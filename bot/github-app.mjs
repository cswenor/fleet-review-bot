import { createPrivateKey, createSign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { beginRequestAttempt, recordLogicalRequest, withRequestPhase } from './request-metrics.mjs';
import { informationalRead } from './informational-cache.mjs';
import { githubPriority, withGitHubPriority } from './github-budget.mjs';

const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2026-03-10';

// Private provenance: error codes alone cannot prove that a mutation was unsent.
const requestDispatch = new WeakMap();
export function githubRequestNotDispatched(error, method, path) {
  const request = error && typeof error === 'object' ? requestDispatch.get(error) : null;
  return Boolean(request && request.method === method && request.path === path && request.notDispatched === true);
}

function localAdmission(callback, method, path, attempted = false) {
  try { return callback(); }
  catch (error) {
    if (error && typeof error === 'object') requestDispatch.set(error, { method, path, notDispatched: !attempted });
    throw error;
  }
}

async function requestGuard(guard, phase, method, path) {
  try { await guard(phase); }
  catch (error) {
    // Even a nested request to the same endpoint is not this request's admission.
    if (githubRequestNotDispatched(error, method, path)) requestDispatch.delete(error);
    throw error;
  }
}

function metricTime() {
  try { return performance.now(); } catch { return 0; }
}

function diagnosticText(value, token, limit) {
  return value.replaceAll(token, '[redacted]')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+|Bearer\s+\S+/giu, '[redacted]').slice(0, limit);
}

// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
export class GitHubApp {
  constructor({ appId, privateKey, repo, fetchImpl = fetch, now = Date.now, sleep = delay, timeoutMs = 30000, log = () => {}, budget = null }) {
    this.appId = Number(appId);
    this.key = createPrivateKey(privateKey);
    this.repo = repo;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.budget = budget;
    this.budgetFailure = false;
    this.cachedToken = null;
    this.tokenPromise = null;
    this.retryAt = 0;
    this.rateFailures = 0;
    this.rateFailure = null;
  }
  jwt() {
    const seconds = Math.floor(this.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: String(this.appId) })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    return `${unsigned}.${signer.sign(this.key).toString('base64url')}`;
  }
  available() {
    if (this.now() < this.retryAt) {
      const error = new Error(`GitHub request deferred until ${new Date(this.retryAt).toISOString()}`);
      Object.assign(error, { code: 'github_rate_limited', retryAt: this.retryAt, github: this.rateFailure });
      throw error;
    }
    if (this.budgetFailure) {
      throw Object.assign(new Error('GitHub budget accounting unavailable'), {
        code: 'github_budget_deferred', priority: githubPriority() ?? 'review',
        retryAt: this.now() + 3660000, reason: 'github_budget_accounting_unavailable',
      });
    }
  }
  failure(method, path, response, detail, token) {
    let message = null;
    try {
      const value = JSON.parse(detail).message;
      if (typeof value === 'string') message = diagnosticText(value, token, 512);
    } catch { /* Non-JSON bodies are not logged. */ }
    const headers = Object.fromEntries(['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
      'x-ratelimit-resource', 'retry-after', 'x-github-request-id']
      .map((key) => [key, response.headers.get(key) === null ? null : diagnosticText(response.headers.get(key), token, 128)]));
    const github = { status: response.status, headers, message };
    const error = Object.assign(new Error(`GitHub request failed: ${method} ${path} HTTP ${response.status}`), { github });
    const limited = response.status === 429 || (response.status === 403
      && (headers['retry-after'] !== null || headers['x-ratelimit-remaining'] === '0'
        || /(?:secondary|API) rate limit/iu.test(detail)));
    if (limited) {
      const after = headers['retry-after'];
      const seconds = after === null ? NaN : Number(after);
      const explicit = after === null ? NaN : Number.isFinite(seconds)
        ? this.now() + Math.max(0, seconds * 1000) : Date.parse(after);
      const reset = headers['x-ratelimit-remaining'] === '0'
        ? Number(headers['x-ratelimit-reset']) * 1000 + 1000 : NaN;
      const fallback = this.now() + Math.min(900000, 60000 * 2 ** Math.min(this.rateFailures++, 4));
      this.retryAt = Math.max(this.retryAt, this.now() + 1000,
        Number.isFinite(explicit) ? explicit : 0, Number.isFinite(reset) && reset > this.now() ? reset : 0,
        !Number.isFinite(explicit) && !(Number.isFinite(reset) && reset > this.now()) ? fallback : 0);
      this.rateFailure = github;
      Object.assign(error, { code: 'github_rate_limited', retryAt: this.retryAt });
    }
    this.log({ event: 'github_request_failed', method, path: diagnosticText(path, token, 1000), github,
      ...(error.retryAt ? { retryAt: error.retryAt } : {}) });
    return error;
  }
  settleBudget(receipt, response) {
    if (!this.budget) return;
    try { this.budget.settle(receipt, { status: response?.status, headers: response?.headers }); }
    catch {
      // Never discard a remote acceptance because its local accounting failed.
      // The durable provisional charge remains; this client cannot dispatch again.
      this.budgetFailure = true;
      this.log({ event: 'github_budget_accounting_failed', reason: 'settlement_failed' });
    }
  }
  async send(method, path, body, token, guard = async () => {}, logicalRecorded = false, informational = null) {
    if (!logicalRecorded) recordLogicalRequest({ appId: this.appId, method });
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('GitHub path must be relative');
    for (let attempt = 0; attempt < 3; attempt++) {
      // Authorization still wins over a local backoff; no API call is made in either case.
      await requestGuard(guard, 'before_send', method, path);
      localAdmission(() => this.available(), method, path, attempt > 0);
      const signal = AbortSignal.timeout(this.timeoutMs);
      let response;
      const etag = informational?.etag();
      const options = { method,
        headers: { Accept: ACCEPT, 'X-GitHub-Api-Version': API_VERSION,
          ...(etag ? { 'If-None-Match': etag } : {}),
          Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal };
      const receipt = localAdmission(() => this.budget?.reserve(githubPriority() ?? 'review'), method, path, attempt > 0);
      const finish = beginRequestAttempt({ appId: this.appId, method, retry: attempt > 0 });
      let started = metricTime();
      let latencyMs = 0;
      try {
        response = await this.fetch(`https://api.github.com${path}`, options);
      } catch (error) {
        if (error && typeof error === 'object') requestDispatch.delete(error);
        this.settleBudget(receipt);
        finish({ latencyMs: Math.max(0, metricTime() - started), outcome: signal.aborted ? 'timeout' : 'transport_error' });
        if (signal.aborted) throw new Error('github_timeout'); throw error;
      }
      latencyMs += Math.max(0, metricTime() - started);
      this.settleBudget(receipt, response);
      if (response.ok || (response.status === 304 && informational)) {
        let outcome = 'guard_refused';
        try {
          await requestGuard(guard, undefined, method, path);
          outcome = 'body_error';
          started = metricTime();
          let result;
          try {
            if (response.status === 304) {
              if (!etag) throw new Error('github_informational_304_without_representation');
              result = informational.representation();
            } else result = response.status === 204 ? null : await response.json();
          }
          finally { latencyMs += Math.max(0, metricTime() - started); }
          finish({ status: response.status, latencyMs, outcome: 'success' });
          await requestGuard(guard, undefined, method, path);
          if (response.status === 304) result = informational.representation();
          if (this.now() >= this.retryAt) this.rateFailures = 0;
          if (response.status === 200) informational?.store(response.headers.get('etag'), result);
          return result;
        } catch (error) {
          finish({ status: response.status, latencyMs, outcome: signal.aborted ? 'timeout' : outcome });
          if (signal.aborted) throw new Error('github_timeout'); throw error;
        }
      }
      let detail;
      started = metricTime();
      try { detail = await response.text(); }
      catch (error) {
        finish({ status: response.status, latencyMs: latencyMs + Math.max(0, metricTime() - started),
          outcome: signal.aborted ? 'timeout' : 'body_error' });
        if (!['GET', 'PATCH'].includes(method) && response.status >= 400 && response.status < 500) detail = '';
        else { if (signal.aborted) throw new Error('github_timeout'); throw error; }
      }
      latencyMs += Math.max(0, metricTime() - started);
      finish({ status: response.status, latencyMs, outcome: 'http_error' });
      const failure = this.failure(method, path, response, detail, token);
      if (!['GET', 'PATCH'].includes(method) && response.status >= 400 && response.status < 500) {
        // A received mutation rejection remains conclusive even if authorization changed.
        throw failure;
      }
      await requestGuard(guard, undefined, method, path);
      // Rate windows never sleep on the serialized publication/lane queue.
      if (failure.retryAt || !['GET', 'PATCH'].includes(method) || response.status < 500 || attempt === 2) throw failure;
      await this.sleep(attempt === 0 ? 1000 : 3000);
      await requestGuard(guard, undefined, method, path);
    }
  }
  async token() {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now() + 300000) return this.cachedToken.token;
    if (!this.tokenPromise) this.tokenPromise = withRequestPhase('auth', null, async () => {
      const installation = await this.send('GET', `/repos/${this.repo}/installation`, undefined, this.jwt());
      const receipt = await this.send('POST', `/app/installations/${installation.id}/access_tokens`,
        { repositories: [this.repo.split('/')[1]] }, this.jwt());
      this.cachedToken = { token: receipt.token, expiresAt: Date.parse(receipt.expires_at), installationId: installation.id };
      return receipt.token;
    }).finally(() => { this.tokenPromise = null; });
    return this.tokenPromise;
  }
  async request(method, path, body, guard = async () => {}, options = {}) {
    const priority = githubPriority() ?? (options.informational === true ? 'presentation' : 'review');
    return withGitHubPriority(priority, async () => {
      recordLogicalRequest({ appId: this.appId, method });
      await requestGuard(guard, undefined, method, path);
      localAdmission(() => this.available(), method, path);
      const token = await this.token();
      await requestGuard(guard, undefined, method, path);
      const informational = options.informational === true && method === 'GET' && body === undefined
        && this.cachedToken?.token === token
        ? informationalRead(this, { appId: this.appId, installationId: this.cachedToken.installationId,
          repo: this.repo, method, path, accept: ACCEPT, apiVersion: API_VERSION,
          headSha: options.headSha, pr: options.pr }) : null;
      try { return await this.send(method, path, body, token, guard, true, informational); }
      finally { informational?.release(); }
    });
  }
  async graphql(query, variables, guard = async () => {}) {
    const response = await this.request('POST', '/graphql', { query, variables }, guard);
    if (response?.errors?.length) {
      const clean = Array.isArray(response.errors)
        && response.errors.every((error) => typeof error?.message === 'string' && error.message.includes('Pull request is in clean status'));
      throw new Error(clean ? 'pull_request_clean_status' : 'github_graphql_failed');
    }
    if (!response?.data || typeof response.data !== 'object') throw new Error('github_graphql_failed');
    return response.data;
  }
  async paginate(path, key = null, guard = async () => {}, options = {}) {
    const rows = [];
    for (let page = 1; ; page++) {
      const receipt = await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, undefined, guard, options);
      const batch = key ? receipt[key] : receipt;
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub pagination response');
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  }
}
