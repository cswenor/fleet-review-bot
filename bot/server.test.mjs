import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Scheduler } from './scheduler.mjs';
import { admitStartupMode, createAdmission, createWebhookServer, mergeBatchConfig } from './server.mjs';
import { readSelectionDrainRequest } from './merge-drain.mjs';
import { GitHubBudget, withGitHubPriority } from './github-budget.mjs';
import { GitHubApp } from './github-app.mjs';
import { REVIEW_APP_ID, REPOSITORY } from './identity.mjs';
const invoke = (server, method, url, body, headers = {}) => new Promise((done) => {
  const req = Readable.from(body ? [Buffer.from(body)] : []); Object.assign(req, { method, url, headers });
  let status;
  server.emit('request', req, { writeHead: (value) => { status = value; }, end: (value) => done({ status, body: JSON.parse(value) }) });
});

test('production CLI off startup drains canonical cancellation without execution dependencies', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-off-cli-'));
  const clock = join(root, 'clock'), preload = join(root, 'preload.mjs');
  const initialNow = 1000000, retryAt = initialNow + 2000;
  const revision = 'ef5989423242b25789384ea1899d32a86f4c654f';
  let dependenciesDown = false;
  const requests = [], patches = [], unexpected = [];
  let child, output = '', exited = false;
  const setClock = async (now) => {
    // The child must never observe writeFile's transient empty/truncated clock.
    await writeFile(clock + '.next', String(now));
    await rename(clock + '.next', clock);
  };
  const stopChild = async () => {
    if (!child || exited) return;
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
    try { await stopped; } finally { clearTimeout(kill); }
  };
  const store = new Store(join(root, 'bot.sqlite'));
  const enqueue = (pr, head) => store.enqueue({ pr, head_sha: head.repeat(40), base_ref: 'main', due: initialNow, reason: 'opened' }, initialNow);
  const immediate = enqueue(1, 'c'), delayed = enqueue(2, 'd');
  for (const [row, check, due] of [[immediate, 901, 0], [delayed, 902, retryAt]]) {
    store.update(row.id, { status: 'cancelled', reason: 'closed', conclusion: 'cancelled', finished_at: initialNow,
      check_run_id: check, result_json: JSON.stringify({ cancellation_terminal_pending: { retry_at: due } }) });
  }
  const newer = enqueue(1, 'e');
  store.update(newer.id, { check_run_id: 903 });
  store.close();
  const remote = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const path = new URL(req.url, 'http://fixture').pathname;
    requests.push({ method: req.method, path });
    let text = ''; for await (const part of req) text += part;
    if (req.method === 'GET' && path === '/repos/example-org/example-project/installation') { res.end('{"id":42}'); return; }
    if (req.method === 'POST' && path === '/app/installations/42/access_tokens') {
      res.end(JSON.stringify({ token: 'fixture-only-token', expires_at: new Date(initialNow + 3600000).toISOString() })); return;
    }
    if (req.method === 'GET' && ['/runner/health', '/gateway/healthz'].includes(path)) {
      res.writeHead(dependenciesDown ? 503 : 200); res.end('{}'); return;
    }
    const check = /^\/repos\/example-org\/example-project\/check-runs\/(901|902)$/.exec(path);
    if (req.method === 'PATCH' && check) {
      patches.push({ id: Number(check[1]), ...JSON.parse(text) }); res.end(JSON.stringify({ id: Number(check[1]) })); return;
    }
    unexpected.push(`${req.method} ${path}`); res.writeHead(500); res.end('{"message":"unexpected fixture request"}');
  });
  try {
    await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
    const fixture = `http://127.0.0.1:${remote.address().port}`;
    await setClock(initialNow);
    // Test-only transport/clock injection, not a replacement entrypoint or scheduler.
    // The actual CLI constructs GitHubApp, Publisher, Store and Scheduler itself.
    await writeFile(preload, `
      import {readFileSync} from 'node:fs';
      import {Scheduler} from ${JSON.stringify(new URL('./scheduler.mjs', import.meta.url).href)};
      const tickNow=Scheduler.prototype.tickNow;
      Scheduler.prototype.tickNow=async function(...args){
        if(Date.now()===${retryAt + 2}){
          const cause=Object.assign(new TypeError('private response body'),{code:'ECONNRESET',private_key:'private value'});
          throw Object.assign(new Error('private timer message',{cause}),{code:'private code'});
        }
        return tickNow.apply(this,args);
      };
      Date.now=()=>Number(readFileSync(process.env.FIXTURE_CLOCK,'utf8'));
      const originalFetch=globalThis.fetch;
      globalThis.fetch=(input,options)=>{
        const url=new URL(input), fixture=new URL(process.env.FIXTURE_HTTP);
        if(url.hostname==='api.github.com') return originalFetch(fixture.origin+url.pathname+url.search,{...options,redirect:'error'});
        if(url.origin===fixture.origin&&['/runner/health','/gateway/healthz'].includes(url.pathname)) return originalFetch(input,options);
        console.error('Forbidden nonfixture or execution fetch '+url);
        throw new Error('Forbidden nonfixture or execution fetch '+url);
      };
      const interval=globalThis.setInterval;
      globalThis.setInterval=(callback,delay,...args)=>interval(callback,delay===5000?20:delay,...args);
    `);
    // Reserve a local port, then release it immediately before the real CLI binds.
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const encodedKey = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    child = spawn(process.execPath, ['--import', preload, fileURLToPath(new URL('./server.mjs', import.meta.url))], {
      env: { PATH: process.env.PATH, REVIEW_BOT_MODE: 'off', STATE_ROOT: root, WORK_ROOT: join(root, 'work'),
        GITHUB_REPOSITORY: 'example-org/example-project', GITHUB_APP_ID: '123',
        REVIEW_BOT_USER_ID: '124', REVIEW_BOT_LOGIN: 'fixture-review[bot]',
        BUILDER_BOT_USER_ID: '125', BUILDER_BOT_LOGIN: 'fixture-builder[bot]',
        REVIEW_APPROVERS: 'fixture-approver:126',
        SESSIONS_ROOT: join(root, 'sessions'), PORT: String(port), GITHUB_WEBHOOK_SECRET: 'fixture-secret',
        OMP_GATEWAY_TOKEN: 'fixture-gateway-token', GITHUB_APP_PRIVATE_KEY_B64: encodedKey,
        IMAGE_REVISION: revision,
        RUNNER_URL: fixture + '/runner', GATEWAY_URL: fixture + '/gateway', FIXTURE_HTTP: fixture, FIXTURE_CLOCK: clock },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', () => { exited = true; });
    child.on('error', error => { output += error.stack; exited = true; });
    const waitFor = async (probe, description) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        assert.equal(exited, false, `CLI exited before ${description}:\n${output}`);
        if (await probe()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`CLI timed out waiting for ${description}:\n${output}`);
    };
    let ready;
    await waitFor(async () => {
      try { ready = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(500) }); return ready.status === 200; }
      catch { return false; }
    }, 'production entrypoint ready 200');
    assert.deepEqual(await ready.json(), { ok: true, revision });
    let health;
    await waitFor(async () => {
      try { health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }); return health.status === 200; }
      catch { return false; }
    }, 'listening health 200');
    const initialHealth = await health.json();
    assert.equal(initialHealth.mode, 'off');
    assert.equal(initialHealth.githubBudget.state, 'ok', 'actual CLI supplies durable budget to ReviewApp');
    assert.ok(initialHealth.githubBudget.total.wireAttempts >= 3, 'auth and canonical PATCH are metered');
    dependenciesDown = true;
    const unhealthy = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    assert.equal(unhealthy.status, 503);
    const unhealthyBody = await unhealthy.json();
    assert.equal(unhealthyBody.runner, 'down'); assert.equal(unhealthyBody.gateway, 'down');
    const stillReady = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(500) });
    assert.equal(stillReady.status, 200);
    assert.deepEqual(await stillReady.json(), { ok: true, revision });
    dependenciesDown = false;
    assert.deepEqual(patches.map(patch => patch.id), [901], 'already-due canonical terminal must settle during actual CLI recovery');
    await setClock(retryAt - 1);
    // Observe several real production timer callbacks at the still-frozen clock.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(patches.map(patch => patch.id), [901], 'persisted deadline must prevent early HTTP');
    await setClock(retryAt + 1);
    await waitFor(() => patches.length === 2, 'off-mode timer terminal settlement');
    assert.deepEqual(patches.map(patch => patch.id), [901, 902]);
    for (const patch of patches) {
      assert.equal(patch.status, 'completed'); assert.equal(patch.conclusion, 'cancelled');
      assert.equal(patch.output.summary, 'closed');
    }
    assert.deepEqual(unexpected, [], 'no execution/model/approval or newer-check requests');
    assert.equal(output.includes('Forbidden nonfixture or execution fetch'), false, output);
    await waitFor(async () => {
      const settled = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      return (await settled.json()).lastTickCompletedAt === retryAt + 1;
    }, 'production timer committed terminal settlement');
    await setClock(retryAt + 2);
    await waitFor(() => output.includes('"scheduler_tick_failed"'), 'production timer safe failure diagnostic');
    const diagnostics = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      .filter(row => row.event === 'scheduler_tick_failed');
    assert.ok(diagnostics.length > 0);
    for (const { at, ...diagnostic } of diagnostics) assert.deepEqual(diagnostic, {
      event: 'scheduler_tick_failed', stage: 'maintenance',
      cause: { constructor: 'Error', cause: { constructor: 'TypeError', code: 'ECONNRESET' } },
    });
    assert.equal(output.includes('private response body'), false);
    assert.equal(output.includes('private timer message'), false);
    assert.equal(output.includes('private_key'), false);
    await setClock(retryAt + 1);
    // A restart inspection must not run Store migrations against a live writer.
    await stopChild();
    const reopened = new Store(join(root, 'bot.sqlite'));
    try {
      assert.equal(reopened.review(immediate.id).check_run_id, 901);
      assert.equal(reopened.review(delayed.id).check_run_id, 902);
      assert.equal(reopened.review(newer.id).check_run_id, 903);
      assert.equal(reopened.review(newer.id).status, 'queued');
      assert.equal(reopened.all('SELECT id FROM reviews').length, 3);
      const budget = new GitHubBudget({ store: reopened, scope: '123:example-org/example-project', now: () => retryAt + 1 });
      const githubRequests = requests.filter(row => !['/runner/health', '/gateway/healthz'].includes(row.path));
      assert.deepEqual(budget.snapshot().total, { primaryCharges: githubRequests.length, wireAttempts: githubRequests.length },
        'real entrypoint persists every canonical ReviewApp wire attempt in its exact scope');
    } finally { reopened.close(); }
    console.log(JSON.stringify({ productionCLI: true, mode: 'off', health: 200, canonicalChecks: patches.map(p => p.id),
      newerCheckUntouched: 903, retryAt, noEarlyHTTP: true, executionOrModelRequests: unexpected, requests }));
  } finally {
    await stopChild();
    await new Promise(resolve => remote.close(resolve));
    await rm(root, { recursive: true });
  }
});

