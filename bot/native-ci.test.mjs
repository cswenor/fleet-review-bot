import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.mjs';
import { NativeCi } from './native-ci.mjs';
import { REPOSITORY, REVIEW_APP_ID } from './identity.mjs';
import { NATIVE_ADMISSION_CHECK, NATIVE_ADMISSION_JOB, NATIVE_DEFERRED_STEP } from './native-ci-protocol.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubApp } from './github-app.mjs';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

const sha = (n) => n.toString(16).padStart(40, '0');
const ci = { id: 71, run_attempt: 1, status: 'completed', conclusion: 'failure' };
const completed = (name, conclusion = 'success', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
function deferredJobs() {
  return ['Reuse tested PR tree', 'Rust checks', 'TypeScript', 'Bots', 'PR image / build'].map((name) => completed(name)).concat([
    completed(NATIVE_ADMISSION_JOB, 'failure', { steps: [completed('Require known native admission decision'), completed(NATIVE_DEFERRED_STEP, 'failure')] }),
    completed('Rust tests', 'skipped'), completed('Rust', 'failure'), completed('re-actors/alls-green', 'failure'),
  ]);
}
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const state = { jobs: deferredJobs(), attemptJobs: new Map(), runs: [{ ...ci }], checks: [], writes: [], clock: 1000, allowed: true, main: sha(10) };
  const github = { repo: REPOSITORY,
    async paginate(path, key, guard = async () => {}) {
      await guard();
      if (key === 'jobs') {
        if (path.endsWith('/jobs?filter=latest')) return structuredClone(state.jobs);
        const [, id, attempt] = /\/runs\/(\d+)\/attempts\/(\d+)\/jobs/u.exec(path);
        return structuredClone(state.attemptJobs.get(`${id}:${attempt}`) ?? state.jobs);
      }
      if (key === 'check_runs') return structuredClone(state.checks.filter((check) => path.includes(`/commits/${check.head_sha}/`)));
      throw new Error(`unexpected list ${path}`);
    },
    async request(method, path, body, guard = async () => {}) {
      await guard();
      if (method === 'GET') {
        const check = state.checks.find((value) => path.endsWith(`/check-runs/${value.id}`));
        if (!check) throw new Error(`unknown check ${path}`);
        return structuredClone(check);
      }
      await state.beforeSend?.();
      await guard('before_send');
      state.writes.push(method);
      let check;
      if (method === 'POST') {
        check = { id: state.checks.length + 500, app: { id: REVIEW_APP_ID }, ...structuredClone(body) };
        state.checks.push(check);
      } else if (method === 'PATCH') {
        check = state.checks.find((value) => path.endsWith(`/check-runs/${value.id}`));
        Object.assign(check, structuredClone(body));
      } else throw new Error(`unexpected write ${method}`);
      if (state.loseReply) { state.loseReply = false; throw new Error('github_timeout'); }
      await guard();
      return state.alterReply ? state.alterReply(structuredClone(check)) : structuredClone(check);
    } };
  const host = { store, github, now: () => state.clock, ciRuns: async () => structuredClone(state.runs) };
  const native = new NativeCi(host);
  const selected = (generation = 1, head = sha(20)) => store.selectMergeBatch({ id: 'native-lane', generation,
    kind: 'single', state: 'selected', target_pr: 7, head_sha: head, base_sha: state.main,
    selected_at: state.clock, updated_at: state.clock,
    members: [{ pr: 7, head_sha: head, review_id: null, publication_id: null, github_review_id: null,
      ci_run_id: null, ci_attempt: null, pull_request_id: null, priority: null, created_at: null }] });
  const lane = {
    checkpoint(batch) { assert.equal(state.allowed, true, 'authorization revoked'); assert.equal(store.activeMergeBatch()?.generation, batch.generation); },
    async main(batch) { assert.equal(batch.base_sha, state.main, 'main changed'); },
    current(batch) { return store.mergeBatch(batch.id, batch.generation); },
    begin(batch, kind, values) { return store.beginBatchMutation(batch.id, batch.generation,
      { id: `operation-${++state.clock}`, kind, head_sha: batch.head_sha, main_sha: batch.base_sha, marker: null, ...values }, state.clock); },
    finish(batch, receipt) { const pending = store.mergeBatch(batch.id, batch.generation).mutation;
      return store.finishBatchMutation(batch.id, batch.generation, pending.id, receipt, ++state.clock); },
  };
  return { store, state, host, native, selected, lane };
}

