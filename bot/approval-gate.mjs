import { REVIEW_BOT } from './identity.mjs';
import { readQueue, runHoldCheck } from './hold-check.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

export const APPROVAL_GATE = 'app-approval';
const SHA = /^[0-9a-f]{40}$/u;

// Only the deployed App's installation token publishes this check. Actions
// callers retain the generic hold-only status; no PR workflow is authority.
export class ApprovalGate {
  constructor({ github, store = null, now = Date.now, intervalMs = 300000, reviewer = REVIEW_BOT, wait = sleep }) {
    this.github = github;
    this.store = store;
    this.now = now;
    this.intervalMs = intervalMs;
    this.nextAt = 0;
    this.reviewer = reviewer;
    this.wait = wait;
    this.checks = new Map();
    this.dependencies = new Map();
    this.observed = null;
    let identity;
    for (const receipt of store?.all('SELECT * FROM approval_gate_heads WHERE app_id=? AND repo=?',
      github.appId, github.repo) ?? []) {
      if (!SHA.test(receipt.head_sha) || (receipt.check_run_id !== null
        && (!Number.isSafeInteger(receipt.check_run_id) || receipt.check_run_id < 1))
        || ![null, 'success', 'failure'].includes(receipt.conclusion)) throw new Error('Invalid durable approval-gate receipt');
      this.checks.set(receipt.head_sha, receipt.check_run_id === null ? undefined : {
        id: receipt.check_run_id, head_sha: receipt.head_sha, name: APPROVAL_GATE, app: { id: Number(github.appId) },
        status: receipt.conclusion === null ? 'in_progress' : 'completed', conclusion: receipt.conclusion,
      });
      const dependencies = receipt.dependencies_json === null ? null : JSON.parse(receipt.dependencies_json);
      if (dependencies !== null && (!Array.isArray(dependencies) || !dependencies.every((member) =>
        Number.isSafeInteger(member?.number) && member.number > 0 && SHA.test(member.head)))) {
        throw new Error('Invalid durable approval-gate dependencies');
      }
      this.dependencies.set(receipt.head_sha, dependencies);
    }
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
    if (existing === undefined) {
      this.store?.run('INSERT OR IGNORE INTO approval_gate_heads(app_id,repo,head_sha) VALUES(?,?,?)',
        this.github.appId, this.github.repo, sha);
      const path = `${this.base}/commits/${sha}/check-runs?check_name=${APPROVAL_GATE}&filter=all`;
      const checks = await this.github.paginate(path, 'check_runs');
      const own = checks.filter((check) => check.name === APPROVAL_GATE && check.head_sha === sha
        && check.app?.id === Number(this.github.appId) && Number.isSafeInteger(check.id));
      existing = own.sort((a, b) => b.id - a.id)[0] ?? null;
      this.checks.set(sha, existing);
      if (existing) this.store?.run(
        'UPDATE approval_gate_heads SET check_run_id=?,conclusion=? WHERE app_id=? AND repo=? AND head_sha=?',
        existing.id, ['success', 'failure'].includes(existing.conclusion) ? existing.conclusion : null,
        this.github.appId, this.github.repo, sha);
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
      // The remote write may succeed without a response, or outlive this process.
      // A restart must read GitHub, never trust the previous local conclusion.
      this.store?.run('UPDATE approval_gate_heads SET check_run_id=NULL,conclusion=NULL WHERE app_id=? AND repo=? AND head_sha=?',
        this.github.appId, this.github.repo, sha);
      const receipt = await this.github.request(existing ? 'PATCH' : 'POST',
        existing ? `${this.base}/check-runs/${existing.id}` : `${this.base}/check-runs`, body);
      if (!Number.isSafeInteger(receipt?.id) || receipt.head_sha !== sha
        || receipt.app?.id !== Number(this.github.appId) || receipt.name !== APPROVAL_GATE
        || receipt.status !== body.status || (!pending && receipt.conclusion !== conclusion)) {
        throw new Error('Approval-gate publication unconfirmed');
      }
      this.checks.set(sha, receipt);
      this.store?.run('UPDATE approval_gate_heads SET check_run_id=?,conclusion=? WHERE app_id=? AND repo=? AND head_sha=?',
        receipt.id, pending ? null : conclusion, this.github.appId, this.github.repo, sha);
    } catch (error) {
      this.checks.set(sha, undefined); // Keep the head known; reconcile an ambiguous write by reading.
      throw error;
    }
  }

  remember(sha, members) {
    // Membership is revocation evidence only, never cached approval authority.
    // Retain the union for a SHA if queue positions change on a later read.
    const previous = this.dependencies.get(sha) ?? [];
    const dependencies = [...new Map([...previous, ...members].map((member) =>
      [`${member.number}:${member.head}`, member])).values()];
    this.store?.run('INSERT OR IGNORE INTO approval_gate_heads(app_id,repo,head_sha) VALUES(?,?,?)',
      this.github.appId, this.github.repo, sha);
    this.store?.run('UPDATE approval_gate_heads SET dependencies_json=? WHERE app_id=? AND repo=? AND head_sha=?',
      JSON.stringify(dependencies), this.github.appId, this.github.repo, sha);
    this.dependencies.set(sha, dependencies);
  }

