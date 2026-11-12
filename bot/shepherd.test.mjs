import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { Shepherd, statusBody, STATUS_MARKER } from './shepherd.mjs';
import { GitHubApp } from './github-app.mjs';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const sha = (c) => c.repeat(40);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'shepherd-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const calls = [], comments = [];
  const pr = { number: 7, mergeable: true, head: { sha: sha('a') }, labels: [] };
  const state = { main: sha('b'), behind: 3, refusal: null, files: [], missingLabel: false, missingComment: false };
  const github = { repo: 'example-org/example-project', paginate: async () => comments,
    request: async (method, path, body, guard = async () => {}) => {
      await guard('before_send');
      calls.push({ method, path, body });
      if (path.endsWith('/update-branch')) { if (state.refusal) throw new Error(state.refusal); return {}; }
      if (path.includes('/compare/main...')) return { behind_by: state.behind, base_commit: { sha: state.main } };
      if (path.includes('/compare/')) return { files: state.files };
      if (path.endsWith('/pulls/7')) return pr;
      if (method === 'GET' && path.includes('/labels/') && state.missingLabel) throw new Error('HTTP 404');
      if (method === 'PATCH' && state.missingComment) { state.missingComment = false; throw new Error('HTTP 404'); }
      return { id: 100 };
    } };
  const shepherd = new Shepherd({ github, store, now: () => 123 });
  const inspection = async () => ({ ...await shepherd.inspect(7), ready: true });
  return { store, calls, comments, pr, state, shepherd, inspection };
}
test('behind clean updates are fenced by head and main; conflicts and unknown mergeability never update', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.shepherd.updateBranch(await f.inspection()), 'accepted');
  assert.deepEqual(f.calls.find((c) => c.method === 'PUT').body, { expected_head_sha: sha('a') });
  await f.shepherd.updateBranch(await f.inspection());
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1);
  f.state.main = sha('c'); await f.shepherd.updateBranch(await f.inspection());
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 2);
  for (const mergeable of [false, null]) {
    f.pr.mergeable = mergeable;
    const start = f.calls.length;
    assert.equal(await f.shepherd.updateBranch(await f.inspection()), null);
    assert.equal(f.calls.slice(start).some((c) => c.method === 'PUT' || c.path.includes('/compare/')), false);
  }
});
test('bot-owned branches are never updated; human and builder branches still are', async (t) => {
  const f = await fixture(t);
  const renovate = { id: 9, login: 'renovate[bot]', type: 'Bot' };
  for (const { user, ref } of [
    { user: renovate, ref: 'renovate/npm-x' },
    { user: { id: 42, login: 'author', type: 'User' }, ref: 'renovate/npm-x' },
    { user: { id: 9, login: 'other[bot]', type: 'Bot' }, ref: 'feature' },
  ]) {
    f.pr.user = user; f.pr.head.ref = ref;
    const inspection = await f.inspection();
    const start = f.calls.length;
    assert.equal(await f.shepherd.updateBranch(inspection), null);
    assert.equal(f.calls.slice(start).some((c) => c.method === 'PUT' || c.path.includes('/compare/')), false);
    assert.equal(f.store.updateAttempt(7, f.pr.head.sha, sha('b')), undefined);
  }
  f.pr.user = renovate; f.pr.head.ref = 'renovate/npm-x';
  f.store.saveUpdateAttempt(7, f.pr.head.sha, sha('b'), 'failed:HTTP 422', 123);
  assert.equal(await f.shepherd.updateBranch(await f.inspection()), null);
  assert.equal(f.calls.some((c) => c.method === 'PUT'), false);
  for (const { user, head } of [
    { user: { id: 42, login: 'author', type: 'User' }, head: sha('c') },
    { user: { id: 1003, login: 'builder[bot]', type: 'Bot' }, head: sha('d') },
  ]) {
    f.pr.user = user; f.pr.head.ref = 'feature'; f.pr.head.sha = head;
    const start = f.calls.length;
    assert.equal(await f.shepherd.updateBranch(await f.inspection()), 'accepted');
    assert.equal(f.calls.slice(start).filter((c) => c.method === 'PUT').length, 1);
  }
});
test('workflow refusal labels the head, survives main movement, and retries only a new head', async (t) => {
  const f = await fixture(t);
  f.state.refusal = 'GitHub request failed: PUT /pulls/7/update-branch HTTP 422';
  f.state.files = [{ filename: '.github/workflows/ci.yml' }];
  let inspection = await f.inspection();
  let update = await f.shepherd.updateBranch(inspection);
  assert.equal(update, 'failed:workflows');
  assert.equal(f.store.failedUpdate(7, f.pr.head.sha).outcome, update);
  await f.shepherd.syncLabel({ pr: f.pr, needsUpdate: update.startsWith('failed:') });
  assert.ok(f.calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues/7/labels')));
  assert.match(statusBody({ headSha: sha('a'), update }), /this update includes workflow changes/u);
  f.state.main = sha('d');
  assert.equal(await f.shepherd.updateBranch(await f.inspection()), update);
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1);
  f.pr.head.sha = sha('e'); f.state.files = [];
  update = await f.shepherd.updateBranch(await f.inspection());
  assert.equal(update, 'failed:HTTP 422');
  assert.equal(f.store.failedUpdate(7, f.pr.head.sha).outcome, update);
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 2);
  assert.match(statusBody({ headSha: sha('e'), update }), /failed:HTTP 422/u);
});
test('conflict label is created and removed; unknown state leaves it untouched', async (t) => {
  const f = await fixture(t); f.state.missingLabel = true;
  await f.shepherd.syncLabel({ pr: f.pr, needsUpdate: true });
  assert.deepEqual(f.calls.map((c) => c.method), ['GET', 'POST', 'POST']);
  assert.match(f.calls[1].body.description, /update the bot can't apply/u);
  f.pr.labels = [{ name: 'needs-update' }];
  await f.shepherd.syncLabel({ pr: f.pr, needsUpdate: false });
  assert.equal(f.calls.at(-1).method, 'DELETE');
  const count = f.calls.length; await f.shepherd.syncLabel({ pr: f.pr, needsUpdate: null });
  assert.equal(f.calls.length, count);
});
test('sticky comments post once, edit only on change, adopt identity, and replace deleted comments', async (t) => {
  const f = await fixture(t);
  await f.shepherd.publishStatus(7, STATUS_MARKER + '\none');
  await f.shepherd.publishStatus(7, STATUS_MARKER + '\none');
  assert.deepEqual(f.calls.map((c) => c.method), ['POST']);
  await f.shepherd.publishStatus(7, STATUS_MARKER + '\ntwo');
  assert.equal(f.calls.at(-1).path, '/repos/example-org/example-project/issues/comments/100');
  f.store.saveShepherd(7, { comment_id: null, status_sha256: null }, 124);
  f.comments.push({ id: 101, user: { id: 1002, login: 'example-review[bot]' }, body: STATUS_MARKER });
  await f.shepherd.publishStatus(7, STATUS_MARKER + '\nthree');
  assert.equal(f.calls.at(-1).method, 'PATCH');
  assert.ok(f.calls.at(-1).path.endsWith('/101'));
  f.comments.length = 0; f.state.missingComment = true;
  await f.shepherd.publishStatus(7, STATUS_MARKER + '\nfour');
  assert.equal(f.calls.at(-1).method, 'POST');
});

const bodyDigest = (body) => createHash('sha256').update(body).digest('hex');
const reviewUser = { id: 1002, login: 'example-review[bot]' };
async function publicationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'shepherd-publication-'));
  const path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const batchId = 'publication-batch', marker = `<!-- fleet-review-bot-batch-status:${batchId}:1:7 -->`;
  store.selectMergeBatch({
    id: batchId, generation: 1, kind: 'single', state: 'publishing',
    selected_at: 123, updated_at: 123, target_pr: 7,
    head_sha: sha('a'), base_sha: sha('b'),
    members: [{ pr: 7, head_sha: sha('a'), review_id: 7, publication_id: 7,
      github_review_id: 7, pull_request_id: 'PR_7', ci_run_id: 7, ci_attempt: 1,
      priority: null, created_at: '2026-10-01T00:00:00Z' }],
  });
  const state = { authorized: true, loseResponse: false, beforeSend: null };
  const calls = [], comments = [];
  const current = () => store.mergeBatch(batchId, 1);
  const journal = {
    marker,
    pending: () => current().mutation,
    guard: async () => { if (!state.authorized) throw new Error('batch_publication_changed'); },
    begin: (details) => store.beginBatchMutation(batchId, 1, {
      id: `comment-${current().operations.length + 1}`, kind: 'comment', comment_pr: 7,
      head_sha: sha('a'), main_sha: sha('b'), marker, ...details,
    }, 124),
    finish: (receipt) => store.finishBatchMutation(batchId, 1, current().mutation.id, receipt, 125),
  };
  const github = {
    repo: 'example-org/example-project',
    paginate: async () => structuredClone(comments),
    request: async (method, target, input, guard = async () => {}) => {
      if (method === 'GET') {
        calls.push({ method, path: target });
        const comment = comments.find((entry) => target.endsWith(`/${entry.id}`));
        if (!comment) throw new Error(`GitHub request failed: GET ${target} HTTP 404`);
        return structuredClone(comment);
      }
      await guard();
      await state.beforeSend?.();
      await guard('before_send');
      // A separate connection observes committed intent, not an in-memory callback echo.
      const observer = new Store(path);
      try {
        const pending = observer.mergeBatch(batchId, 1).mutation;
        assert.equal(pending.kind, 'comment');
        assert.equal(pending.comment_pr, 7);
        assert.equal(pending.method, method);
        assert.equal(pending.marker, marker);
        assert.equal(pending.body_sha256, bodyDigest(input.body));
        assert.equal(pending.comment_id, method === 'PATCH' ? Number(target.split('/').at(-1)) : null);
      } finally { observer.close(); }
      calls.push({ method, path: target, body: input.body });
      let comment;
      if (method === 'POST') {
        comment = { id: 100 + comments.length, user: { ...reviewUser }, body: input.body };
        comments.push(comment);
      } else {
        assert.equal(method, 'PATCH');
        comment = comments.find((entry) => target.endsWith(`/${entry.id}`));
        if (!comment) throw new Error(`GitHub request failed: PATCH ${target} HTTP 404`);
        comment.body = input.body;
      }
      if (state.loseResponse) throw new Error('github_timeout');
      await guard();
      return structuredClone(comment);
    },
  };
  let shepherd = new Shepherd({ github, store, now: () => 126 });
  return {
    get store() { return store; }, current, journal, state, calls, comments, github,
    body: STATUS_MARKER + '\nConfirmed batch receipt',
    publish(body = this.body) { return shepherd.publishStatus(7, body, journal); },
    reopen() {
      store.close(); store = new Store(path);
      shepherd = new Shepherd({ github, store, now: () => 127 });
    },
  };
}