function budgetTransport(f) {
  const remote = f.host.github;
  const app = new GitHubApp({ appId: REVIEW_APP_ID, repo: REPOSITORY, privateKey,
    now: () => f.state.clock,
    budget: { reserve() {
      if (f.state.budgetRefuse && f.store.activeMergeBatch().mutation) {
        throw Object.assign(new Error('local budget'), { code: 'github_budget_deferred', retryAt: 100000 });
      }
    }, settle() {} },
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      if (options.method === 'GET' && target.pathname.endsWith('/check-runs')) {
        return new Response(JSON.stringify({ check_runs: f.state.checks }));
      }
      const receipt = await remote.request(options.method, target.pathname, options.body && JSON.parse(options.body));
      return new Response(JSON.stringify(receipt));
    } });
  app.cachedToken = { token: 'fixture-token', expiresAt: Infinity };
  f.host.github = app;
}

test('only the explicit scheduling deferral with all non-native checks green prepares without native proof', async (t) => {
  const f = fixture(t);
  assert.equal(await f.native.preparation(ci), 'deferred');
  f.state.jobs = f.state.jobs.filter((job) => !job.name.startsWith('Rust tests'));
  assert.equal(await f.native.preparation(ci), 'deferred', 'an unallocated skipped matrix may have no expanded jobs');
  assert.equal(await f.native.preparation({ ...ci, conclusion: 'cancelled' }), 'red');
  assert.equal(await f.native.preparation({ ...ci, status: 'queued', conclusion: null }), 'wait');
  assert.equal(await f.native.preparation({ ...ci, conclusion: 'success' }), 'native');
});

test('failed-only admission retry retains successful fast jobs without inheriting an older deferral', async (t) => {
  const f = fixture(t);
  const attempt1 = deferredJobs();
  attempt1.find((job) => job.name === NATIVE_ADMISSION_JOB).steps = [completed('Require known native admission decision', 'failure')];
  const attempt2 = deferredJobs().filter((job) => [NATIVE_ADMISSION_JOB, 'Rust', 're-actors/alls-green', 'Rust tests'].includes(job.name));
  f.state.attemptJobs.set('71:1', attempt1);
  f.state.attemptJobs.set('71:2', attempt2);
  assert.equal(await f.native.preparation(ci), 'red');
  const retry = { ...ci, run_attempt: 2 };
  assert.equal(await f.native.preparation(retry), 'deferred');
  f.state.attemptJobs.set('71:2', attempt2.filter((job) => job.name !== NATIVE_ADMISSION_JOB));
  assert.equal(await f.native.preparation(retry), 'red', 'an older effective deferral cannot authorize the current attempt');
  f.state.attemptJobs.set('71:2', attempt1.filter((job) => job.name === NATIVE_ADMISSION_JOB));
  assert.equal(await f.native.preparation(retry), 'red', 'a current metadata failure cannot inherit the older deferral');
  f.state.attemptJobs.set('71:2', [...attempt2, completed('Bots', 'failure')]);
  assert.equal(await f.native.preparation(retry), 'red', 'a current fast failure overrides a stale successful effective job');
});

