import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { Scheduler } from './scheduler.mjs';
import { Approval } from './approval.mjs';
import { REVIEW_APP_ID, REVIEW_BOT, REPOSITORY } from './identity.mjs';
import { mergeLaneConfig, createMergeClients } from './server.mjs';

const sha = 'a'.repeat(40);
async function fixture(t, mergeLaneEnabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'review-only-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const requests = [], checks = [], reviews = [];
  const pr = { number: 1, node_id: 'PR_1', state: 'open', draft: false, mergeable: true,
    head: { sha, repo: { full_name: REPOSITORY } }, base: { ref: 'main', repo: { full_name: REPOSITORY } },
    labels: [{ name: 'hold' }], body: '- [ ] Gate: operator hold', user: { id: 1, login: 'author' } };
  const github = { repo: REPOSITORY, appId: REVIEW_APP_ID,
    async request(method, path, body, guard) {
      requests.push([method, path, body]);
      if (method === 'GET' && path.endsWith('/pulls/1')) return structuredClone(pr);
      if (method === 'POST' && path.endsWith('/pulls/1/reviews')) {
        await guard?.('before_send');
        const receipt = { id: 100, user: { ...REVIEW_BOT, type: 'Bot' }, state: 'APPROVED', commit_id: body.commit_id, body: body.body };
        reviews.push(receipt); return receipt;
      }
      throw new Error(`Unexpected operation: ${method} ${path}`);
    },
    async paginate(path, _key, guard) {
      requests.push(['GET', path]); await guard?.();
      if (path.endsWith('/reviews')) return structuredClone(reviews);
      if (path.includes('/pulls?state=open')) return [structuredClone(pr)];
      throw new Error(`Unexpected pagination: ${path}`);
    } };
  const publisher = {
    queued: async (row, guard) => { await guard?.(); checks.push('queued'); return store.update(row.id, { check_run_id: 10 }); },
    started: async (_row, guard) => { await guard(); checks.push('started'); },
    completed: async (_row, review, _diff, guard) => { await guard(); checks.push('completed'); assert.equal(review.result.pass, true); return 'success'; },
    updateEvidence: async () => { checks.push('evidence'); },
  };
  const approval = new Approval({ store, github, mergeLaneEnabled, mode: 'approve', admit: async () => true });
  const forbidden = new Proxy({}, { get() { throw new Error('Lane dependency accessed'); } });
  const scheduler = new Scheduler({ store, github, publisher, approval, mergeLaneEnabled, mode: 'approve',
    mirror: { reviewModel: 'openai-codex/gpt-6.1-sol', reviewThinking: 'medium',
      prepare: async () => ({ base_sha: 'b'.repeat(40) }) },
    fetchImpl: async (_url, { method }) => { assert.equal(method, 'POST'); checks.push('runner'); return { status: 202 }; },
    shepherd: forbidden, batchAuthor: forbidden, batchMirror: forbidden, readMergeDrain: async () => null,
    now: () => 1000000, workRoot: root, sessionsRoot: root });
  return { store, scheduler, approval, pr, requests, checks, reviews };
}

function completed(f, pr = 1) {
  const row = f.store.enqueue({ pr, head_sha: sha, base_ref: 'main', due: 0, reason: 'opened' }, 1000000);
  const review = { publication_id: row.id, review_route: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
    result: { pass: true, evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } },
    verdict: { decision: 'approve' }, findings: [] };
  f.store.update(row.id, { status: 'completed', result_json: JSON.stringify(review) });
  return { row: f.store.review(row.id), review };
}

test('default runtime reviews and approves without constructing a custom merge lane or Builder client', () => {
  assert.deepEqual(mergeLaneConfig({}), { mergeLaneEnabled: false });
  assert.deepEqual(mergeLaneConfig({ MERGE_LANE_ENABLED: 'true' }), { mergeLaneEnabled: true });
  for (const value of ['', 'TRUE', '0', 'False', true]) assert.throws(() => mergeLaneConfig({ MERGE_LANE_ENABLED: value }), /Invalid MERGE_LANE_ENABLED/u);
  assert.deepEqual(createMergeClients({ REVIEW_BOT_MODE: 'approve' }, '/state', mergeLaneConfig({}).mergeLaneEnabled), { batchAuthor: null, batchMirror: null });
  assert.throws(() => createMergeClients({ REVIEW_BOT_MODE: 'approve' }, '/state', true), /BUILDER/u);
  const scheduler = new Scheduler({});
  assert.equal(scheduler.mergeLaneEnabled, true);
  assert.ok(scheduler.batchLane); assert.ok(scheduler.nativeCi);
});

