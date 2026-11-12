import { randomBytes } from 'node:crypto';
import { readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePullRequests, routeEvent } from './webhook.mjs';
import { RUN_ID } from './runner.mjs';
import { builderUser, effectiveHumanReviews } from './approval.mjs';
import { botMayUpdateBranch, COMMENT_REREVIEWS_PER_HEAD, HUMAN_APPROVERS, renovatePr, statusBody } from './shepherd.mjs';
import { mergeGate } from './merge-gate.mjs';
import { sanitize } from './evidence.mjs';
import { BatchLane } from './batch-lane.mjs';
import { mergePriority } from './batch-plan.mjs';
import { NativeCi } from './native-ci.mjs';
import { findCommitWorkflowRuns } from '../scripts/ci-tested-tree.mjs';
import { withReconcileMetrics, withRequestPhase, withoutRequestMetrics } from './request-metrics.mjs';
import { invalidateInformational } from './informational-cache.mjs';
import { prepareInOrder } from './read-preparation.mjs';
import { withGitHubPriority } from './github-budget.mjs';
import { matchesReviewRoute } from './transcript.mjs';

const UPGRADE_REREVIEWS_PER_HOUR = 6;
// A comment this long before a review started was visible when the review read the PR (clock-skew margin).
const COMMENT_COVERAGE_MARGIN_MS = 30000;
// Only these review reasons may carry evidence forward instead of running a fresh reviewer.
const CARRY_REASONS = ['synchronize', 'reconcile'];

class PriorityDiscoveryUnavailable extends Error {
  constructor(cause) {
    super(cause?.message ?? 'priority_discovery_unavailable', { cause });
    this.name = 'PriorityDiscoveryUnavailable';
    if (cause?.retryAt !== undefined) this.retryAt = cause.retryAt;
    if (cause?.github !== undefined) this.github = cause.github;
    if (cause?.code !== undefined) this.code = cause.code;
  }
}

class SchedulerTickFailure extends Error {
  constructor(stage, cause) {
    super(cause?.message ?? 'scheduler_tick_failed', { cause });
    this.stage = stage;
  }
}

// Diagnostics are structural, not redacted payloads: even a message, error name,
// code or object key can contain a credential or an upstream response body.
function safeErrorCause(error, depth = 0) {
  const constructor = [Error, TypeError, SyntaxError, RangeError, ReferenceError, URIError, EvalError]
    .find((type) => error?.constructor === type)?.name
    ?? (error instanceof PriorityDiscoveryUnavailable ? 'PriorityDiscoveryUnavailable' : 'Error');
  const result = { constructor };
  if (['github_budget_deferred', 'github_rate_limited', 'github_timeout',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'SQLITE_BUSY', 'SQLITE_CORRUPT'].includes(error?.code)) result.code = error.code;
  if (depth < 3 && error?.cause) result.cause = safeErrorCause(error.cause, depth + 1);
  return result;
}

