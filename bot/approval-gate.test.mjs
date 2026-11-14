import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate, APPROVAL_GATE } from './approval-gate.mjs';
import { REVIEW_BOT } from './identity.mjs';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { Publisher } from './publish.mjs';
import { Scheduler } from './scheduler.mjs';
import { createWebhookServer } from './server.mjs';

const sha = (digit) => digit.repeat(40);
const repository = 'example/project';
const root = `/repos/${repository}`;
const bot = { ...REVIEW_BOT, type: 'Bot', html_url: `https://github.com/apps/${REVIEW_BOT.graphqlLogin}` };
const pr = (number, head = sha('a')) => ({ number, state: 'open', draft: false, body: '', labels: [],
  head: { sha: head }, base: { ref: 'main' } });
const approved = (head = sha('a')) => [{ id: 1, user: bot, state: 'APPROVED', commit_id: head,
  submitted_at: '2026-11-12T12:00:00Z' }];

function fixture({ pulls = [pr(1)], queue = [], refs = [] } = {}) {
  const checks = [];
  const writes = [];
  const reviews = new Map(pulls.map((pull) => [pull.number, approved(pull.head.sha)]));
  let clock = 100000;
  let sequence = 0;
  const github = {
    repo: repository, appId: 1007,
    graphql: async (_query, { branch }) => ({ repository: { mergeQueue: branch === 'main' && queue.length ? { entries: {
      nodes: queue, totalCount: queue.length, pageInfo: { hasNextPage: false, endCursor: null },
    } } : null } }),
    paginate: async (path) => {
      const target = path.split('/commits/')[1]?.split('/')[0];
      assert.ok(target);
      return checks.filter((check) => check.head_sha === target);
    },
    request: async (method, path, body) => {
      const url = new URL(path, 'https://api.github.com');
      if (method !== 'GET') {
        assert.ok(path.startsWith(`${root}/check-runs`), 'no statuses, workflow dispatch or repository writes');
        const id = method === 'PATCH' ? Number(path.split('/').at(-1)) : ++sequence;
        const previous = checks.find((check) => check.id === id);
        const result = { ...previous, ...structuredClone(body), id, app: { id: github.appId } };
        if (previous) checks.splice(checks.indexOf(previous), 1, result); else checks.push(result);
        writes.push(structuredClone(result));
        return result;
      }
      if (url.pathname.startsWith('/users/')) return bot;
      if (url.pathname === `${root}/pulls`) return url.searchParams.get('page') === '1' ? pulls : [];
      const pull = url.pathname.match(/\/pulls\/(\d+)(\/reviews)?$/);
      if (pull) return pull[2] ? reviews.get(Number(pull[1])) ?? [] : pulls.find((row) => row.number === Number(pull[1]));
      if (url.pathname.includes('/git/matching-refs/')) return refs;
      if (url.pathname.includes('/git/ref/')) {
        const ref = `refs/${url.pathname.split('/git/ref/')[1]}`;
        return refs.find((row) => row.ref === ref);
      }
      throw new Error('Unexpected fixture endpoint');
    },
  };
  const gate = new ApprovalGate({ github, now: () => clock });
  const delivery = (event, action, pull = pulls[0]) => gate.delivery(event,
    { action, repository: { full_name: repository }, pull_request: pull });
  return { gate, github, checks, writes, reviews, pulls, delivery, advance: () => { clock += 300001; } };
}

const result = (f, head = sha('a')) => f.checks.filter((check) => check.head_sha === head && check.name === APPROVAL_GATE).at(-1);

test('App-owned exact-head authority revokes a dismissed approval independently of PR workflows', async () => {
  const f = fixture();
  await f.delivery('pull_request_review', 'submitted');
  assert.equal(result(f).conclusion, 'success');
  assert.equal(result(f).app.id, f.github.appId);
  f.reviews.set(1, [{ ...approved()[0], state: 'DISMISSED' }]);
  await f.delivery('pull_request_review', 'dismissed');
  assert.equal(result(f).conclusion, 'failure');
  assert.ok(f.writes.every((write) => write.name === APPROVAL_GATE && write.head_sha === sha('a')));
});