test('real health exposes rolling per-class SQLite usage and refunds without spending, and faults never report zero', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const now = 1000000;
  const budget = new GitHubBudget({ store, scope: `${REVIEW_APP_ID}:${REPOSITORY}`, now: () => now,
    limits: { presentation: { charge: 2, wire: 2 } } });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const github = new GitHubApp({ appId: REVIEW_APP_ID, repo: REPOSITORY,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), budget, now: () => now,
    fetchImpl: async (url, options) => options.headers['If-None-Match']
      ? new Response(null, { status: 304 }) : new Response('{"id":1}', { headers: { etag: '"fixture"' } }) });
  github.cachedToken = { token: 'fixture-token', installationId: 42, expiresAt: now + 3600000 };
  const options = { informational: true, headSha: 'a'.repeat(40), pr: 1 };
  await github.request('GET', '/fixture', undefined, undefined, options);
  await github.request('GET', '/fixture', undefined, undefined, options);
  await github.request('GET', '/fixture');
  await withGitHubPriority('merge', () => github.request('POST', '/fixture', {}));
  await assert.rejects(github.request('GET', '/fixture', undefined, undefined, options),
    error => error.code === 'github_budget_deferred' && error.priority === 'presentation');
  const scheduler = { github, lastTickCompletedAt: now, lastReconcileOkAt: now };
  const server = createWebhookServer({ store, scheduler, secret: 'fixture-secret', now: () => now,
    revision: 'a'.repeat(40), fetchImpl: async () => ({ ok: true }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const before = store.get('SELECT record_json FROM github_budget WHERE scope=?', `${REVIEW_APP_ID}:${REPOSITORY}`).record_json;
  for (let read = 0; read < 2; read++) {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.githubBudget.state, 'ok');
    assert.deepEqual(health.githubBudget.total, { primaryCharges: 3, wireAttempts: 4 });
    assert.deepEqual(health.githubBudget.byClass, {
      presentation: { primaryCharges: 1, wireAttempts: 2 },
      review: { primaryCharges: 1, wireAttempts: 1 },
      merge: { primaryCharges: 1, wireAttempts: 1 },
    });
  }
  assert.equal(store.get('SELECT record_json FROM github_budget WHERE scope=?', `${REVIEW_APP_ID}:${REPOSITORY}`).record_json, before,
    'health reads neither reserve nor rewrite the durable ledger');
  store.db.prepare('UPDATE github_budget SET record_json=? WHERE scope=?').run('{"private-secret":"corrupt"}', `${REVIEW_APP_ID}:${REPOSITORY}`);
  const failed = await fetch(`${url}/health`);
  assert.equal(failed.status, 503);
  const body = await failed.json();
  assert.deepEqual(body.githubBudget, { state: 'fault', reason: 'github_budget_accounting_unavailable' });
  assert.equal(JSON.stringify(body).includes('private-secret'), false);
  assert.equal((await fetch(`${url}/ready`)).status, 200, 'ledger health is not local deployment readiness');
});
test('merge batch config defaults to five and bounds collection seconds from zero through nine hundred', () => {
  assert.deepEqual(mergeBatchConfig({}), { batchEnabled: false, batchMaxSize: 5, batchCollectSeconds: 180 });
  for (const seconds of [0, 1, 180, 900]) {
    const config = mergeBatchConfig({ MERGE_BATCH_ENABLED: 'true', MERGE_BATCH_COLLECT_SECONDS: String(seconds) });
    assert.equal(config.batchEnabled, true);
    assert.equal(config.batchCollectSeconds, seconds);
    const scheduler = new Scheduler({ now: () => 1000, ...config });
    assert.equal(scheduler.batchLane.collectSeconds, seconds);
    assert.equal(scheduler.batchLane.maxSize, 5);
  }
  for (const seconds of ['-1', '901', '0.5', 'NaN', 'Infinity', 'invalid']) {
    assert.throws(() => mergeBatchConfig({ MERGE_BATCH_COLLECT_SECONDS: seconds }), /MERGE_BATCH_COLLECT_SECONDS/u);
  }
  assert.throws(() => mergeBatchConfig({ MERGE_BATCH_MAX_SIZE: '6' }), /batch limit/u);
});

