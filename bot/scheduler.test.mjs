import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { Scheduler } from './scheduler.mjs';
import { Publisher } from './publish.mjs';
import { Mirror } from './mirror.mjs';
import { Approval } from './approval.mjs';
import { Shepherd } from './shepherd.mjs';
import { minimalPayload } from './webhook.mjs';
import { readSelectionDrainRequest } from './merge-drain.mjs';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { GitHubApp } from './github-app.mjs';
import { createWebhookServer } from './server.mjs';
import { GitHubBudget, GitHubBudgetDeferred } from './github-budget.mjs';
const sha = (letter) => letter.repeat(40);
const builder = { id: 1003, login: 'builder[bot]' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'review-scheduler-'));
  await mkdir(join(root, 'work')); await mkdir(join(root, 'sessions'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const calls = []; let now = 1000000;
  const github = { repo: 'example-org/example-project', appId: 1001, request: async () => ({ state: 'open', draft: false, head: { sha: sha('c'), ref: 'feature', repo: { full_name: 'example-org/example-project' } }, base: { ref: 'main', repo: { full_name: 'example-org/example-project' } } }), paginate: async () => [] };
  const publisher = { queued: async (row) => store.update(row.id, { check_run_id: row.id + 10 }),
    terminal: async (row, conclusion, reason) => calls.push(['check', row.id, conclusion, reason]), started: async () => {} };
  const mirror = { reviewModel: 'openai-codex/gpt-6.1-sol', reviewThinking: 'medium',
    prepare: async () => ({ base_sha: sha('d') }), carry: async () => null };
  const verdict = { evaluate: async (review) => ({
    decision: review.findings?.some((finding) => finding.status !== 'resolved') ? 'block' : 'approve',
    model: 'jev-1.13.0', request_ids: ['fixture-verdict'],
  }) };
  const fetchImpl = async (url, options) => { calls.push([options.method, url]); return { status: 202, ok: true }; };
  const scheduler = new Scheduler({ store, github, publisher, mirror, verdict, fetchImpl, now: () => now,
    workRoot: join(root, 'work'), sessionsRoot: join(root, 'sessions') });
  return { root, store, scheduler, calls, github, setNow: (value) => { now = value; } };
}


test('reconcile metrics retain PR phases across real nested reads and mutations', async (t) => {
  const f = await fixture(t);
  const logs = [], requests = [];
  const prs = [1, 2].map((number) => ({
    number, state: 'open', draft: false, mergeable: true, labels: [{ name: 'needs-update' }],
    head: { sha: sha(number === 1 ? 'a' : 'b'), ref: `feature-${number}`, repo: { full_name: f.github.repo } },
    base: { ref: 'main', sha: sha('d') }, user: { login: 'author', type: 'User' },
  }));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const github = new GitHubApp({ appId: f.github.appId, repo: f.github.repo,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    fetchImpl: async (input, options) => {
      const url = new URL(input), path = url.pathname.replace(`/repos/${f.github.repo}`, '');
      requests.push([options.method, path]);
      let body;
      if (path === '/pulls') body = prs;
      else if (/^\/pulls\/[12]$/u.test(path)) body = prs[Number(path.split('/').at(-1)) - 1];
      else if (path.startsWith('/compare/')) body = { behind_by: 0, base_commit: { sha: sha('d') } };
      else if (/^\/issues\/[12]\/labels\/needs-update$/u.test(path)) return new Response(null, { status: 204 });
      else if (/^\/pulls\/[12]\/reviews$/u.test(path)) body = [];
      else if (/^\/commits\/[ab]+\/check-runs$/u.test(path)) body = { check_runs: [] };
      else if (/^\/commits\/[ab]+\/check-suites$/u.test(path)) body = { check_suites: [] };
      else if (path === '/check-runs') body = { id: 100 + requests.length };
      else if (/^\/issues\/[12]\/comments$/u.test(path)) body = options.method === 'POST' ? { id: 200 + requests.length } : [];
      else throw new Error(`Unexpected metrics fixture request: ${options.method} ${path}`);
      return Response.json(body);
    } });
  github.cachedToken = { token: 'fixture-token', expiresAt: Date.now() + 3600000 };
  f.scheduler.github = github;
  f.scheduler.publisher = new Publisher({ github, store: f.store });
  f.scheduler.shepherd = new Shepherd({ github, store: f.store });
  f.scheduler.log = (row) => logs.push(row);
  await f.scheduler.reconcile();
  const phases = logs.filter((row) => row.event === 'reconcile_request_phase');
  const summary = logs.find((row) => row.event === 'reconcile_request_summary');
  assert.equal(f.scheduler.lastReconcileCounts.failed, 0);
  assert.equal(summary.complete, true);
  assert.equal(summary.attempts, requests.length);
  assert.equal(summary.inflight, 0);
  assert.equal(new Set(phases.map((row) => row.cycleId)).size, 1);
  assert.ok(phases.every((row) => row.cycleId === summary.cycleId && row.appId === github.appId));
  assert.equal(phases.find((row) => row.phase === 'openPRs').pr, null);
  for (const pr of prs) {
    const rows = phases.filter((row) => row.pr === pr.number);
    assert.ok(rows.some((row) => row.phase === 'inspect' && row.method === 'GET' && row.attempts > 0));
    assert.ok(rows.some((row) => row.phase === 'inspect' && row.method === 'DELETE' && row.statusCounts['204'] === 1));
    assert.ok(rows.some((row) => row.phase === 'review' && row.method === 'POST' && row.attempts === 1));
    assert.ok(rows.some((row) => row.phase === 'review' && row.method === 'GET' && row.attempts > 1));
    assert.ok(rows.some((row) => row.phase === 'status' && row.method === 'POST' && row.attempts === 1));
    assert.equal(f.store.active(pr.number).status, 'queued');
    assert.equal(f.store.active(pr.number).attempt, 1);
  }
  assert.deepEqual(requests.filter(([method]) => method === 'DELETE').map(([, path]) => path),
    ['/issues/1/labels/needs-update', '/issues/2/labels/needs-update']);
  assert.equal(f.calls.length, 0, 'observing reconciliation does not launch runner work');
});

test('reconcile metrics flush failed discovery without capturing independent poll or start work', async (t) => {
  const f = await fixture(t);
  const logs = [], requests = [];
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let release, background;
  const blocked = new Promise((resolve) => { release = resolve; });
  const queued = f.store.enqueue({ pr: 9, head_sha: sha('c'), base_ref: 'main', due: 2000000, reason: 'synchronize' }, 1000000);
  const running = f.store.enqueue({ pr: 8, head_sha: sha('b'), base_ref: 'main', due: 1000000, reason: 'synchronize' }, 1000000);
  f.store.update(running.id, { status: 'running' });
  const github = new GitHubApp({ appId: f.github.appId, repo: f.github.repo,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    fetchImpl: async (input) => {
      const path = new URL(input).pathname;
      requests.push(path);
      if (path.endsWith('/pulls')) {
        background = [f.scheduler.poll(running), f.scheduler.start(queued)];
        throw new Error('fixture_discovery_failure');
      }
      if (path.endsWith('/pulls/8')) {
        await blocked;
        return Response.json({});
      }
      if (path.endsWith('/pulls/9')) return Response.json({});
      throw new Error(`Unexpected independent fixture request: ${path}`);
    } });
  github.cachedToken = { token: 'fixture-token', expiresAt: Date.now() + 3600000 };
  f.scheduler.github = github;
  f.scheduler.pollNow = () => github.request('GET', `/repos/${github.repo}/pulls/8`);
  f.scheduler.log = (row) => logs.push(row);
  try {
    await f.scheduler.reconcile();
    const summary = logs.find((row) => row.event === 'reconcile_request_summary');
    assert.equal(summary.complete, true, 'independent poll must not hold the root open');
    assert.equal(summary.attempts, 1);
    assert.equal(summary.logicalCalls, 1);
    assert.equal(summary.inflight, 0);
    assert.equal(f.scheduler.lastReconcileCounts.failed, 1);
    assert.ok(logs.some((row) => row.event === 'reconcile_sweep_failed'));
    assert.equal(f.store.review(queued.id).status, 'queued');
    assert.equal(f.store.review(queued.id).due_at, 2000000);
    assert.equal(f.store.review(queued.id).attempt, 1);
  } finally {
    release();
    await Promise.all(background ?? []);
  }
  assert.equal(requests.length, 3);
  assert.equal(logs.filter((row) => row.event === 'reconcile_request_summary').length, 1);
});

function ciProvider(github) {
  const state = { runs: [], legacyRuns: [] };
  const request = github.request, paginate = github.paginate;
  const app = { id: 15368, slug: 'github-actions' };
  github.paginate = async (input, key, guard) => {
    const url = new URL(input, 'https://api.github.com');
    const path = url.pathname.replace(`/repos/${github.repo}/`, '');
    if (path === 'actions/runs' || path === 'actions/workflows/ci.yml/runs') {
      if (state.legacyRuns instanceof Error) throw state.legacyRuns;
      return state.legacyRuns;
    }
    const commit = /^commits\/([a-f0-9]{40})\/check-suites$/u.exec(path);
    if (commit) return state.runs.filter((run) => run.head_sha === commit[1]).map((run) => ({
      id: run.id + 1000, head_sha: run.head_sha, app, repository: { full_name: github.repo },
    }));
    const suite = /^check-suites\/(\d+)\/check-runs$/u.exec(path);
    if (suite) return state.runs.filter((run) => run.id + 1000 === Number(suite[1])).map((run) => ({
      id: run.id + 2000, head_sha: run.head_sha, app, check_suite: { id: run.id + 1000 },
      details_url: `https://github.com/${github.repo}/actions/runs/${run.id}/job/${run.id + 2000}`,
    }));
    return paginate(input, key, guard);
  };
  github.request = async (method, input, body, guard) => {
    const path = new URL(input, 'https://api.github.com').pathname.replace(`/repos/${github.repo}/`, '');
    const run = /^actions\/runs\/(\d+)$/u.exec(path);
    if (run) {
      assert.equal(method, 'GET');
      const value = state.runs.find((candidate) => candidate.id === Number(run[1]));
      if (!value) throw new Error(`Unexpected fixture run: ${run[1]}`);
      return { ...value, check_suite_id: value.id + 1000 };
    }
    return request(method, input, body, guard);
  };
  const run = { id: 42, run_attempt: 2, name: 'CI', event: 'pull_request', head_sha: sha('c'),
    path: '.github/workflows/ci.yml', workflow_id: 7, repository: { full_name: github.repo },
    head_repository: { full_name: github.repo }, status: 'completed', conclusion: 'success',
    html_url: `https://github.com/${github.repo}/actions/runs/42` };
  state.runs.push(run);
  return { state, run };
}

test('scheduler publishes exact-head green CI despite an empty legacy workflow-run index', async (t) => {
  const f = await fixture(t);
  ciProvider(f.github);
  const review = {};
  await f.scheduler.attachCi({ head_sha: sha('c') }, review);
  assert.deepEqual(review.ci, { id: 42, run_attempt: 2, status: 'completed', conclusion: 'success',
    html_url: `https://github.com/${f.github.repo}/actions/runs/42`, completed_at: 0 });
});

test('scheduler exposes newest queued then failed CI instead of older green despite a flaky legacy index', async (t) => {
  const f = await fixture(t);
  const { state, run } = ciProvider(f.github);
  state.legacyRuns = new Error('legacy workflow-runs index unavailable');
  const latest = { ...run, id: 43, status: 'queued', conclusion: null };
  state.runs = [latest, run];
  let ci = await f.scheduler.latestCi(sha('c'));
  assert.equal(ci.id, 43);
  assert.equal(ci.status, 'queued');
  assert.equal(ci.conclusion, null);
  latest.status = 'completed';
  latest.conclusion = 'failure';
  ci = await f.scheduler.latestCi(sha('c'));
  assert.equal(ci.id, 43);
  assert.equal(ci.conclusion, 'failure');
});

test('scheduler CI display admits neither foreign authority nor unrelated workflow names', async (t) => {
  const f = await fixture(t);
  const { state, run } = ciProvider(f.github);
  state.runs = [
    { ...run, id: 900, head_repository: { full_name: 'attacker/repo' } },
    { ...run, id: 901, repository: { full_name: 'attacker/repo' } },
    { ...run, id: 902, event: 'push' },
    { ...run, id: 903, path: '.github/workflows/other.yml' },
    { ...run, id: 904, head_sha: sha('b') },
    { ...run, id: 905, name: 'Other workflow' },
  ];
  assert.equal(await f.scheduler.latestCi(sha('c')), null);
  state.runs.push(run);
  assert.equal((await f.scheduler.latestCi(sha('c'))).id, 42);
});

test('drain ACK waits for both writer retirement and completion publication, and follows the current request', async (t) => {
  const f = await fixture(t);
  f.scheduler.mode = 'off';
  const marker = join(f.root, 'merge-selection-drain.request');
  const first = 'd66bd611-34ce-43c9-bbb6-34c323a9267f';
  const second = '5d5ddc53-f903-45c4-b9d8-db82b02762ce';
  f.scheduler.readMergeDrain = () => readSelectionDrainRequest(marker);
  await writeFile(marker, first);
  const selected = f.store.selectMergeBatch({ id: 'drain-existing', generation: 1, kind: 'single', state: 'selected',
    selected_at: 1000000, updated_at: 1000000, base_sha: sha('a'), head_sha: sha('b'), target_pr: 1,
    members: [{ pr: 1, head_sha: sha('b'), review_id: null, publication_id: null, github_review_id: null,
      pull_request_id: 'PR_1', ci_run_id: null, ci_attempt: null, priority: null, created_at: null }] });
  await f.scheduler.tick();
  assert.equal(f.scheduler.mergeDrain.request_id, first);
  assert.equal(f.scheduler.mergeDrain.acknowledged, false, 'an active writer is not drained');
  f.store.retireMergeBatch(selected.id, 1, 'publishing', 1000000);
  await f.scheduler.tick();
  assert.equal(f.scheduler.mergeDrain.acknowledged, false, 'released main authority still has a publication to finish');
  f.store.updateMergeBatch(selected.id, 1, { state: 'merged' });
  await f.scheduler.tick();
  assert.equal(f.scheduler.mergeDrain.acknowledged, true);
  await writeFile(marker, second);
  await f.scheduler.tick();
  assert.equal(f.scheduler.mergeDrain.request_id, second);
  assert.equal(f.scheduler.mergeDrain.acknowledged, true);
  await rm(marker);
  await f.scheduler.tick();
  assert.equal(f.scheduler.mergeDrain.requested, false);
  assert.equal(f.scheduler.mergeDrain.request_id, null);
  assert.equal(f.scheduler.mergeDrain.acknowledged, false);
});

test('a failed drain read revokes an old ACK without granting new selection or exposing the error', async (t) => {
  const f = await fixture(t);
  f.scheduler.mode = 'off';
  const request_id = 'd66bd611-34ce-43c9-bbb6-34c323a9267f';
  f.scheduler.readMergeDrain = async () => ({ request_id, error: null });
  await f.scheduler.tick();
  assert.equal(f.scheduler.mergeDrain.acknowledged, true);
  f.scheduler.readMergeDrain = async () => { throw new Error('private-read-diagnostic'); };
  await f.scheduler.tick();
  assert.equal(f.scheduler.mergeDrain.requested, true);
  assert.equal(f.scheduler.mergeDrain.request_id, null);
  assert.equal(f.scheduler.mergeDrain.acknowledged, false);
  assert.equal(f.scheduler.mergeDrain.error, 'unavailable');
});
test('three synchronize events collapse into newest debounced head', async (t) => {
  const f = await fixture(t);
  for (const [index, letter] of ['a', 'b', 'c'].entries()) await f.scheduler.handle({ type: 'enqueue', pr: 1,
    head_sha: sha(letter), due: 1060000 + index * 1000, reason: 'synchronize' });
  assert.equal(f.store.counts().queued, 1);
  assert.equal(f.store.active(1).head_sha, sha('c'));
  assert.equal(f.store.active(1).due_at, 1062000);
  f.setNow(1062000); await f.scheduler.tick();
  assert.equal(f.store.counts().running, 1);
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
});

async function queuedReviews(t, entries, concurrency = 4) {
  const f = await fixture(t);
  f.scheduler.concurrency = concurrency;
  f.scheduler.lastReconcileAt = f.scheduler.now();
  const prs = new Map(entries.map(({ pr, priority }) => [pr, {
    number: pr, state: 'open', draft: false,
    labels: priority === undefined ? [] : [{ name: `merge-priority:${priority}` }],
    head: { sha: sha('c'), repo: { full_name: f.github.repo } },
    base: { ref: 'main', repo: { full_name: f.github.repo } },
  }]));
  f.github.paginate = async () => [...prs.values()];
  f.github.request = async (_method, path) => prs.get(Number(path.split('/').at(-1)));
  const started = [];
  f.scheduler.mirror.prepare = async row => { started.push(row.pr); return { base_sha: sha('d') }; };
  for (const { pr, created, due = 0 } of entries) {
    f.store.enqueue({ pr, head_sha: sha('c'), base_ref: 'main', due, reason: 'opened' }, created);
  }
  return { ...f, prs, started };
}

test('ready reviews use priority then queue age and id, respect due time and fill four slots', async t => {
  const f = await queuedReviews(t, [
    { pr: 1, priority: 2, created: 1 },
    { pr: 2, priority: 0, created: 30 },
    { pr: 3, priority: 0, created: 20, due: 100 },
    { pr: 4, priority: 0, created: 20, due: 200 },
    { pr: 5, priority: 1, created: 10 },
    { pr: 6, priority: 0, created: 0, due: 1000001 },
    { pr: 7, created: -10 },
  ]);
  await f.scheduler.tick();
  assert.deepEqual(f.started, [3, 4, 2, 5]);
  assert.deepEqual(f.store.all('SELECT pr,status FROM reviews ORDER BY pr').map(row => [row.pr, row.status]), [
    [1, 'queued'], [2, 'running'], [3, 'running'], [4, 'running'],
    [5, 'running'], [6, 'queued'], [7, 'queued'],
  ]);
});

test('queued review priority follows current labels rather than enqueue-time labels', async t => {
  const f = await queuedReviews(t, [
    { pr: 1, priority: 0, created: 1 },
    { pr: 2, priority: 2, created: 2 },
  ], 1);
  f.prs.get(1).labels = [];
  f.prs.get(2).labels = [{ name: 'merge-priority:0' }];
  await f.scheduler.tick();
  assert.equal(f.store.active(2).status, 'running');
  assert.equal(f.store.active(1).status, 'queued');
});

test('unavailable review priorities leave eligible work queued without a FIFO fallback', async t => {
  const f = await queuedReviews(t, [{ pr: 1, priority: 0, created: 1 }]);
  f.github.paginate = async () => { throw new Error('priority metadata unavailable'); };
  await assert.rejects(f.scheduler.tick(), /priority metadata unavailable/u);
  assert.equal(f.store.active(1).status, 'queued');
  assert.deepEqual(f.started, []);
});

test('initial refill failure does not skip running and publishing recovery', async t => {
  const f = await queuedReviews(t, [1, 2, 3].map(pr => ({ pr, created: pr })));
  const running = f.store.active(2), publishing = f.store.active(3);
  f.store.update(running.id, { status: 'running' });
  f.store.update(publishing.id, { status: 'publishing' });
  f.github.paginate = async () => { throw new Error('priority metadata unavailable'); };
  const logs = [];
  f.scheduler.log = entry => logs.push(entry);
  await f.scheduler.recover();
  assert.deepEqual(logs, [{ event: 'recovery_refill_failed' }]);
  assert.equal(f.store.active(1).status, 'queued');
  assert.equal(f.store.review(running.id).reason, 'restart');
  assert.equal(f.store.active(2).attempt, 2);
  assert.equal(f.store.active(2).status, 'queued');
  assert.equal(f.store.review(publishing.id).reason, 'review_evidence_failed');
  assert.equal(f.store.review(publishing.id).status, 'failed');
  assert.deepEqual(f.started, []);
  assert.equal(f.calls.some(([method]) => method === 'POST'), false);
});

test('initial refill failure does not hide unrelated durable recovery errors', async t => {
  const f = await queuedReviews(t, [1, 2].map(pr => ({ pr, created: pr })));
  f.store.update(f.store.active(2).id, { status: 'running' });
  f.github.paginate = async () => { throw new Error('priority metadata unavailable'); };
  const failure = new Error('terminal recovery unavailable');
  f.scheduler.publisher.terminal = async () => { throw failure; };
  await assert.rejects(f.scheduler.recover({ waitForPublications: false }), error => error === failure);
  assert.equal(f.store.active(1).status, 'queued');
  assert.deepEqual(f.started, []);
});

for (const waitForPublications of [true, false]) {
  test(`recovery propagates malformed durable batch data before priority discovery (wait=${waitForPublications})`, async t => {
    const f = await queuedReviews(t, [{ pr: 1, created: 1 }]);
    f.store.run('INSERT INTO merge_batches(id,generation,record_json) VALUES(?,?,?)', 'malformed-recovery', 1, '{');
    f.store.run('INSERT INTO active_merge_batch(slot,id,generation) VALUES(?,?,?)', 1, 'malformed-recovery', 1);
    let discoveries = 0;
    const logs = [];
    f.github.paginate = async () => { discoveries++; throw new Error('priority metadata unavailable'); };
    f.scheduler.log = entry => logs.push(entry);
    await assert.rejects(f.scheduler.recover({ waitForPublications }), SyntaxError);
    assert.equal(discoveries, 0, 'the failure must originate inside refill before its GitHub await');
    assert.equal(f.store.active(1).status, 'queued');
    assert.deepEqual(f.started, []);
    assert.deepEqual(logs, [], 'durable corruption must not be recorded as retryable discovery failure');
  });
}

test('rate-limited refill discovery is DEFERRED without changing queued work', async t => {
  const f = await queuedReviews(t, [{ pr: 1, created: 1 }]);
  const failure = Object.assign(new Error('private upstream response'), {
    retryAt: 1060000, code: 'github_rate_limited', github: { status: 403, headers: { 'retry-after': '60' } },
  });
  const before = f.store.active(1), logs = [];
  let discoveries = 0;
  f.scheduler.log = row => logs.push(row);
  f.github.paginate = async () => { discoveries++; throw failure; };
  for (let i = 0; i < 6; i++) {
    f.setNow(1000000 + i * 5000);
    await f.scheduler.tick();
  }
  assert.equal(discoveries, 1);
  assert.deepEqual(f.scheduler.refillDiscovery, { state: 'DEFERRED', priority: 'review', retryAt: 1060000 });
  assert.deepEqual(f.store.active(1), before);
  assert.deepEqual(logs, [{ event: 'refill_discovery_deferred', state: 'DEFERRED', priority: 'review', retryAt: 1060000,
    cause: { constructor: 'Error', code: 'github_rate_limited' } }]);
  assert.equal(f.store.active(1).status, 'queued');
  assert.deepEqual(f.started, []);
});

test('exhausted review discovery is latched across both tick entrypoints until the exact accounting wake', async t => {
  const f = await queuedReviews(t, [{ pr: 1, created: 1 }, { pr: 2, created: 2 }]);
  const running = f.store.active(2);
  f.store.update(running.id, { status: 'running', run_id: '2-cccccccccccc-12345678' });
  const queued = f.store.active(1), logs = [];
  const budget = new GitHubBudget({ store: f.store, scope: 'discovery-wake', now: f.scheduler.now,
    limits: { presentation: { charge: 1, wire: 1, floor: 0 },
      review: { charge: 1, wire: 1, floor: 0 }, merge: { charge: 100, wire: 100, floor: 0 } } });
  budget.settle(budget.reserve('review'), { status: 200 });
  const usage = budget.snapshot().total;
  let discoveries = 0, polls = 0, maintenance = 0;
  const paginate = f.github.paginate;
  f.github.paginate = async (...args) => {
    discoveries++;
    const receipt = budget.reserve('review');
    budget.settle(receipt, { status: 200 });
    return paginate(...args);
  };
  f.scheduler.fetch = async (_url, { method }) => {
    if (method === 'GET') polls++;
    return { status: method === 'GET' ? 200 : 202, ok: true, json: async () => ({ state: 'running' }) };
  };
  const cancellationMaintenance = f.scheduler.resumeCancellationTerminals.bind(f.scheduler);
  f.scheduler.resumeCancellationTerminals = async () => { maintenance++; return cancellationMaintenance(); };
  f.scheduler.log = row => logs.push(row);
  for (let i = 0; i < 6; i++) {
    f.setNow(1000000 + i * 5000);
    await f.scheduler.tick();
  }
  assert.equal(discoveries, 1, 'neither execution pump nor maintenance retries local admission each tick');
  assert.equal(polls, 6);
  assert.equal(maintenance, 6);
  assert.deepEqual(f.store.active(1), queued);
  assert.deepEqual(budget.snapshot().total, usage, 'refused discovery does not reset or add accounting');
  assert.equal(f.github.retryAt, undefined, 'no global GitHub backoff is introduced');
  assert.equal(logs.filter(row => row.event === 'refill_discovery_deferred').length, 1);
  const retryAt = f.scheduler.refillDiscovery.retryAt;
  f.setNow(retryAt - 1);
  f.scheduler.lastReconcileAt = f.scheduler.now();
  await f.scheduler.tick();
  assert.equal(discoveries, 1);
  f.setNow(retryAt);
  f.scheduler.lastReconcileAt = f.scheduler.now();
  await f.scheduler.tick();
  assert.equal(discoveries, 2, 'the exact durable-accounting deadline permits discovery');
  assert.equal(f.scheduler.refillDiscovery, null);
  assert.equal(f.store.active(1).status, 'running');
  assert.equal(f.store.active(1).attempt, queued.attempt);
});

test('unexpected discovery failures reject real ticks and diagnostics contain only safe structure', async t => {
  const f = await queuedReviews(t, [{ pr: 1, created: 1 }]), logs = [];
  f.scheduler.log = row => logs.push(row);
  const privateCause = Object.assign(new TypeError('secret body'), { code: 'ECONNRESET', secret_key: 'secret value' });
  const failure = Object.assign(new Error('secret message', { cause: privateCause }), { code: 'secret code' });
  f.github.paginate = async () => { throw failure; };
  await assert.rejects(f.scheduler.tick(), error => {
    f.scheduler.recordTickFailure(error);
    return true;
  });
  assert.deepEqual(logs, [{ event: 'scheduler_tick_failed', stage: 'refill_discovery',
    cause: { constructor: 'PriorityDiscoveryUnavailable', cause: { constructor: 'Error',
      cause: { constructor: 'TypeError', code: 'ECONNRESET' } } } }]);
  assert.equal(f.scheduler.refillDiscovery, null);
  assert.equal(f.store.active(1).status, 'queued');
});

test('each real exit refills independently while verdict publication remains serialized', async t => {
  const f = await queuedReviews(t, [1, 2, 3, 4].map(pr => ({ pr, created: pr })), 2);
  const exited = new Set([1]);
  const firstVerdict = Promise.withResolvers(), releaseVerdict = Promise.withResolvers();
  const started = new Map([3, 4].map(pr => [pr, Promise.withResolvers()]));
  const intent = new Map([1, 2].map(pr => [pr, Promise.withResolvers()]));
  const polls = [], publications = [], approvals = [];
  for (const pr of [1, 2]) {
    const row = f.store.active(pr);
    f.store.update(row.id, { status: 'running', run_id: `${row.id}-cccccccccccc-12345678`, check_run_id: row.id + 10 });
  }
  f.scheduler.mode = 'approve';
  f.scheduler.approval = { run: async row => { assert.ok(publications.includes(row.pr)); approvals.push(row.pr); return null; }, disable: async () => {} };
  f.scheduler.attachCi = async () => {};
  f.scheduler.mirror.result = async () => ({ result: { pass: true }, priorFindingIds: [], findings: [], diff: '' });
  f.scheduler.fetch = async (url, { method }) => {
    const id = Number(url.split('/').at(-1).split('-')[0]);
    const row = f.store.review(id);
    if (method === 'GET') {
      polls.push(row.pr);
      return { ok: true, status: 200, json: async () => ({ state: exited.has(row.pr) ? 'exited' : 'running', exitCode: 0 }) };
    }
    if (method === 'POST') {
      assert.ok(f.store.counts().running <= 2);
      started.get(row.pr)?.resolve();
    }
    if (method === 'DELETE') {
      assert.equal(row.status, 'publishing');
      assert.ok(JSON.parse(row.result_json).publication_id);
      intent.get(row.pr)?.resolve();
    }
    return { ok: true, status: method === 'POST' ? 202 : 200 };
  };
  f.scheduler.verdict.evaluate = async review => {
    if (review.publication_id === f.store.active(1)?.id) {
      firstVerdict.resolve();
      await releaseVerdict.promise;
    }
    return { decision: 'approve' };
  };
  f.scheduler.publisher.completed = async row => { publications.push(row.pr); return 'success'; };
  const firstTick = f.scheduler.tick();
  await Promise.all([firstVerdict.promise, started.get(3).promise]);
  assert.equal(f.store.active(1).status, 'publishing');
  assert.equal(f.store.active(2).status, 'running');
  assert.equal(f.store.counts().running, 2);
  assert.deepEqual(publications, []);
  assert.deepEqual(approvals, []);
  exited.add(2);
  const secondTick = f.scheduler.tick();
  await Promise.all([started.get(4).promise, intent.get(2).promise]);
  assert.equal(f.store.active(2).status, 'publishing');
  assert.equal(f.store.counts().running, 2);
  assert.deepEqual(publications, []);
  assert.deepEqual(approvals, []);
  assert.equal(polls.filter(pr => pr === 1).length, 1, 'blocked publication retains its per-row poll lease');
  assert.ok(f.store.review(f.store.active(2).id).execution_exit_json);
  releaseVerdict.resolve();
  await Promise.all([firstTick, secondTick]);
  assert.deepEqual(publications, [1, 2]);
  assert.equal(f.store.latest(1).status, 'completed');
  assert.equal(f.store.latest(2).status, 'completed');
});

for (const supersede of [false, true]) {
  test(`${supersede ? 'superseding' : 'cancelling'} an exited publishing review fences its blocked verdict`, async t => {
    const f = await fixture(t);
    let row = f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' }, 1);
    row = f.store.update(row.id, { status: 'running', run_id: '1-cccccccccccc-12345678', check_run_id: 11 });
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    f.scheduler.attachCi = async () => {};
    f.scheduler.mirror.result = async () => ({ result: { pass: true }, priorFindingIds: [], findings: [], diff: '' });
    f.scheduler.fetch = async () => ({ ok: true, status: 200, json: async () => ({ state: 'exited', exitCode: 0 }) });
    f.scheduler.verdict.evaluate = async () => { entered.resolve(); await release.promise; return { decision: 'approve' }; };
    let publications = 0, approvals = 0;
    f.scheduler.publisher.completed = async () => { publications++; return 'success'; };
    f.scheduler.approval = { disable: async () => {}, run: async () => { approvals++; } };
    f.scheduler.mode = 'approve';
    const polling = f.scheduler.poll(row);
    const rejected = assert.rejects(polling, /publication_cancelled/u);
    await entered.promise;
    assert.equal(f.store.review(row.id).status, 'publishing');
    const operation = f.scheduler.handle(supersede
      ? { type: 'enqueue', pr: 1, head_sha: sha('b'), base_ref: 'main', due: 0, reason: 'synchronize' }
      : { type: 'cancel', pr: 1, reason: 'closed' });
    release.resolve();
    await Promise.all([rejected, operation]);
    assert.equal(f.store.review(row.id).status, 'cancelled');
    assert.equal(publications, 0);
    assert.equal(approvals, 0);
    assert.equal(f.store.active(1)?.head_sha, supersede ? sha('b') : undefined);
  });
}

test('a blocked maintenance queue does not prevent tick execution polling and refill', async t => {
  const f = await queuedReviews(t, [1, 2].map(pr => ({ pr, created: pr })), 1);
  let row = f.store.active(1);
  row = f.store.update(row.id, { status: 'running', run_id: '1-cccccccccccc-12345678', check_run_id: 11 });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), started = Promise.withResolvers();
  const maintenance = f.scheduler.serialize(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  f.scheduler.attachCi = async () => {};
  f.scheduler.mirror.result = async () => ({ result: { pass: false }, priorFindingIds: [], findings: [], diff: '' });
  f.scheduler.publisher.completed = async () => 'neutral';
  f.scheduler.fetch = async (_url, { method }) => {
    if (method === 'POST') started.resolve();
    return { ok: true, status: method === 'POST' ? 202 : 200, json: async () => ({ state: 'exited', exitCode: 0 }) };
  };
  const tick = f.scheduler.tick();
  await started.promise;
  assert.equal(f.store.review(row.id).status, 'publishing');
  assert.equal(f.store.counts().running, 1);
  assert.equal(f.store.active(2).status, 'running');
  release.resolve();
  await Promise.all([tick, maintenance]);
  assert.equal(f.store.review(row.id).status, 'completed');
});

test('starting reservations bound capacity without blocking another runner poll or setup', async t => {
  const f = await queuedReviews(t, [1, 2, 3].map(pr => ({ pr, created: pr })), 2);
  const preparing = Promise.withResolvers(), release = Promise.withResolvers(), second = Promise.withResolvers();
  f.scheduler.mirror.prepare = async row => {
    if (row.pr === 1) { preparing.resolve(); await release.promise; }
    return { base_sha: sha('d') };
  };
  let polled = 0;
  f.scheduler.fetch = async (url, { method }) => {
    if (method === 'POST' && url.includes('/2-')) second.resolve();
    if (method === 'GET') polled++;
    return { ok: true, status: method === 'POST' ? 202 : 200, json: async () => ({ state: 'running' }) };
  };
  const firstTick = f.scheduler.tick();
  await Promise.all([preparing.promise, second.promise]);
  await f.scheduler.starting.get(f.store.active(2).id);
  const secondTick = f.scheduler.tick();
  await secondTick;
  assert.equal(polled, 1, 'unfinished setup does not hide the other live runner');
  assert.equal(f.store.counts().running, 2);
  assert.equal(f.store.active(3).status, 'queued');
  assert.equal(f.scheduler.starting.size, 1);
  release.resolve();
  await firstTick;
  assert.equal(f.scheduler.starting.size, 0);
});

for (const canonical of [false, true]) {
  test(`restart resumes ${canonical ? 'canonical intent' : 'durable exit before intent'} without another model`, async t => {
    const f = await fixture(t);
    let row = f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' }, 1);
    row = f.store.update(row.id, { status: 'running', run_id: '1-cccccccccccc-12345678', check_run_id: 11 });
    const exit = { state: 'exited', exitCode: 0 };
    row = f.store.executionExited(row, exit);
    const review = { result: { pass: false }, priorFindingIds: [], findings: [], diff: 'durable diff' };
    if (canonical) f.store.publicationIntent(row, review);
    let evidenceReads = 0, publications = 0;
    const recovered = new Scheduler({ store: f.store, github: f.github,
      publisher: { ...f.scheduler.publisher, completed: async () => { publications++; return 'neutral'; } },
      mirror: { result: async (_row, receipt) => { evidenceReads++; assert.deepEqual(receipt, exit); return review; } },
      fetchImpl: async (_url, { method }) => { assert.equal(method, 'DELETE'); return { ok: true, status: 200 }; } });
    recovered.attachCi = async () => {};
    await recovered.recover();
    assert.equal(evidenceReads, canonical ? 0 : 1);
    assert.equal(publications, 1);
    assert.equal(f.store.review(row.id).status, 'completed');
    assert.equal(f.store.all('SELECT id FROM reviews').length, 1);
    assert.equal(f.store.review(row.id).result_json.includes('durable diff'), false, 'completed evidence drops the publication-only diff');
  });
}
test('newer head cancels running reviewer and its check', async (t) => {
  const f = await fixture(t);
  const old = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('a'), due: 0, reason: 'opened' });
  f.store.update(old.id, { status: 'running', run_id: '1-aaaaaaaaaaaa-12345678' });
  await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('b'), due: 1, reason: 'synchronize' });
  assert.equal(f.store.review(old.id).status, 'cancelled');
  assert.ok(f.calls.some(([method, path]) => method === 'DELETE' && path.endsWith(old.id + '-aaaaaaaaaaaa-12345678')));
  assert.ok(f.calls.some(([kind, id, conclusion]) => kind === 'check' && id === old.id && conclusion === 'cancelled'));
});
test('pre-start re-read cancels stale, closed and unapproved draft heads', async (t) => {
  const f = await fixture(t);
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('a'), due: 0, reason: 'opened' });
  await f.scheduler.start(row);
  assert.equal(f.store.review(row.id).reason, 'superseded');
  assert.equal(f.calls.some(([method]) => method === 'POST'), false);
  for (const state of ['closed', 'draft']) {
    f.github.request = async () => ({ state: state === 'closed' ? 'closed' : 'open', draft: state === 'draft', head: { sha: sha('a'), repo: { full_name: f.github.repo } }, base: { ref: 'main', repo: { full_name: 'example-org/example-project' } } });
    const next = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('a'), due: 0, reason: 'opened' });
    await f.scheduler.start(next); assert.equal(f.store.review(next.id).reason, state);
  }
});
test('reconcile enqueues a missed non-draft same-repo head', async (t) => {
  const f = await fixture(t);
  f.github.paginate = async (path) => path.includes('/pulls?') ? [{ number: 9, draft: false, head: { sha: sha('a'), ref: 'feature', repo: { full_name: f.github.repo } }, base: { ref: 'main' } }] : [];
  await f.scheduler.reconcile();
  assert.equal(f.store.active(9).reason, 'reconcile');
});
test('restart recovery fails old evidence and retries once', async (t) => {
  const f = await fixture(t);
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('a'), due: 0, reason: 'opened' });
  f.store.update(row.id, { status: 'running', run_id: '1-aaaaaaaaaaaa-12345678' });
  await f.scheduler.recover();
  assert.equal(f.store.review(row.id).reason, 'restart');
  assert.equal(f.store.active(1).attempt, 2);
  const second = f.store.active(1); f.store.update(second.id, { status: 'running' });
  await f.scheduler.recover(); assert.equal(f.store.active(1), undefined);
});
test('off mode ignores enqueue and reconcile', async (t) => {
  const f = await fixture(t); f.scheduler.mode = 'off';
  await f.scheduler.handle({ type: 'enqueue', pr: 1, head_sha: sha('a'), due: 0, reason: 'opened' });
  await f.scheduler.reconcile(); await f.scheduler.tick(); assert.equal(f.store.counts().queued, 0);
});