test('durable comment create commits intent before POST and records one exact receipt', async (t) => {
  const f = await publicationFixture(t);
  const receipt = await f.publish();
  assert.deepEqual(receipt, { comment_id: 100, body_sha256: bodyDigest(`${f.body}\n${f.journal.marker}`) });
  assert.equal(f.current().mutation, null);
  assert.equal(f.current().operations.length, 1);
  assert.deepEqual(f.current().operations[0].receipt, { outcome: 'published', ...receipt });
  f.reopen();
  assert.deepEqual(await f.publish(), receipt);
  assert.deepEqual(f.calls.map((call) => call.method), ['POST']);
  assert.equal(f.store.shepherdState(7).status_sha256, receipt.body_sha256);
});

test('lost create response adopts only the exact native Review-owned body after reopen without another POST', async (t) => {
  const f = await publicationFixture(t);
  f.state.loseResponse = true;
  await assert.rejects(f.publish(), /github_timeout/u);
  const intent = f.current().mutation;
  assert.equal(f.current().operations.length, 0);
  assert.equal(f.store.shepherdState(7)?.comment_id ?? null, null);
  f.reopen(); f.state.loseResponse = false;
  assert.deepEqual(f.current().mutation, intent);
  const receipt = await f.publish();
  assert.equal(receipt.comment_id, 100);
  assert.equal(receipt.body_sha256, intent.body_sha256);
  assert.equal(f.current().mutation, null);
  assert.equal(f.current().operations.length, 1);
  assert.deepEqual(f.current().operations[0].intent, intent);
  assert.deepEqual(f.calls.map((call) => call.method), ['POST']);
});

