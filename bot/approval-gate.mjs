import { REVIEW_BOT } from './identity.mjs';
import { readQueue, runHoldCheck } from './hold-check.mjs';

export const APPROVAL_GATE = 'app-approval';
const SHA = /^[0-9a-f]{40}$/u;

// Only the deployed App's installation token publishes this check. Actions
// callers retain the generic hold-only status; no PR workflow is authority.
export class ApprovalGate {
  constructor({ github, now = Date.now, intervalMs = 300000, reviewer = REVIEW_BOT }) {
    this.github = github;
    this.now = now;
    this.intervalMs = intervalMs;
    this.nextAt = 0;
    this.reviewer = reviewer;
    this.checks = new Map();
    this.observed = null;
    let identity;
    const [owner, repo] = github.repo.split('/');
    this.repo = { owner, repo };
    this.base = `/repos/${github.repo}`;
    const get = async (path) => ({ data: await github.request('GET', path) });
    this.adapter = {
      graphql: (query, variables) => github.graphql(query, variables),
      rest: {
        pulls: {
          get: ({ pull_number }) => get(`${this.base}/pulls/${pull_number}`),
          list: ({ page, per_page }) => get(`${this.base}/pulls?state=open&per_page=${per_page}&page=${page}`),
          listReviews: ({ pull_number, page, per_page }) => get(`${this.base}/pulls/${pull_number}/reviews?per_page=${per_page}&page=${page}`),
        },
        git: { getRef: ({ ref }) => get(`${this.base}/git/ref/${ref}`) },
        users: { getByUsername: async ({ username }) => {
          const result = identity ?? await get(`/users/${encodeURIComponent(username)}`);
          if (result.data?.id !== this.reviewer.id || result.data?.login !== this.reviewer.login) {
            throw new Error('Configured Review App identity mismatch');
          }
          identity = result; // Immutable Bot identity only; never cache approval authority.
          return result;
        } },
      },
    };
  }

  async publish(sha, state, description) {
    if (!SHA.test(sha)) throw new Error('Invalid approval-gate SHA');
    this.observed?.add(sha);
    let existing = this.checks.get(sha);
    if (!this.checks.has(sha)) {
      const path = `${this.base}/commits/${sha}/check-runs?check_name=${APPROVAL_GATE}&filter=all`;
      const checks = await this.github.paginate(path, 'check_runs');
      const own = checks.filter((check) => check.name === APPROVAL_GATE && check.head_sha === sha
        && check.app?.id === Number(this.github.appId) && Number.isSafeInteger(check.id));
      existing = own.sort((a, b) => b.id - a.id)[0] ?? null;
      this.checks.set(sha, existing);
    }
    const pending = state === 'pending';
    // Existing heads keep their last result while fresh reads run. Only a new
    // head needs an in-progress check; a temporary failure ejects healthy queues.
    if (pending && existing) return;
    const conclusion = state === 'success' ? 'success' : 'failure';
    if (!pending && existing?.status === 'completed' && existing.conclusion === conclusion) return;
    const body = {
      name: APPROVAL_GATE, external_id: `fleet-app-approval:${sha}`,
      status: pending ? 'in_progress' : 'completed',
      output: { title: pending ? 'Checking live App approval and holds' : state === 'success'
        ? 'Exact-head App approval and holds verified' : 'App approval or hold authority blocked', summary: description },
    };
    if (!existing) body.head_sha = sha;
    if (!pending) {
      body.conclusion = conclusion;
      body.completed_at = new Date(this.now()).toISOString();
    }
    try {
      const receipt = await this.github.request(existing ? 'PATCH' : 'POST',
        existing ? `${this.base}/check-runs/${existing.id}` : `${this.base}/check-runs`, body);
      if (!Number.isSafeInteger(receipt?.id) || receipt.head_sha !== sha
        || receipt.app?.id !== Number(this.github.appId) || receipt.name !== APPROVAL_GATE
        || receipt.status !== body.status || (!pending && receipt.conclusion !== conclusion)) {
        throw new Error('Approval-gate publication unconfirmed');
      }
      this.checks.set(sha, receipt);
    } catch (error) {
      this.checks.delete(sha); // Reconcile an ambiguous write by reading, never blind re-create.
      throw error;
    }
  }

  async evaluate(eventName, payload) {
    let failed = false;
    const core = { setFailed: () => { failed = true; }, error: () => { failed = true; } };
    const pass = await runHoldCheck({ github: this.adapter,
      context: { repo: this.repo, eventName, payload }, core,
      reviewApp: this.reviewer.login.slice(0, -'[bot]'.length),
      publishStatus: (sha, state, description) => this.publish(sha, state, description) });
    return pass && !failed;
  }

  async delivery(event, payload) {
    if (payload.repository?.full_name !== this.github.repo) return;
    if (event === 'merge_group' && payload.action === 'checks_requested') {
      await this.evaluate('merge_group', payload);
    } else if ((event === 'pull_request_review' && ['submitted', 'edited', 'dismissed'].includes(payload.action))
      || (event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'edited', 'labeled', 'unlabeled',
        'ready_for_review', 'converted_to_draft'].includes(payload.action))) {
      // A delayed webhook is only a PR identity hint: fetch its current head.
      const number = payload.pull_request?.number ?? payload.number;
      if (!Number.isSafeInteger(number) || number < 1) throw new Error('Missing approval-gate PR identity');
      const pr = await this.github.request('GET', `${this.base}/pulls/${number}`);
      if (pr.state === 'open') await this.evaluate('pull_request_target', { action: 'edited', pull_request: pr });
    }
  }

  async reconcile() {
    if (this.now() < this.nextAt) return;
    this.nextAt = this.now() + this.intervalMs;
    this.observed = new Set();
    try {
      await this.evaluate('approval_reconcile', { action: 'reconcile' });
      // Webhook loss must not preserve stale synthetic-head success. Resolve
      // current refs from GitHub, never remembered events or workflow artifacts.
      const entries = await readQueue(this.adapter, this.repo, 'main');
      if (!entries.length) return;
      const refs = await this.github.request('GET', `${this.base}/git/matching-refs/heads/gh-readonly-queue/main/`);
      if (!Array.isArray(refs)) throw new Error('Unknown approval-gate queue refs');
      for (const entry of entries) {
        const sha = entry?.headCommit?.oid;
        const matches = refs.filter((ref) => ref.object?.sha === sha
          && ref.ref?.startsWith('refs/heads/gh-readonly-queue/main/'));
        if (matches.length !== 1) {
          await this.publish(sha, 'failure', 'Current synthetic queue ref could not be verified');
          continue;
        }
        await this.evaluate('merge_group', { action: 'checks_requested', merge_group: {
          head_sha: sha, base_sha: entry?.baseCommit?.oid, base_ref: 'refs/heads/main', head_ref: matches[0].ref,
        } });
      }
    } finally {
      for (const sha of this.checks.keys()) if (!this.observed.has(sha)) this.checks.delete(sha);
      this.observed = null;
    }
  }
}
