import { randomBytes } from 'node:crypto';
import { mergeGate } from './merge-gate.mjs';
import { botMayUpdateBranch } from './shepherd.mjs';
import { effectiveHumanReviews, ownUser } from './approval.mjs';
import { REVIEW_APP_ID } from './identity.mjs';
import { batchLimit, mergePriority, selectClosedBatch, ancestryViolations, manifestDigest } from './batch-plan.mjs';
import { carrierBranch, carrierMarker } from './batch-author.mjs';
import { readBatchCiProof, confirmBatchTree } from './batch-proof.mjs';
import { sanitize } from './evidence.mjs';
import { CandidateHints, prepareInOrder } from './read-preparation.mjs';
import { invalidateInformational } from './informational-cache.mjs';
import { withGitHubPriority } from './github-budget.mjs';
import { githubRequestNotDispatched } from './github-app.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const SELECTION_STALL_MS = 30 * 60 * 1000;
const uid = () => randomBytes(12).toString('hex');
const rejected = (error) => /^GitHub request failed: (?:POST|PUT|PATCH|DELETE) \/\S+ HTTP 4\d\d$/u.test(error.message);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// Mirror the local admission predicates, not presentation JSON or receipt
// timestamps rewritten by idempotent evidence publication.
function reviewIdentity(row) {
  if (!row) return null;
  const report = row.result_json ? JSON.parse(row.result_json) : null;
  return [row.id, row.pr, row.head_sha, row.base_ref, row.base_sha, row.status, row.reason, row.attempt,
    row.allow_draft, row.due_at, row.check_run_id, row.run_id, row.publication_id, row.conclusion,
    row.bot_revision, row.rerequest_watermark, row.ambiguous_rereviews, Boolean(row.result_json),
    report?.result?.pass, report?.verdict?.decision, report?.verdict?.reason, report?.publication_id];
}
function approvalIdentity(receipt) {
  return receipt ? [receipt.publication_id, receipt.pr, receipt.head_sha, receipt.review_id, receipt.pull_request_id,
    receipt.armed, receipt.github_review_id, receipt.outcome, receipt.auto_merge_owner, receipt.arm_error] : null;
}
// Only authority changes release a rejected native receipt. Main, labels, CI,
// cache invalidation and process restarts are not fresh approval authority.
function memberApprovalIdentity(member) {
  return { pr: member.pr, head_sha: member.head_sha, review_id: member.review_id,
    publication_id: member.publication_id, github_review_id: member.github_review_id,
    pull_request_id: member.pull_request_id };
}
const receiptTime = (value) => typeof value === 'number' ? value : Date.parse(value) || 0;

function selectCarrierEligibleBatch({ ready, ...options }) {
  let candidates = ready;
  let selected = selectClosedBatch({ ready: candidates, ...options });
  const excludedCarrierOnly = new Set();
  // Each pass removes one singleton and recomputes closure. A dependent PR
  // cannot become an unchecked single when its carrier-only dependency is removed.
  while (selected.members.length === 1 && selected.members[0].carrier_only) {
    const pr = selected.members[0].pr;
    excludedCarrierOnly.add(pr);
    candidates = candidates.filter((member) => member.pr !== pr);
    selected = selectClosedBatch({ ready: candidates, ...options });
  }
  return { ...selected, excludedCarrierOnly };
}