for (const impostor of ['missing', 'wrong-id', 'wrong-login', 'changed-body', 'missing-marker']) {
  test(`uncertain create stays fenced when native evidence is ${impostor}`, async (t) => {
    const f = await publicationFixture(t);
    f.state.loseResponse = true;
    await assert.rejects(f.publish(), /github_timeout/u);
    const intent = f.current().mutation;
    if (impostor === 'missing') f.comments.length = 0;
    if (impostor === 'wrong-id') f.comments[0].user.id++;
    if (impostor === 'wrong-login') f.comments[0].user.login = 'builder[bot]';
    if (impostor === 'changed-body') f.comments[0].body += '\nEdited receipt';
    if (impostor === 'missing-marker') f.comments[0].body = f.body;
    f.state.loseResponse = false;
    for (let restart = 0; restart < 2; restart++) {
      f.reopen();
      assert.deepEqual(await f.publish(), { pending: true });
      assert.deepEqual(f.current().mutation, intent);
      assert.equal(f.current().operations.length, 0);
      assert.equal(f.store.shepherdState(7)?.comment_id ?? null, null);
    }
    assert.deepEqual(f.calls.map((call) => call.method), ['POST']);
  });
}

for (const boundary of ['native-response', 'local-receipt']) {
  test(`crash at ${boundary} boundary recovers one comment and one durable publication receipt`, async (t) => {
    const f = await publicationFixture(t);
    if (boundary === 'native-response') {
      f.store.finishBatchMutation = () => { throw new Error('simulated crash'); };
    } else {
      f.store.saveShepherd = () => { throw new Error('simulated crash'); };
    }
    await assert.rejects(f.publish(), /simulated crash/u);
    assert.equal(f.comments.length, 1);
    assert.equal(f.current().mutation.kind, 'comment');
    assert.equal(f.current().operations.length, 0);
    assert.equal(f.store.shepherdState(7)?.comment_id ?? null, null);
    f.reopen();
    const receipt = await f.publish();
    assert.equal(receipt.comment_id, 100);
    assert.equal(f.current().mutation, null);
    assert.equal(f.current().operations.length, 1);
    assert.equal(f.store.shepherdState(7).status_sha256, receipt.body_sha256);
    assert.deepEqual(f.calls.map((call) => call.method), ['POST']);
  });
}