test('lost runner is neutral and re-enqueued only once', async (t) => {
  const f = await fixture(t);
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('a'), due: 0, reason: 'opened' });
  const running = f.store.update(row.id, { status: 'running', run_id: '1-aaaaaaaaaaaa-12345678' });
  f.scheduler.fetch = async () => ({ status: 404 });
  await f.scheduler.poll(running);
  assert.equal(f.store.review(row.id).reason, 'runner_lost');
  assert.equal(f.store.active(1).attempt, 2);
});

test('completed execution re-checks head, persists findings and publishes once after transient check failure', async (t) => {
  const f = await fixture(t);
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
  let running = f.store.update(row.id, { status: 'running', run_id: '1-cccccccccccc-12345678' });
  const runnerCalls = [];
  f.scheduler.fetch = async (_url, { method }) => {
    runnerCalls.push(method);
    if (method === 'DELETE') {
      assert.ok(JSON.parse(f.store.review(row.id).result_json).result);
      return { status: 200, ok: true };
    }
    assert.equal(runnerCalls.filter((call) => call === 'GET').length, 1, 'consumed results must not be polled again');
    return { status: 200, ok: true, json: async () => ({ state: 'exited', exitCode: 0 }) };
  };
  f.scheduler.mirror.result = async () => ({ result: { pass: true }, priorFindingIds: [], diff: 'fixture diff',
    findings: [{ id: null, status: 'new', severity: 'P2', file: 'src/file.mjs', line: 1, title: 'bug', scenario: 'broken contract' }] });
  let attempts = 0;
  f.scheduler.publisher.completed = async () => { if (attempts++ === 0) throw new Error('transient'); return 'failure'; };
  await assert.rejects(f.scheduler.poll(running));
  running = f.store.review(row.id);
  await f.scheduler.poll(running);
  assert.equal(f.store.review(row.id).status, 'completed');
  assert.equal(f.store.review(row.id).conclusion, 'failure');
  assert.deepEqual(f.store.findings(1).map((finding) => finding.id), ['F1']);
  assert.deepEqual(runnerCalls, ['GET', 'DELETE']);
});

test('a failed enqueue-time check POST cannot lose durable queued work', async (t) => {
  const f = await fixture(t);
  let creates = 0;
  f.scheduler.publisher.queued = async (row) => {
    if (creates++ === 0) throw new Error('unavailable');
    return f.store.update(row.id, { check_run_id: 99 });
  };
  await assert.rejects(f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' }));
  const row = f.store.active(1);
  assert.equal(row.status, 'queued');
  await f.scheduler.start(row);
  assert.equal(f.store.review(row.id).check_run_id, 99);
  assert.equal(f.store.review(row.id).status, 'running');
});

test('a stale pre-start request cannot cancel the newer queued head', async (t) => {
  const f = await fixture(t);
  const old = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('a'), due: 0, reason: 'opened' });
  f.github.request = async () => {
    await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('b'), due: 0, reason: 'synchronize' });
    return { state: 'open', draft: false, head: { sha: sha('b'), repo: { full_name: f.github.repo } }, base: { ref: 'main', repo: { full_name: 'example-org/example-project' } } };
  };
  await f.scheduler.start(old);
  assert.equal(f.store.active(1).head_sha, sha('b'));
  assert.equal(f.store.active(1).status, 'queued');
});

test('cancel and newer head during CI pagination prevent old publication and finding writes', async (t) => {
  const f = await fixture(t);
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
  const running = f.store.update(row.id, { status: 'running', run_id: '1-cccccccccccc-12345678' });
  f.scheduler.fetch = async () => ({ status: 200, ok: true, json: async () => ({ state: 'exited' }) });
  f.scheduler.mirror.result = async () => ({ result: { pass: true }, priorFindingIds: [], diff: '',
    findings: [{ id: null, status: 'new', severity: 'P2', file: 'src/file.mjs', line: 1, title: 'bug', scenario: 'broken' }] });
  let release, entered;
  const waiting = new Promise((done) => { entered = done; });
  f.github.paginate = async () => { entered(); return new Promise((done) => { release = () => done([]); }); };
  let posts = 0; f.scheduler.publisher.completed = async () => { posts++; return 'failure'; };
  const poll = f.scheduler.poll(running);
  await waiting;
  const cancel = f.scheduler.handle({ type: 'cancel', pr: 1, reason: 'superseded' });
  const newer = f.scheduler.handle({ type: 'enqueue', pr: 1, head_sha: sha('b'), due: 0, reason: 'synchronize' });
  release(); await Promise.all([poll, cancel, newer]);
  assert.equal(posts, 0);
  assert.equal(f.store.findings(1).length, 0);
  assert.equal(f.store.review(row.id).status, 'cancelled');
  assert.equal(f.store.active(1).head_sha, sha('b'));
});

test('reconcile ignores skipped and neutral draft placeholders on a ready head', async (t) => {
  for (const conclusion of ['skipped', 'neutral']) {
    const f = await fixture(t);
    f.github.paginate = async (path) => path.includes('/pulls?') ? [{ number: 9, draft: false, head: { sha: sha('a'), ref: 'feature', repo: { full_name: f.github.repo } }, base: { ref: 'main' } }]
      : [{ app: { id: 1001 }, head_sha: sha('a'), conclusion, output: { title: 'codex-review skipped · draft · aaaaaaaaaaaa' } }];
    await f.scheduler.reconcile();
    assert.equal(f.store.active(9).reason, 'reconcile');
  }
});

test('startup and periodic reconciliation retry received deliveries with bounded attempts', async (t) => {
  const f = await fixture(t);
  const payload = { repository: { full_name: f.github.repo }, action: 'completed',
    workflow_run: { name: 'CI', head_sha: sha('a'), head_branch: 'feature', conclusion: 'success' } };
  f.store.receiveDelivery('retry-success', 'workflow_run', payload, 1);
  f.github.paginate = async () => { throw new Error('transient resolution failure'); };
  await f.scheduler.recover();
  assert.equal(f.store.get('SELECT attempts FROM deliveries WHERE id=?', 'retry-success').attempts, 1);
  assert.equal(f.store.get('SELECT state FROM deliveries WHERE id=?', 'retry-success').state, 'received');
  f.setNow(1060001); f.github.paginate = async () => [];
  await f.scheduler.reconcile();
  assert.equal(f.store.get('SELECT state FROM deliveries WHERE id=?', 'retry-success').state, 'processed');
  f.store.receiveDelivery('retry-fail', 'workflow_run', payload, 1);
  f.github.paginate = async () => { throw new Error('persistent failure'); };
  for (const now of [1120001, 1180002, 1240003, 1300004]) {
    f.setNow(now); await f.scheduler.recover();
  }
  assert.equal(f.store.get('SELECT attempts FROM deliveries WHERE id=?', 'retry-fail').attempts, 3);
  assert.equal(f.store.get('SELECT state FROM deliveries WHERE id=?', 'retry-fail').state, 'received');
});

test('failed delivery recovers on a tick within thirty seconds without redelivery or a sweep', async (t) => {
  const f = await fixture(t);
  const payload = { repository: { full_name: f.github.repo }, action: 'completed',
    workflow_run: { name: 'CI', head_sha: sha('a'), head_branch: 'feature', conclusion: 'success' } };
  f.store.receiveDelivery('tick-retry', 'workflow_run', payload, f.scheduler.now());
  f.github.paginate = async () => { throw new Error('transient'); };
  await assert.rejects(f.scheduler.processDelivery('tick-retry'), /transient/);
  f.github.paginate = async () => [];
  f.scheduler.lastReconcileAt = f.scheduler.now();
  f.setNow(1015000);
  await f.scheduler.tick();
  assert.equal(f.store.get('SELECT state FROM deliveries WHERE id=?', 'tick-retry').state, 'processed');
});

test('full sweeps stay at five minutes while bounded lane probes use the configured fast cadence', async (t) => {
  const f = await fixture(t), probes = [];
  let sweeps = 0;
  f.github.paginate = async () => { sweeps++; return []; };
  const candidate = { number: 1, state: 'open', draft: false, base: { ref: 'main' },
    head: { sha: sha('a'), repo: { full_name: f.github.repo } } };
  f.scheduler.mode = 'approve'; f.scheduler.approval = {};
  f.scheduler.shepherd = { inspect: async (number) => {
    probes.push(number); return { pr: { ...candidate, number }, conflicting: false, behindBy: 0 };
  } };
  f.scheduler.laneCandidates = [candidate, { ...candidate, number: 2 }];
  f.scheduler.lastReconcileAt = f.scheduler.lastLaneReconcileAt = f.scheduler.now();
  f.setNow(1059999); await f.scheduler.tick();
  assert.deepEqual(probes, []);
  f.setNow(1060000); await f.scheduler.tick();
  f.setNow(1120000); await f.scheduler.tick();
  assert.deepEqual(probes, [1, 2]);
  assert.equal(sweeps, 0);
  f.setNow(1300000); await f.scheduler.tick();
  assert.equal(sweeps, 1);
  f.store.selectMergeBatch({ id: 'inflight', generation: 1, kind: 'single', state: 'testing',
    selected_at: f.scheduler.now(), updated_at: f.scheduler.now(), target_pr: 1, head_sha: sha('a'),
    members: [{ pr: 1, head_sha: sha('a'), review_id: null, publication_id: null,
      github_review_id: null, ci_run_id: null, ci_attempt: null, pull_request_id: null, priority: null, created_at: null }] });
  f.setNow(1360000); await f.scheduler.tick();
  assert.deepEqual(probes, [1, 2, 1]);
  assert.equal(sweeps, 1);
  f.store.retireMergeBatch('inflight', 1, 'invalidated', f.scheduler.now());
  for (const reconcileIntervalMs of [0, 59999, 300001, 60000.5, NaN]) {
    assert.throws(() => new Scheduler({ store: f.store, reconcileIntervalMs }), /reconcile interval/);
  }
  const configured = new Scheduler({ store: f.store, now: f.scheduler.now, mode: 'approve',
    approval: {}, shepherd: f.scheduler.shepherd, reconcileIntervalMs: 120000 });
  configured.laneCandidates = [candidate];
  configured.lastReconcileAt = configured.lastLaneReconcileAt = configured.now();
  f.setNow(1479999); await configured.tick();
  assert.deepEqual(probes, [1, 2, 1]);
  f.setNow(1480000); await configured.tick();
  assert.deepEqual(probes, [1, 2, 1, 1]);
});

test('only an open eligible exact-head approved PR keeps the fast safety-net sweep awake', async (t) => {
  const f = await fixture(t);
  const pr = { number: 1, state: 'open', draft: false, labels: [], body: '', base: { ref: 'main' },
    head: { sha: sha('c'), repo: { full_name: f.github.repo } } };
  f.github.paginate = async () => [pr];
  const row = f.store.enqueue({ pr: 1, head_sha: pr.head.sha, base_ref: 'main', due: 0, reason: 'opened' }, 1);
  f.store.update(row.id, { status: 'completed' });
  f.store.reserveApproval(row, 'PR_1', 1);
  f.store.updateApproval(row.id, { github_review_id: 10, outcome: 'approved' }, 1);
  await f.scheduler.reconcileNow();
  assert.deepEqual(f.scheduler.laneCandidates.map((pr) => pr.number), [1]);
  pr.head.sha = sha('d');
  await f.scheduler.reconcileNow();
  assert.deepEqual(f.scheduler.laneCandidates, []);
  pr.head.sha = sha('c'); pr.labels = [{ name: 'hold' }];
  await f.scheduler.reconcileNow();
  assert.deepEqual(f.scheduler.laneCandidates, []);
  f.github.paginate = async () => [];
  await f.scheduler.reconcileNow();
  assert.deepEqual(f.scheduler.laneCandidates, []);
});

test('an approval recovered during a sweep immediately enables the fast CI fallback', async (t) => {
  const f = await fixture(t);
  nativeApprovalFixture(f);
  const { row } = completedApprovalRow(f);
  await f.scheduler.reconcile();
  assert.equal(f.store.approvalForReview(row.id).outcome, 'approved');
  assert.deepEqual(f.scheduler.laneCandidates.map((pr) => pr.number), [1]);
});

async function publicationFixture(t) {
  const f = await fixture(t);
  let row = f.store.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' }, 1);
  row = f.store.update(row.id, { status: 'running', check_run_id: 10, run_id: '1-cccccccccccc-12345678' });
  const review = { repo: f.github.repo, pr: 1, head_sha: sha('c'), base_sha: sha('d'), policy: {},
    priorFindingIds: [], findings: [{ id: null, severity: 'P2', status: 'new', file: 'src/file.mjs',
      line: 99, title: 'bug', scenario: 'broken' }], suggestions: [], diff: '',
    result: { pass: true, reasons: [], evidence: {} } };
  f.store.publicationIntent(row, review);
  f.scheduler.publisher = new Publisher({ github: f.github, store: f.store });
  return { ...f, row, review };
}

for (const exactCarrier of [false, true]) {
  test(`polling publication ${exactCarrier ? 'uses the exact carrier reserve' : 'cannot borrow an unrelated carrier reserve'}`, async (t) => {
    const f = await publicationFixture(t), requests = [];
    const budget = new GitHubBudget({ store: f.store, scope: 'poll-publication', now: () => 1_000_000,
      limits: { presentation: { charge: 2, wire: 2, floor: 0 },
        review: { charge: 3, wire: 3, floor: 0 }, merge: { charge: 100, wire: 100, floor: 0 } } });
    for (let i = 0; i < 3; i++) budget.settle(budget.reserve('review'), { status: 200 });
    f.store.selectMergeBatch({ id: 'poll-carrier', generation: 1, kind: 'batch', state: 'testing',
      selected_at: 1, updated_at: 1, base_sha: sha('d'), head_sha: sha('c'), tree_sha: sha('e'),
      target_pr: exactCarrier ? 1 : 2, carrier_branch: 'integration/poll', sealed: true,
      manifest_digest: 'a'.repeat(64), members: [3, 4].map(pr => ({ pr, head_sha: sha('a'),
        review_id: null, publication_id: null, github_review_id: null, pull_request_id: null,
        ci_run_id: null, ci_attempt: null, priority: null, created_at: null })) });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const github = new GitHubApp({ appId: f.github.appId, repo: f.github.repo, budget,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      fetchImpl: async (input, options) => {
        const path = new URL(input).pathname;
        requests.push({ method: options.method, path, body: options.body && JSON.parse(options.body) });
        if (options.method === 'GET' && path.endsWith('/pulls/1')) {
          return Response.json({ state: 'open', draft: false, head: { sha: sha('c'),
            repo: { full_name: f.github.repo } }, base: { ref: 'main' } });
        }
        if (options.method === 'GET' && path.endsWith('/reviews')) return Response.json([]);
        if (options.method === 'POST' && path.endsWith('/reviews')) return Response.json({ id: 901 });
        if (options.method === 'PATCH' && path.endsWith('/check-runs/10')) return Response.json({});
        throw new Error(`Unexpected publication request: ${options.method} ${path}`);
      } });
    github.cachedToken = { token: 'fixture-token', expiresAt: Date.now() + 3600000 };
    f.scheduler.github = github;
    f.scheduler.publisher = new Publisher({ github, store: f.store });
    if (!exactCarrier) {
      await assert.rejects(f.scheduler.poll(f.row), { code: 'github_budget_deferred' });
      assert.equal(requests.length, 0, 'ordinary publication cannot spend the merge reserve');
      assert.equal(f.store.review(f.row.id).status, 'publishing');
      return;
    }
    await f.scheduler.poll(f.row);
    assert.equal(f.store.review(f.row.id).status, 'completed');
    assert.equal(f.store.review(f.row.id).conclusion, 'failure', 'real findings still block the carrier');
    assert.ok(requests.some(r => r.method === 'PATCH' && r.body.status === 'completed'
      && r.body.conclusion === 'failure'), 'the final native review check publishes through fresh fences');
  });
}

