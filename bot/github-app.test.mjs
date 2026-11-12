import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { GitHubApp, githubRequestNotDispatched } from './github-app.mjs';
import { performance } from 'node:perf_hooks';
import { withReconcileMetrics, withRequestPhase, withoutRequestMetrics } from './request-metrics.mjs';
import { GitHubBudget, withGitHubPriority } from './github-budget.mjs';
import { Store } from './store.mjs';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
test('JWT has RS256, bounded timestamps and verifiable signature', () => {
  const app = new GitHubApp({ appId: 1001, privateKey, now: () => 1000000 });
  const token = app.jwt(); const [header, payload, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iat: 940, exp: 1540, iss: '1001' });
  assert.equal(verify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')), true);
});
test('installation tokens survive a shared retry-after window without repeated requests or sleeps', async () => {
  const requests = []; const sleeps = []; let attempts = 0; let now = 1000000;
  const app = new GitHubApp({ appId: 1001, privateKey, repo: 'example-org/example-project', now: () => now, sleep: async (ms) => sleeps.push(ms),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/installation')) return new Response(JSON.stringify({ id: 1007 }));
      if (url.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 'fixture-installation-token', expires_at: new Date(4600000).toISOString() }));
      attempts++;
      return attempts === 1 ? new Response('rate limit', { status: 429, headers: { 'retry-after': '2' } }) : new Response(JSON.stringify({ ok: true }));
    } });
  await assert.rejects(app.request('GET', '/repos/example-org/example-project/pulls/1'),
    (error) => error.code === 'github_rate_limited' && error.retryAt === 1002000);
  await assert.rejects(app.request('GET', '/repos/example-org/example-project/pulls/2'), /deferred until/u);
  await assert.rejects(app.request('POST', '/repos/example-org/example-project/check-runs', {}), /deferred until/u);
  assert.equal(attempts, 1, 'all endpoints share the backoff, before auth or mutation');
  now = 1002000;
  assert.deepEqual(await app.request('GET', '/repos/example-org/example-project/pulls/1'), { ok: true });
  assert.equal(attempts, 2);
  assert.equal(requests.filter((row) => row.url.endsWith('/access_tokens')).length, 1);
  assert.deepEqual(sleeps, [], 'no rate-limit sleep holds the publication queue');
});
test('primary exhaustion honors reset and retry-after and retains only redacted diagnostic fields', async () => {
  let calls = 0; const logs = [];
  const app = new GitHubApp({ appId: 1001, privateKey, now: () => 1000000, log: record => logs.push(record),
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ message: 'API rate limit exceeded fixture-token ghp_secret', token: 'must-not-log' }),
        { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1003', 'retry-after': '2',
          'x-ratelimit-resource': 'core', 'x-github-request-id': 'fixture-request' } });
    } });
  await assert.rejects(app.send('GET', '/fixture', undefined, 'fixture-token'), (error) => {
    assert.equal(error.code, 'github_rate_limited');
    assert.equal(error.retryAt, 1004000);
    assert.equal(error.github.headers['x-github-request-id'], 'fixture-request');
    return true;
  });
  assert.equal(logs[0].github.message, 'API rate limit exceeded [redacted] [redacted]');
  assert.equal(/fixture-token|ghp_secret|must-not-log/u.test(JSON.stringify(logs)), false, 'neither credentials nor unrelated response fields reach logs');
  await assert.rejects(app.send('GET', '/other', undefined, 'fixture-token'), /deferred until/u);
  assert.equal(calls, 1);
});
test('secondary limits back off progressively while ordinary permission 403s do not', async () => {
  let now = 1000000; let calls = 0;
  const app = new GitHubApp({ appId: 1001, privateKey, now: () => now,
    fetchImpl: async () => { calls++; return new Response('secondary rate limit', { status: 403 }); } });
  await assert.rejects(app.send('GET', '/fixture', undefined, 'fixture-token'), (error) => error.retryAt === 1060000);
  now = 1060000;
  await assert.rejects(app.send('GET', '/fixture', undefined, 'fixture-token'), (error) => error.retryAt === 1180000);
  assert.equal(calls, 2);
  let denied = 0;
  const permissions = new GitHubApp({ appId: 1001, privateKey,
    fetchImpl: async () => { denied++; return new Response('Resource not accessible by integration', { status: 403 }); } });
  for (let i = 0; i < 2; i++) await assert.rejects(permissions.send('GET', '/fixture', undefined, 'fixture-token'),
    (error) => error.github.status === 403 && error.code === undefined);
  assert.equal(denied, 2, 'a permission error must not be mislabeled as rate limiting');
});
test('a received mutation rejection is conclusive despite a changed guard or unreadable body', async () => {
  let returned = false; let calls = 0;
  const app = new GitHubApp({ appId: 1001, privateKey, now: () => 1000000,
    fetchImpl: async () => {
      calls++; returned = true;
      return { ok: false, status: 403, headers: new Headers({ 'retry-after': '3' }),
        text: async () => { throw new Error('body unavailable'); } };
    } });
  await assert.rejects(app.send('POST', '/fixture', {}, 'fixture-token',
    async () => { if (returned) throw new Error('Human veto'); }),
  (error) => error.github.status === 403 && error.retryAt === 1003000 && /HTTP 403/u.test(error.message));
  assert.equal(calls, 1);
});