test('off mode still authenticates, deduplicates and serves health without scheduling', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-server-')); const store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const events = [];
  const scheduler = { lastReconcileAt: 0, lastTickCompletedAt: Date.now(), handle: async () => { throw new Error('off must not schedule'); } };
  const secret = 'fixture-webhook-secret';
  const server = createWebhookServer({ store, scheduler, secret, mode: 'off', fetchImpl: async () => ({ ok: true }), log: (event) => events.push(event) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).revision, null);
  assert.equal((await invoke(server, 'POST', '/github', '{}')).status, 401);
  const body = JSON.stringify({ repository: { full_name: 'example-org/example-project' } });
  const headers = { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    'x-github-delivery': 'fixture-delivery', 'x-github-event': 'ping' };
  assert.equal((await invoke(server, 'POST', '/github', body, headers)).status, 202);
  assert.equal((await invoke(server, 'POST', '/github', body, headers)).status, 200);
  assert.equal((await invoke(server, 'GET', '/x')).status, 404);
  assert.equal(store.counts().queued, 0);
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test('ready stays local while strict health reports reconciliation, backlog, publication and dependency failures', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-ready-')), store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const now = 4000000, revision = 'ef5989423242b25789384ea1899d32a86f4c654f';
  store.enqueue({ pr: 1, head_sha: 'a'.repeat(40), base_ref: 'main', due: now, reason: 'opened' }, now);
  const publicationFailures = [{ reviewId: 1, reason: 'fixture publication unavailable' }];
  const mergeFailures = [{ reason: 'fixture merge unavailable' }];
  const scheduler = { startedAt: 1, lastTickCompletedAt: 1, lastReconcileOkAt: 1,
    lastReconcileAt: now, publicationFailures: () => publicationFailures,
    batchLane: { failures: () => mergeFailures } };
  let probes = 0;
  const server = createWebhookServer({ store, scheduler, revision, secret: 'fixture-secret', now: () => now,
    modeDegraded: 'approve→advisory', fetchImpl: async () => { probes++; throw new Error('offline'); } });
  assert.deepEqual(await invoke(server, 'GET', '/ready'), { status: 503, body: { ok: false, revision } },
    'not ready before listening');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const ready = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1000) });
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, revision });
  assert.equal(probes, 0, 'ready must not probe dependencies');
  const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
  assert.equal(health.status, 503);
  const body = await health.json();
  assert.equal(body.ok, false); assert.equal(body.revision, revision);
  assert.equal(body.runner, 'down'); assert.equal(body.gateway, 'down'); assert.equal(probes, 2);
  assert.equal(body.queued, 1); assert.equal(body.lastTickCompletedAt, 1);
  assert.equal(body.lastReconcileOkAt, 1); assert.equal(body.mode_degraded, 'approve→advisory');
  assert.deepEqual(body.publicationFailures, publicationFailures); assert.deepEqual(body.mergeFailures, mergeFailures);
  assert.equal((await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1000) })).status, 200);
  assert.equal(probes, 2);
  assert.equal((await fetch(`${url}/ready`, { method: 'POST', signal: AbortSignal.timeout(1000) })).status, 404);
});