test('a queued sealed carrier starts through real ticks while ordinary discovery is already deferred', async (t) => {
  const f = await fixture(t), requests = [];
  const carrier = f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 1005000, reason: 'opened' }, 1);
  const ordinary = f.store.enqueue({ pr: 2, head_sha: sha('a'), base_ref: 'main', due: 0, reason: 'opened' }, 2);
  const budget = new GitHubBudget({ store: f.store, scope: 'refill-carrier', now: () => 1_000_000,
    limits: { presentation: { charge: 2, wire: 2, floor: 0 },
      review: { charge: 3, wire: 3, floor: 0 }, merge: { charge: 100, wire: 100, floor: 0 } } });
  for (let i = 0; i < 3; i++) budget.settle(budget.reserve('review'), { status: 200 });
  f.store.selectMergeBatch({ id: 'refill-carrier', generation: 1, kind: 'batch', state: 'testing',
    selected_at: 1, updated_at: 1, base_sha: sha('d'), head_sha: sha('c'), tree_sha: sha('e'),
    target_pr: 1, carrier_branch: 'integration/refill', sealed: true, manifest_digest: 'a'.repeat(64),
    members: [3, 4].map(pr => ({ pr, head_sha: sha('a'), review_id: null, publication_id: null,
      github_review_id: null, pull_request_id: null, ci_run_id: null, ci_attempt: null,
      priority: null, created_at: null })) });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const github = new GitHubApp({ appId: f.github.appId, repo: f.github.repo, budget,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    fetchImpl: async (input, options) => {
      const path = new URL(input).pathname;
      requests.push(path);
      assert.equal(options.method, 'GET');
      assert.ok(path.endsWith('/pulls/1'), 'unrelated discovery and ordinary review do not spend the reserve');
      return Response.json({ state: 'open', draft: false, head: { sha: sha('c'),
        repo: { full_name: f.github.repo } }, base: { ref: 'main' } });
    } });
  github.cachedToken = { token: 'fixture-token', expiresAt: Date.now() + 3600000 };
  f.scheduler.github = github;
  f.scheduler.lastReconcileAt = f.scheduler.lastLaneReconcileAt = f.scheduler.now();
  await f.scheduler.tick();
  const deferred = f.scheduler.refillDiscovery;
  assert.equal(deferred.state, 'DEFERRED');
  assert.equal(f.store.review(carrier.id).status, 'queued');
  assert.equal(requests.length, 0, 'review discovery refuses locally before any wire request');
  f.setNow(1005000);
  await f.scheduler.tick();
  assert.equal(f.scheduler.refillDiscovery, deferred, 'carrier start does not clear the review discovery latch');
  assert.equal(f.store.review(carrier.id).status, 'running');
  assert.equal(f.store.review(ordinary.id).status, 'queued');
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1, 'one real start reaches the runner boundary');
  assert.ok(requests.length > 0);
});

test('cancellation during review receipt pagination aborts before POST and never completes', async (t) => {
  const f = await publicationFixture(t); let release, entered; let posts = 0;
  const waiting = new Promise((done) => { entered = done; });
  f.github.paginate = async () => { entered(); return new Promise((done) => { release = () => done([]); }); };
  const request = f.github.request;
  f.github.request = async (method, ...args) => { if (method === 'POST') posts++; return request(method, ...args); };
  const publishing = f.scheduler.serialize(() => f.scheduler.publishNow(f.row, f.review));
  const aborted = assert.rejects(publishing, /publication_cancelled/u);
  await waiting;
  const cancellation = f.scheduler.handle({ type: 'cancel', pr: 1, reason: 'closed' });
  release(); await Promise.all([aborted, cancellation]);
  assert.equal(posts, 0); assert.equal(f.store.review(f.row.id).status, 'cancelled');
});

test('restart resumes original publication after accepted COMMENT or ambiguous create', async (t) => {
  for (const crash of ['after_comment', 'ambiguous_accepted', 'ambiguous_not_accepted']) {
    const f = await publicationFixture(t); let created = 0; let crashed = false; let receipt;
    const request = f.github.request;
    f.github.paginate = async () => {
      if (crashed) throw new Error('simulated process exit');
      return receipt ? [receipt] : [];
    };
    f.github.request = async (method, path, body) => {
      if (method === 'POST') {
        if (!crashed && crash === 'ambiguous_not_accepted') { crashed = true; throw new Error('ambiguous POST'); }
        created++; receipt = { id: 90, user: { id: 1002, login: 'example-review[bot]' },
          commit_id: sha('c'), body: body.body };
        if (!crashed && crash === 'ambiguous_accepted') { crashed = true; throw new Error('ambiguous POST'); }
        return receipt;
      }
      if (method === 'PATCH' && !crashed && crash === 'after_comment') { crashed = true; throw new Error('simulated process exit'); }
      if (method === 'PATCH' && crash === 'ambiguous_accepted' && crashed) throw new Error('simulated process exit');
      return request(method, path, body);
    };
    await assert.rejects(f.scheduler.publishNow(f.row, f.review));
    assert.equal(f.store.review(f.row.id).status, 'publishing');
    f.github.paginate = async () => receipt ? [receipt] : [];
    f.github.request = async (method, path, body) => {
      if (method === 'POST') {
        created++; receipt = { id: 90, user: { id: 1002, login: 'example-review[bot]' },
          commit_id: sha('c'), body: body.body }; return receipt;
      }
      return request(method, path, body);
    };
    const recovered = new Scheduler({ store: f.store, github: f.github,
      publisher: new Publisher({ github: f.github, store: f.store }),
      mirror: { result: () => { throw new Error('must not rerun reviewer'); } } });
    await recovered.recover();
    assert.equal(created, 1, crash);
    assert.equal(f.store.all('SELECT id FROM reviews').length, 1);
    const completed = f.store.review(f.row.id);
    assert.equal(completed.status, 'completed');
    assert.equal(JSON.parse(completed.result_json).publication_id, f.row.id);
    assert.equal(JSON.parse(completed.result_json).publication_state, 'completed');
    assert.match(receipt.body, new RegExp(`<!-- codex-review review ${f.row.id} -->`, 'u'));
  }
});

test('conversation evidence survives a completed non-pass review after the findings were judged', async (t) => {
  const f = await fixture(t);
  const judged = f.store.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' }, 1);
  f.store.update(judged.id, { status: 'completed', conclusion: 'success', started_at: 100, finished_at: 200,
    result_json: JSON.stringify({ result: { pass: true } }) });
  f.store.saveFindings(judged, [{ id: null, severity: 'P2', status: 'new', file: 'a.mjs', line: 3,
    title: 'Open defect', scenario: 'Evidence is needed' }]);
  const neutral = f.store.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'comment_rereview' }, 300);
  f.store.update(neutral.id, { status: 'running', started_at: 300 });
  f.store.publicationIntent(neutral, { result: { pass: false }, findings: [] });
  f.store.update(neutral.id, { status: 'completed', conclusion: 'neutral', started_at: 300, finished_at: 400 });
  let prepared;
  f.scheduler.mirror.prepare = async (...args) => { prepared = args; return { base_sha: sha('d') }; };
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'comment_rereview' });
  await f.scheduler.start(row);
  assert.equal(prepared[2][0].last_review_id, judged.id);
  assert.equal(prepared[3].id, neutral.id);
  assert.equal(prepared[4], 100);
  assert.equal(f.store.review(row.id).status, 'running');
});

test('conversation evidence without open findings starts after the previous completed review finished', async (t) => {
  const f = await fixture(t);
  const previous = f.store.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' }, 1);
  f.store.update(previous.id, { status: 'completed', conclusion: 'success', started_at: 100, finished_at: 200 });
  let prepared;
  f.scheduler.mirror.prepare = async (...args) => { prepared = args; return { base_sha: sha('d') }; };
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'comment_rereview' });
  await f.scheduler.start(row);
  assert.deepEqual(prepared[2], []);
  assert.equal(prepared[3].id, previous.id);
  assert.equal(prepared[4], 200);
  assert.equal(f.store.review(row.id).status, 'running');
});

test('stalled mirror fetch aborts, records neutral timeout, and leaves serialized work independent', async (t) => {
  const f = await fixture(t);
  let killed = false;
  const mirror = new Mirror({ github: { token: async () => 'fixture-token' }, timeouts: { fetch: 10, git: 10 },
    executeImpl: async (command, args, options) => new Promise((accept, reject) => {
      assert.equal(options.killSignal, 'SIGKILL');
      options.signal.addEventListener('abort', () => { killed = true; reject(new Error('aborted')); }, { once: true });
    }) });
  f.scheduler.mirror.prepare = async () => mirror.fetchHead(1);
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
  const hold = setTimeout(() => {}, 100);
  try {
    const stalled = f.scheduler.start(row);
    let advanced = false;
    const next = f.scheduler.serialize(() => { advanced = true; });
    await Promise.all([stalled, next]);
    assert.equal(killed, true); assert.equal(advanced, true);
    assert.equal(f.store.review(row.id).reason, 'mirror_timeout');
    assert.equal(f.store.review(row.id).conclusion, 'neutral');
  } finally { clearTimeout(hold); }
});

test('workspace budget rejection produces controlled neutral workspace_too_large', async (t) => {
  const f = await fixture(t);
  f.scheduler.mirror.prepare = async () => { throw Object.assign(new Error('Workspace budget exceeded'), { code: 'workspace_too_large' }); };
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
  await f.scheduler.start(row);
  assert.equal(f.store.review(row.id).reason, 'workspace_too_large');
  assert.equal(f.store.review(row.id).conclusion, 'neutral');
});

for (const reason of ['policy_unavailable', 'verdict_unavailable']) {
  test(`missing trusted main input publishes neutral ${reason} without starting a reviewer`, async (t) => {
    const f = await fixture(t);
    f.scheduler.mirror.prepare = async () => { throw new Error(reason); };
    const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
    await f.scheduler.start(row);
    assert.equal(f.store.review(row.id).reason, reason);
    assert.equal(f.store.review(row.id).conclusion, 'neutral');
    assert.deepEqual(f.calls, [['check', row.id, 'neutral', reason]]);
  });
}

function verdictReport(f) {
  return { repo: f.github.repo, pr: 1, head_sha: sha('c'), base_sha: sha('d'),
    policy: { revision: sha('e') }, priorFindingIds: [], priorFindings: [], replies: [],
    prTitle: 'Change', reportText: 'No findings.', findings: [], suggestions: [], diff: '',
    review_route: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
    result: { pass: true, reasons: [], evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } } };
}
function publicationRow(f, attempt = 1) {
  const row = f.store.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: attempt === 1 ? 'opened' : 'ambiguous_rereview', attempt }, 1);
  return f.store.update(row.id, { status: 'running', check_run_id: row.id + 10 });
}
test('ambiguous verdict re-reviews exactly once then waits without approval', async (t) => {
  const f = await fixture(t); let judges = 0;
  f.scheduler.verdict.evaluate = async () => { judges++; return { decision: 'ambiguous', model: 'jev-1.13.0' }; };
  f.scheduler.publisher.completed = async () => 'neutral';
  f.scheduler.approval = { run: () => assert.fail('Ambiguity cannot approve'), disable: async () => {} };
  const first = publicationRow(f);
  const report = verdictReport(f); f.store.publicationIntent(first, report);
  await f.scheduler.publishNow(first, report);
  const second = f.store.active(1);
  assert.equal(second.reason, 'ambiguous_rereview'); assert.equal(second.attempt, 1);
  assert.equal(second.ambiguous_rereviews, 1);
  const running = f.store.update(second.id, { status: 'running' });
  const closure = verdictReport(f); f.store.publicationIntent(running, closure);
  await f.scheduler.publishNow(running, closure);
  assert.equal(judges, 2); assert.equal(f.store.active(1), undefined);
  assert.equal(closure.waitingForHuman, true);
});
test('requested second ambiguity parks recovery; only a new explicit request starts another cycle', async (t) => {
  const f = await fixture(t); nativeApprovalFixture(f);
  const { row: old } = completedApprovalRow(f);
  let judges = 0;
  f.scheduler.verdict.evaluate = async () => { judges++; return { decision: 'ambiguous', model: 'jev-1.13.0' }; };
  f.scheduler.publisher.completed = async () => 'neutral';
  f.store.receiveDelivery('parked-request', 'check_run', rerequestPayload(f), f.scheduler.now());
  await f.scheduler.processDelivery('parked-request');
  for (let i = 0; i < 2; i++) {
    const row = f.store.update(f.store.active(1).id, { status: 'running' });
    const report = verdictReport(f); f.store.publicationIntent(row, report);
    await f.scheduler.publishNow(row, report);
  }
  const request = f.store.get('SELECT * FROM rerequests');
  assert.equal(judges, 2);
  assert.equal(request.parked, 1);
  assert.equal(request.satisfied_by_review_id, null);
  assert.equal(f.scheduler.hasPendingEnqueue(old), true, 'Parking retains the old approval fence');
  for (let i = 1; i <= 3; i++) {
    f.setNow(request.next_attempt_at + i * 7200000);
    await f.scheduler.tick(); await f.scheduler.reconcile(); await f.scheduler.recover();
    assert.equal(f.store.active(1), undefined);
    assert.equal(f.store.get('SELECT attempts FROM rerequests WHERE id=?', request.id).attempts, request.attempts);
  }
  f.store.receiveDelivery('new-explicit-request', 'check_run', rerequestPayload(f), f.scheduler.now());
  await f.scheduler.processDelivery('new-explicit-request');
  const fresh = f.store.active(1);
  assert.equal(fresh.reason, 'rerequested');
  assert.equal(fresh.ambiguous_rereviews, 0);
  assert.equal(f.store.get('SELECT parked FROM rerequests WHERE delivery_id=?', 'new-explicit-request').parked, 0);
  await f.scheduler.processDelivery('new-explicit-request');
  await f.scheduler.reconcileRerequests();
  assert.equal(f.store.active(1).id, fresh.id, 'Exactly one new cycle is queued');
  assert.equal(judges, 2, 'Parked work never calls the judge again');
});
for (const reason of ['auth_failed', 'provider_error', 'max_time', 'workspace_export_failed', 'workspace_too_large', 'verdict_unavailable']) {
  test(`requested neutral ${reason} remains retryable, not parked`, async (t) => {
    const f = await fixture(t); nativeApprovalFixture(f);
    f.store.receiveDelivery('retryable-request', 'check_run', rerequestPayload(f), f.scheduler.now());
    await f.scheduler.processDelivery('retryable-request');
    const first = f.store.active(1);
    f.store.update(first.id, { status: 'completed', conclusion: 'neutral',
      result_json: JSON.stringify({ result: { pass: false, reasons: [reason] }, waitingForHuman: false }) });
    const request = f.store.get('SELECT * FROM rerequests');
    assert.equal(request.parked, 0); assert.equal(request.satisfied_by_review_id, null);
    f.setNow(request.next_attempt_at); await f.scheduler.reconcileRerequests();
    assert.equal(f.store.active(1).reason, 'rerequest_recovered');
    assert.notEqual(f.store.active(1).id, first.id);
  });
}
test('unavailable verdict is neutral without automatic re-review', async (t) => {
  const f = await fixture(t);
  f.scheduler.verdict.evaluate = async () => ({ decision: 'ambiguous', reason: 'verdict_unavailable' });
  f.scheduler.publisher.completed = async () => 'neutral';
  const row = publicationRow(f), report = verdictReport(f); f.store.publicationIntent(row, report);
  await f.scheduler.publishNow(row, report);
  assert.deepEqual(report.result.reasons, ['verdict_unavailable']);
  assert.equal(f.store.active(1), undefined); assert.equal(report.waitingForHuman, false);
});
test('approve publication completes its check before native approval; advisory does not approve', async (t) => {
  for (const mode of ['advisory', 'approve']) {
    const f = await fixture(t); f.scheduler.mode = mode; const order = [];
    f.scheduler.publisher.completed = async () => { order.push('check'); return 'success'; };
    f.scheduler.publisher.updateEvidence = async () => { order.push('evidence'); };
    f.scheduler.approval = { disable: async () => {}, run: async (row, report, guard) => {
      await guard(); assert.equal(f.store.review(row.id).status, 'completed');
      order.push('approve'); return { outcome: 'approved', publication_id: row.publication_id };
    } };
    const row = publicationRow(f), report = verdictReport(f); f.store.publicationIntent(row, report);
    await f.scheduler.publishNow(row, report);
    assert.deepEqual(order, mode === 'approve' ? ['check', 'approve', 'evidence'] : ['check']);
  }
});
test('proven main-merge carry publishes a new identity without runner or judge calls', async (t) => {
  const f = await fixture(t); f.scheduler.mode = 'approve';
  const original = verdictReport(f); original.verdict = { decision: 'approve', model: 'jev-1.13.0' };
  const prior = f.store.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('a'), due: 0, reason: 'opened' }, 1);
  f.store.update(prior.id, { status: 'completed', base_sha: sha('d'), result_json: JSON.stringify(original), check_run_id: 10 });
  const native = [];
  f.scheduler.approval = { disable: async () => native.push('disable'), run: async (row, report, guard) => {
    await guard(); native.push(row.publication_id); return { outcome: 'approved' };
  } };
  f.scheduler.publisher.completed = async () => 'success'; f.scheduler.publisher.updateEvidence = async () => {};
  f.scheduler.mirror.carry = async () => ({ ...original, carried_forward_from: sha('a'),
    source_review_head: sha('a'), carry: { main_sha: sha('e') } });
  f.scheduler.mirror.prepare = () => assert.fail('Carry does not run the reviewer');
  f.scheduler.verdict.evaluate = () => assert.fail('Carry does not call the judge');
  f.scheduler.verdict.carry = async () => original.verdict;
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'synchronize' });
  await f.scheduler.start(row);
  const saved = JSON.parse(f.store.review(row.id).result_json);
  assert.equal(saved.publication_id, row.id); assert.notEqual(saved.publication_id, prior.id);
  assert.equal(saved.carried_forward_from, sha('a')); assert.equal(f.store.review(row.id).status, 'completed');
  assert.deepEqual(native, ['disable', row.id]);
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 0);
});
test('changed patch disables the prior arm before starting full closure', async (t) => {
  const f = await fixture(t); const order = [];
  f.scheduler.approval = { disable: async () => order.push('disable') };
  f.scheduler.mirror.carry = async () => null;
  f.scheduler.mirror.prepare = async () => { order.push('review'); return { base_sha: sha('d') }; };
  const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'synchronize' });
  await f.scheduler.start(row);
  assert.deepEqual(order, ['disable', 'review']);
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
});

test('a lost runner execution retry still gets one independent ambiguity re-review', async (t) => {
  const f = await fixture(t);
  const first = publicationRow(f);
  f.scheduler.fetch = async () => ({ status: 404 });
  await f.scheduler.poll(f.store.update(first.id, { run_id: '1-cccccccccccc-12345678' }));
  const retry = f.store.active(1);
  assert.equal(retry.attempt, 2); assert.equal(retry.ambiguous_rereviews, 0);
  f.scheduler.verdict.evaluate = async () => ({ decision: 'ambiguous', model: 'jev-1.13.0' });
  f.scheduler.publisher.completed = async () => 'neutral';
  const running = f.store.update(retry.id, { status: 'running' }), report = verdictReport(f);
  f.store.publicationIntent(running, report);
  await f.scheduler.publishNow(running, report);
  const fresh = f.store.active(1);
  assert.equal(fresh.reason, 'ambiguous_rereview'); assert.equal(fresh.attempt, 1);
  assert.equal(fresh.ambiguous_rereviews, 1);
  f.store.update(fresh.id, { status: 'running', run_id: '3-cccccccccccc-12345678' });
  await f.scheduler.recover();
  const resumed = f.store.active(1);
  assert.equal(resumed.attempt, 2); assert.equal(resumed.ambiguous_rereviews, 1);
  const closureRow = f.store.update(resumed.id, { status: 'running' }), closure = verdictReport(f);
  f.store.publicationIntent(closureRow, closure);
  await f.scheduler.publishNow(closureRow, closure);
  assert.equal(f.store.active(1), undefined); assert.equal(closure.waitingForHuman, true);
});

const botUser = { id: 1002, login: 'example-review[bot]', type: 'Bot' };
function nativeApprovalFixture(f) {
  const calls = [], reviews = [];
  const pr = { number: 1, node_id: 'PR_fixture', state: 'open', draft: false, auto_merge: null,
    head: { sha: sha('c'), ref: 'feature', repo: { full_name: f.github.repo } },
    base: { ref: 'main', repo: { full_name: f.github.repo } } };
  f.github.request = async (method, path, body, guard = async () => {}) => {
    await guard('before_send'); calls.push({ method, path, body });
    if (method === 'GET') return structuredClone(pr);
    if (method === 'POST') {
      const review = { id: reviews.length + 1, user: botUser, state: 'APPROVED', ...body };
      reviews.push(review); return review;
    }
    if (method === 'PUT') { pr.state = 'closed'; pr.merged = true; pr.merged_by = botUser; return { merged: true }; }
    throw new Error('Unexpected mutation');
  };
  f.github.paginate = async (path, key, guard = async () => {}) => {
    await guard();
    if (path.endsWith('/reviews')) return structuredClone(reviews);
    if (path.includes('/pulls?state=open') || path.endsWith('/pulls')) return pr.state === 'open' ? [structuredClone(pr)] : [];
    return [];
  };
  f.github.graphql = async (query, variables, guard = async () => {}) => {
    await guard(); calls.push({ method: 'GRAPHQL', query, variables });
    if (query.includes('disablePullRequestAutoMerge(input:')) {
      pr.auto_merge = null; return { disablePullRequestAutoMerge: { pullRequest: { id: pr.node_id } } };
    }
    throw new Error('Unexpected auto-merge mutation');
  };
  f.scheduler.mode = 'approve';
  f.scheduler.approval = new Approval({ store: f.store, github: f.github, mode: 'approve',
    admit: async () => true, now: () => 1 });
  f.scheduler.publisher.updateEvidence = async () => {};
  return { pr, calls, reviews };
}
function completedApprovalRow(f) {
  const row = publicationRow(f), report = verdictReport(f);
  report.verdict = { decision: 'approve', model: 'jev-1.13.0' };
  f.store.publicationIntent(row, report);
  return { row: f.store.update(row.id, { status: 'completed', conclusion: 'success', result_json: JSON.stringify(report) }), report };
}

async function preparationFixture(t) {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const { row, report } = completedApprovalRow(f);
  await f.scheduler.approveCompleted(row, report);
  const ci = ciProvider(f.github);
  ci.run.conclusion = 'failure';
  const jobs = [
    { name: 'Native admission', status: 'completed', conclusion: 'failure',
      steps: [{ name: 'Native execution deferred until selected', conclusion: 'failure' }] },
    ...['Reuse tested PR tree', 'Rust checks', 'TypeScript', 'Bots', 'PR image / build']
      .map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    { name: 'Rust tests', status: 'completed', conclusion: 'skipped' },
    { name: 'Rust', status: 'completed', conclusion: 'failure' },
  ];
  const paginate = f.github.paginate;
  f.github.paginate = async (path, ...args) => path.endsWith('/attempts/2/jobs') ? jobs : paginate(path, ...args);
  return { ...f, ...native, ...ci, row, report, jobs,
    inspection: { pr: native.pr, conflicting: false, behindBy: 0 } };
}

test('recognized fast-green deferred CI prepares a source but never grants final merge readiness', async (t) => {
  const f = await preparationFixture(t);
  const prepared = await f.scheduler.prepareReadiness(f.inspection);
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.native, 'deferred');
  assert.equal(prepared.row.id, f.row.id);
  assert.equal(prepared.ci.id, 42);
  assert.equal((await f.scheduler.mergeReadiness(f.inspection)).state, 'blocked');
  f.run.conclusion = 'success';
  assert.equal((await f.scheduler.prepareReadiness(f.inspection)).native, 'native');
  assert.equal((await f.scheduler.mergeReadiness(f.inspection)).state, 'ready');
});

for (const scenario of ['unknown', 'cancelled', 'fast-red', 'untrusted', 'queued']) {
  test(`source preparation refuses ${scenario} CI`, async (t) => {
    const f = await preparationFixture(t);
    if (scenario === 'unknown') f.jobs[0].steps[0].name = 'Native admission metadata unavailable';
    if (scenario === 'cancelled') f.run.conclusion = 'cancelled';
    if (scenario === 'fast-red') f.jobs.find((job) => job.name === 'Bots').conclusion = 'failure';
    if (scenario === 'untrusted') f.run.head_repository.full_name = 'attacker/repo';
    if (scenario === 'queued') { f.run.status = 'queued'; f.run.conclusion = null; }
    assert.equal((await f.scheduler.prepareReadiness(f.inspection)).state,
      ['untrusted', 'queued'].includes(scenario) ? 'wait' : 'blocked');
    assert.notEqual((await f.scheduler.mergeReadiness(f.inspection)).state, 'ready');
  });
}