test('disabled seeded lane and armed legacy journal stay frozen across recovery, delivery, reconcile, tick and status', async (t) => {
  const f = await fixture(t);
  const legacy = completed(f, 99);
  f.store.reserveApproval({ ...legacy.row, publication_id: legacy.row.id }, 'PR_99', 1);
  f.store.updateApproval(legacy.row.id, { armed: 1 }, 1);
  // Raw persisted legacy state deliberately has no fresh authorization metadata.
  f.store.run('INSERT INTO merge_batches(id,generation,record_json) VALUES(?,?,?)', 'legacy', 1,
    JSON.stringify({ id: 'legacy', generation: 1, state: 'reconciling', members: [], mutation: { kind: 'merge' }, target_pr: 99 }));
  f.store.run('INSERT INTO active_merge_batch(slot,id,generation) VALUES(1,?,?)', 'legacy', 1);
  const before = { batch: f.store.all('SELECT * FROM merge_batches'), approval: f.store.approval(legacy.row.id) };
  assert.equal(f.scheduler.batchLane, null); assert.equal(f.scheduler.nativeCi, null);
  await f.scheduler.recover();
  f.store.receiveDelivery('ci', 'workflow_run', { repository: { full_name: REPOSITORY }, action: 'completed',
    workflow_run: { name: 'CI', head_sha: sha, conclusion: 'success', head_branch: 'feature' } }, 1, REVIEW_APP_ID);
  await f.scheduler.processDelivery('ci');
  await f.scheduler.reconcile();
  assert.ok(f.store.active(1), 'normal source discovery enqueues despite hold/Gate');
  // Avoid starting an external runner; exercise maintenance, not the execution pump.
  f.store.update(f.store.active(1).id, { due_at: 2000000 });
  await f.scheduler.tickNow();
  await f.scheduler.refreshStatus(1);
  await f.scheduler.advanceMergeLane([]);
  await f.scheduler.reconcileLane();
  await f.approval.disable(99);
  assert.equal(await f.approval.merge(legacy.row), null);
  assert.deepEqual(f.store.all('SELECT * FROM merge_batches'), before.batch);
  assert.deepEqual(f.store.approval(legacy.row.id), before.approval);
  assert.equal(f.scheduler.mergeDrain.observed_at, 1000000);
  assert.ok(f.requests.every(([method, path]) => method === 'GET' && (path.includes('/pulls?') || path.endsWith('/pulls/1'))));
});

test('normal held source review finishes checks and exact-head APPROVE without immediate lane work', async (t) => {
  const f = await fixture(t);
  await f.scheduler.enqueue({ pr: 1, head_sha: sha, base_ref: 'main', due: 0, reason: 'opened' });
  const row = f.store.active(1);
  await f.scheduler.start(row);
  assert.equal(f.store.review(row.id).status, 'running');
  const review = { publication_id: row.id, review_route: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
    result: { pass: true, evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } },
    verdict: { decision: 'approve' }, findings: [] };
  await f.scheduler.publishNow(f.store.review(row.id), review);
  assert.equal(f.store.review(row.id).status, 'completed');
  assert.equal(f.store.approvalForReview(row.id).outcome, 'approved');
  assert.deepEqual(f.checks, ['queued', 'started', 'runner', 'completed', 'evidence']);
  assert.equal(f.reviews.length, 1); assert.equal(f.reviews[0].commit_id, sha);
  assert.ok(f.requests.filter(([method]) => method !== 'GET').every(([method, path]) => method === 'POST' && path.endsWith('/reviews')));
});

for (const blocker of ['head', 'cancel', 'human', 'admission', 'source']) test(`review-only retains ${blocker} approval fence`, async (t) => {
  const f = await fixture(t);
  const { row, review } = completed(f);
  if (blocker === 'head') f.pr.head.sha = 'b'.repeat(40);
  if (blocker === 'cancel') f.scheduler.pendingCancels.set(row.id, 'closed');
  if (blocker === 'human') f.reviews.push({ id: 12, user: { id: 2, login: 'human', type: 'User' },
    state: 'CHANGES_REQUESTED', submitted_at: new Date().toISOString() });
  if (blocker === 'admission') f.approval.admit = async () => false;
  if (blocker === 'source') f.pr.head.repo.full_name = 'other/fork';
  if (blocker === 'cancel') await assert.rejects(f.scheduler.approveCompleted(row, review), /publication_cancelled/u);
  else await f.scheduler.approveCompleted(row, review);
  assert.equal(f.requests.filter(([method]) => method === 'POST').length, 0);
});

test('disabled approval recovery preserves an armed receipt instead of adopting or disarming it', async (t) => {
  const f = await fixture(t);
  const { row, review } = completed(f);
  f.store.reserveApproval({ ...row, publication_id: row.id }, 'PR_1', 1);
  f.store.updateApproval(row.id, { armed: 1 }, 1);
  const before = f.store.approval(row.id);
  await f.scheduler.approveCompleted(row, review);
  assert.deepEqual(f.store.approval(row.id), before);
  assert.equal(f.requests.length, 0);
});