// One lane owns both N=1 original PRs and N>1 carriers. Reviews remain owned by
// Scheduler; every native main mutation still goes through Approval.merge.
export class BatchLane {
  // Ownership is process-local: a persisted intent after restart stays uncertain
  // until native reconciliation records its receipt.
  #liveMutations = new Set();
  #collectingDeadline = null;
  #conflictBase = null;
  #candidateBase = null;
  #knownConflicts = [];
  constructor({ host, author = null, mirror = null, maxSize = 5, collectSeconds = 180, batchEnabled = false, readProof = readBatchCiProof, confirmTree = confirmBatchTree,
    selectionPaused = async () => false }) {
    const limit = batchLimit(maxSize);
    if (!Number.isInteger(collectSeconds) || collectSeconds < 0 || collectSeconds > 900) throw new Error('Invalid MERGE_BATCH_COLLECT_SECONDS');
    Object.assign(this, { host, author, mirror, collectSeconds, maxSize: batchEnabled ? limit : 1, readProof, confirmTree, selectionPaused });
    this.candidateHints = new CandidateHints(() => this.now());
  }
  get store() { return this.host.store; }
  get github() { return this.host.github; }
  now() { return this.host.now(); }
  knownConflicts(base, open) {
    if (base !== this.#conflictBase) {
      this.#conflictBase = base;
      this.#knownConflicts = [];
    }
    const heads = new Map(open.map((member) => [member.pr, member.head_sha]));
    this.#knownConflicts = this.#knownConflicts.filter((conflict) => conflict.every(
      (member) => heads.get(member.pr) === member.head_sha));
    return this.#knownConflicts;
  }
  current(batch) { return this.store.mergeBatch(batch.id, batch.generation); }
  patch(batch, values) { return this.store.updateMergeBatch(batch.id, batch.generation, { ...values, updated_at: this.now() }); }
  active(batch) {
    const active = this.store.activeMergeBatch();
    return active?.id === batch.id && active.generation === batch.generation;
  }
  checkpoint(batch, authorize = true) {
    if (this.host.mode !== 'approve' || !this.active(batch)) throw new Error('merge_batch_changed');
    const current = this.current(batch);
    if (batch.sealed && (!current.sealed || current.head_sha !== batch.head_sha || current.base_sha !== batch.base_sha
      || current.tree_sha !== batch.tree_sha || current.manifest_digest !== batch.manifest_digest
      || !same(current.members, batch.members))) throw new Error('merge_batch_changed');
    if (authorize) for (const member of batch.members) {
      const row = this.store.review(member.review_id);
      if (!row || row.pr !== member.pr || row.head_sha !== member.head_sha) throw new Error('batch_member_review_changed');
      this.host.approvalCheckpoint(row);
    }
  }
  async admitted(batch) {
    this.checkpoint(batch);
    if (!await this.host.approval.admit()) throw new Error('approval_admission_failed');
    this.checkpoint(batch);
  }
  async nativeFence(batch) {
    await this.main(batch);
    if (batch.kind === 'batch') {
      await this.fenceMembers(batch);
      if (batch.target_pr) {
        const { pr, mainSha, behindBy } = await this.host.shepherd.inspect(batch.target_pr);
        if (pr.state !== 'open' || pr.draft || pr.node_id !== batch.target_node_id
          || pr.head.sha !== batch.head_sha || pr.head.ref !== batch.carrier_branch
          || pr.base?.ref !== 'main' || pr.head?.repo?.full_name !== this.github.repo
          || mainSha !== batch.base_sha || behindBy !== 0 || !mergeGate(pr).pass) throw new Error('batch_member_authorization_changed');
        const humans = effectiveHumanReviews(await this.github.paginate(`/repos/${this.github.repo}/pulls/${pr.number}/reviews`));
        if ([...humans.values()].some((review) => review.state === 'CHANGES_REQUESTED')) throw new Error('batch_member_authorization_changed');
      }
    } else {
      await this.fenceMembers(batch);
      const inspection = await this.host.shepherd.inspect(batch.target_pr);
      const prepared = await this.host.prepareReadiness(inspection);
      if (inspection.pr.head.sha !== batch.head_sha || inspection.pr.node_id !== batch.target_node_id
        || inspection.mainSha !== batch.base_sha || prepared.state !== 'prepared'
        || prepared.row.id !== batch.members[0].review_id) throw new Error('batch_member_authorization_changed');
    }
    this.checkpoint(batch);
  }
  async admitNative(batch) {
    return this.host.nativeCi.admit({
      checkpoint: (...args) => this.checkpoint(...args),
      main: (candidate) => this.nativeFence(candidate),
      current: (...args) => this.current(...args),
      begin: (...args) => this.begin(...args),
      finish: (...args) => this.finish(...args),
    }, batch);
  }
  async resumeNative(batch, ci) {
    // Only a dispatched request (including a rejected write) consumes this
    // candidate's single automatic retry. Unknown writes remain pending.
    const requested = () => {
      for (let generation = 1; generation <= batch.generation; generation++) {
        const history = this.store.mergeBatch(batch.id, generation);
        if (history?.operations.some(({ intent, receipt }) => intent.kind === 'ci_rerun'
          && receipt.outcome !== 'not_dispatched'
          && intent.purpose === 'native_admission' && intent.head_sha === batch.head_sha)) return true;
      }
      return false;
    };
    if (requested()) return;
    if (!this.author) throw new Error('batch_native_author_unavailable');
    let intentId;
    try {
      await this.author.rerunCi(batch, ci, async (phase) => {
        this.checkpoint(batch);
        if (phase !== 'before_send') return;
        await this.nativeFence(batch);
        const latest = await this.host.latestCi(batch.head_sha);
        if (latest?.id !== ci.id || latest.run_attempt !== ci.run_attempt
          || latest.status !== 'completed' || await this.host.nativeCi.preparation(latest) !== 'deferred'
          || requested()) throw new Error('batch_rerun_target_changed');
        intentId = this.begin(batch, 'ci_rerun', { purpose: 'native_admission', failed_only: true,
          run_id: ci.id, previous_attempt: ci.run_attempt }).mutation.id;
      }, { failedOnly: true });
    } catch (error) {
      this.finishUnsent(batch, error, 'POST', `/repos/${this.github.repo}/actions/runs/${ci.id}/rerun-failed-jobs`, intentId);
      if (rejected(error) && this.current(batch).mutation?.kind === 'ci_rerun') this.finish(batch, { outcome: 'rejected', reason: error.message });
      throw error;
    }
  }
  begin(batch, kind, values = {}) {
    const current = this.store.beginBatchMutation(batch.id, batch.generation, {
      id: `${kind}-${uid()}`, kind, head_sha: batch.head_sha, main_sha: batch.base_sha,
      marker: null, ...values,
    }, this.now());
    this.#liveMutations.add(current.mutation.id);
    return current;
  }
  finish(batch, receipt, transition = null) {
    let intentId;
    const result = this.store.transaction(() => {
      const current = this.current(batch);
      if (!current?.mutation) throw new Error('batch_mutation_receipt_without_intent');
      intentId = current.mutation.id;
      const finished = this.store.finishBatchMutation(batch.id, batch.generation, current.mutation.id, receipt, this.now());
      // Losing the intent without its native identity/next phase would turn a
      // successful remote write into a duplicate POST or a lost merge receipt.
      return transition ? this.patch(finished, transition) : finished;
    });
    this.#liveMutations.delete(intentId);
    return result;
  }
  finishUnsent(batch, error, method, path, intentId) {
    // Only this invocation's intent is eligible; a restarted intent is uncertain.
    if (intentId && this.current(batch).mutation?.id === intentId && githubRequestNotDispatched(error, method, path)) {
      this.finish(batch, { outcome: 'not_dispatched', reason: error.message });
    }
  }
  async open() { return this.github.paginate(`/repos/${this.github.repo}/pulls?state=open`); }
  snapshots(open) { return open.map((pr) => ({ pr: pr.number, head_sha: pr.head?.sha })); }
  member(inspection, readiness) {
    const receipt = this.store.approvalForReview(readiness.row.id);
    return { pr: inspection.pr.number, head_sha: inspection.pr.head.sha,
      review_id: readiness.row.id, publication_id: readiness.row.publication_id ?? readiness.row.id,
      github_review_id: receipt.github_review_id, pull_request_id: receipt.pull_request_id,
      ci_run_id: readiness.ci.id, ci_attempt: readiness.ci.run_attempt ?? 1,
      priority: mergePriority(inspection.pr), created_at: inspection.pr.created_at };
  }
  invalidateCandidates(tags) { this.candidateHints.invalidate(tags); }
  candidateLocalIdentity(pr, headSha) {
    const row = this.store.latest(pr, headSha);
    const quarantine = this.store.nativeCiFailure(pr, headSha);
    return JSON.stringify([reviewIdentity(row), approvalIdentity(row && this.store.approvalForReview(row.id)),
      reviewIdentity(this.store.active(pr)), this.store.latest(pr)?.id,
      reviewIdentity(this.store.exhaustedFailure(pr, headSha)),
      quarantine && [quarantine.pr, quarantine.head_sha, quarantine.run_id, quarantine.run_attempt, quarantine.job_id, quarantine.reason],
      this.host.pendingRestart(pr, headSha)?.id ?? null, row && this.host.hasPendingEnqueue(row),
      row && Boolean(this.host.pendingCancels?.has(row.id)), this.host.mode, this.host.admission?.state?.mode ?? null]);
  }
  unchangedReviewStatus(row) {
    return this.candidateHints.matchesLocal(row.pr, row.head_sha, this.candidateLocalIdentity(row.pr, row.head_sha));
  }
  candidateKey(pr) {
    return JSON.stringify([this.#candidateBase, pr.number, pr.node_id, pr.head.sha, pr.head.ref, pr.head.repo?.full_name,
      pr.base?.sha, pr.base?.ref, pr.base?.repo?.full_name, pr.state, pr.draft, pr.body, pr.auto_merge,
      pr.user?.id, pr.user?.login, pr.user?.type, pr.created_at,
      (pr.labels ?? []).map((label) => typeof label === 'string' ? label : label.name).sort(),
      this.candidateLocalIdentity(pr.number, pr.head.sha)]);
  }
  async discoverCandidate(pr) {
    const key = this.candidateKey(pr);
    const token = this.candidateHints.capture(pr.number, pr.head.sha);
    const cached = this.candidateHints.get(pr.number, key);
    if (cached) return { key, token, ...cached.value };
    const options = { informational: true, headSha: pr.head.sha, pr: pr.number };
    const inspection = await this.host.shepherd.inspect(pr.number, options);
    if (inspection.pr.head.sha !== pr.head.sha || inspection.pr.base?.sha !== pr.base?.sha) return { key };
    const readiness = await this.host.prepareReadiness(inspection, options);
    if (key !== this.candidateKey(pr) || !this.candidateHints.valid(pr.number, pr.head.sha, token)) return { key };
    const value = { inspection, readiness, localIdentity: this.candidateLocalIdentity(pr.number, pr.head.sha) };
    // An externally managed behind head must prove its live routing on each attempt.
    if (!readiness.carrierOnly) this.candidateHints.put(pr.number, pr.head.sha, key, value, token);
    return { key, token, ...value };
  }
  deferBudget(error, pr = null) {
    if (this.host.deferBudget) return this.host.deferBudget(error, pr, 'lane');
    this.host.reconcileSoon(Math.max(1000, error.retryAt - this.now()));
    this.host.log({ event: 'merge_batch_deferred', status: 'DEFERRED', pr,
      reason: sanitize(error.reason ?? error.code, { limit: 100 }),
      priority: error.priority, retryAt: error.retryAt });
  }
  async select(open) {
    // Approval recovery may enter the lane while presentation workers are live.
    // Existing batch work can proceed, but discovery must not nest another pool.
    if (this.host.presentationPreparations) return null;
    // Local eligibility is only a discovery filter, never merge authority.
    // Preserve the complete open list below for dependency closure.
    const publishing = this.store.pendingBatchPublications();
    const candidates = open.filter((pr) => {
      if (pr.state !== 'open' || pr.draft || pr.base?.ref !== 'main'
        || pr.head?.repo?.full_name !== this.github.repo || this.store.sealedCarrier(pr.number)
        || publishing.some((batch) => batch.members.some((member) => member.pr === pr.number))) return false;
      const row = this.store.latest(pr.number, pr.head.sha);
      const receipt = row && this.store.approvalForReview(row.id);
      return row?.status === 'completed' && row.base_ref === 'main' && receipt?.outcome === 'approved'
        && !this.store.rejectedBatchApproval(memberApprovalIdentity({
          pr: pr.number, head_sha: pr.head.sha, review_id: row.id,
          publication_id: row.publication_id ?? row.id,
          github_review_id: receipt.github_review_id, pull_request_id: receipt.pull_request_id,
        }));
    });
    if (!candidates.length) return null;
    if (await this.selectionPaused()) return null;
    // A cached inspection cannot discover a moved main branch. Bind discovery
    // hints to one fresh canonical main observation on every selection pass.
    const main = (await withGitHubPriority('merge', () =>
      this.github.request('GET', `/repos/${this.github.repo}/git/ref/heads/main`))).object?.sha;
    if (!SHA.test(main)) throw new Error('batch_main_unavailable');
    if (main !== this.#candidateBase) {
      if (this.#candidateBase !== null) invalidateInformational(this.github, { all: true });
      this.invalidateCandidates({ all: true });
      this.#candidateBase = main;
    }
    const ready = [];
    const keys = new Map();
    const tokens = new Map();
    const base = main;
    for await (const { item: pr, value, error } of prepareInOrder(candidates,
      (pr) => withGitHubPriority('merge', () => this.discoverCandidate(pr)),
      () => this.host.mode === 'approve' && !(this.now() < this.github?.retryAt))) {
      try {
        if (error) throw error;
        if (!value?.inspection || value.key !== this.candidateKey(pr)
          || !this.candidateHints.valid(pr.number, pr.head.sha, value.token)) continue;
        const { inspection, readiness } = value;
        if (readiness.state !== 'prepared') continue;
        if (inspection.mainSha !== base) {
          this.invalidateCandidates({ pr: pr.number });
          this.host.reconcileSoon(0);
          return null;
        }
        const member = this.member(inspection, readiness);
        member.carrier_only = Boolean(readiness.carrierOnly || inspection.behindBy > 0 && !botMayUpdateBranch(inspection.pr));
        member.ready_at = Math.max(receiptTime(this.store.approvalForReview(readiness.row.id)?.updated_at),
          receiptTime(readiness.ci.completed_at ?? readiness.ci.updated_at));
        ready.push(member);
        keys.set(pr.number, value.key);
        tokens.set(pr.number, value.token);
      } catch (error) {
        if (error.code === 'github_budget_deferred') {
          this.deferBudget(error, pr.number);
          return null;
        }
        if (this.host.reconcileCounts) this.host.reconcileCounts.failed++;
        this.host.log({ event: 'merge_candidate_failed', pr: pr.number,
          cause: sanitize(error.message, { secrets: this.host.publisher?.secrets ?? [], limit: 1000 }) });
      }
    }
    if (!ready.length || !base) return null;
    if (!this.mirror) throw new Error('batch_ancestry_reader_unavailable');
    const pendingFallbacks = this.store.pendingBatchFallbacks();
    const forceSerial = [...new Set(pendingFallbacks.flatMap((batch) => batch.members.filter((member) => !batch.fallback_done.includes(member.pr)).map((member) => member.pr)))];
    const context = { id: uid(), generation: 1, base_sha: base, selected_at: this.now(), mutation: null };
    const allOpen = this.snapshots(open);
    const dependencies = await this.mirror.dependencies(context, ready, allOpen);
    const selected = selectCarrierEligibleBatch({ ready, open: allOpen, dependencies, max: this.maxSize, forceSerial,
      knownConflicts: this.knownConflicts(base, allOpen) });
    for (const deferred of selected.deferred) this.host.log({ event: 'merge_batch_deferred', ...deferred });
    if (!selected.members.length) { await this.mirror.discard(context); return null; }
    const single = selected.members.length === 1;
    const fallback = single ? pendingFallbacks.find((batch) => batch.members.some((member) => member.pr === selected.members[0].pr)
      && !batch.fallback_done.includes(selected.members[0].pr)) : null;
    if (!fallback && selected.members.length < this.maxSize && !selected.members.some((member) => member.priority === 0)
      && this.collectSeconds > 0) {
      const deadline = Math.max(this.store.lastRetiredBatchAt(), Math.min(...selected.members.map((member) => member.ready_at)))
        + this.collectSeconds * 1000;
      if (this.now() < deadline) {
        if (this.#collectingDeadline !== deadline) {
          this.#collectingDeadline = deadline;
          this.host.log({ event: 'merge_batch_collecting', members: selected.members.map((member) => member.pr), deadline });
        }
        // Re-arm on every selection attempt, even when a full sweep cleared the
        // prior wakeup. The deadline itself is still derived from durable receipts.
        this.host.reconcileSoon(Math.max(0, deadline - this.now()));
        await this.mirror.discard(context);
        return null;
      }
    }
    this.#collectingDeadline = null;
    if (await this.selectionPaused()) { await this.mirror.discard(context); return null; }
    // Discovery (including a cached green hint) is never selection authority.
    // Revalidate only the selected members, unconditionally, before persistence.
    let fenceStage = 'selected_inspection';
    let fenceMember = null;
    try {
      for (const member of selected.members) {
        fenceMember = member;
        fenceStage = 'selected_inspection';
        const inspection = await withGitHubPriority('merge', () => this.host.shepherd.inspect(member.pr));
        fenceStage = 'selected_readiness';
        const readiness = await withGitHubPriority('merge', () => this.host.prepareReadiness(inspection));
        fenceStage = 'selected_readiness_state';
        if (readiness.state !== 'prepared') throw new Error('merge_candidate_changed');
        fenceStage = 'selected_main';
        if (inspection.mainSha !== base) throw new Error('merge_candidate_changed');
        fenceStage = 'selected_carrier_routing';
        if (Boolean(readiness.carrierOnly || inspection.behindBy > 0 && !botMayUpdateBranch(inspection.pr)) !== member.carrier_only) {
          throw new Error('merge_candidate_changed');
        }
        fenceStage = 'selected_head';
        if (inspection.pr.head.sha !== member.head_sha) throw new Error('merge_candidate_changed');
        fenceStage = 'selected_member_identity';
        if (!same(this.member(inspection, readiness), {
            pr: member.pr, head_sha: member.head_sha, review_id: member.review_id, publication_id: member.publication_id,
            github_review_id: member.github_review_id, pull_request_id: member.pull_request_id,
            ci_run_id: member.ci_run_id, ci_attempt: member.ci_attempt, priority: member.priority, created_at: member.created_at,
          })) throw new Error('merge_candidate_changed');
        fenceStage = 'selected_approval';
        this.host.approvalCheckpoint(readiness.row);
      }
      fenceMember = null;
      fenceStage = 'selection_paused';
      if (await this.selectionPaused()) throw new Error('merge_selection_paused');
      fenceStage = 'selection_mode_backoff';
      if (this.host.mode !== 'approve' || this.now() < this.github?.retryAt) throw new Error('merge_candidate_changed');
      for (const member of selected.members) {
        fenceMember = member;
        fenceStage = 'selected_local_identity';
        const pr = open.find((pr) => pr.number === member.pr);
        if (!pr || keys.get(member.pr) !== this.candidateKey(pr)) throw new Error('merge_candidate_changed');
        fenceStage = 'selected_local_approval';
        this.host.approvalCheckpoint(this.store.review(member.review_id));
      }
      // Keep every selected token live through the last synchronous authority
      // checkpoint. No await separates this fence from durable selection.
      fenceStage = 'selected_token_before_persistence';
      for (const member of selected.members) {
        fenceMember = member;
        if (!this.candidateHints.valid(member.pr, member.head_sha, tokens.get(member.pr))) {
          throw new Error('merge_candidate_changed');
        }
      }
    } catch (error) {
      if (error.code !== 'github_budget_deferred') {
        for (const member of selected.members) this.invalidateCandidates({ pr: member.pr });
      }
      await this.mirror.discard(context);
      if (error.code === 'github_budget_deferred') this.deferBudget(error, fenceMember?.pr ?? null);
      else {
        this.host.reconcileSoon(0);
        this.host.log({ event: 'merge_candidate_revalidation_failed', fence_stage: fenceStage,
          pr: fenceMember?.pr ?? null, head_sha: fenceMember?.head_sha ?? null,
          members: selected.members.map(({ pr, head_sha }) => ({ pr, head_sha })), main: base,
          cause: sanitize(error.message, { secrets: this.host.publisher?.secrets ?? [], limit: 1000 }) });
      }
      return null;
    }
    const batch = this.store.selectMergeBatch({ ...context, kind: single ? 'single' : 'batch', state: 'selected',
      members: selected.members, target_pr: single ? selected.members[0].pr : null,
      target_node_id: single ? selected.members[0].pull_request_id : null,
      head_sha: single ? selected.members[0].head_sha : null,
      fallback_of: fallback ? { id: fallback.id, generation: fallback.generation } : null,
      updated_at: this.now() });
    this.host.log({ event: 'merge_batch_selected', id: batch.id, generation: batch.generation,
      members: batch.members.map((member) => member.pr), main: base, kind: batch.kind });
    return batch;
  }
  async fenceMembers(batch) {
    this.checkpoint(batch);
    for (const member of batch.members) {
      const inspection = await this.host.shepherd.inspect(member.pr);
      const ready = await this.host.prepareReadiness(inspection);
      if (ready.state !== 'prepared' || inspection.pr.head.sha !== member.head_sha
        || ready.row.id !== member.review_id || ready.ci.id !== member.ci_run_id
        || (ready.ci.run_attempt ?? 1) !== member.ci_attempt) throw new Error('batch_member_authorization_changed');
      const receipt = this.store.approvalForReview(ready.row.id);
      if (receipt.github_review_id !== member.github_review_id || receipt.pull_request_id !== member.pull_request_id) throw new Error('batch_member_approval_changed');
      const nativeReviews = await this.github.paginate(`/repos/${this.github.repo}/pulls/${member.pr}/reviews`);
      const nativeReview = nativeReviews.find((review) => review.id === member.github_review_id && ownUser(review.user)
        && review.commit_id === member.head_sha);
      if (nativeReview?.state !== 'APPROVED') {
        // A successful list can lag an approval POST, and a pending draft can
        // still submit APPROVED with the same ID. Only terminal negatives stick.
        const rejectedApproval = ['DISMISSED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(nativeReview?.state)
          ? memberApprovalIdentity(member) : null;
        throw Object.assign(new Error('batch_member_approval_changed'), rejectedApproval ? { rejectedApproval } : {});
      }
      const live = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${member.pr}`);
      if (live.state !== 'open' || live.draft || live.head?.sha !== member.head_sha
        || live.node_id !== member.pull_request_id || live.base?.ref !== 'main'
        || live.head?.repo?.full_name !== this.github.repo || !mergeGate(live).pass) throw new Error('batch_member_authorization_changed');
      this.checkpoint(batch);
    }
  }
  async main(batch) {
    const ref = await this.github.request('GET', `/repos/${this.github.repo}/git/ref/heads/main`);
    if (ref.object?.sha !== batch.base_sha) throw new Error('batch_main_changed');
    this.checkpoint(batch);
  }
  async closure(batch) {
    const open = await this.open();
    for (const member of batch.members) {
      const live = open.find((pr) => pr.number === member.pr);
      if (!live || live.head?.sha !== member.head_sha || live.node_id !== member.pull_request_id
        || live.draft || live.base?.ref !== 'main' || live.head?.repo?.full_name !== this.github.repo
        || !mergeGate(live).pass) throw new Error('batch_member_authorization_changed');
    }
    const filtered = batch.kind === 'batch' ? open.filter((pr) => pr.number !== batch.target_pr
      || pr.head?.sha !== batch.head_sha) : open;
    const snapshots = this.snapshots(filtered);
    const ancestry = await this.mirror.ancestry(batch, snapshots);
    this.checkpoint(batch);
    if (ancestryViolations({ open: snapshots, members: batch.members, ...ancestry }).length) throw new Error('batch_ancestry_changed');
  }
  async invalidate(batch, reason, fallback = false, rejectedApproval = null) {
    batch = this.current(batch);
    if (batch.mutation) throw new Error('batch_mutation_unresolved');
    if (batch.state === 'closing') {
      reason = batch.closing_reason;
      fallback = batch.closing_fallback;
    } else batch = this.patch(batch, { state: 'closing', closing_reason: reason, closing_fallback: fallback,
      ...(rejectedApproval ? { rejected_approval: rejectedApproval } : {}) });
    await this.host.nativeCi.revoke(this, batch);
    if (batch.kind === 'batch' && batch.target_pr) {
      const native = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${batch.target_pr}`);
      if (!native.merged) {
        let intentId;
        try {
          const closed = await this.author.closeCarrier(batch, async (phase) => {
            this.checkpoint(batch, false);
            if (phase === 'before_send' && !this.current(batch).mutation) intentId = this.begin(batch, 'close_carrier').mutation.id;
          });
          if (this.current(batch).mutation) this.finish(batch, { outcome: 'closed', pr: closed.number });
        } catch (error) {
          this.finishUnsent(batch, error, 'PATCH', `/repos/${this.github.repo}/pulls/${batch.target_pr}`, intentId);
          if (rejected(error) && this.current(batch).mutation?.kind === 'close_carrier') this.finish(batch, { outcome: 'rejected', reason: error.message });
          throw error;
        }
      }
    }
    const retired = this.store.retireMergeBatch(batch.id, batch.generation, fallback ? 'fallback' : 'invalidated', this.now(), reason);
    this.host.log({ event: 'merge_batch_invalidated', id: batch.id, generation: batch.generation, reason, fallback });
    await this.mirror?.discard(retired);
    this.host.reconcileSoon(0);
  }
  async refreshSingle(batch, inspection) {
    let retired;
    const replacement = this.store.transaction(() => {
      retired = this.store.retireMergeBatch(batch.id, batch.generation, 'refreshed', this.now());
      const pr = inspection.pr;
      return this.store.selectMergeBatch({ id: retired.id, generation: retired.generation + 1, kind: 'single', state: 'selected',
        selected_at: this.now(), updated_at: this.now(), base_sha: inspection.mainSha, head_sha: pr.head.sha,
        // The observed head is known; null authorization receipts still wait for
        // its own review and CI through the normal admission checks.
        target_pr: pr.number, target_node_id: pr.node_id, needs_inspection: false, fallback_of: retired.fallback_of,
        members: [{ pr: pr.number, head_sha: pr.head.sha, review_id: null, publication_id: null,
          github_review_id: null, pull_request_id: pr.node_id, ci_run_id: null, ci_attempt: null,
          priority: mergePriority(pr), created_at: pr.created_at }] });
    });
    await this.mirror.discard(retired);
    return replacement;
  }
  async reconcileMutation(batch) {
    const pending = batch.mutation;
    if (!pending) return true;
    if (['native_admission', 'native_admission_revoke'].includes(pending.kind)) return this.host.nativeCi.reconcile(this, batch);
    if (pending.kind === 'comment') {
      await this.publish(batch, pending.comment_pr);
      return !this.current(batch).mutation;
    }
    this.checkpoint(batch, false);
    if (pending.kind === 'ci_rerun') {
      const run = await this.github.request('GET', `/repos/${this.github.repo}/actions/runs/${pending.run_id}`);
      const source = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${batch.target_pr}`);
      if (source.head.sha !== pending.head_sha) {
        this.finish(batch, { outcome: 'superseded', reason: 'rerun_only_affects_old_immutable_head' });
        return true;
      }
      if (run.id !== pending.run_id || run.head_sha !== pending.head_sha) throw new Error('batch_rerun_identity_changed');
      if ((run.run_attempt ?? 1) <= pending.previous_attempt) return false;
      this.finish(batch, { outcome: 'fresh_attempt_observed', run_id: run.id, attempt: run.run_attempt });
      return true;
    }
    if (pending.kind === 'create_ref') {
      if (await this.author.readBranch(batch.carrier_branch) !== batch.head_sha) return false;
      this.finish(batch, { outcome: 'published', branch: batch.carrier_branch, head_sha: batch.head_sha });
      return true;
    }
    if (pending.kind === 'create_carrier') {
      const pr = await this.author.findCarrier(batch);
      if (!pr) return false;
      this.finish(batch, { outcome: 'created', pr: pr.number, node_id: pr.node_id, head_sha: pr.head.sha },
        { target_pr: pr.number, target_node_id: pr.node_id, state: 'testing' });
      return true;
    }
    if (pending.kind === 'close_carrier') {
      const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${batch.target_pr}`);
      if (pr.state !== 'closed') return false;
      this.finish(batch, { outcome: 'closed', pr: pr.number });
      return true;
    }
    if (['merge', 'update'].includes(pending.kind)) {
      const inspection = await this.host.shepherd.inspect(batch.target_pr);
      const pr = inspection.pr;
      if (pending.kind === 'merge' && pr.merged && pr.state === 'closed' && pr.head.sha === pending.head_sha
        && pr.node_id === batch.target_node_id && pr.base?.ref === 'main'
        && pr.base?.repo?.full_name === this.github.repo && ownUser(pr.merged_by)) {
        // The pinned 2026 REST API omits merge_commit_sha. Resolve the native
        // merge through GraphQL, bound to the same PR and frozen source head.
        const [owner, name] = this.github.repo.split('/');
        const response = await this.github.graphql(`query MergeBatchNativeReceipt($owner:String!,$name:String!,$number:Int!) {
          repository(owner:$owner,name:$name) { pullRequest(number:$number) {
            id merged headRefOid baseRefName mergeCommit { oid }
          } }
        }`, { owner, name, number: batch.target_pr }, () => this.checkpoint(batch, false));
        const native = response?.repository?.pullRequest;
        const mergedSha = native?.mergeCommit?.oid;
        if (native?.id !== batch.target_node_id || native?.merged !== true || native?.headRefOid !== pending.head_sha
          || native?.baseRefName !== 'main' || !SHA.test(mergedSha)) throw new Error('batch_merged_identity_mismatch');
        const commit = await this.github.request('GET', `/repos/${this.github.repo}/commits/${mergedSha}`);
        if (commit.sha !== mergedSha || commit.commit?.tree?.sha !== batch.tree_sha) throw new Error('batch_merged_tree_mismatch');
        this.finish(batch, { outcome: 'merged', merge_sha: mergedSha, tree_sha: batch.tree_sha },
          { state: 'publishing', merged_sha: mergedSha });
        return true;
      }
      if (pr.head.sha !== pending.head_sha || pr.state === 'closed') {
        this.finish(batch, { outcome: 'settled', reason: pr.head.sha !== pending.head_sha ? 'head_changed' : 'closed' });
        if (batch.kind === 'single' && pr.state === 'open') await this.refreshSingle(this.current(batch), inspection);
        else await this.invalidate(this.current(batch), pending.kind === 'update' && pr.state === 'closed' ? 'source_closed' : 'native_target_changed');
        return true;
      }
      return false;
    }
    throw new Error('batch_mutation_kind_unknown');
  }
  async waitSingle(batch, stage, readiness = {}, ci = null) {
    batch = this.current(batch);
    if (batch.mutation) return;
    const reason = `selection_wait:${stage}:${readiness.state ?? 'unknown'}:${readiness.reason ?? readiness.native ?? 'unspecified'}`;
    const identity = JSON.stringify([stage, readiness.state, readiness.reason, readiness.native,
      readiness.row?.id, ci?.id, ci?.run_attempt, ci?.status, ci?.conclusion]);
    const previous = batch.selection_wait;
    const since = previous?.identity === identity ? previous.since : this.now();
    const stalled = this.now() - since >= SELECTION_STALL_MS
      && this.host.nativeCi.admittedChecks(batch).length === 0
      && !batch.operations.some(({ intent, receipt }) => intent.kind === 'ci_rerun'
        && receipt.outcome === 'fresh_attempt_observed');
    // Fresh review/CI work is ordinary waiting, not a failing health signal.
    const healthy = !stalled && (!ci || ci.status !== 'completed'
      || ['review_pending', 'review_active', 'fresh_review'].includes(readiness.reason));
    this.patch(batch, { reason, selection_wait: { identity, since, healthy: Boolean(healthy) } });
    if (previous?.identity !== identity) this.host.log({ event: 'merge_batch_waiting', id: batch.id,
      generation: batch.generation, reason });
    if (stalled && batch.state === 'selected' && !batch.sealed && !batch.mutation) {
      await this.invalidate(batch, 'selection_stalled');
    }
  }
  async advanceSingle(batch) {
    const inspection = await this.host.shepherd.inspect(batch.target_pr);
    const pr = inspection.pr;
    if (pr.state !== 'open') { await this.invalidate(batch, 'source_closed'); await this.finishFallback(batch); return; }
    if (pr.head.sha !== batch.head_sha) { await this.refreshSingle(batch, inspection); return; }
    // Preserve selected-head failures before readiness or base drift can retire
    // their selection window, even when this unchanged head now needs a fold.
    const ci = await this.host.latestCi(pr.head.sha);
    if (await this.host.nativeCi.recordFailure(pr, ci, batch)) {
      await this.invalidate(batch, 'native_execution_failed');
      await this.finishFallback(batch);
      return;
    }
    if (inspection.behindBy > 0 && !botMayUpdateBranch(pr)) { await this.invalidate(batch, 'source_not_admitted'); return; }
    const prepared = await this.host.prepareReadiness(inspection);
    if (prepared.state === 'blocked') { await this.invalidate(batch, 'source_not_admitted'); return; }
    if (prepared.state !== 'prepared') { await this.waitSingle(batch, 'preparation', prepared, ci); return; }
    if (inspection.mainSha !== batch.base_sha || (batch.sealed && inspection.behindBy > 0)) {
      await this.refreshSingle(batch, inspection); return;
    }
    if (!batch.sealed) batch = this.patch(batch, { members: [this.member(inspection, prepared)], head_sha: pr.head.sha,
      base_sha: inspection.mainSha, target_node_id: pr.node_id, needs_inspection: false });
    if (inspection.behindBy > 0) {
      await this.admitNative(batch);
      const guard = async () => {
        await this.admitted(batch);
        if (this.isSealedCarrier(pr.number)) throw new Error('sealed_carrier_update_forbidden');
        const current = await this.host.shepherd.inspect(pr.number);
        const admitted = await this.host.prepareReadiness(current);
        if (current.pr.head.sha !== pr.head.sha || current.mainSha !== inspection.mainSha
          || current.behindBy !== inspection.behindBy || admitted.state !== 'prepared'
          || !mergeGate(current.pr).pass || !botMayUpdateBranch(current.pr)) throw new Error('merge_lane_changed');
        this.checkpoint(batch);
      };
      let update, intentId;
      try {
        update = await this.host.shepherd.updateBranch({ ...inspection, ready: true, beforeSend: guard,
          recordMutation: () => { intentId = this.begin(batch, 'update').mutation.id; } });
      } catch (error) {
        this.finishUnsent(batch, error, 'PUT', `/repos/${this.github.repo}/pulls/${pr.number}/update-branch`, intentId);
        throw error;
      }
      if ((/^failed:HTTP 4\d\d$/u.test(update) || update === 'failed:workflows') && this.current(batch).mutation) this.finish(batch, { outcome: 'rejected', reason: update });
      if (update?.startsWith('failed:')) {
        this.patch(batch, { reason: sanitize(update, { secrets: this.host.publisher?.secrets ?? [], limit: 1000 }) });
      }
      await this.host.shepherd.syncLabel({ pr, needsUpdate: Boolean(update?.startsWith('failed:')) });
      await this.host.publishStatus(inspection, update);
      return;
    }
    if (inspection.behindBy !== 0 || !inspection.mainSha) {
      await this.waitSingle(batch, 'base', { state: 'unknown', reason: `behind_${inspection.behindBy}` }, ci); return;
    }
    if (prepared.native === 'deferred') {
      await this.admitNative(batch);
      await this.resumeNative(batch, prepared.ci);
      await this.waitSingle(batch, 'native', prepared, prepared.ci);
      return;
    }
    const ready = await this.host.mergeReadiness(inspection);
    if (ready.state !== 'ready') { await this.waitSingle(batch, 'readiness', ready, ci); return; }
    if (!await this.fallbackFresh(batch, inspection, ready)) return;
    if (batch.reason || batch.selection_wait) batch = this.patch(batch, { reason: null, selection_wait: null });
    if (!batch.sealed) {
      const commit = await this.github.request('GET', `/repos/${this.github.repo}/commits/${pr.head.sha}`);
      if (commit.sha !== pr.head.sha || !SHA.test(commit.commit?.tree?.sha)) throw new Error('batch_tree_identity_invalid');
      const values = { ...batch, tree_sha: commit.commit.tree.sha };
      batch = this.patch(batch, { tree_sha: values.tree_sha, manifest_digest: manifestDigest(values), sealed: true, state: 'testing' });
    }
    await this.readyToMerge(batch, inspection, ready);
  }
  async fallbackFresh(batch, inspection, ready) {
    if (!batch.fallback_of) return true;
    const parent = this.store.mergeBatch(batch.fallback_of.id, batch.fallback_of.generation);
    const original = parent?.members.find((member) => member.pr === batch.target_pr);
    if (!original) throw new Error('batch_fallback_parent_missing');
    const freshCi = ready.row.head_sha !== original.head_sha || ready.ci.id !== original.ci_run_id
      || (ready.ci.run_attempt ?? 1) > original.ci_attempt;
    if (!freshCi) {
      if (!this.author) throw new Error('batch_fallback_author_unavailable');
      let intentId;
      try {
        await this.author.rerunCi(batch, ready.ci, async (phase) => {
          this.checkpoint(batch);
          if (phase === 'before_send') {
            const current = await this.host.shepherd.inspect(batch.target_pr);
            const authorization = await this.host.mergeReadiness(current);
            if (current.pr.head.sha !== batch.head_sha || current.mainSha !== batch.base_sha
              || current.behindBy !== 0 || authorization.state !== 'ready'
              || authorization.ci.id !== ready.ci.id || authorization.ci.run_attempt !== ready.ci.run_attempt) throw new Error('batch_member_authorization_changed');
            intentId = this.begin(batch, 'ci_rerun', { run_id: ready.ci.id, previous_attempt: ready.ci.run_attempt }).mutation.id;
          }
        });
      } catch (error) {
        this.finishUnsent(batch, error, 'POST', `/repos/${this.github.repo}/actions/runs/${ready.ci.id}/rerun`, intentId);
        if (rejected(error) && this.current(batch).mutation?.kind === 'ci_rerun') this.finish(batch, { outcome: 'rejected', reason: error.message });
        throw error;
      }
      await this.waitSingle(batch, 'fallback', { ...ready, state: 'waiting', reason: 'fresh_ci' }, ready.ci);
      return false;
    }
    const reviewedHead = ready.review.source_review_head ?? ready.row.head_sha;
    if (ready.row.id === original.review_id || ready.review.carried_forward_from || reviewedHead !== batch.head_sha) {
      await this.host.enqueue({ pr: batch.target_pr, head_sha: batch.head_sha, base_ref: 'main',
        due: this.now(), reason: 'batch_fallback' });
      await this.waitSingle(batch, 'fallback', { ...ready, state: 'waiting', reason: 'fresh_review' }, ready.ci);
      return false;
    }
    return true;
  }
  carrierBody(batch) {
    return [`Protected integration of ${batch.members.length} approved pinned PRs.`, '',
      ...batch.members.map((member) => `- #${member.pr}: \`${member.head_sha}\` (review ${member.review_id}, native approval ${member.github_review_id}, preparation CI ${member.ci_run_id}/${member.ci_attempt}; not final native proof)`),
      '', `Base B: \`${batch.base_sha}\``, `Head C: \`${batch.head_sha}\``, `Tree T: \`${batch.tree_sha}\``,
      `Manifest: \`${batch.manifest_digest}\``, '',
      'This carrier requires its own fresh codex-review, native approval and required CI. Original approvals/checks are not copied.',
      'The owner-approved carrier is the batch authority. Source-head changes after the final member fence are not an atomic multi-PR CAS; receipts report the pinned version actually applied.'].join('\n');
  }
  async advanceCarrier(batch) {
    if (!this.author || !this.mirror) throw new Error('batch_authoring_unavailable');
    if (!batch.sealed) {
      await this.fenceMembers(batch); await this.main(batch);
      const assembled = await this.mirror.assemble(batch);
      if (assembled.conflicts.length) {
        this.host.log({ event: 'merge_batch_conflicts', id: batch.id, conflicts: assembled.conflicts });
        const open = this.snapshots(await this.open());
        const knownConflicts = this.knownConflicts(batch.base_sha, open);
        const accepted = [];
        for (const member of batch.members) {
          if (assembled.conflicts.some((conflict) => conflict.pr === member.pr)) {
            // The rejected head conflicted with this accepted prefix. Preserve
            // the whole witness: N>2 does not prove an individual pair conflicts.
            knownConflicts.push([...accepted, member].map(({ pr, head_sha }) => ({ pr, head_sha })));
          } else accepted.push(member);
        }
        const remaining = batch.members.filter((member) => !assembled.conflicts.some((conflict) => conflict.pr === member.pr));
        const dependencies = await this.mirror.dependencies(batch, remaining, open);
        let selected = selectCarrierEligibleBatch({ ready: remaining, open, dependencies, max: this.maxSize, knownConflicts });
        if (!selected.members.length && selected.excludedCarrierOnly.size) {
          // A composition conflict need not conflict with main. If its only
          // surviving partner cannot run alone, reconsider the original members
          // without that partner instead of repeatedly selecting the same pair.
          const candidates = batch.members.filter((member) => !selected.excludedCarrierOnly.has(member.pr));
          const dependencies = await this.mirror.dependencies(batch, candidates, open);
          selected = selectCarrierEligibleBatch({ ready: candidates, open, dependencies, max: this.maxSize, knownConflicts });
        }
        if (!selected.members.length) { await this.invalidate(batch, 'conflicting_members'); return; }
        const single = selected.members.length === 1;
        this.patch(batch, { members: selected.members, kind: single ? 'single' : 'batch',
          target_pr: single ? selected.members[0].pr : null, target_node_id: single ? selected.members[0].pull_request_id : null,
          head_sha: single ? selected.members[0].head_sha : null, conflicts: assembled.conflicts });
        return;
      }
      batch = this.patch(batch, { head_sha: assembled.head_sha, tree_sha: assembled.tree_sha,
        carrier_branch: carrierBranch(batch), manifest_digest: manifestDigest(batch), sealed: true, state: 'assembling' });
      await this.closure(batch); await this.main(batch);
    }
    if (!batch.target_pr) {
      const branch = await this.author.readBranch(batch.carrier_branch);
      if (branch !== batch.head_sha) {
        if (branch !== null) throw new Error('batch_branch_identity_changed');
        try {
          await this.mirror.publish(batch, async () => { await this.fenceMembers(batch); await this.main(batch); },
            async () => this.begin(batch, 'create_ref', { marker: batch.carrier_branch }));
          if (await this.author.readBranch(batch.carrier_branch) !== batch.head_sha) throw new Error('batch_branch_publish_unconfirmed');
          this.finish(batch, { outcome: 'published', branch: batch.carrier_branch, head_sha: batch.head_sha });
        } catch (error) {
          if (error.knownRejected && this.current(batch).mutation) this.finish(batch, { outcome: 'rejected', reason: error.message });
          throw error;
        }
      } else if (!batch.operations.some((operation) => operation.intent.kind === 'create_ref' && operation.receipt.outcome === 'published')) {
        throw new Error('batch_branch_without_durable_intent');
      }
      await this.admitNative(batch);
      let intentId;
      try {
        const pr = await this.author.createCarrier(batch, this.carrierBody(batch), async (phase) => {
          this.checkpoint(batch);
          if (phase === 'before_send') {
            await this.fenceMembers(batch); await this.main(batch);
            intentId = this.begin(batch, 'create_carrier', { marker: carrierMarker(batch) }).mutation.id;
          }
        });
        this.finish(batch, { outcome: 'created', pr: pr.number, node_id: pr.node_id },
          { target_pr: pr.number, target_node_id: pr.node_id, state: 'testing' });
      } catch (error) {
        this.finishUnsent(batch, error, 'POST', `/repos/${this.github.repo}/pulls`, intentId);
        if (rejected(error) && this.current(batch).mutation) this.finish(batch, { outcome: 'rejected', reason: error.message });
        throw error;
      }
      return;
    }
    const inspection = await this.host.shepherd.inspect(batch.target_pr);
    const pr = inspection.pr;
    if (pr.state !== 'open' || pr.draft || pr.node_id !== batch.target_node_id || pr.head.sha !== batch.head_sha
      || pr.head.ref !== batch.carrier_branch || pr.base?.ref !== 'main' || pr.head?.repo?.full_name !== this.github.repo
      || inspection.mainSha !== batch.base_sha || inspection.behindBy !== 0) {
      await this.invalidate(batch, 'sealed_carrier_drift'); return;
    }
    await this.fenceMembers(batch);
    if (!mergeGate(pr).pass) return;
    const humans = effectiveHumanReviews(await this.github.paginate(`/repos/${this.github.repo}/pulls/${pr.number}/reviews`));
    if ([...humans.values()].some((review) => review.state === 'CHANGES_REQUESTED')) return;
    const ci = await this.host.latestCi(batch.head_sha);
    const nativeFailure = await this.host.nativeCi.inspectFailure(pr, ci, batch);
    if (nativeFailure) {
      await this.invalidate(batch, `composition_native_failed:run${nativeFailure.run_id}:attempt${nativeFailure.run_attempt}:job${nativeFailure.job_id}`, true);
      return;
    }
    if (await this.host.nativeCi.preparation(ci) === 'deferred') {
      await this.admitNative(batch);
      await this.resumeNative(batch, ci);
      return;
    }
    const proof = await this.readProof({ github: this.github, batch, guard: () => this.checkpoint(batch) });
    if (proof.state === 'red') {
      await this.invalidate(batch, `composition_ci_${proof.run.conclusion}:run${proof.run.id}`, true); return;
    }
    if (proof.state !== 'green') return;
    const ready = await this.host.mergeReadiness(inspection);
    if (ready.state !== 'ready') return;
    await this.readyToMerge(batch, inspection, ready, proof);
  }
  async readyToMerge(batch, inspection, ready, observedProof = null) {
    const proof = observedProof ?? await this.readProof({ github: this.github, batch, guard: () => this.checkpoint(batch) });
    if (proof.state === 'red') {
      await this.invalidate(batch, `singleton_ci_${proof.run.conclusion}:run${proof.run.id}`); await this.finishFallback(batch); return;
    }
    if (proof.state !== 'green') return;
    batch = this.patch(batch, { ci: proof.receipt, state: 'merging' });
    const guard = async (phase) => {
      this.checkpoint(batch);
      this.host.approvalCheckpoint(ready.row);
      if (phase !== 'before_send') return;
      await this.admitted(batch);
      const current = await this.host.shepherd.inspect(batch.target_pr);
      const authorization = await this.host.mergeReadiness(current);
      const changes = [
        current.pr.head.sha !== batch.head_sha && 'head_sha',
        current.pr.node_id !== batch.target_node_id && 'pull_request_id',
        current.mainSha !== batch.base_sha && 'main_sha',
        current.behindBy !== 0 && 'behind_by',
        authorization.state !== 'ready' && `authorization_${authorization.state}`,
        authorization.state === 'ready' && authorization.row.id !== ready.row.id && 'review_id',
      ].filter(Boolean);
      if (changes.length) throw Object.assign(new Error('merge_batch_changed'), { changes });
      const nativeFailure = batch.kind === 'single'
        ? await this.host.nativeCi.recordFailure(current.pr, authorization.ci, batch)
        : await this.host.nativeCi.inspectFailure(current.pr, authorization.ci, batch);
      if (nativeFailure) throw new Error(batch.kind === 'single' ? 'native_execution_failed'
        : `composition_native_failed:run${nativeFailure.run_id}:attempt${nativeFailure.run_attempt}:job${nativeFailure.job_id}`);
      await this.fenceMembers(batch);
      await this.closure(batch);
      const tested = await this.readProof({ github: this.github, batch, expected: batch.ci, guard: () => this.checkpoint(batch) });
      if (tested.state !== 'green') throw new Error('batch_ci_changed');
      const rules = await this.github.request('GET', `/repos/${this.github.repo}/rules/branches/main`);
      const strict = rules.find((rule) => rule.type === 'required_status_checks' && rule.parameters?.strict_required_status_checks_policy === true);
      if (!strict) throw new Error('merge_strict_checks_required');
      const required = strict.parameters.required_status_checks;
      if (!Array.isArray(required) || !['re-actors/alls-green', 'merge-gate', 'codex-review'].every((name) => required.some((check) => check.context === name))
        || !required.some((check) => check.context === 'codex-review' && check.integration_id === REVIEW_APP_ID)) throw new Error('merge_required_checks_changed');
      await this.main(batch);
      this.host.approvalCheckpoint(ready.row);
    };
    let merged, intentId;
    try {
      merged = await this.host.approval.merge({ ...ready.row, publication_id: ready.row.publication_id ?? ready.row.id }, guard,
        () => { intentId = this.begin(batch, 'merge', { target_pr: batch.target_pr, tree_sha: batch.tree_sha, manifest_digest: batch.manifest_digest }).mutation.id; });
    } catch (error) {
      this.finishUnsent(batch, error, 'PUT', `/repos/${this.github.repo}/pulls/${batch.target_pr}/merge`, intentId);
      const mergeEndpoint = `GitHub request failed: PUT /repos/${this.github.repo}/pulls/${batch.target_pr}/merge HTTP `;
      if (rejected(error) && error.message.startsWith(mergeEndpoint) && this.current(batch).mutation?.kind === 'merge') {
        this.finish(batch, { outcome: 'rejected', reason: error.message });
      }
      throw error;
    }
    // A failed receipt read (GraphQL is an HTTP POST) cannot reject a merge PUT
    // that already succeeded. Retain its intent for native-state reconciliation.
    if (merged && this.current(batch).mutation) await this.reconcileMutation(this.current(batch));
  }
  finishFallback(batch) {
    if (!batch.fallback_of) return;
    const parent = this.store.mergeBatch(batch.fallback_of.id, batch.fallback_of.generation);
    if (!parent || parent.state !== 'fallback') return;
    const done = [...new Set([...parent.fallback_done, batch.members[0].pr])];
    this.store.updateMergeBatch(parent.id, parent.generation, { fallback_done: done,
      state: done.length === parent.members.length ? 'fallback-completed' : 'fallback', updated_at: this.now() });
  }
  statusBatch(number) {
    const active = this.store.activeMergeBatch();
    if (active && (active.target_pr === number || active.members.some((member) => member.pr === number))) return active;
    return this.store.latestMergeBatchForPr(number);
  }
  isSealedCarrier(number) {
    return this.store.sealedCarrier(number);
  }
  statusLines(number, batch = this.statusBatch(number)) {
    if (!batch) return [];
    const member = batch.members.find((member) => member.pr === number);
    const phase = batch.member_proofs?.[number]?.outcome ?? batch.state;
    const lines = [`**Merge ${batch.kind === 'batch' ? 'batch' : 'lane'} ${batch.id}/${batch.generation}: ${phase}.** ${batch.target_pr && batch.kind === 'batch' ? `Carrier #${batch.target_pr}.` : ''}`];
    if (member) lines.push(`Pinned source head: \`${member.head_sha ?? 'awaiting reinspection'}\`. Source approvals are not carrier-head approvals.`);
    if (batch.base_sha) lines.push(`B \`${batch.base_sha}\`; C \`${batch.head_sha ?? 'assembling'}\`; T \`${batch.tree_sha ?? 'assembling'}\`.`);
    if (batch.ci) lines.push(`CI [run ${batch.ci.run_id}/${batch.ci.attempt}](https://github.com/${this.github.repo}/actions/runs/${batch.ci.run_id}); image ${batch.ci.image_digest ? `\`${batch.ci.image_digest}\`` : 'not present in artifact'}.`);
    if (batch.merged_sha) lines.push(`Confirmed carrier/target merge: \`${batch.merged_sha}\`.`);
    if (batch.member_proofs?.[number]) lines.push(`Native source result: **${batch.member_proofs[number].outcome}**; observed head \`${batch.member_proofs[number].observed_head}\`.`);
    if (batch.reason) lines.push(`Progress: ${sanitize(batch.reason, { secrets: this.host.publisher?.secrets ?? [], limit: 1000 })}`);
    if (batch.state === 'fallback') lines.push('The composition failed, not necessarily this PR. Serial isolation requires fresh current-main CI/review; no prefix uses the combined proof.');
    if (batch.fallback_of) lines.push(`Serial isolation of failed batch ${batch.fallback_of.id}/${batch.fallback_of.generation}; fresh current-base CI and review are required.`);
    return lines;
  }
  statusJournal(number, batch = this.statusBatch(number)) {
    if (!batch || (!this.active(batch) && batch.state !== 'publishing')) return null;
    return { marker: `<!-- fleet-review-bot-batch-status:${batch.id}:${batch.generation}:${number} -->`,
      pending: () => this.current(batch).mutation,
      guard: async () => {
        if (this.host.mode !== 'approve' || (!this.active(batch) && this.current(batch).state !== 'publishing')) throw new Error('batch_publication_changed');
      },
      begin: (details) => this.begin(batch, 'comment', { ...details, comment_pr: number,
        marker: `<!-- fleet-review-bot-batch-status:${batch.id}:${batch.generation}:${number} -->` }),
      finish: (receipt) => this.finish(batch, receipt) };
  }
  async publish(batch, number) {
    const inspection = await this.host.shepherd.inspect(number);
    return this.host.publishStatus(inspection, undefined, batch);
  }
  async publishCompleted(batch) {
    const proof = batch.deploy_proof ?? await this.confirmTree({ github: this.github, batch, mergedSha: batch.merged_sha,
      guard: () => { if (!this.active(batch) && this.current(batch).state !== 'publishing') throw new Error('batch_publication_changed'); } });
    if (!proof) return;
    if (!batch.deploy_proof) batch = this.patch(batch, { deploy_proof: proof });
    // Main is conclusively merged with its exact deploy proof. Slow per-source
    // visibility/publication remains journaled, but is no longer a main writer.
    if (this.active(batch)) {
      this.invalidateCandidates({ all: true });
      invalidateInformational(this.github, { all: true });
      batch = this.store.retireMergeBatch(batch.id, batch.generation, 'publishing', this.now());
    }
    for (const member of batch.members) {
      if (batch.member_results[member.pr]) continue;
      const native = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${member.pr}`);
      if (native.node_id !== member.pull_request_id || native.head?.repo?.full_name !== this.github.repo
        || native.base?.repo?.full_name !== this.github.repo) throw new Error('batch_source_receipt_identity_changed');
      const ancestry = await this.mirror.ancestry(batch, [{ pr: member.pr, head_sha: member.head_sha }], batch.merged_sha);
      if (!ancestry.combinedAncestors.has(member.pr)) throw new Error('batch_member_not_in_merged_tree');
      let outcome;
      if (native.base.ref !== 'main') outcome = 'pinned_applied_source_retargeted';
      else if (native.head.sha !== member.head_sha) outcome = 'pinned_applied_source_advanced';
      else if (native.state === 'closed' && native.merged) outcome = batch.kind === 'batch' ? 'merged_via_batch' : 'merged_direct';
      else if (native.state === 'closed') outcome = 'pinned_applied_source_closed';
      else continue; // Indirect native status is eventually consistent; never fabricate it.
      const memberProof = { outcome, pinned_head: member.head_sha, observed_head: native.head.sha,
        merge_sha: batch.merged_sha, tree_sha: batch.tree_sha, native_merged: native.merged === true };
      batch = this.patch(batch, { member_proofs: { ...batch.member_proofs, [member.pr]: memberProof } });
      const publication = await this.publish(batch, member.pr);
      if (!publication || publication.pending || this.current(batch).mutation) {
        const attempts = batch.publication_wait?.pr === member.pr ? batch.publication_wait.attempts + 1 : 1;
        this.patch(batch, { publication_wait: { pr: member.pr, attempts },
          ...(attempts >= 3 ? { reason: `publication_pending:pr_${member.pr}:attempts_${attempts}` } : {}) });
        return;
      }
      batch = this.patch(batch, { member_results: { ...batch.member_results, [member.pr]: { ...memberProof, ...publication } },
        publication_wait: null, reason: null });
    }
    if (batch.members.every((member) => batch.member_results[member.pr])) {
      this.store.transaction(() => {
        this.patch(batch, { state: 'merged', reason: null });
        this.finishFallback(batch);
      });
      await this.mirror.discard(this.current(batch));
      this.host.log({ event: 'merge_batch_merged', id: batch.id, generation: batch.generation,
        members: batch.members.map((member) => member.pr), merge_sha: batch.merged_sha, tree_sha: batch.tree_sha });
      this.host.reconcileSoon(0);
    }
  }
  failures() {
    const active = this.store.activeMergeBatch();
    return [...new Map([...(active ? [active] : []), ...this.store.pendingBatchPublications()]
      .filter((batch) => (batch.reason !== null && !(batch.reason?.startsWith('selection_wait:') && batch.selection_wait?.healthy)) || batch.needs_inspection
        || (batch.mutation && !this.#liveMutations.has(batch.mutation.id)))
      .map((batch) => [`${batch.id}/${batch.generation}`, batch])).values()]
      .map((batch) => ({ id: batch.id, generation: batch.generation, state: batch.state,
        mutation: batch.mutation?.kind ?? null, reason: batch.reason, target_pr: batch.target_pr }));
  }
  async advance(open) {
    if (!this.host.shepherd || !this.host.approval || this.host.mode !== 'approve') return;
    let batch = this.store.activeMergeBatch();
    try {
      for (const publication of this.store.pendingBatchPublications()) {
        if (!this.active(publication)) {
          try {
            await withGitHubPriority('merge', async () => {
              if (publication.mutation && !await this.reconcileMutation(publication)) return;
              await this.publishCompleted(this.current(publication));
            });
          } catch (error) {
            if (error.code === 'github_budget_deferred') {
              this.deferBudget(error);
              continue;
            }
            const cause = sanitize(error.message, { secrets: this.host.publisher?.secrets ?? [], limit: 1000 });
            this.patch(publication, { reason: cause });
            this.host.log({ event: 'merge_batch_publication_failed', id: publication.id, generation: publication.generation, cause });
          }
        }
      }
      if (batch?.mutation) {
        if (!await withGitHubPriority('merge', () => this.reconcileMutation(batch))) return;
        batch = this.store.activeMergeBatch();
      }
      if (!batch) batch = await withGitHubPriority('merge', () => this.select(open));
      if (!batch) return;
      return await withGitHubPriority('merge', async () => {
        if (batch.state === 'publishing') { await this.publishCompleted(batch); return; }
        if (batch.state === 'closing') { await this.invalidate(batch, batch.closing_reason, batch.closing_fallback); return; }
        if (batch.kind === 'single') await this.advanceSingle(batch);
        else await this.advanceCarrier(batch);
        let current = this.store.activeMergeBatch();
        if (current && !current.mutation && current.state !== 'publishing') {
          if (current.reason && !current.reason.startsWith('selection_wait:')) current = this.patch(current, { reason: null, selection_wait: null });
          for (const member of current.members) {
            await this.publish(current, member.pr);
            if (this.current(current).mutation) break;
          }
        }
      });
    } catch (error) {
      if (error.code === 'github_budget_deferred') {
        this.deferBudget(error);
        return;
      }
      const active = this.store.activeMergeBatch();
      const reason = sanitize(error.message, { secrets: this.host.publisher?.secrets ?? [], limit: 1000 });
      const owner = active ?? (batch && this.current(batch)?.state === 'publishing' ? this.current(batch) : null);
      if (owner) this.patch(owner, { reason });
      // Never discard an uncertain mutation. A pre-send state change has no intent,
      // so retire its stale selection and let the next tick select fresh authority.
      const compositionFailure = /^composition_native_failed:run\d+:attempt\d+:job\d+$/u.test(error.message);
      if (active && !active.mutation && (compositionFailure || /^(?:merge_batch_changed|batch_main_changed|batch_ancestry_changed|batch_member_authorization_changed|batch_member_approval_changed|batch_member_review_changed|publication_cancelled|native_execution_failed)$/u.test(error.message))) {
        await withGitHubPriority('merge', () => this.invalidate(active, reason, compositionFailure, error.rejectedApproval));
        if (error.message === 'native_execution_failed') await this.finishFallback(active);
      }
      if (error.message === 'merge_batch_changed') this.host.reconcileSoon(0);
      this.host.log({ event: 'merge_batch_failed', id: active?.id ?? batch?.id ?? null, cause: reason,
        ...(error.changes ? { changes: error.changes } : {}) });
      throw error;
    }
  }
}