for (const scenario of ['human-veto', 'withdrawal', 'armed', 'missing-native-receipt', 'review-blocked', 'held', 'old-head', 'cancelled', 'new-review', 'pending-enqueue', 'mode']) {
  test(`preparation and final readiness preserve ${scenario} authorization fence`, async (t) => {
    const f = await preparationFixture(t);
    if (scenario === 'human-veto') f.reviews.push({ id: 99, state: 'CHANGES_REQUESTED',
      user: { id: 123, login: 'human', type: 'User' }, submitted_at: '2026-10-22T00:00:00Z' });
    if (scenario === 'withdrawal') f.store.updateApproval(f.row.publication_id, { outcome: 'withdrawn' }, 2);
    if (scenario === 'armed') f.store.updateApproval(f.row.publication_id, { armed: 1 }, 2);
    if (scenario === 'missing-native-receipt') f.store.updateApproval(f.row.publication_id, { github_review_id: null }, 2);
    if (scenario === 'review-blocked') f.store.update(f.row.id, { result_json: JSON.stringify({
      ...f.report, verdict: { decision: 'block' },
    }) });
    if (scenario === 'held') f.pr.labels = [{ name: 'hold' }];
    if (scenario === 'old-head') f.pr.head.sha = sha('b');
    if (scenario === 'cancelled') f.scheduler.pendingCancels.set(f.row.id, 'closed');
    if (scenario === 'new-review') f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'rerequested' }, 2);
    if (scenario === 'pending-enqueue') f.scheduler.pendingEnqueues.add({ type: 'enqueue', pr: 1, head_sha: sha('c') });
    if (scenario === 'mode') f.scheduler.mode = 'advisory';
    assert.notEqual((await f.scheduler.prepareReadiness(f.inspection)).state, 'prepared');
    f.run.conclusion = 'success';
    assert.notEqual((await f.scheduler.mergeReadiness(f.inspection)).state, 'ready');
  });
}

test('preparation rechecks authorization after deferred-job discovery', async (t) => {
  const f = await preparationFixture(t);
  const paginate = f.github.paginate;
  f.github.paginate = async (path, ...args) => {
    const result = await paginate(path, ...args);
    if (path.endsWith('/jobs')) f.scheduler.pendingCancels.set(f.row.id, 'superseded');
    return result;
  };
  assert.equal((await f.scheduler.prepareReadiness(f.inspection)).state, 'wait');
});

test('recorded selected native failure blocks the exact head through a green rerun and restart', async (t) => {
  const f = await preparationFixture(t);
  f.store.recordNativeCiFailure({ pr: 1, head_sha: sha('c'), run_id: 42, run_attempt: 1,
    job_id: 9042, reason: 'native_test_failure' }, 2);
  f.run.conclusion = 'success';
  f.run.run_attempt = 3;
  const restarted = new Scheduler({ store: f.store, github: f.github, mode: 'approve',
    mirror: f.scheduler.mirror, approval: f.scheduler.approval });
  assert.equal((await restarted.prepareReadiness(f.inspection)).state, 'blocked');
  assert.equal((await restarted.mergeReadiness(f.inspection)).state, 'blocked');
  const receipt = f.store.nativeCiFailure(1, sha('c'));
  assert.equal(receipt.run_id, 42);
  assert.equal(receipt.job_id, 9042);
  f.pr.head.sha = sha('b'); f.run.head_sha = sha('b');
  const next = f.store.enqueue({ pr: 1, head_sha: sha('b'), base_ref: 'main', due: 0, reason: 'synchronize' }, 3);
  const row = f.store.update(next.id, { status: 'completed', result_json: JSON.stringify(f.report) });
  f.store.reserveApproval(row, f.pr.node_id, 3);
  f.store.updateApproval(row.id, { github_review_id: 100, outcome: 'approved' }, 3);
  assert.equal((await restarted.prepareReadiness(f.inspection)).state, 'prepared');
  assert.equal((await restarted.mergeReadiness(f.inspection)).state, 'ready');
  assert.deepEqual(f.store.nativeCiFailure(1, sha('c')), receipt, 'old-head failure remains durable');
});

test('unselected deferred source wakes reconciliation without pretending to be final ready', async (t) => {
  const f = await preparationFixture(t);
  f.scheduler.shepherd = { inspect: async () => f.inspection };
  f.scheduler.laneCandidates = [f.pr];
  await f.scheduler.reconcileLane();
  assert.equal(f.scheduler.reconcileSoonAt, f.scheduler.now());
  assert.equal((await f.scheduler.mergeReadiness(f.inspection)).state, 'blocked');
});

test('source status keeps native quarantine run and job receipt visible until a new push', async (t) => {
  const f = await shepherdFixture(t);
  f.add(1);
  f.store.recordNativeCiFailure({ pr: 1, head_sha: sha('a'), run_id: 42, run_attempt: 2,
    job_id: 9042, reason: 'native_test_failure' }, f.scheduler.now());
  await f.scheduler.publishStatus(await f.scheduler.shepherd.inspect(1), null);
  const body = f.api.find((call) => call.body?.body).body.body;
  assert.match(body, /Native CI quarantined for this exact head/u);
  assert.match(body, /run 42, attempt 2, job 9042/u);
  assert.match(body, /A new push is required; a successful rerun does not clear quarantine/u);
  f.api.length = 0;
  f.prs[0].head.sha = sha('b');
  await f.scheduler.publishStatus(await f.scheduler.shepherd.inspect(1), null);
  assert.doesNotMatch(f.api.find((call) => call.body?.body).body.body, /quarantined/u);
});

test('serialized approval completion and tick never adopt an in-flight approval intent', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const first = completedApprovalRow(f);
  const other = structuredClone(native.pr);
  other.number = 2; other.node_id = 'PR_other'; other.head.sha = sha('b');
  const otherRow = f.store.enqueue({ base_ref: 'main', pr: 2, head_sha: other.head.sha, due: 0, reason: 'opened' }, 1);
  const report = { ...verdictReport(f), pr: 2, head_sha: other.head.sha, verdict: { decision: 'approve' } };
  f.store.publicationIntent(f.store.update(otherRow.id, { status: 'running', check_run_id: otherRow.id + 10 }), report);
  const row = f.store.update(otherRow.id, { status: 'completed', conclusion: 'success', result_json: JSON.stringify(report) });
  const request = f.github.request, paginate = f.github.paginate;
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  f.github.request = async (method, path, body, guard) => {
    if (method === 'GET' && path.endsWith('/pulls/2')) return structuredClone(other);
    if (method === 'POST' && path.endsWith('/pulls/1/reviews')) {
      started.resolve(); await release.promise;
    }
    return request(method, path, body, guard);
  };
  f.github.paginate = async (path, ...args) => {
    if (path.includes('/pulls?state=open')) return [structuredClone(native.pr), structuredClone(other)];
    if (path.endsWith('/pulls/2/reviews')) return native.reviews.filter((r) => r.commit_id === other.head.sha);
    return paginate(path, ...args);
  };
  const approving = f.scheduler.serialize(() => f.scheduler.approveCompleted(first.row, first.report));
  await started.promise;
  const waiting = f.scheduler.serialize(() => f.scheduler.approveCompleted(row, report));
  const ticking = f.scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.approval(first.report.publication_id).outcome, 'reserved');
  assert.equal(f.store.approval(report.publication_id), undefined);
  assert.equal(native.reviews.length, 0);
  release.resolve();
  await Promise.all([approving, waiting, ticking]);
  for (const head of [native.pr.head.sha, other.head.sha]) {
    assert.equal(native.reviews.filter((r) => r.commit_id === head && r.state === 'APPROVED').length, 1);
  }
  assert.equal(f.store.approval(first.report.publication_id).outcome, 'approved');
  assert.equal(f.store.approval(report.publication_id).outcome, 'approved');
  assert.equal(native.calls.some((call) => call.method === 'GRAPHQL' || call.method === 'PUT'), false);
});


test('terminal historical arm refusal survives scheduler reconciliation without mutation', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const { row, report } = completedApprovalRow(f);
  f.store.reserveApproval({ ...row, publication_id: report.publication_id }, native.pr.node_id, 1);
  f.store.updateApproval(report.publication_id, { outcome: 'failed:arm' }, 1);
  await f.scheduler.tick();
  assert.equal(f.store.approval(report.publication_id).outcome, 'failed:arm');
  assert.equal(native.calls.some((c) => c.method === 'POST' || c.method === 'PUT' || c.method === 'GRAPHQL'), false);
});

function rerequestPayload(f) {
  return { repository: { full_name: f.github.repo }, action: 'rerequested',
    check_run: { app: { id: Number(f.github.appId) }, name: 'codex-review', head_sha: sha('c'),
      check_suite: { head_branch: 'feature' } } };
}
test('unresolved same-head re-request arriving at APPROVE fences the mutation', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const { row, report } = completedApprovalRow(f);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const request = f.github.request;
  f.github.request = async (method, path, body, guard) => {
    if (method === 'POST' && path.endsWith('/reviews')) {
      started.resolve(); await release.promise;
    }
    return request(method, path, body, guard);
  };
  const publishing = f.scheduler.serialize(() => f.scheduler.approveCompleted(row, report));
  await started.promise;
  f.store.receiveDelivery('same-head-rerequest', 'check_run', rerequestPayload(f), 1);
  const delivery = f.scheduler.processDelivery('same-head-rerequest');
  assert.equal(f.store.active(1), undefined, 'PR resolution/dispatch has not happened');
  assert.equal(f.scheduler.pendingEnqueues.size, 1);
  assert.throws(() => f.scheduler.approvalCheckpoint(row), /publication_cancelled/u);
  release.resolve(); await Promise.all([publishing, delivery]);
  assert.equal(native.reviews.length, 0);
  assert.equal(native.calls.some((call) => call.method === 'POST' || call.method === 'PUT'), false);
  assert.equal(f.store.active(1).reason, 'rerequested');
});
test('failed and exhausted unresolved same-head re-request remains a fence after scheduler restart', async (t) => {
  const f = await fixture(t); nativeApprovalFixture(f);
  const { row } = completedApprovalRow(f);
  f.store.receiveDelivery('failed-rerequest', 'check_run', rerequestPayload(f), 1);
  f.github.paginate = async () => { throw new Error('PR lookup failed'); };
  await assert.rejects(f.scheduler.processDelivery('failed-rerequest'), /PR lookup failed/u);
  assert.equal(f.scheduler.pendingEnqueues.size, 0);
  f.store.run("UPDATE deliveries SET attempts=3 WHERE id='failed-rerequest'");
  const restarted = new Scheduler({ store: f.store, github: f.github, mode: 'approve', now: f.scheduler.now });
  assert.throws(() => restarted.approvalCheckpoint(row), /publication_cancelled/u);
  const foreign = rerequestPayload(f); foreign.check_run.app.id = 42;
  f.store.run("UPDATE deliveries SET payload_json=? WHERE id='failed-rerequest'", JSON.stringify(foreign));
  assert.throws(() => restarted.approvalCheckpoint(row), /publication_cancelled/u, 'Durable accepted request is independent of delivery payload');
});
function armReceipt(f, native) {
  const saved = completedApprovalRow(f);
  f.store.reserveApproval(saved.row, native.pr.node_id, 1);
  f.store.updateApproval(saved.row.publication_id, { armed: 1, outcome: 'approved', github_review_id: 7 }, 1);
  native.pr.auto_merge = { enabled_by: botUser };
  return saved;
}
test('armed reconcile disarms a missed draft transition and retries failed revocation on the next sweep', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const { row } = armReceipt(f, native);
  native.pr.draft = true;
  const graphql = f.github.graphql; let attempts = 0;
  f.github.graphql = async (...args) => {
    if (args[0].includes('disablePullRequestAutoMerge(input:') && ++attempts === 1) throw new Error('Transient revoke failure');
    return graphql(...args);
  };
  await f.scheduler.reconcile();
  assert.equal(attempts, 1); assert.equal(f.store.approval(row.publication_id).armed, 1);
  await f.scheduler.reconcile();
  assert.equal(attempts, 2); assert.equal(f.store.approval(row.publication_id).armed, 0);
  assert.equal(native.pr.auto_merge, null);
  await f.scheduler.reconcile(); assert.equal(attempts, 2);
});
test('armed reconcile retains a receipt until revocation is observed, not just acknowledged', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const { row } = armReceipt(f, native); native.pr.draft = true;
  const graphql = f.github.graphql;
  f.github.graphql = async () => ({ disablePullRequestAutoMerge: { pullRequest: { id: native.pr.node_id } } });
  await f.scheduler.reconcile(); assert.equal(f.store.approval(row.publication_id).armed, 1);
  f.github.graphql = graphql;
  await f.scheduler.reconcile(); assert.equal(f.store.approval(row.publication_id).armed, 0);
});
test('armed reconcile clears closed PR receipts even though open-PR enumeration excludes them', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const { row } = armReceipt(f, native); native.pr.state = 'closed';
  await f.scheduler.reconcile();
  assert.equal(f.store.approval(row.publication_id).armed, 0);
  assert.equal(native.calls.some((call) => call.method !== 'GET'), false);
});
for (const change of ['superseded', 'non-approve', 'human-owned']) {
  test(`armed reconcile handles ${change} independently of review eligibility`, async (t) => {
    const f = await fixture(t), native = nativeApprovalFixture(f);
    const { row, report } = armReceipt(f, native);
    if (change === 'superseded') native.pr.head.sha = sha('b');
    if (change === 'non-approve') {
      report.verdict.decision = 'block'; f.store.update(row.id, { result_json: JSON.stringify(report) });
    }
    if (change === 'human-owned') {
      native.pr.draft = true;
      native.pr.auto_merge = { enabled_by: { id: 1004, login: 'example-owner' } };
    }
    await f.scheduler.reconcile();
    assert.equal(f.store.approval(row.publication_id).armed, 0);
    const disables = native.calls.filter((call) => call.query?.includes('disablePullRequestAutoMerge(input:'));
    assert.equal(disables.length, change === 'human-owned' ? 0 : 1);
    assert.equal(native.calls.some((call) => call.method === 'POST' || call.method === 'PUT'
      || call.query?.includes('enablePullRequestAutoMerge(input:')), false);
  });
}

test('failed armed cleanup is attempted once per sweep even when an eligible queued delivery also needs disarm', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const { row } = armReceipt(f, native);
  native.pr.head.sha = sha('b');
  const payload = rerequestPayload(f); payload.check_run.head_sha = sha('b');
  f.store.receiveDelivery('new-head-rerequest', 'check_run', payload, 1);
  const graphql = f.github.graphql; let attempts = 0;
  f.github.graphql = async (...args) => {
    if (args[0].includes('disablePullRequestAutoMerge(input:') && ++attempts === 1) throw new Error('Transient revoke failure');
    return graphql(...args);
  };
  await f.scheduler.reconcile();
  assert.equal(attempts, 1); assert.equal(f.store.approval(row.publication_id).armed, 1);
  assert.equal(f.store.active(1), undefined);
  assert.equal(f.store.get("SELECT state FROM deliveries WHERE id='new-head-rerequest'").state, 'received');
  f.setNow(1060001);
  await f.scheduler.reconcile();
  assert.equal(attempts, 2); assert.equal(f.store.approval(row.publication_id).armed, 0);
  assert.equal(f.store.active(1).head_sha, sha('b'));
  assert.equal(f.store.get("SELECT state FROM deliveries WHERE id='new-head-rerequest'").state, 'processed');
});

async function exhaustedFenceFixture(t) {
  const f = await fixture(t), native = nativeApprovalFixture(f), saved = completedApprovalRow(f);
  const receivedAt = 90000000;
  f.setNow(receivedAt + 1000);
  f.store.receiveDelivery('exhausted-fence', 'check_run', rerequestPayload(f), receivedAt);
  f.store.run("UPDATE deliveries SET attempts=3 WHERE id='exhausted-fence'");
  f.store.run('UPDATE rerequests SET next_attempt_at=?', receivedAt + 60000);
  return { f, native, ...saved, receivedAt };
}
test('live exhausted approval fence skips only its PR; bookkeeping, pruning and unrelated dispatch proceed', async (t) => {
  const { f, native, row } = await exhaustedFenceFixture(t), logs = [];
  f.scheduler.log = (event) => logs.push(event);
  const other = { number: 2, state: 'open', draft: false, head: { sha: sha('b'), ref: 'other', repo: { full_name: f.github.repo } }, base: { ref: 'main' } };
  const request = f.github.request, paginate = f.github.paginate;
  f.github.request = async (method, path, ...args) => path.endsWith('/pulls/2')
    ? structuredClone(other) : request(method, path, ...args);
  f.github.paginate = async (path, ...args) => path.endsWith('/pulls?state=open')
    ? [structuredClone(native.pr), structuredClone(other)] : paginate(path, ...args);
  const queued = await f.scheduler.enqueue({ base_ref: 'main', pr: 2, head_sha: sha('b'), due: 0, reason: 'opened' });
  assert.throws(() => f.scheduler.approvalCheckpoint(row), /publication_cancelled/u);
  await f.scheduler.tick();
  assert.equal(f.store.review(queued.id).status, 'running');
  assert.equal(f.scheduler.lastReconcileAt, 90001000);
  assert.equal(f.scheduler.lastPruneAt, 90001000);
  assert.equal(f.scheduler.lastTickCompletedAt, 90001000);
  assert.deepEqual(f.scheduler.lastReconcileCounts, { skipped: 1, failed: 0, recovered: 0, deferred: 0 });
  assert.ok(logs.some((event) => event.event === 'reconcile_pr_skipped' && event.pr === 1));
  assert.equal(native.calls.some((call) => call.method === 'POST' || call.method === 'PUT'
    || call.query?.includes('enablePullRequestAutoMerge(input:')), false);
  assert.equal(f.scheduler.hasPendingEnqueue(row), true);
});
for (const step of ['approval', 'enqueue', 'disarm']) {
  test(`per-PR ${step} failure is logged and counted without stopping the sweep`, async (t) => {
    const f = await fixture(t), native = nativeApprovalFixture(f), logs = [];
    f.scheduler.log = (event) => logs.push(event);
    const { row, report } = step === 'disarm' ? armReceipt(f, native) : completedApprovalRow(f);
    if (step === 'approval') f.scheduler.approveCompleted = async () => { throw new Error('Fixture approval failure'); };
    if (step === 'enqueue') {
      f.store.run('UPDATE reviews SET base_ref=NULL WHERE id=?', row.id);
      f.scheduler.enqueue = async () => { throw new Error('Fixture enqueue failure'); };
    }
    if (step === 'disarm') {
      native.pr.draft = true; f.github.graphql = async () => { throw new Error('Fixture disarm failure'); };
    }
    await f.scheduler.reconcile();
    assert.equal(f.scheduler.lastReconcileAt, 1000000);
    assert.equal(f.scheduler.lastReconcileCounts.failed, 1);
    assert.ok(logs.some((event) => event.pr === 1
      && event.event === (step === 'disarm' ? 'approval_disarm_retry_pending' : 'reconcile_pr_failed')));
    assert.ok(logs.some((event) => event.event === 'reconcile_completed'));
  });
}
test('a PR inspection failure does not stop later reconciliation or queued execution', async (t) => {
  const f = await queuedReviews(t, [{ pr: 2, created: 1 }]);
  const logs = [];
  f.scheduler.log = (event) => logs.push(event);
  f.scheduler.lastReconcileAt = 0;
  for (const number of [1, 3]) {
    f.prs.set(number, { ...structuredClone(f.prs.get(2)), number });
  }
  f.scheduler.shepherdBefore = async (number) => {
    if (number === 1) throw new Error('GitHub check-suites HTTP 403');
    return null;
  };
  await f.scheduler.tick();
  assert.equal(f.store.active(2).status, 'running');
  assert.equal(f.store.active(3).status, 'running');
  assert.equal(f.scheduler.lastReconcileCounts.failed, 1);
  assert.ok(logs.some((row) => row.event === 'reconcile_pr_failed' && row.pr === 1));
});

test('global open-PR enumeration failure still advances reconciliation bookkeeping', async (t) => {
  const f = await fixture(t);
  f.github.paginate = async () => { throw new Error('Fixture enumeration failure'); };
  await f.scheduler.reconcile();
  assert.equal(f.scheduler.lastReconcileAt, 1000000);
  assert.equal(f.scheduler.lastReconcileCounts.failed, 1);
});


test('failed requested review does not satisfy the request; backoff recovery queues another fresh row', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f), { row: old } = completedApprovalRow(f);
  f.store.receiveDelivery('monotonic-request', 'check_run', rerequestPayload(f), 1000000);
  await f.scheduler.processDelivery('monotonic-request');
  const first = f.store.active(1), request = f.store.get('SELECT * FROM rerequests');
  assert.equal(first.rerequest_watermark, request.id);
  f.store.update(first.id, { status: 'failed', conclusion: 'neutral' });
  assert.equal(f.store.get('SELECT satisfied_by_review_id FROM rerequests').satisfied_by_review_id, null);
  assert.throws(() => f.scheduler.approvalCheckpoint(old), /publication_cancelled/u);
  f.setNow(request.next_attempt_at); await f.scheduler.reconcile();
  const retry = f.store.active(1);
  assert.equal(retry.reason, 'rerequest_recovered'); assert.notEqual(retry.id, first.id);
  assert.equal(f.scheduler.hasPendingEnqueue(old), true);
  f.setNow(request.next_attempt_at + 7200000);
  assert.equal(f.scheduler.hasPendingEnqueue(old), true, 'There is no time expiry');
  assert.equal(native.calls.some((call) => call.method === 'POST' || call.method === 'PUT'
    || call.query?.includes('enablePullRequestAutoMerge(input:')), false);
});
test('older running review completing after request cannot satisfy it or approve', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f), row = publicationRow(f), report = verdictReport(f);
  f.scheduler.publisher.completed = async () => 'success';
  f.store.receiveDelivery('during-review', 'check_run', rerequestPayload(f), 1000000);
  f.store.publicationIntent(row, report);
  await assert.rejects(f.scheduler.publishNow(row, report), /publication_cancelled/u);
  assert.equal(f.store.review(row.id).status, 'completed');
  assert.equal(f.store.get('SELECT satisfied_by_review_id FROM rerequests').satisfied_by_review_id, null);
  assert.equal(native.calls.some((call) => call.method !== 'GET'), false);
});
for (const reason of ['rerequested', 'rerequest_recovered', 'restart', 'ambiguous_rereview', 'comment_rereview', 'batch_fallback']) {
  test(`${reason} must run a fresh reviewer, never carry prior evidence`, async (t) => {
    const f = await fixture(t); completedApprovalRow(f);
    f.scheduler.mirror.carry = () => assert.fail('Reason is not in the carry allowlist');
    const row = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason });
    await f.scheduler.start(row);
    assert.equal(f.store.review(row.id).status, 'running');
    assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
  });
}
for (const change of ['closed', 'superseded']) {
  test(`${change} PR makes its durable request moot`, async (t) => {
    const f = await fixture(t), native = nativeApprovalFixture(f);
    completedApprovalRow(f); f.store.receiveDelivery('moot-request', 'check_run', rerequestPayload(f), 1);
    await f.scheduler.processDelivery('moot-request');
    const request = f.store.get('SELECT * FROM rerequests');
    if (change === 'closed') native.pr.state = 'closed'; else native.pr.head.sha = sha('b');
    f.setNow(request.next_attempt_at); await f.scheduler.reconcile();
    assert.notEqual(f.store.get('SELECT moot_at FROM rerequests').moot_at, null);
    assert.equal(f.store.get('SELECT satisfied_by_review_id FROM rerequests').satisfied_by_review_id, null);
  });
}

test('unresolved durable requests retry at startup and indefinitely with persisted bounded backoff', async (t) => {
  const f = await fixture(t); nativeApprovalFixture(f); const { row } = completedApprovalRow(f);
  f.store.receiveDelivery('indefinite-request', 'check_run', rerequestPayload(f), 1);
  f.github.paginate = async () => { throw new Error('Fixture lookup failure'); };
  await f.scheduler.recover();
  let request = f.store.get('SELECT * FROM rerequests');
  assert.equal(request.attempts, 1);
  for (let i = 0; i < 5; i++) {
    f.setNow(request.next_attempt_at);
    await f.scheduler.reconcile();
    const next = f.store.get('SELECT * FROM rerequests');
    assert.equal(next.attempts, request.attempts + 1);
    assert.ok(next.next_attempt_at - f.scheduler.now() <= 600000);
    request = next;
  }
  assert.ok(request.attempts > 3);
  assert.equal(request.satisfied_by_review_id, null); assert.equal(request.moot_at, null);
  assert.throws(() => f.scheduler.approvalCheckpoint(row), /publication_cancelled/u);
});

test('stale synchronize or close events cannot mark a still-current live request moot', async (t) => {
  const f = await fixture(t); nativeApprovalFixture(f); const { row } = completedApprovalRow(f);
  f.store.receiveDelivery('current-request', 'check_run', rerequestPayload(f), 1);
  await f.scheduler.processDelivery('current-request');
  await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('b'), due: 0, reason: 'synchronize' });
  await f.scheduler.cancel(1, 'closed');
  assert.equal(f.store.get('SELECT moot_at FROM rerequests').moot_at, null);
  assert.throws(() => f.scheduler.approvalCheckpoint(row), /publication_cancelled/u);
});

test('every scheduler tick refreshes effective approve admission before work', async (t) => {
  const f = await fixture(t); let mode = 'approve', checks = 0;
  f.scheduler.admission = { refresh: async () => { checks++; return { mode }; } };
  await f.scheduler.tick(); assert.equal(f.scheduler.mode, 'approve');
  mode = 'advisory'; await f.scheduler.tick(); assert.equal(f.scheduler.mode, 'advisory');
  mode = 'approve'; await f.scheduler.tick(); assert.equal(f.scheduler.mode, 'approve');
  assert.equal(checks, 3);
});

test('admission degradation preserves an exact-head approval without granting merge authority', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const { row, report } = completedApprovalRow(f);
  const state = { mode: 'approve', modeDegraded: null };
  f.scheduler.admission = { state, refresh: async () => state };
  f.scheduler.approval.admit = async () => state.mode === 'approve';
  f.scheduler.lastReconcileAt = f.scheduler.now();
  await f.scheduler.approveCompleted(row, report);
  state.mode = 'advisory'; state.modeDegraded = 'approve→advisory';
  await f.scheduler.tick();
  await f.scheduler.reconcile();
  assert.equal(f.store.approval(row.publication_id).armed, 0);
  assert.equal(native.pr.auto_merge, null);
  state.mode = 'approve'; state.modeDegraded = null;
  await f.scheduler.tick();
  await f.scheduler.reconcile();
  assert.equal(native.calls.filter(call => call.query?.includes('enablePullRequestAutoMerge(input:')).length, 0);
  assert.equal(native.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(native.calls.filter(call => call.query?.includes('disablePullRequestAutoMerge(input:')).length, 0);
});