test('multiple exact native matches leave the original comment intent uncertain', async (t) => {
  const f = await publicationFixture(t);
  f.state.loseResponse = true;
  await assert.rejects(f.publish(), /github_timeout/u);
  const intent = f.current().mutation;
  f.comments.push({ ...structuredClone(f.comments[0]), id: 101 });
  f.state.loseResponse = false; f.reopen();
  await assert.rejects(f.publish(), /batch_comment_adoption_ambiguous/u);
  assert.deepEqual(f.current().mutation, intent);
  assert.deepEqual(f.current().operations, []);
  assert.deepEqual(f.calls.map((call) => call.method), ['POST']);
});

test('lost PATCH response adopts the exact updated native comment without resending', async (t) => {
  const f = await publicationFixture(t);
  await f.publish();
  const body = STATUS_MARKER + '\nUpdated batch receipt';
  f.state.loseResponse = true;
  await assert.rejects(f.publish(body), /github_timeout/u);
  const intent = f.current().mutation;
  assert.equal(intent.comment_id, 100);
  f.state.loseResponse = false; f.reopen();
  const receipt = await f.publish(body);
  assert.equal(receipt.comment_id, 100);
  assert.equal(receipt.body_sha256, intent.body_sha256);
  assert.equal(f.current().mutation, null);
  assert.equal(f.current().operations.length, 2);
  assert.deepEqual(f.current().operations[1].intent, intent);
  assert.deepEqual(f.calls.map((call) => call.method), ['POST', 'PATCH', 'GET']);
});