test('create POST failures are never blindly retried', async () => {
  let calls = 0; const sleeps = [];
  const app = new GitHubApp({ appId: 1001, privateKey, sleep: async (ms) => sleeps.push(ms),
    fetchImpl: async () => { calls++; return new Response('ambiguous creation', { status: 503 }); } });
  await assert.rejects(app.send('POST', '/repos/example-org/example-project/check-runs', {}, 'fixture-token'));
  assert.equal(calls, 1); assert.deepEqual(sleeps, []);
});
test('before_send guard runs immediately before fetch, not after an accepted mutation', async () => {
  const events = [];
  const app = new GitHubApp({ appId: 1001, privateKey,
    fetchImpl: async () => { events.push('fetch'); return new Response('{}'); } });
  await app.send('POST', '/repos/example-org/example-project/pulls/1/reviews', {}, 'fixture-token',
    async phase => events.push(phase ?? 'response_guard'));
  assert.deepEqual(events, ['before_send', 'fetch', 'response_guard', 'response_guard']);
  events.length = 0;
  await assert.rejects(app.send('POST', '/repos/example-org/example-project/pulls/1/reviews', {}, 'fixture-token',
    async phase => { if (phase === 'before_send') throw new Error('Human veto'); }), /Human veto/u);
  assert.deepEqual(events, [], 'a veto at this fence proves no POST was sent');
});

test('stalled GitHub fetch aborts with github_timeout and never retries a create', async () => {
  let aborted = false; let calls = 0;
  const app = new GitHubApp({ appId: 1001, privateKey, timeoutMs: 10,
    fetchImpl: async (url, options) => new Promise((accept, reject) => {
      calls++; options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
    }) });
  const hold = setTimeout(() => {}, 100);
  try {
    await assert.rejects(app.send('POST', '/repos/example-org/example-project/check-runs', {}, 'fixture-token'), /github_timeout/u);
    assert.equal(aborted, true); assert.equal(calls, 1);
  } finally { clearTimeout(hold); }
});
test('GraphQL uses the authenticated request path and distinguishes only clean-status errors', async () => {
  const app = new GitHubApp({ appId: 1001, privateKey });
  const calls = [];
  app.request = async (...args) => { calls.push(args); return { data: { receipt: true } }; };
  assert.deepEqual(await app.graphql('mutation fixture', { input: { expectedHeadOid: 'a'.repeat(40) } }), { receipt: true });
  assert.equal(calls[0][0], 'POST'); assert.equal(calls[0][1], '/graphql');
  assert.equal(calls[0][2].variables.input.expectedHeadOid, 'a'.repeat(40));
  app.request = async () => ({ errors: [{ message: 'Pull request is in clean status' }] });
  await assert.rejects(app.graphql('fixture', {}), /^Error: pull_request_clean_status$/u);
  app.request = async () => ({ errors: [{ message: 'Pull request is in clean status' }, { message: 'Forbidden' }] });
  await assert.rejects(app.graphql('fixture', {}), /^Error: github_graphql_failed$/u);
});