test('ready refuses unknown or malformed revisions and an unavailable actual SQLite store', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-ready-store-')), store = new Store(join(root, 'state.sqlite'));
  let closed = false;
  try {
    for (const revision of [null, '', 'a'.repeat(7), 'g'.repeat(40), 'a'.repeat(41), 'a'.repeat(40)]) {
      const server = createWebhookServer({ store, scheduler: {}, revision, secret: 'fixture-secret',
        fetchImpl: async () => assert.fail('ready must not fetch') });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`, { signal: AbortSignal.timeout(1000) });
        const known = revision === 'a'.repeat(40);
        assert.equal(response.status, known ? 200 : 503);
        assert.deepEqual(await response.json(), { ok: known, revision: known ? revision : null });
        if (known) {
          store.close(); closed = true;
          const unavailable = await fetch(`http://127.0.0.1:${server.address().port}/ready`, { signal: AbortSignal.timeout(1000) });
          assert.equal(unavailable.status, 503);
          assert.deepEqual(await unavailable.json(), { ok: false, revision });
        }
      } finally { await new Promise(resolve => server.close(resolve)); }
    }
  } finally { if (!closed) store.close(); await rm(root, { recursive: true }); }
});

test('ready refuses shutdown on an existing HTTP connection before the store closes', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-ready-shutdown-')), store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const revision = 'a'.repeat(40);
  const server = createWebhookServer({ store, scheduler: {}, revision, secret: 'fixture-secret',
    fetchImpl: async () => { entered.resolve(); await release.promise; return { ok: true }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = createConnection({ port: server.address().port, host: '127.0.0.1' });
  let output = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { output += chunk; });
  const ended = new Promise((resolve, reject) => { socket.once('end', resolve); socket.once('error', reject); });
  t.after(() => { release.resolve(); socket.destroy(); server.close(); });
  socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n');
  await entered.promise;
  const closed = new Promise(resolve => server.close(resolve));
  assert.equal(server.listening, false);
  assert.equal(store.get('SELECT count(*) AS n FROM deliveries').n, 0, 'store remains available during shutdown');
  server.on('request', req => { if (req.url === '/ready') release.resolve(); });
  socket.write('GET /ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  await ended;
  await closed;
  assert.equal((output.match(/HTTP\/1\.1 503/g) ?? []).length, 2, output);
  assert.ok(output.includes(JSON.stringify({ ok: false, revision })), output);
});

test('durably acknowledges a signed webhook while serialized processing is blocked', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-webhook-ack-')), store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const scheduler = new Scheduler({ store, github: { repo: 'example-org/example-project' } });
  const blocked = Promise.withResolvers();
  const blocking = scheduler.serialize(() => blocked.promise);
  const secret = 'fixture-webhook-secret';
  const server = createWebhookServer({ store, scheduler, secret });
  const body = JSON.stringify({ repository: { full_name: 'example-org/example-project' } });
  const headers = { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    'x-github-delivery': 'blocked-delivery', 'x-github-event': 'ping' };
  let acknowledged = false;
  const response = invoke(server, 'POST', '/github', body, headers).then((value) => {
    acknowledged = true; return value;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(acknowledged, true, 'durable receipt must not wait for the scheduler queue');
    assert.equal(store.get('SELECT state FROM deliveries WHERE id=?', 'blocked-delivery').state, 'received');
  } finally {
    blocked.resolve();
    await blocking;
    await scheduler.operations;
  }
  assert.equal((await response).status, 202);
  assert.equal(store.get('SELECT state FROM deliveries WHERE id=?', 'blocked-delivery').state, 'processed');
});

test('startup survives unavailable review priorities, accepts intake and retries queued work on a later tick', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-startup-refill-')), store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const now = 1000000, head = 'c'.repeat(40), secret = 'fixture-webhook-secret';
  let unavailable = true;
  const logs = [], prepared = [], jobs = [];
  const prs = [1, 2].map(number => ({
    number, state: 'open', draft: false, labels: [{ name: `merge-priority:${number === 2 ? 0 : 2}` }],
    head: { sha: head, repo: { full_name: 'example-org/example-project' } }, base: { ref: 'main' },
  }));
  const github = { repo: 'example-org/example-project',
    paginate: async (path) => {
      assert.equal(path, '/repos/example-org/example-project/pulls?state=open');
      if (unavailable) throw new Error(`discovery unavailable ${secret} private-response-body`);
      return prs;
    },
    request: async (method, path) => {
      assert.equal(method, 'GET');
      return prs.find(pr => path === `/repos/example-org/example-project/pulls/${pr.number}`);
    } };
  const scheduler = new Scheduler({ store, github, now: () => now, concurrency: 1,
    publisher: {
      queued: async row => store.update(row.id, { check_run_id: row.id + 10 }),
      started: async () => {},
    },
    mirror: { prepare: async row => { prepared.push(row.pr); return { base_sha: 'd'.repeat(40) }; } },
    fetchImpl: async (url, { method }) => { jobs.push({ url, method }); return { status: 202, ok: true }; },
    log: entry => logs.push(entry) });
  scheduler.lastReconcileAt = now;
  for (const pr of [1, 2]) store.enqueue({ pr, head_sha: head, base_ref: 'main', due: 0, reason: 'opened' }, pr);

  // Match the real entrypoint: recovery must return before HTTP and its timer can be installed.
  await scheduler.recover({ waitForPublications: false });
  await scheduler.operations;
  assert.deepEqual(logs, [{ event: 'recovery_refill_failed' }]);
  assert.equal(store.counts().queued, 2);
  assert.deepEqual(prepared, []);
  assert.deepEqual(jobs, []);
  const server = createWebhookServer({ store, scheduler, secret, now: () => now,
    fetchImpl: async () => ({ ok: true }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/health`)).status, 200);
  const body = JSON.stringify({ repository: { full_name: github.repo } });
  const response = await fetch(`${url}/github`, { method: 'POST', body, headers: {
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    'x-github-delivery': 'startup-refill-intake', 'x-github-event': 'ping',
  } });
  assert.equal(response.status, 202);
  await response.json();
  await scheduler.operations;
  assert.equal(store.get('SELECT state FROM deliveries WHERE id=?', 'startup-refill-intake').state, 'processed');
  assert.deepEqual(prepared, []);
  assert.deepEqual(jobs, []);

  // Invoke the installed timer's normal callback deterministically, without sleeping.
  unavailable = false;
  await scheduler.tick();
  assert.deepEqual(prepared, [2], 'fresh priority must win over older queued work');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].method, 'POST');
  assert.equal(store.active(2).status, 'running');
  assert.equal(store.active(1).status, 'queued');
});

test('failed dispatch leaves received work, redelivery retries it, processed redelivery dedupes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-redelivery-')); const store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  let failures = 1;
  const github = { repo: 'example-org/example-project', appId: 1001,
    paginate: async () => { if (failures-- > 0) throw new Error('transient'); return []; } };
  const scheduler = new Scheduler({ store, github });
  const secret = 'fixture-webhook-secret';
  const server = createWebhookServer({ store, scheduler, secret, fetchImpl: async () => ({ ok: true }) });
  const body = JSON.stringify({ repository: { full_name: github.repo }, action: 'rerequested', secret: 'must-not-persist',
    check_run: { app: { id: 1001 }, name: 'codex-review', head_sha: 'a'.repeat(40) },
    pull_request_body: 'untrusted content must not persist' });
  const headers = { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    'x-github-delivery': 'fixture-retry', 'x-github-event': 'check_run' };
  assert.equal((await invoke(server, 'POST', '/github', body, headers)).status, 202);
  await scheduler.operations;
  let receipt = store.get('SELECT * FROM deliveries WHERE id=?', 'fixture-retry');
  assert.equal(receipt.state, 'received'); assert.equal(receipt.attempts, 1);
  assert.equal(receipt.payload_json.includes('must-not-persist'), false);
  await invoke(server, 'POST', '/github', body, headers);
  await scheduler.operations;
  assert.equal((await invoke(server, 'POST', '/github', body, headers)).status, 200);
  receipt = store.get('SELECT * FROM deliveries WHERE id=?', 'fixture-retry');
  assert.equal(receipt.state, 'processed'); assert.equal(receipt.attempts, 2);
});

test('webhook failures log a bounded redacted error cause, never credentials or payload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-webhook-cause-')), store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const secret = 'fixture-webhook-secret', token = 'fixture-service-token', logs = [], failed = Promise.withResolvers();
  const scheduler = { processDelivery: async () => { throw new TypeError(`lookup failed ${secret} ${token} ${'x'.repeat(2000)}`); } };
  const server = createWebhookServer({ store, scheduler, secret, secrets: [token], log: (entry) => {
    logs.push(entry); if (entry.event === 'webhook_failed') failed.resolve(entry.cause);
  } });
  const body = JSON.stringify({ repository: { full_name: 'example-org/example-project' }, private_body: 'payload-not-for-logs' });
  const headers = { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    'x-github-delivery': 'cause-fixture', 'x-github-event': 'ping' };
  await invoke(server, 'POST', '/github', body, headers);
  const cause = await failed.promise;
  assert.equal(cause.name, 'TypeError');
  assert.match(cause.message, /^lookup failed \[redacted\] \[redacted\]/);
  assert.ok(cause.message.length <= 1000);
  assert.ok(!JSON.stringify(logs).includes('payload-not-for-logs'));
});

test('scheduler progress older than five minutes makes health fail even with healthy dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-liveness-')); const store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  let now = 1000000;
  const scheduler = new Scheduler({ store, mode: 'off', now: () => now });
  const revision = 'a'.repeat(40);
  const server = createWebhookServer({ store, scheduler, revision, secret: 'fixture-secret', now: () => now,
    fetchImpl: async () => ({ ok: true }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    return { status: response.status, body: await response.json() };
  };
  const healthy = await health();
  assert.equal(healthy.status, 200); assert.equal(healthy.body.revision, revision);
  now += 300001;
  const stale = await health();
  assert.equal(stale.status, 503); assert.equal(stale.body.ok, false);
  assert.equal(stale.body.revision, revision);
  await scheduler.tick();
  assert.equal((await health()).status, 200);
});

test('enumeration failures expire reconciliation health after thirty minutes despite live ticks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reconcile-health-')), store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  let now = 1000000;
  const github = { repo: 'example-org/example-project', paginate: async () => [] };
  const scheduler = new Scheduler({ store, github, now: () => now });
  const revision = 'ef5989423242b25789384ea1899d32a86f4c654f';
  const server = createWebhookServer({ store, scheduler, revision, secret: 'fixture-secret', now: () => now,
    fetchImpl: async () => ({ ok: true }) });
  await scheduler.reconcile();
  assert.equal(scheduler.lastReconcileOkAt, now);
  const healthy = await invoke(server, 'GET', '/health');
  assert.equal(healthy.status, 200); assert.equal(healthy.body.lastReconcileOkAt, now);
  github.paginate = async () => { throw new Error('Fixture enumeration failure'); };
  now += 1800001; scheduler.lastTickCompletedAt = now;
  await scheduler.reconcile();
  const unhealthy = await invoke(server, 'GET', '/health');
  assert.equal(unhealthy.status, 503); assert.equal(unhealthy.body.lastReconcileOkAt, 1000000);
  assert.equal(unhealthy.body.lastReconcileAt, now); assert.equal(unhealthy.body.lastReconcileCounts.failed, 1);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  github.paginate = async () => { entered.resolve(); await release.promise; return []; };
  const reconciling = scheduler.reconcile();
  try {
    await entered.promise;
    const url = `http://127.0.0.1:${server.address().port}`;
    const ready = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1000) });
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true, revision });
    const stillUnhealthy = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    assert.equal(stillUnhealthy.status, 503, 'in-flight reconciliation must not erase operational failure');
    assert.equal((await stillUnhealthy.json()).lastReconcileOkAt, 1000000);
  } finally { release.resolve(); await reconciling; }
});

