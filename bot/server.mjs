import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY, REVIEW_APP_ID } from './identity.mjs';
import { verifySignature, minimalPayload } from './webhook.mjs';
import { GitHubApp } from './github-app.mjs';
import { GitHubBudget } from './github-budget.mjs';
import { Store } from './store.mjs';
import { Publisher } from './publish.mjs';
import { Mirror } from './mirror.mjs';
import { Scheduler } from './scheduler.mjs';
import { VerdictService } from './verdict-service.mjs';
import { Approval } from './approval.mjs';
import { ApprovalGate } from './approval-gate.mjs';
import { Shepherd } from './shepherd.mjs';
import { BatchAuthor } from './batch-author.mjs';
import { BatchMirror } from './batch-mirror.mjs';
import { batchLimit } from './batch-plan.mjs';
import { readSelectionDrainRequest } from './merge-drain.mjs';
import { sanitize } from './evidence.mjs';

export function mergeBatchConfig(env) {
  const enabled = env.MERGE_BATCH_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('Invalid MERGE_BATCH_ENABLED');
  const batchMaxSize = batchLimit(Number(env.MERGE_BATCH_MAX_SIZE ?? 5));
  const batchCollectSeconds = Number(env.MERGE_BATCH_COLLECT_SECONDS ?? 180);
  if (!Number.isInteger(batchCollectSeconds) || batchCollectSeconds < 0 || batchCollectSeconds > 900) throw new Error('Invalid MERGE_BATCH_COLLECT_SECONDS');
  return { batchEnabled: enabled === 'true', batchMaxSize, batchCollectSeconds };
}

// Keep this independent of review/model admission: review-only needs no Builder.
export function mergeLaneConfig(env) {
  const enabled = env.MERGE_LANE_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('Invalid MERGE_LANE_ENABLED');
  return { mergeLaneEnabled: enabled === 'true' };
}

export function createMergeClients(env, stateRoot, mergeLaneEnabled) {
  if (!mergeLaneEnabled) return { batchAuthor: null, batchMirror: null };
  if (env.REVIEW_BOT_MODE !== 'approve' && !env.BUILDER_GITHUB_APP_CLIENT_ID && !env.BUILDER_GITHUB_APP_PRIVATE_KEY_B64) {
    return { batchAuthor: null, batchMirror: null };
  }
  const encodedBuilderKey = env.BUILDER_GITHUB_APP_PRIVATE_KEY_B64;
  if (!encodedBuilderKey || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedBuilderKey)) throw new Error('Invalid BUILDER_GITHUB_APP_PRIVATE_KEY_B64');
  const batchAuthor = new BatchAuthor({ clientId: env.BUILDER_GITHUB_APP_CLIENT_ID,
    privateKey: Buffer.from(encodedBuilderKey, 'base64').toString('utf8') });
  return { batchAuthor, batchMirror: new BatchMirror({ author: batchAuthor, root: join(stateRoot, 'batches') }) };
}