  affectedPull(number, head) {
    return new Set([...this.checks.keys()].filter((sha) => {
      const members = this.dependencies.get(sha);
      return sha === head || !members || members.some((member) => member.number === number || member.head === head);
    }).concat(SHA.test(head) ? [head] : []));
  }

  async evaluate(eventName, payload) {
    let failed = false;
    const incomplete = [];
    const core = { setFailed: () => { failed = true; }, error: (_message, pull) => { incomplete.push(pull); } };
    const pass = await runHoldCheck({ github: this.adapter,
      context: { repo: this.repo, eventName, payload }, core,
      reviewApp: this.reviewer.login.slice(0, -'[bot]'.length),
      publishStatus: (sha, state, description) => {
        if (state === 'success' && eventName !== 'merge_group') this.remember(sha, []);
        return this.publish(sha, state, description);
      },
      rememberGroup: (sha, members) => this.remember(sha,
        members.map((member) => ({ number: member.pullRequest.number, head: member.pullRequest.headRefOid }))),
      settleGroup: async (resolve) => {
        for (const delay of [250, 1000, 2000, 4000, null]) {
          try { return await resolve(); }
          catch (error) {
            if (delay === null) throw error;
            await this.wait(delay);
          }
        }
      } });
    if (incomplete.length) {
      const heads = new Set(incomplete.flatMap((pull) => pull
        ? [...this.affectedPull(pull.number, pull.head)] : [...this.checks.keys()]));
      await this.revokeKnown(heads);
      const error = new Error('Approval-gate membership or revocation incomplete');
      error.scopedApproval = incomplete.every(Boolean);
      throw error;
    }
    return pass && !failed;
  }

  async delivery(event, payload) {
    if (payload.repository?.full_name !== this.github.repo) return;
    let number;
    let head = payload.pull_request?.head?.sha;
    try {
      if (event === 'merge_group' && payload.action === 'checks_requested') {
        await this.evaluate('merge_group', payload);
      } else if ((event === 'pull_request_review' && ['submitted', 'edited', 'dismissed'].includes(payload.action))
        || (event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'edited', 'labeled', 'unlabeled',
          'ready_for_review', 'converted_to_draft'].includes(payload.action))) {
        // A delayed webhook is only a PR identity hint: fetch its current head.
        number = payload.pull_request?.number ?? payload.number;
        if (!Number.isSafeInteger(number) || number < 1) throw new Error('Missing approval-gate PR identity');
        const pr = await this.github.request('GET', `${this.base}/pulls/${number}`);
        head = pr?.head?.sha ?? head;
        if (pr.state === 'open') await this.evaluate('pull_request_target', { action: 'edited', pull_request: pr });
      }
    } catch (error) {
      await this.revokeKnown(event === 'merge_group'
        ? [payload.merge_group?.head_sha].filter((sha) => SHA.test(sha))
        : this.affectedPull(number, head));
      throw error;
    }
  }

  async revokeKnown(heads = this.checks.keys()) {
    let failed = false;
    for (const sha of [...heads]) {
      try { await this.publish(sha, 'failure', 'Live approval membership unavailable; prior authority revoked'); }
      catch { failed = true; }
    }
    if (failed) throw new Error('Known approval-gate authority could not be fully revoked');
  }

  async reconcile() {
    if (this.now() < this.nextAt) return;
    this.nextAt = this.now() + this.intervalMs;
    this.observed = new Set();
    let complete = false;
    const failures = [];
    try {
      let entries;
      let refs;
      try {
        try { await this.evaluate('approval_reconcile', { action: 'reconcile' }); }
        catch (error) {
          if (!error.scopedApproval) throw error;
          failures.push(error);
        }
        entries = await readQueue(this.adapter, this.repo, 'main');
        if (entries.length) {
          refs = await this.github.request('GET', `${this.base}/git/matching-refs/heads/gh-readonly-queue/main/`);
          if (!Array.isArray(refs)) throw new Error('Unknown approval-gate queue refs');
        }
      } catch (error) {
        await this.revokeKnown();
        throw error;
      }
      // One group's failed publication must not skip validation of later heads.
      for (const entry of entries) {
        const sha = entry?.headCommit?.oid;
        try {
          const matches = refs.filter((ref) => ref.object?.sha === sha
            && ref.ref?.startsWith('refs/heads/gh-readonly-queue/main/'));
          if (matches.length !== 1) {
            await this.publish(sha, 'failure', 'Current synthetic queue ref could not be verified');
            continue;
          }
          await this.evaluate('merge_group', { action: 'checks_requested', merge_group: {
            head_sha: sha, base_sha: entry?.baseCommit?.oid, base_ref: 'refs/heads/main', head_ref: matches[0].ref,
          } });
        } catch (error) {
          try { await this.revokeKnown([sha]); }
          catch (revocationError) { failures.push(revocationError); }
          failures.push(error);
        }
      }
      complete = failures.length === 0;
      if (failures.length) throw new AggregateError(failures, 'Approval-gate reconciliation incomplete');
    } finally {
      if (complete) for (const sha of this.checks.keys()) if (!this.observed.has(sha)) {
        this.checks.delete(sha);
        this.dependencies.delete(sha);
        this.store?.run('DELETE FROM approval_gate_heads WHERE app_id=? AND repo=? AND head_sha=?',
          this.github.appId, this.github.repo, sha);
      }
      this.observed = null;
    }
  }
}