for (const outcome of ['failed:approval_admission_failed', 'failed:approval_interrupted',
  'approval_review_blocked', 'reserved', 'armed', 'unknown']) {
  for (const mode of ['advisory', 'off']) {
    test(`unconfirmed ${outcome} arm is retried and disarmed without admission in ${mode}`, async (t) => {
      const f = await fixture(t), native = nativeApprovalFixture(f);
      const { row } = armReceipt(f, native);
      f.store.updateApproval(row.publication_id, { outcome, github_review_id: null }, 2);
      f.scheduler.mode = mode;
      f.scheduler.approval.mode = mode;
      f.scheduler.approval.admit = async () => { throw new Error('cleanup must not ask admission'); };
      const graphql = f.github.graphql;
      let attempts = 0;
      f.github.graphql = async (...args) => {
        if (args[0].includes('disablePullRequestAutoMerge(input:') && ++attempts === 1) {
          throw new Error('Transient disable failure');
        }
        return graphql(...args);
      };
      assert.deepEqual([...(await f.scheduler.reconcileArmed())], [row.pr]);
      assert.equal(f.store.approval(row.publication_id).armed, 1);
      assert.ok(native.pr.auto_merge);
      assert.equal((await f.scheduler.reconcileArmed()).size, 0);
      assert.equal(f.store.approval(row.publication_id).armed, 0);
      assert.equal(native.pr.auto_merge, null);
      assert.equal(attempts, 2);
      await f.scheduler.reconcileArmed();
      assert.equal(attempts, 2);
      assert.equal(native.calls.filter(call => call.method === 'POST' || call.method === 'PUT'
        || call.query?.includes('enablePullRequestAutoMerge(input:')).length, 0);
    });
  }
}

test('fresh admission loss during polling leaves other confirmed approvals armed', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const { row } = armReceipt(f, native);
  f.scheduler.lastReconcileAt = f.scheduler.now();
  const state = { mode: 'approve' };
  f.scheduler.admission = { state, refresh: async () => state };
  const running = await f.scheduler.enqueue({ base_ref: 'main', pr: 2, head_sha: sha('c'), due: f.scheduler.now(), reason: 'fixture' });
  f.store.update(running.id, { status: 'running' });
  f.scheduler.pollNow = async () => { state.mode = 'advisory'; };
  await f.scheduler.tick();
  assert.equal(f.scheduler.mode, 'advisory');
  assert.equal(f.store.approval(row.publication_id).armed, 1); assert.ok(native.pr.auto_merge);
});

test('failed daily prune is counted and logged without starving queued dispatch', async (t) => {
  const f = await fixture(t); f.setNow(90001000);
  f.scheduler.lastReconcileAt = f.scheduler.now();
  await f.scheduler.handle({ type: 'enqueue', pr: 1, head_sha: sha('c'),
    due: f.scheduler.now(), reason: 'fixture' });
  let attempts = 0; const logs = [];
  f.scheduler.log = event => logs.push(event);
  f.scheduler.prune = async () => { attempts++; throw new Error('Read-only filesystem'); };
  await f.scheduler.tick();
  assert.equal(f.store.counts().running, 1);
  assert.equal(f.scheduler.lastPruneAt, 90001000);
  assert.equal(f.scheduler.pruneFailures, 1);
  assert.deepEqual(logs.find(event => event.event === 'prune_failed'), { event: 'prune_failed', failures: 1 });
  await f.scheduler.tick(); assert.equal(attempts, 1);
});

for (const operation of ['recover', 'tick']) {
  test(`off mode ${operation} disarms bot-owned receipts without reviewing or approving`, async (t) => {
    const f = await fixture(t), native = nativeApprovalFixture(f);
    const { row } = armReceipt(f, native);
    f.scheduler.mode = 'off';
    f.scheduler.approval = new Approval({ store: f.store, github: f.github, mode: 'off' });
    await f.scheduler[operation]();
    assert.equal(f.store.approval(row.publication_id).armed, 0);
    assert.equal(native.pr.auto_merge, null);
    assert.equal(native.calls.filter(call => call.query?.includes('disablePullRequestAutoMerge(input:')).length, 1);
    assert.deepEqual(native.calls.filter(call => call.method === 'POST' || call.method === 'PUT'
      || call.query?.includes('enablePullRequestAutoMerge(input:')), []);
    assert.deepEqual(f.calls, []);
  });
}


test('non-main target intake, reconciliation and re-request never start a review', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  native.pr.base.ref = 'release';
  assert.equal(await f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' }), null);
  await f.scheduler.reconcile();
  assert.equal(f.store.counts().queued, 0);
  f.store.receiveDelivery('unsupported-target', 'check_run', rerequestPayload(f), f.scheduler.now());
  await f.scheduler.processDelivery('unsupported-target');
  assert.equal(f.store.counts().queued, 0);
  assert.equal(f.store.get('SELECT moot_at FROM rerequests').moot_at, f.scheduler.now());
  assert.equal(native.calls.some(call => call.method === 'POST' || call.method === 'PUT' || call.query?.includes('enablePullRequestAutoMerge(input:')), false);
});

test('edited target cancels and disarms same-head work; retargeting main starts a fresh review', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  let row = await f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
  row = f.store.update(row.id, { status: 'running', run_id: '1-cccccccccccc-12345678' });
  f.store.reserveApproval(row, native.pr.node_id, f.scheduler.now());
  f.store.updateApproval(row.publication_id, { armed: 1, outcome: 'armed' }, f.scheduler.now());
  native.pr.auto_merge = { enabled_by: { id: 1002, login: 'example-review[bot]' } };
  native.pr.base.ref = 'release';
  const edit = () => ({ repository: { full_name: f.github.repo }, action: 'edited',
    pull_request: structuredClone(native.pr), changes: { base: { ref: { from: 'main' } } } });
  f.store.receiveDelivery('retarget-out', 'pull_request', edit(), f.scheduler.now());
  await f.scheduler.processDelivery('retarget-out');
  assert.equal(f.store.review(row.id).status, 'cancelled');
  assert.equal(f.store.approval(row.publication_id).armed, 0);
  assert.equal(native.pr.auto_merge, null);
  assert.ok(f.calls.some(([method]) => method === 'DELETE'));
  assert.equal(native.calls.some(call => call.method === 'POST'), false);
  native.pr.base.ref = 'main';
  f.store.receiveDelivery('retarget-main', 'pull_request', edit(), f.scheduler.now());
  await f.scheduler.processDelivery('retarget-main');
  const fresh = f.store.active(1);
  assert.notEqual(fresh.id, row.id);
  assert.equal(fresh.base_ref, 'main');
  assert.equal(fresh.reason, 'retargeted');
  let prepared = false;
  f.scheduler.mirror.carry = () => assert.fail('Retargeting cannot reuse a prior review');
  f.scheduler.mirror.prepare = async () => { prepared = true; return { base_sha: sha('d') }; };
  await f.scheduler.start(fresh);
  assert.equal(prepared, true);
  assert.equal(f.store.review(fresh.id).status, 'running');
});

for (const stage of ['start', 'publish']) {
  test(`missed retarget webhook is fenced at ${stage}`, async (t) => {
    const f = await fixture(t), native = nativeApprovalFixture(f);
    let row = await f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
    if (stage === 'publish') row = f.store.update(row.id, { status: 'running' });
    native.pr.base.ref = 'release';
    if (stage === 'start') await f.scheduler.start(row);
    else await assert.rejects(f.scheduler.checkpoint(row), /publication_cancelled/u);
    assert.equal(f.store.review(row.id).status, 'cancelled');
    assert.equal(f.calls.some(([method]) => method === 'POST'), false);
    assert.equal(native.calls.some(call => call.method === 'POST'), false);
  });
}
test('unbound historical review cannot approve and reconciliation queues fresh main evidence', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const { row, report } = completedApprovalRow(f);
  f.store.run('UPDATE reviews SET base_ref=NULL WHERE id=?', row.id);
  assert.throws(() => f.scheduler.approvalCheckpoint(row), /publication_cancelled/u);
  await f.scheduler.reconcile();
  assert.notEqual(f.store.active(1).id, row.id);
  assert.equal(f.store.active(1).base_ref, 'main');
  assert.equal(native.calls.some(call => call.method === 'POST'), false);
});

test('cancelled check from an unbound migrated queued row cannot suppress fresh main review', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  const old = await f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
  f.store.run('UPDATE reviews SET base_ref=NULL WHERE id=?', old.id);
  await f.scheduler.start(f.store.review(old.id));
  assert.equal(f.store.review(old.id).status, 'cancelled');
  const paginate = f.github.paginate;
  f.github.paginate = async (path, ...args) => path.includes('/check-runs?')
    ? [{ app: { id: Number(f.github.appId) }, head_sha: sha('c'), conclusion: 'cancelled' }]
    : paginate(path, ...args);
  await f.scheduler.reconcile();
  const fresh = f.store.active(1);
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.base_ref, 'main');
  assert.equal(fresh.reason, 'reconcile');
  assert.equal(native.calls.some(call => call.method === 'POST'), false);
});
for (const status of ['queued', 'running', 'publishing']) {
  test(`unbound active ${status} row is replaced rather than counted as coverage`, async (t) => {
    const f = await fixture(t); nativeApprovalFixture(f);
    const old = await f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
    f.store.run('UPDATE reviews SET base_ref=NULL WHERE id=?', old.id);
    if (status !== 'queued') f.store.update(old.id, { status, run_id: '1-cccccccccccc-12345678' });
    await f.scheduler.reconcile();
    assert.equal(f.store.review(old.id).status, 'cancelled');
    assert.notEqual(f.store.active(1).id, old.id);
    assert.equal(f.store.active(1).base_ref, 'main');
  });
}
for (const status of ['queued', 'running', 'publishing', 'completed']) {
  test(`exact-head main-bound ${status} row provides durable coverage`, async (t) => {
    const f = await fixture(t); nativeApprovalFixture(f);
    const row = status === 'completed' ? completedApprovalRow(f).row
      : await f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
    if (['running', 'publishing'].includes(status)) f.store.update(row.id, { status });
    const before = f.store.get('SELECT COUNT(*) AS count FROM reviews').count;
    await f.scheduler.reconcile();
    assert.equal(f.store.get('SELECT COUNT(*) AS count FROM reviews').count, before);
  });
}

for (const conclusion of ['cancelled', 'skipped', 'success']) {
  test(`App ${conclusion} check alone is not main-bound review coverage`, async (t) => {
    const f = await fixture(t); nativeApprovalFixture(f);
    const paginate = f.github.paginate;
    f.github.paginate = async (path, ...args) => path.includes('/check-runs?')
      ? [{ app: { id: Number(f.github.appId) }, head_sha: sha('c'), conclusion }]
      : paginate(path, ...args);
    await f.scheduler.reconcile();
    assert.equal(f.store.active(1).base_ref, 'main');
    assert.equal(f.store.active(1).reason, 'reconcile');
  });
}

test('two runner losses exhaust head retries; reconciles stay neutral until an explicit re-request', async (t) => {
  const f = await fixture(t); nativeApprovalFixture(f);
  f.scheduler.fetch = async () => ({ status: 404 });
  const first = await f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
  await f.scheduler.poll(f.store.update(first.id, { status: 'running', run_id: '1-cccccccccccc-12345678' }));
  const retry = f.store.active(1);
  assert.equal(retry.attempt, 2);
  await f.scheduler.poll(f.store.update(retry.id, { status: 'running', run_id: '2-cccccccccccc-12345678' }));
  assert.equal(f.store.review(retry.id).status, 'failed');
  assert.equal(f.store.review(retry.id).conclusion, 'neutral');
  assert.equal(f.store.active(1), undefined);
  for (let sweep = 1; sweep <= 3; sweep++) {
    f.setNow(1000000 + sweep * 600000);
    await f.scheduler.reconcile();
    assert.equal(f.store.active(1), undefined);
    assert.equal(f.store.get('SELECT COUNT(*) AS count FROM reviews').count, 2);
  }
  f.store.receiveDelivery('exhausted-rerequest', 'check_run', rerequestPayload(f), f.scheduler.now());
  await f.scheduler.processDelivery('exhausted-rerequest');
  const requested = f.store.active(1);
  assert.equal(requested.reason, 'rerequested');
  assert.equal(requested.attempt, 1);
  await f.scheduler.processDelivery('exhausted-rerequest');
  await f.scheduler.reconcile();
  assert.equal(f.store.active(1).id, requested.id);
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM reviews').count, 3);
});
test('all main-bound completed conclusions provide coverage even without report text', async (t) => {
  const f = await fixture(t); nativeApprovalFixture(f);
  const row = await f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
  for (const conclusion of ['success', 'failure', 'neutral', 'cancelled']) {
    f.store.update(row.id, { status: 'completed', conclusion });
    await f.scheduler.reconcile();
    assert.equal(f.store.active(1), undefined);
    assert.equal(f.store.get('SELECT COUNT(*) AS count FROM reviews').count, 1);
  }
});

async function shepherdFixture(t) {
  const f = await fixture(t);
  const prs = [], api = [];
  f.github.request = async (method, path, body) => {
    api.push({ method, path, body });
    if (path.includes('/compare/main...')) return { behind_by: 0, base_commit: { sha: sha('d') } };
    if (/\/pulls\/\d+$/u.test(path)) return prs.find((pr) => path.endsWith('/' + pr.number));
    return { id: 100 + api.length };
  };
  f.github.paginate = async (path) => path.includes('/pulls?') ? prs : [];
  f.scheduler.shepherd = new Shepherd({ github: f.github, store: f.store, now: f.scheduler.now });
  f.scheduler.revision = sha('f');
  const add = (number, headSha = sha('a')) => {
    const pr = { number, state: 'open', draft: false, mergeable: true, labels: [], user: { login: 'author' },
      head: { sha: headSha, repo: { full_name: f.github.repo } }, base: { ref: 'main' } };
    prs.push(pr);
    const row = f.store.enqueue({ pr: number, head_sha: pr.head.sha, base_ref: 'main', due: 0, reason: 'opened' }, 0);
    f.store.update(row.id, { status: 'completed', result_json: JSON.stringify({
      result: { pass: true }, verdict: { decision: 'block' }, findings: [{ id: 'F1', status: 'new' }],
    }) });
    return row;
  };
  return { ...f, prs, api, add };
}
for (const stage of ['preparation', 'before', 'review', 'after']) {
  test(`typed budget deferral during ${stage} stays dirty and resumes due work without failure`, async (t) => {
    const f = await shepherdFixture(t);
    const row = f.add(1);
    f.store.update(row.id, { bot_revision: sha('f') });
    const logs = [];
    f.scheduler.log = (entry) => logs.push(entry);
    const [owner, method] = stage === 'preparation' ? [f.scheduler, 'preparePresentation']
      : stage === 'before' ? [f.scheduler.shepherd, 'inspect']
        : stage === 'review' ? [f.scheduler, 'approveCompleted'] : [f.scheduler, 'publishStatus'];
    const original = owner[method];
    owner[method] = async () => { throw new GitHubBudgetDeferred('presentation', 1005000, 'github_hourly_budget'); };
    await f.scheduler.reconcile();
    assert.equal(f.scheduler.lastReconcileCounts.failed, 0);
    assert.equal(f.scheduler.lastReconcileCounts.deferred, 1);
    assert.equal(f.scheduler.sweepSeen.get(1).dirty, true);
    assert.equal(f.scheduler.reconcileSoonAt, 1005000);
    const deferred = logs.filter((entry) => entry.event === 'reconcile_pr_deferred');
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].status, 'DEFERRED');
    assert.equal(deferred[0].priority, 'presentation');
    assert.equal(deferred[0].retryAt, 1005000);
    assert.equal(deferred[0].reason, 'github_hourly_budget');
    assert.equal(logs.some((entry) => entry.event === 'shepherd_failed' || entry.event === 'reconcile_pr_failed'), false);
    owner[method] = original;
    f.setNow(1005000);
    await f.scheduler.reconcile();
    assert.equal(f.scheduler.lastReconcileCounts.failed, 0);
    assert.equal(f.scheduler.lastReconcileCounts.deferred, 0);
    assert.equal(f.scheduler.sweepSeen.get(1).dirty, undefined, 'due work is retried and only then becomes clean');
    assert.equal(f.scheduler.sweepSeen.get(1).at, 1005000);
  });
}

test('upgrade backfill queues six per hour, skips approved and current revision heads', async (t) => {
  const f = await shepherdFixture(t);
  for (let number = 1; number <= 8; number++) f.add(number);
  const approved = f.add(9);
  f.store.reserveApproval({ ...approved, publication_id: approved.id }, 'PR9', 0);
  f.store.updateApproval(approved.id, { outcome: 'approved' }, 0);
  const current = f.add(10); f.store.update(current.id, { bot_revision: sha('f') });
  await f.scheduler.reconcile();
  assert.equal(f.store.all("SELECT * FROM reviews WHERE reason='upgrade_rereview'").length, 6);
  assert.equal(f.store.active(9), undefined); assert.equal(f.store.active(10), undefined);
  f.setNow(4600000);
  for (const row of f.store.all("SELECT * FROM reviews WHERE reason='upgrade_rereview'")) {
    f.store.update(row.id, { status: 'cancelled' });
    f.store.update(f.store.latest(row.pr).id, { bot_revision: sha('f') });
  }
  await f.scheduler.reconcile();
  assert.deepEqual(f.store.all("SELECT pr FROM reviews WHERE reason='upgrade_rereview' AND status='queued'").map((r) => r.pr), [7, 8]);
});

for (const operation of ['upgrade_rereview', 'presentation', 'publish_status']) {
  test(`shepherd after ${operation} failures retain bounded sanitized causes`, async (t) => {
    const f = await shepherdFixture(t);
    f.add(1);
    const logs = [];
    f.scheduler.log = (entry) => logs.push(entry);
    f.scheduler.reconcileCounts = { failed: 0 };
    f.scheduler.publisher.secrets = ['publisher-private'];
    f.scheduler.shepherd.secrets = ['shepherd-private'];
    const token = `ghp_${'a'.repeat(36)}`;
    const error = Object.assign(new Error(`endpoint unavailable publisher-private shepherd-private ${token} ${'x'.repeat(1200)}`), {
      name: `RemoteError publisher-private ${'n'.repeat(120)}`,
      code: `HTTP_503 shepherd-private ${'c'.repeat(120)}`,
      stack: 'must not log stack',
      headers: { authorization: 'must not log headers' },
    });
    let publications = 0;
    f.scheduler.upgradeRereview = async () => { if (operation === 'upgrade_rereview') throw error; };
    f.scheduler.publishStatus = async () => { publications++; throw error; };
    await f.scheduler.shepherdAfter({ inspection: { pr: f.prs[0], conflicting: false } },
      operation === 'presentation' ? { presentationError: error } : undefined);
    assert.equal(f.scheduler.reconcileCounts.failed, 1, 'genuine failures must still count');
    assert.equal(publications, operation === 'publish_status' ? 1 : 0);
    assert.equal(logs.length, 1);
    const entry = logs[0];
    assert.equal(entry.event, 'shepherd_failed');
    assert.equal(entry.pr, 1);
    assert.equal(entry.step, 'after');
    assert.equal(entry.operation, operation);
    assert.deepEqual(Object.keys(entry.cause).sort(), ['code', 'message', 'name']);
    assert.match(entry.cause.message, /^endpoint unavailable \[redacted\] \[redacted\] \[redacted\]/u);
    for (const [key, limit] of [['name', 100], ['message', 1000], ['code', 100]]) {
      assert.equal(entry.cause[key].length, limit);
      assert.match(entry.cause[key], /…\[truncated\]$/u);
    }
    assert.doesNotMatch(JSON.stringify(entry), /publisher-private|shepherd-private|ghp_|must not log/u);
  });
}

for (const executionChanges of [false, true]) {
  test(`upgrade status ${executionChanges ? 'rejects an execution change during its fresh fence' : 'captures the newly queued row before fencing'}`, async (t) => {
    const f = await shepherdFixture(t);
    const previous = f.add(1), logs = [];
    f.scheduler.log = (entry) => logs.push(entry);
    f.scheduler.reconcileCounts = { failed: 0 };
    const request = f.github.request;
    let fencing = false, writes = 0;
    f.github.request = async (method, path, body, guard) => {
      if (method === 'POST' && path.endsWith('/comments')) {
        fencing = true;
        await guard('before_send');
        writes++;
      } else if (fencing && method === 'GET' && path.endsWith('/pulls/1') && executionChanges) {
        const active = f.store.active(1);
        assert.equal(active.reason, 'upgrade_rereview');
        f.store.update(active.id, { status: 'running', started_at: f.scheduler.now() });
      }
      return request(method, path, body);
    };
    await f.scheduler.shepherdAfter({ inspection: { pr: f.prs[0], conflicting: false, behindBy: 0 } },
      { humans: [], ci: null });
    const active = f.store.active(1);
    assert.notEqual(active.id, previous.id);
    assert.equal(active.reason, 'upgrade_rereview');
    assert.equal(writes, executionChanges ? 0 : 1);
    if (executionChanges) {
      assert.equal(f.store.shepherdState(1)?.comment_id, undefined, 'stale status must not publish');
    } else {
      assert.ok(f.store.shepherdState(1)?.comment_id);
    }
  });
}
test('shepherd ignores draft, non-main and fork PRs entirely', async (t) => {
  const f = await shepherdFixture(t);
  f.add(1); f.prs[0].draft = true;
  f.add(2); f.prs[1].base.ref = 'release';
  f.add(3); f.prs[2].head.repo.full_name = 'other/repo';
  await f.scheduler.reconcile(); assert.deepEqual(f.api, []);
});
test('synchronize does not carry a verdict across bot revisions', async (t) => {
  const f = await fixture(t); f.scheduler.revision = sha('f');
  const previous = f.store.enqueue({ pr: 1, head_sha: sha('a'), base_ref: 'main', due: 0, reason: 'opened' }, 0);
  f.store.update(previous.id, { status: 'completed', bot_revision: sha('e') });
  let carried = false; f.scheduler.mirror.carry = async () => { carried = true; return null; };
  const row = await f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'synchronize' });
  await f.scheduler.start(row); assert.equal(carried, false);
  assert.equal(f.store.review(row.id).status, 'running');
});
test('merged main delivery schedules a sweep on the next tick', async (t) => {
  const f = await fixture(t); f.scheduler.lastReconcileAt = 999999;
  f.store.receiveDelivery('merged-main', 'pull_request', { action: 'closed',
    repository: { full_name: f.github.repo }, pull_request: { number: 7, merged: true,
      base: { ref: 'main' }, head: { sha: sha('a'), repo: { full_name: f.github.repo } } } }, 1000000);
  await f.scheduler.processDelivery('merged-main');
  assert.equal(f.scheduler.reconcileSoonAt, 1000000);
  await f.scheduler.tick();
  assert.equal(f.scheduler.lastReconcileAt, 1000000); assert.equal(f.scheduler.reconcileSoonAt, null);
});
test('unselected reconciliation preserves author-owned branches and never refreshes a builder merely behind main', async (t) => {
  const f = await shepherdFixture(t); const row = f.add(1);
  const result = JSON.stringify({ result: { pass: true }, verdict: { decision: 'approve' }, findings: [] });
  f.store.update(row.id, { bot_revision: sha('f'), result_json: result });
  f.prs[0].user = { id: 9, login: 'renovate[bot]', type: 'Bot' };
  f.prs[0].head.ref = 'renovate/npm-nodemailer-vulnerability';
  f.github.request = async (method, path, body) => {
    f.api.push({ method, path, body });
    if (path.includes('/compare/main...')) return { behind_by: 3, base_commit: { sha: sha('c') } };
    if (path.endsWith('/pulls/1')) return f.prs[0];
    return { id: 123 };
  };
  f.store.saveUpdateAttempt(1, sha('a'), sha('c'), 'failed:HTTP 422', f.scheduler.now());
  await f.scheduler.reconcile();
  assert.equal(f.api.filter((c) => c.method === 'PUT').length, 0);
  assert.equal(f.api.some((c) => c.method === 'POST' && c.path.endsWith('/issues/1/labels')), false);
  await f.scheduler.refreshStatus(1);
  assert.equal(f.api.filter((c) => c.method === 'PUT').length, 0);
  f.prs[0].user = { ...builder, type: 'Bot' };
  f.prs[0].head.ref = 'task-x'; f.prs[0].head.sha = sha('b');
  const next = f.store.enqueue({ pr: 1, head_sha: sha('b'), base_ref: 'main', due: 0, reason: 'opened' }, f.scheduler.now());
  f.store.update(next.id, { status: 'completed', bot_revision: sha('f'), result_json: result });
  await f.scheduler.reconcile();
  assert.equal(f.api.filter((c) => c.method === 'PUT' && c.path.endsWith('/update-branch')).length, 0);
});

test('failed and cancelled upgrade reviews still consume the hourly cap after reason changes', async (t) => {
  const f = await shepherdFixture(t);
  for (let number = 1; number <= 8; number++) f.add(number);
  await f.scheduler.reconcile();
  const queued = f.store.all("SELECT * FROM reviews WHERE reason='upgrade_rereview'");
  assert.equal(queued.length, 6);
  for (const [index, row] of queued.entries()) {
    f.store.update(row.id, { status: index % 2 ? 'cancelled' : 'failed',
      reason: index % 2 ? 'superseded' : 'runner_lost', finished_at: f.scheduler.now() });
  }
  assert.equal(f.store.upgradeRereviewsSince(f.scheduler.now() - 3600000), 6);
  await f.scheduler.reconcile();
  assert.equal(f.store.counts().queued, 0);
  assert.equal(f.store.all('SELECT * FROM upgrade_rereviews').length, 6);
  assert.equal(f.store.active(7), undefined); assert.equal(f.store.active(8), undefined);
});
test('pending stored update is neither a refusal label nor an update status', async (t) => {
  const f = await shepherdFixture(t); f.add(1);
  f.store.saveUpdateAttempt(1, sha('a'), sha('d'), 'pending', f.scheduler.now());
  await f.scheduler.refreshStatus(1);
  const comment = f.api.find((c) => c.body?.body);
  assert.ok(comment); assert.doesNotMatch(comment.body.body, /Behind|pending/u);
  await f.scheduler.reconcile();
  assert.equal(f.api.some((c) => c.method === 'PUT' || c.path.includes('/labels')), false);
});