test('approve startup requires hosted judge credentials and working reviewer OAuth', async () => {
  const readyChecks = { credentials: [{ provider: 'openai-codex', type: 'oauth', ok: true }] };
  const check = (checks, judgeToken = 'fixture-judge-token', ok = true) => admitStartupMode({
    mode: 'approve', token: 'fixture-token', judgeToken, gatewayUrl: 'http://gateway:4000',
    fetchImpl: async () => ({ ok, json: async () => checks }),
  });
  assert.deepEqual(await check(readyChecks), { mode: 'approve', modeDegraded: null });
  const degraded = { mode: 'advisory', modeDegraded: 'approve→advisory' };
  for (const judgeToken of ['', 'has whitespace', null]) assert.deepEqual(await check(readyChecks, judgeToken), degraded);
  for (const checks of [{ credentials: [] }, {}, { credentials: [{ provider: 'openai-codex', type: 'oauth', ok: null }] },
    { credentials: [{ provider: 'openai-codex', type: 'api_key', ok: true }] },
    { credentials: [{ provider: 'openai-codex', type: 'oauth', ok: false }] }]) {
    assert.deepEqual(await check(checks), degraded);
  }
  assert.deepEqual(await check(readyChecks, 'fixture-judge-token', false), degraded);
  assert.deepEqual(await admitStartupMode({ mode: 'approve', judgeToken: 'fixture-judge-token',
    fetchImpl: async () => { throw new Error('offline'); } }), degraded);
  for (const mode of ['off', 'advisory']) {
    assert.deepEqual(await admitStartupMode({ mode, fetchImpl: async () => { assert.fail('no admission call'); } }),
      { mode, modeDegraded: null });
  }
});