test('conclusive PATCH 404 records rejection then creates one replacement with a new intent', async (t) => {
  const f = await publicationFixture(t);
  await f.publish();
  f.comments.length = 0;
  const body = STATUS_MARKER + '\nUpdated batch receipt';
  const receipt = await f.publish(body);
  assert.equal(f.current().mutation, null);
  assert.deepEqual(f.calls.map((call) => call.method), ['POST', 'PATCH', 'POST']);
  assert.deepEqual(f.current().operations.map((operation) => operation.receipt.outcome), ['published', 'rejected', 'published']);
  assert.equal(f.current().operations[1].intent.comment_id, 100);
  assert.match(f.current().operations[1].receipt.reason, /PATCH .* HTTP 404$/u);
  assert.equal(f.comments.length, 1);
  f.reopen();
  assert.deepEqual(await f.publish(body), receipt);
  assert.equal(f.calls.length, 3);
});

test('uncertain PATCH followed by GET 404 never clears uncertainty or creates a replacement', async (t) => {
  const f = await publicationFixture(t);
  await f.publish();
  f.state.loseResponse = true;
  const body = STATUS_MARKER + '\nUpdated batch receipt';
  await assert.rejects(f.publish(body), /github_timeout/u);
  const intent = f.current().mutation;
  f.comments.length = 0; f.state.loseResponse = false;
  for (let restart = 0; restart < 2; restart++) {
    f.reopen();
    assert.deepEqual(await f.publish(body), { pending: true });
    assert.deepEqual(f.current().mutation, intent);
    assert.equal(f.current().operations.length, 1);
  }
  assert.deepEqual(f.calls.filter((call) => call.method !== 'GET').map((call) => call.method), ['POST', 'PATCH']);
});

for (const late of [false, true]) {
  test(`publication guard blocks unauthorized ${late ? 'send-fence' : 'initial'} mutation`, async (t) => {
    const f = await publicationFixture(t);
    if (late) f.state.beforeSend = () => { f.state.authorized = false; };
    else f.state.authorized = false;
    await assert.rejects(f.publish(), /batch_publication_changed/u);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.comments, []);
    assert.equal(f.current().mutation, null);
    assert.deepEqual(f.current().operations, []);
  });
}