test('request metrics count auth, retries and no-send backoff without changing request sequence', async (t) => {
  let time = 0; let calls = 0; const rows = []; const requests = []; const sleeps = [];
  t.mock.method(performance, 'now', () => time);
  const app = new GitHubApp({ appId: 7, privateKey, repo: 'owner/private', now: () => 1000000,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method, authorization: options.headers.Authorization });
      calls++; time += 2;
      const body = url.endsWith('/installation') ? { id: 10 }
        : url.endsWith('/access_tokens') ? { token: 'ghp_private_token', expires_at: new Date(4600000).toISOString() }
          : calls === 3 ? { message: 'secret body' } : { ok: true };
      const status = calls === 3 ? 503 : 200;
      return { status, ok: status === 200, headers: new Headers(),
        json: async () => { time += 3; return body; },
        text: async () => { time += 3; return JSON.stringify(body); } };
    } });
  await withReconcileMetrics((row) => rows.push(row), () => withRequestPhase('inspect', 99, async () => {
    assert.deepEqual(await app.request('GET', '/private?sha=secret-sha', undefined, async () => { time += 100; }), { ok: true });
    app.retryAt = 1001000;
    await assert.rejects(app.request('DELETE', '/private?token=secret-query'), /deferred until/u);
  }));
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(requests.map((row) => row.method), ['GET', 'POST', 'GET', 'GET']);
  assert.equal(requests[2].authorization, 'Bearer ghp_private_token');
  const auth = rows.filter((row) => row.phase === 'auth');
  assert.equal(auth.length, 2);
  assert.ok(auth.every((row) => row.pr === null && row.attempts === 1 && row.logicalCalls === 1));
  const get = rows.find((row) => row.phase === 'inspect' && row.method === 'GET');
  assert.equal(get.logicalCalls, 1);
  assert.equal(get.attempts, 2);
  assert.equal(get.retries, 1);
  assert.equal(get.latencyMs, 10, 'guards and retry sleep are excluded');
  assert.deepEqual(get.statusCounts, { 200: 1, 503: 1 });
  const refused = rows.find((row) => row.method === 'DELETE');
  assert.equal(refused.logicalCalls, 1);
  assert.equal(refused.attempts, 0);
  const summary = rows.find((row) => row.event === 'reconcile_request_summary');
  assert.equal(summary.attempts, 4);
  assert.equal(summary.logicalCalls, 4);
  assert.equal(summary.latencyMs, 20);
  assert.equal(/ghp_private_token|secret-sha|secret-query|secret body|owner\/private/u.test(JSON.stringify(rows)), false);
});

test('metrics distinguish actual 429 attempt from later guard and shared-backoff no-send requests', async () => {
  const rows = []; let calls = 0; const veto = new Error('original veto');
  const app = new GitHubApp({ appId: 7, privateKey, now: () => 1000000,
    fetchImpl: async () => { calls++; return new Response('rate limit', { status: 429, headers: { 'retry-after': '2' } }); } });
  await withReconcileMetrics((row) => rows.push(row), async () => {
    await assert.rejects(app.send('GET', '/secret', undefined, 'secret-token'), (error) => error.code === 'github_rate_limited');
    await assert.rejects(app.send('POST', '/secret', {}, 'secret-token'), /deferred until/u);
    await assert.rejects(app.send('PATCH', '/secret', {}, 'secret-token', async () => { throw veto; }), (error) => error === veto);
  });
  assert.equal(calls, 1);
  const summary = rows.find((row) => row.event === 'reconcile_request_summary');
  assert.equal(summary.logicalCalls, 3);
  assert.equal(summary.attempts, 1);
  assert.deepEqual(summary.statusCounts, { 429: 1 });
  assert.deepEqual(summary.outcomeCounts, { http_error: 1 });
});

