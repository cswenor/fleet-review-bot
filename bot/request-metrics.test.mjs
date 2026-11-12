import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withReconcileMetrics, withRequestPhase, withoutRequestMetrics, recordLogicalRequest, beginRequestAttempt } from './request-metrics.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
};
const summary = (rows) => rows.find((row) => row.event === 'reconcile_request_summary');

test('exact aggregate accounting, dimensions, retry statuses, sum latency and finish idempotence', () => {
  let now = 10;
  const rows = [];
  const result = withReconcileMetrics((row) => rows.push(row), () => withRequestPhase('inspect', 42, () => {
    recordLogicalRequest({ appId: 7, method: 'GET' });
    const first = beginRequestAttempt({ appId: 7, method: 'GET', retry: false });
    now = 15;
    first({ status: 503, outcome: 'http_error' });
    first({ status: 200, latencyMs: 9999, outcome: 'success' });
    now = 1015;
    const second = beginRequestAttempt({ appId: 7, method: 'GET', retry: true });
    now = 1022;
    second({ status: 200, outcome: 'success' });
    return 123;
  }), { now: () => now });
  assert.equal(result, 123);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { event: 'reconcile_request_phase', cycleId: rows[0].cycleId,
    phase: 'inspect', pr: 42, appId: 7, method: 'GET', logicalCalls: 1, attempts: 2, retries: 1,
    latencyMs: 12, statusCounts: { 200: 1, 503: 1 }, outcomeCounts: { http_error: 1, success: 1 },
    inflight: 0, maxInflight: 1, complete: true });
  assert.equal(summary(rows).durationMs, 1012);
  assert.equal(summary(rows).tailDurationMs, 0);
});

test('phase wrappers preserve callback identity and synchronous exceptions', async () => {
  const promise = Promise.resolve(9);
  const error = new Error('original');
  withReconcileMetrics(() => {}, () => {
    assert.equal(withRequestPhase('review', 1, () => promise), promise);
    assert.equal(withoutRequestMetrics(() => promise), promise);
    assert.throws(() => withRequestPhase('review', 1, () => { throw error; }), (caught) => caught === error);
  });
  assert.equal(await promise, 9);
});

test('interleaved roots and escaped work never share metrics or other ALS state', async () => {
  const firstRows = []; const secondRows = [];
  const firstGate = deferred(); const secondGate = deferred();
  const unrelated = new AsyncLocalStorage();
  const first = unrelated.run('preserved', () => withReconcileMetrics((row) => firstRows.push(row), async () => {
    await withRequestPhase('inspect', 11, async () => {
      const finish = beginRequestAttempt({ appId: 1, method: 'GET' });
      await firstGate.promise;
      finish({ status: 200, latencyMs: 3, outcome: 'success' });
    });
    await withoutRequestMetrics(async () => {
      assert.equal(unrelated.getStore(), 'preserved');
      recordLogicalRequest({ appId: 900, method: 'DELETE' });
      beginRequestAttempt({ appId: 900, method: 'DELETE' })({ status: 204 });
    });
  }));
  const second = withReconcileMetrics((row) => secondRows.push(row), () => withRequestPhase('review', 22, async () => {
    const finish = beginRequestAttempt({ appId: 2, method: 'POST' });
    await secondGate.promise;
    finish({ status: 201, latencyMs: 7, outcome: 'success' });
  }));
  secondGate.resolve(); await second;
  assert.equal(firstRows.length, 0);
  firstGate.resolve(); await first;
  assert.equal(summary(firstRows).attempts, 1);
  assert.equal(summary(secondRows).attempts, 1);
  assert.notEqual(summary(firstRows).cycleId, summary(secondRows).cycleId);
  assert.equal(firstRows[0].pr, 11);
  assert.equal(secondRows[0].pr, 22);
});

test('root return never drains inflight work and complete summary waits for tail settlement', async () => {
  const rows = []; let finish; let now = 10;
  assert.equal(withReconcileMetrics((row) => rows.push(row), () => {
    finish = beginRequestAttempt({ appId: 1, method: 'GET' });
    now = 15;
    return 'returned';
  }, { now: () => now }), 'returned');
  assert.equal(rows.length, 0);
  now = 30;
  finish({ status: 200, outcome: 'success' });
  assert.equal(summary(rows).rootDurationMs, 5);
  assert.equal(summary(rows).tailDurationMs, 15);
  assert.equal(summary(rows).durationMs, 20);
  assert.equal(summary(rows).latencyMs, 20);
  assert.equal(summary(rows).complete, true);
});

test('clock and logger failures never replace original sync or async outcomes', async () => {
  const original = new Error('original');
  const fail = () => { throw new Error('metrics failure'); };
  assert.throws(() => withReconcileMetrics(fail, () => { throw original; }, { now: fail }), (error) => error === original);
  await assert.rejects(withReconcileMetrics(fail, async () => {
    beginRequestAttempt({ appId: 1, method: 'GET' })({ status: 200, outcome: 'success' });
    throw original;
  }, { now: fail }), (error) => error === original);
  assert.equal(await withReconcileMetrics(fail, async () => 7, { now: fail }), 7);
});

test('bounded groups and fixed dimensions cannot log paths, secrets or arbitrary labels', () => {
  const rows = [];
  withReconcileMetrics((row) => rows.push(row), () => {
    for (let pr = 1; pr <= 400; pr++) withRequestPhase('inspect', pr, () => {
      recordLogicalRequest({ appId: 7, method: 'GET' });
      beginRequestAttempt({ appId: 7, method: 'GET' })({ status: 200, latencyMs: 1, outcome: 'success' });
    });
    withRequestPhase('/private?token=ghp_secret', 'secret-sha', () => {
      recordLogicalRequest({ appId: 'Bearer secret', method: '/private-token' });
      beginRequestAttempt({ appId: 'Bearer secret', method: '/private-token' })({ status: 'secret', latencyMs: 2, outcome: 'raw error' });
    });
  });
  assert.equal(rows.filter((row) => row.event === 'reconcile_request_phase').length, 257);
  assert.equal(summary(rows).attempts, 401);
  assert.equal(summary(rows).logicalCalls, 401);
  assert.equal(summary(rows).latencyMs, 402);
  assert.equal(rows.find((row) => row.phase === 'overflow').attempts, 145);
  assert.equal(/secret|private|Bearer|raw error/u.test(JSON.stringify(rows)), false);
});

test('out-of-context attempts and logical calls are no-ops', () => {
  recordLogicalRequest({ appId: 1, method: 'GET' });
  assert.doesNotThrow(() => beginRequestAttempt({ appId: 1, method: 'GET' })({ status: 200 }));
});