test('delayed events cannot authorize a new head using an older approved review', async () => {
  const f = fixture();
  const old = structuredClone(f.pulls[0]);
  f.pulls[0].head.sha = sha('b');
  await f.delivery('pull_request', 'synchronize', old);
  assert.equal(result(f, sha('b')).conclusion, 'failure');
  assert.equal(result(f), undefined);
  f.reviews.set(1, approved(sha('b')));
  await f.delivery('pull_request_review', 'submitted', old);
  assert.equal(result(f, sha('b')).conclusion, 'success');
});

test('missed webhooks are repaired by periodic live approval and hold reconciliation', async () => {
  const f = fixture();
  await f.gate.reconcile();
  assert.equal(result(f).conclusion, 'success');
  f.pulls[0].labels = [{ name: 'hold' }];
  f.advance();
  await f.gate.reconcile();
  assert.equal(result(f).conclusion, 'failure');
  f.pulls[0].labels = [];
  f.reviews.set(1, approved().map((review) => ({ ...review, user: { ...bot, id: bot.id + 1 } })));
  f.advance();
  await f.gate.reconcile();
  assert.equal(result(f).conclusion, 'failure');
});

test('periodic queue checks require every member and recover after valid approval returns', async () => {
  const pulls = [pr(1), pr(2, sha('b')), pr(3, sha('f'))];
  const queue = [
    { position: 1, baseCommit: { oid: sha('c') }, headCommit: { oid: sha('d') }, pullRequest: { number: 1, headRefOid: sha('a') } },
    { position: 2, baseCommit: { oid: sha('d') }, headCommit: { oid: sha('e') }, pullRequest: { number: 2, headRefOid: sha('b') } },
  ];
  const refs = queue.map((entry, i) => ({ ref: `refs/heads/gh-readonly-queue/main/pr-${i + 1}-fixture`, object: { sha: entry.headCommit.oid } }));
  const f = fixture({ pulls, queue, refs });
  f.reviews.set(3, []);
  await f.gate.reconcile();
  assert.equal(result(f, sha('d')).conclusion, 'success');
  assert.equal(result(f, sha('e')).conclusion, 'success');
  assert.ok(f.writes.filter((write) => [sha('d'), sha('e')].includes(write.head_sha))
    .every((write) => write.status === 'in_progress' || write.conclusion === 'success'),
  'Healthy queue heads must never receive a temporary failure while being checked');
  f.reviews.set(2, [{ ...approved(sha('b'))[0], state: 'DISMISSED' }]);
  f.advance();
  await f.gate.reconcile();
  assert.equal(result(f, sha('d')).conclusion, 'success');
  assert.equal(result(f, sha('e')).conclusion, 'failure');
  f.reviews.set(2, approved(sha('b')));
  f.advance();
  await f.gate.reconcile();
  assert.equal(result(f, sha('e')).conclusion, 'success');
});

test('review API loss cannot preserve prior success', async () => {
  const f = fixture();
  await f.delivery('pull_request_review', 'submitted');
  const request = f.github.request;
  f.github.request = async (method, path, body) => {
    if (path.includes('/reviews')) throw new Error('Unavailable');
    return request(method, path, body);
  };
  await f.delivery('pull_request_review', 'dismissed');
  assert.equal(result(f).conclusion, 'failure');
});