test('transport and body failures preserve error identity and count received statuses exactly once', async (t) => {
  let time = 0; const rows = []; const original = new Error('private transport details');
  t.mock.method(performance, 'now', () => time);
  const app = new GitHubApp({ appId: 7, privateKey,
    fetchImpl: async () => { time += 4; throw original; } });
  await withReconcileMetrics((row) => rows.push(row), async () => {
    await assert.rejects(app.send('PUT', '/private', {}, 'secret'), (error) => error === original);
    app.fetch = async () => {
      time += 2;
      return { ok: true, status: 200, json: async () => { time += 5; throw original; } };
    };
    await assert.rejects(app.send('GET', '/private', undefined, 'secret'), (error) => error === original);
    app.fetch = async () => {
      time += 3;
      return { ok: false, status: 403, headers: new Headers(), text: async () => { time += 6; throw original; } };
    };
    await assert.rejects(app.send('POST', '/private', {}, 'secret'), (error) => error.github.status === 403);
    app.fetch = async () => { time += 1; return { ok: true, status: 200 }; };
    let guardCalls = 0;
    await assert.rejects(app.send('HEAD', '/private', undefined, 'secret', async () => {
      time += 100;
      if (++guardCalls === 2) throw original;
    }), (error) => error === original);
  });
  const summary = rows.find((row) => row.event === 'reconcile_request_summary');
  assert.equal(summary.attempts, 4);
  assert.equal(summary.latencyMs, 21);
  assert.deepEqual(summary.statusCounts, { none: 1, 200: 2, 403: 1 });
  assert.deepEqual(summary.outcomeCounts, { transport_error: 1, body_error: 2, guard_refused: 1 });
  assert.equal(/private|secret/u.test(JSON.stringify(rows)), false);
});

test('metrics count timed out fetch and body once without retries', async () => {
  const rows = []; let calls = 0;
  const app = new GitHubApp({ appId: 7, privateKey, timeoutMs: 5,
    fetchImpl: async (url, { signal }) => {
      calls++;
      const failOnAbort = () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      if (calls === 1) return failOnAbort();
      return { ok: true, status: 200, json: failOnAbort };
    } });
  const hold = setTimeout(() => {}, 1000);
  try {
    await withReconcileMetrics((row) => rows.push(row), async () => {
      await assert.rejects(app.send('POST', '/private', {}, 'secret'), /^Error: github_timeout$/u);
      await assert.rejects(app.send('GET', '/private', undefined, 'secret'), /^Error: github_timeout$/u);
    });
  } finally { clearTimeout(hold); }
  assert.equal(calls, 2);
  const summary = rows.find((row) => row.event === 'reconcile_request_summary');
  assert.equal(summary.attempts, 2);
  assert.equal(summary.retries, 0);
  assert.deepEqual(summary.statusCounts, { none: 1, 200: 1 });
  assert.deepEqual(summary.outcomeCounts, { timeout: 2 });
});