export class Scheduler {
  constructor({ store, github, publisher, mirror, verdict, approval, admission, fetchImpl = fetch, runnerUrl = 'http://runner:8081', mode = 'advisory',
    concurrency = 2, retentionDays = 180, workRoot = '/work', sessionsRoot = '/sessions', now = Date.now, log = () => {},
    shepherd = null, revision = null, batchAuthor = null, batchMirror = null, batchMaxSize = 5,
    batchCollectSeconds = 180, batchEnabled = false, mergeLaneEnabled = true, batchReadProof, batchConfirmTree, readMergeDrain = async () => null, reconcileIntervalMs = 60000 }) {
    if (typeof mergeLaneEnabled !== 'boolean') throw new Error('Invalid mergeLaneEnabled');
    if (!Number.isInteger(reconcileIntervalMs) || reconcileIntervalMs < 60000 || reconcileIntervalMs > 300000) throw new Error('Invalid reconcile interval (60000–300000 ms)');
    Object.assign(this, { store, github, publisher, mirror, verdict, approval, admission, fetch: fetchImpl, runnerUrl, mode, concurrency,
      retentionDays, workRoot, sessionsRoot, now, log, revision, readMergeDrain, reconcileIntervalMs, mergeLaneEnabled });
    this.shepherd = mergeLaneEnabled ? shepherd : null;
    this.lastReconcileAt = 0;
    this.lastReconcileOkAt = null;
    this.startedAt = this.now();
    this.lastPruneAt = 0;
    this.pruneFailures = 0;
    this.busy = false;
    this.lastTickCompletedAt = this.now();
    this.operations = Promise.resolve();
    this.pendingCancels = new Map();
    this.pendingEnqueues = new Set();
    this.starting = new Map();
    this.preparing = new Map();
    this.polling = new Map();
    this.startStatus = new Map();
    this.refilling = null;
    this.refillDiscovery = null;
    this.releasedRuns = new Set();
    this.ciDisplay = new Map();
    this.sweepSeen = new Map();
    this.presentationPreparations = 0;
    this.disarmSweep = null;
    this.reconcileSoonAt = null;
    this.laneCandidates = [];
    this.laneCursor = 0;
    this.lastLaneReconcileAt = 0;
    this.statusDue = new Set();
    this.mergeDrain = Object.freeze({ requested: false, request_id: null, acknowledged: false, observed_at: null, error: null });
    this.nativeCi = mergeLaneEnabled ? new NativeCi(this) : null;
    this.batchLane = mergeLaneEnabled ? new BatchLane({ host: this, author: batchAuthor, mirror: batchMirror,
      maxSize: batchMaxSize, collectSeconds: batchCollectSeconds, batchEnabled, readProof: batchReadProof, confirmTree: batchConfirmTree,
      selectionPaused: () => this.#refreshMergeDrain() }) : null;
  }
  frozenCarrier(pr, headSha) {
    if (this.mergeLaneEnabled) return false;
    if (pr != null) return this.store.sealedCarrier(pr);
    if (!headSha) return false;
    const known = this.store.all('SELECT DISTINCT pr FROM reviews WHERE head_sha=?', headSha);
    return known.length > 0 && known.every((row) => this.store.sealedCarrier(row.pr));
  }
  recordPollFailure(row, error, event = 'review_poll_failed') {
    const clean = (value, limit) => sanitize(value, { secrets: this.publisher?.secrets ?? [], limit });
    const cause = { name: clean(error?.name ?? 'Error', 100), message: clean(error?.message ?? error, 1000) };
    if (error?.code !== undefined) cause.code = clean(error.code, 100);
    if (error?.github) cause.github = {
      status: error.github.status,
      headers: Object.fromEntries(Object.entries(error.github.headers ?? {}).map(([key, value]) => [key, value === null ? null : clean(value, 128)])),
      message: error.github.message === null ? null : clean(error.github.message, 512),
    };
    if (Number.isSafeInteger(error?.retryAt)) cause.retryAt = error.retryAt;
    const current = this.store.review(row.id);
    let review = null;
    if (['running', 'publishing'].includes(current?.status) && current.result_json) {
      // Diagnose the fresh receipt, never overwrite an accepted remote POST with
      // the stale row from the start of this polling attempt.
      try { review = JSON.parse(current.result_json); }
      catch { /* An invalid result is itself the logged failure; preserve its retry behavior. */ }
    }
    let failure = null;
    if (review?.result && Array.isArray(review.findings)) {
      const previous = review.publication_failure;
      failure = { first_failed_at: previous?.first_failed_at ?? this.now(), last_failed_at: this.now(),
        attempts: (previous?.attempts ?? 0) + 1, cause };
    }
    this.log({ event, review: row.id, pr: row.pr, head_sha: row.head_sha, cause,
      ...(failure ? { first_failed_at: failure.first_failed_at, last_failed_at: failure.last_failed_at, attempts: failure.attempts } : {}) });
    if (failure) {
      review.publication_failure = failure;
      this.store.update(row.id, { result_json: JSON.stringify(review) });
    }
  }
  publicationFailures() {
    return this.store.all("SELECT id,pr,head_sha,result_json FROM reviews WHERE status IN ('running','publishing') AND result_json IS NOT NULL")
      .flatMap((row) => {
        if (this.frozenCarrier(row.pr)) return [];
        const failure = JSON.parse(row.result_json).publication_failure;
        return failure ? [{ review: row.id, pr: row.pr, head_sha: row.head_sha, attempts: failure.attempts,
          first_failed_at: failure.first_failed_at, last_failed_at: failure.last_failed_at }] : [];
      });
  }
  runner(method, id) { return this.fetch(`${this.runnerUrl}/runs/${id}`, { method, signal: AbortSignal.timeout(10000) }); }
  recordTickFailure(error) {
    const staged = error instanceof SchedulerTickFailure;
    const cause = staged ? error.cause : error;
    this.log({ event: 'scheduler_tick_failed', stage: cause instanceof PriorityDiscoveryUnavailable
      ? 'refill_discovery' : staged ? error.stage : 'tick', cause: safeErrorCause(cause) });
  }
  reconcileSoon(delayMs) { this.reconcileSoonAt = Math.min(this.reconcileSoonAt ?? Infinity, this.now() + delayMs); }
  reviewGitHubPriority(row) {
    if (!this.mergeLaneEnabled) return 'review';
    const batch = this.store.activeMergeBatch();
    return batch?.kind === 'batch' && batch.sealed && batch.target_pr === row.pr
      && batch.head_sha === row.head_sha ? 'merge' : 'review';
  }
  async #refreshMergeDrain(acknowledge = false) {
    const previous = this.mergeDrain;
    // Revoke the old ACK before yielding: a new request or failed read cannot reuse it.
    this.mergeDrain = Object.freeze({ ...this.mergeDrain, acknowledged: false });
    let request;
    try { request = await this.readMergeDrain(); }
    catch { request = { request_id: null, error: 'unavailable' }; }
    const status = { requested: request !== null, request_id: request?.request_id ?? null,
      acknowledged: false, observed_at: this.now(), error: request?.error ?? null };
    if (acknowledge && status.request_id && !status.error) {
      try {
        // Review-only ACK proves this process owns no lane authority, not that
        // old workers stopped or that frozen native intents have been settled.
        status.acknowledged = !this.mergeLaneEnabled || (!this.store.activeMergeBatch()
          && this.store.pendingBatchPublications().length === 0
          && !this.store.get('SELECT 1 AS armed FROM approvals WHERE armed=1 LIMIT 1'));
      } catch { status.error = 'unavailable'; }
    }
    if (status.requested !== previous.requested || status.request_id !== previous.request_id || status.error !== previous.error) {
      this.reconcileSoon(0);
    }
    this.mergeDrain = Object.freeze(status);
    return status.requested;
  }
  async releaseRun(row) {
    if (this.frozenCarrier(row.pr)) return;
    if (!row.run_id || this.releasedRuns.has(row.run_id)) return;
    try {
      const response = await this.runner('DELETE', row.run_id);
      if (!response.ok && response.status !== 404) throw new Error('Runner unavailable');
      this.releasedRuns.add(row.run_id);
    } catch { this.log({ event: 'runner_release_unavailable', review: row.id }); }
  }
  serialize(callback) {
    const work = this.operations.then(callback);
    this.operations = work.catch(() => {});
    return work;
  }
  dirtySweep({ pr, headSha, all = false }) {
    for (const [number, seen] of this.sweepSeen) {
      if (all || (pr === number && (!headSha || seen.headSha === headSha))
        || (headSha && seen.headSha === headSha)) {
        this.sweepSeen.set(number, { headSha: seen.headSha, dirty: true });
      }
    }
  }
  dirtyDelivery(event, payload) {
    if (payload.repository?.full_name !== this.github.repo || this.unchangedReviewStatus(event, payload)) return;
    const headSha = payload.workflow_run?.head_sha ?? payload.check_run?.head_sha ?? payload.check_suite?.head_sha
      ?? payload.pull_request?.head?.sha ?? (event === 'status' ? payload.sha : undefined);
    const pr = payload.pull_request?.number ?? payload.issue?.number ?? (payload.pull_request ? payload.number : undefined);
    if (event === 'push' && payload.ref === 'refs/heads/main') this.dirtySweep({ all: true });
    else if (['pull_request', 'pull_request_review', 'check_run', 'check_suite', 'status'].includes(event)
      || (event === 'workflow_run' && payload.workflow_run?.name === 'CI')) this.dirtySweep({ pr, headSha });
  }
  deliveryOperations(event, payload, options) {
    return routeEvent(event, payload, options).map(operation => operation.type === 'mergeChanged'
      ? { ...operation, pr: payload.pull_request?.number ?? payload.number } : operation);
  }
  noteCancellation(operation) {
    if (this.frozenCarrier(operation.pr, operation.head_sha)) return null;
    const all = operation.type === 'mainMoved' || (operation.type === 'mergeChanged' && operation.pr === undefined);
    this.dirtySweep({ pr: operation.pr, headSha: operation.head_sha,
      all: operation.type === 'mainMoved' || (operation.type === 'mergeChanged' && operation.pr === undefined) });
    invalidateInformational(this.github, { pr: operation.pr, headSha: operation.head_sha, all });
    this.batchLane?.invalidateCandidates({ pr: operation.pr, headSha: operation.head_sha, all });
    if (all) this.ciDisplay.clear();
    if (operation.head_sha) this.ciDisplay.delete(operation.head_sha);
    if (['enqueue', 'reuseVerdict', 'commentRereview'].includes(operation.type)) this.pendingEnqueues.add(operation);
    if (operation.pr === undefined) return null;
    const row = this.store.active(operation.pr) ?? this.store.latest(operation.pr);
    if (!row || !(operation.type === 'cancel' || operation.type === 'markDraft'
      || (operation.type === 'enqueue' && (operation.head_sha !== row.head_sha || operation.reason === 'rerequested')))) return null;
    this.pendingCancels.set(row.id, operation.type === 'enqueue' ? 'superseded' : operation.type === 'markDraft' ? 'draft' : operation.reason);
    return row.id;
  }
  handle(operation) {
    const cancelled = this.noteCancellation(operation);
    return this.serialize(() => this.apply(operation)).finally(() => {
      if (cancelled !== null) this.pendingCancels.delete(cancelled);
      this.pendingEnqueues.delete(operation);
    });
  }
  unchangedReviewStatus(event, payload) {
    const check = payload.check_run;
    if (event !== 'check_run' || payload.action !== 'completed' || check?.name !== 'codex-review'
      || check.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(check.conclusion)
      || !Number.isSafeInteger(check.id) || check.id <= 0 || !Number.isSafeInteger(check.app?.id)
      || check.app.id !== Number(this.github.appId) || !/^[0-9a-f]{40}$/u.test(check.head_sha ?? '')) return false;
    const row = this.store.get('SELECT * FROM reviews WHERE check_run_id=? AND head_sha=? ORDER BY id DESC LIMIT 1',
      check.id, check.head_sha);
    if (!row || row.status !== 'completed' || row.conclusion !== check.conclusion
      || this.store.latest(row.pr)?.id !== row.id) return false;
    // This is an exact echo of an existing local publication, not a blanket
    // own-App exemption. Changed admission facts or expired hints still revoke.
    try { return this.batchLane?.unchangedReviewStatus(row) ?? false; }
    catch { return false; }
  }
  processDelivery(id) {
    const delivery = this.store.get('SELECT * FROM deliveries WHERE id=?', id);
    const marked = [];
    const pending = [];
    if (delivery?.state === 'received' && delivery.payload_json) {
      const payload = JSON.parse(delivery.payload_json);
      this.dirtyDelivery(delivery.event, payload);
      const head = payload.workflow_run?.head_sha ?? payload.check_run?.head_sha ?? payload.check_suite?.head_sha
        ?? payload.pull_request?.head?.sha ?? (delivery.event === 'status' ? payload.sha : undefined);
      const pr = payload.pull_request?.number ?? payload.issue?.number ?? (payload.pull_request ? payload.number : undefined);
      const all = delivery.event === 'push' && payload.ref === 'refs/heads/main';
      if (!this.unchangedReviewStatus(delivery.event, payload)) {
        if (head) this.ciDisplay.delete(head);
        if (all) this.ciDisplay.clear();
        invalidateInformational(this.github, { headSha: head, pr, all });
        this.batchLane?.invalidateCandidates({ headSha: head, pr, all });
      }
      for (const operation of this.deliveryOperations(delivery.event, payload, {
        appId: this.github?.appId, now: this.now(),
      })) {
        if (['enqueue', 'reuseVerdict', 'commentRereview'].includes(operation.type)) pending.push(operation);
        const cancelled = this.noteCancellation(operation);
        if (cancelled !== null) marked.push(cancelled);
      }
    }
    return this.serialize(() => this.processDeliveryNow(id)).catch((error) => {
      // Failed deliveries remain durable; ticks retry them independently of the sweep.
      // Reconcile immediately as well, so an undecided comment request disarms old authority.
      this.reconcileSoon(0);
      throw error;
    }).finally(() => {
      for (const row of marked) this.pendingCancels.delete(row);
      for (const operation of pending) this.pendingEnqueues.delete(operation);
    });
  }
  async processDeliveryNow(id) {
    const delivery = this.store.get('SELECT * FROM deliveries WHERE id=?', id);
    if (!delivery || delivery.state === 'processed') return;
    const rerequest = this.store.get('SELECT * FROM rerequests WHERE delivery_id=?', id);
    if (delivery.attempts >= 3 && !rerequest) throw new Error('Delivery retries exhausted');
    this.store.run('UPDATE deliveries SET attempts=attempts+1,updated_at=? WHERE id=?', this.now(), id);
    if (rerequest) {
      if (this.mode !== 'off') await withRequestPhase('deliveries', rerequest.pr, () => this.queueRerequest(rerequest, 'rerequested'));
      this.store.processedDelivery(id, this.now());
      return;
    }
    const payload = JSON.parse(delivery.payload_json);
    if (!payload || typeof payload !== 'object') throw new Error('Delivery payload unavailable');
    this.dirtyDelivery(delivery.event, payload);
    const pr = payload.pull_request;
    const completed = pr ? Boolean(this.store.latest(pr.number ?? payload.number, pr.head?.sha)) : false;
    if (this.mode !== 'off') for (const operation of this.deliveryOperations(delivery.event, payload, {
      appId: this.github.appId, now: this.now(), completed,
    })) await withRequestPhase('deliveries', operation.pr ?? null, () => this.apply(operation));
    this.store.processedDelivery(id, this.now());
  }
  async retryReceivedNow() {
    if (this.mode === 'off') return;
    for (const delivery of this.store.all("SELECT id FROM deliveries WHERE state='received' AND attempts<3 AND received_at<=? AND updated_at<=? AND NOT EXISTS (SELECT 1 FROM rerequests WHERE delivery_id=deliveries.id)",
      this.now() - 15000, this.now() - 15000)) {
      try { await this.processDeliveryNow(delivery.id); } catch (error) {
        if (this.reconcileCounts) this.reconcileCounts.failed++;
        const clean = (value, limit) => sanitize(value, { secrets: this.publisher?.secrets ?? [], limit });
        this.log({ event: 'delivery_retry_failed', id: delivery.id,
          cause: { name: clean(error?.name ?? 'Error', 100), message: clean(error?.message ?? error, 1000) } });
      }
    }
  }
  async apply(operation) {
    if (this.frozenCarrier(operation.pr, operation.head_sha)) return;
    if (operation.type !== 'ignore') this.dirtySweep({ pr: operation.pr, headSha: operation.head_sha });
    if (operation.pr !== undefined || operation.head_sha) {
      invalidateInformational(this.github, { pr: operation.pr, headSha: operation.head_sha });
      this.batchLane?.invalidateCandidates({ pr: operation.pr, headSha: operation.head_sha });
    }
    if (this.mode === 'off') return;
    if (['mainMoved', 'mergeChanged'].includes(operation.type)) {
      this.dirtySweep({ pr: operation.pr, all: operation.type === 'mainMoved' || operation.pr === undefined });
      if (operation.pr === undefined) this.ciDisplay.clear();
      invalidateInformational(this.github, { pr: operation.pr, all: operation.pr === undefined });
      this.batchLane?.invalidateCandidates({ pr: operation.pr, all: operation.pr === undefined });
      this.reconcileSoon(0);
      return;
    }
    if (operation.type === 'ignore') { this.log({ event: operation.reason }); return; }
    if (!this.mergeLaneEnabled && operation.type === 'ciCompleted') return;
    if (operation.type === 'commentRereview') return this.commentRereview(operation);
    if (operation.pr === undefined && ['enqueue', 'ciCompleted'].includes(operation.type)) {
      for (const pr of await resolvePullRequests(this.github, operation)) {
        if (pr.head.repo?.full_name !== this.github.repo) continue;
        if (pr.base?.ref !== 'main') { await this.cancel(pr.number, 'target_changed'); continue; }
        await this.apply({ ...operation, pr: pr.number, base_ref: pr.base.ref });
      }
      return;
    }
    if (operation.type === 'enqueue') return this.enqueue(operation);
    if (operation.type === 'cancel') return this.cancel(operation.pr, operation.reason);
    if (operation.type === 'markDraft') {
      await this.cancel(operation.pr, 'draft');
      try {
        return await this.publisher.draft(operation.pr, operation.head_sha, async () => {
          const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${operation.pr}`);
          if (pr.base?.ref !== 'main' || pr.state !== 'open' || !pr.draft || pr.head.sha !== operation.head_sha) throw new Error('publication_cancelled');
        });
      } catch (error) { if (error.message !== 'publication_cancelled') throw error; }
    }
    // CI completion wakes the single merge lane; it never starts another review.
    if (operation.type === 'ciCompleted') {
      const batch = this.store.activeMergeBatch();
      const row = batch ? null : this.store.latest(operation.pr, operation.head_sha);
      const approved = row?.status === 'completed' && row.head_sha === operation.head_sha
        && this.store.approvalForReview(row.id)?.outcome === 'approved';
      const selected = batch?.target_pr === operation.pr && batch.head_sha === operation.head_sha;
      if (this.mode === 'approve' && (selected || approved)) {
        try {
          const unresolved = await this.reconcileArmed();
          if (unresolved.size === 0) {
            const open = batch ? [] : await this.github.paginate(`/repos/${this.github.repo}/pulls?state=open&per_page=100`);
            await this.advanceMergeLane(open);
          } else this.reconcileSoon(0);
        } catch { this.reconcileSoon(0); }
      } else this.reconcileSoon(0);
      return;
    }
    if (operation.type === 'reuseVerdict') return this.enqueue({ ...operation, due: this.now(), reason: 'reuse_verdict' });
  }
  disarm(pr) {
    if (!this.mergeLaneEnabled || !this.approval) return;
    if (!this.disarmSweep) return this.approval.disable(pr);
    if (!this.disarmSweep.has(pr)) this.disarmSweep.set(pr, this.approval.disable(pr));
    return this.disarmSweep.get(pr);
  }
  pendingRestart(pr, head) {
    return this.store.get(`SELECT * FROM reviews AS pending WHERE pr=? AND head_sha=?
      AND status='failed' AND reason='restart_terminal_pending'
      AND NOT EXISTS (SELECT 1 FROM reviews AS newer WHERE newer.pr=pending.pr AND newer.id>pending.id)
      ORDER BY id DESC LIMIT 1`, pr, head);
  }
  async enqueue(operation) {
    if (this.frozenCarrier(operation.pr, operation.head_sha)) return null;
    if (operation.base_ref === undefined) {
      const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${operation.pr}`);
      operation = { ...operation, base_ref: pr.base?.ref };
    }
    if (operation.base_ref !== 'main') { await this.cancel(operation.pr, 'target_changed'); return null; }
    const pendingAutomaticRetry = () => ['reconcile', 'upgrade_rereview', 'reuse_verdict', 'synchronize', 'ambiguous_rereview'].includes(operation.reason)
      && this.pendingRestart(operation.pr, operation.head_sha);
    if (pendingAutomaticRetry()) return null;
    const active = this.store.active(operation.pr);
    if (active && active.base_ref === 'main' && active.head_sha === operation.head_sha
      && operation.reason !== 'rerequested' && operation.reason !== 'rerequest_recovered'
      && !(operation.reason === 'comment_rereview' && ['running', 'publishing'].includes(active.status))) {
      if (active.status === 'queued') this.store.update(active.id, { due_at: operation.due });
      return active;
    }
    if (active) await this.cancel(operation.pr, 'superseded');
    else await this.disarm(operation.pr);
    if (pendingAutomaticRetry()) return null;
    const row = this.store.enqueue(operation, this.now());
    try { return await this.publisher.queued(row, async () => {
      if (!await this.executionFence(row)) throw new Error('publication_cancelled');
    }); }
    catch (error) {
      if (error.message === 'publication_cancelled') return this.store.review(row.id);
      throw error;
    }
  }
  async commentRereview(operation) {
    if (this.frozenCarrier(operation.pr, operation.head_sha)) return;
    const done = (outcome) => { this.log({ event: 'comment_rereview', pr: operation.pr, trigger: operation.trigger, outcome }); };
    const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${operation.pr}`);
    if (pr.state !== 'open' || pr.draft || pr.base?.ref !== 'main' || pr.head?.repo?.full_name !== this.github.repo) {
      return done('ineligible');
    }
    const commenter = operation.commenter ?? {};
    const builderAnswer = operation.trigger === 'builder_answer';
    // A builder answer counts only from the builder App on its own PR; the review bot and other bots never qualify.
    const authorized = builderAnswer ? builderUser(commenter) && builderUser(pr.user)
      : (commenter.id !== undefined && commenter.id === pr.user?.id)
        || HUMAN_APPROVERS.some((user) => user.id === commenter.id && user.login === commenter.login)
        || builderUser(commenter);
    if (!authorized) return done('unauthorized');
    if (operation.trigger === 'finding_reply' && !this.store.findingByComment(pr.number, operation.in_reply_to_id)) {
      return done('not_a_finding');
    }
    if (builderAnswer) {
      const open = new Set(this.store.findings(pr.number, true).map((finding) => finding.id));
      if (!operation.findings?.some((id) => open.has(id))) return done('not_a_finding');
    }
    const head = pr.head.sha;
    let active = this.store.active(pr.number);
    if (active?.head_sha === head && !this.commentSeen(operation, active)) active = this.#holdCommentStart(active);
    if (active?.head_sha === head && active.status === 'queued') {
      // A review that has not started yet reads the reply; a later reply pushes the debounce.
      // The reply needs a fresh reviewer, so the queued review may no longer carry evidence forward.
      this.store.update(active.id, { due_at: operation.due,
        ...(CARRY_REASONS.includes(active.reason) ? { reason: 'comment_rereview' } : {}) });
      if (this.shepherd) this.statusDue.add(pr.number);
      return done('absorbed');
    }
    if (active?.head_sha === head && ['running', 'publishing'].includes(active.status) && this.commentSeen(operation, active)) return done('covered');
    if (!active && this.commentSeen(operation, this.store.latest(pr.number, head))) return done('covered');
    if (this.store.commentRereviews(pr.number, head) >= COMMENT_REREVIEWS_PER_HEAD) {
      if (this.shepherd) this.statusDue.add(pr.number);
      return done('limited');
    }
    await this.enqueue({ pr: pr.number, head_sha: head, base_ref: 'main', due: operation.due, reason: 'comment_rereview' });
    if (this.shepherd) this.statusDue.add(pr.number);
    return done('queued');
  }
  // A review covers a comment only when a fresh reviewer started after the comment existed.
  commentSeen(operation, row) {
    if (!Number.isFinite(operation.created_at) || row?.started_at == null
      || operation.created_at >= row.started_at - COMMENT_COVERAGE_MARGIN_MS) return false;
    if (row.result_json) return !JSON.parse(row.result_json).carried_forward_from;
    return !CARRY_REASONS.includes(row.reason);
  }
  // A comment request is decided only when its delivery is processed; until then it fences
  // execution and approval that did not see the comment, across retries and restarts.
  pendingCommentRereview(row) {
    const review = this.store.review(row.review_id ?? row.id);
    return this.store.all(`SELECT event,payload_json FROM deliveries WHERE state='received'
      AND event IN ('issue_comment','pull_request_review_comment') AND payload_json IS NOT NULL`)
      .some((delivery) => routeEvent(delivery.event, JSON.parse(delivery.payload_json))
        .some((operation) => operation.type === 'commentRereview' && operation.pr === row.pr
          && !this.commentSeen(operation, review)));
  }
  async cancel(pr, reason) {
    if (this.frozenCarrier(pr)) return;
    const row = this.store.active(pr);
    if (row) this.store.update(row.id, { status: 'cancelled', reason, conclusion: 'cancelled', finished_at: this.now(),
      result_json: JSON.stringify({ ...JSON.parse(row.result_json ?? '{}'), cancellation_terminal_pending: { retry_at: 0 } }) });
    try {
      if (!row) { await this.resumeCancellationTerminals(pr); return; }
      if (['running', 'publishing'].includes(row.status) && row.run_id) {
        try { await this.runner('DELETE', row.run_id); } catch { this.log({ event: 'runner_cancel_unavailable', review: row.id }); }
        this.releasedRuns.delete(row.run_id);
      }
      await this.finishCancellationTerminal(this.store.review(row.id));
    } finally { await this.disarm(pr); }
  }
  async finishCancellationTerminal(row) {
    if (this.frozenCarrier(row.pr)) return;
    const result = JSON.parse(row.result_json ?? '{}');
    const intent = result.cancellation_terminal_pending;
    if (row.status !== 'cancelled' || !intent) return;
    // A shared deadline belongs to this durable obligation too: the next
    // process has a fresh GitHubApp and cannot recover an in-memory window.
    if (this.now() < this.github?.retryAt && this.github.retryAt > intent.retry_at) {
      intent.retry_at = this.github.retryAt;
      this.store.update(row.id, { result_json: JSON.stringify(result) });
    }
    if (this.now() < intent.retry_at) return;
    // Neither an accepted queued POST nor an in-flight in-progress PATCH may
    // land after the terminal write. Re-read only this review's canonical ID.
    await this.startStatus.get(row.id)?.catch(() => {});
    await this.publisher.queuedPending?.get(row.id)?.catch(() => {});
    row = this.store.review(row.id);
    let check;
    let failure;
    try {
      if (!row.check_run_id && this.publisher.findCheck) check = await this.publisher.findCheck(row);
    } catch (error) { failure = error; }
    // Store failures are not GitHub deferrals, even when they carry similar metadata.
    if (check) row = this.store.update(row.id, { check_run_id: check.id });
    if (!failure) {
      try { await this.publisher.terminal(row, 'cancelled', row.reason); }
      catch (error) { failure = error; }
    }
    if (failure) {
      if (!(['github_rate_limited', 'github_budget_deferred'].includes(failure.code) && Number.isSafeInteger(failure.retryAt))
        && failure.message !== 'github_timeout' && !(failure.github?.status >= 500 && failure.github.status <= 599)) throw failure;
      const result = JSON.parse(this.store.review(row.id).result_json);
      result.cancellation_terminal_pending.retry_at = Math.max(this.now() + 1000,
        Number.isSafeInteger(failure.retryAt) ? failure.retryAt : this.now() + 60000);
      this.store.update(row.id, { result_json: JSON.stringify(result) });
      this.log({ event: 'cancellation_terminal_deferred', review: row.id });
      return;
    }
    const completed = JSON.parse(this.store.review(row.id).result_json);
    delete completed.cancellation_terminal_pending;
    this.store.update(row.id, { result_json: Object.keys(completed).length ? JSON.stringify(completed) : null });
  }
  async resumeCancellationTerminals(pr) {
    for (const row of this.store.all(`SELECT * FROM reviews WHERE status='cancelled'
      AND json_extract(result_json,'$.cancellation_terminal_pending') IS NOT NULL
      ${pr === undefined ? '' : 'AND pr=?'} ORDER BY id`, ...(pr === undefined ? [] : [pr]))) {
      await this.finishCancellationTerminal(row);
    }
  }
  async recover({ waitForPublications = true } = {}) {
    await this.resumeCancellationTerminals();
    if (this.mode === 'off') { await this.reconcileArmed(); return; }
    const rows = this.store.all("SELECT * FROM reviews WHERE status IN ('running','publishing')");
    // Priority discovery is retryable execution work, not a prerequisite for
    // durable recovery or installing HTTP intake and the ordinary execution timer.
    let starts = [];
    try { starts = await this.refill(); }
    catch (error) {
      if (!(error instanceof PriorityDiscoveryUnavailable)) throw error;
      this.log({ event: 'recovery_refill_failed' });
    }
    const resumes = [];
    for (const row of rows) {
      if (this.frozenCarrier(row.pr)) continue;
      if (row.result_json || row.execution_exit_json) {
        resumes.push(this.poll(row).catch((error) => {
          if (error.message !== 'publication_cancelled') this.recordPollFailure(row, error, 'publication_resume_failed');
        }));
        continue;
      }
      if (row.status === 'publishing') {
        await this.fail(row, 'review_evidence_failed');
        continue;
      }
      this.store.update(row.id, { status: 'failed', reason: 'restart_terminal_pending', conclusion: 'neutral', finished_at: this.now() });
      if (row.run_id) { try { await this.runner('DELETE', row.run_id); } catch { /* Runner may also have restarted. */ } }
    }
    await this.resumeRestartTerminals();
    if (waitForPublications) {
      await this.reconcileRerequests();
      await this.retryReceivedNow();
      await Promise.all([...resumes, ...starts]);
    } else {
      // Startup installs HTTP intake and the execution timer after initialization,
      // not after a resumed verdict or publisher finally finishes.
      Promise.all([...resumes, ...starts]).catch(error => this.log({ event: 'recovery_failed',
        cause: sanitize(error.message, { secrets: this.publisher?.secrets ?? [], limit: 1000 }) }));
      this.serialize(async () => {
        await this.reconcileRerequests();
        await this.retryReceivedNow();
      }).catch(error => this.log({ event: 'recovery_maintenance_failed',
        cause: sanitize(error.message, { secrets: this.publisher?.secrets ?? [], limit: 1000 }) }));
    }
  }
  async resumeRestartTerminals() {
    for (const row of this.store.all("SELECT * FROM reviews WHERE status='failed' AND reason='restart_terminal_pending' ORDER BY id")) {
      if (this.frozenCarrier(row.pr)) continue;
      try {
        await this.publisher.terminal(row, 'neutral', 'restart');
        const replaced = () => this.store.get('SELECT id FROM reviews WHERE pr=? AND id>? LIMIT 1', row.pr, row.id);
        const retryAllowed = () => this.mode !== 'off' && this.admission?.state?.mode !== 'off';
        if (row.attempt < 2 && retryAllowed() && !replaced()) {
          await this.disarm(row.pr);
          // The replacement and completion marker commit together. A crash after
          // the remote PATCH can repeat it, but cannot consume another attempt.
          this.store.transaction(() => {
            if (retryAllowed() && !replaced()) this.store.enqueue({ pr: row.pr, head_sha: row.head_sha, base_ref: row.base_ref,
              due: this.now(), reason: 'restart', attempt: row.attempt + 1,
              ambiguousRereviews: row.ambiguous_rereviews, allowDraft: Boolean(row.allow_draft) }, this.now());
            this.store.update(row.id, { reason: 'restart' });
          });
        } else this.store.update(row.id, { reason: 'restart' });
      } catch (error) {
        if (!(['github_rate_limited', 'github_budget_deferred'].includes(error.code) && Number.isSafeInteger(error.retryAt))
          && error.message !== 'github_timeout' && !(error.github?.status >= 500 && error.github.status <= 599)) throw error;
        this.log({ event: 'restart_terminal_deferred', review: row.id });
      }
    }
  }
  queuedDue(row) {
    if (this.frozenCarrier(row.pr)) return false;
    const current = this.store.review(row.id);
    return current?.status === 'queued' && current.due_at <= this.now()
      && !this.pendingCancels.has(row.id) && !this.pendingCommentRereview(current)
      && this.mode !== 'off' && this.admission?.state?.mode !== 'off';
  }
  #holdCommentStart(row) {
    const lease = this.preparing.get(row.id);
    const current = this.store.review(row.id);
    if (!lease || lease.revoked || current?.status !== 'running' || current.run_id !== lease.run_id
      || current.pr !== row.pr || current.head_sha !== row.head_sha || current.result_json || current.execution_exit_json) return current;
    // Revoke only this still-local preparation. Never await its promise here:
    // it can itself be waiting for serialized publication behind this delivery.
    const queued = this.store.update(row.id, { status: 'queued', run_id: null, started_at: null });
    lease.revoked = true;
    return queued;
  }
  start(row) {
    return withGitHubPriority(this.reviewGitHubPriority(row), () => withoutRequestMetrics(() => this.#startNow(row)));
  }
  async #startNow(row) {
    if (this.frozenCarrier(row.pr)) return;
    const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${row.pr}`);
    if (!this.queuedDue(row)) return;
    row = this.store.review(row.id);
    if (row.base_ref !== 'main' || pr.base?.ref !== 'main'
      || pr.state !== 'open' || pr.head.sha !== row.head_sha || (pr.draft && !row.allow_draft)
      || pr.head.repo?.full_name !== this.github.repo) {
      return this.serialize(() => {
        if (this.store.active(row.pr)?.id === row.id) {
          return this.cancel(row.pr, pr.state !== 'open' ? 'closed' : pr.draft ? 'draft' : 'superseded');
        }
      });
    }
    if (!row.check_run_id) {
      try {
        row = await this.publisher.queued(row, async () => {
          if (!await this.executionFence(row)) throw new Error('publication_cancelled');
        });
      } catch (error) {
        if (error.message !== 'publication_cancelled' || !this.pendingCommentRereview(row)) throw error;
        return;
      }
    }
    // Cancellation owns the durable terminal write after the queued lease;
    // a stale start must neither bypass its backoff nor stamp another status.
    if (this.store.review(row.id).status !== 'queued') return;
    if (!this.queuedDue(row)) return;
    row = this.store.review(row.id);
    const run_id = `${row.id}-${row.head_sha.slice(0, 12)}-${randomBytes(4).toString('hex')}`;
    row = this.store.update(row.id, { status: 'running', run_id, started_at: this.now(), bot_revision: this.revision });
    const preparation = { run_id, revoked: false };
    this.preparing.set(row.id, preparation);
    let runnerRequested = false;
    let statusSettled = false;
    try {
      const status = this.publisher.started(row, async () => {
        if (preparation.revoked || !await this.executionFence(row) || preparation.revoked) throw new Error('publication_cancelled');
      });
      this.startStatus.set(row.id, status);
      try { await status; }
      finally { this.startStatus.delete(row.id); }
      statusSettled = true;
      if (preparation.revoked || this.pendingCommentRereview(row)) return;
      const previous = this.store.latest(row.pr);
      const canCarry = CARRY_REASONS.includes(row.reason) && previous && previous.head_sha !== row.head_sha
        && !this.store.get('SELECT id FROM rerequests WHERE head_sha=? AND satisfied_by_review_id IS NULL AND moot_at IS NULL', row.head_sha)
        && (this.revision === null || previous.bot_revision === this.revision);
      const carried = canCarry ? await this.mirror.carry(row, previous) : null;
      if (carried) {
        if (preparation.revoked || !await this.executionFence(row) || preparation.revoked || this.pendingCommentRereview(row)) return;
        row = this.store.update(row.id, { base_sha: carried.base_sha });
        await this.attachCi(row, carried);
        if (preparation.revoked || !await this.executionFence(row) || preparation.revoked || this.pendingCommentRereview(row)) return;
        if (this.preparing.get(row.id) === preparation) this.preparing.delete(row.id);
        this.store.publicationIntent(row, carried);
        this.refill().catch((error) => this.recordPollFailure(row, error, 'review_refill_failed'));
        await this.serialize(() => this.publishNow(this.store.review(row.id), carried));
        return;
      }
      if (preparation.revoked || this.pendingCommentRereview(row)) return;
      const findings = this.store.findings(row.pr, true);
      // Evidence answers the open findings; show every comment since the review that last judged them started.
      const judged = findings.map((finding) => this.store.review(finding.last_review_id)?.started_at).filter(Number.isFinite);
      const commentsSince = judged.length ? Math.min(...judged) : previous?.finished_at ?? null;
      const metadata = await this.mirror.prepare(row, pr, findings, previous, commentsSince);
      if (preparation.revoked || this.store.review(row.id).status !== 'running' || this.store.review(row.id).run_id !== run_id) return;
      this.store.update(row.id, { base_sha: metadata.base_sha });
      if (preparation.revoked || !await this.executionFence(row) || preparation.revoked || this.pendingCommentRereview(row)) return;
      if (this.preparing.get(row.id) === preparation) this.preparing.delete(row.id);
      runnerRequested = true;
      const response = await this.runner('POST', run_id);
      if (response.status !== 202) throw new Error('runner_start_failed');
      if (this.store.review(row.id).status !== 'running') await this.runner('DELETE', run_id);
    } catch (error) {
      if (preparation.revoked) return;
      if (!runnerRequested && error.message === 'publication_cancelled' && this.pendingCommentRereview(row)) return;
      if (!statusSettled) throw error;
      const publishing = this.store.review(row.id)?.status === 'publishing';
      if (error.retryAt && !publishing) { this.deferStart(row, error); return; }
      if (error.message !== 'publication_cancelled' && publishing) this.recordPollFailure(row, error, 'publication_start_failed');
      const reason = error.code === 'mirror_timeout' || error.message === 'mirror_timeout' || error.cause?.message === 'mirror_timeout' ? 'mirror_timeout'
        : error.message === 'github_timeout' ? 'github_timeout'
        : error.code === 'workspace_too_large' ? 'workspace_too_large'
        : error.message === 'policy_unavailable' ? 'policy_unavailable'
        : error.message === 'verdict_unavailable' ? 'verdict_unavailable' : 'workspace_export_failed';
      if (!publishing || ['github_timeout', 'mirror_timeout'].includes(reason)) await this.serialize(() => this.fail(row, reason));
    } finally {
      if (!runnerRequested && this.pendingCommentRereview(row)) this.#holdCommentStart(row);
      if (this.preparing.get(row.id) === preparation) this.preparing.delete(row.id);
    }
  }
  deferStart(row, error) {
    if (this.frozenCarrier(row.pr)) return;
    const current = this.store.review(row.id);
    if (current && ['queued', 'running'].includes(current.status) && !this.pendingCancels.has(row.id)
      && !current.result_json && !current.execution_exit_json) {
      // All GitHub work precedes the local runner POST. A rate window must not
      // consume an attempt or strand a model that was never started.
      this.store.update(row.id, { status: 'queued', due_at: Math.max(current.due_at, error.retryAt),
        run_id: null, started_at: null });
    }
    this.recordPollFailure(row, error, 'review_start_deferred');
  }
  async fail(row, reason, retry = false) {
    if (this.frozenCarrier(row.pr)) return;
    const current = this.store.review(row.id);
    if (!['queued', 'running', 'publishing'].includes(current.status)) return;
    if (this.pendingCancels.has(row.id)) return this.cancel(row.pr, this.pendingCancels.get(row.id));
    if ((current.result_json || current.execution_exit_json) && ['github_timeout', 'mirror_timeout'].includes(reason)) {
      // An unavailable publisher does not erase its durable identity or rerun the reviewer.
      this.store.update(row.id, { reason, conclusion: 'neutral' });
      try { await this.publisher.terminal(row, 'neutral', reason); }
      catch { this.log({ event: 'publication_timeout_check_unavailable', review: row.id }); }
      return;
    }
    this.store.update(row.id, { status: 'failed', reason, conclusion: 'neutral', finished_at: this.now() });
    await this.publisher.terminal(row, 'neutral', reason);
    if (retry && row.attempt < 2) await this.enqueue({ pr: row.pr, head_sha: row.head_sha, due: this.now(),
      reason, attempt: row.attempt + 1, ambiguousRereviews: row.ambiguous_rereviews, allowDraft: Boolean(row.allow_draft) });
  }
  poll(row) {
    if (this.frozenCarrier(row.pr)) return Promise.resolve();
    if (this.polling.has(row.id)) return this.polling.get(row.id);
    const work = withGitHubPriority(this.reviewGitHubPriority(row), () => withoutRequestMetrics(() =>
      this.pollNow(this.store.review(row.id)).finally(() => this.polling.delete(row.id))));
    this.polling.set(row.id, work);
    return work;
  }
  async checkpoint(row) {
    if (!await this.publicationFence(row)) throw new Error('publication_cancelled');
  }
  async executionFence(row) {
    if (this.frozenCarrier(row.pr)) return false;
    const eligible = () => this.mode !== 'off' && this.admission?.state?.mode !== 'off'
      && ['queued', 'running', 'publishing'].includes(this.store.review(row.id)?.status)
      && !this.pendingCancels.has(row.id) && !this.pendingCommentRereview(row);
    if (!eligible()) return false;
    const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${row.pr}`);
    if (!eligible()) return false;
    if (row.base_ref === 'main' && this.store.review(row.id)?.base_ref === 'main' && pr.base?.ref === 'main'
      && pr.state === 'open' && pr.head.sha === row.head_sha && (!pr.draft || row.allow_draft)
      && pr.head.repo?.full_name === this.github.repo) return true;
    const reason = pr.state !== 'open' ? 'closed' : 'superseded';
    this.pendingCancels.set(row.id, reason);
    this.serialize(() => {
      if (this.store.active(row.pr)?.id === row.id) return this.cancel(row.pr, reason);
    }).catch((error) => this.recordPollFailure(row, error))
      .finally(() => { if (this.pendingCancels.get(row.id) === reason) this.pendingCancels.delete(row.id); });
    return false;
  }
  async publicationFence(row) {
    if (this.frozenCarrier(row.pr)) return false;
    if (this.mode === 'off' || this.admission?.state?.mode === 'off'
      || !['queued', 'running', 'publishing'].includes(this.store.review(row.id).status)) return false;
    if (this.pendingCancels.has(row.id)) {
      await this.cancel(row.pr, this.pendingCancels.get(row.id));
      return false;
    }
    const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${row.pr}`);
    if (this.mode === 'off' || this.admission?.state?.mode === 'off'
      || !['queued', 'running', 'publishing'].includes(this.store.review(row.id).status)) return false;
    if (this.pendingCancels.has(row.id)) {
      await this.cancel(row.pr, this.pendingCancels.get(row.id));
      return false;
    }
    if (row.base_ref !== 'main' || pr.base?.ref !== 'main'
      || this.store.review(row.id).base_ref !== 'main'
      || pr.state !== 'open' || pr.head.sha !== row.head_sha || (pr.draft && !row.allow_draft)) {
      await this.cancel(row.pr, pr.state !== 'open' ? 'closed' : 'superseded');
      return false;
    }
    return true;
  }
  async pollNow(row) {
    if (row && this.frozenCarrier(row.pr)) return;
    if (!row || !['running', 'publishing'].includes(row.status) || this.starting.has(row.id)) return;
    if (row.status === 'publishing' && this.now() < this.github?.retryAt) return;
    if (row.result_json) {
      const review = JSON.parse(row.result_json);
      if (review.result && Array.isArray(review.findings)) {
        if (!await this.executionFence(row)) return;
        this.store.publicationIntent(row, review);
        this.refill().catch((error) => this.recordPollFailure(row, error, 'review_refill_failed'));
        await this.releaseRun(row);
        return this.serialize(() => this.publishNow(this.store.review(row.id), review));
      }
    }
    let exit = row.execution_exit_json ? JSON.parse(row.execution_exit_json) : null;
    if (!exit) {
      const response = await this.runner('GET', row.run_id);
      if (response.status === 404) return this.serialize(() => this.fail(row, 'runner_lost', true));
      if (!response.ok) throw new Error('Runner unavailable');
      exit = await response.json();
      if (exit.state !== 'exited') return;
      if (this.store.review(row.id)?.status !== 'running') return;
      row = this.store.executionExited(row, exit);
      // Free capacity before evidence, GitHub, verdict, or publication can block.
      this.refill().catch((error) => this.recordPollFailure(row, error, 'review_refill_failed'));
    }
    if (this.now() < this.github?.retryAt) return;
    let review;
    try { review = await this.mirror.result(row, exit); }
    catch (error) {
      if (['github_timeout', 'mirror_timeout'].includes(error.message) || error.retryAt) throw error;
      return this.serialize(() => this.fail(row, 'review_evidence_failed'));
    }
    // Read-only fences during evidence preparation; all authority mutations below
    // remain on the publication/maintenance queue.
    if (this.store.review(row.id)?.status !== 'publishing' || this.pendingCancels.has(row.id) || this.mode === 'off') return;
    await this.attachCi(row, review);
    if (!await this.executionFence(row)) return;
    if (review.result.pass && !review.findingsAssigned
      && review.findings.some((finding) => finding.status !== 'new' && !review.priorFindingIds.includes(finding.id))) {
      return this.serialize(() => this.fail(row, 'finding_identity_invalid'));
    }
    if (!await this.executionFence(row)) return;
    this.store.publicationIntent(row, review);
    // Full intent is durable independently of the serialized publisher backlog.
    await this.releaseRun(row);
    return this.serialize(() => this.publishNow(this.store.review(row.id), review));
  }
  async ciRuns(headSha, { requireComplete = false, informational = false, pr } = {}) {
    const options = informational ? { informational: true, headSha, pr } : {};
    const runs = await findCommitWorkflowRuns({ sha: headSha, repository: this.github.repo,
      workflowPath: '.github/workflows/ci.yml', event: 'pull_request', requireComplete,
      get: (path) => this.github.request('GET', `/repos/${this.github.repo}/${path}`, undefined, undefined, options),
      list: (path, key) => this.github.paginate(`/repos/${this.github.repo}/${path}`, key, undefined, options) });
    return runs.filter((run) => run.name === 'CI' && run.head_sha === headSha).sort((a, b) => b.id - a.id);
  }
  async displayCi(headSha) {
    const cached = this.ciDisplay.get(headSha);
    if (cached && (cached.pending || cached.expiresAt > this.now())) return cached.pending ?? cached.runs;
    const entry = { pending: this.ciRuns(headSha, { informational: true }), expiresAt: 0 };
    this.ciDisplay.set(headSha, entry);
    while (this.ciDisplay.size > 64) this.ciDisplay.delete(this.ciDisplay.keys().next().value);
    try {
      const runs = await entry.pending;
      entry.runs = runs;
      entry.pending = null;
      entry.expiresAt = this.now() + (runs.length && runs.every((run) => run.status === 'completed') ? 300000 : 30000);
      return runs;
    } catch (error) {
      if (this.ciDisplay.get(headSha) === entry) this.ciDisplay.delete(headSha);
      throw error;
    }
  }
  async latestCi(headSha, { display = false, informational = false, pr } = {}) {
    // Presentation/discovery may opt in; authority defaults remain unconditional.
    return (await (display ? this.displayCi(headSha) : this.ciRuns(headSha, { informational, pr }))).map((run) => ({ id: run.id, run_attempt: run.run_attempt ?? 1,
      status: run.status, conclusion: run.conclusion, html_url: run.html_url,
      completed_at: Date.parse(run.completed_at ?? run.updated_at) || 0 }))[0] ?? null;
  }
  async attachCi(row, review) {
    review.ci = await withGitHubPriority(this.reviewGitHubPriority(row), () => this.latestCi(row.head_sha, { display: true }));
  }
  hasPendingEnqueue(row) {
    for (const operation of this.pendingEnqueues) {
      if (operation.head_sha === row.head_sha || operation.pr === row.pr) return true;
    }
    if (this.pendingCommentRereview(row)) return true;
    const watermark = row.rerequest_watermark
      ?? this.store.review(row.review_id ?? row.id)?.rerequest_watermark ?? 0;
    return Boolean(this.store.get(`SELECT id FROM rerequests WHERE head_sha=? AND id>?
      AND satisfied_by_review_id IS NULL AND moot_at IS NULL`, row.head_sha, watermark));
  }
  async queueRerequest(request, reason = 'rerequest_recovered') {
    if (this.frozenCarrier(request.pr, request.head_sha)) return false;
    if (request.satisfied_by_review_id !== null || request.moot_at !== null || request.parked) return false;
    this.store.run('UPDATE rerequests SET attempts=attempts+1,next_attempt_at=? WHERE id=?',
      this.now() + Math.min(600000, 60000 * 2 ** Math.min(request.attempts, 4)), request.id);
    let number = request.pr;
    if (number === null) {
      const linked = await this.github.paginate(`/repos/${this.github.repo}/commits/${request.head_sha}/pulls`);
      const matching = linked.filter((pr) => pr.state === 'open' && pr.head.sha === request.head_sha
        && pr.head.repo?.full_name === this.github.repo && pr.base?.ref === 'main');
      if (matching.length !== 1) {
        if (linked.length && linked.every((pr) => pr.base?.ref !== 'main' || pr.state !== 'open' || pr.head.sha !== request.head_sha)) {
          this.store.run('UPDATE rerequests SET moot_at=? WHERE id=?', this.now(), request.id);
        }
        return false;
      }
      number = matching[0].number;
    }
    if (this.frozenCarrier(number)) return false;
    const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${number}`);
    if (pr.base?.ref !== 'main' || pr.state !== 'open' || pr.head.sha !== request.head_sha || pr.head.repo?.full_name !== this.github.repo) {
      this.store.run('UPDATE rerequests SET moot_at=? WHERE id=?', this.now(), request.id);
      return false;
    }
    request = this.store.bindRerequest(request.id, number);
    if (request.satisfied_by_review_id !== null || request.parked) return false;
    const active = this.store.active(number);
    if (active?.head_sha === request.head_sha && active.rerequest_watermark >= request.id) return false;
    await this.enqueue({ pr: number, head_sha: request.head_sha, base_ref: pr.base.ref, due: this.now(), reason, allowDraft: true });
    this.store.processedDelivery(request.delivery_id, this.now());
    if (this.reconcileCounts) this.reconcileCounts.recovered++;
    this.log({ event: 'rerequest_queued', pr: number, rerequest: request.id });
    return true;
  }
  async reconcileRerequests() {
    for (const request of this.store.all(`SELECT * FROM rerequests WHERE satisfied_by_review_id IS NULL
      AND moot_at IS NULL AND parked=0 AND next_attempt_at<=? ORDER BY id`, this.now())) {
      try { await withRequestPhase('rerequests', request.pr, () => this.queueRerequest(request)); }
      catch {
        if (this.reconcileCounts) this.reconcileCounts.failed++;
        this.log({ event: 'rerequest_retry_failed', pr: request.pr, rerequest: request.id });
      }
    }
  }
  reviewRouteMatches(review) {
    return matchesReviewRoute(review, this.mirror?.reviewModel, this.mirror?.reviewThinking);
  }
  approvalCheckpoint(row) {
    if (this.frozenCarrier(row.pr)) throw new Error('publication_cancelled');
    const persisted = this.store.review(row.id);
    if (!persisted?.result_json || !this.reviewRouteMatches(JSON.parse(persisted.result_json))) throw new Error('publication_cancelled');
    if (row.base_ref !== 'main' || this.store.review(row.id)?.base_ref !== 'main'
      || this.mode !== 'approve' || this.pendingCancels.has(row.id) || this.hasPendingEnqueue(row)
      || this.store.review(row.id)?.status !== 'completed' || this.store.active(row.pr)
      || this.store.latest(row.pr)?.id !== row.id) throw new Error('publication_cancelled');
  }
  async approveCompleted(row, review) {
    if (this.mode !== 'approve' || review.verdict?.decision !== 'approve') return;
    if (this.frozenCarrier(row.pr)) return;
    if (!this.reviewRouteMatches(review)) {
      if (this.store.review(row.id)?.status === 'completed' && this.store.latest(row.pr)?.id === row.id
        && !this.store.active(row.pr)) {
        await this.enqueue({ pr: row.pr, head_sha: row.head_sha, base_ref: row.base_ref, due: this.now(), reason: 'reconcile' });
      }
      return;
    }
    if (this.shepherd && this.revision !== null && row.bot_revision !== this.revision
      && !['approved', 'merged_direct'].includes(this.store.approvalForReview(row.id)?.outcome)) return;
    if (review.publication_id !== row.id) throw new Error('Invalid approval publication identity');
    row = { ...row, publication_id: review.publication_id };
    this.approvalCheckpoint(row);
    const alreadyApproved = ['approved', 'merged_direct'].includes(this.store.approvalForReview(row.id)?.outcome);
    const receipt = await this.approval.run(row, review, async () => this.approvalCheckpoint(row));
    if (!receipt) return;
    review.approval = { ...receipt, branch_update: this.mergeLaneEnabled
      ? this.store.failedUpdate(row.pr, row.head_sha)?.outcome ?? null : null };
    this.store.update(row.id, { result_json: JSON.stringify(review) });
    // A completed review/approval is lane work, not a request to wait behind
    // informational status updates and an unrelated full-repository sweep.
    if (this.mergeLaneEnabled && !alreadyApproved && receipt.outcome === 'approved' && this.shepherd) {
      try {
        const unresolved = await this.reconcileArmed();
        if (unresolved.size === 0) {
          const open = this.store.activeMergeBatch() ? []
            : await withGitHubPriority('review', () => this.github.paginate(`/repos/${this.github.repo}/pulls?state=open`));
          await this.advanceMergeLane(open);
        }
      } catch (error) {
        // The lane owns its durable failure/uncertain-write journal. Do not
        // misclassify a merge failure as a failed review publication.
        this.log({ event: 'merge_lane_reconcile_failed',
          cause: sanitize(error.message, { secrets: this.publisher?.secrets ?? [], limit: 1000 }) });
        this.reconcileSoon(error.code === 'github_budget_deferred' ? Math.max(1000, error.retryAt - this.now()) : 0);
      }
    }
    await this.publisher.updateEvidence(row, review);
    return receipt;
  }
  publishNow(row, review) {
    if (this.frozenCarrier(row.pr)) return Promise.resolve();
    return withGitHubPriority(this.reviewGitHubPriority(row), () => this.#publishNow(row, review));
  }
  async #publishNow(row, review) {
    await this.checkpoint(row);
    if (!row.check_run_id) row = await this.publisher.queued(row, () => this.checkpoint(row));
    await this.checkpoint(row);
    if (review.result.pass) {
      if (review.carried_forward_from && !review.carry.verdict_rescored) {
        review.verdict = await this.verdict.carry(review);
        review.carry.verdict_rescored = true;
      } else if (!review.verdict) review.verdict = await this.verdict.evaluate(review);
      if (review.verdict?.reason === 'verdict_unavailable') review.result.reasons = ['verdict_unavailable'];
      review.waitingForHuman = review.verdict?.decision === 'ambiguous' && !review.verdict.reason && row.ambiguous_rereviews >= 1;
    }
    await this.checkpoint(row);
    this.store.update(row.id, { verdict_json: JSON.stringify(review.verdict ?? null), result_json: JSON.stringify(review) });
    const conclusion = await this.publisher.completed(row, review, review.diff, () => this.checkpoint(row));
    await this.checkpoint(row);
    if (this.pendingCancels.has(row.id)) {
      await this.cancel(row.pr, this.pendingCancels.get(row.id));
      return;
    }
    review.publication_state = 'completed';
    delete review.diff;
    delete review.publication_failure;
    if (['running', 'publishing'].includes(this.store.review(row.id).status)) {
      this.store.update(row.id, { status: 'completed', conclusion, result_json: JSON.stringify(review), finished_at: this.now() });
      this.dirtySweep({ pr: row.pr, headSha: row.head_sha });
      this.releasedRuns.delete(row.run_id);
      await this.approveCompleted(this.store.review(row.id), review);
      this.reconcileSoon(0);
      if (review.verdict?.decision === 'ambiguous' && !review.verdict.reason && row.ambiguous_rereviews < 1) {
        await this.enqueue({ pr: row.pr, head_sha: row.head_sha, due: this.now(), reason: 'ambiguous_rereview',
          attempt: 1, ambiguousRereviews: row.ambiguous_rereviews + 1, allowDraft: Boolean(row.allow_draft) });
      }
      if (this.shepherd) this.statusDue.add(row.pr);
    }
  }
  async reconcileArmed() {
    const unresolved = new Set();
    if (!this.mergeLaneEnabled || !this.approval) return unresolved;
    // Clean cutover: no open PR keeps a legacy bot-owned auto-merge request.
    // Human requests remain human-owned; strict main checks still govern them.
    for (const { pr: number } of this.store.all('SELECT DISTINCT pr FROM approvals WHERE armed=1')) {
      try { await withRequestPhase('disarm', number, () => this.disarm(number)); }
      catch {
        unresolved.add(number);
        if (this.reconcileCounts) this.reconcileCounts.failed++;
        this.log({ event: 'approval_disarm_retry_pending', pr: number });
      }
    }
    return unresolved;
  }
  async reconcile() {
    if (this.mode === 'off') return;
    return withReconcileMetrics(this.log, async () => {
      this.disarmSweep = new Map();
      this.reconcileCounts = { skipped: 0, failed: 0, recovered: 0, deferred: 0 };
      this.reconcileSoonAt = null;
      try { await this.reconcileNow(); }
      catch (error) {
        if (!this.deferBudget(error, null, 'sweep')) {
          this.reconcileCounts.failed++;
          this.log({ event: 'reconcile_sweep_failed' });
        }
      } finally {
        this.lastReconcileAt = this.now();
        this.lastLaneReconcileAt = this.now();
        this.lastReconcileCounts = this.reconcileCounts;
        this.log({ event: 'reconcile_completed', ...this.reconcileCounts });
        this.reconcileCounts = null;
        this.disarmSweep = null;
      }
    });
  }
  async reconcileNow() {
    await withRequestPhase('rerequests', null, () => this.reconcileRerequests());
    const unresolved = await withRequestPhase('disarm', null, () => this.reconcileArmed());
    await withRequestPhase('deliveries', null, () => this.retryReceivedNow());
    // Durable lane progress must not wait behind an unrelated informational scan.
    const hadActiveLane = this.mergeLaneEnabled && Boolean(this.store.activeMergeBatch() || this.store.pendingBatchPublications().length);
    if (hadActiveLane && unresolved.size === 0) await withRequestPhase('lane', null, () => this.advanceMergeLane([]));
    const open = await withRequestPhase('openPRs', null, () => withGitHubPriority(
      this.shepherd && this.approval && this.mode === 'approve' ? 'merge' : 'review',
      () => this.github.paginate(`/repos/${this.github.repo}/pulls?state=open`)));
    const openNumbers = new Set(open.map((pr) => pr.number));
    for (const number of this.sweepSeen.keys()) if (!openNumbers.has(number)) this.sweepSeen.delete(number);
    this.lastReconcileOkAt = this.now();
    const candidates = [];
    for (const pr of open) {
      try {
        if (this.frozenCarrier(pr.number)) continue;
        if (unresolved.has(pr.number)) continue;
        if (pr.head.repo?.full_name !== this.github.repo || pr.base?.ref !== 'main' || pr.draft) continue;
        const active = this.store.active(pr.number);
        if (active?.base_ref === 'main' && active.head_sha === pr.head.sha && !this.pendingCancels.has(active.id)) continue;
        // Ignore updated_at: our status comments change it without changing PR semantics.
        const key = JSON.stringify([pr.head.sha, pr.base.sha, pr.base.ref, pr.head.repo?.full_name,
          pr.draft, pr.title, pr.body, pr.user?.id, pr.auto_merge, this.mode, this.revision,
          (pr.labels ?? []).map((label) => typeof label === 'string' ? label : label.name).sort()]);
        let seen = this.sweepSeen.get(pr.number);
        // Thirty-minute missed-event safety net; this hint is never write authority.
        if (!seen?.dirty && seen?.key === key && seen.identity === this.presentationIdentity(pr)
          && this.now() - seen.at < 1800000) continue;
        if (!seen) {
          seen = { headSha: pr.head.sha, dirty: true };
          this.sweepSeen.set(pr.number, seen);
        }
        candidates.push({ pr, key, seen });
      } catch (error) {
        this.reconcileCounts.failed++;
        this.log({ event: 'reconcile_pr_failed', pr: pr.number, step: 'candidate',
          cause: sanitize(error.message, { secrets: this.publisher?.secrets ?? [], limit: 1000 }) });
      }
    }
    for await (const { item: { pr, key, seen }, value, error } of this.preparePresentations(candidates)) {
      try {
        if (error) throw error;
        if (!value || value.skipped || this.mode === 'off' || this.now() < this.github?.retryAt
          || this.pendingRestart(pr.number, pr.head.sha)) continue;
        if (this.presentationPending(pr)) { this.skipPreparedReview(pr); continue; }
        if (value.identity !== this.presentationIdentity(pr)) continue;
        const failures = this.reconcileCounts?.failed;
        const skipped = this.reconcileCounts?.skipped;
        const deferred = this.reconcileCounts?.deferred;
        // Reuse the pure inspection, but never use its prefetched head/base as
        // write authority. The compare is presentation-only; all native fences
        // retain their own unconditional inspections.
        let inspection = value.inspection ?? null;
        if (inspection) {
          const fresh = await withRequestPhase('inspect', pr.number, () =>
            this.github.request('GET', `/repos/${this.github.repo}/pulls/${pr.number}`));
          if (fresh.head?.sha !== pr.head.sha || fresh.base?.sha !== inspection.pr.base?.sha
            || fresh.base?.ref !== 'main' || fresh.head?.repo?.full_name !== this.github.repo
            || fresh.state !== 'open' || fresh.draft) continue;
          inspection = { ...inspection, pr: fresh,
            conflicting: fresh.mergeable === false ? true : fresh.mergeable === true ? false : null };
        }
        if (this.presentationPending(pr)) { this.skipPreparedReview(pr); continue; }
        if (value.identity !== this.presentationIdentity(pr) || this.pendingRestart(pr.number, pr.head.sha)) continue;
        const shepherded = await withRequestPhase('inspect', pr.number, () =>
          this.shepherdBefore(pr.number, inspection, value.inspectionError));
        if (shepherded?.update !== 'accepted') await withRequestPhase('review', pr.number, () => this.reconcileReview(inspection?.pr ?? pr));
        if (!this.pendingRestart(pr.number, pr.head.sha)) {
          await withRequestPhase('status', pr.number, () => this.shepherdAfter(shepherded, value));
        }
        const latest = this.store.latest(pr.number, pr.head.sha);
        const approvalRetry = latest?.result_json && JSON.parse(latest.result_json).approval?.arm_error;
        if (failures === this.reconcileCounts?.failed && skipped === this.reconcileCounts?.skipped
          && deferred === this.reconcileCounts?.deferred
          && !approvalRetry && this.sweepSeen.get(pr.number) === seen
          && shepherded?.inspection?.conflicting !== null) {
          this.sweepSeen.set(pr.number, { key, headSha: pr.head.sha,
            identity: this.presentationIdentity(pr), at: this.now() });
        }
      } catch (error) {
        if (this.deferBudget(error, pr.number, 'preparation')) continue;
        this.reconcileCounts.failed++;
        this.log({ event: 'reconcile_pr_failed', pr: pr.number, step: 'preparation',
          cause: sanitize(error.message, { secrets: this.publisher?.secrets ?? [], limit: 1000 }) });
      }
    }
    if (!this.mergeLaneEnabled) return;
    // Scheduling hints only; the lane still re-reads every native safety fence.
    this.laneCandidates = open.filter((pr) => {
      if (pr.state !== 'open' || pr.draft || pr.base?.ref !== 'main'
        || pr.head?.repo?.full_name !== this.github.repo || !mergeGate(pr).pass) return false;
      const row = this.store.latest(pr.number, pr.head.sha);
      return row?.status === 'completed' && this.store.approvalForReview(row.id)?.outcome === 'approved';
    });
    if (!hadActiveLane && unresolved.size === 0) await withRequestPhase('lane', null, () => this.advanceMergeLane(open));
  }
  deferBudget(error, pr, step) {
    if (error?.code !== 'github_budget_deferred') return false;
    this.reconcileSoon(Math.max(1000, error.retryAt - this.now()));
    if (this.reconcileCounts) this.reconcileCounts.deferred = (this.reconcileCounts.deferred ?? 0) + 1;
    this.dirtySweep({ pr });
    this.log({ event: 'reconcile_pr_deferred', status: 'DEFERRED', pr, step,
      reason: sanitize(error.reason ?? error.code, { limit: 100 }),
      priority: error.priority, retryAt: error.retryAt });
    return true;
  }
  async *preparePresentations(candidates) {
    this.presentationPreparations++;
    try {
      yield* prepareInOrder(candidates, ({ pr }) => this.preparePresentation(pr),
        () => this.mode !== 'off' && !(this.now() < this.github?.retryAt));
    } finally {
      // The iterator drains its workers before candidate discovery may begin.
      this.presentationPreparations--;
    }
  }
  skipPreparedReview(pr) {
    if (this.reconcileCounts) this.reconcileCounts.skipped++;
    this.log({ event: 'reconcile_pr_skipped', pr: pr.number, step: 'preparation' });
  }
  presentationPending(pr) {
    const row = this.store.latest(pr.number, pr.head.sha) ?? { id: null, pr: pr.number, head_sha: pr.head.sha };
    return this.hasPendingEnqueue(row) || this.pendingCancels.has(row.id);
  }
  presentationIdentity(pr) {
    const row = this.store.latest(pr.number, pr.head.sha);
    const pending = this.presentationPending(pr);
    return JSON.stringify([row, row && this.store.approvalForReview(row.id), this.store.active(pr.number),
      this.mergeLaneEnabled ? this.store.nativeCiFailure(pr.number, pr.head.sha) : null,
      this.store.exhaustedFailure(pr.number, pr.head.sha), pending]);
  }
  async preparePresentation(pr) {
    const identity = this.presentationIdentity(pr);
    if (!this.shepherd) return { identity };
    return withGitHubPriority('presentation', () => withRequestPhase('inspect', pr.number, async () => {
      const options = { informational: true, headSha: pr.head.sha, pr: pr.number };
      let inspection;
      try {
        inspection = await this.shepherd.inspect(pr.number, options);
        if (inspection.pr.head.sha !== pr.head.sha) return { skipped: true };
      } catch (inspectionError) {
        if (inspectionError.code === 'github_budget_deferred') {
          this.reconcileSoon(Math.max(1000, inspectionError.retryAt - this.now()));
        }
        return { identity, inspectionError };
      }
      try {
        const humans = [...effectiveHumanReviews(await this.github.paginate(
          `/repos/${this.github.repo}/pulls/${pr.number}/reviews`, undefined, undefined, options)).values()];
        const ci = await this.latestCi(pr.head.sha, { display: true });
        return { identity, inspection, humans, ci };
      } catch (presentationError) {
        if (presentationError.code === 'github_budget_deferred') {
          this.reconcileSoon(Math.max(1000, presentationError.retryAt - this.now()));
        }
        // These reads formerly ran after review reconciliation. Preserve that
        // liveness: a status outage must not suppress enqueue/approval recovery.
        return { identity, inspection, presentationError };
      }
    }));
  }
  presentationGuard(pr, batch = null) {
    const identity = this.presentationIdentity(pr);
    const refuse = (cause) => {
      throw Object.assign(new Error('publication_cancelled'), { presentationCause: cause });
    };
    const mergedMember = () => {
      const current = batch && this.batchLane.current(batch);
      const member = current?.members.find((item) => item.pr === pr.number);
      const proof = current?.member_proofs?.[pr.number];
      return current?.state === 'publishing' && Boolean(current.deploy_proof)
        && member?.pull_request_id === pr.node_id && proof?.native_merged === true
        && proof.observed_head === pr.head.sha;
    };
    const checkpoint = () => {
      if (this.mode === 'off') refuse('mode_off');
      if (this.admission?.state?.mode === 'off') refuse('admission_off');
      if (this.presentationPending(pr)) refuse('presentation_pending');
      if (this.pendingRestart(pr.number, pr.head.sha)) refuse('restart_terminal_pending');
      if (identity !== this.presentationIdentity(pr)) refuse('presentation_identity_changed');
    };
    return async (phase) => {
      checkpoint();
      if (phase === 'before_send') {
        const fresh = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${pr.number}`);
        checkpoint();
        // A journaled post-merge receipt expects the source to be merged. Ordinary
        // presentation still requires an open PR, including a closed unmerged one.
        if (fresh.state !== 'open' && !(fresh.merged === true && mergedMember())) refuse('source_not_open');
        if (fresh.draft) refuse('source_draft');
        if (fresh.head?.sha !== pr.head.sha) refuse('source_head_changed');
        if (fresh.base?.ref !== pr.base?.ref) refuse('source_base_ref_changed');
        if (fresh.base?.sha !== pr.base?.sha) refuse('source_base_sha_changed');
        if (fresh.head?.repo?.full_name !== this.github.repo) refuse('source_repository_changed');
      }
    };
  }
  async reconcileReview(pr) {
    if (this.frozenCarrier(pr.number)) return;
    let step = 'recovery';
    try {
      if (this.pendingRestart(pr.number, pr.head.sha)) return;
      const active = this.store.active(pr.number);
      if (active?.base_ref === 'main' && active.head_sha === pr.head.sha) return;
      if (active) await this.cancel(pr.number, 'superseded');
      step = 'inspection';
      const stored = this.store.get(`SELECT * FROM reviews WHERE pr=? AND head_sha=? AND base_ref='main'
        AND (status='completed' OR (status='failed' AND attempt>=2)) ORDER BY id DESC LIMIT 1`, pr.number, pr.head.sha);
      const review = stored?.status === 'completed' && stored.result_json ? JSON.parse(stored.result_json) : null;
      if (!stored) {
        step = 'enqueue';
        await this.enqueue({ pr: pr.number, head_sha: pr.head.sha, base_ref: pr.base.ref, due: this.now(), reason: 'reconcile' });
      } else if (stored && review) {
        step = 'approval';
        await this.approveCompleted(stored, review);
      }
    } catch (error) {
      if (this.deferBudget(error, pr.number, step)) return;
      const skipped = error.message === 'publication_cancelled';
      this.reconcileCounts[skipped ? 'skipped' : 'failed']++;
      this.log({ event: skipped ? 'reconcile_pr_skipped' : 'reconcile_pr_failed', pr: pr.number, step });
    }
  }
  async shepherdBefore(number, prepared, inspectionError) {
    if (!this.shepherd) return null;
    try {
      // Preserve the original failure boundary without retrying a failed prefetch.
      if (inspectionError) throw inspectionError;
      const inspection = prepared ?? await this.shepherd.inspect(number);
      if (inspection.pr.state !== 'open' || inspection.pr.draft || inspection.pr.base?.ref !== 'main'
        || inspection.pr.head.repo?.full_name !== this.github.repo) return null;
      if (inspection.conflicting === null) {
        this.reconcileSoon(60000);
        return { inspection, update: null };
      }
      // Behind-only updates belong exclusively to the persisted merge lane.
      // Conflicts remain visible for their author; the bot cannot resolve them.
      const update = botMayUpdateBranch(inspection.pr)
        ? this.store.failedUpdate(number, inspection.pr.head.sha)?.outcome ?? null : null;
      await this.shepherd.syncLabel({ pr: inspection.pr,
        needsUpdate: inspection.conflicting || Boolean(update?.startsWith('failed:')), guard: this.presentationGuard(inspection.pr) });
      return { inspection, update };
    } catch (error) {
      if (this.deferBudget(error, number, 'before')) return null;
      const skipped = error.message === 'publication_cancelled';
      this.reconcileCounts[skipped ? 'skipped' : 'failed']++;
      this.log({ event: skipped ? 'shepherd_skipped' : 'shepherd_failed', pr: number, step: 'before' });
      return null;
    }
  }
  reviewApproved(pr, humans) {
    return humans.some((r) => r.state === 'APPROVED' && r.user.id !== pr.user?.id
      && HUMAN_APPROVERS.some((user) => user.id === r.user.id && user.login === r.user.login));
  }
  async sourceAuthorization({ pr, conflicting, behindBy }, options = {}) {
    if (pr.state !== 'open' || pr.draft || pr.base?.ref !== 'main'
      || pr.head?.repo?.full_name !== this.github.repo || conflicting === true
      || !mergeGate(pr).pass) return { state: 'blocked' };
    if (conflicting === null) return { state: 'wait', reason: 'mergeability_unknown' };
    if (this.store.active(pr.number)) return { state: 'wait', reason: 'review_active' };
    if (this.store.nativeCiFailure(pr.number, pr.head.sha)) return { state: 'blocked' };
    const row = this.store.latest(pr.number, pr.head.sha);
    const failed = this.store.exhaustedFailure(pr.number, pr.head.sha);
    if (failed && (!row || failed.id > row.id)) return { state: 'blocked' };
    if (!row || row.status !== 'completed' || !row.result_json) return { state: 'wait', reason: 'review_pending' };
    const review = JSON.parse(row.result_json);
    if (!review.result?.pass || review.verdict?.reason || review.verdict?.decision !== 'approve') return { state: 'blocked' };
    try { this.approvalCheckpoint(row); } catch { return { state: 'wait', reason: 'approval_checkpoint' }; }
    const humans = [...effectiveHumanReviews(await this.github.paginate(`/repos/${this.github.repo}/pulls/${pr.number}/reviews`, undefined, undefined, options)).values()];
    if (humans.some((human) => human.state === 'CHANGES_REQUESTED')) return { state: 'blocked' };
    const receipt = this.store.approvalForReview(row.id);
    if (!receipt?.github_review_id || receipt.outcome !== 'approved' || receipt.armed) return { state: 'wait', reason: 'approval_receipt_pending' };
    return { state: 'authorized', row, review, carrierOnly: behindBy > 0 && !botMayUpdateBranch(pr) };
  }
  async readinessCi(inspection, options = {}) {
    const authorization = await this.sourceAuthorization(inspection, options);
    if (authorization.state !== 'authorized') return authorization;
    const ci = await this.latestCi(inspection.pr.head.sha, options);
    try { this.approvalCheckpoint(authorization.row); } catch { return { state: 'wait', reason: 'approval_checkpoint' }; }
    if (this.store.nativeCiFailure(inspection.pr.number, inspection.pr.head.sha)) return { state: 'blocked' };
    return { ...authorization, ci };
  }
  async prepareReadiness(inspection, options = {}) {
    const readiness = await this.readinessCi(inspection, options);
    if (readiness.state !== 'authorized') return readiness;
    const native = await this.nativeCi.preparation(readiness.ci);
    try { this.approvalCheckpoint(readiness.row); } catch { return { state: 'wait', reason: 'approval_checkpoint' }; }
    if (this.store.nativeCiFailure(inspection.pr.number, inspection.pr.head.sha)) return { state: 'blocked' };
    if (native === 'wait') return { ...readiness, state: 'wait', native, reason: 'ci_pending' };
    return { ...readiness, state: ['native', 'deferred'].includes(native) ? 'prepared' : 'blocked', native };
  }
  async mergeReadiness(inspection) {
    const readiness = await this.readinessCi(inspection);
    if (readiness.state !== 'authorized') return readiness;
    if (readiness.carrierOnly) return { state: 'blocked' };
    if (!readiness.ci || readiness.ci.status !== 'completed') return { state: 'wait', reason: 'ci_pending' };
    return { ...readiness, state: readiness.ci.conclusion === 'success' ? 'ready' : 'blocked' };
  }
  async advanceMergeLane(open) {
    if (this.mergeLaneEnabled) return this.batchLane.advance(open);
  }
  async reconcileLane() {
    if (!this.mergeLaneEnabled || !this.shepherd || !this.approval || this.mode !== 'approve') return;
    const batch = this.store.activeMergeBatch();
    // Journal recovery/publication is real lane work, not a scan of unrelated PRs.
    if (batch && (batch.mutation || !batch.target_pr || ['closing', 'publishing'].includes(batch.state))) {
      await this.advanceMergeLane([]);
      return;
    }
    // Bound the safety net to one candidate per pass even with ten approved PRs.
    // Events wake normal reconciliation; unchanged presentations rescan after 30 min.
    const candidate = batch
      ? { number: batch.target_pr, head: { sha: batch.head_sha } }
      : this.laneCandidates[this.laneCursor++ % this.laneCandidates.length];
    if (!candidate) return;
    // The bounded unconditional probe is also a lost-webhook recovery owner.
    // Its observation must not be hidden by a cached negative on the next sweep.
    if (!batch) this.batchLane.invalidateCandidates({ pr: candidate.number });
    const { inspection, ready } = await withGitHubPriority('merge', async () => {
      const inspection = await this.shepherd.inspect(candidate.number);
      const ready = batch ? await this.mergeReadiness(inspection) : await this.prepareReadiness(inspection);
      return { inspection, ready };
    });
    if (ready.state === (batch ? 'ready' : 'prepared') || (batch && ready.state === 'blocked')
      || inspection.pr.state !== 'open' || inspection.pr.head.sha !== candidate.head.sha) {
      this.reconcileSoon(0);
    }
  }
  async shepherdAfter(s, presentation) {
    if (!s) return;
    let operation = 'upgrade_rereview';
    try {
      if (s.update !== 'accepted') await this.upgradeRereview(s.inspection.pr);
      operation = 'presentation';
      if (presentation?.presentationError) throw presentation.presentationError;
      operation = 'publish_status';
      if (s.inspection.conflicting !== null) await this.publishStatus(s.inspection, s.update, undefined, presentation);
    } catch (error) {
      if (this.deferBudget(error, s.inspection.pr.number, operation)) return;
      this.reconcileCounts.failed++;
      const secrets = [...(this.publisher?.secrets ?? []), ...(this.shepherd?.secrets ?? [])];
      const clean = (value, limit) => sanitize(value, { secrets, limit });
      const cause = { name: clean(error?.name ?? 'Error', 100), message: clean(error?.message ?? error, 1000) };
      if (error?.code !== undefined) cause.code = clean(error.code, 100);
      this.log({ event: 'shepherd_failed', pr: s.inspection.pr.number, step: 'after', operation, cause });
    }
  }
  async upgradeRereview(pr) {
    if (this.pendingRestart(pr.number, pr.head.sha)) return;
    if (this.revision === null || this.store.active(pr.number)) return;
    const latest = this.store.latest(pr.number, pr.head.sha);
    if (!latest || latest.base_ref !== 'main' || latest.bot_revision === this.revision
      || ['approved', 'merged_direct'].includes(this.store.approvalForReview(latest.id)?.outcome)
      || this.store.upgradeRereviewsSince(this.now() - 3600000) >= UPGRADE_REREVIEWS_PER_HOUR) return;
    if (this.store.exhaustedFailure(pr.number, pr.head.sha)?.id > latest.id) return;
    await this.enqueue({ pr: pr.number, head_sha: pr.head.sha, base_ref: 'main', due: this.now(), reason: 'upgrade_rereview' });
    this.log({ event: 'upgrade_rereview_queued', pr: pr.number });
  }
  publishStatus(inspection, update, batch = this.batchLane?.statusBatch(inspection.pr.number), presentation) {
    if (!this.mergeLaneEnabled) return;
    const owned = batch && (this.batchLane.active(batch) || this.batchLane.current(batch)?.state === 'publishing');
    return withGitHubPriority(owned ? 'merge' : 'presentation', async () => {
      try { return await this.#publishStatus(inspection, update, batch, presentation); }
      catch (error) {
        if (error.message !== 'publication_cancelled') throw error;
        this.log({ event: 'status_publication_cancelled', pr: inspection.pr.number,
          head_sha: inspection.pr.head.sha, cause: error.presentationCause ?? 'publication_guard_cancelled' });
        // Presentation can race a legitimate review transition. It owns no
        // authority to retire the selection; the next status pass uses fresh facts.
        return { pending: true };
      }
    });
  }
  async #publishStatus(inspection, update, batch, presentation) {
    const { pr } = inspection;
    const head = pr.head.sha;
    let guard = this.presentationGuard(pr, batch);
    const active = this.store.active(pr.number);
    const latest = this.store.latest(pr.number, head);
    let review = latest?.result_json ? JSON.parse(latest.result_json) : null;
    const failed = this.store.exhaustedFailure(pr.number, head);
    const failedReason = failed && (!latest || failed.id > latest.id) ? failed.reason : null;
    if (failed && (!latest || failed.id > latest.id)) review = null;
    const humans = presentation?.humans ?? [...effectiveHumanReviews(await this.github.paginate(
      `/repos/${this.github.repo}/pulls/${pr.number}/reviews`, undefined, undefined, { informational: true, headSha: head, pr: pr.number })).values()];
    if (update === undefined) update = botMayUpdateBranch(pr) ? this.store.failedUpdate(pr.number, head)?.outcome ?? null : null;
    if (latest?.status === 'completed' && !active && review?.approval?.arm_error) {
      const branchUpdate = this.store.failedUpdate(pr.number, head)?.outcome ?? null;
      if (review.approval.branch_update !== branchUpdate) {
        await guard('before_send');
        review.approval.branch_update = branchUpdate;
        this.store.update(latest.id, { result_json: JSON.stringify(review) });
        guard = this.presentationGuard(pr, batch);
        await guard('before_send');
        await this.publisher.updateEvidence(latest, review);
      }
    }
    const quarantine = this.store.nativeCiFailure(pr.number, head);
    const nativeStatus = quarantine
      ? [`Native CI quarantined for this exact head: [run ${quarantine.run_id}, attempt ${quarantine.run_attempt}, job ${quarantine.job_id}](https://github.com/${this.github.repo}/actions/runs/${quarantine.run_id}/job/${quarantine.job_id}). A new push is required; a successful rerun does not clear quarantine.`]
      : [];
    return this.shepherd.publishStatus(pr.number, statusBody({
      number: pr.number, headSha: head, author: pr.user?.login, conflicting: inspection.conflicting,
      behindBy: inspection.behindBy, update, botUpdatesBranch: botMayUpdateBranch(pr), renovateBranch: renovatePr(pr),
      active: active?.head_sha === head ? active.status : null, review, failedReason,
      botApproved: latest && ['approved', 'merged_direct'].includes(this.store.approvalForReview(latest.id)?.outcome),
      reviewApproved: this.reviewApproved(pr, humans),
      changesRequestedBy: humans.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.user.login),
      ci: presentation ? presentation.ci : await this.latestCi(head, { display: true }), autoMerge: Boolean(pr.auto_merge), gate: mergeGate(pr), secrets: this.shepherd.secrets,
      batch: [...nativeStatus, ...this.batchLane.statusLines(pr.number, batch)],
      mergeSelected: this.store.activeMergeBatch()?.members.some((member) => member.pr === pr.number) ?? false,
      commentRereviewsLeft: Math.max(0, COMMENT_REREVIEWS_PER_HEAD - this.store.commentRereviews(pr.number, head)),
    }), this.batchLane.statusJournal(pr.number, batch), guard).catch((error) => {
      if (error.message === 'publication_cancelled') throw error;
      if (error.code === 'github_budget_deferred') {
        this.reconcileSoon(Math.max(1000, error.retryAt - this.now()));
        throw error;
      }
      const current = batch && this.store.mergeBatch(batch.id, batch.generation);
      if (current && (this.batchLane.active(current) || current.state === 'publishing')) {
        this.batchLane.patch(current, { reason: sanitize(error.message, {
          secrets: this.publisher?.secrets ?? [], limit: 1000,
        }) });
      }
      throw error;
    });
  }
  refreshStatus(number) {
    return withGitHubPriority('presentation', () => this.#refreshStatus(number)).catch((error) => {
      if (error.code === 'github_budget_deferred') this.reconcileSoon(Math.max(1000, error.retryAt - this.now()));
      throw error;
    });
  }
  async #refreshStatus(number) {
    if (!this.mergeLaneEnabled || !this.shepherd) return;
    const inspection = await this.shepherd.inspect(number);
    const { pr, conflicting } = inspection;
    if (pr.state !== 'open' || pr.base?.ref !== 'main' || pr.draft || pr.head.repo?.full_name !== this.github.repo) return;
    if (conflicting === null) this.reconcileSoon(60000);
    else await this.publishStatus(inspection, undefined);
  }
  async prune() {
    const cutoff = this.now() - this.retentionDays * 86400000;
    const active = new Set(this.store.all("SELECT run_id FROM reviews WHERE status IN ('running','queued','publishing')").map((row) => row.run_id));
    for (const root of [this.workRoot, this.sessionsRoot]) {
      for (const name of await readdir(root)) {
        if (!RUN_ID.test(name) || active.has(name)) continue;
        const path = join(root, name);
        const info = await lstat(path);
        if (info.isDirectory() && !info.isSymbolicLink() && info.mtimeMs < cutoff) await rm(path, { recursive: true });
      }
    }
    // Unprocessed comment deliveries are durable approval fences (pendingCommentRereview); keep them.
    this.store.run(`DELETE FROM deliveries WHERE received_at<?
      AND NOT (state='received' AND event IN ('issue_comment','pull_request_review_comment'))`, this.now() - 7 * 86400000);
  }
  async refill() {
    if (this.refilling) return this.refilling;
    const work = withoutRequestMetrics(async () => {
      if (this.mode === 'off' || this.admission?.state?.mode === 'off' || this.now() < this.github?.retryAt) return [];
      const occupied = () => (this.mergeLaneEnabled ? this.store.counts().running
        : this.store.all("SELECT pr FROM reviews WHERE status='running'").filter((row) => !this.frozenCarrier(row.pr)).length)
        + [...this.starting.keys()].filter((id) => {
          const row = this.store.review(id);
          return !this.frozenCarrier(row?.pr) && !['running', 'publishing', 'completed'].includes(row?.status);
        }).length;
      if (occupied() >= this.concurrency) return [];
      let queued = this.store.all("SELECT * FROM reviews WHERE status='queued' AND due_at<=? ORDER BY created_at,id", this.now())
        .filter((row) => !this.frozenCarrier(row.pr) && !this.starting.has(row.id) && !this.pendingCancels.has(row.id));
      if (!queued.length) return [];
      let open = [];
      // This process-local latch gates only broad review-priority discovery. A
      // restart reconsults durable accounting; successful discovery clears it.
      // Never clear it for an intake wake or use it to defer selected merge work.
      if (!this.refillDiscovery || this.now() >= this.refillDiscovery.retryAt) {
        try {
          open = await withGitHubPriority('review', () => this.github.paginate(`/repos/${this.github.repo}/pulls?state=open`));
          this.refillDiscovery = null;
        } catch (cause) {
          if (!['github_budget_deferred', 'github_rate_limited'].includes(cause?.code)
            || !Number.isSafeInteger(cause.retryAt) || cause.retryAt <= this.now()) throw new PriorityDiscoveryUnavailable(cause);
          this.refillDiscovery = { state: 'DEFERRED', priority: 'review', retryAt: cause.retryAt };
          this.log({ event: 'refill_discovery_deferred', ...this.refillDiscovery, cause: safeErrorCause(cause) });
        }
      }
      if (this.refillDiscovery) {
        // A sealed carrier is already selected. Starting only that exact review
        // needs no unrelated PR ranking; start() still revalidates live authority.
        queued = queued.filter(row => this.reviewGitHubPriority(row) === 'merge' && this.queuedDue(row));
        if (!queued.length) return [];
      }
      const priorities = new Map(open.map((pr) => [pr.number, mergePriority(pr) ?? Infinity]));
      queued.sort((a, b) => (priorities.get(a.pr) ?? Infinity) - (priorities.get(b.pr) ?? Infinity));
      const starts = [];
      for (const row of queued) {
        if (this.mode === 'off' || this.admission?.state?.mode === 'off') break;
        // Starting rows already running count once; exited rows no longer reserve.
        if (occupied() >= this.concurrency) break;
        if (this.starting.has(row.id) || !this.queuedDue(row)) continue;
        this.starting.set(row.id, null);
        const start = this.start(row).catch((error) => error.retryAt ? this.deferStart(row, error) : this.serialize(() =>
          this.fail(row, error.message === 'github_timeout' ? 'github_timeout' : 'review_start_failed')))
          .finally(() => this.starting.delete(row.id));
        this.starting.set(row.id, start);
        starts.push(start);
      }
      return starts;
    });
    this.refilling = work;
    try { return await work; }
    finally { if (this.refilling === work) this.refilling = null; }
  }
  async executionPump() {
    if (this.mode === 'off') return;
    const polls = this.store.all("SELECT * FROM reviews WHERE status IN ('running','publishing')")
      .filter((row) => !this.frozenCarrier(row.pr))
      .map((row) => this.poll(row).catch((error) => {
        if (error.message !== 'publication_cancelled') this.recordPollFailure(row, error);
      }));
    const starts = await this.refill();
    await Promise.all([...polls, ...starts]);
  }
  tick() {
    // Every existing timer tick observes executions, even when the authority queue
    // is blocked. Per-row leases prevent duplicate polls and publications.
    const pump = this.executionPump().catch((cause) => { throw new SchedulerTickFailure('execution_pump', cause); });
    if (this.busy) return pump;
    this.busy = true;
    const maintenance = this.serialize(() => this.tickNow())
      .then(async () => { this.lastTickCompletedAt = this.now(); await Promise.all(await this.refill()); })
      .catch((cause) => { throw new SchedulerTickFailure('maintenance', cause); })
      .finally(() => { this.busy = false; });
    return Promise.all([pump, maintenance]);
  }
  async tickNow() {
    try {
      if (this.admission) this.mode = (await this.admission.refresh()).mode;
      await this.resumeCancellationTerminals();
      if (this.mode === 'off') { await this.reconcileArmed(); return; }
      if (this.now() < this.github?.retryAt) return;
      await this.resumeRestartTerminals();
      await this.reconcileRerequests();
      await this.retryReceivedNow();
      for (const pr of [...this.statusDue]) {
        this.statusDue.delete(pr);
        try { await this.refreshStatus(pr); } catch { this.log({ event: 'status_refresh_failed', pr }); }
      }
      if (this.now() - this.lastReconcileAt >= 300000
        || (this.reconcileSoonAt !== null && this.now() >= this.reconcileSoonAt)) await this.reconcile();
      else if (this.mergeLaneEnabled && this.now() - this.lastLaneReconcileAt >= this.reconcileIntervalMs
        && (this.store.activeMergeBatch() || this.laneCandidates.length)) {
        this.lastLaneReconcileAt = this.now();
        try { await this.reconcileLane(); }
        catch { this.log({ event: 'merge_lane_reconcile_failed' }); }
      }
      if (this.now() - this.lastPruneAt >= 86400000) {
        try { await this.prune(); }
        catch { this.log({ event: 'prune_failed', failures: ++this.pruneFailures }); }
        finally { this.lastPruneAt = this.now(); }
      }
      if (this.admission && this.admission.state?.mode !== undefined && this.mode !== this.admission.state.mode) {
        this.mode = this.admission.state.mode;
        if (this.mode === 'off') await this.reconcileArmed();
      }
    } finally {
      // Only the serialized scheduler, never a health read, may acknowledge idle.
      await this.#refreshMergeDrain(true);
    }
  }
}