test('degraded approve startup exposes advisory mode but unhealthy readiness', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-degraded-')), store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const scheduler = { lastTickCompletedAt: Date.now(), startedAt: Date.now() };
  const server = createWebhookServer({ store, scheduler, secret: 'fixture-secret', mode: 'advisory',
    modeDegraded: 'approve→advisory', fetchImpl: async () => ({ ok: true }) });
  const result = await invoke(server, 'GET', '/health');
  assert.equal(result.status, 503); assert.equal(result.body.ok, false);
  assert.equal(result.body.mode, 'advisory'); assert.equal(result.body.mode_degraded, 'approve→advisory');
});

test('approve admission refreshes once per 60 seconds and health follows recovery and loss', async (t) => {
  let now = 1000000, ready = false, calls = 0;
  const admission = createAdmission({ mode: 'approve', now: () => now, token: 'fixture-token', judgeToken: 'fixture-judge-token',
    gatewayUrl: 'http://gateway:4000', fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ credentials: [{ provider: 'openai-codex', type: 'oauth', ok: ready }] }) };
    } });
  await Promise.all([admission.refresh(), admission.refresh()]);
  assert.equal(calls, 1); assert.equal(admission.state.mode, 'advisory');
  const root = await mkdtemp(join(tmpdir(), 'review-admission-')), store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const scheduler = { lastTickCompletedAt: now, startedAt: now };
  const server = createWebhookServer({ store, scheduler, admission, secret: 'fixture-secret',
    mode: 'approve', now: () => now, fetchImpl: async () => ({ ok: true }) });
  assert.equal((await invoke(server, 'GET', '/health')).status, 503);
  ready = true; now += 59999; await admission.refresh(); assert.equal(calls, 1);
  now++; await admission.refresh(); assert.equal(calls, 2);
  const healthy = await invoke(server, 'GET', '/health');
  assert.equal(healthy.status, 200); assert.equal(healthy.body.mode, 'approve');
  assert.equal(healthy.body.mode_degraded, null);
  ready = false; now += 60000; await admission.refresh(); assert.equal(calls, 3);
  assert.equal((await invoke(server, 'GET', '/health')).body.mode, 'advisory');
  assert.equal((await invoke(server, 'GET', '/health')).status, 503);
});

