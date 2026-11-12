import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { GitHubBudget, GitHubBudgetDeferred, githubPriority, withGitHubPriority } from './github-budget.mjs';

const SCOPE = '123:owner/repository';
const limits = {
  presentation: { charge: 2, wire: 4, floor: 0 },
  review: { charge: 3, wire: 6, floor: 0 },
  merge: { charge: 4, wire: 8, floor: 0 },
};
function fixture(t, options = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let time = 60_000;
  const budget = new GitHubBudget({ store, scope: SCOPE, now: () => time, limits, ...options });
  return { store, budget, at: (value) => { time = value; } };
}
const deferred = (fn, reason) => {
  let error;
  assert.throws(fn, (value) => {
    error = value;
    return value instanceof GitHubBudgetDeferred && value.code === 'github_budget_deferred'
      && Number.isSafeInteger(value.retryAt) && (!reason || value.reason === reason);
  });
  return error;
};
const core = (remaining, reset) => new Headers({
  'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset),
});
const record = (store) => JSON.parse(store.get('SELECT record_json FROM github_budget WHERE scope=?', SCOPE).record_json);

test('shared total admission leaves carrier reserve and never grants own-class quotas', (t) => {
  const { budget } = fixture(t);
  budget.reserve('presentation'); budget.reserve('presentation');
  const low = deferred(() => budget.reserve('presentation'), 'github_hourly_budget');
  assert.equal(low.retryAt, 62 * 60_000);
  budget.reserve('review');
  deferred(() => budget.reserve('review'), 'github_hourly_budget');
  budget.reserve('merge');
  deferred(() => budget.reserve('merge'), 'github_hourly_budget');
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 4, wireAttempts: 4 });
  assert.deepEqual(budget.snapshot().byClass, {
    presentation: { primaryCharges: 2, wireAttempts: 2 },
    review: { primaryCharges: 1, wireAttempts: 1 },
    merge: { primaryCharges: 1, wireAttempts: 1 },
  });
  assert.deepEqual(budget.snapshot().admissionCeilings.review, { primaryCharges: 3, wireAttempts: 6 });
});

test('SQLite restart and two independently constructed meters conserve crash-pending attempts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'github-budget-'));
  const path = join(root, 'state.sqlite');
  let store = new Store(path), other = new Store(path);
  t.after(async () => { store.close(); other.close(); await rm(root, { recursive: true }); });
  const options = { scope: SCOPE, now: () => 60_000, limits };
  let budget = new GitHubBudget({ store, ...options });
  const parallel = new GitHubBudget({ store: other, ...options });
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => Promise.resolve().then(() => {
    try { return (index % 2 ? budget : parallel).reserve('merge'); }
    catch (error) { return error; }
  })));
  assert.equal(results.filter((value) => !(value instanceof Error)).length, 4);
  assert.equal(results.filter((value) => value.code === 'github_budget_deferred').length, 8);
  store.close(); store = new Store(path);
  budget = new GitHubBudget({ store, ...options });
  assert.equal(budget.snapshot().pendingReservations, 4);
  deferred(() => budget.reserve('merge'));
  // A receipt from before process replacement is still exactly-once refundable.
  const receipt = results.find((value) => !(value instanceof Error));
  budget.settle(receipt, { status: 304 });
  budget.settle(receipt, { status: 304 });
  budget.reserve('merge');
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 4, wireAttempts: 5 });
});

test('304 refunds only its reservation, unknown outcomes stay charged, every wire remains bounded', (t) => {
  const { budget } = fixture(t);
  const first = budget.reserve('merge'), second = budget.reserve('merge');
  budget.settle(first, { status: 304 }); budget.settle(first, { status: 304 });
  budget.settle(second, {});
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 1, wireAttempts: 2 });
  for (let i = 0; i < 6; i++) budget.settle(budget.reserve('merge'), { status: 304 });
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 1, wireAttempts: 8 });
  deferred(() => budget.reserve('merge'), 'github_hourly_budget');
  assert.equal(budget.snapshot().pendingReservations, 0);
});

