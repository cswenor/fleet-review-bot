import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubApp } from './github-app.mjs';
import { invalidateInformational } from './informational-cache.mjs';
import { withReconcileMetrics, withRequestPhase } from './request-metrics.mjs';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const options = { informational: true, headSha: 'head-a', pr: 7 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, resource) {
  const requests = [];
  let installationId = 11;
  let now = 1000000;
  const server = createServer((req, res) => {
    const request = { path: req.url, method: req.method, headers: req.headers };
    requests.push(request);
    const reply = (body, status = 200, headers = {}) => {
      request.status = status;
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(status === 304 ? undefined : JSON.stringify(body));
    };
    if (req.url.endsWith('/installation')) return reply({ id: installationId });
    if (req.url.endsWith('/access_tokens')) return reply({ token: `fixture-${installationId}`, expires_at: new Date(now + 3600000).toISOString() });
    Promise.resolve(resource(req, reply, res)).catch(error => { res.destroy(error); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const app = new GitHubApp({ appId: 19, privateKey, repo: 'owner/repo', now: () => now, sleep: async () => {},
    fetchImpl: (url, init) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, init) });
  return { app, requests, principal(id) { installationId = id; app.cachedToken = null; }, advance(ms) { now += ms; } };
}

const read = (app, path = '/resource', opts = options, guard) => app.request('GET', path, undefined, guard, opts);

test('wire 304 revalidation returns isolated representations, observes same-head changes, and records actual network success', async t => {
  let version = 1;
  const f = await fixture(t, (req, reply) => {
    const etag = `"v${version}"`;
    reply({ labels: [`version-${version}`] }, req.headers['if-none-match'] === etag ? 304 : 200, { etag });
  });
  const first = await read(f.app);
  first.labels.push('consumer-mutation');
  const metrics = [];
  await withReconcileMetrics(row => metrics.push(row), () => withRequestPhase('inspect', 7, async () => {
    assert.deepEqual(await read(f.app), { labels: ['version-1'] });
  }));
  const row = metrics.find(row => row.phase === 'inspect' && row.method === 'GET');
  assert.equal(row.attempts, 1);
  assert.deepEqual(row.statusCounts, { 304: 1 });
  assert.deepEqual(row.outcomeCounts, { success: 1 });
  version = 2;
  assert.deepEqual(await read(f.app), { labels: ['version-2'] }, 'ETag revalidation notices labels/status changes at the same SHA');
  assert.equal(f.requests.filter(row => row.path === '/resource').length, 3, 'cache never invents a zero-network fresh read');
});

test('exact principal, repository, resource query, head and PR partitions never borrow validators', async t => {
  const f = await fixture(t, (req, reply) => reply({ resource: req.url }, 200, { etag: '"same"' }));
  await read(f.app, '/resource?state=open');
  await read(f.app, '/resource?state=open');
  await read(f.app, '/resource?state=closed');
  await read(f.app, '/resource?state=open', { ...options, headSha: 'head-b' });
  await read(f.app, '/resource?state=open', { ...options, pr: 8 });
  f.principal(12);
  await read(f.app, '/resource?state=open');
  f.app.repo = 'other/repo';
  await read(f.app, '/resource?state=open');
  f.app.appId = 20;
  await read(f.app, '/resource?state=open');
  const rows = f.requests.filter(row => row.path.startsWith('/resource'));
  assert.equal(rows[1].headers['if-none-match'], '"same"');
  assert.ok(rows.filter((_, index) => index !== 1).every(row => row.headers['if-none-match'] === undefined));
});

test('authority, mutations, GET bodies and unknown installation identity never become conditional or override fixed headers', async t => {
  const f = await fixture(t, (req, reply) => reply({ ok: true }, 200, { etag: '"cached"' }));
  await read(f.app);
  await f.app.request('GET', '/resource');
  await f.app.request('PATCH', '/resource', { labels: [] }, undefined, options);
  // A fake cached token without its actual minted installation is intentionally uncacheable.
  f.app.cachedToken = { token: 'unknown-principal', expiresAt: 9999999 };
  await read(f.app);
  await read(f.app, '/resource', { ...options, headers: { Accept: 'bad', 'If-None-Match': 'bad' } });
  const rows = f.requests.filter(row => row.path === '/resource');
  assert.ok(rows.every(row => row.headers['if-none-match'] === undefined));
  assert.ok(rows.every(row => row.headers.accept === 'application/vnd.github+json' && row.headers['x-github-api-version'] === '2026-03-10'));
  // Native fetch disallows GET bodies; exercise this exclusion without changing that transport policy.
  await assert.rejects(f.app.request('GET', '/resource', {}, undefined, options), /GET\/HEAD|body/iu);
});

test('tag invalidation retains only validators for a new guarded upstream revalidation', async t => {
  const f = await fixture(t, (req, reply) => reply([], req.headers['if-none-match'] === '"tag"' ? 304 : 200, { etag: '"tag"' }));
  await read(f.app, '/one');
  await read(f.app, '/two', { ...options, headSha: 'head-b', pr: 8 });
  invalidateInformational({}, { all: true });
  invalidateInformational(f.app, { pr: 7 });
  await read(f.app, '/one');
  await read(f.app, '/two', { ...options, headSha: 'head-b', pr: 8 });
  assert.equal(f.requests.at(-2).headers['if-none-match'], '"tag"');
  assert.equal(f.requests.at(-1).headers['if-none-match'], '"tag"');
  invalidateInformational(f.app, { headSha: 'head-b' });
  await read(f.app, '/two', { ...options, headSha: 'head-b', pr: 8 });
  assert.equal(f.requests.at(-1).headers['if-none-match'], '"tag"');
  invalidateInformational(f.app, { all: true });
  await read(f.app, '/one');
  assert.equal(f.requests.at(-1).headers['if-none-match'], '"tag"');
});

for (const [tag, invalidation] of [['pr', { pr: 7 }], ['head', { headSha: 'head-a' }], ['all', { all: true }]])
for (const status of [200, 304]) test(`in-flight ${status} cannot resurrect a ${tag}-invalidated representation`, async t => {
  const entered = deferred(); const release = deferred(); let hold = false;
  const f = await fixture(t, async (req, reply) => {
    if (hold) { entered.resolve(); await release.promise; reply({ value: 'late' }, status, { etag: '"late"' }); }
    else reply({ value: 'initial' }, 200, { etag: '"initial"' });
  });
  if (status === 304) await read(f.app);
  hold = true;
  const pending = read(f.app);
  // Attach rejection handling before opening the response gate.
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  invalidateInformational(f.app, invalidation);
  hold = false; release.resolve();
  const result = await outcome;
  if (status === 304) assert.match(result.error.message, /304_without_representation/u);
  else assert.match(result.error.message, /informational_invalidated/u);
  await read(f.app);
  assert.equal(f.requests.at(-1).headers['if-none-match'], status === 304 ? '"initial"' : undefined,
    'old tickets cannot replace validators; a new ticket may revalidate the pre-event body');
});

for (const invalidation of [{ pr: 8 }, { headSha: 'head-b' }, { pr: 999 }, { headSha: 'absent-head' }, {}])
test(`unrelated invalidation ${JSON.stringify(invalidation)} preserves an in-flight A revalidation`, async t => {
  const entered = deferred(); const release = deferred(); let hold = false;
  const f = await fixture(t, async (req, reply) => {
    if (hold && req.url === '/a') { entered.resolve(); await release.promise; }
    reply({ resource: req.url }, req.headers['if-none-match'] ? 304 : 200, { etag: '"present"' });
  });
  await read(f.app, '/a');
  await read(f.app, '/b', { ...options, headSha: 'head-b', pr: 8 });
  hold = true;
  const pending = read(f.app, '/a');
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  invalidateInformational(f.app, invalidation);
  release.resolve();
  const result = await outcome;
  assert.equal(result.error, undefined, 'B events and absent tags must not turn valid A 304s into preparation errors');
  assert.deepEqual(result.value, { resource: '/a' });
  assert.equal(f.requests.at(-1).headers['if-none-match'], '"present"');
  await read(f.app, '/a');
  assert.equal(f.requests.at(-1).headers['if-none-match'], '"present"', 'unrelated invalidation preserves A for later revalidation too');
});

test('304 without a matching representation refuses once, and authority always refuses 304', async t => {
  const f = await fixture(t, (req, reply) => reply(null, 304));
  await assert.rejects(read(f.app), /304_without_representation/u);
  await assert.rejects(f.app.request('GET', '/resource'), /HTTP 304/u);
  assert.equal(f.requests.filter(row => row.path === '/resource').length, 2, 'no retry loop for a bodyless 304');
});

for (const status of [403, 429, 503]) test(`cached representation never masks HTTP ${status} or shared backoff`, async t => {
  let fail = false;
  const f = await fixture(t, (req, reply) => fail ? reply({ message: 'denied' }, status, status === 429 ? { 'retry-after': '2' } : {})
    : reply({ value: 'old' }, 200, { etag: '"old"' }));
  await read(f.app); fail = true;
  await assert.rejects(read(f.app), error => error.github?.status === status);
  if (status === 429) {
    const count = f.requests.length;
    await assert.rejects(read(f.app, '/other'), error => error.code === 'github_rate_limited');
    assert.equal(f.requests.length, count, 'shared window blocks sends even when a representation exists');
    f.advance(2000);
  }
});

test('guards still fence conditional sends, body consumption and returned representations', async t => {
  const f = await fixture(t, (req, reply) => reply({ ok: true }, req.headers['if-none-match'] ? 304 : 200, { etag: '"guard"' }));
  await read(f.app);
  const events = [];
  assert.deepEqual(await read(f.app, '/resource', options, async phase => events.push(phase ?? 'guard')), { ok: true });
  assert.deepEqual(events, ['guard', 'guard', 'before_send', 'guard', 'guard']);
  const count = f.requests.length;
  await assert.rejects(read(f.app, '/resource', options, async phase => { if (phase === 'before_send') throw new Error('veto'); }), /veto/u);
  assert.equal(f.requests.length, count);
});

test('pagination forwards opt-in validators per page without sharing mutable rows', async t => {
  const f = await fixture(t, (req, reply) => reply({ runs: [{ status: 'completed' }] }, req.headers['if-none-match'] ? 304 : 200, { etag: '"page"' }));
  const rows = await f.app.paginate('/runs?head=head-a', 'runs', undefined, options);
  rows[0].status = 'changed-locally';
  assert.deepEqual(await f.app.paginate('/runs?head=head-a', 'runs', undefined, options), [{ status: 'completed' }]);
  assert.equal(f.requests.at(-1).path, '/runs?head=head-a&per_page=100&page=1');
  assert.equal(f.requests.at(-1).headers['if-none-match'], '"page"');
});

test('per-head entry, byte and head bounds isolate noisy resources from the rest of the sweep', async t => {
  const f = await fixture(t, (req, reply) => reply({ value: req.url.startsWith('/large') ? 'x'.repeat(600 * 1024) : 'small' },
    req.headers['if-none-match'] ? 304 : 200, { etag: '"bound"' }));
  const quiet = { ...options, headSha: 'quiet-head', pr: 8 };
  await read(f.app, '/quiet', quiet);
  for (let i = 0; i <= 32; i++) await read(f.app, `/entry-${i}`);
  await read(f.app, '/entry-0');
  assert.equal(f.requests.at(-1).headers['if-none-match'], undefined, 'oldest entry within one head was evicted');
  await read(f.app, '/quiet', quiet);
  assert.equal(f.requests.at(-1).headers['if-none-match'], '"bound"', 'one noisy head cannot evict another head');
  for (let i = 0; i <= 64; i++) await read(f.app, '/heads', { ...options, headSha: `head-${i}` });
  await read(f.app, '/heads', { ...options, headSha: 'head-0' });
  assert.equal(f.requests.at(-1).headers['if-none-match'], undefined, 'oldest distinct head was evicted');
  await read(f.app, '/large-a');
  await read(f.app, '/large-b');
  await read(f.app, '/large-a');
  assert.equal(f.requests.at(-1).headers['if-none-match'], undefined, 'per-head byte budget also bounds retained bodies');
});

for (const mode of ['body', 'transport']) test(`cached data never replaces a ${mode} failure`, async t => {
  let fail = false;
  const f = await fixture(t, (req, reply, res) => {
    if (!fail) return reply({ value: 'old' }, 200, { etag: '"old"' });
    if (mode === 'transport') return res.destroy();
    res.writeHead(200, { 'Content-Type': 'application/json', etag: '"broken"' });
    res.end('not JSON');
  });
  await read(f.app);
  fail = true;
  await assert.rejects(read(f.app));
});

test('representations lacking validators or exceeding the per-head byte budget remain uncached', async t => {
  const f = await fixture(t, (req, reply) => reply({ value: req.url === '/oversized' ? 'x'.repeat(1024 * 1024) : 'small' },
    200, req.url === '/oversized' ? { etag: '"oversized"' } : {}));
  for (const path of ['/oversized', '/no-etag']) {
    await read(f.app, path);
    await read(f.app, path);
    assert.equal(f.requests.at(-1).headers['if-none-match'], undefined);
  }
});

test('48-head preparation working set survives repeated sweeps and matching-head webhook invalidation on real HTTP', async t => {
  const f = await fixture(t, (req, reply) => {
    const etag = JSON.stringify(req.url);
    reply({ resource: req.url }, req.headers['if-none-match'] === etag ? 304 : 200, { etag });
  });
  const sweep = async cycle => {
    for (let pr = 1; pr <= 48; pr++) {
      const headSha = `head-${pr}`;
      if (cycle) invalidateInformational(f.app, { headSha, pr });
      const paths = [
        `/pulls/${pr}`, `/compare/main...${headSha}?per_page=1`,
        `/pulls/${pr}/reviews?per_page=100&page=1`,
        `/commits/${headSha}/check-suites?per_page=100&page=1`,
        `/check-suites/${pr}/check-runs?filter=all&per_page=100&page=1`,
        `/actions/runs/${pr}`,
      ];
      // Display reads omit PR identity; candidate reads include it. Both exact
      // representations must survive (12 entries/head, 576 across the sweep).
      for (const identity of [undefined, pr]) for (const path of paths) {
        assert.deepEqual(await read(f.app, `/repos/owner/repo${path}`,
          { informational: true, headSha, pr: identity }), { resource: `/repos/owner/repo${path}` });
      }
    }
  };
  await sweep(0);
  assert.equal(f.requests.filter(row => row.path.startsWith('/repos/owner/repo/') && row.status === 200
    && !row.path.endsWith('/installation')).length, 576);
  for (let cycle = 1; cycle <= 2; cycle++) {
    if (cycle === 2) invalidateInformational(f.app, { all: true });
    const start = f.requests.length;
    await sweep(cycle);
    const rows = f.requests.slice(start);
    assert.equal(rows.length, 576, 'every result still requires an authorized upstream request');
    assert.ok(rows.every(row => row.status === 304 && row.headers['if-none-match']),
      'neither same-head events nor cyclic entry churn erase the validators');
  }
  await f.app.request('GET', '/repos/owner/repo/pulls/1');
  assert.equal(f.requests.at(-1).status, 200);
  assert.equal(f.requests.at(-1).headers['if-none-match'], undefined, 'final authority never uses the representation cache');
});

test('multi-page conditional pagination follows refreshed page boundaries instead of cached tails', async t => {
  let size = 101;
  const f = await fixture(t, (req, reply) => {
    const page = Number(new URL(req.url, 'http://fixture').searchParams.get('page'));
    const rows = Array.from({ length: size }, (_, id) => ({ id })).slice((page - 1) * 100, page * 100);
    const etag = `"size-${size}-page-${page}"`;
    reply({ runs: rows }, req.headers['if-none-match'] === etag ? 304 : 200, { etag });
  });
  const pages = () => f.app.paginate('/runs?head=head-a', 'runs', undefined, options);
  assert.equal((await pages()).length, 101);
  let start = f.requests.length;
  assert.equal((await pages()).length, 101);
  assert.deepEqual(f.requests.slice(start).map(row => row.status), [304, 304]);
  size = 2;
  start = f.requests.length;
  assert.deepEqual(await pages(), [{ id: 0 }, { id: 1 }]);
  assert.deepEqual(f.requests.slice(start).map(row => row.status), [200], 'shrinking page one never appends old page two');
  size = 201;
  start = f.requests.length;
  assert.equal((await pages()).length, 201);
  assert.deepEqual(f.requests.slice(start).map(row => row.status), [200, 200, 200]);
  assert.equal(f.requests.at(-1).headers['if-none-match'], undefined, 'new page starts without another page validator');
});

test('concurrent replacement cannot attach a newer body to an older in-flight 304', async t => {
  const entered = deferred(); const release = deferred();
  let hold = false; let version = 1;
  const f = await fixture(t, async (req, reply) => {
    const etag = `"v${version}"`;
    if (hold) {
      hold = false;
      entered.resolve();
      await release.promise;
      return reply(null, 304, { etag });
    }
    reply({ version }, req.headers['if-none-match'] === etag ? 304 : 200, { etag });
  });
  await read(f.app);
  hold = true;
  const pending = read(f.app).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  version = 2;
  assert.deepEqual(await read(f.app), { version: 2 });
  release.resolve();
  assert.match((await pending).error.message, /304_without_representation/u);
  assert.deepEqual(await read(f.app), { version: 2 });
  assert.equal(f.requests.at(-1).headers['if-none-match'], '"v2"');
});

test('a 200 without ETag removes the former validator and a subsequent unsolicited 304 fails closed', async t => {
  let mode = 'tagged';
  const f = await fixture(t, (req, reply) => {
    if (mode === 'tagged') return reply({ value: 1 }, 200, { etag: '"old"' });
    if (mode === 'untagged') return reply({ value: 2 });
    return reply(null, 304);
  });
  await read(f.app);
  mode = 'untagged';
  assert.deepEqual(await read(f.app), { value: 2 });
  assert.equal(f.requests.at(-1).headers['if-none-match'], '"old"');
  mode = 'unsolicited';
  await assert.rejects(read(f.app), /304_without_representation/u);
  assert.equal(f.requests.at(-1).headers['if-none-match'], undefined);
});

test('unknown installation cannot use a retained validator even when upstream returns 304', async t => {
  let unsolicited = false;
  const f = await fixture(t, (req, reply) => reply({ value: 1 }, unsolicited ? 304 : 200, { etag: '"old"' }));
  await read(f.app);
  f.app.cachedToken = { token: 'unknown-installation', expiresAt: 9999999 };
  unsolicited = true;
  await assert.rejects(read(f.app), /HTTP 304/u);
  assert.equal(f.requests.at(-1).headers['if-none-match'], undefined);
});
