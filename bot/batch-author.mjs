import { createPrivateKey } from 'node:crypto';
import { appJwt } from '../scripts/builder/builder.mjs';
import { GitHubApp } from './github-app.mjs';
import { BUILDER_BOT, REVIEW_BOT, REVIEW_APP_ID, REPOSITORY } from './identity.mjs';
import { manifestDigest } from './batch-plan.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const BRANCH = /^fleet-review-bot-batch\/[a-z0-9-]+\/[1-9][0-9]*$/u;
const owns = (user) => user?.id === BUILDER_BOT.id && user?.login === BUILDER_BOT.login;
const readGuard = (guard) => () => guard();

export function carrierBranch(batch) {
  const branch = `fleet-review-bot-batch/${batch.id}/${batch.generation}`;
  if (!BRANCH.test(branch)) throw new Error('batch_branch_invalid');
  return branch;
}

export function carrierMarker(batch) {
  if (batch.manifest_digest !== manifestDigest(batch)) throw new Error('batch_manifest_invalid');
  return `<!-- fleet-review-bot-batch:${batch.id}:${batch.generation}:${batch.manifest_digest} -->`;
}

// This client is constructed only in the trusted web control plane. It never
// accepts the review App, a personal token, GH_TOKEN, or a model-runner identity.
export class BatchAuthor {
  #clientId;
  #privateKey;
  #github = null;
  #proof = null;

  constructor({ clientId, privateKey, repo = REPOSITORY, fetchImpl = fetch, now = Date.now,
    timeoutMs = 30000, githubFactory = (options) => new GitHubApp(options) }) {
    if (repo !== REPOSITORY || !/^Iv[0-9A-Za-z.]+$/u.test(clientId ?? '')) throw new Error('builder_identity_configuration_invalid');
    if (BUILDER_BOT.id === REVIEW_BOT.id || BUILDER_BOT.login === REVIEW_BOT.login) throw new Error('builder_review_identity_not_distinct');
    try { createPrivateKey(privateKey); } catch { throw new Error('builder_private_key_invalid'); }
    this.#clientId = clientId;
    this.#privateKey = privateKey;
    Object.assign(this, { repo, fetch: fetchImpl, now, timeoutMs, githubFactory });
  }