test('inclusive minute windows and clock rollback never expire accounting early', (t) => {
  const { budget, at, store } = fixture(t);
  at(119_999);
  const old = budget.reserve('merge');
  for (let i = 0; i < 3; i++) budget.reserve('merge');
  at(120_000); deferred(() => budget.reserve('merge'));
  at(60_000); deferred(() => budget.reserve('merge'));
  at(62 * 60_000 - 1); deferred(() => budget.reserve('merge'));
  at(62 * 60_000); budget.reserve('merge');
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 1, wireAttempts: 1 });
  budget.settle(old, { status: 304 });
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 1, wireAttempts: 1 });
  const before = store.get('SELECT record_json FROM github_budget WHERE scope=?', SCOPE).record_json;
  at(200 * 60_000);
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 0, wireAttempts: 0 });
  assert.equal(store.get('SELECT record_json FROM github_budget WHERE scope=?', SCOPE).record_json, before,
    'snapshot must not persist expiry, receipts or clock changes');
});

test('retained buckets and pending nonces are bounded and old receipts cannot refund new traffic', (t) => {
  const { budget, store, at } = fixture(t, { limits: { pending: 2 } });
  const one = budget.reserve('merge'), two = budget.reserve('merge');
  deferred(() => budget.reserve('merge'), 'github_pending_budget');
  budget.settle(one, {});
  budget.reserve('merge');
  assert.equal(record(store).pending.length, 2);
  at(62 * 60_000); const fresh = budget.reserve('merge');
  budget.settle(two, { status: 304 });
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 1, wireAttempts: 1 });
  budget.settle(fresh, {});
  for (let minute = 63; minute < 200; minute++) {
    at(minute * 60_000);
    budget.settle(budget.reserve('merge'), { status: 304 });
    assert.ok(record(store).buckets.length <= 61);
    assert.equal(record(store).pending.length, 0);
  }
});

test('core remaining floors subtract outstanding, never replenish on old replies, and preserve newer reset', (t) => {
  const { budget, at } = fixture(t, { limits: {} });
  const first = budget.reserve('review'), outstanding = budget.reserve('review');
  budget.settle(first, { status: 200, headers: core(1502, 3600) });
  assert.deepEqual(budget.snapshot().serverCore, { remaining: 1501, reset: 3_600_000 });
  const lastLow = budget.reserve('presentation');
  deferred(() => budget.reserve('presentation'), 'github_core_reserve');
  const carrier = budget.reserve('merge');
  budget.settle(carrier, { status: 200, headers: core(1400, 7200) });
  budget.settle(outstanding, { status: 200, headers: core(5000, 3600) });
  assert.deepEqual(budget.snapshot().serverCore, { remaining: 1398, reset: 7_200_000 });
  budget.settle(lastLow, { status: 200, headers: core(9999, 7200) });
  assert.deepEqual(budget.snapshot().serverCore, { remaining: 1398, reset: 7_200_000 });
  at(7_200_000); assert.equal(budget.snapshot().serverCore, null);
  budget.reserve('presentation');
});

test('same-window out-of-order headers only tighten and floor protects the next reservation', (t) => {
  const { budget } = fixture(t, { limits: {} });
  const older = budget.reserve(), newer = budget.reserve();
  budget.settle(newer, { status: 200, headers: core(102, 3600) });
  assert.equal(budget.snapshot().serverCore.remaining, 101);
  const last = budget.reserve('merge');
  deferred(() => budget.reserve('merge'), 'github_core_reserve');
  budget.settle(older, { status: 200, headers: core(9999, 3600) });
  assert.equal(budget.snapshot().serverCore.remaining, 100);
  budget.settle(last, { status: 304, headers: core(9999, 3600) });
  deferred(() => budget.reserve('merge'), 'github_core_reserve');
});

test('unknown and non-core response resources cannot replenish the core allowance', (t) => {
  const { budget } = fixture(t, { limits: {} });
  budget.settle(budget.reserve(), { status: 200, headers: core(1500, 3600) });
  for (const resource of [null, 'graphql']) {
    const receipt = budget.reserve('merge');
    const headers = new Headers({ 'x-ratelimit-remaining': '5000', 'x-ratelimit-reset': '7200' });
    if (resource !== null) headers.set('x-ratelimit-resource', resource);
    budget.settle(receipt, { status: 200, headers });
    assert.equal(budget.snapshot().serverCore.reset, 3_600_000);
    deferred(() => budget.reserve('presentation'), 'github_core_reserve');
  }
});