test('overlapping app requests isolate PR roots and exclude independent background requests', async () => {
  const rowsA = []; const rowsB = []; const releases = new Map(); let calls = 0, allStarted;
  const started = new Promise(resolve => { allStarted = resolve; });
  const app = new GitHubApp({ appId: 7, privateKey, fetchImpl: async (url) => {
    calls++;
    const held = new Promise((resolve) => releases.set(url, resolve));
    if (calls === 3) allStarted();
    await held;
    return new Response(null, { status: 204 });
  } });
  const requestA = withReconcileMetrics((row) => rowsA.push(row), () => withRequestPhase('review', 11,
    () => app.send('DELETE', '/a', undefined, 'secret')));
  const requestB = withReconcileMetrics((row) => rowsB.push(row), () => withRequestPhase('status', 22,
    () => app.send('PATCH', '/b', {}, 'secret')));
  const background = withoutRequestMetrics(() => app.send('HEAD', '/background', undefined, 'secret'));
  await started;
  releases.get('https://api.github.com/b')();
  await requestB;
  assert.equal(rowsA.length, 0);
  releases.get('https://api.github.com/background')();
  await background;
  releases.get('https://api.github.com/a')();
  await requestA;
  assert.equal(rowsA[0].pr, 11);
  assert.equal(rowsB[0].pr, 22);
  for (const rows of [rowsA, rowsB]) {
    const summary = rows.find((row) => row.event === 'reconcile_request_summary');
    assert.equal(summary.attempts, 1);
    assert.equal(summary.logicalCalls, 1);
    assert.deepEqual(summary.statusCounts, { 204: 1 });
  }
});

test('durable budget refusal counts no wire attempt, preserves merge reserve and reruns stale guards at due time', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = 1000000, calls = 0, stale = false;
  const budget = new GitHubBudget({ store, scope: '7:owner/repo', now: () => now,
    limits: { presentation: { charge: 1, wire: 1 } } });
  const app = new GitHubApp({ appId: 7, privateKey, now: () => now, budget,
    fetchImpl: async () => { calls++; return new Response('{}'); } });
  await withGitHubPriority('presentation', () => app.send('GET', '/fixture', undefined, 'token'));
  const rows = [];
  let due;
  await withReconcileMetrics(row => rows.push(row), () => withGitHubPriority('presentation', async () => {
    await assert.rejects(app.send('GET', '/fixture', undefined, 'token'), error => {
      assert.equal(error.code, 'github_budget_deferred'); assert.equal(error.priority, 'presentation');
      assert.ok(error.retryAt > now); due = error.retryAt; return true;
    });
  }));
  assert.equal(rows.find(row => row.event === 'reconcile_request_summary').attempts, 0);
  assert.equal(app.retryAt, 0);
  assert.equal(calls, 1);
  await withGitHubPriority('merge', () => app.send('POST', '/fixture', {}, 'token'));
  assert.equal(calls, 2);
  now = due; stale = true;
  await assert.rejects(withGitHubPriority('presentation', () => app.send('GET', '/fixture', undefined, 'token',
    async () => { if (stale) throw new Error('stale head'); })), /stale head/u);
  assert.equal(calls, 2, 'expired budget does not bypass the authority guard');
});

test('every retry is charged, authenticated informational 304 refunds charge only, authority stays unconditional', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const budget = new GitHubBudget({ store, scope: '7:owner/repo', now: () => 1000000 });
  const requests = []; let first = true;
  const app = new GitHubApp({ appId: 7, privateKey, repo: 'owner/repo', budget, now: () => 1000000, sleep: async () => {},
    fetchImpl: async (url, options) => {
      requests.push(options);
      if (first) { first = false; return new Response('unavailable', { status: 503 }); }
      return options.headers['If-None-Match']
        ? new Response(null, { status: 304 })
        : new Response('{"id":1}', { headers: { etag: '"fixture"' } });
    } });
  app.cachedToken = { token: 'token', expiresAt: 4600000, installationId: 42 };
  const options = { informational: true, headSha: 'a'.repeat(40), pr: 1 };
  assert.deepEqual(await app.request('GET', '/fixture', undefined, undefined, options), { id: 1 });
  assert.deepEqual(await app.request('GET', '/fixture', undefined, undefined, options), { id: 1 });
  assert.deepEqual(budget.snapshot().byClass.presentation, { primaryCharges: 2, wireAttempts: 3 });
  await app.request('GET', '/fixture');
  assert.equal(requests.at(-1).headers['If-None-Match'], undefined);
  assert.deepEqual(budget.snapshot().byClass.review, { primaryCharges: 1, wireAttempts: 1 });
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 3, wireAttempts: 4 });
});

