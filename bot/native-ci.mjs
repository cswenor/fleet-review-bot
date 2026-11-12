import { REVIEW_APP_ID } from './identity.mjs';
import { carrierBranch } from './batch-author.mjs';
import { NATIVE_ADMISSION_CHECK, NATIVE_ADMISSION_JOB, NATIVE_DEFERRED_STEP, nativeAdmissionExternalId, parseNativeAdmission } from './native-ci-protocol.mjs';
import { githubRequestNotDispatched } from './github-app.mjs';

const nativeJob = (job) => job.name?.startsWith('Rust tests');
const aggregateJob = (job) => ['Rust', 're-actors/alls-green'].includes(job.name);
const rejected = (error) => /^GitHub request failed: (?:POST|PATCH) \/\S+ HTTP 4\d\d$/u.test(error.message);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

// Preparation and scheduling are deliberately not final CI/proof authority.
export class NativeCi {
  constructor(host) { this.host = host; }
  get github() { return this.host.github; }
  async jobs(ci) {
    if (!positive(ci?.id) || !positive(ci.run_attempt)) throw new Error('native_ci_identity_invalid');
    return this.github.paginate(`/repos/${this.github.repo}/actions/runs/${ci.id}/attempts/${ci.run_attempt}/jobs`, 'jobs');
  }
  async preparation(ci) {
    if (!ci) return 'wait';
    if (ci.status === 'completed' && ci.conclusion === 'success') return 'native';
    if (['cancelled', 'timed_out', 'action_required'].includes(ci.conclusion) || ci.status === 'queued') return ci.status === 'queued' ? 'wait' : 'red';
    const current = await this.jobs(ci);
    // Failed-only retries omit earlier successful jobs from attempt-scoped reads.
    // Overlay this attempt so stale effective results cannot hide a new failure.
    const latest = await this.github.paginate(`/repos/${this.github.repo}/actions/runs/${ci.id}/jobs?filter=latest`, 'jobs');
    const currentNames = new Set(current.map((job) => job.name));
    const jobs = latest.filter((job) => !currentNames.has(job.name)).concat(current);
    const admission = current.filter((job) => job.name === NATIVE_ADMISSION_JOB);
    const recognized = admission.length === 1 && admission[0].status === 'completed' && admission[0].conclusion === 'failure'
      && admission[0].steps?.some((step) => step.name === NATIVE_DEFERRED_STEP && step.conclusion === 'failure')
      && admission[0].steps.every((step) => !['failure', 'cancelled', 'timed_out'].includes(step.conclusion) || step.name === NATIVE_DEFERRED_STEP);
    const fast = jobs.filter((job) => job.name !== NATIVE_ADMISSION_JOB && !nativeJob(job) && !aggregateJob(job));
    const required = ['Reuse tested PR tree', 'Rust checks', 'TypeScript', 'Bots', 'PR image / build'];
    if (recognized && required.every((name) => fast.filter((job) => job.name === name && job.status === 'completed' && job.conclusion === 'success').length === 1)
      && fast.every((job) => job.status === 'completed' && ['success', 'skipped'].includes(job.conclusion))
      && jobs.filter(nativeJob).every((job) => job.status === 'completed' && job.conclusion === 'skipped')) return 'deferred';
    return ci.status === 'completed' ? 'red' : 'wait';
  }
  async inspectFailure(pr, ci, batch) {
    if (!ci) return null;
    const selectedAt = this.host.store.mergeBatch(batch.id, 1)?.selected_at;
    if (!['single', 'batch'].includes(batch.kind) || !Number.isSafeInteger(selectedAt)) throw new Error('native_ci_selection_window_missing');
    const runs = await this.host.ciRuns(pr.head.sha, { requireComplete: true });
    if (!runs.some((run) => run.id === ci.id && run.run_attempt >= ci.run_attempt)) throw new Error('native_ci_history_incomplete');
    // A later green attempt cannot erase a selected native execution failure.
    // The first generation's window also covers a fold completed during downtime.
    for (const run of runs) {
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        for (const job of await this.jobs({ id: run.id, run_attempt: attempt })) {
          if (!nativeJob(job)) continue;
          // Compilation, setup and runner timeouts are retryable. Only nextest's
          // typed TEST_RUN_FAILED outcome emits this failed Actions step.
          // Preserve that outcome even if the job is subsequently cancelled.
          const step = job.steps?.find((step) => step.name === 'Native test failures reported by nextest'
            && step.conclusion === 'failure');
          if (!step) continue;
          const failedAt = Date.parse(step.completed_at ?? job.completed_at);
          if (!Number.isFinite(failedAt)) throw new Error('native_ci_failure_time_unknown');
          if (failedAt < selectedAt) continue;
          if (!positive(job.id)) throw new Error('native_ci_failure_identity_unknown');
          return { pr: pr.number, head_sha: pr.head.sha,
            run_id: run.id, run_attempt: attempt, job_id: job.id,
            reason: 'native_test_failure' };
        }
      }
    }
    return null;
  }
  async recordFailure(pr, ci, batch) {
    if (batch.kind !== 'single') throw new Error('native_ci_failure_attribution_unknown');
    const existing = this.host.store.nativeCiFailure(pr.number, pr.head.sha);
    if (existing) return existing;
    const failure = await this.inspectFailure(pr, ci, batch);
    return failure ? this.host.store.recordNativeCiFailure(failure, this.host.now()) : null;
  }
  signal(batch) {
    const value = { version: 1, repository: this.github.repo, batch_id: batch.id, generation: batch.generation,
      kind: batch.kind, base_sha: batch.base_sha, head_sha: batch.head_sha,
      ...(batch.kind === 'single' ? { pr_number: batch.target_pr } : { carrier_branch: carrierBranch(batch) }) };
    if (!parseNativeAdmission(JSON.stringify(value))) throw new Error('native_admission_identity_invalid');
    return value;
  }
  async findSignal(batch, guard) {
    await guard();
    const external = nativeAdmissionExternalId(batch, batch.head_sha);
    const checks = await this.github.paginate(`/repos/${this.github.repo}/commits/${batch.head_sha}/check-runs?check_name=${NATIVE_ADMISSION_CHECK}&filter=all`, 'check_runs', guard);
    await guard();
    const matches = checks.filter((check) => check.name === NATIVE_ADMISSION_CHECK && check.app?.id === REVIEW_APP_ID
      && check.head_sha === batch.head_sha && check.external_id === external);
    if (matches.length > 1) throw new Error('native_admission_ambiguous');
    const check = matches[0];
    if (check && (JSON.stringify(parseNativeAdmission(check.output?.text)) !== JSON.stringify(this.signal(batch)) || !positive(check.id))) throw new Error('native_admission_receipt_invalid');
    return check ?? null;
  }
  async admit(lane, batch) {
    const guard = async () => lane.checkpoint(batch);
    const existing = await this.findSignal(batch, guard);
    if (existing) {
      if (existing.status !== 'completed' || existing.conclusion !== 'success') throw new Error('native_admission_revoked');
      if (!lane.current(batch).operations.some((op) => op.intent.kind === 'native_admission' && op.receipt.outcome === 'admitted'
        && op.receipt.check_id === existing.id)) {
        await lane.main(batch);
        lane.begin(batch, 'native_admission', { marker: existing.external_id, adopted: true });
        lane.finish(batch, { outcome: 'admitted', check_id: existing.id, head_sha: existing.head_sha, external_id: existing.external_id });
      }
      return existing;
    }
    if (lane.current(batch).operations.some((op) => op.intent.kind === 'native_admission' && op.receipt.outcome === 'admitted')) throw new Error('native_admission_receipt_missing');
    const data = this.signal(batch), marker = nativeAdmissionExternalId(batch, batch.head_sha);
    let check, intentId;
    try {
      check = await this.github.request('POST', `/repos/${this.github.repo}/check-runs`, {
        name: NATIVE_ADMISSION_CHECK, head_sha: batch.head_sha, external_id: marker,
        status: 'completed', conclusion: 'success', completed_at: new Date(this.host.now()).toISOString(),
        output: { title: 'Native execution admitted for the selected candidate',
          summary: 'Scheduling only. Full final CI, review, artifact and closure proofs are still required.', text: JSON.stringify(data) },
      }, async (phase) => {
        await guard();
        if (phase === 'before_send') {
          await lane.main(batch);
          intentId = lane.begin(batch, 'native_admission', { marker }).mutation.id;
        }
      });
    } catch (error) {
      if (intentId && lane.current(batch).mutation?.id === intentId
        && githubRequestNotDispatched(error, 'POST', `/repos/${this.github.repo}/check-runs`)) {
        lane.finish(batch, { outcome: 'not_dispatched', reason: error.message });
      }
      if (rejected(error) && lane.current(batch).mutation?.kind === 'native_admission') lane.finish(batch, { outcome: 'rejected', reason: error.message });
      throw error;
    }
    if (!positive(check?.id) || check.head_sha !== batch.head_sha || check.external_id !== marker || check.app?.id !== REVIEW_APP_ID
      || check.status !== 'completed' || check.conclusion !== 'success') throw new Error('native_admission_unconfirmed');
    lane.finish(batch, { outcome: 'admitted', check_id: check.id, head_sha: batch.head_sha, external_id: marker });
    return check;
  }
  admittedChecks(batch) {
    const checks = new Map(), revoked = new Set();
    for (let generation = 1; generation <= batch.generation; generation++) {
      const history = this.host.store.mergeBatch(batch.id, generation);
      for (const operation of history?.operations ?? []) {
        if (operation.intent.kind === 'native_admission' && operation.receipt.outcome === 'admitted') checks.set(operation.receipt.check_id, operation.receipt);
        if (operation.intent.kind === 'native_admission_revoke' && operation.receipt.outcome === 'revoked') revoked.add(operation.receipt.check_id);
      }
    }
    return [...checks.values()].filter((check) => !revoked.has(check.check_id));
  }
  async revoke(lane, batch) {
    for (const receipt of this.admittedChecks(batch)) {
      const guard = async () => lane.checkpoint(batch, false);
      const path = `/repos/${this.github.repo}/check-runs/${receipt.check_id}`;
      await guard();
      const check = await this.github.request('GET', path, undefined, guard);
      if (check.app?.id !== REVIEW_APP_ID || check.head_sha !== receipt.head_sha || check.external_id !== receipt.external_id) throw new Error('native_admission_revocation_identity_changed');
      let revoked, intentId;
      try {
        revoked = await this.github.request('PATCH', path, { status: 'completed', conclusion: 'cancelled',
          completed_at: new Date(this.host.now()).toISOString(), output: { title: 'Native scheduling admission revoked',
            summary: 'This candidate is no longer selected. This check is not test or merge proof.', text: check.output.text } }, async (phase) => {
          await guard();
          if (phase === 'before_send') intentId = lane.begin(batch, 'native_admission_revoke', { marker: receipt.external_id,
            check_id: receipt.check_id, signal_head_sha: receipt.head_sha }).mutation.id;
        });
      } catch (error) {
        if (intentId && lane.current(batch).mutation?.id === intentId && githubRequestNotDispatched(error, 'PATCH', path)) {
          lane.finish(batch, { outcome: 'not_dispatched', reason: error.message });
        }
        if (rejected(error) && lane.current(batch).mutation?.kind === 'native_admission_revoke') lane.finish(batch, { outcome: 'rejected', reason: error.message });
        throw error;
      }
      if (revoked?.id !== receipt.check_id || revoked.app?.id !== REVIEW_APP_ID || revoked.head_sha !== receipt.head_sha
        || revoked.external_id !== receipt.external_id || revoked.status !== 'completed' || revoked.conclusion !== 'cancelled') throw new Error('native_admission_revocation_unconfirmed');
      lane.finish(batch, { outcome: 'revoked', check_id: receipt.check_id });
    }
  }
  async reconcile(lane, batch) {
    const pending = batch.mutation;
    const guard = async () => lane.checkpoint(batch, false);
    if (pending.kind === 'native_admission') {
      const check = await this.findSignal(batch, guard);
      if (!check) return false;
      if (check.status !== 'completed') return false;
      if (check.conclusion !== 'success') {
        lane.finish(batch, { outcome: 'revoked', check_id: check.id });
        throw new Error('native_admission_revoked');
      }
      lane.finish(batch, { outcome: 'admitted', check_id: check.id, head_sha: check.head_sha, external_id: check.external_id });
      return true;
    }
    if (pending.kind === 'native_admission_revoke') {
      const check = await this.github.request('GET', `/repos/${this.github.repo}/check-runs/${pending.check_id}`, undefined, guard);
      if (check.app?.id !== REVIEW_APP_ID || check.head_sha !== pending.signal_head_sha || check.external_id !== pending.marker) throw new Error('native_admission_revocation_identity_changed');
      if (check.status !== 'completed' || check.conclusion !== 'cancelled') return false;
      lane.finish(batch, { outcome: 'revoked', check_id: pending.check_id });
      return true;
    }
    throw new Error('native_admission_mutation_unknown');
  }
}
