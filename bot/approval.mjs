import { BUILDER_BOT, REPOSITORY, REVIEW_APP_ID, REVIEW_BOT } from './identity.mjs';
import { githubRequestNotDispatched } from './github-app.mjs';

const DISABLE = `mutation($input: DisablePullRequestAutoMergeInput!) {
  disablePullRequestAutoMerge(input: $input) { pullRequest { id } }
}`;
const APPROVE_BODY = 'Automated review verdict: approve. This approval is for the exact commit_id; required CI checks govern merging.';
export const ownUser = (user) => user?.id === REVIEW_BOT.id && user.login === REVIEW_BOT.login;
// Orca/OMP workers push and comment as the builder App's bot user.
export const builderUser = (user) => user?.id === BUILDER_BOT.id && user?.login === BUILDER_BOT.login;
const AUTHORIZATION_ERRORS = new Set([
  'publication_cancelled', 'approval_admission_failed', 'approval_closed', 'approval_draft',
  'approval_target_changed', 'approval_head_changed', 'approval_conflicts', 'approval_identity_missing',
]);

export function effectiveHumanReviews(reviews) {
  if (!Array.isArray(reviews)) throw new Error('human_reviews_unavailable');
  const latest = new Map();
  for (const review of reviews) {
    if (review.user?.type === 'Bot' || ownUser(review.user)
      || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    const submittedAt = Date.parse(review.submitted_at);
    if (!Number.isSafeInteger(review.user?.id) || !Number.isSafeInteger(review.id)
      || !Number.isFinite(submittedAt)) throw new Error('human_reviews_unavailable');
    const prior = latest.get(review.user.id);
    if (!prior || submittedAt > Date.parse(prior.submitted_at)
      || (submittedAt === Date.parse(prior.submitted_at) && review.id > prior.id)) latest.set(review.user.id, review);
  }
  return latest;
}

export class Approval {
  constructor({ store, github, mode = 'advisory', mergeLaneEnabled = true, admit = async () => false, now = Date.now, log = () => {} }) {
    if (typeof mergeLaneEnabled !== 'boolean') throw new Error('Invalid mergeLaneEnabled');
    Object.assign(this, { store, github, mode, mergeLaneEnabled, admit, now, log });
    if (Number(github.appId) !== REVIEW_APP_ID || github.repo !== REPOSITORY) {
      throw new Error('Invalid approval App/repository binding');
    }
  }
  async live(row, guard) {
    await guard();
    const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${row.pr}`, undefined, guard);
    await guard();
    if (pr.state !== 'open') throw new Error('approval_closed');
    if (pr.draft) throw new Error('approval_draft');
    if (row.base_ref !== 'main' || pr.base?.ref !== 'main') throw new Error('approval_target_changed');
    if (pr.head?.sha !== row.head_sha || pr.head?.repo?.full_name !== this.github.repo
      || pr.base?.repo?.full_name !== this.github.repo) throw new Error('approval_head_changed');
    if (pr.mergeable === false) throw new Error('approval_conflicts');
    if (typeof pr.node_id !== 'string' || !pr.node_id) throw new Error('approval_identity_missing');
    return pr;
  }
  async find(row, marker = null, guard = async () => {}) {
    return (await this.github.paginate(`/repos/${this.github.repo}/pulls/${row.pr}/reviews`, null, guard))
      .find((review) => ownUser(review.user) && review.commit_id === row.head_sha && review.state === 'APPROVED'
        && (marker === null || review.body?.split('\n', 1)[0] === marker));
  }
  async humanChangesRequested(row, guard) {
    const reviews = await this.github.paginate(`/repos/${this.github.repo}/pulls/${row.pr}/reviews`, null, guard);
    await guard();
    for (const review of effectiveHumanReviews(reviews).values()) if (review.state === 'CHANGES_REQUESTED') return true;
    return false;
  }
  async disable(prNumber) {
    if (!this.mergeLaneEnabled) return false;
    const receipt = this.store.armedApproval(prNumber);
    if (!receipt) {
      this.store.clearArmed(prNumber, this.now());
      return false;
    }
    const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${prNumber}`);
    if (pr.node_id !== receipt.pull_request_id) throw new Error('approval_identity_missing');
    if (pr.state !== 'open' || pr.merged) {
      this.store.clearArmed(prNumber, this.now());
      return true;
    }
    if (pr.auto_merge && ownUser(pr.auto_merge.enabled_by)) {
      await this.github.graphql(DISABLE, { input: { pullRequestId: pr.node_id } });
      const current = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${prNumber}`);
      if (current.node_id !== receipt.pull_request_id || (current.state === 'open' && !current.merged
        && current.auto_merge && ownUser(current.auto_merge.enabled_by))) throw new Error('approval_disarm_unconfirmed');
    }
    // Do not disable a human's request, even if an earlier bot intent remains in SQLite.
    this.store.clearArmed(prNumber, this.now());
    return true;
  }
  async releaseBlockedApproval(row) {
    await this.disable(row.pr);
    if (this.store.approval(row.publication_id).armed) throw new Error('approval_disarm_unconfirmed');
    this.store.releaseUnpostedApproval(row.publication_id);
  }
  async run(row, review, guard = async () => {}) {
    if (!this.mergeLaneEnabled && this.store.sealedCarrier(row.pr)) return null;
    if (row.base_ref !== 'main' || this.mode !== 'approve' || !review.result.pass || review.verdict?.decision !== 'approve' || !await this.admit()) return null;
    const mutationGuard = async () => {
      await guard();
      if (this.mode !== 'approve' || !await this.admit()) throw new Error('approval_admission_failed');
      await guard();
      await this.live(row, guard);
    };
    const marker = `<!-- codex-review approval ${row.publication_id} -->`;
    let existing = this.store.approval(row.publication_id);
    // Disabling the lane freezes legacy merge authority, including uncertain
    // armed intents. Only the enabled lane/operator may reconcile those rows.
    if (!this.mergeLaneEnabled && existing?.armed) return null;
    if (['approval_review_blocked', 'failed:preflight'].includes(existing?.outcome)) {
      // Preflight failed before any APPROVE POST, or its send fence proved no
      // POST occurred. Only an unarmed reservation without a receipt can release.
      try { await this.releaseBlockedApproval(row); } catch (error) {
        if (error.code === 'github_budget_deferred') throw error;
        return null;
      }
      existing = this.store.approval(row.publication_id);
    }
    if (existing) {
      if (['approved', 'merged_direct'].includes(existing.outcome)) return existing;
      if (existing.outcome.startsWith('failed:')) {
        await this.disable(row.pr);
        return this.store.approval(row.publication_id);
      }
      if (existing.github_review_id !== null) {
        await this.disable(row.pr);
        return this.store.approval(row.publication_id);
      }
      // A durable intent is never a licence to repeat APPROVE after a crash.
      const adopted = await this.find(row, marker);
      if (adopted) return this.store.updateApproval(row.publication_id,
        { github_review_id: adopted.id, outcome: 'approved' }, this.now());
      await this.disable(row.pr);
      return this.store.updateApproval(row.publication_id, { outcome: 'failed:approval_interrupted' }, this.now());
    }
    let reserved = false;
    let stage = 'preflight';
    let approvalBlocked = null;
    let postStarted = false;
    let sendAuthorized = false;
    let guardBudgetUnsent = false;
    const reviewPath = `/repos/${this.github.repo}/pulls/${row.pr}/reviews`;
    const approvalAuthorization = async (phase) => {
      await mutationGuard();
      if (phase !== 'before_send') return;
      try {
        if (await this.humanChangesRequested(row, guard)) approvalBlocked = 'human_changes_requested';
      } catch (error) {
        if (error.message === 'publication_cancelled' || error.code === 'github_budget_deferred') throw error;
        approvalBlocked = 'human_reviews_unavailable';
      }
      if (!approvalBlocked) {
        await this.live(row, guard);
        sendAuthorized = true;
        return;
      }
      // Persist the proof before throwing: transport has not sent the APPROVE request.
      this.store.updateApproval(row.publication_id, { outcome: 'approval_review_blocked' }, this.now());
      throw new Error(approvalBlocked);
    };
    const approvalGuard = async (phase) => {
      try {
        await approvalAuthorization(phase);
      } catch (error) {
        // A nested read refusal describes that read, not the POST. Our own
        // first send fence can still prove that APPROVE was never authorized.
        if (error.code === 'github_budget_deferred' && !sendAuthorized) guardBudgetUnsent = true;
        throw error;
      }
    };
    try {
      const pr = await this.live(row, guard);
      // Read failures precede reservation/mutation, so reconciliation can safely retry.
      if (await this.humanChangesRequested(row, guard)) {
        this.log({ event: 'approval_skipped', pr: row.pr, skipped: 'human_changes_requested' });
        return null;
      }
      this.store.reserveApproval(row, pr.node_id, this.now());
      reserved = true;
      // Approval owns no merge request. Legacy owned requests are disarmed by disable().
      await this.live(row, guard);
      stage = 'approval_unconfirmed';
      let approved = await this.find(row, null, guard);
      if (!approved) {
        await this.live(row, guard);
        try {
          postStarted = true;
          approved = await this.github.request('POST', reviewPath, {
            commit_id: row.head_sha, event: 'APPROVE', body: `${marker}\n${APPROVE_BODY}`,
          }, approvalGuard);
        } catch (error) {
          if (approvalBlocked) throw error;
          if (error.code === 'github_budget_deferred'
            && (guardBudgetUnsent || githubRequestNotDispatched(error, 'POST', reviewPath))) {
            // This request never reached fetch, including any transport retries.
            this.store.updateApproval(row.publication_id, { outcome: 'approval_review_blocked' }, this.now());
            throw error;
          }
          // Read-only adoption is safe even if a concurrent close/head change cancelled the request.
          approved = await this.find(row, marker);
          if (!approved) throw error;
        }
      }
      if (!ownUser(approved.user) || approved.commit_id !== row.head_sha || approved.state !== 'APPROVED') {
        throw new Error('approval_receipt_invalid');
      }
      this.store.updateApproval(row.publication_id, { github_review_id: approved.id, outcome: 'approved' }, this.now());
      return this.store.approval(row.publication_id);
    } catch (error) {
      if (error.code === 'github_budget_deferred') {
        if (reserved && !postStarted) {
          // No POST was entered; restart must rerun all fresh authority fences.
          this.store.updateApproval(row.publication_id, { outcome: 'approval_review_blocked' }, this.now());
        }
        // An attempted POST retains its uncertain receipt for exact-marker adoption.
        throw error;
      }
      if (!reserved) return null;
      if (approvalBlocked) {
        this.log({ event: 'approval_skipped', pr: row.pr, skipped: approvalBlocked });
        try { await this.releaseBlockedApproval(row); } catch (releaseError) {
          if (releaseError.code === 'github_budget_deferred') throw releaseError;
          // Retain the blocked reservation for recovery.
        }
        return null;
      }
      const receipt = this.store.approval(row.publication_id);
      const reason = AUTHORIZATION_ERRORS.has(error.message) ? error.message : stage;
      if (receipt.outcome !== 'approved') {
        this.store.updateApproval(row.publication_id, { outcome: `failed:${reason}` }, this.now());
      }
      // Failure to disable leaves the durable armed intent available to reconciliation.
      try { await this.disable(row.pr); } catch { /* retain the armed receipt */ }
      return this.store.approval(row.publication_id);
    }
  }
  // null means ineligible or human-vetoed, with no merge attempted. Any thrown error
  // leaves the durable approval intact so the parent retains its selected lane.
  async merge(row, guard, beforeSend = async () => {}) {
    if (!this.mergeLaneEnabled) return null;
    if (typeof guard !== 'function') throw new Error('approval_merge_guard_required');
    // A GET's before_send phase is not the merge PUT's authorization boundary.
    // Keep cancellation fences, but never propagate read phases as mutations.
    const readGuard = () => guard();
    if (row.base_ref !== 'main' || this.mode !== 'approve' || !await this.admit()) return null;
    const receipt = this.store.approval(row.publication_id);
    if (!receipt || !['approved', 'merged_direct'].includes(receipt.outcome)) return null;
    if (receipt.pr !== row.pr || receipt.head_sha !== row.head_sha || !Number.isSafeInteger(receipt.github_review_id)) {
      throw new Error('approval_receipt_invalid');
    }
    const confirm = (pr) => pr.node_id === receipt.pull_request_id
      && pr.merged === true && pr.state === 'closed' && pr.head?.sha === row.head_sha
      && pr.head?.repo?.full_name === this.github.repo && pr.base?.ref === 'main'
      && pr.base?.repo?.full_name === this.github.repo && ownUser(pr.merged_by);
    const record = () => this.store.updateApproval(row.publication_id,
      { outcome: 'merged_direct', armed: 0 }, this.now());
    const mergeGuard = async (phase) => {
      await guard();
      if (this.mode !== 'approve') throw new Error('approval_admission_failed');
      // Transport token/response checkpoints need local cancellation fences, not
      // another remote authorization chain. Keep live preflight and send checks.
      if (phase !== 'preflight' && phase !== 'before_send') return;
      if (!await this.admit()) throw new Error('approval_admission_failed');
      const pr = await this.live(row, readGuard);
      if (pr.node_id !== receipt.pull_request_id) throw new Error('approval_identity_missing');
      const reviews = await this.github.paginate(`/repos/${this.github.repo}/pulls/${row.pr}/reviews`, null, readGuard);
      await guard();
      const approved = reviews.find((review) => review.id === receipt.github_review_id
        && ownUser(review.user) && review.commit_id === row.head_sha && review.state === 'APPROVED');
      if (!approved) throw new Error('approval_receipt_missing');
      for (const review of effectiveHumanReviews(reviews).values()) {
        if (review.state === 'CHANGES_REQUESTED') throw new Error('human_changes_requested');
      }
      // Reviews are another network round trip: recheck the live head after reading them.
      const current = await this.live(row, readGuard);
      if (current.node_id !== receipt.pull_request_id) throw new Error('approval_identity_missing');
      await guard(phase === 'before_send' ? phase : undefined);
      if (phase === 'before_send') await beforeSend();
    };
    // A previous process may have merged successfully before recording the outcome.
    const observed = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${row.pr}`, undefined, readGuard);
    if (confirm(observed)) return record();
    try {
      await mergeGuard('preflight');
    } catch (error) {
      if (error.message === 'human_changes_requested') return null;
      throw error;
    }
    try {
      const merged = await this.github.request('PUT', `/repos/${this.github.repo}/pulls/${row.pr}/merge`,
        { sha: row.head_sha, merge_method: 'merge' }, mergeGuard);
      if (merged?.merged !== true) throw new Error('approval_merge_unconfirmed');
    } catch (error) {
      const rejected = `GitHub request failed: PUT /repos/${this.github.repo}/pulls/${row.pr}/merge HTTP `;
      if (error.message.startsWith(rejected) && /^4\d\d$/u.test(error.message.slice(rejected.length))) throw error;
      // Never infer success from "closed" or another actor's merge after an uncertain PUT.
      let current;
      try { current = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${row.pr}`); }
      catch { throw error; }
      if (!confirm(current)) throw error;
    }
    return record();
  }
}