  async #appRequest(path) {
    let response;
    try {
      response = await this.fetch(`https://api.github.com${path}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
          Authorization: `Bearer ${appJwt({ clientId: this.#clientId, privateKey: this.#privateKey, now: this.now })}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw new Error('builder_identity_lookup_unavailable'); }
    if (!response.ok) throw new Error(`builder_identity_lookup_http_${response.status}`);
    try { return await response.json(); } catch { throw new Error('builder_identity_response_invalid'); }
  }

  async prove({ fresh = false } = {}) {
    if (!fresh && this.#proof && this.now() - this.#proof.checked_at < 60000) return this.#proof;
    const app = await this.#appRequest('/app');
    if (!Number.isSafeInteger(app?.id) || app.id < 1 || app.id === REVIEW_APP_ID
      || `${app.slug}[bot]` !== BUILDER_BOT.login) throw new Error('builder_app_identity_mismatch');
    const installation = await this.#appRequest(`/repos/${this.repo}/installation`);
    if (!Number.isSafeInteger(installation?.id) || installation.id < 1 || installation.app_id !== app.id
      || installation.suspended_at || installation.repository_selection !== 'selected'
      || installation.account?.login?.toLowerCase() !== this.repo.split('/')[0].toLowerCase()) {
      throw new Error('builder_installation_identity_mismatch');
    }
    for (const permission of ['contents', 'pull_requests', 'workflows']) {
      if (installation.permissions?.[permission] !== 'write') throw new Error(`builder_permission_missing:${permission}:write`);
    }
    const github = this.githubFactory({ appId: app.id, privateKey: this.#privateKey, repo: this.repo,
      fetchImpl: this.fetch, now: this.now, timeoutMs: this.timeoutMs });
    const user = await github.request('GET', `/users/${encodeURIComponent(BUILDER_BOT.login)}`);
    if (!owns(user) || user.type !== 'Bot') throw new Error('builder_user_identity_mismatch');
    const repositories = await github.paginate('/installation/repositories', 'repositories');
    if (repositories.length !== 1 || repositories[0]?.full_name?.toLowerCase() !== this.repo.toLowerCase()) {
      throw new Error('builder_token_repository_scope_mismatch');
    }
    this.#github = github;
    this.#proof = Object.freeze({ app_id: app.id, installation_id: installation.id,
      user: Object.freeze({ id: user.id, login: user.login }), repository: this.repo,
      permissions: Object.freeze({ contents: 'write', pull_requests: 'write', workflows: 'write',
        actions: installation.permissions?.actions ?? null }), checked_at: this.now() });
    return this.#proof;
  }

  async credentials() {
    const identity = await this.prove();
    return { token: await this.#github.token(), identity };
  }

  async readBranch(branch, guard = async () => {}) {
    if (!BRANCH.test(branch)) throw new Error('batch_branch_invalid');
    await this.prove();
    const path = `/repos/${this.repo}/git/ref/heads/${branch}`;
    try {
      const ref = await this.#github.request('GET', path, undefined, readGuard(guard));
      if (ref?.ref !== `refs/heads/${branch}` || ref.object?.type !== 'commit' || !SHA.test(ref.object.sha)) throw new Error('batch_branch_receipt_invalid');
      return ref.object.sha;
    } catch (error) {
      if (error.message === `GitHub request failed: GET ${path} HTTP 404`) return null;
      throw error;
    }
  }

  async findCarrier(batch, guard = async () => {}) {
    await this.prove();
    const marker = carrierMarker(batch);
    const matches = (await this.#github.paginate(`/repos/${this.repo}/pulls?state=all`, null, readGuard(guard)))
      .filter((pr) => owns(pr.user) && pr.head?.ref === carrierBranch(batch)
        && pr.head?.repo?.full_name === this.repo && pr.base?.repo?.full_name === this.repo
        && pr.body?.split('\n', 1)[0] === marker);
    if (matches.length > 1) throw new Error('batch_carrier_adoption_ambiguous');
    // A matching native PR proves the creation happened even if somebody later
    // moved its head/base. The lane must invalidate drift, never repeat POST.
    return matches[0] ?? null;
  }

  async createCarrier(batch, body, guard = async () => {}) {
    if (!batch.sealed || batch.kind !== 'batch' || batch.carrier_branch !== carrierBranch(batch)
      || !SHA.test(batch.base_sha) || !SHA.test(batch.head_sha) || !SHA.test(batch.tree_sha)) throw new Error('batch_carrier_not_sealed');
    await this.prove({ fresh: true });
    const pr = await this.#github.request('POST', `/repos/${this.repo}/pulls`, {
      title: `Merge batch ${batch.id}/${batch.generation} (${batch.members.length} PRs)`,
      head: batch.carrier_branch, base: 'main', draft: false,
      body: `${carrierMarker(batch)}\n\n${body}`,
    }, guard);
    if (!owns(pr?.user) || pr.head?.sha !== batch.head_sha || pr.head?.ref !== batch.carrier_branch
      || pr.base?.ref !== 'main' || pr.head?.repo?.full_name !== this.repo || pr.base?.repo?.full_name !== this.repo
      || !Number.isSafeInteger(pr.number) || typeof pr.node_id !== 'string' || !pr.node_id) throw new Error('batch_carrier_creation_unconfirmed');
    return pr;
  }
  async rerunCi(batch, expected, guard = async () => {}, { failedOnly = false } = {}) {
    const proof = await this.prove({ fresh: true });
    if (proof.permissions.actions !== 'write') throw new Error('builder_permission_missing:actions:write');
    if (!Number.isSafeInteger(expected.id) || expected.id < 1 || !Number.isSafeInteger(expected.run_attempt)
      || expected.run_attempt < 1 || !SHA.test(batch.head_sha)) throw new Error('batch_rerun_identity_invalid');
    const path = `/repos/${this.repo}/actions/runs/${expected.id}`;
    const workflow = await this.#github.request('GET', `/repos/${this.repo}/actions/workflows/ci.yml`, undefined, readGuard(guard));
    const check = (run) => {
      if (run.id !== expected.id || run.run_attempt !== expected.run_attempt || run.workflow_id !== workflow.id
        || run.head_sha !== batch.head_sha || run.head_repository?.full_name !== this.repo
        || run.event !== 'pull_request' || run.status !== 'completed') throw new Error('batch_rerun_target_changed');
    };
    check(await this.#github.request('GET', path, undefined, readGuard(guard)));
    await this.#github.request('POST', `${path}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, undefined, async (phase) => {
      if (phase === 'before_send') check(await this.#github.request('GET', path, undefined, readGuard(guard)));
      await guard(phase);
    });
  }

  async closeCarrier(batch, guard = async () => {}) {
    if (!Number.isSafeInteger(batch.target_pr) || !batch.target_node_id) throw new Error('batch_carrier_identity_missing');
    await this.prove();
    const path = `/repos/${this.repo}/pulls/${batch.target_pr}`;
    const check = (pr) => {
      if (pr?.node_id !== batch.target_node_id || !owns(pr.user) || pr.head?.ref !== carrierBranch(batch)
        || pr.head?.repo?.full_name !== this.repo) throw new Error('batch_carrier_identity_changed');
      if (pr.merged) throw new Error('batch_carrier_already_merged');
    };
    const current = await this.#github.request('GET', path, undefined, readGuard(guard));
    check(current);
    if (current.state === 'closed') return current;
    const closed = await this.#github.request('PATCH', path, { state: 'closed' }, async (phase) => {
      await guard(phase);
      if (phase === 'before_send') check(await this.#github.request('GET', path, undefined, readGuard(guard)));
    });
    check(closed);
    if (closed.state !== 'closed') throw new Error('batch_carrier_close_unconfirmed');
    return closed;
  }
}