test('genuine Retry-After and exhausted remote reset block all priorities durably', (t) => {
  const { budget, at } = fixture(t, { limits: {} });
  budget.settle(budget.reserve(), { status: 429, headers: new Headers({ 'retry-after': '120' }) });
  for (const p of ['presentation', 'review', 'merge']) {
    assert.equal(deferred(() => budget.reserve(p), 'github_server_backoff').retryAt, 180_000);
  }
  at(180_000);
  budget.settle(budget.reserve('merge'), { status: 403, headers: core(0, 600) });
  for (const p of ['presentation', 'review', 'merge']) assert.equal(deferred(() => budget.reserve(p)).retryAt, 600_000);
  at(600_000); budget.reserve('merge');
});

test('unknown priorities and cross-scope receipts are refused, distinct scopes never share credits', (t) => {
  const { store, budget } = fixture(t);
  assert.throws(() => budget.reserve('urgent'), TypeError);
  assert.throws(() => withGitHubPriority('urgent', () => {}), TypeError);
  assert.throws(() => new GitHubBudget({ store, scope: 'https://secret@example.test' }), TypeError);
  const other = new GitHubBudget({ store, scope: '124:owner/repository', now: () => 60_000, limits });
  const receipt = budget.reserve('merge');
  assert.throws(() => other.settle(receipt, { status: 304 }), TypeError);
  assert.deepEqual(other.snapshot().total, { primaryCharges: 0, wireAttempts: 0 });
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 1, wireAttempts: 1 });
});

test('malformed, wrong-scope, unknown-version and missing ledger storage fail closed without resets', (t) => {
  const { store, budget } = fixture(t);
  budget.reserve('merge');
  const valid = record(store);
  const corruptions = ['not json', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, scope: 'other' }),
    JSON.stringify({ ...valid, pending: [...valid.pending, valid.pending[0]] }),
    JSON.stringify({ ...valid, core: { remaining: -1, reset: 600_000, sequence: 1 } })];
  for (const corrupt of corruptions) {
    store.run('UPDATE github_budget SET record_json=? WHERE scope=?', corrupt, SCOPE);
    deferred(() => budget.reserve('merge'), 'github_budget_accounting_unavailable');
    assert.throws(() => budget.snapshot());
    assert.equal(store.get('SELECT record_json FROM github_budget WHERE scope=?', SCOPE).record_json, corrupt);
  }
  store.db.exec('DROP TABLE github_budget');
  deferred(() => budget.reserve('merge'), 'github_budget_accounting_unavailable');
});

test('storage write failure rolls back reservation and never releases a receipt', (t) => {
  const { store, budget } = fixture(t);
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 0, wireAttempts: 0 });
  assert.equal(store.get('SELECT COUNT(*) AS count FROM github_budget').count, 0);
  budget.reserve('merge');
  const before = record(store);
  store.db.exec(`CREATE TRIGGER budget_write_failure BEFORE UPDATE ON github_budget
    BEGIN SELECT RAISE(ABORT,'accounting unavailable'); END;`);
  deferred(() => budget.reserve('merge'), 'github_budget_accounting_unavailable');
  assert.deepEqual(record(store), before);
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 1, wireAttempts: 1 });
});

test('priority scopes isolate concurrent asynchronous operations and restore on throw', async () => withGitHubPriority('review', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const low = withGitHubPriority('presentation', async () => {
    await barrier; assert.equal(githubPriority(), 'presentation');
    await withGitHubPriority('merge', async () => { await Promise.resolve(); assert.equal(githubPriority(), 'merge'); });
    assert.equal(githubPriority(), 'presentation');
  });
  const high = withGitHubPriority('merge', async () => {
    release(); await Promise.resolve(); assert.equal(githubPriority(), 'merge');
  });
  await Promise.all([low, high]);
  assert.throws(() => withGitHubPriority('merge', () => { throw new Error('stop'); }));
  assert.equal(githubPriority(), 'review');
}));