for (const currentRevision of [false, true]) {
  test(`shepherd reconciliation ${currentRevision ? 'approves current-revision' : 're-reviews stale-revision'} approve evidence`, async (t) => {
    const f = await shepherdFixture(t);
    const native = nativeApprovalFixture(f);
    native.pr.mergeable = true; native.pr.labels = [];
    const request = f.github.request;
    f.github.request = async (method, path, body, guard) => {
      if (path.includes('/compare/main...')) return { behind_by: 0, base_commit: { sha: sha('d') } };
      if (path.endsWith('/comments')) return { id: 123 };
      return request(method, path, body, guard);
    };
    const { row } = completedApprovalRow(f);
    if (currentRevision) f.store.update(row.id, { bot_revision: sha('f') });
    await f.scheduler.reconcile();
    const arms = native.calls.filter((c) => c.query?.includes('enablePullRequestAutoMerge(input:'));
    const approvals = native.calls.filter((c) => c.method === 'POST' && c.body?.event === 'APPROVE');
    if (currentRevision) {
      assert.equal(f.store.approvalForReview(row.id).outcome, 'approved');
      assert.equal(arms.length, 0); assert.equal(approvals.length, 1);
      assert.equal(f.store.active(1), undefined);
    } else {
      assert.equal(f.store.approvalForReview(row.id), undefined);
      assert.equal(arms.length, 0); assert.equal(approvals.length, 0);
      assert.equal(f.store.active(1).reason, 'upgrade_rereview');
    }
  });
}

for (const newerFailure of [true, false]) {
  test(`status renders ${newerFailure ? 'newer exhausted failure' : 'newer completed verdict'} for a re-reviewed head`, async (t) => {
    const f = await shepherdFixture(t);
    f.add(1);
    const failed = f.store.enqueue({ pr: 1, head_sha: sha('a'), base_ref: 'main',
      due: 0, reason: 'rerequested', attempt: 2 }, f.scheduler.now());
    f.store.update(failed.id, { status: 'failed', reason: 'review_evidence_failed' });
    if (!newerFailure) {
      const completed = f.store.enqueue({ pr: 1, head_sha: sha('a'), base_ref: 'main',
        due: 0, reason: 'rerequested' }, f.scheduler.now());
      f.store.update(completed.id, { status: 'completed', result_json: JSON.stringify({
        result: { pass: true }, verdict: { decision: 'block' }, findings: [{ id: 'F2', status: 'new' }],
      }) });
    }
    await f.scheduler.publishStatus(await f.scheduler.shepherd.inspect(1), null);
    const body = f.api.find((call) => call.body?.body).body.body;
    if (newerFailure) {
      assert.match(body, /codex-review could not complete.*review_evidence_failed/u);
      assert.doesNotMatch(body, /finding\(s\)/u);
    } else {
      assert.match(body, /1 codex-review finding\(s\).*F2/u);
      assert.doesNotMatch(body, /could not complete|review_evidence_failed/u);
    }
  });
}

test('exhausted upgrade head is not automatically re-reviewed again after the hourly cap expires', async (t) => {
  const f = await shepherdFixture(t); f.add(1);
  const failed = f.store.enqueue({ pr: 1, head_sha: sha('a'), base_ref: 'main',
    due: 0, reason: 'upgrade_rereview', attempt: 2 }, f.scheduler.now());
  f.store.update(failed.id, { status: 'failed', reason: 'runner_lost' });
  f.setNow(4600000);
  await f.scheduler.reconcile();
  assert.equal(f.store.active(1), undefined);
  assert.equal(f.store.all('SELECT * FROM upgrade_rereviews').length, 1);
});
for (const scenario of ['unlisted', 'juli', 'author', 'dismissed', 'wrong-id', 'wrong-login']) {
  test(`human approval status requires effective named non-author identity: ${scenario}`, async (t) => {
    const f = await shepherdFixture(t);
    const row = f.add(1);
    f.store.update(row.id, { result_json: JSON.stringify({ result: { pass: true },
      verdict: { decision: 'ambiguous' }, waitingForHuman: true, findings: [] }) });
    let user = { id: 1005, login: 'second-approver' };
    if (scenario === 'unlisted') user = { id: 999, login: 'someone' };
    if (scenario === 'wrong-id') user = { ...user, id: 999 };
    if (scenario === 'wrong-login') user = { ...user, login: 'someone' };
    if (scenario === 'author') f.prs[0].user = { ...user };
    const reviews = [{ id: 1, user, state: 'APPROVED', submitted_at: '2026-10-10T00:00:00Z' }];
    if (scenario === 'dismissed') reviews.push({ id: 2, user, state: 'DISMISSED', submitted_at: '2026-10-10T01:00:00Z' });
    const paginate = f.github.paginate;
    f.github.paginate = async (path) => path.endsWith('/reviews') ? reviews : paginate(path);
    f.github.graphql = async () => assert.fail('Status does not query ruleset reviewDecision');
    await f.scheduler.publishStatus(await f.scheduler.shepherd.inspect(1), null);
    const body = f.api.find((call) => call.body?.body).body.body;
    if (scenario === 'juli') assert.doesNotMatch(body, /Needs a human approval/u);
    else assert.match(body, /Needs a human approval/u);
  });
}

for (const producingRevision of [null, sha('e')]) {
  test(`recovered approve evidence preserves producing revision ${producingRevision ?? 'NULL'} and waits for upgrade review`, async (t) => {
    const f = await shepherdFixture(t);
    const native = nativeApprovalFixture(f);
    native.pr.mergeable = true; native.pr.labels = [];
    const request = f.github.request;
    f.github.request = async (method, path, body, guard) => {
      if (path.includes('/compare/main...')) return { behind_by: 0, base_commit: { sha: sha('d') } };
      if (path.endsWith('/comments')) return { id: 123 };
      return request(method, path, body, guard);
    };
    f.scheduler.publisher.completed = async () => 'success';
    const row = publicationRow(f);
    const report = verdictReport(f);
    report.verdict = { decision: 'approve' };
    f.store.publicationIntent(row, report);
    f.store.update(row.id, { bot_revision: producingRevision });
    await f.scheduler.recover();
    assert.equal(f.store.review(row.id).status, 'completed');
    assert.equal(f.store.review(row.id).bot_revision, producingRevision);
    assert.equal(f.store.approvalForReview(row.id), undefined);
    assert.equal(native.calls.some((c) => c.query?.includes('enablePullRequestAutoMerge(input:')), false);
    assert.equal(native.calls.some((c) => c.body?.event === 'APPROVE'), false);
    await f.scheduler.reconcile();
    assert.equal(f.store.active(1).reason, 'upgrade_rereview');
    await f.scheduler.start(f.store.active(1));
    assert.equal(f.store.active(1).bot_revision, sha('f'));
  });
}


function commentFixture(f) {
  const pr = { number: 1, state: 'open', draft: false, user: { id: 42, login: 'author' },
    head: { sha: sha('c'), repo: { full_name: f.github.repo } }, base: { ref: 'main' } };
  f.github.request = async () => structuredClone(pr);
  f.store.run("INSERT INTO findings(pr,finding_id,first_review_id,last_review_id,status,comment_id) VALUES(1,'F1',1,1,'new',500)");
  const outcomes = [];
  f.scheduler.log = (entry) => { if (entry.event === 'comment_rereview') outcomes.push(entry.outcome); };
  const reply = (overrides = {}) => f.scheduler.handle({ type: 'commentRereview', pr: 1, trigger: 'finding_reply', comment_id: 900,
    in_reply_to_id: 500, created_at: 1000000, commenter: { id: 42, login: 'author' }, due: 1060000, ...overrides });
  const command = (overrides = {}) => reply({ trigger: 'command', in_reply_to_id: undefined, due: 1000000, ...overrides });
  const answer = (overrides = {}) => reply({ trigger: 'builder_answer', in_reply_to_id: undefined,
    findings: ['F1'], commenter: builder, ...overrides });
  return { pr, outcomes, reply, command, answer };
}
test('an author finding reply queues one debounced comment re-review and later replies push it', async (t) => {
  const f = await fixture(t), c = commentFixture(f);
  await c.reply();
  const row = f.store.active(1);
  assert.equal(row.reason, 'comment_rereview');
  assert.equal(row.head_sha, sha('c'));
  assert.equal(row.due_at, 1060000);
  await c.reply({ comment_id: 901, due: 1070000 });
  assert.equal(f.store.counts().queued, 1);
  assert.equal(f.store.active(1).id, row.id);
  assert.equal(f.store.active(1).due_at, 1070000);
  assert.equal(f.store.commentRereviews(1, sha('c')), 1);
  assert.deepEqual(c.outcomes, ['queued', 'absorbed']);
});
test('an approver /rereview on another author\'s PR queues immediately', async (t) => {
  const f = await fixture(t), c = commentFixture(f);
  await c.command({ commenter: { id: 1004, login: 'example-owner' } });
  assert.equal(f.store.active(1).reason, 'comment_rereview');
  assert.equal(f.store.active(1).due_at, 1000000);
  assert.deepEqual(c.outcomes, ['queued']);
});
test('the builder bot /rereview on a legacy author PR queues immediately', async (t) => {
  const f = await fixture(t), c = commentFixture(f);
  await c.command({ commenter: { id: 1003, login: 'builder[bot]' } });
  assert.equal(f.store.active(1).reason, 'comment_rereview');
  assert.equal(f.store.active(1).due_at, 1000000);
  assert.deepEqual(c.outcomes, ['queued']);
});
test('a builder answer on a builder-authored PR queues one debounced re-review under the per-head limit', async (t) => {
  const f = await fixture(t), c = commentFixture(f);
  c.pr.user = { ...builder };
  await c.answer();
  const row = f.store.active(1);
  assert.equal(row.reason, 'comment_rereview');
  assert.equal(row.due_at, 1060000);
  assert.equal(f.store.commentRereviews(1, sha('c')), 1);
  f.store.update(row.id, { status: 'cancelled', reason: 'superseded' });
  for (let index = 0; index < 2; index++) {
    await c.command({ commenter: builder });
    f.store.update(f.store.active(1).id, { status: 'cancelled', reason: 'superseded' });
  }
  await c.answer();
  assert.equal(f.store.commentRereviews(1, sha('c')), 3);
  assert.equal(f.store.get('SELECT count(*) AS n FROM reviews').n, 3);
  assert.deepEqual(c.outcomes, ['queued', 'queued', 'queued', 'limited']);
});
test('builder answers need a builder-authored PR, the real builder App and an open cited finding', async (t) => {
  const f = await fixture(t), c = commentFixture(f);
  await c.answer();
  c.pr.user = { ...builder };
  await c.answer({ commenter: { id: 1, login: 'builder[bot]' } });
  await c.answer({ commenter: { id: 1002, login: 'example-review[bot]' } });
  await c.answer({ findings: ['F9'] });
  f.store.run("UPDATE findings SET status='resolved' WHERE pr=1 AND finding_id='F1'");
  await c.answer();
  assert.deepEqual(c.outcomes, ['unauthorized', 'unauthorized', 'unauthorized', 'not_a_finding', 'not_a_finding']);
  assert.equal(f.store.get('SELECT count(*) AS n FROM reviews').n, 0);
});
test('a persisted builder evidence comment delivery queues the re-review', async (t) => {
  const f = await fixture(t), c = commentFixture(f);
  c.pr.user = { ...builder };
  f.store.receiveDelivery('comment-b', 'issue_comment', minimalPayload({ action: 'created', repository: { full_name: f.github.repo },
    issue: { number: 1, pull_request: { url: 'x' } }, comment: { id: 902, created_at: new Date(1000000).toISOString(),
      body: 'Re review-bot **F1** (`a.mjs:3`): not applicable.', user: { ...builder, type: 'Bot' } } }), 1000000);
  await f.scheduler.processDelivery('comment-b');
  assert.equal(f.store.get("SELECT state FROM deliveries WHERE id='comment-b'").state, 'processed');
  assert.equal(f.store.active(1).reason, 'comment_rereview');
  assert.deepEqual(c.outcomes, ['queued']);
});
test('unauthorized commenters, non-finding replies, drafts and non-main targets never queue', async (t) => {
  const f = await fixture(t), c = commentFixture(f);
  await c.command({ commenter: { id: 99, login: 'other' } });
  await c.command({ commenter: { id: 1004, login: 'impostor' } });
  await c.reply({ in_reply_to_id: 999 });
  c.pr.draft = true; await c.command();
  c.pr.draft = false; c.pr.base.ref = 'release'; await c.command();
  c.pr.base.ref = 'main'; c.pr.head.repo.full_name = 'other/repo'; await c.command();
  assert.equal(f.store.get('SELECT count(*) AS n FROM reviews').n, 0);
  assert.deepEqual(c.outcomes, ['unauthorized', 'unauthorized', 'not_a_finding', 'ineligible', 'ineligible', 'ineligible']);
});
test('comment re-reviews are capped per head, and cancelled or failed reviews still count', async (t) => {
  const f = await fixture(t), c = commentFixture(f);
  for (let index = 0; index < 3; index++) {
    await c.command();
    f.store.update(f.store.active(1).id, { status: index === 2 ? 'failed' : 'cancelled', reason: 'superseded' });
  }
  await c.command();
  assert.equal(f.store.active(1), undefined);
  assert.equal(f.store.get('SELECT count(*) AS n FROM reviews').n, 3);
  assert.equal(c.outcomes.at(-1), 'limited');
  c.pr.head.sha = sha('d');
  await c.command();
  assert.equal(f.store.active(1).head_sha, sha('d'));
  assert.equal(c.outcomes.at(-1), 'queued');
});
test('a running review that already saw the comment covers it; a later comment replaces it', async (t) => {
  const f = await fixture(t), c = commentFixture(f);
  const running = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' });
  f.store.update(running.id, { status: 'running', run_id: `${running.id}-cccccccccccc-12345678`, started_at: 1000000 });
  await c.command({ created_at: 900000 });
  assert.equal(f.store.review(running.id).status, 'running');
  assert.equal(c.outcomes.at(-1), 'covered');
  await c.command({ created_at: 1000000 });
  assert.equal(f.store.review(running.id).status, 'cancelled');
  assert.equal(f.store.review(running.id).reason, 'superseded');
  assert.equal(f.store.active(1).reason, 'comment_rereview');
  assert.equal(f.store.active(1).status, 'queued');
  assert.equal(c.outcomes.at(-1), 'queued');
});
test('a reply absorbed into a queued carry-eligible review forces a fresh reviewer', async (t) => {
  const f = await fixture(t), c = commentFixture(f);
  const previous = f.store.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('b'), due: 0, reason: 'opened' }, 1);
  f.store.update(previous.id, { status: 'completed', conclusion: 'success', result_json: '{}', started_at: 1, finished_at: 2 });
  const queued = await f.scheduler.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 1000000, reason: 'synchronize' });
  await c.reply();
  assert.equal(c.outcomes.at(-1), 'absorbed');
  assert.equal(f.store.review(queued.id).reason, 'comment_rereview');
  assert.equal(f.store.commentRereviews(1, sha('c')), 0);
  f.scheduler.mirror.carry = () => assert.fail('An answered finding needs a fresh reviewer');
  f.setNow(f.store.review(queued.id).due_at);
  await f.scheduler.start(f.store.review(queued.id));
  assert.equal(f.store.review(queued.id).status, 'running');
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
});
test('an undecided comment request fences approval across failed processing until a fresh review sees it', async (t) => {
  const f = await fixture(t);
  const c = commentFixture(f);
  const old = f.store.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'opened' }, 1);
  // An approving verdict, so only the comment fence can invalidate its arm.
  f.store.update(old.id, { status: 'completed', conclusion: 'success', started_at: 1000000, finished_at: 1000001,
    result_json: JSON.stringify({ result: { pass: true }, verdict: { decision: 'approve' } }) });
  f.store.receiveDelivery('comment-1', 'issue_comment', minimalPayload({ action: 'created', repository: { full_name: f.github.repo },
    issue: { number: 1, pull_request: { url: 'x' } }, comment: { id: 901, created_at: new Date(1000000).toISOString(),
      body: '/rereview', user: { id: 42, login: 'author', type: 'User' } } }), 1000000);
  f.github.request = async () => { throw new Error('GitHub unavailable'); };
  await assert.rejects(f.scheduler.processDelivery('comment-1'), /GitHub unavailable/u);
  assert.equal(f.store.get("SELECT state FROM deliveries WHERE id='comment-1'").state, 'received');
  assert.equal(f.scheduler.hasPendingEnqueue(f.store.review(old.id)), true);
  assert.equal(f.scheduler.reconcileSoonAt, 1000000, 'Failed processing schedules arm cleanup');
  f.store.run(`INSERT INTO approvals(publication_id,pr,head_sha,review_id,pull_request_id,armed,outcome,updated_at)
    VALUES(?,1,?,?,'PR_1',1,'approved',1)`, old.id, sha('c'), old.id);
  const disabled = [];
  f.scheduler.approval = { disable: async (pr) => { disabled.push(pr); } };
  f.github.request = async () => structuredClone(c.pr);
  await f.scheduler.reconcileArmed();
  assert.deepEqual(disabled, [1], 'An existing bot arm is disarmed while the request is undecided');
  const fresh = f.store.enqueue({ base_ref: 'main', pr: 1, head_sha: sha('c'), due: 0, reason: 'rerequested' }, 1);
  f.store.update(fresh.id, { status: 'completed', conclusion: 'success', result_json: '{}', started_at: 1040000, finished_at: 1040001 });
  assert.equal(f.scheduler.hasPendingEnqueue(f.store.review(fresh.id)), false);
  assert.equal(f.scheduler.hasPendingEnqueue(f.store.review(old.id)), true);
  f.setNow(1000000 + 30 * 86400000); await f.scheduler.prune();
  assert.equal(f.scheduler.hasPendingEnqueue(f.store.review(old.id)), true, 'Retention never lifts an undecided fence');
  f.store.processedDelivery('comment-1', 1050000);
  assert.equal(f.scheduler.hasPendingEnqueue(f.store.review(old.id)), false);
});

test('display CI coalesces discovery while authoritative reads never inherit cached green', async t => {
  const f = await fixture(t), { state, run } = ciProvider(f.github);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const paginate = f.github.paginate;
  let suites = 0;
  f.github.paginate = async (...args) => {
    if (args[0].endsWith('/check-suites')) { suites++; entered.resolve(); await release.promise; }
    return paginate(...args);
  };
  const first = f.scheduler.latestCi(sha('c'), { display: true });
  await entered.promise;
  const second = f.scheduler.latestCi(sha('c'), { display: true });
  release.resolve();
  assert.deepEqual((await Promise.all([first, second])).map(ci => ci.id), [42, 42]);
  assert.equal(suites, 1, 'concurrent display requests share the suite/check/run fan-out');
  state.runs.unshift({ ...run, id: 43, status: 'queued', conclusion: null });
  assert.equal((await f.scheduler.latestCi(sha('c'))).id, 43, 'authority always sees the new attempt');
  assert.equal((await f.scheduler.latestCi(sha('c'), { display: true })).id, 42, 'only display may reuse its bounded receipt');
});
test('CI completion invalidates display state and absent webhooks cannot retain it past its TTL', async t => {
  const f = await fixture(t), { state, run } = ciProvider(f.github);
  await f.scheduler.latestCi(sha('c'), { display: true });
  state.runs.unshift({ ...run, id: 43, conclusion: 'failure' });
  await f.scheduler.handle({ type: 'ciCompleted', pr: 1, head_sha: sha('c') });
  assert.equal((await f.scheduler.latestCi(sha('c'), { display: true })).conclusion, 'failure');
  state.runs.unshift({ ...run, id: 44, status: 'queued', conclusion: null });
  f.setNow(1300001);
  assert.equal((await f.scheduler.latestCi(sha('c'), { display: true })).id, 44);
});
test('a failed CI discovery is not retained as an empty or green display receipt', async t => {
  const f = await fixture(t);
  ciProvider(f.github);
  const paginate = f.github.paginate;
  let failed = false;
  f.github.paginate = async (...args) => {
    if (!failed && args[0].includes('/check-suites')) { failed = true; throw new Error('fixture rate window'); }
    return paginate(...args);
  };
  await assert.rejects(f.scheduler.latestCi(sha('c'), { display: true }), /fixture rate window/u);
  assert.equal((await f.scheduler.latestCi(sha('c'), { display: true })).id, 42);
});
test('unchanged review intake skips redundant inspection but labels and safety-net expiry wake it', async t => {
  const f = await shepherdFixture(t);
  const active = f.add(1), settled = f.add(2);
  f.store.update(active.id, { status: 'queued' });
  f.store.update(settled.id, { bot_revision: sha('f') });
  const inspect = f.scheduler.shepherd.inspect.bind(f.scheduler.shepherd), inspected = [];
  f.scheduler.shepherd.inspect = async number => { inspected.push(number); return inspect(number); };
  await f.scheduler.reconcile();
  await f.scheduler.reconcile();
  assert.deepEqual(inspected, [2], 'active exact-head coverage and unchanged settled intake do no repeated per-PR reads');
  f.prs[1].labels = [{ name: 'hold' }];
  await f.scheduler.reconcile();
  assert.deepEqual(inspected, [2, 2], 'live label changes are not hidden by the intake hint');
  f.setNow(2800001);
  await f.scheduler.reconcile();
  assert.deepEqual(inspected, [2, 2, 2], 'a missing webhook cannot suppress the periodic safety net');
});
test('incremental sweeps read only changed webhook identities, not own comment timestamps', async t => {
  const f = await shepherdFixture(t);
  for (const number of [1, 2]) {
    const row = f.add(number, sha(number === 1 ? 'a' : 'b'));
    f.store.update(row.id, { bot_revision: sha('f') });
  }
  const reads = [];
  const request = f.github.request, paginate = f.github.paginate;
  f.github.request = async (method, path, ...args) => {
    if (method === 'GET') reads.push(path);
    return request(method, path, ...args);
  };
  f.github.paginate = async (path, ...args) => {
    if (!path.includes('/pulls?')) reads.push(path);
    return paginate(path, ...args);
  };
  const sweep = async () => {
    reads.length = 0;
    await f.scheduler.reconcile();
    assert.equal(f.scheduler.lastReconcileCounts.failed, 0);
    return [...reads];
  };
  const initial = await sweep();
  assert.ok(initial.length > 0, 'unknown startup evidence performs real per-PR reads');
  f.setNow(1300000);
  for (const pr of f.prs) pr.updated_at = 'own-status-comment-timestamp';
  assert.deepEqual(await sweep(), [], 'next five-minute sweep has zero per-PR GETs/pagination');
  const deliver = async (id, event, payload) => {
    f.store.receiveDelivery(id, event, minimalPayload({ repository: { full_name: f.github.repo }, ...payload }), f.scheduler.now());
    await f.scheduler.processDelivery(id);
  };
  await deliver('human-veto', 'pull_request_review', { action: 'submitted', pull_request: f.prs[0] });
  const changed = await sweep();
  assert.ok(changed.length > 0);
  assert.ok(changed.every(path => !path.includes('/pulls/2') && !path.includes('/issues/2')
    && !path.includes(sha('b'))), 'a human review wakes exactly its PR/head');
  assert.deepEqual(await sweep(), []);
  await deliver('unrelated', 'workflow_run', { action: 'completed', workflow_run: { name: 'Docs', head_sha: sha('b') } });
  await deliver('own-comment', 'issue_comment', { action: 'created', issue: { number: 2, pull_request: true },
    comment: { id: 99, body: 'status', user: { type: 'Bot', login: 'example-review[bot]' } } });
  assert.deepEqual(await sweep(), [], 'unrelated workflows and status-comment echoes do not dirty the catalogue');
  await deliver('one-label', 'pull_request', { action: 'labeled', pull_request: f.prs[1] });
  const labeled = await sweep();
  assert.ok(labeled.length > 0);
  assert.ok(labeled.every(path => !path.includes('/pulls/1') && !path.includes('/issues/1')
    && !path.includes(sha('a'))), 'mergeChanged from a PR event is scoped, not a global rescan');
  await deliver('one-check', 'check_suite', { action: 'completed', check_suite: { head_sha: sha('a') } });
  assert.equal((await sweep()).length, changed.length, 'head-only check events need no discovery read to dirty the exact PR');
  f.scheduler.sweepSeen.clear();
  assert.ok((await sweep()).length > 0, 'restart/unknown evidence never fabricates readiness');
  await deliver('main-moved', 'push', { ref: 'refs/heads/main' });
  const main = await sweep();
  assert.ok(main.some(path => path.endsWith('/pulls/1')) && main.some(path => path.endsWith('/pulls/2')),
    'main movement wakes both PRs without changing their heads');
  f.prs[0].body = 'source routing changed without an updated_at dependency';
  assert.ok((await sweep()).some(path => path.endsWith('/pulls/1')), 'listing semantics recover missed body-routing events');
  f.prs[1].head.sha = sha('c');
  assert.ok((await sweep()).some(path => path.endsWith('/pulls/2')), 'head movement cannot inherit a clean old-head hint');
});
test('rate backoff still journals actual exits without consuming a queued execution slot', async t => {
  const f = await queuedReviews(t, [{ pr: 1, created: 1 }, { pr: 2, created: 2 }], 1);
  const row = f.store.active(1);
  f.store.update(row.id, { status: 'running', run_id: '1-cccccccccccc-12345678' });
  f.github.retryAt = 1060000;
  f.github.request = f.github.paginate = async () => { throw new Error('no GitHub request during the shared window'); };
  const methods = [];
  f.scheduler.fetch = async (_url, { method }) => {
    methods.push(method);
    return { status: 200, ok: true, json: async () => ({ state: 'exited', exitCode: 0 }) };
  };
  await f.scheduler.tick();
  assert.equal(f.store.review(row.id).status, 'publishing');
  assert.deepEqual(JSON.parse(f.store.review(row.id).execution_exit_json), { state: 'exited', exitCode: 0 });
  assert.equal(f.store.active(2).status, 'queued');
  assert.deepEqual(methods, ['GET'], 'a local exit needs neither a new model nor remote publication');
});
test('rate rejection during setup defers the same review and starts its model once after reset', async t => {
  const f = await queuedReviews(t, [{ pr: 1, created: 1 }], 1);
  const original = f.store.active(1);
  let preparations = 0;
  f.scheduler.mirror.prepare = async () => {
    if (preparations++ === 0) {
      f.github.retryAt = 1060000;
      throw Object.assign(new Error('fixture rate limit'), { code: 'github_rate_limited', retryAt: 1060000 });
    }
    return { base_sha: sha('d') };
  };
  await f.scheduler.tick();
  const deferred = f.store.active(1);
  assert.equal(deferred.id, original.id);
  assert.equal(deferred.status, 'queued');
  assert.equal(deferred.attempt, original.attempt);
  assert.equal(deferred.due_at, 1060000);
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 0);
  f.setNow(1060000);
  await f.scheduler.tick();
  assert.equal(f.store.active(1).id, original.id);
  assert.equal(f.store.active(1).status, 'running');
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
});