for (const [name, alter] of [
  ['unknown admission', (jobs) => { jobs.find((job) => job.name === NATIVE_ADMISSION_JOB).steps = [completed('Require known native admission decision', 'failure')]; }],
  ['another admission failure', (jobs) => { jobs.find((job) => job.name === NATIVE_ADMISSION_JOB).steps.push(completed('Checkout', 'failure')); }],
  ['duplicate admission', (jobs) => { jobs.push(structuredClone(jobs.find((job) => job.name === NATIVE_ADMISSION_JOB))); }],
  ['failed fast check', (jobs) => { jobs.find((job) => job.name === 'Bots').conclusion = 'failure'; }],
  ['unfinished fast check', (jobs) => { jobs.find((job) => job.name === 'PR image / build').status = 'in_progress'; }],
  ['missing fast check', (jobs) => { jobs.splice(jobs.findIndex((job) => job.name === 'Rust checks'), 1); }],
  ['new failing non-native check', (jobs) => { jobs.push(completed('Security', 'failure')); }],
  ['native already executing', (jobs) => { jobs.find((job) => job.name === 'Rust tests').status = 'in_progress'; }],
]) test(`${name} is not mistaken for intentional native deferral`, async (t) => {
  const f = fixture(t); alter(f.state.jobs);
  assert.equal(await f.native.preparation(ci), 'red');
});

test('only failed native execution, not setup, artifact or foreign checks, quarantines an exact candidate', async (t) => {
  const f = fixture(t), pr = { number: 7, head: { sha: sha(20) } }, batch = f.selected();
  for (const jobs of [
    [completed('Rust tests (ares-2, weighted)', 'failure', { id: 80, steps: [completed('Initialize containers', 'failure')] })],
    [completed('Rust tests (ares-2, weighted)', 'failure', { id: 80, steps: [completed('Native tests from persistent target', 'failure')] })],
    [completed('Rust tests (ares-2, weighted)', 'failure', { id: 80, steps: [completed('Compile native tests from persistent target', 'failure'), completed('Native tests from persistent target', 'skipped')] })],
    [completed('Rust tests (ares-2, weighted)', 'failure', { id: 80, steps: [completed('Compile native tests from persistent target'), completed('Native tests from persistent target', 'failure'), completed('Native test failures reported by nextest', 'skipped')] })],
    [completed('Rust tests (ares-2, weighted)', 'failure', { id: 80, steps: [completed('Native tests from persistent target'), completed('Upload artifact', 'failure')] })],
    [completed('TypeScript', 'failure', { id: 80, steps: [completed('Native test failures reported by nextest', 'failure')] })],
  ]) {
    f.state.jobs = jobs.map((job) => ({ ...job, completed_at: '2026-10-23T20:00:00Z' }));
    assert.equal(await f.native.recordFailure(pr, ci, batch), null);
    assert.equal(f.store.nativeCiFailure(7, pr.head.sha), null);
  }
  f.state.jobs = [completed('Rust tests (ares-2, weighted)', 'failure', { id: 80, completed_at: '2026-10-23T20:00:00Z',
    steps: [completed('Native test failures reported by nextest', 'failure')] })];
  assert.equal((await f.native.recordFailure(pr, ci, batch)).reason, 'native_test_failure');
  assert.equal((await f.native.recordFailure(pr, { ...ci, conclusion: 'success' }, batch)).run_id, ci.id);
  assert.equal(f.store.nativeCiFailure(7, sha(21)), null);
});

test('a runner wall timeout without a reported test failure remains retryable', async (t) => {
  const f = fixture(t), pr = { number: 7, head: { sha: sha(20) } }, batch = f.selected();
  for (const name of ['Compile native tests from persistent target', 'Native tests from persistent target']) {
    f.state.jobs = [completed('Rust tests (ares-2, weighted)', 'timed_out', { id: 80,
      completed_at: '2026-10-23T20:00:00Z',
      steps: [{ name, conclusion: null, started_at: '2026-10-23T19:59:00Z' }] })];
    assert.equal(await f.native.recordFailure(pr, { ...ci, conclusion: 'timed_out' }, batch), null);
  }
});