test('enabled operator drain refuses idle ACK while legacy authority is armed', async (t) => {
  const f = await fixture(t);
  const { row } = completed(f);
  f.store.reserveApproval({ ...row, publication_id: row.id }, 'PR_1', 1);
  f.store.updateApproval(row.id, { armed: 1 }, 1);
  const scheduler = new Scheduler({ store: f.store, mode: 'off', now: () => 1000000,
    readMergeDrain: async () => ({ request_id: '01234567-89ab-4cde-8fab-0123456789ab' }) });
  await scheduler.tickNow();
  assert.equal(scheduler.mergeDrain.acknowledged, false);
  f.store.updateApproval(row.id, { armed: 0 }, 2);
  await scheduler.tickNow();
  assert.equal(scheduler.mergeDrain.acknowledged, true);
});

test('retained sealed carrier reviews freeze at all lifecycle boundaries while source capacity and approval continue', async (t) => {
  const f = await fixture(t);
  f.scheduler.concurrency = 1;
  const carriers = [];
  const states = ['queued', 'running', 'publishing', 'completed', 'cancelled', 'failed'];
  for (const [index, status] of states.entries()) {
    const pr = 90 + index, head = pr.toString(16).padStart(40, '0');
    const row = f.store.enqueue({ pr, head_sha: head, base_ref: 'main', due: 0, reason: 'opened' }, 1);
    const review = { publication_id: row.id, result: { pass: true }, verdict: { decision: 'approve' }, findings: [],
      ...(status === 'cancelled' ? { cancellation_terminal_pending: { retry_at: 0 } } : {}) };
    f.store.update(row.id, { status, run_id: `carrier-${pr}`, result_json: status === 'running' ? null : JSON.stringify(review),
      ...(status === 'failed' ? { reason: 'restart_terminal_pending' } : {}) });
    f.store.run('INSERT INTO merge_batches(id,generation,record_json) VALUES(?,?,?)', `carrier-${pr}`, 1,
      JSON.stringify({ id: `carrier-${pr}`, generation: 1, kind: 'batch', sealed: true, target_pr: pr,
        members: [], state: 'reconciling', mutation: { kind: 'merge' } }));
    carriers.push({ row: f.store.review(row.id), review });
  }
  const journals = f.store.all('SELECT * FROM merge_batches');
  const paginate = f.scheduler.github.paginate;
  f.scheduler.github.paginate = async (...args) => {
    const rows = await paginate(...args);
    return args[0].includes('/pulls?state=open')
      ? [...rows, ...carriers.map(({ row }) => ({ ...structuredClone(f.pr), number: row.pr, head: { ...f.pr.head, sha: row.head_sha } }))]
      : rows;
  };
  for (const { row } of carriers) {
    for (const action of ['synchronize', 'closed']) {
      const id = `${row.pr}-${action}`;
      f.store.receiveDelivery(id, 'pull_request', { repository: { full_name: REPOSITORY }, action,
        pull_request: { number: row.pr, draft: false, base: { ref: 'main' },
          head: { sha: 'c'.repeat(40), repo: { full_name: REPOSITORY } } } }, 1, REVIEW_APP_ID);
      await f.scheduler.processDelivery(id);
    }
    const id = `${row.pr}-rerequest`;
    f.store.receiveDelivery(id, 'check_run', { repository: { full_name: REPOSITORY }, action: 'rerequested',
      check_run: { name: 'codex-review', app: { id: REVIEW_APP_ID }, head_sha: row.head_sha } }, 1, REVIEW_APP_ID);
    await f.scheduler.processDelivery(id);
  }
  const rerequests = f.store.all('SELECT * FROM rerequests');
  const source = f.store.enqueue({ pr: 1, head_sha: sha, base_ref: 'main', due: 0, reason: 'opened' }, 1);
  await f.scheduler.recover();
  assert.equal(f.store.review(source.id).status, 'running', 'frozen running carrier cannot exhaust the single source slot');
  await f.scheduler.publishNow(f.store.review(source.id), {
    publication_id: source.id, review_route: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
    result: { pass: true, evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } },
    verdict: { decision: 'approve' }, findings: [],
  });
  await f.scheduler.tick();
  for (const { row, review } of carriers) {
    await f.scheduler.start(row);
    await f.scheduler.poll(row);
    await f.scheduler.publishNow(row, review);
    await f.scheduler.approveCompleted(row, review);
    await f.approval.run({ ...row, publication_id: row.id }, review);
    await f.scheduler.cancel(row.pr, 'closed');
    await f.scheduler.releaseRun(row);
    await f.scheduler.reconcileReview({ ...f.pr, number: row.pr });
    assert.deepEqual(f.store.review(row.id), row);
  }
  assert.deepEqual(f.store.all('SELECT * FROM merge_batches'), journals);
  assert.deepEqual(f.store.all('SELECT * FROM rerequests'), rerequests);
  assert.equal(f.store.approvalForReview(source.id).outcome, 'approved');
  assert.equal(f.reviews.length, 1);
  assert.equal(f.checks.filter((entry) => entry === 'runner').length, 1, 'no second carrier model launched through priority discovery');
  assert.ok(f.requests.every(([, path]) => !carriers.some(({ row }) =>
    path === `/repos/${REPOSITORY}/pulls/${row.pr}` || path.startsWith(`/repos/${REPOSITORY}/pulls/${row.pr}/`))));
});