test('cancellation publishes terminal after an already-in-flight start PATCH settles', async t => {
  const f = await queuedReviews(t, [{ pr: 1, created: 1 }], 1);
  const row = f.store.active(1);
  f.store.update(row.id, { check_run_id: 11 });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), cancelled = Promise.withResolvers();
  t.after(() => release.resolve());
  const request = f.github.request, statuses = [];
  f.github.request = async (method, path, body, guard = async () => {}) => {
    if (method !== 'PATCH') return request(method, path, body, guard);
    await guard('before_send');
    if (body.status === 'in_progress') { entered.resolve(); await release.promise; }
    statuses.push(body.status);
    await guard();
    return {};
  };
  f.scheduler.publisher = new Publisher({ github: f.github, store: f.store });
  f.scheduler.fetch = async (_url, { method }) => {
    assert.equal(method, 'DELETE', 'a cancelled setup must never dispatch a model');
    cancelled.resolve();
    return { status: 200, ok: true };
  };
  const starting = f.scheduler.tick();
  await entered.promise;
  const cancel = f.scheduler.handle({ type: 'cancel', pr: 1, reason: 'closed' });
  await cancelled.promise;
  assert.deepEqual(statuses, []);
  release.resolve();
  await Promise.all([starting, cancel]);
  assert.deepEqual(statuses, ['in_progress', 'completed'], 'the cancelled check cannot be left in progress by a late PATCH');
  assert.equal(f.store.review(row.id).status, 'cancelled');
});