test('fresh mutation admission refuses a cached positive when the gateway fails', async () => {
  let ready = true;
  const admission = createAdmission({ mode: 'approve', now: () => 1000000,
    gatewayUrl: 'http://gateway:4000', token: 'fixture-token', judgeToken: 'fixture-judge-token', fetchImpl: async () => {
      if (!ready) throw new Error('Gateway unavailable');
      return { ok: true, json: async () => ({ credentials: [{ provider: 'openai-codex', type: 'oauth', ok: true }] }) };
    } });
  assert.equal((await admission.refresh()).mode, 'approve');
  ready = false;
  assert.equal((await admission.refresh()).mode, 'approve');
  const results = await Promise.all([admission.refresh({ fresh: true }), admission.refresh({ fresh: true })]);
  assert.ok(results.every(result => result.mode === 'advisory'));
});

test('health cannot acknowledge a new request ahead of the serialized scheduler', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-drain-health-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const marker = join(root, 'merge-selection-drain.request');
  const first = 'd66bd611-34ce-43c9-bbb6-34c323a9267f';
  const second = '5d5ddc53-f903-45c4-b9d8-db82b02762ce';
  const scheduler = new Scheduler({ store, mode: 'off', readMergeDrain: () => readSelectionDrainRequest(marker) });
  const server = createWebhookServer({ store, scheduler, secret: 'fixture-secret', mode: 'off',
    fetchImpl: async () => ({ ok: true }) });
  await writeFile(marker, first);
  await scheduler.tick();
  assert.equal((await invoke(server, 'GET', '/health')).body.mergeDrain.request_id, first);
  await writeFile(marker, second);
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = scheduler.serialize(async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  });
  await started;
  const tick = scheduler.tick();
  try {
    const before = (await invoke(server, 'GET', '/health')).body.mergeDrain;
    assert.equal(before.request_id, first, 'HTTP does not sample the new file or bypass queued work');
    assert.notEqual(before.request_id, second);
  } finally {
    release();
    await blocked;
    await tick;
  }
  const after = (await invoke(server, 'GET', '/health')).body.mergeDrain;
  assert.equal(after.request_id, second);
  assert.equal(after.acknowledged, true);
  assert.equal(after.error, null);
});

test('approval admission follows configured reviewer provider and rejects another healthy provider', async () => {
  for (const [reviewModel, provider] of [['openai-codex/gpt-6.1-sol', 'openai-codex'], ['anthropic/claude-opus-5-5', 'anthropic']]) {
    const admission = (credentials) => admitStartupMode({ mode: 'approve', reviewModel,
      gatewayUrl: 'http://gateway:4000', token: 'fixture-token', judgeToken: 'fixture-judge',
      fetchImpl: async () => ({ ok: true, json: async () => ({ credentials }) }) });
    assert.equal((await admission([{ provider, type: 'oauth', ok: true }])).mode, 'approve');
    const other = provider === 'anthropic' ? 'openai-codex' : 'anthropic';
    assert.equal((await admission([{ provider: other, type: 'oauth', ok: true }])).mode, 'advisory');
    assert.equal((await admission([{ provider, type: 'oauth', ok: false }])).mode, 'advisory');
  }
});