test('signed webhook reaches durable scheduler and revokes live App check; unsigned input cannot', async (t) => {
  const f = fixture();
  await f.delivery('pull_request_review', 'submitted');
  f.reviews.set(1, [{ ...approved()[0], state: 'DISMISSED' }]);
  const directory = await mkdtemp(join(tmpdir(), 'approval-webhook-'));
  const store = new Store(join(directory, 'state.sqlite'));
  const publisher = new Publisher({ github: f.github, store });
  const scheduler = new Scheduler({ store, github: f.github, publisher, approvalGate: f.gate,
    mode: 'advisory', mergeLaneEnabled: false });
  const secret = 'synthetic-webhook-secret';
  const server = createWebhookServer({ store, scheduler, secret, appId: f.github.appId });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const body = JSON.stringify({ repository: { full_name: repository },
    action: 'dismissed', pull_request: f.pulls[0] });
  const url = `http://127.0.0.1:${server.address().port}/github`;
  const headers = { 'x-github-event': 'pull_request_review', 'x-github-delivery': 'dismiss-fixture' };
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 401);
  assert.equal(result(f).conclusion, 'success');
  headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 202);
  await scheduler.operations;
  assert.equal(result(f).conclusion, 'failure');
  assert.equal(store.get('SELECT state FROM deliveries WHERE id=?', 'dismiss-fixture').state, 'processed');
});

test('periodic group evaluation cannot restore authority revoked by an unapproved shared-head PR', async () => {
  const pulls = [pr(1), pr(2)];
  const queue = [{ position: 1, baseCommit: { oid: sha('c') }, headCommit: { oid: sha('d') },
    pullRequest: { number: 1, headRefOid: sha('a') } }];
  const refs = [{ ref: 'refs/heads/gh-readonly-queue/main/pr-1-fixture', object: { sha: sha('d') } }];
  const f = fixture({ pulls, queue, refs });
  await f.gate.reconcile();
  assert.equal(result(f, sha('d')).conclusion, 'success');
  f.reviews.set(2, []);
  f.advance();
  await f.gate.reconcile();
  assert.equal(result(f, sha('d')).conclusion, 'failure');
  f.reviews.set(2, approved());
  f.advance();
  await f.gate.reconcile();
  assert.equal(result(f, sha('d')).conclusion, 'success');
});

test('App approval cannot authorize unsupported base branches or their synthetic heads', async () => {
  const member = pr(1);
  member.base.ref = 'release';
  const f = fixture({ pulls: [member] });
  await f.delivery('pull_request_review', 'submitted');
  assert.equal(result(f).conclusion, 'failure');
  await f.gate.delivery('merge_group', { action: 'checks_requested', repository: { full_name: repository },
    merge_group: { head_sha: sha('d'), base_sha: sha('c'), base_ref: 'refs/heads/release',
      head_ref: 'refs/heads/gh-readonly-queue/release/pr-1-fixture' } });
  assert.equal(result(f, sha('d')).conclusion, 'failure');
});

test('main PR evaluation cannot clear a same-head unsupported base failure', async () => {
  const pulls = [pr(1), pr(2)];
  pulls[1].base.ref = 'release';
  const f = fixture({ pulls });
  await f.delivery('pull_request_review', 'submitted', pulls[1]);
  assert.equal(result(f).conclusion, 'failure');
  await f.delivery('pull_request_review', 'submitted', pulls[0]);
  assert.equal(result(f).conclusion, 'failure');
  assert.ok(!f.writes.some((write) => write.conclusion === 'success'));
});

test('restart plus unavailable queue discovery revokes durable prior success instead of forgetting it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'approval-receipts-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const queue = [{ position: 1, baseCommit: { oid: sha('c') }, headCommit: { oid: sha('d') },
    pullRequest: { number: 1, headRefOid: sha('a') } }];
  const refs = [{ ref: 'refs/heads/gh-readonly-queue/main/pr-1-fixture', object: { sha: sha('d') } }];
  const f = fixture({ queue, refs });
  let gate = new ApprovalGate({ github: f.github, store, now: f.gate.now });
  await gate.reconcile();
  assert.equal(result(f, sha('d')).conclusion, 'success');
  store.close();
  store = new Store(path);
  gate = new ApprovalGate({ github: f.github, store, now: f.gate.now });
  const graphql = f.github.graphql;
  f.github.graphql = async () => { throw new Error('Queue discovery unavailable'); };
  f.reviews.set(1, []);
  await assert.rejects(gate.reconcile());
  assert.equal(result(f, sha('d')).conclusion, 'failure');
  f.github.graphql = graphql;
  f.reviews.set(1, approved());
  f.advance();
  await gate.reconcile();
  assert.equal(result(f, sha('d')).conclusion, 'success');
});