// Reviewer readiness stays on the gateway. Hosted judge authentication is proved
// by each successful verdict; absent credentials cannot admit approval mode.
export async function admitStartupMode({ mode, gatewayUrl, token, judgeToken,
  reviewModel = 'openai-codex/gpt-6.1-sol', fetchImpl = fetch }) {
  if (mode !== 'approve') return { mode, modeDegraded: null };
  try {
    if (typeof judgeToken !== 'string' || !judgeToken || /\s/u.test(judgeToken)) throw new Error('Missing hosted judge credential');
    const provider = {
      'openai-codex/gpt-6.1-sol': 'openai-codex',
      'anthropic/claude-opus-5-5': 'anthropic',
    }[reviewModel];
    if (!provider) throw new Error('Unsupported review route');
    const get = async (path) => {
      const response = await fetchImpl(`${gatewayUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error('Gateway admission failed');
      return response.json();
    };
    const checks = await get('/v1/credentials/check');
    if (Array.isArray(checks.credentials) && checks.credentials.some((credential) =>
        credential?.provider === provider && credential.type === 'oauth' && credential.ok === true)) {
      return { mode, modeDegraded: null };
    }
  } catch { /* Unavailable or malformed readiness never grants approval authority. */ }
  return { mode: 'advisory', modeDegraded: 'approve→advisory' };
}

export function createAdmission({ mode, now = Date.now, ...options }) {
  const state = { mode: mode === 'approve' ? 'advisory' : mode,
    modeDegraded: mode === 'approve' ? 'approve→advisory' : null };
  let nextCheckAt = 0;
  let pending = null;
  const refresh = async ({ fresh = false } = {}) => {
    if (mode !== 'approve') return state;
    if (pending) return pending;
    if (!fresh && now() < nextCheckAt) return state;
    pending ??= admitStartupMode({ mode, ...options }).then((result) => {
      Object.assign(state, result); nextCheckAt = now() + 60000; return state;
    }).finally(() => { pending = null; });
    return pending;
  };
  return { state, refresh };
}

export function createWebhookServer({ store, scheduler, secret, appId = REVIEW_APP_ID, mode = 'advisory', revision = null,
  admission = null, modeDegraded = null, secrets = [], fetchImpl = fetch, runnerUrl = 'http://runner:8081', gatewayUrl = 'http://gateway:4000', now = Date.now, log = () => {} }) {
  let lastWebhookAt = store.get('SELECT max(received_at) AS n FROM deliveries').n ?? null;
  let lastHealthFailures = null;
  const reportFailure = (error) => {
    const clean = (value, limit) => sanitize(value, { secrets: [secret, ...secrets, ...(scheduler.publisher?.secrets ?? [])], limit });
    log({ event: 'webhook_failed', cause: {
      name: clean(error?.name ?? 'Error', 100), message: clean(error?.message ?? error, 1000),
    } });
  };
  const probe = async (url) => { try { return (await fetchImpl(url, { signal: AbortSignal.timeout(2000) })).ok ? 'up' : 'down'; } catch { return 'down'; } };
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const knownRevision = typeof revision === 'string' && /^[0-9a-f]{40}$/u.test(revision);
  const server = createServer(async (req, res) => {
    try {
      // Deployment readiness is local startup/liveness, not scheduler authority.
      if (req.method === 'GET' && req.url === '/ready') {
        let ok = server.listening && knownRevision;
        if (ok) {
          try { store.get('SELECT id FROM deliveries LIMIT 1'); }
          catch { ok = false; }
        }
        return send(res, ok ? 200 : 503, { ok, revision: knownRevision ? revision : null });
      }
      const runtime = admission?.state ?? { mode, modeDegraded };
      if (req.method === 'GET' && req.url === '/health') {
        const [runner, gateway] = await Promise.all([probe(`${runnerUrl}/health`), probe(`${gatewayUrl}/healthz`)]);
        const lastTickCompletedAt = scheduler.lastTickCompletedAt ?? 0;
        const alive = now() - lastTickCompletedAt <= 300000;
        const lastReconcileOkAt = scheduler.lastReconcileOkAt ?? null;
        const reconciled = mode === 'off' || now() - (lastReconcileOkAt ?? scheduler.startedAt ?? 0) <= 1800000;
        const publicationFailures = scheduler.publicationFailures?.() ?? [];
        const mergeFailures = scheduler.batchLane?.failures() ?? [];
        let githubBudget = null;
        const budget = scheduler.github?.budget;
        if (budget) {
          try {
            githubBudget = scheduler.github.budgetFailure
              ? { state: 'fault', reason: 'github_budget_accounting_unavailable' } : budget.snapshot();
          } catch {
            githubBudget = { state: 'fault', reason: 'github_budget_accounting_unavailable' };
          }
        }
        const budgetHealthy = githubBudget === null || githubBudget.state !== 'fault';
        const ok = !runtime.modeDegraded && runner === 'up' && gateway === 'up' && alive && reconciled
          && publicationFailures.length === 0 && mergeFailures.length === 0 && budgetHealthy;
        const failures = [
          ...(runtime.modeDegraded ? ['admission_degraded'] : []),
          ...(runner !== 'up' ? ['runner_unavailable'] : []),
          ...(gateway !== 'up' ? ['gateway_unavailable'] : []),
          ...(!alive ? ['tick_stale'] : []), ...(!reconciled ? ['reconcile_stale'] : []),
          ...(publicationFailures.length ? ['publication_pending'] : []),
          ...(mergeFailures.length ? ['merge_pending'] : []),
          ...(!budgetHealthy ? ['github_budget_accounting_unavailable'] : []),
        ];
        const signature = JSON.stringify(failures);
        if (signature !== lastHealthFailures) {
          if (failures.length || lastHealthFailures !== null) log({ event: 'health_state', ok, failures });
          lastHealthFailures = signature;
        }
        return send(res, ok ? 200 : 503, { ok, revision, mode: runtime.mode, mode_degraded: runtime.modeDegraded,
          ...store.counts({ includeMergeLane: scheduler.mergeLaneEnabled !== false }), lastWebhookAt, lastTickCompletedAt,
          lastReconcileAt: scheduler.lastReconcileAt || null, lastReconcileOkAt,
          lastReconcileCounts: scheduler.lastReconcileCounts ?? null, publicationFailures, mergeFailures, runner, gateway,
          mergeLaneEnabled: scheduler.mergeLaneEnabled ?? true, mergeDrain: scheduler.mergeDrain ?? null, githubBudget });
      }
      if (req.method !== 'POST' || req.url !== '/github') return send(res, 404, { error: 'not_found' });
      if (!req.headers['x-hub-signature-256']) { req.resume(); return send(res, 401, { error: 'invalid_signature' }); }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) { send(res, 413, { error: 'body_too_large' }); req.destroy(); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (!verifySignature(raw, req.headers['x-hub-signature-256'], secret)) return send(res, 401, { error: 'invalid_signature' });
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'invalid_json' }); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return send(res, 400, { error: 'invalid_payload' });
      const id = req.headers['x-github-delivery'];
      const event = req.headers['x-github-event'];
      if (typeof id !== 'string' || !id || typeof event !== 'string') return send(res, 400, { error: 'missing_delivery' });
      const delivery = store.receiveDelivery(id, event, minimalPayload(payload), now(), appId);
      if (delivery.state === 'processed') return send(res, 200, { duplicate: true });
      lastWebhookAt = now();
      if (mode === 'off') store.processedDelivery(id, now());
      else void (async () => scheduler.processDelivery(id))().catch(reportFailure);
      log({ event: 'webhook_accepted' });
      return send(res, 202, { accepted: true });
    } catch (error) {
      reportFailure(error);
      return send(res, 500, { error: 'request_failed' });
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env;
  const requestedMode = env.REVIEW_BOT_MODE;
  if (!['off', 'advisory', 'approve'].includes(requestedMode)) throw new Error('Invalid REVIEW_BOT_MODE');
  const laneConfig = mergeLaneConfig(env);
  const concurrency = Number(env.REVIEW_CONCURRENCY ?? 2);
  const retentionDays = Number(env.RETENTION_DAYS ?? 180);
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('Invalid runtime limits');
  const stateRoot = env.STATE_ROOT ?? '/state';
  const workRoot = env.WORK_ROOT ?? '/work';
  const sessionsRoot = env.SESSIONS_ROOT ?? '/sessions';
  await Promise.all([stateRoot, workRoot].map((path) => mkdir(path, { recursive: true })));
  const store = new Store(join(stateRoot, 'bot.sqlite'));
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret || /\s/u.test(secret)) throw new Error('Invalid webhook secret');
  const log = (entry) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  const runnerUrl = env.RUNNER_URL ?? 'http://runner:8081';
  const gatewayUrl = env.GATEWAY_URL ?? 'http://gateway:4000';
  const token = env.OMP_GATEWAY_TOKEN;
  if (!token || /\s/u.test(token)) throw new Error('Invalid OMP_GATEWAY_TOKEN');
  const judgeToken = env.TYPESAFE_API_KEY;
  const admission = createAdmission({ mode: requestedMode, gatewayUrl, token, judgeToken, reviewModel: env.REVIEW_MODEL });
  await admission.refresh();
  const mode = admission.state.mode;
  if (admission.state.modeDegraded) log({ event: 'mode_degraded', mode_degraded: admission.state.modeDegraded });
  const encodedKey = env.GITHUB_APP_PRIVATE_KEY_B64;
  if (!encodedKey || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedKey)) throw new Error('Invalid GITHUB_APP_PRIVATE_KEY_B64');
  const budget = new GitHubBudget({ store, scope: `${REVIEW_APP_ID}:${REPOSITORY}`, log });
  const github = new GitHubApp({ appId: REVIEW_APP_ID, privateKey: Buffer.from(encodedKey, 'base64').toString('utf8'), repo: REPOSITORY, log, budget });
  const approvalGate = laneConfig.mergeLaneEnabled || requestedMode === 'off' ? null : new ApprovalGate({ github, store });
  const approval = new Approval({ store, github, mode: requestedMode, ...laneConfig, log,
    admit: async () => (await admission.refresh({ fresh: true })).mode === 'approve' });
  const secrets = [token, judgeToken].filter(Boolean);
  // Off mode still settles durable canonical cancellation checks.
  const publisher = new Publisher({ github, store, secrets, draftConclusion: env.DRAFT_CHECK_CONCLUSION ?? 'skipped' });
  let mirror = null;
  let verdict = null;
  let shepherd = null;
  const revision = /^[0-9a-f]{40}$/u.test(env.IMAGE_REVISION ?? '') ? env.IMAGE_REVISION : null;
  const batchConfig = mergeBatchConfig(env);
  const { batchAuthor, batchMirror } = createMergeClients(env, stateRoot, laneConfig.mergeLaneEnabled);
  if (mode !== 'off') {
    mirror = new Mirror({ github, stateRoot, workRoot, sessionsRoot, secrets,
      reviewModel: env.REVIEW_MODEL, reviewThinking: env.REVIEW_THINKING });
    verdict = new VerdictService({ mirror, token, judgeToken });
    if (laneConfig.mergeLaneEnabled) shepherd = new Shepherd({ github, store, secrets, log });
  }
  const scheduler = new Scheduler({ store, github, publisher, mirror, verdict, approval, approvalGate,
    runnerUrl, mode, admission, concurrency, retentionDays, workRoot, sessionsRoot, log, shepherd, revision,
    batchAuthor, batchMirror, ...batchConfig, ...laneConfig,
    reconcileIntervalMs: Number(env.RECONCILE_INTERVAL_MS ?? 60000),
    readMergeDrain: () => readSelectionDrainRequest(join(stateRoot, 'merge-selection-drain.request')) });
  await scheduler.recover({ waitForPublications: false });
  const server = createWebhookServer({ store, scheduler, secret, mode, admission, runnerUrl, gatewayUrl, log, revision,
    secrets: [token, judgeToken, encodedKey, env.BUILDER_GITHUB_APP_PRIVATE_KEY_B64] });
  const timer = setInterval(() => scheduler.tick().catch((error) => scheduler.recordTickFailure(error)), 5000);
  server.listen(Number(env.PORT ?? 8080), '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(timer); server.close(() => store.close()); });
}