for (const conclusion of ['cancelled', 'timed_out']) {
  test(`a reported test failure survives a subsequent ${conclusion} job`, async (t) => {
    const f = fixture(t), pr = { number: 7, head: { sha: sha(20) } }, batch = f.selected();
    f.state.jobs = [completed('Rust tests (ares-2, weighted)', conclusion, { id: 80,
      steps: [completed('Native test failures reported by nextest', 'failure', { completed_at: '2026-10-23T20:00:00Z' })] })];
    assert.equal((await f.native.recordFailure(pr, { ...ci, conclusion }, batch)).reason, 'native_test_failure');
  });
}

test('a selected native failure remains attributable when a later attempt or separate canonical run is green', async (t) => {
  for (const separateRun of [false, true]) {
    const f = fixture(t), batch = f.selected(), pr = { number: 7, head: { sha: sha(20) } };
    const old = { ...ci, run_attempt: 2 };
    const green = { ...ci, id: separateRun ? 72 : ci.id, run_attempt: separateRun ? 1 : 3, conclusion: 'success' };
    f.state.runs = separateRun ? [green, old] : [green];
    f.state.jobs = [];
    f.state.attemptJobs.set(`${ci.id}:2`, [completed('Rust tests (ares-2, weighted)', 'failure', {
      id: 802, completed_at: new Date(batch.selected_at + 10).toISOString(),
      steps: [completed('Native test failures reported by nextest', 'failure')],
    })]);
    const receipt = await new NativeCi(f.host).recordFailure(pr, green, batch);
    assert.equal(receipt.run_id, ci.id);
    assert.equal(receipt.run_attempt, 2);
    assert.equal(receipt.job_id, 802);
  }
});

test('fold recovery retains the original selection window but excludes earlier native feedback', async (t) => {
  const f = fixture(t), first = f.selected(), pr = { number: 7, head: { sha: sha(21) } };
  f.store.retireMergeBatch(first.id, first.generation, 'source-fold', ++f.state.clock);
  f.state.clock += 100;
  const fold = f.selected(2, pr.head.sha), green = { ...ci, run_attempt: 2, conclusion: 'success' };
  f.state.runs = [green]; f.state.jobs = [];
  const failed = completed('Rust tests (ares-2, weighted)', 'failure', { id: 803,
    completed_at: new Date(first.selected_at - 1).toISOString(),
    steps: [completed('Native test failures reported by nextest', 'failure')] });
  f.state.attemptJobs.set(`${ci.id}:1`, [failed]);
  assert.equal(await f.native.recordFailure(pr, green, fold), null, 'pre-selection feedback is not lane failure');
  failed.completed_at = new Date(first.selected_at + 10).toISOString();
  assert.ok(Date.parse(failed.completed_at) < fold.selected_at, 'failure occurred before fold recovery');
  assert.equal((await f.native.recordFailure(pr, green, fold)).job_id, 803);
});

test('incomplete history or an undated native failure cannot silently admit a later green', async (t) => {
  const f = fixture(t), batch = f.selected(), pr = { number: 7, head: { sha: sha(20) } };
  const green = { ...ci, run_attempt: 2, conclusion: 'success' };
  await assert.rejects(f.native.recordFailure(pr, green, batch), /history_incomplete/u);
  f.state.runs = [green]; f.state.jobs = [];
  f.state.attemptJobs.set(`${ci.id}:1`, [completed('Rust tests (ares-2, weighted)', 'failure', {
    id: 804, steps: [completed('Native test failures reported by nextest', 'failure')],
  })]);
  await assert.rejects(f.native.recordFailure(pr, green, batch), /failure_time_unknown/u);
  assert.equal(f.store.nativeCiFailure(7, pr.head.sha), null, 'unknown evidence is refused, not invented');
});