test('opening a cross-base shared-head PR immediately revokes main queue authority', async () => {
  const queue = [{ position: 1, baseCommit: { oid: sha('c') }, headCommit: { oid: sha('d') },
    pullRequest: { number: 1, headRefOid: sha('a') } }];
  const refs = [{ ref: 'refs/heads/gh-readonly-queue/main/pr-1-fixture', object: { sha: sha('d') } }];
  const f = fixture({ queue, refs });
  await f.gate.reconcile();
  assert.equal(result(f, sha('d')).conclusion, 'success');
  const alias = pr(2);
  alias.base.ref = 'release';
  f.pulls.push(alias);
  f.reviews.set(2, approved());
  await f.delivery('pull_request', 'opened', alias);
  assert.equal(result(f, sha('d')).conclusion, 'failure');
});

test('restart after an accepted success with a lost response reads and revokes remote authority', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'approval-ambiguous-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const f = fixture();
  let gate = new ApprovalGate({ github: f.github, store, now: f.gate.now });
  await gate.publish(sha('a'), 'failure', 'Initially blocked');
  const request = f.github.request;
  f.github.request = async (method, path, body) => {
    const response = await request(method, path, body);
    if (method === 'PATCH' && body.conclusion === 'success') throw new Error('Response lost after acceptance');
    return response;
  };
  await assert.rejects(gate.publish(sha('a'), 'success', 'Live approval verified'));
  assert.equal(result(f).conclusion, 'success');
  store.close();
  store = new Store(path);
  gate = new ApprovalGate({ github: f.github, store, now: f.gate.now });
  f.reviews.set(1, []);
  await gate.delivery('pull_request_review', {
    action: 'dismissed', repository: { full_name: repository }, pull_request: f.pulls[0],
  });
  assert.equal(result(f).conclusion, 'failure');
});

const queuedFixture = () => {
  const queue = [
    { position: 1, baseCommit: { oid: sha('c') }, headCommit: { oid: sha('d') }, pullRequest: { number: 1, headRefOid: sha('a') } },
    { position: 2, baseCommit: { oid: sha('d') }, headCommit: { oid: sha('e') }, pullRequest: { number: 2, headRefOid: sha('b') } },
  ];
  const refs = queue.map((entry, i) => ({ ref: `refs/heads/gh-readonly-queue/main/pr-${i + 1}-fixture`, object: { sha: entry.headCommit.oid } }));
  const f = fixture({ pulls: [pr(1), pr(2, sha('b')), pr(3, sha('f'))], queue, refs });
  const payload = { action: 'checks_requested', repository: { full_name: repository }, merge_group: {
    head_sha: sha('e'), base_sha: sha('d'), base_ref: 'refs/heads/main', head_ref: refs[1].ref,
  } };
  return { ...f, queue, refs, payload };
};

for (const missing of ['ref', 'membership']) {
  test(`enqueue waits for delayed ${missing} without revoking other authority`, async () => {
    const f = queuedFixture();
    await f.gate.reconcile();
    // The second synthetic head has not been evaluated on this process yet.
    f.checks.splice(f.checks.findIndex((check) => check.head_sha === sha('e')), 1);
    f.gate.checks.delete(sha('e'));
    const before = f.writes.length;
    const absent = missing === 'ref' ? f.refs.pop() : f.queue.pop();
    const delays = [];
    f.gate.wait = async (delay) => {
      delays.push(delay);
      assert.equal(result(f, sha('e')).status, 'in_progress');
      assert.equal(result(f, sha('d')).conclusion, 'success');
      assert.equal(result(f, sha('a')).conclusion, 'success');
      if (delays.length === 2) (missing === 'ref' ? f.refs : f.queue).push(absent);
    };
    await f.gate.delivery('merge_group', f.payload);
    assert.deepEqual(delays, [250, 1000]);
    assert.equal(result(f, sha('e')).conclusion, 'success');
    assert.deepEqual(f.writes.slice(before).map((write) => [write.head_sha, write.status, write.conclusion]),
      [[sha('e'), 'in_progress', undefined], [sha('e'), 'completed', 'success']]);
  });
}