for (const newerWork of [false, true]) {
  test(`shared-backoff mixed startup retains terminal recovery across crash and newer work=${newerWork}`, async t => {
    const f = await queuedReviews(t, [{ pr: 1, created: 1 }, { pr: 2, created: 2 }]);
    const old = f.store.active(2);
    f.store.update(old.id, { status: 'running', run_id: '2-cccccccccccc-12345678', check_run_id: 92 });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let limited = true;
    const patches = [];
    const github = new GitHubApp({ appId: f.github.appId, repo: f.github.repo,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), now: f.scheduler.now,
      sleep: async () => { throw new Error('unexpected sleep'); },
      fetchImpl: async (url, options) => {
        if (url.endsWith('/installation')) return Response.json({ id: 1 });
        if (url.endsWith('/access_tokens')) return Response.json({ token: 'fixture-token', expires_at: new Date(4600000).toISOString() });
        if (options.method === 'PATCH') { patches.push(JSON.parse(options.body)); return Response.json({ id: 92 }); }
        assert.match(url, /\/pulls\?/u);
        if (limited) return new Response('rate limit', { status: 429, headers: { 'retry-after': '2' } });
        return Response.json([]);
      } });
    const publisher = new Publisher({ github, store: f.store, now: f.scheduler.now });
    Object.assign(f.scheduler, { github, publisher });
    await f.scheduler.recover({ waitForPublications: false });
    assert.equal(github.retryAt, 1002000);
    assert.equal(f.store.review(old.id).reason, 'restart_terminal_pending');
    assert.equal(f.store.active(2), undefined);
    assert.equal(patches.length, 0);
    const secret = 'fixture-recovery-secret';
    const server = createWebhookServer({ store: f.store, scheduler: f.scheduler, secret });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const body = JSON.stringify({ repository: { full_name: github.repo } });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/github`, { method: 'POST', body,
      headers: { 'x-github-event': 'ping', 'x-github-delivery': `backoff-${newerWork}`,
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } });
    assert.equal(response.status, 202, 'HTTP intake remains available during the shared rate window');
    let newer;
    if (newerWork) newer = f.store.enqueue({ pr: 2, head_sha: sha('b'), base_ref: 'main',
      due: 1100000, reason: 'comment_rereview' }, 1001000);
    f.setNow(1002000); limited = false;
    const update = f.store.update.bind(f.store);
    f.store.update = (id, values) => {
      if (id === old.id && values.reason === 'restart') throw new Error('crash before terminal completion commit');
      return update(id, values);
    };
    await assert.rejects(f.scheduler.tickNow(), /crash before terminal completion commit/u);
    f.store.update = update;
    assert.equal(f.store.review(old.id).reason, 'restart_terminal_pending');
    assert.equal(f.store.all('SELECT id FROM reviews WHERE pr=2').length, newerWork ? 2 : 1);
    // A fresh connection and scheduler see only committed durable obligations.
    const reopened = new Store(join(f.root, 'state.sqlite'));
    t.after(() => reopened.close());
    const recovered = new Scheduler({ store: reopened, github,
      publisher: new Publisher({ github, store: reopened, now: f.scheduler.now }),
      now: f.scheduler.now, fetchImpl: f.scheduler.fetch });
    recovered.lastReconcileAt = recovered.now();
    await recovered.tickNow();
    await recovered.tickNow();
    assert.equal(reopened.review(old.id).reason, 'restart');
    assert.equal(reopened.review(old.id).check_run_id, 92);
    assert.equal(patches.length, 2, 'idempotent terminal PATCH repeats only for the uncommitted crash');
    const active = reopened.active(2);
    assert.equal(active.attempt, newerWork ? 1 : 2);
    assert.equal(active.head_sha, newerWork ? sha('b') : old.head_sha);
    assert.equal(active.due_at, newerWork ? 1100000 : 1002000);
    assert.equal(reopened.all('SELECT id FROM reviews WHERE pr=2').length, 2);
    if (!newerWork) {
      reopened.update(active.id, { status: 'running' });
      recovered.concurrency = 0;
      await recovered.recover();
      assert.equal(reopened.active(2), undefined, 'restart consumes at most two attempts');
    }
  });
}

for (const boundary of ['discovery', 'fresh_pr', 'queued_check']) {
  test(`live finding-reply debounce wins during ${boundary}`, async t => {
    const f = await queuedReviews(t, [{ pr: 1, created: 1 }]);
    const row = f.store.active(1);
    f.prs.get(1).user = { id: 42, login: 'author' };
    f.store.run("INSERT INTO findings(pr,finding_id,comment_id) VALUES(1,'F1',77)");
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const request = f.github.request, paginate = f.github.paginate, queued = f.scheduler.publisher.queued;
    let paused = false;
    const pause = async () => { if (!paused) { paused = true; entered.resolve(); await release.promise; } };
    if (boundary === 'discovery') f.github.paginate = async (...args) => { await pause(); return paginate(...args); };
    if (boundary === 'fresh_pr') f.github.request = async (...args) => { await pause(); return request(...args); };
    if (boundary === 'queued_check') f.scheduler.publisher.queued = async (...args) => { await pause(); return queued(...args); };
    const pump = f.scheduler.executionPump();
    await entered.promise;
    await f.scheduler.commentRereview({ pr: 1, trigger: 'finding_reply', in_reply_to_id: 77,
      commenter: { id: 42 }, due: 1060000 });
    release.resolve();
    await pump;
    const live = f.store.review(row.id);
    assert.equal(live.status, 'queued');
    assert.equal(live.due_at, 1060000);
    assert.equal(live.run_id, null);
    assert.equal(live.started_at, null);
    assert.deepEqual(f.started, []);
    assert.deepEqual(f.calls, []);
    f.setNow(1060000);
    await f.scheduler.executionPump();
    assert.deepEqual(f.started, [1]);
  });
}

for (const boundary of ['lookup', 'post']) {
  test(`enqueue and pump share one canonical queued check during ${boundary}`, async t => {
    const f = await queuedReviews(t, []);
    f.prs.set(1, { number: 1, state: 'open', draft: false, base: { ref: 'main' },
      head: { sha: sha('c'), repo: { full_name: f.github.repo } } });
    const entered = Promise.withResolvers(), releaseLookup = Promise.withResolvers();
    const releaseFirstPost = Promise.withResolvers();
    const checks = [], creations = [];
    let lookups = 0, posts = 0;
    const request = f.github.request;
    f.github.paginate = async path => {
      if (!path.includes('/check-runs')) return [...f.prs.values()];
      // Capture the response before yielding: the first lookup cannot adopt a
      // check created by a competing caller while its response was delayed.
      const snapshot = checks.slice();
      lookups++;
      if (boundary === 'lookup' && lookups === 1) { entered.resolve(); await releaseLookup.promise; }
      return snapshot;
    };
    f.github.request = async (method, path, body, guard = async () => {}) => {
      if (method === 'PATCH') {
        const check = checks.find(candidate => candidate.id === Number(path.split('/').at(-1)));
        assert.ok(check);
        Object.assign(check, body);
        return check;
      }
      if (method !== 'POST') return request(method, path, body);
      const ordinal = ++posts;
      const check = { id: 90 + ordinal, head_sha: body.head_sha, external_id: body.external_id,
        app: { id: f.github.appId }, status: body.status };
      creations.push(check);
      // The first accepted creation remains undiscoverable until its response
      // is released. A competing POST creates a distinct, newer required check
      // and returns first, rather than adopting the delayed first response.
      if (ordinal === 1) {
        if (boundary === 'post') entered.resolve();
        await releaseFirstPost.promise;
      }
      checks.push(check);
      await guard();
      return check;
    };
    f.scheduler.publisher = new Publisher({ store: f.store, github: f.github });
    const enqueue = f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' });
    await entered.promise;
    const starts = await f.scheduler.refill();
    assert.equal(starts.length, 1);
    // These fixture APIs have no I/O/timers. An event-loop turn drains their
    // finite promise chains, allowing an unleased contender to complete POST 2
    // before POST 1 returns, without depending on wall-clock delays.
    await new Promise(resolve => setImmediate(resolve));
    releaseLookup.resolve();
    await new Promise(resolve => setImmediate(resolve));
    releaseFirstPost.resolve();
    await enqueue; await Promise.all(starts);
    assert.equal(creations.length, 1, 'overlap must not create a second required check');
    assert.equal(f.store.active(1).check_run_id, 91);
    assert.deepEqual(f.started, [1]);
    await f.scheduler.cancel(1, 'closed');
    assert.deepEqual(checks.map(check => [check.id, check.status, check.conclusion]), [[91, 'completed', 'cancelled']],
      'terminal publication reaches the sole canonical required check');
  });
}

test('queued creation cancellation adopts accepted POST and terminalizes only its exact row', async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let checks = [], posts = 0;
  const patches = [], request = f.github.request;
  f.github.paginate = async () => checks;
  f.github.request = async (method, path, body, guard = async () => {}) => {
    if (method === 'POST') {
      posts++;
      checks = [{ id: 91, head_sha: body.head_sha, external_id: body.external_id, app: { id: f.github.appId } }];
      entered.resolve(); await release.promise; await guard(); return checks[0];
    }
    if (method === 'PATCH') { patches.push({ path, body }); return {}; }
    return request(method, path, body);
  };
  f.scheduler.publisher = new Publisher({ store: f.store, github: f.github });
  const enqueue = f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' });
  await entered.promise;
  const old = f.store.active(1);
  const cancel = f.scheduler.handle({ type: 'cancel', pr: 1, reason: 'closed' });
  release.resolve();
  await enqueue; await cancel;
  assert.equal(posts, 1);
  assert.equal(f.store.review(old.id).status, 'cancelled');
  assert.equal(f.store.review(old.id).check_run_id, 91);
  assert.deepEqual(patches.map(p => [p.path, p.body.conclusion]), [[`/repos/${f.github.repo}/check-runs/91`, 'cancelled']]);
  assert.equal(f.scheduler.publisher.queuedPending.size, 0);
});

test('failed queued creation releases its lease and restart adopts only the exact external identity', async t => {
  const f = await fixture(t);
  const row = f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' }, 1);
  let checks = [], posts = 0;
  f.github.paginate = async () => checks;
  f.github.request = async () => { posts++; throw new Error('creation unavailable'); };
  let publisher = new Publisher({ store: f.store, github: f.github });
  await assert.rejects(publisher.queued(row), /creation unavailable/u);
  assert.equal(publisher.queuedPending.size, 0);
  assert.equal(f.store.review(row.id).check_run_id, null);
  checks = [{ id: 90, head_sha: sha('b'), external_id: String(row.id), app: { id: f.github.appId } },
    { id: 91, head_sha: row.head_sha, external_id: String(row.id + 1), app: { id: f.github.appId } },
    { id: 92, head_sha: row.head_sha, external_id: String(row.id), app: { id: f.github.appId } }];
  publisher = new Publisher({ store: f.store, github: f.github });
  assert.equal((await publisher.queued(row)).check_run_id, 92);
  assert.equal(posts, 1);
});

test('queued creation retry shares a fresh lease and rejects a different row identity', async t => {
  const f = await fixture(t);
  const row = f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' }, 1);
  const publisher = new Publisher({ store: f.store, github: f.github });
  f.github.paginate = async () => [];
  f.github.request = async () => { throw new Error('not accepted'); };
  const failed = publisher.queued(row);
  const joinedFailure = publisher.queued(row);
  const results = await Promise.allSettled([failed, joinedFailure]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'not accepted'));
  assert.equal(publisher.queuedPending.size, 0);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let posts = 0;
  f.github.request = async () => { posts++; entered.resolve(); await release.promise; return { id: 93 }; };
  const retry = publisher.queued(row);
  await entered.promise;
  const otherIdentity = assert.rejects(publisher.queued({ ...row, head_sha: sha('b') }), /publication_cancelled/u);
  const joined = publisher.queued(row);
  release.resolve();
  assert.equal((await retry).check_run_id, 93);
  assert.equal((await joined).check_run_id, 93);
  await otherIdentity;
  assert.equal(posts, 1);
  assert.equal(f.store.review(row.id).check_run_id, 93);
});

for (const boundary of ['terminal', 'disarm']) {
  test(`restart replacement admission respects mode off during ${boundary}`, async t => {
    const f = await fixture(t);
    const row = f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' }, 1);
    f.store.update(row.id, { status: 'failed', reason: 'restart_terminal_pending', conclusion: 'neutral', check_run_id: 91 });
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const terminal = f.scheduler.publisher.terminal;
    f.scheduler.publisher.terminal = async (...args) => {
      if (boundary === 'terminal') { entered.resolve(); await release.promise; }
      return terminal(...args);
    };
    f.scheduler.approval = { disable: async () => {
      if (boundary === 'disarm') { entered.resolve(); await release.promise; }
    } };
    const recovery = f.scheduler.resumeRestartTerminals();
    await entered.promise;
    f.scheduler.mode = 'off';
    release.resolve();
    await recovery;
    assert.equal(f.store.review(row.id).reason, 'restart', 'the real terminal obligation may settle');
    assert.equal(f.store.review(row.id).check_run_id, 91);
    assert.equal(f.store.active(1), undefined, 'off mode must not admit a replacement');
    assert.equal(f.store.all('SELECT id FROM reviews WHERE pr=1').length, 1);
    assert.deepEqual(f.calls, [['check', row.id, 'neutral', 'restart']]);
  });
}

test('terminal HTTP 5xx without shared backoff fences automatic same-head admission and preserves retry ceiling', async t => {
  const f = await queuedReviews(t, [{ pr: 1, created: 1 }]);
  const row = f.store.active(1);
  f.store.update(row.id, { status: 'running', check_run_id: 91 });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let unavailable = true, patches = 0;
  const github = new GitHubApp({ appId: f.github.appId, repo: f.github.repo,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), now: f.scheduler.now,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      if (url.endsWith('/installation')) return Response.json({ id: 1 });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'fixture-token', expires_at: new Date(4600000).toISOString() });
      if (options.method === 'PATCH') {
        patches++;
        return unavailable ? new Response('unavailable', { status: 503 }) : Response.json({ id: 91 });
      }
      throw new Error(`unexpected fixture request ${options.method} ${url}`);
    } });
  Object.assign(f.scheduler, { github, publisher: new Publisher({ github, store: f.store, now: f.scheduler.now }) });
  f.scheduler.concurrency = 0;
  f.scheduler.reconcileCounts = { failed: 0, skipped: 0 };
  await f.scheduler.recover();
  assert.equal(github.retryAt, 0, 'ordinary 503 establishes no shared rate window');
  assert.equal(patches, 3, 'real GitHubApp exhausts the bounded PATCH retry');
  assert.equal(f.store.review(row.id).reason, 'restart_terminal_pending');
  await f.scheduler.reconcileReview(f.prs.get(1));
  for (const reason of ['reconcile', 'upgrade_rereview', 'reuse_verdict', 'synchronize', 'ambiguous_rereview']) {
    assert.equal(await f.scheduler.enqueue({ pr: 1, head_sha: row.head_sha, base_ref: 'main', due: 0, reason }), null);
  }
  assert.equal(f.store.all('SELECT id FROM reviews').length, 1, 'automatic work cannot reset attempt to one');
  assert.equal(f.store.active(1), undefined);
  unavailable = false;
  await f.scheduler.tickNow();
  const retry = f.store.active(1);
  assert.equal(retry.attempt, 2);
  assert.equal(retry.reason, 'restart');
  f.store.update(retry.id, { status: 'running', check_run_id: 92 });
  unavailable = true;
  await f.scheduler.recover();
  await f.scheduler.reconcileReview(f.prs.get(1));
  assert.equal(f.store.review(retry.id).reason, 'restart_terminal_pending');
  assert.equal(f.store.active(1), undefined);
  unavailable = false;
  await f.scheduler.tickNow();
  await f.scheduler.reconcileReview(f.prs.get(1));
  assert.equal(f.store.review(retry.id).reason, 'restart');
  assert.equal(f.store.active(1), undefined, 'terminal attempt two cannot become a fresh automatic attempt one');
  assert.equal(f.store.all('SELECT id FROM reviews').length, 2);
});

test('pending restart fences only its unsuperseded exact head, not authorized fresh comment work', async t => {
  const f = await fixture(t);
  const row = f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' }, 1);
  f.store.update(row.id, { status: 'failed', reason: 'restart_terminal_pending' });
  assert.equal(f.scheduler.pendingRestart(1, sha('b')), undefined);
  const fresh = await f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main',
    due: 1060000, reason: 'comment_rereview' });
  assert.equal(fresh.attempt, 1);
  assert.equal(fresh.due_at, 1060000);
  assert.equal(f.scheduler.pendingRestart(1, sha('c')), undefined, 'newer explicit work supersedes the old retry obligation');
  await f.scheduler.resumeRestartTerminals();
  assert.equal(f.store.active(1).id, fresh.id);
  assert.equal(f.store.active(1).due_at, 1060000);
});

test('pending restart permits automatic reconciliation of a genuinely newer head', async t => {
  const f = await queuedReviews(t, [{ pr: 1, created: 1 }]);
  const old = f.store.active(1);
  f.store.update(old.id, { status: 'failed', reason: 'restart_terminal_pending' });
  f.prs.get(1).head.sha = sha('b');
  await f.scheduler.reconcileReview(f.prs.get(1));
  const fresh = f.store.active(1);
  assert.equal(fresh.head_sha, sha('b'));
  assert.equal(fresh.attempt, 1);
  await f.scheduler.resumeRestartTerminals();
  assert.equal(f.store.active(1).id, fresh.id);
  assert.equal(f.store.all('SELECT id FROM reviews WHERE pr=1').length, 2);
});

for (const missingIdentity of [false, true]) {
  test(`cancelled canonical survives shared GitHubApp backoff and off-mode restart; missing ID=${missingIdentity}`, async t => {
    const f = await fixture(t);
    const row = f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' }, 1);
    const evidence = { publication_id: row.id, postedReviewId: 72, result: { pass: true }, findings: [] };
    f.store.update(row.id, { status: 'running', run_id: '1-cccccccccccc-12345678',
      check_run_id: missingIdentity ? null : 91, result_json: JSON.stringify(evidence) });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const checks = [
      { id: 90, head_sha: sha('b'), external_id: String(row.id), app: { id: f.github.appId }, status: 'queued' },
      { id: 91, head_sha: row.head_sha, external_id: String(row.id), app: { id: f.github.appId }, status: 'in_progress' },
      { id: 92, head_sha: row.head_sha, external_id: String(row.id + 1), app: { id: f.github.appId }, status: 'queued' },
    ];
    const patches = [];
    const requests = [];
    const createGithub = () => new GitHubApp({ appId: f.github.appId, repo: f.github.repo,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), now: f.scheduler.now,
      sleep: async () => { throw new Error('unexpected sleep'); },
      fetchImpl: async (url, options) => {
        requests.push([options.method, url]);
        if (url.endsWith('/installation')) return Response.json({ id: 1 });
        if (url.endsWith('/access_tokens')) return Response.json({ token: 'fixture-token', expires_at: new Date(4600000).toISOString() });
        if (url.includes('/pulls?')) return new Response('rate limit', { status: 429, headers: { 'retry-after': '2' } });
        if (url.includes('/commits/')) return Response.json({ check_runs: checks });
        assert.equal(options.method, 'PATCH', 'terminal recovery must never create a check or review');
        const id = Number(url.split('/').at(-1)), body = JSON.parse(options.body);
        patches.push({ id, body });
        Object.assign(checks.find(check => check.id === id), body);
        return Response.json({ id });
      } });
    const github = createGithub();
    Object.assign(f.scheduler, { github, publisher: new Publisher({ github, store: f.store, now: f.scheduler.now }) });
    await assert.rejects(github.paginate(`/repos/${github.repo}/pulls?state=open`), error => error.code === 'github_rate_limited');
    await f.scheduler.handle({ type: 'cancel', pr: 1, reason: 'closed' });
    await f.scheduler.handle({ type: 'cancel', pr: 1, reason: 'superseded' });
    assert.equal(f.store.review(row.id).status, 'cancelled');
    assert.equal(f.store.review(row.id).reason, 'closed');
    assert.equal(checks[1].status, 'in_progress', 'the real shared window prevents the immediate terminal PATCH');
    assert.equal(f.calls.filter(([method]) => method === 'DELETE').length, 1);
    const newer = f.store.enqueue({ pr: 1, head_sha: sha('b'), base_ref: 'main', due: 1100000, reason: 'synchronize' }, 1001000);
    f.store.update(newer.id, { check_run_id: 90 });
    const reopened = new Store(join(f.root, 'state.sqlite'));
    t.after(() => reopened.close());
    const freshGithub = createGithub();
    assert.equal(freshGithub.retryAt, 0, 'a real restart loses the original client window');
    const beforeRecovery = requests.length;
    const restarted = new Scheduler({ store: reopened, github: freshGithub, mode: 'off', now: f.scheduler.now,
      publisher: new Publisher({ github: freshGithub, store: reopened, now: f.scheduler.now }),
      fetchImpl: async () => { throw new Error('cancelled recovery must not contact runner'); } });
    await restarted.recover();
    f.setNow(1001999);
    await restarted.tickNow();
    assert.equal(requests.length, beforeRecovery, 'the persisted deadline suppresses every request without a fresh 429');
    assert.equal(patches.length, 0);
    f.setNow(1002000);
    await restarted.tickNow();
    await restarted.tickNow();
    assert.deepEqual(patches.map(({ id, body }) => [id, body.conclusion, body.output.summary]), [[91, 'cancelled', 'closed']]);
    assert.equal(checks[1].status, 'completed');
    assert.equal(checks[0].status, 'queued');
    assert.equal(checks[2].status, 'queued');
    assert.equal(reopened.active(1).id, newer.id);
    assert.equal(reopened.active(1).due_at, 1100000);
    assert.equal(reopened.review(row.id).check_run_id, 91);
    assert.deepEqual(JSON.parse(reopened.review(row.id).result_json), evidence, 'terminal journal must preserve publication evidence');
    assert.equal(reopened.all('SELECT id FROM reviews').length, 2);
  });
}

for (const failureKind of ['timeout', '503', 'unrelated', 'store']) {
  test(`cancellation terminal defers only recognized external failures: ${failureKind}`, async t => {
    const f = await fixture(t);
    const row = f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' }, 1);
    f.store.update(row.id, { status: 'running', check_run_id: 91 });
    let attempts = 0, failing = true;
    const failure = failureKind === 'timeout' ? new Error('github_timeout')
      : failureKind === 'unrelated' ? new Error('permission denied')
        : Object.assign(new Error('unavailable'), { github: { status: 503 } });
    f.scheduler.publisher.terminal = async () => { attempts++; if (failing && failureKind !== 'store') throw failure; };
    const update = f.store.update.bind(f.store);
    if (failureKind === 'store') f.store.update = (id, values) => {
      if (values.result_json === null) throw failure;
      return update(id, values);
    };
    if (['unrelated', 'store'].includes(failureKind)) {
      await assert.rejects(f.scheduler.cancel(1, 'draft'), error => error === failure);
    } else {
      await f.scheduler.cancel(1, 'draft');
      await f.scheduler.resumeCancellationTerminals();
      assert.equal(attempts, 1, 'timeout/5xx retry is bounded to one attempt per minute');
      f.setNow(1060000);
    }
    assert.equal(f.store.review(row.id).status, 'cancelled');
    assert.equal(f.store.review(row.id).reason, 'draft');
    assert.ok(JSON.parse(f.store.review(row.id).result_json).cancellation_terminal_pending);
    failing = false; f.store.update = update;
    await f.scheduler.resumeCancellationTerminals();
    assert.equal(f.store.review(row.id).result_json, null);
    assert.equal(f.store.active(1), undefined);
    assert.equal(f.store.all('SELECT id FROM reviews').length, 1);
  });
}

test('accepted queued POST under shared backoff is adopted after cancellation restart without creating again', async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const checks = [], patches = [];
  let posts = 0;
  const createGithub = () => new GitHubApp({ appId: f.github.appId, repo: f.github.repo,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), now: f.scheduler.now,
    sleep: async () => { throw new Error('unexpected sleep'); },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/installation')) return Response.json({ id: 1 });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'fixture-token', expires_at: new Date(4600000).toISOString() });
      if (url.endsWith('/pulls/1')) return Response.json({ state: 'open', draft: false, base: { ref: 'main' },
        head: { sha: sha('c'), repo: { full_name: f.github.repo } } });
      if (url.includes('/pulls?')) return new Response('limited', { status: 429, headers: { 'retry-after': '2' } });
      if (url.includes('/commits/')) return Response.json({ check_runs: checks });
      if (options.method === 'POST') {
        posts++;
        const body = JSON.parse(options.body);
        checks.push({ ...body, id: 91, app: { id: f.github.appId } });
        entered.resolve(); await release.promise;
        return Response.json(checks[0]);
      }
      assert.equal(options.method, 'PATCH');
      patches.push(JSON.parse(options.body));
      Object.assign(checks[0], patches.at(-1));
      return Response.json({ id: 91 });
    } });
  const github = createGithub();
  Object.assign(f.scheduler, { github, publisher: new Publisher({ github, store: f.store, now: f.scheduler.now }) });
  const enqueue = f.scheduler.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' });
  const enqueueDeferred = assert.rejects(enqueue, error => error.code === 'github_rate_limited');
  await entered.promise;
  const row = f.store.active(1);
  const cancelled = f.scheduler.handle({ type: 'cancel', pr: 1, reason: 'closed' });
  await assert.rejects(github.paginate(`/repos/${github.repo}/pulls?state=open`), error => error.code === 'github_rate_limited');
  release.resolve();
  // A queued POST may have been accepted although its guarded response and
  // immediate read-only adoption are blocked by the shared window.
  await Promise.all([enqueueDeferred, cancelled]);
  assert.equal(f.store.review(row.id).status, 'cancelled');
  assert.equal(checks[0].status, 'queued');
  assert.equal(patches.length, 0);
  const reopened = new Store(join(f.root, 'state.sqlite'));
  t.after(() => reopened.close());
  const freshGithub = createGithub();
  assert.equal(freshGithub.retryAt, 0);
  const restarted = new Scheduler({ store: reopened, github: freshGithub, mode: 'off', now: f.scheduler.now,
    publisher: new Publisher({ github: freshGithub, store: reopened, now: f.scheduler.now }),
    fetchImpl: async () => { throw new Error('no reviewer may start'); } });
  await restarted.recover();
  assert.equal(patches.length, 0, 'fresh-client recovery must honor the persisted shared deadline');
  f.setNow(1002000);
  await restarted.tickNow();
  await restarted.tickNow();
  assert.equal(posts, 1);
  assert.equal(reopened.review(row.id).check_run_id, 91);
  assert.equal(reopened.review(row.id).reason, 'closed');
  assert.equal(reopened.review(row.id).result_json, null);
  assert.equal(checks[0].status, 'completed');
  assert.deepEqual(patches.map(body => [body.conclusion, body.output.summary]), [['cancelled', 'closed']]);
  assert.equal(reopened.all('SELECT id FROM reviews').length, 1);
});

async function pendingReplyFixture(t) {
  const f = await queuedReviews(t, [1, 3].map(pr => ({ pr, created: pr })), 2);
  f.prs.set(2, { ...structuredClone(f.prs.get(3)), number: 2, user: { id: 42, login: 'author' } });
  const previous = f.store.enqueue({ pr: 2, head_sha: sha('b'), base_ref: 'main', due: 0, reason: 'opened' }, 1);
  f.store.update(previous.id, { status: 'completed', conclusion: 'success', result_json: '{}', started_at: 1, finished_at: 2 });
  const queued = f.store.enqueue({ pr: 2, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'synchronize' }, 2);
  f.store.run(`INSERT INTO findings(pr,finding_id,first_review_id,last_review_id,status,comment_id)
    VALUES(2,'F1',?,?,'new',500)`, previous.id, previous.id);
  const outcomes = [];
  f.scheduler.log = entry => { if (entry.event === 'comment_rereview') outcomes.push(entry.outcome); };
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.scheduler.verdict.evaluate = async () => { entered.resolve(); await release.promise; return { decision: 'approve' }; };
  f.scheduler.publisher.completed = async () => 'success';
  const publishing = f.store.update(f.store.active(1).id, { status: 'running', check_run_id: 91 });
  const report = { result: { pass: true }, findings: [], priorFindingIds: [], diff: '' };
  f.store.publicationIntent(publishing, report);
  const publication = f.scheduler.serialize(() => f.scheduler.publishNow(f.store.review(publishing.id), report));
  await entered.promise;
  const receive = ({ id = 'pending-finding-reply', author = true, finding = true, pr = 2, createdAt = f.scheduler.now() } = {}) => {
    f.store.receiveDelivery(id, 'pull_request_review_comment', minimalPayload({
      action: 'created', repository: { full_name: f.github.repo }, pull_request: f.prs.get(pr),
      comment: { id: 901, in_reply_to_id: finding ? 500 : 999, created_at: new Date(createdAt).toISOString(),
        body: 'This finding is answered.', user: { id: author ? 42 : 99, login: author ? 'author' : 'other', type: 'User' } },
    }), f.scheduler.now());
    return id;
  };
  return { ...f, queued, previous, outcomes, receive, publication, releasePublication: release.resolve };
}

for (const [boundary, decideFirst] of [
  ...['queued', 'pr_read', 'queued_check', 'start_status', 'carry', 'carry_ci', 'prepare'].map(boundary => [boundary, false]),
  ...['start_status', 'carry', 'carry_ci', 'prepare'].map(boundary => [boundary, true]),
]) {
  test(`durable finding reply holds the same review at ${boundary}, delivery decides before preparation=${decideFirst}`, async t => {
    const f = await pendingReplyFixture(t);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    let held = false;
    const hold = async pr => {
      if (pr === 2 && !held) { held = true; entered.resolve(); await release.promise; }
    };
    if (boundary === 'pr_read') {
      const request = f.github.request;
      f.github.request = async (...args) => {
        if (args[1].endsWith('/pulls/2')) await hold(2);
        return request(...args);
      };
    }
    if (boundary === 'queued_check') {
      const queued = f.scheduler.publisher.queued;
      f.scheduler.publisher.queued = async (row, guard) => { await hold(row.pr); await guard(); return queued(row, guard); };
    }
    if (boundary === 'start_status') {
      f.scheduler.publisher.started = async (row, guard) => { await hold(row.pr); await guard(); };
    }
    const carries = [];
    f.scheduler.mirror.carry = async row => {
      carries.push(row.pr);
      if (boundary === 'carry') await hold(row.pr);
      return ['carry', 'carry_ci'].includes(boundary)
        ? { base_sha: sha('d'), result: { pass: true }, findings: [], priorFindingIds: [], diff: '' } : null;
    };
    if (boundary === 'carry_ci') f.scheduler.attachCi = async row => { await hold(row.pr); };
    if (boundary === 'prepare') {
      const prepare = f.scheduler.mirror.prepare;
      f.scheduler.mirror.prepare = async (...args) => { await hold(args[0].pr); return prepare(...args); };
    }
    const posts = [];
    f.scheduler.fetch = async (url, { method }) => {
      if (method === 'POST') posts.push(f.store.review(Number(url.split('/').at(-1).split('-')[0])).pr);
      return { ok: true, status: method === 'POST' ? 202 : 200 };
    };
    let delivery, starts;
    if (boundary === 'queued') delivery = f.scheduler.processDelivery(f.receive());
    starts = Promise.all(await f.scheduler.refill());
    if (boundary !== 'queued') {
      await entered.promise;
      delivery = f.scheduler.processDelivery(f.receive());
      if (decideFirst) {
        f.releasePublication();
        await Promise.all([f.publication, delivery]);
        const absorbedBeforePreparation = f.store.review(f.queued.id);
        assert.equal(absorbedBeforePreparation.status, 'queued', 'delivery must revoke exact provisional execution without awaiting it');
        assert.equal(absorbedBeforePreparation.run_id, null);
        assert.equal(absorbedBeforePreparation.reason, 'comment_rereview');
        assert.equal(absorbedBeforePreparation.due_at, 1060000);
        assert.equal(f.store.commentRereviews(2, sha('c')), 0);
      }
      release.resolve();
    }
    await starts;
    const heldRow = f.store.review(f.queued.id);
    assert.equal(heldRow.status, 'queued', 'an unstarted preparation must not strand a running/no-runner row');
    assert.equal(heldRow.run_id, null);
    assert.equal(heldRow.started_at, null);
    assert.equal(heldRow.reason, decideFirst ? 'comment_rereview' : 'synchronize', 'authorization owns carry policy, not the pending fence');
    assert.equal(heldRow.due_at, decideFirst ? 1060000 : 0);
    assert.deepEqual(posts, [3], 'a pending reply fences only its PR while publication blocks serialized delivery');
    assert.equal(f.store.commentRereviews(2, sha('c')), 0);
    assert.equal(f.store.get("SELECT state FROM deliveries WHERE id='pending-finding-reply'").state, decideFirst ? 'processed' : 'received');
    const carryAttempts = carries.length;
    f.releasePublication();
    await Promise.all([f.publication, delivery]);
    const absorbed = f.store.review(f.queued.id);
    assert.equal(f.store.active(2).id, f.queued.id);
    assert.equal(absorbed.reason, 'comment_rereview');
    assert.equal(absorbed.due_at, 1060000);
    assert.deepEqual(f.outcomes, ['absorbed']);
    assert.equal(f.store.commentRereviews(2, sha('c')), 0);
    assert.equal(f.store.all('SELECT id FROM reviews WHERE pr=2').length, 2, 'no replacement review or comment budget is consumed');
    f.setNow(1060000);
    await Promise.all(await f.scheduler.refill());
    assert.deepEqual(posts, [3, 2]);
    assert.equal(carries.length, carryAttempts, 'the absorbed reply disables carry before the eventual start');
  });
}

for (const rejected of ['unauthorized', 'not_a_finding']) {
  test(`undecided ${rejected} reply holds only until serialized authorization rejects it`, async t => {
    const f = await pendingReplyFixture(t);
    const delivery = f.scheduler.processDelivery(f.receive({ author: rejected !== 'unauthorized', finding: rejected !== 'not_a_finding' }));
    await Promise.all(await f.scheduler.refill());
    assert.equal(f.store.review(f.queued.id).status, 'queued');
    assert.equal(f.store.active(3).status, 'running');
    f.releasePublication();
    await Promise.all([f.publication, delivery]);
    assert.deepEqual(f.outcomes, [rejected]);
    assert.equal(f.store.review(f.queued.id).reason, 'synchronize');
    assert.equal(f.store.review(f.queued.id).due_at, 0);
    assert.equal(f.store.commentRereviews(2, sha('c')), 0);
    await Promise.all(await f.scheduler.refill());
    assert.equal(f.store.review(f.queued.id).status, 'running', 'a rejected comment cannot leave a permanent false hold');
  });
}

test('received finding reply fences queued execution across restart before delivery processing', async t => {
  const f = await pendingReplyFixture(t);
  f.receive();
  f.releasePublication();
  await f.publication;
  const reopened = new Store(join(f.root, 'state.sqlite'));
  t.after(() => reopened.close());
  const posts = [];
  const restarted = new Scheduler({ store: reopened, github: f.github, now: f.scheduler.now, concurrency: 2,
    publisher: { ...f.scheduler.publisher, queued: async row => reopened.update(row.id, { check_run_id: row.id + 10 }) },
    mirror: f.scheduler.mirror, verdict: f.scheduler.verdict,
    fetchImpl: async (url, { method }) => {
      if (method === 'POST') posts.push(reopened.review(Number(url.split('/').at(-1).split('-')[0])).pr);
      return { ok: true, status: method === 'POST' ? 202 : 200 };
    } });
  await restarted.recover();
  assert.deepEqual(posts, [3], 'startup refill must honor the durable reply without any in-memory processDelivery marker');
  assert.equal(reopened.review(f.queued.id).status, 'queued');
  assert.equal(reopened.get("SELECT state FROM deliveries WHERE id='pending-finding-reply'").state, 'received');
  await restarted.processDelivery('pending-finding-reply');
  assert.equal(reopened.active(2).id, f.queued.id);
  assert.equal(reopened.review(f.queued.id).reason, 'comment_rereview');
  assert.equal(reopened.review(f.queued.id).due_at, 1060000);
  assert.equal(reopened.commentRereviews(2, sha('c')), 0);
});

for (const control of ['unrelated', 'covered', 'runner_post']) {
  test(`pending reply cannot roll back ${control} execution`, async t => {
    const f = await pendingReplyFixture(t);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    if (control === 'covered') f.store.update(f.queued.id, { reason: 'opened' });
    if (control !== 'runner_post') {
      const prepare = f.scheduler.mirror.prepare;
      f.scheduler.mirror.prepare = async (...args) => { entered.resolve(); await release.promise; return prepare(...args); };
    }
    let posts = 0;
    f.scheduler.fetch = async (_url, { method }) => {
      if (method === 'POST') {
        posts++;
        if (control === 'runner_post') { entered.resolve(); await release.promise; }
      }
      return { ok: true, status: method === 'POST' ? 202 : 200 };
    };
    const starting = f.scheduler.start(f.store.review(f.queued.id));
    await entered.promise;
    const delivery = f.scheduler.processDelivery(f.receive({
      pr: control === 'unrelated' ? 3 : 2,
      createdAt: control === 'covered' ? 900000 : f.scheduler.now(),
    }));
    release.resolve();
    await starting;
    assert.equal(posts, 1);
    const running = f.store.review(f.queued.id);
    assert.equal(running.status, 'running');
    assert.ok(running.run_id);
    assert.equal(running.started_at, 1000000);
    f.releasePublication();
    await Promise.all([f.publication, delivery]);
    if (control === 'runner_post') {
      assert.equal(f.store.review(f.queued.id).status, 'cancelled', 'a genuinely launched review uses normal cancellation, never provisional rollback');
      assert.notEqual(f.store.active(2).id, f.queued.id);
      assert.equal(f.store.commentRereviews(2, sha('c')), 1);
    } else {
      assert.equal(f.store.active(2).id, f.queued.id);
      assert.equal(f.store.active(2).status, 'running');
      assert.equal(f.store.commentRereviews(2, sha('c')), 0);
      assert.deepEqual(f.outcomes, [control === 'covered' ? 'covered' : 'unauthorized']);
    }
  });
}

for (const boundary of ['execution', 'start']) {
  test(`deferred ${boundary} cancellation cannot cancel a reconciled newer-head review`, async (t) => {
    const f = await fixture(t);
    const old = f.store.enqueue({ pr: 1, head_sha: sha('c'), base_ref: 'main', due: 0, reason: 'opened' }, 1);
    f.store.update(old.id, { status: boundary === 'execution' ? 'publishing' : 'queued', check_run_id: 11 });
    const current = { number: 1, state: 'open', draft: false, user: builder, labels: [],
      head: { sha: sha('e'), repo: { full_name: f.github.repo } }, base: { ref: 'main', sha: sha('d') } };
    f.github.request = async () => current;
    f.github.paginate = async (path) => path === `/repos/${f.github.repo}/pulls?state=open` ? [current] : [];
    const paused = Promise.withResolvers(), release = Promise.withResolvers();
    f.scheduler.shepherdBefore = async () => { paused.resolve(); await release.promise; return null; };
    const reconciling = f.scheduler.serialize(() => f.scheduler.reconcile());
    await paused.promise;
    let staleStart;
    try {
      if (boundary === 'execution') assert.equal(await f.scheduler.executionFence(f.store.review(old.id)), false);
      else {
        staleStart = f.scheduler.start(f.store.review(old.id));
        // Drain the PR-read continuation so its cancellation queues behind the sweep.
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally { release.resolve(); }
    await reconciling;
    await staleStart;
    await f.scheduler.operations;
    const replacement = f.store.active(1);
    assert.equal(f.store.review(old.id).status, 'cancelled');
    assert.equal(f.store.review(old.id).reason, 'superseded');
    assert.notEqual(replacement?.id, old.id);
    assert.equal(replacement.head_sha, current.head.sha);
    assert.equal(replacement.status, 'queued');
    assert.equal(replacement.check_run_id, replacement.id + 10);
    assert.deepEqual(f.calls.filter(call => call[0] === 'check'), [['check', old.id, 'cancelled', 'superseded']]);
    await Promise.all(await f.scheduler.refill());
    assert.equal(f.store.review(replacement.id).status, 'running');
    assert.equal(f.store.review(replacement.id).head_sha, current.head.sha);
    assert.equal(f.calls.filter(call => call[0] === 'POST').length, 1);
  });
}

test('blocked four-worker presentation preparation does not queue an independent runner start', async (t) => {
  const f = await queuedReviews(t, [{ pr: 1, created: 1 }], 1);
  const candidate = { ...structuredClone(f.prs.get(1)), number: 3, mergeable: true,
    head: { sha: sha('b'), repo: { full_name: f.github.repo } } };
  f.prs.set(3, candidate);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), started = Promise.withResolvers();
  f.github.paginate = async (path) => path.includes('pulls?') ? [...f.prs.values()] : [];
  f.github.request = async (_method, path, _body, _guard, options) => {
    if (path.endsWith('/pulls/3')) {
      if (options?.informational) { entered.resolve(); await release.promise; }
      return structuredClone(candidate);
    }
    if (path.includes('/compare/')) return { behind_by: 0, base_commit: { sha: sha('d') } };
    return f.prs.get(Number(path.split('/').at(-1)));
  };
  f.scheduler.shepherd = new Shepherd({ github: f.github, store: f.store });
  f.scheduler.shepherd.publishStatus = async () => {};
  f.scheduler.attachCi = async () => {};
  f.scheduler.fetch = async (_url, { method }) => {
    if (method === 'POST') started.resolve();
    return { status: 202, ok: true };
  };
  const maintenance = f.scheduler.serialize(() => f.scheduler.reconcileNow());
  await entered.promise;
  const tick = f.scheduler.tick();
  await started.promise;
  assert.equal(f.store.active(1).status, 'running');
  assert.ok(!f.store.active(3), 'preparation still waits without publishing or enqueuing its PR');
  release.resolve();
  await Promise.all([maintenance, tick]);
});

for (const change of ['head', 'pending-delivery', 'debounced-enqueue', 'off']) {
  test(`ordered presentation drops a prepared PR after ${change} changes while reads are pending`, async (t) => {
    const f = await fixture(t);
    const pr = { number: 1, state: 'open', draft: false, mergeable: true, labels: [{ name: 'needs-update' }],
      head: { sha: sha('c'), repo: { full_name: f.github.repo } }, base: { ref: 'main', sha: sha('d') } };
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const writes = [];
    f.github.paginate = async (path) => {
      if (path.includes('pulls?')) return [structuredClone(pr)];
      if (path.endsWith('/reviews')) { entered.resolve(); await release.promise; }
      return [];
    };
    f.github.request = async (method, path, _body, guard) => {
      if (method !== 'GET') { await guard?.('before_send'); writes.push([method, path]); return { id: 100 }; }
      if (path.includes('/compare/')) return { behind_by: 0, base_commit: { sha: sha('d') } };
      return structuredClone(pr);
    };
    f.scheduler.shepherd = new Shepherd({ github: f.github, store: f.store });
    const sweep = f.scheduler.reconcile();
    await entered.promise;
    if (change === 'head') pr.head.sha = sha('b');
    if (change === 'off') f.scheduler.mode = 'off';
    if (change === 'debounced-enqueue') f.scheduler.noteCancellation({ type: 'enqueue', pr: 1,
      head_sha: sha('c'), reason: 'synchronize', due: f.scheduler.now() + 60000 });
    if (change === 'pending-delivery') {
      f.store.receiveDelivery('live-preparation-comment', 'issue_comment', minimalPayload({
        action: 'created', repository: { full_name: f.github.repo }, issue: { number: 1, pull_request: {} },
        comment: { id: 999, created_at: new Date(f.scheduler.now()).toISOString(), body: '/rereview', user: builder },
      }), f.scheduler.now());
    }
    release.resolve();
    await sweep;
    assert.deepEqual(writes, [], 'stale informational work cannot cause a label, review, or status write');
    assert.ok(!f.store.active(1));
  });
}

test('presentation reads occupy at most four workers and out-of-order completion preserves label commit order', async (t) => {
  const f = await fixture(t);
  const gates = Array.from({ length: 6 }, () => Promise.withResolvers());
  const fourStarted = Promise.withResolvers();
  const prs = gates.map((_, index) => ({ number: index + 1, state: 'open', draft: false, mergeable: true,
    labels: [{ name: 'needs-update' }], head: { sha: (index + 1).toString(16).repeat(40), repo: { full_name: f.github.repo } },
    base: { ref: 'main', sha: sha('d') } }));
  let active = 0, peak = 0, entered = 0;
  const labels = [];
  f.github.paginate = async (path) => path.includes('pulls?') ? structuredClone(prs) : [];
  f.github.request = async (method, path, _body, guard, options) => {
    const number = Number(/\/pulls\/(\d+)/u.exec(path)?.[1]);
    if (options?.informational && number) {
      peak = Math.max(peak, ++active);
      if (++entered === 4) fourStarted.resolve();
      await gates[number - 1].promise;
      active--;
    }
    if (method === 'DELETE') {
      await guard?.('before_send');
      const number = Number(/\/issues\/(\d+)/u.exec(path)[1]);
      labels.push(number); prs[number - 1].labels = [];
      return {};
    }
    if (path.includes('/compare/')) return { behind_by: 0, base_commit: { sha: sha('d') } };
    return structuredClone(prs[number - 1]);
  };
  f.scheduler.shepherd = new Shepherd({ github: f.github, store: f.store });
  f.scheduler.shepherd.publishStatus = async () => {};
  const sweep = f.scheduler.reconcile();
  await fourStarted.promise;
  gates[3].resolve(); gates[2].resolve(); gates[1].resolve(); gates[4].resolve(); gates[5].resolve();
  await new Promise(setImmediate);
  assert.deepEqual(labels, [], 'later preparations may finish, but the first PR owns the next commit');
  gates[0].resolve();
  await sweep;
  assert.equal(peak, 4);
  assert.deepEqual(labels, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(f.store.all('SELECT pr FROM reviews ORDER BY id').map((row) => row.pr), [1, 2, 3, 4, 5, 6]);
});

test('approval recovery cannot nest candidate discovery above the four presentation workers', async (t) => {
  const f = await fixture(t), native = nativeApprovalFixture(f);
  native.pr.base.sha = sha('d');
  native.pr.mergeable = true;
  const completed = completedApprovalRow(f).row;
  const prs = [native.pr, ...Array.from({ length: 5 }, (_, index) => ({
    ...structuredClone(native.pr), number: index + 2, node_id: `PR_${index + 2}`,
    head: { ...structuredClone(native.pr.head), sha: sha((index + 2).toString(16)) },
  }))];
  ciProvider(f.github);
  const request = f.github.request, paginate = f.github.paginate;
  const fourStarted = Promise.withResolvers(), approved = Promise.withResolvers(), release = Promise.withResolvers();
  let active = 0, peak = 0, started = 0;
  f.github.request = async (method, path, ...args) => {
    const number = Number(/\/pulls\/(\d+)$/u.exec(path)?.[1]);
    if (args[2]?.informational && number > 1) {
      peak = Math.max(peak, ++active);
      if (++started === 4) fourStarted.resolve();
      await release.promise;
      active--;
    }
    if (method === 'GET' && number) return structuredClone(prs[number - 1]);
    if (path.endsWith('/git/ref/heads/main')) return { object: { sha: sha('d') } };
    if (path.includes('/compare/main...')) return { behind_by: 0, base_commit: { sha: sha('d') } };
    const result = await request(method, path, ...args);
    if (method === 'POST' && path.endsWith('/reviews')) approved.resolve();
    return result;
  };
  f.github.paginate = async (path, ...args) => path.includes('pulls?') ? structuredClone(prs) : paginate(path, ...args);
  f.scheduler.shepherd = new Shepherd({ github: f.github, store: f.store });
  const sweep = f.scheduler.reconcile();
  await fourStarted.promise;
  await approved.promise;
  await new Promise(setImmediate);
  const duringRecovery = peak;
  release.resolve();
  await sweep;
  assert.equal(f.store.approvalForReview(completed.id).outcome, 'approved');
  assert.equal(duringRecovery, 4, 'recovered approval must not start a second discovery pool before presentation drains');
  assert.equal(peak, 4);
});

for (const unavailable of ['human-display', 'ci-display', 'compare-inspection']) {
  for (const work of ['enqueue', 'approval-recovery']) {
    test(`${unavailable} prefetch failure cannot suppress ${work} reconciliation`, async (t) => {
      const f = await fixture(t), native = nativeApprovalFixture(f), logs = [];
      native.pr.mergeable = true;
      const completed = work === 'approval-recovery' ? completedApprovalRow(f).row : null;
      ciProvider(f.github);
      const request = f.github.request, paginate = f.github.paginate;
      f.github.request = async (method, path, ...args) => {
        if (method === 'GET' && path.includes('/compare/main...')) {
          if (unavailable === 'compare-inspection') throw new Error('comparison_endpoint_HTTP_503');
          return { behind_by: 0, base_commit: { sha: sha('d') } };
        }
        return request(method, path, ...args);
      };
      f.github.paginate = async (path, key, guard, options) => {
        if (options?.informational && (unavailable === 'human-display' ? path.endsWith('/reviews') : path.endsWith('/check-suites'))) {
          throw new Error('presentation_endpoint_unavailable');
        }
        return paginate(path, key, guard, options);
      };
      f.scheduler.shepherd = new Shepherd({ github: f.github, store: f.store });
      f.scheduler.log = (event) => logs.push(event);
      // This owner covers the review/status boundary, not native lane selection.
      f.scheduler.advanceMergeLane = async () => {};
      await f.scheduler.reconcile();
      if (completed) {
        assert.equal(f.store.approvalForReview(completed.id).outcome, 'approved');
        assert.equal(native.calls.filter(({ method, path }) => method === 'POST' && path.endsWith('/reviews')).length, 1);
      } else {
        assert.equal(f.store.active(1).status, 'queued');
        assert.equal(f.store.active(1).reason, 'reconcile');
        assert.ok(f.store.active(1).check_run_id, 'durable queued intake still publishes its queued check');
      }
      assert.ok(logs.some((entry) => entry.event === 'shepherd_failed' && entry.pr === 1
        && entry.step === (unavailable === 'compare-inspection' ? 'before' : 'after')),
        'informational failure stays isolated from enqueue and approval recovery');
      assert.equal(f.store.shepherdState(1)?.comment_id, undefined);
    });
  }
}

test('restart cannot approve or merge persisted evidence from another reviewer route', async (t) => {
  for (const changed of ['model', 'effort', 'missing-receipt']) {
    const f = await fixture(t), native = nativeApprovalFixture(f);
    const { row, report } = completedApprovalRow(f);
    if (changed === 'model') f.scheduler.mirror.reviewModel = 'anthropic/claude-opus-5-5';
    else if (changed === 'effort') f.scheduler.mirror.reviewThinking = 'high';
    else {
      delete report.review_route;
      f.store.update(row.id, { result_json: JSON.stringify(report) });
    }
    assert.throws(() => f.scheduler.approvalCheckpoint(row), /publication_cancelled/u);
    f.scheduler.reconcileCounts = { failed: 0, skipped: 0, deferred: 0 };
    await f.scheduler.reconcileReview(native.pr);
    assert.equal(native.reviews.length, 0);
    assert.ok(!native.calls.some((call) => ['POST', 'PUT'].includes(call.method)));
    const queued = f.store.active(1);
    assert.equal(queued.reason, 'reconcile');
    assert.equal(queued.head_sha, row.head_sha);
    assert.notEqual(queued.id, row.id);
  }
});