test('review-only drain rotates nonces, revokes ACK before reads, and restarts without inspecting frozen authority', async (t) => {
  const f = await fixture(t);
  const legacy = completed(f, 99);
  f.store.reserveApproval({ ...legacy.row, publication_id: legacy.row.id }, 'PR_99', 1);
  f.store.updateApproval(legacy.row.id, { armed: 1 }, 1);
  f.store.run('INSERT INTO merge_batches(id,generation,record_json) VALUES(?,?,?)', 'frozen', 1,
    JSON.stringify({ id: 'frozen', generation: 1, kind: 'batch', sealed: true, target_pr: 99,
      members: [], state: 'reconciling', mutation: { kind: 'merge' } }));
  f.store.run('INSERT INTO active_merge_batch(slot,id,generation) VALUES(1,?,?)', 'frozen', 1);
  const source = await f.scheduler.enqueue({ pr: 1, head_sha: sha, base_ref: 'main', due: 0, reason: 'opened' });
  await f.scheduler.start(source);
  assert.equal(f.store.review(source.id).status, 'running');
  const journal = f.store.all('SELECT * FROM merge_batches'), receipt = f.store.approval(legacy.row.id);
  const sourceBefore = f.store.review(source.id);
  f.scheduler.github.retryAt = 2000000; // Ordinary API backoff must not skip tick-finally observation.
  f.store.activeMergeBatch = () => { throw new Error('Frozen active journal inspected'); };
  f.store.pendingBatchPublications = () => { throw new Error('Frozen publication journal inspected'); };
  const get = f.store.get.bind(f.store);
  f.store.get = (sql, ...args) => {
    if (sql.includes('approvals WHERE armed=1')) throw new Error('Frozen armed journal inspected');
    return get(sql, ...args);
  };
  const first = '01234567-89ab-4cde-8fab-0123456789ab';
  const second = '11234567-89ab-4cde-8fab-0123456789ab';
  f.scheduler.readMergeDrain = async () => ({ request_id: first });
  await f.scheduler.tickNow();
  assert.equal(f.scheduler.mergeDrain.request_id, first);
  assert.equal(f.scheduler.mergeDrain.acknowledged, true, 'only local lane authority is absent; source remains running');
  let release;
  f.scheduler.readMergeDrain = () => new Promise((resolve) => { release = resolve; });
  const rotating = f.scheduler.tickNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.scheduler.mergeDrain.acknowledged, false, 'old ACK is revoked while marker read is pending');
  release({ request_id: second });
  await rotating;
  assert.equal(f.scheduler.mergeDrain.request_id, second);
  assert.equal(f.scheduler.mergeDrain.acknowledged, true);
  f.scheduler.readMergeDrain = async () => { throw new Error('unreadable marker'); };
  await f.scheduler.tickNow();
  assert.equal(f.scheduler.mergeDrain.acknowledged, false);
  assert.equal(f.scheduler.mergeDrain.request_id, null);
  assert.equal(f.scheduler.mergeDrain.error, 'unavailable');
  f.scheduler.readMergeDrain = async () => ({ request_id: null, error: 'invalid' });
  await f.scheduler.tickNow();
  assert.equal(f.scheduler.mergeDrain.acknowledged, false);
  const restarted = new Scheduler({ store: f.store, github: f.scheduler.github, mergeLaneEnabled: false,
    mode: 'approve', now: () => 1000000, readMergeDrain: async () => ({ request_id: second }) });
  assert.equal(restarted.mergeDrain.acknowledged, false, 'restart cannot reuse a previous process ACK');
  assert.equal(restarted.mergeDrain.observed_at, null);
  await restarted.tickNow();
  assert.equal(restarted.mergeDrain.acknowledged, true);
  assert.equal(restarted.mergeDrain.request_id, second);
  assert.equal(restarted.batchLane, null);
  assert.equal(restarted.nativeCi, null);
  assert.deepEqual(f.store.review(source.id), sourceBefore, 'ACK must not imply this source execution stopped');
  assert.deepEqual(f.store.all('SELECT * FROM merge_batches'), journal);
  assert.deepEqual(f.store.approval(legacy.row.id), receipt);
});