test('token acquisition inherits explicit priority and informational default priority', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const priority of ['presentation', 'merge']) {
    const budget = new GitHubBudget({ store, scope: `7:owner/${priority}`, now: () => 1000000 });
    const app = new GitHubApp({ appId: 7, privateKey, repo: 'owner/repo', budget, now: () => 1000000,
      fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/installation') ? { id: 42 }
        : url.endsWith('/access_tokens') ? { token: 'token', expires_at: new Date(4600000).toISOString() } : { ok: true })) });
    const request = () => app.request('GET', '/fixture', undefined, undefined, { informational: true });
    if (priority === 'merge') await withGitHubPriority('merge', request); else await request();
    assert.deepEqual(budget.snapshot().byClass[priority], { primaryCharges: 3, wireAttempts: 3 });
    assert.deepEqual(budget.snapshot().total, { primaryCharges: 3, wireAttempts: 3 });
  }
});

test('real server primary-rate response blocks every priority before budget admission', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const budget = new GitHubBudget({ store, scope: '7:owner/repo', now: () => 1000000 });
  let calls = 0;
  const app = new GitHubApp({ appId: 7, privateKey, budget, now: () => 1000000,
    fetchImpl: async () => { calls++; return new Response('rate limit', { status: 429,
      headers: { 'retry-after': '3', 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1002' } }); } });
  await assert.rejects(app.send('GET', '/fixture', undefined, 'token'), error => error.code === 'github_rate_limited');
  for (const priority of ['presentation', 'review', 'merge']) {
    await assert.rejects(withGitHubPriority(priority, () => app.send('POST', '/fixture', {}, 'token')),
      error => error.code === 'github_rate_limited' && error.retryAt === 1003000);
  }
  assert.equal(calls, 1);
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 1, wireAttempts: 1 });
});

test('accepted POST receipt survives settlement fault; later dispatch fails closed without secret diagnostics', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const ledger = new GitHubBudget({ store, scope: '7:owner/repo', now: () => 1000000 });
  const logs = []; let calls = 0;
  const app = new GitHubApp({ appId: 7, privateKey, now: () => 1000000, log: row => logs.push(row),
    budget: { reserve: priority => ledger.reserve(priority), settle: () => { throw new Error('private-secret-raw-record'); } },
    fetchImpl: async () => { calls++; return new Response('{"id":123,"accepted":true}', { status: 201 }); } });
  assert.deepEqual(await app.send('POST', '/fixture', {}, 'token'), { id: 123, accepted: true });
  await assert.rejects(withGitHubPriority('merge', () => app.send('POST', '/fixture', {}, 'token')),
    error => error.code === 'github_budget_deferred' && error.reason === 'github_budget_accounting_unavailable');
  assert.equal(calls, 1);
  assert.deepEqual(ledger.snapshot().total, { primaryCharges: 1, wireAttempts: 1 });
  assert.equal(ledger.snapshot().pendingReservations, 1);
  assert.deepEqual(logs, [{ event: 'github_budget_accounting_failed', reason: 'settlement_failed' }]);
});

test('transport failure retains its charge and original error without retry', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const budget = new GitHubBudget({ store, scope: '7:owner/repo', now: () => 1000000 });
  const original = new Error('transport failed'); let calls = 0;
  const app = new GitHubApp({ appId: 7, privateKey, budget,
    fetchImpl: async () => { calls++; throw original; } });
  await assert.rejects(app.send('POST', '/fixture', {}, 'token'), error => error === original);
  assert.equal(calls, 1);
  assert.deepEqual(budget.snapshot().total, { primaryCharges: 1, wireAttempts: 1 });
  assert.equal(budget.snapshot().pendingReservations, 0);
});

test('known-no-dispatch provenance is exact and recorded only after the send fence', async () => {
  const error = Object.assign(new Error('local budget'), { code: 'github_budget_deferred', retryAt: 2000 });
  const events = [];
  const app = new GitHubApp({ appId: 7, privateKey,
    budget: { reserve() { events.push('reserve'); throw error; } },
    fetchImpl: async () => { assert.fail('unsent request cannot fetch'); } });
  await assert.rejects(app.send('POST', '/check-runs', {}, 'token', async phase => events.push(phase)),
    thrown => {
      assert.equal(thrown, error);
      assert.equal(githubRequestNotDispatched(thrown, 'POST', '/check-runs'), true);
      assert.equal(githubRequestNotDispatched(thrown, 'PATCH', '/check-runs'), false);
      assert.equal(githubRequestNotDispatched(thrown, 'POST', '/other'), false);
      return true;
    });
  assert.deepEqual(events, ['before_send', 'reserve']);
  assert.equal(githubRequestNotDispatched({ code: error.code }, 'POST', '/check-runs'), false);
});

test('an earlier attempted PATCH followed by local budget refusal remains uncertain', async () => {
  let reservations = 0, calls = 0;
  const app = new GitHubApp({ appId: 7, privateKey, sleep: async () => {},
    budget: { reserve() {
      if (++reservations === 2) throw Object.assign(new Error('local budget'), { code: 'github_budget_deferred' });
    }, settle() {} },
    fetchImpl: async () => { calls++; return new Response('unavailable', { status: 503 }); } });
  await assert.rejects(app.send('PATCH', '/check-runs/1', {}, 'token'), error => {
    assert.equal(error.code, 'github_budget_deferred');
    assert.equal(githubRequestNotDispatched(error, 'PATCH', '/check-runs/1'), false);
    return true;
  });
  assert.equal(calls, 1);
});

for (const accepted of [false, true]) test(`nested read refusal cannot describe an ${accepted ? 'accepted' : 'unsent'} outer mutation`, async () => {
  let calls = 0;
  const app = new GitHubApp({ appId: 7, privateKey,
    budget: { reserve() {
      if (!accepted || calls) throw Object.assign(new Error('local budget'), { code: 'github_budget_deferred' });
    }, settle() {} },
    fetchImpl: async () => { calls++; return new Response('{}'); } });
  await assert.rejects(app.send('PUT', '/merge', {}, 'token', async phase => {
    if ((phase === 'before_send') !== accepted) await app.send('GET', '/authority', undefined, 'token');
  }), error => {
    assert.equal(githubRequestNotDispatched(error, 'GET', '/authority'), true);
    assert.equal(githubRequestNotDispatched(error, 'PUT', '/merge'), false);
    return true;
  });
  assert.equal(calls, accepted ? 1 : 0);
});

test('a nested same-endpoint refusal and a reused transport error cannot claim outer no-dispatch', async () => {
  const error = Object.assign(new Error('local budget'), { code: 'github_budget_deferred' });
  let refuse = true;
  const app = new GitHubApp({ appId: 7, privateKey,
    budget: { reserve() { if (refuse) throw error; }, settle() {} },
    fetchImpl: async () => { throw error; } });
  await assert.rejects(app.send('POST', '/mutation', {}, 'token', async () => {
    await app.send('POST', '/mutation', {}, 'token');
  }));
  assert.equal(githubRequestNotDispatched(error, 'POST', '/mutation'), false);
  await assert.rejects(app.send('POST', '/mutation', {}, 'token'));
  assert.equal(githubRequestNotDispatched(error, 'POST', '/mutation'), true);
  refuse = false;
  await assert.rejects(app.send('POST', '/mutation', {}, 'token'));
  assert.equal(githubRequestNotDispatched(error, 'POST', '/mutation'), false);
});
