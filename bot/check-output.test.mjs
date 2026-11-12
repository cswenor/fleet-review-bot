import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { Publisher } from './publish.mjs';
import { REVIEW_APP_ID } from './identity.mjs';

const head = 'a'.repeat(40);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'check-output-'));
  const path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const row = store.enqueue({ pr: 1, head_sha: head, base_ref: 'main', due: 0, reason: 'opened' }, 0);
  Object.assign(row, store.update(row.id, { check_run_id: 10, status: 'completed', conclusion: 'success' }));
  const review = { repo: 'example-org/example-project', pr: 1, publication_id: row.id, head_sha: head,
    base_sha: 'b'.repeat(40), policy: { source: 'main@' + head }, findings: [], suggestions: [], priorFindingIds: [],
    result: { pass: true, reasons: [], evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } },
    verdict: { decision: 'approve', model: 'jev-1.13.0', request_ids: ['fixture'] } };
  const sent = [];
  const github = { appId: REVIEW_APP_ID, repo: review.repo,
    request: async (method, path, body) => { sent.push({ method, path, body }); return { id: 10 }; } };
  const publisher = () => new Publisher({ github, store, now: () => 0 });
  return { row, review, github, sent, publisher, get store() { return store; },
    reopen() { store.close(); store = new Store(path); } };
}

test('accepted output survives restart; changed approval is published exactly once', async t => {
  const f = await fixture(t);
  await f.publisher().completed(f.row, f.review, '');
  f.reopen();
  await f.publisher().updateEvidence(f.row, structuredClone(f.review));
  assert.equal(f.sent.length, 1, 'identical accepted output needs no GitHub write after restart');
  f.review.approval = { outcome: 'approved', github_review_id: 123, branch_update: null };
  await f.publisher().updateEvidence(f.row, f.review);
  await f.publisher().updateEvidence(f.row, structuredClone(f.review));
  assert.equal(f.sent.length, 2);
});

test('output receipts cannot cross App, repository, check, publication or head identities', async t => {
  const f = await fixture(t);
  await f.publisher().updateEvidence(f.row, f.review);
  const saved = { ...f.store.get('SELECT * FROM check_output_receipts') };
  for (const [field, value] of [['app_id', REVIEW_APP_ID + 1], ['repo', 'example-org/project-alpha'],
    ['check_run_id', 11], ['publication_id', String(f.row.id + 1)], ['head_sha', 'c'.repeat(40)]]) {
    f.store.run('DELETE FROM check_output_receipts');
    const altered = { ...saved, [field]: value };
    f.store.run(`INSERT INTO check_output_receipts(app_id,repo,check_run_id,publication_id,head_sha,output_sha256)
      VALUES(?,?,?,?,?,?)`, altered.app_id, altered.repo, altered.check_run_id, altered.publication_id,
    altered.head_sha, altered.output_sha256);
    const before = f.sent.length;
    await f.publisher().updateEvidence(f.row, f.review);
    assert.equal(f.sent.length, before + 1, `${field} mismatch cannot suppress a real update`);
  }
});

test('uncertain output replacement invalidates both old and unacknowledged new receipts', async t => {
  const f = await fixture(t);
  await f.publisher().updateEvidence(f.row, f.review);
  const original = structuredClone(f.review);
  f.review.approval = { outcome: 'approved', github_review_id: 123 };
  const request = f.github.request;
  f.github.request = async (...args) => { await request(...args); throw new Error('connection lost after accepted PATCH'); };
  await assert.rejects(f.publisher().updateEvidence(f.row, f.review), /connection lost/u);
  f.reopen();
  assert.equal(f.store.get('SELECT * FROM check_output_receipts'), undefined);
  f.github.request = request;
  await f.publisher().updateEvidence(f.row, original);
  assert.equal(f.sent.length, 3, 'the old output must be restored, not trusted after an uncertain replacement');
  await f.publisher().updateEvidence(f.row, f.review);
  assert.equal(f.sent.length, 4, 'the unacknowledged new output must also get a real accepted write');
});

test('display receipts never skip mandatory completion fences or terminal output', async t => {
  const f = await fixture(t);
  await f.publisher().completed(f.row, f.review, '');
  await assert.rejects(f.publisher().completed(f.row, f.review, '', async () => {
    throw new Error('publication_cancelled');
  }), /publication_cancelled/u);
  assert.equal(f.sent.length, 1);
  await f.publisher().completed(f.row, f.review, '');
  assert.equal(f.sent.length, 2, 'completion is unconditional even when its display body is unchanged');
  await f.publisher().terminal(f.row, 'cancelled', 'superseded');
  assert.equal(f.sent[2].body.conclusion, 'cancelled');
  await f.publisher().updateEvidence(f.row, f.review);
  assert.equal(f.sent.length, 4, 'terminal output invalidates the older informational receipt');
});

test('an old database with no output table safely sends before recording its first receipt', async t => {
  const f = await fixture(t);
  f.store.db.exec('DROP TABLE check_output_receipts');
  f.reopen();
  f.review.check_output_receipt = { output_sha256: 'forged reviewer metadata' };
  await f.publisher().updateEvidence(f.row, f.review);
  await f.publisher().updateEvidence(f.row, f.review);
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.review(f.row.id).head_sha, head, 'additive migration preserves the real review');
});