test('persistent group incompleteness and publication errors revoke only the evaluated head', async () => {
  const f = queuedFixture();
  await f.gate.reconcile();
  f.queue.pop();
  const delays = [];
  f.gate.wait = async (delay) => { delays.push(delay); };
  const before = f.writes.length;
  await f.gate.delivery('merge_group', f.payload);
  assert.deepEqual(delays, [250, 1000, 2000, 4000]);
  assert.equal(result(f, sha('e')).conclusion, 'failure');
  assert.deepEqual(f.writes.slice(before).map((write) => write.head_sha), [sha('e')]);
  const request = f.github.request;
  f.github.request = async (method, path, body) => {
    const response = await request(method, path, body);
    if (method === 'PATCH' && response.head_sha === sha('e')) throw new Error('Response lost');
    return response;
  };
  f.gate.checks.set(sha('e'), { ...result(f, sha('e')), conclusion: 'success' });
  await assert.rejects(f.gate.delivery('merge_group', f.payload));
  for (const head of ['a', 'b', 'f', 'd']) assert.equal(result(f, sha(head)).conclusion, 'success');
});

test('signed enqueue webhook persists pending then success while membership settles', async (t) => {
  const f = queuedFixture();
  const directory = await mkdtemp(join(tmpdir(), 'approval-enqueue-'));
  const store = new Store(join(directory, 'state.sqlite'));
  const gate = new ApprovalGate({ github: f.github, store, now: f.gate.now });
  await gate.reconcile();
  const member = f.queue.pop();
  // Replay a newly built synthetic head after prior PR/group authority exists.
  f.payload.merge_group.head_sha = sha('9');
  f.refs[1].object.sha = sha('9');
  member.headCommit.oid = sha('9');
  const publisher = new Publisher({ github: f.github, store });
  const scheduler = new Scheduler({ store, github: f.github, publisher, approvalGate: gate,
    mode: 'advisory', mergeLaneEnabled: false });
  gate.wait = async () => {
    assert.equal(result(f, sha('9')).status, 'in_progress');
    assert.equal(store.get('SELECT conclusion FROM approval_gate_heads WHERE head_sha=?', sha('9')).conclusion, null);
    f.queue.push(member);
  };
  const secret = 'synthetic-enqueue-secret';
  const server = createWebhookServer({ store, scheduler, secret, appId: f.github.appId });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const body = JSON.stringify(f.payload);
  const headers = { 'x-github-event': 'merge_group', 'x-github-delivery': 'enqueue-fixture',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` };
  const url = `http://127.0.0.1:${server.address().port}/github`;
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 202);
  await scheduler.operations;
  assert.equal(result(f, sha('9')).conclusion, 'success');
  assert.equal(store.get('SELECT state FROM deliveries WHERE id=?', 'enqueue-fixture').state, 'processed');
  assert.equal(store.get('SELECT conclusion FROM approval_gate_heads WHERE head_sha=?', sha('9')).conclusion, 'success');
  for (const head of ['a', 'b', 'f', 'd']) assert.equal(result(f, sha(head)).conclusion, 'success');
});