test('pending update reservation survives a restart without resending the same head/main pair', async (t) => {
  const f = await fixture(t);
  f.store.saveUpdateAttempt(7, sha('a'), sha('b'), 'pending', 123);
  assert.equal(await f.shepherd.updateBranch(await f.inspection()), null);
  assert.equal(f.calls.some((c) => c.method === 'PUT'), false);
  const body = statusBody({ headSha: sha('a'), update: 'pending' });
  assert.doesNotMatch(body, /Behind|pending/u);
  f.state.main = sha('c');
  assert.equal(await f.shepherd.updateBranch(await f.inspection()), 'accepted');
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1);
  f.pr.head.sha = sha('d');
  assert.equal(await f.shepherd.updateBranch(await f.inspection()), 'accepted');
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 2);
});
test('reservation is durable before update PUT and remains pending if final persistence crashes', async (t) => {
  const f = await fixture(t);
  const save = f.store.saveUpdateAttempt.bind(f.store);
  f.store.saveUpdateAttempt = (pr, head, main, outcome, now) => {
    if (outcome === 'accepted') throw new Error('simulated crash');
    return save(pr, head, main, outcome, now);
  };
  await assert.rejects(f.shepherd.updateBranch(await f.inspection()), /simulated crash/u);
  assert.equal(f.store.updateAttempt(7, sha('a'), sha('b')).outcome, 'pending');
  f.store.saveUpdateAttempt = save;
  assert.equal(await f.shepherd.updateBranch(await f.inspection()), null);
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('unavailable verdict is incomplete even when review execution passed', () => {
  const body = statusBody({ headSha: sha('a'), review: {
    result: { pass: true }, verdict: { decision: 'ambiguous', reason: 'verdict_unavailable' }, findings: [],
  } });
  assert.match(body, /codex-review could not complete.*verdict_unavailable/u);
  assert.doesNotMatch(body, /Waiting for the bot's approval|Needs a human approval/u);
});

for (const refused of [true, false]) {
  test(`returning to a previously ${refused ? 'refused' : 'accepted'} head never repeats its update`, async (t) => {
    const f = await fixture(t);
    if (refused) f.state.refusal = 'GitHub request failed: PUT /pulls/7/update-branch HTTP 422';
    const outcome = await f.shepherd.updateBranch(await f.inspection());
    assert.equal(outcome, refused ? 'failed:HTTP 422' : 'accepted');
    f.pr.head.sha = sha('c'); f.state.refusal = null;
    await f.shepherd.updateBranch(await f.inspection());
    assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 2);
    f.pr.head.sha = sha('a');
    assert.equal(await f.shepherd.updateBranch(await f.inspection()), refused ? outcome : null);
    assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 2);
  });
}

test('unready updates neither reserve nor write, even with a stored refusal', async (t) => {
  const f = await fixture(t);
  const inspection = { ...await f.inspection(), ready: false };
  f.store.saveUpdateAttempt = () => assert.fail('Unready update must not write');
  assert.equal(await f.shepherd.updateBranch(inspection), null);
  assert.equal(f.store.updateAttempt(7, sha('a'), sha('b')), undefined);
  assert.equal(f.calls.some((c) => c.method === 'PUT'), false);
  f.store.failedUpdate = () => ({ outcome: 'failed:HTTP 422' });
  assert.equal(await f.shepherd.updateBranch(inspection), null);
});



test('block status counts only actionable open findings, excluding fixed and deferred', () => {
  const body = statusBody({ headSha: sha('a'), review: { verdict: { decision: 'block' },
    findings: [{ id: 'F1', status: 'new' }, { id: 'F2', status: 'resolved' },
      { id: 'F3', status: 'deferred' }, { id: 'F4', status: 'still_open' }] } });
  assert.match(body, /2 codex-review finding\(s\) to fix or answer:\*\* F1, F4/u);
  assert.doesNotMatch(body, /F2|F3/u);
});

for (const operation of ['create-label', 'add-label', 'remove-label', 'status']) {
  test(`revoked preparation guard prevents ${operation} publication and local receipts`, async (t) => {
    const f = await fixture(t);
    let revoked = false;
    const guard = async () => { if (revoked) throw new Error('publication_cancelled'); };
    if (operation === 'create-label') f.state.missingLabel = true;
    if (operation === 'remove-label') f.pr.labels = [{ name: 'needs-update' }];
    // Inspection may finish successfully; authority is revoked before the ordered writer sends.
    await f.inspection();
    revoked = true;
    const before = f.calls.length;
    const write = operation === 'status'
      ? f.shepherd.publishStatus(7, `${STATUS_MARKER}\nPrepared status`, null, guard)
      : f.shepherd.syncLabel({ pr: f.pr, needsUpdate: operation !== 'remove-label', guard });
    await assert.rejects(write, /publication_cancelled/u);
    assert.equal(f.calls.slice(before).some(({ method }) => method !== 'GET'), false);
    assert.ok(!f.store.shepherdState(7)?.comment_id);
  });
}

for (const dispatched of [false, true]) test(`branch budget deferral stays typed and ${dispatched ? 'retains uncertain' : 'releases unsent'} reservation`, async (t) => {
  const f = await fixture(t), inspection = await f.inspection();
  const error = Object.assign(new Error('local budget'), { code: 'github_budget_deferred', retryAt: 2000 });
  let refuse = true, calls = 0, fences = 0;
  const app = new GitHubApp({ appId: 7, repo: 'example-org/example-project', privateKey,
    budget: { reserve() {
      assert.equal(f.store.updateAttempt(7, f.pr.head.sha, inspection.mainSha).outcome, 'pending');
      if (refuse && !dispatched) throw error;
    }, settle() {} },
    fetchImpl: async () => { calls++; if (refuse) throw error; return new Response('{}'); } });
  app.cachedToken = { token: 'fixture-token', expiresAt: Infinity };
  f.shepherd.github = app;
  await assert.rejects(f.shepherd.updateBranch({ ...inspection, beforeSend: async () => { fences++; } }), thrown => thrown === error);
  assert.equal(calls, dispatched ? 1 : 0);
  assert.equal(f.store.failedUpdate(7, f.pr.head.sha), undefined);
  if (dispatched) {
    assert.equal(f.store.updateAttempt(7, f.pr.head.sha, inspection.mainSha).outcome, 'pending');
    assert.equal(await f.shepherd.updateBranch(inspection), null);
    assert.equal(calls, 1, 'an uncertain transport outcome cannot be retried');
  } else {
    assert.equal(f.store.updateAttempt(7, f.pr.head.sha, inspection.mainSha), undefined);
    refuse = false;
    assert.equal(await f.shepherd.updateBranch({ ...inspection, beforeSend: async () => { fences++; } }), 'accepted');
    assert.equal(fences, 2);
    assert.equal(calls, 1);
  }
});

for (const method of ['POST', 'PATCH']) test(`unsent status ${method} settles durable intent and can publish after restart`, async (t) => {
  const f = await publicationFixture(t);
  if (method === 'PATCH') await f.publish();
  const original = f.github.request.bind(f.github);
  let refuse = true, calls = 0;
  const app = new GitHubApp({ appId: 7, repo: f.github.repo, privateKey,
    budget: { reserve() {
      assert.equal(f.current().mutation.kind, 'comment');
      if (refuse) throw Object.assign(new Error('local budget'), { code: 'github_budget_deferred', retryAt: 2000 });
    }, settle() {} },
    fetchImpl: async (url, options) => {
      calls++;
      return new Response(JSON.stringify(await original(options.method, new URL(url).pathname,
        JSON.parse(options.body), async () => {})));
    } });
  app.cachedToken = { token: 'fixture-token', expiresAt: Infinity };
  f.github.request = (verb, path, ...args) => verb === method
    ? app.request(verb, path, ...args) : original(verb, path, ...args);
  const body = f.body + '\nUpdated';
  await assert.rejects(f.publish(body), error => error.code === 'github_budget_deferred');
  assert.equal(f.current().mutation, null);
  assert.equal(f.current().operations.at(-1).receipt.outcome, 'not_dispatched');
  assert.equal(calls, 0);
  f.reopen(); refuse = false;
  await f.publish(body);
  assert.equal(calls, 1);
  assert.equal(f.current().mutation, null);
  assert.equal(f.current().operations.at(-1).receipt.outcome, 'published');
  assert.equal(f.comments.length, 1);
});