test('lost scheduling-write reply is adopted after restart without duplicate remote admission', async (t) => {
  const f = fixture(t), batch = f.selected();
  f.state.loseReply = true;
  await assert.rejects(f.native.admit(f.lane, batch), /github_timeout/u);
  assert.equal(f.store.activeMergeBatch().mutation.kind, 'native_admission');
  const restarted = new NativeCi(f.host);
  assert.equal(await restarted.reconcile(f.lane, f.store.activeMergeBatch()), true);
  assert.equal(f.store.activeMergeBatch().mutation, null);
  assert.equal(f.store.activeMergeBatch().operations[0].receipt.outcome, 'admitted');
  await restarted.admit(f.lane, f.store.activeMergeBatch());
  assert.equal(f.state.checks.length, 1);
  assert.deepEqual(f.state.writes, ['POST']);
});

test('adopting a pre-existing trusted admission records it so later invalidation revokes it', async (t) => {
  const f = fixture(t), batch = f.selected();
  const check = await f.native.admit(f.lane, batch);
  f.store.db.prepare('UPDATE merge_batches SET record_json=? WHERE id=? AND generation=1').run(
    JSON.stringify({ ...f.store.activeMergeBatch(), operations: [] }), batch.id);
  await f.native.admit(f.lane, f.store.activeMergeBatch());
  assert.equal(f.store.activeMergeBatch().operations[0].receipt.check_id, check.id);
  await f.native.revoke(f.lane, f.store.activeMergeBatch());
  assert.equal(f.state.checks[0].conclusion, 'cancelled');
  assert.equal(f.native.admittedChecks(f.store.activeMergeBatch()).length, 0);
});

test('revocation follows scheduling hints across source-fold generations and survives a lost reply', async (t) => {
  const f = fixture(t), first = f.selected();
  await f.native.admit(f.lane, first);
  f.store.retireMergeBatch(first.id, first.generation, 'superseded', ++f.state.clock);
  const fold = f.selected(2, sha(21));
  await f.native.admit(f.lane, fold);
  f.state.loseReply = true;
  await assert.rejects(f.native.revoke(f.lane, fold), /github_timeout/u);
  assert.equal(f.store.activeMergeBatch().mutation.kind, 'native_admission_revoke');
  const restarted = new NativeCi(f.host);
  assert.equal(await restarted.reconcile(f.lane, f.store.activeMergeBatch()), true);
  await restarted.revoke(f.lane, f.store.activeMergeBatch());
  assert.equal(f.native.admittedChecks(f.store.activeMergeBatch()).length, 0);
  assert.equal(f.state.checks.every((check) => check.conclusion === 'cancelled'), true);
  assert.deepEqual(f.state.writes, ['POST', 'POST', 'PATCH', 'PATCH']);
});

test('pre-send authorization or main drift cannot mint a native scheduling hint', async (t) => {
  for (const changed of ['authorization', 'main']) {
    const f = fixture(t), batch = f.selected();
    f.state.beforeSend = () => { if (changed === 'main') f.state.main = sha(99); else f.state.allowed = false; };
    await assert.rejects(f.native.admit(f.lane, batch), changed === 'main' ? /main changed/u : /authorization revoked/u);
    assert.equal(f.state.checks.length, 0);
    assert.equal(f.store.activeMergeBatch().mutation, null);
  }
});

test('uncertain absent write stays pending rather than blindly retrying', async (t) => {
  const f = fixture(t), batch = f.selected();
  f.lane.begin(batch, 'native_admission', { marker: 'uncertain' });
  assert.equal(await f.native.reconcile(f.lane, f.store.activeMergeBatch()), false);
  assert.equal(f.store.activeMergeBatch().mutation.kind, 'native_admission');
  assert.deepEqual(f.state.writes, []);
});

test('a revoked check found during recovery settles the confirmed write without restoring admission', async (t) => {
  const f = fixture(t), batch = f.selected();
  f.state.loseReply = true;
  await assert.rejects(f.native.admit(f.lane, batch), /github_timeout/u);
  f.state.checks[0].conclusion = 'cancelled';
  await assert.rejects(f.native.reconcile(f.lane, f.store.activeMergeBatch()), /native_admission_revoked/u);
  assert.equal(f.store.activeMergeBatch().mutation, null);
  assert.equal(f.state.checks[0].conclusion, 'cancelled');
});