test('periodic group publication failure does not revoke other PR or synthetic heads', async () => {
  const f = queuedFixture();
  await f.gate.reconcile();
  f.gate.checks.set(sha('e'), { ...result(f, sha('e')), conclusion: 'failure' });
  const request = f.github.request;
  f.github.request = async (method, path, body) => {
    const response = await request(method, path, body);
    if (method === 'PATCH' && response.head_sha === sha('e')) throw new Error('Response lost');
    return response;
  };
  f.advance();
  await assert.rejects(f.gate.reconcile());
  assert.equal(result(f, sha('e')).conclusion, 'failure');
  for (const head of ['a', 'f', 'd']) assert.equal(result(f, sha(head)).conclusion, 'success');
});

test('PR enqueue discovery loss revokes only its durable dependents and recovers', async (t) => {
  const f = queuedFixture();
  const directory = await mkdtemp(join(tmpdir(), 'approval-dependencies-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let gate = new ApprovalGate({ github: f.github, store, now: f.gate.now });
  await gate.reconcile();
  store.close();
  store = new Store(path);
  gate = new ApprovalGate({ github: f.github, store, now: f.gate.now });
  const graphql = f.github.graphql;
  f.github.graphql = async () => { throw new Error('Enqueue discovery temporarily unavailable'); };
  const before = f.writes.length;
  await assert.rejects(gate.delivery('pull_request', {
    action: 'edited', repository: { full_name: repository }, pull_request: f.pulls[1],
  }));
  assert.deepEqual(f.writes.slice(before).map((write) => write.head_sha).sort(), [sha('b'), sha('e')].sort());
  assert.equal(result(f, sha('b')).conclusion, 'failure');
  assert.equal(result(f, sha('e')).conclusion, 'failure');
  for (const head of ['a', 'f', 'd']) assert.equal(result(f, sha(head)).conclusion, 'success');
  f.github.graphql = graphql;
  await gate.delivery('pull_request', {
    action: 'edited', repository: { full_name: repository }, pull_request: f.pulls[1],
  });
  assert.equal(result(f, sha('b')).conclusion, 'success');
  await gate.delivery('merge_group', f.payload);
  assert.equal(result(f, sha('e')).conclusion, 'success');
});

test('unknown legacy dependency receipts fail closed until fresh reconciliation', async (t) => {
  const f = queuedFixture();
  const directory = await mkdtemp(join(tmpdir(), 'approval-legacy-dependencies-'));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let gate = new ApprovalGate({ github: f.github, store, now: f.gate.now });
  await gate.reconcile();
  // Model pre-migration authority: the additive column has no membership proof.
  store.run('UPDATE approval_gate_heads SET dependencies_json=NULL');
  gate = new ApprovalGate({ github: f.github, store, now: f.gate.now });
  const graphql = f.github.graphql;
  f.github.graphql = async () => { throw new Error('Queue unavailable'); };
  await assert.rejects(gate.delivery('pull_request', {
    action: 'edited', repository: { full_name: repository }, pull_request: f.pulls[1],
  }));
  for (const head of ['a', 'b', 'f', 'd', 'e']) assert.equal(result(f, sha(head)).conclusion, 'failure');
  f.github.graphql = graphql;
  await gate.reconcile();
  for (const head of ['a', 'b', 'f', 'd', 'e']) assert.equal(result(f, sha(head)).conclusion, 'success');
});

test('an early group publication error cannot skip later stale-group validation', async () => {
  const f = queuedFixture();
  await f.gate.reconcile();
  f.gate.checks.set(sha('d'), { ...result(f, sha('d')), conclusion: 'failure' });
  f.pulls[1].head.sha = sha('8');
  f.reviews.set(2, approved(sha('8')));
  const request = f.github.request;
  f.github.request = async (method, path, body) => {
    const response = await request(method, path, body);
    if (method === 'PATCH' && response.head_sha === sha('d')) throw new Error('Response lost');
    return response;
  };
  f.advance();
  await assert.rejects(f.gate.reconcile());
  assert.equal(result(f, sha('e')).conclusion, 'failure');
  assert.equal(result(f, sha('f')).conclusion, 'success');
});