test('malformed or wrong-App scheduling receipts cannot be adopted as native authority', async (t) => {
  for (const change of ['payload', 'app', 'duplicate']) {
    const f = fixture(t), batch = f.selected();
    await f.native.admit(f.lane, batch);
    if (change === 'payload') f.state.checks[0].output.text = '{}';
    if (change === 'app') f.state.checks[0].app.id++;
    if (change === 'duplicate') f.state.checks.push(structuredClone(f.state.checks[0]));
    await assert.rejects(f.native.admit(f.lane, f.store.activeMergeBatch()),
      change === 'duplicate' ? /ambiguous/u : change === 'app' ? /receipt_missing/u : /receipt_invalid/u);
  }
});

test('unconfirmed revocation response retains its intent for a later authoritative read', async (t) => {
  const f = fixture(t), batch = f.selected();
  await f.native.admit(f.lane, batch);
  f.state.alterReply = (check) => ({ ...check, conclusion: 'success' });
  await assert.rejects(f.native.revoke(f.lane, f.store.activeMergeBatch()), /revocation_unconfirmed/u);
  assert.equal(f.store.activeMergeBatch().mutation.kind, 'native_admission_revoke');
  assert.equal(await f.native.reconcile(f.lane, f.store.activeMergeBatch()), true);
});

test('budget refusal after admission intent is durably unsent and retries after restart with fresh fences', async (t) => {
  const f = fixture(t), batch = f.selected();
  budgetTransport(f);
  f.state.budgetRefuse = true;
  await assert.rejects(f.native.admit(f.lane, batch), error => error.code === 'github_budget_deferred');
  assert.equal(f.store.activeMergeBatch().mutation, null);
  assert.equal(f.store.activeMergeBatch().operations[0].receipt.outcome, 'not_dispatched');
  assert.deepEqual(f.state.writes, []);
  const restarted = new NativeCi(f.host);
  f.state.budgetRefuse = false;
  f.state.main = sha(99);
  await assert.rejects(restarted.admit(f.lane, f.store.activeMergeBatch()), /main changed/u);
  assert.deepEqual(f.state.writes, [], 'fresh authority still wins after budget expiry');
  f.state.main = batch.base_sha;
  await restarted.admit(f.lane, f.store.activeMergeBatch());
  assert.deepEqual(f.state.writes, ['POST']);
  assert.equal(f.store.activeMergeBatch().operations.at(-1).receipt.outcome, 'admitted');
});

test('unsent budget-deferred revocation settles its own intent and can retry', async (t) => {
  const f = fixture(t), batch = f.selected();
  await f.native.admit(f.lane, batch);
  budgetTransport(f);
  f.state.budgetRefuse = true;
  await assert.rejects(f.native.revoke(f.lane, f.store.activeMergeBatch()), error => error.code === 'github_budget_deferred');
  assert.equal(f.store.activeMergeBatch().mutation, null);
  assert.equal(f.store.activeMergeBatch().operations.at(-1).receipt.outcome, 'not_dispatched');
  assert.deepEqual(f.state.writes, ['POST']);
  f.state.budgetRefuse = false;
  await new NativeCi(f.host).revoke(f.lane, f.store.activeMergeBatch());
  assert.deepEqual(f.state.writes, ['POST', 'PATCH']);
});

test('budget pressure cannot erase a previous invocation uncertain native admission', async (t) => {
  const f = fixture(t), batch = f.selected();
  f.lane.begin(batch, 'native_admission', { marker: 'uncertain' });
  const intent = f.store.activeMergeBatch().mutation;
  budgetTransport(f);
  f.state.budgetRefuse = true;
  await assert.rejects(f.native.admit(f.lane, f.store.activeMergeBatch()), error => error.code === 'github_budget_deferred');
  assert.deepEqual(f.store.activeMergeBatch().mutation, intent);
  assert.deepEqual(f.state.writes, []);
});
