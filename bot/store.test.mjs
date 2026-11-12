import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { applyDeferrals } from './verdict.mjs';

test('native CI failure quarantine migrates additively and latches the first receipt across reopen', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-ci-failure-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const head = 'a'.repeat(40);
  const review = store.enqueue({ base_ref: 'main', pr: 1, head_sha: head, due: 0, reason: 'opened' }, 1);
  store.db.exec('DROP TABLE native_ci_failures');
  store.close(); store = new Store(path);
  assert.equal(store.review(review.id).head_sha, head, 'migration retains existing store data');
  assert.equal(store.nativeCiFailure(1, head), null);
  const input = { pr: 1, head_sha: head, run_id: 11, run_attempt: 1, job_id: 21, reason: 'native_job_failed' };
  const first = store.recordNativeCiFailure(input, 100);
  assert.deepEqual({ ...first }, { ...input, recorded_at: 100 });
  assert.deepEqual(store.recordNativeCiFailure(input, 101), first);
  assert.deepEqual(store.recordNativeCiFailure({
    ...input, run_id: 12, run_attempt: 2, job_id: 22, reason: 'native_execution_failed',
  }, 102), first, 'another run or attempt cannot replace the failure');
  store.close(); store = new Store(path);
  assert.deepEqual(store.nativeCiFailure(1, head), first);
  store.update(review.id, { status: 'completed', conclusion: 'success', result_json: '{"result":{"pass":true}}' });
  assert.deepEqual(store.nativeCiFailure(1, head), first, 'later successful evidence cannot clear quarantine');
});

test('native CI failure quarantine is scoped to PR and canonical full head without discarding old receipts', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const head = 'a'.repeat(40), nextHead = 'b'.repeat(40);
  const input = { pr: 1, head_sha: head.toUpperCase(), run_id: 11, run_attempt: 1, job_id: 21,
    reason: 'native_job_failed' };
  const first = store.recordNativeCiFailure(input, 0);
  assert.equal(first.head_sha, head);
  assert.deepEqual(store.nativeCiFailure(1, head.toUpperCase()), first);
  assert.deepEqual(store.recordNativeCiFailure({ ...input, head_sha: head, job_id: 22 }, 1), first);
  assert.equal(store.nativeCiFailure(1, nextHead), null, 'a new push is eligible');
  assert.equal(store.nativeCiFailure(2, head), null, 'another PR is independent');
  const next = store.recordNativeCiFailure({ ...input, head_sha: nextHead, job_id: 23 }, 2);
  const otherPr = store.recordNativeCiFailure({ ...input, pr: 2, job_id: 24 }, 3);
  assert.equal(next.head_sha, nextHead);
  assert.equal(otherPr.pr, 2);
  assert.deepEqual(store.nativeCiFailure(1, head), first, 'new heads never erase prior receipts');
});

test('native CI failure boundaries reject invalid identities and unsafe receipts before writing', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const head = 'a'.repeat(40);
  const input = { pr: 1, head_sha: head, run_id: 11, run_attempt: 1, job_id: 21, reason: 'native_job_failed' };
  const invalidIds = [null, undefined, 0, -1, 1.5, '1', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  const invalidHeads = [null, undefined, '', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 123, `${head}\n`];
  for (const pr of invalidIds) {
    assert.throws(() => store.nativeCiFailure(pr, head), /Invalid native CI failure identity/u);
  }
  for (const headSha of invalidHeads) {
    assert.throws(() => store.nativeCiFailure(1, headSha), /Invalid native CI failure identity/u);
  }
  for (const key of ['pr', 'run_id', 'run_attempt', 'job_id']) {
    for (const value of invalidIds) {
      assert.throws(() => store.recordNativeCiFailure({ ...input, [key]: value }, 1), /Invalid native CI failure receipt/u);
    }
  }
  for (const head_sha of invalidHeads) {
    assert.throws(() => store.recordNativeCiFailure({ ...input, head_sha }, 1), /Invalid native CI failure receipt/u);
  }
  for (const reason of [null, undefined, '', 'Native_failed', 'raw log with secret', 'token=secret',
    'failed\nsecret', 'failed\n', 'a'.repeat(65), 1]) {
    assert.throws(() => store.recordNativeCiFailure({ ...input, reason }, 1), /Invalid native CI failure receipt/u);
  }
  for (const now of [undefined, null, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.recordNativeCiFailure(input, now), /Invalid native CI failure receipt/u);
  }
  assert.equal(store.nativeCiFailure(1, head), null, 'invalid inputs leave no quarantine');
  const boundary = { pr: Number.MAX_SAFE_INTEGER, head_sha: head, run_id: Number.MAX_SAFE_INTEGER,
    run_attempt: Number.MAX_SAFE_INTEGER, job_id: Number.MAX_SAFE_INTEGER, reason: 'a'.repeat(64) };
  assert.deepEqual({ ...store.recordNativeCiFailure(boundary, Number.MAX_SAFE_INTEGER) },
    { ...boundary, recorded_at: Number.MAX_SAFE_INTEGER });
  const first = store.recordNativeCiFailure(input, 1);
  assert.throws(() => store.recordNativeCiFailure({ ...input, reason: 'secret=raw' }, 2),
    /Invalid native CI failure receipt/u, 'even duplicates must pass validation');
  assert.deepEqual(store.nativeCiFailure(1, head), first);
});

test('delivery dedupe, active uniqueness and finding IDs survive closure without partial invalid writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-store-')); const store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  assert.equal(store.receiveDelivery('fixture-id', 'pull_request', {}, 1).state, 'received');
  store.processedDelivery('fixture-id', 2);
  assert.equal(store.receiveDelivery('fixture-id', 'pull_request', {}, 3).state, 'processed');
  const row = store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'a'.repeat(40), due: 0, reason: 'opened' }, 1);
  assert.throws(() => store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'b'.repeat(40), due: 0, reason: 'opened' }, 1));
  const finding = { id: null, severity: 'P2', status: 'new', file: 'src/file.mjs', line: 1, title: 'bug', scenario: 'broken contract' };
  assert.equal(store.saveFindings(row, [finding])[0].id, 'F1');
  assert.throws(() => store.saveFindings(row, [finding, { ...finding, id: 'F99', status: 'resolved' }]));
  assert.equal(store.findings(1).length, 1);
  store.saveFindings(row, [{ ...finding, id: 'F1', status: 'resolved' }]);
  assert.equal(store.findings(1, true).length, 0);
  assert.equal(store.saveFindings(row, [finding])[0].id, 'F2');
});

test('legacy review CHECK migration preserves all columns, rows, indexes and triggers across reopen', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-review-publishing-')), path = join(root, 'state.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE reviews(id INTEGER PRIMARY KEY,pr INTEGER,head_sha TEXT,base_sha TEXT,
    status TEXT CHECK(status IN ('queued','running','completed','cancelled','failed')),reason TEXT,attempt INTEGER,
    allow_draft INTEGER,due_at INTEGER,check_run_id INTEGER,run_id TEXT,conclusion TEXT,result_json TEXT,verdict_json TEXT,
    created_at INTEGER,started_at INTEGER,finished_at INTEGER,rerequest_watermark INTEGER NOT NULL DEFAULT 0,
    publication_id INTEGER,base_ref TEXT,bot_revision TEXT,ambiguous_rereviews INTEGER NOT NULL DEFAULT 0,
    extension_receipt TEXT NOT NULL DEFAULT 'preserve-extension');
    CREATE UNIQUE INDEX active_pr ON reviews(pr) WHERE status IN ('queued','running');
    CREATE INDEX review_receipt_lookup ON reviews(extension_receipt,head_sha);
    CREATE TABLE review_audit(review_id INTEGER,reason TEXT);
    CREATE TRIGGER review_reason_audit AFTER UPDATE OF reason ON reviews BEGIN
      INSERT INTO review_audit VALUES(NEW.id,NEW.reason);
    END;`);
  for (const [index, status] of ['queued', 'running', 'completed', 'cancelled', 'failed'].entries()) {
    const id = index + 1;
    legacy.prepare(`INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, id, `${id}`.repeat(40), 'a'.repeat(40), status, `reason-${id}`, id, id % 2,
      100 + id, 200 + id, `run-${id}`, status === 'completed' ? 'success' : null,
      status === 'completed' ? '{"result":{"pass":true},"receipt":"canonical"}' : null,
      '{"verdict":"retained"}', 300 + id, 400 + id, 500 + id, id, 600 + id, 'main',
      `revision-${id}`, id, `extension-${id}`);
  }
  const rows = legacy.prepare('SELECT * FROM reviews ORDER BY id').all();
  const columns = legacy.prepare('PRAGMA table_info(reviews)').all();
  const indexSql = legacy.prepare("SELECT sql FROM sqlite_master WHERE name='review_receipt_lookup'").get().sql;
  const triggerSql = legacy.prepare("SELECT sql FROM sqlite_master WHERE name='review_reason_audit'").get().sql;
  legacy.close();
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  assert.deepEqual(store.all('PRAGMA table_info(reviews)').filter((column) => column.name !== 'execution_exit_json'), columns);
  for (const [index, row] of store.all('SELECT * FROM reviews ORDER BY id').entries()) {
    const { execution_exit_json, ...retained } = row;
    assert.equal(execution_exit_json, null);
    assert.deepEqual(retained, { ...rows[index] });
  }
  assert.equal(store.get("SELECT sql FROM sqlite_master WHERE name='review_receipt_lookup'").sql, indexSql);
  assert.equal(store.get("SELECT sql FROM sqlite_master WHERE name='review_reason_audit'").sql, triggerSql);
  assert.deepEqual(store.all('SELECT * FROM review_audit'), []);
  const exit = { state: 'exited', exitCode: 0, signal: null, durationMs: 25, stdoutTail: 'receipt', stderrTail: '' };
  const publishing = store.executionExited(store.review(2), exit);
  assert.equal(publishing.status, 'publishing');
  assert.equal(store.active(2).id, 2);
  assert.throws(() => store.enqueue({ base_ref: 'main', pr: 2, head_sha: 'f'.repeat(40), due: 0, reason: 'opened' }, 1),
    /UNIQUE/u, 'publication still owns the active PR');
  store.update(2, { reason: 'publication-resumed' });
  assert.deepEqual({ ...store.get('SELECT * FROM review_audit') }, { review_id: 2, reason: 'publication-resumed' });
  store.close(); store = new Store(path);
  assert.equal(store.active(2).status, 'publishing');
  assert.deepEqual(JSON.parse(store.review(2).execution_exit_json), exit);
  assert.equal(store.review(2).extension_receipt, 'extension-2');
  assert.equal(store.counts().running, 0);
  assert.equal(store.counts().publishing, 1);
  assert.throws(() => store.run("UPDATE reviews SET status='unknown' WHERE id=2"), /CHECK/u);
  assert.throws(() => store.enqueue({ base_ref: 'main', pr: 2, head_sha: 'f'.repeat(40), due: 0, reason: 'opened' }, 2), /UNIQUE/u);
});

test('execution exit is atomic, idempotent and rejects invalid receipts, identities and terminal transitions', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const queued = store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'a'.repeat(40), due: 0, reason: 'opened' }, 1);
  const exit = { state: 'exited', exitCode: 1, signal: null, durationMs: 12,
    stdoutTail: 'exact stdout\n', stderrTail: 'exact stderr\n' };
  assert.throws(() => store.executionExited(queued, exit), /Invalid execution exit transition/u);
  assert.throws(() => store.publicationIntent(queued, { result: { pass: true }, findings: [] }), /Publication cancelled/u);
  assert.equal(store.review(queued.id).execution_exit_json, null);
  const row = store.update(queued.id, { status: 'running', run_id: 'runner-1' });
  assert.equal(store.counts().running, 1);
  assert.equal(store.active(1).id, row.id);
  assert.throws(() => store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'b'.repeat(40), due: 0, reason: 'opened' }, 1), /UNIQUE/u);
  for (const receipt of [null, undefined, [], {}, { state: 'running' }, { state: 'lost' }]) {
    assert.throws(() => store.executionExited(row, receipt), /Invalid execution exit receipt/u);
  }
  for (const identity of [{ ...row, id: 999 }, { ...row, pr: 2 }, { ...row, head_sha: 'b'.repeat(40) },
    { ...row, run_id: 'other-runner' }]) {
    assert.throws(() => store.executionExited(identity, exit), /Invalid execution exit transition/u);
  }
  store.db.exec(`CREATE TRIGGER reject_exit BEFORE UPDATE OF execution_exit_json ON reviews BEGIN
    SELECT RAISE(ABORT,'exit write failed');
  END;`);
  assert.throws(() => store.executionExited(row, exit), /exit write failed/u);
  assert.equal(store.review(row.id).status, 'running');
  assert.equal(store.review(row.id).execution_exit_json, null);
  store.db.exec('DROP TRIGGER reject_exit');
  const observed = store.executionExited(row, exit);
  assert.equal(observed.status, 'publishing');
  assert.equal(observed.execution_exit_json, JSON.stringify(exit));
  assert.deepEqual(store.executionExited(row, exit), observed, 'a stale running snapshot can replay the same observation');
  assert.throws(() => store.executionExited(row, { ...exit, exitCode: 0 }), /Incompatible execution exit receipt/u);
  assert.deepEqual(store.review(row.id), observed);
  assert.equal(store.counts().running, 0);
  assert.equal(store.counts().publishing, 1);
  for (const status of ['completed', 'cancelled', 'failed']) {
    const next = store.enqueue({ base_ref: 'main', pr: 10 + status.length,
      head_sha: 'b'.repeat(40), due: 0, reason: 'opened' }, 1);
    const terminal = store.update(next.id, { status, run_id: `terminal-${status}` });
    assert.throws(() => store.executionExited(terminal, exit), /Invalid execution exit transition/u);
    assert.throws(() => store.publicationIntent(terminal, { result: { pass: true }, findings: [] }), /Publication cancelled/u);
    assert.equal(store.review(next.id).execution_exit_json, null);
  }
  store.update(row.id, { status: 'cancelled' });
  assert.throws(() => store.executionExited(row, exit), /Invalid execution exit transition/u,
    'cancellation wins even when the same receipt is already durable');
  assert.equal(store.counts().publishing, 0);
  assert.equal(store.active(row.pr), undefined);
  const noExit = store.enqueue({ base_ref: 'main', pr: 99, head_sha: 'c'.repeat(40), due: 0, reason: 'opened' }, 1);
  store.update(noExit.id, { status: 'publishing' });
  assert.throws(() => store.executionExited(noExit, exit), /Invalid execution exit transition/u,
    'a legacy intent without an exit cannot manufacture an observation on replay');
  assert.equal(store.review(noExit.id).execution_exit_json, null);
});

test('publishing survives crashes before and after intent without losing exit, findings or publication identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-exit-recovery-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const queued = store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'a'.repeat(40), due: 0, reason: 'opened' }, 1);
  const running = store.update(queued.id, { status: 'running', run_id: 'runner-1', started_at: 2 });
  const exit = { state: 'exited', exitCode: 0, signal: null, durationMs: 30,
    stdoutTail: 'model-result', stderrTail: '' };
  store.executionExited(running, exit);
  store.close(); store = new Store(path);
  const recovered = store.review(running.id);
  assert.equal(recovered.status, 'publishing', 'crash before evidence capture does not lose the exited execution');
  assert.deepEqual(JSON.parse(recovered.execution_exit_json), exit);
  assert.equal(recovered.result_json, null);
  assert.equal(recovered.conclusion, null);
  assert.equal(store.counts().running, 0);
  assert.equal(store.active(1).id, recovered.id);
  const review = { result: { pass: true, raw: exit.stdoutTail }, findings: [{ id: null, severity: 'P2', status: 'new',
    file: 'src/file.mjs', line: 1, title: 'bug', scenario: 'broken' }], publication_id: -1 };
  store.db.exec(`CREATE TRIGGER reject_intent BEFORE UPDATE OF result_json ON reviews BEGIN
    SELECT RAISE(ABORT,'intent write failed');
  END;`);
  assert.throws(() => store.publicationIntent(recovered, review), /intent write failed/u);
  assert.deepEqual(store.review(recovered.id), recovered, 'failed evidence capture preserves the exit journal atomically');
  assert.deepEqual(store.findings(1), []);
  assert.equal(review.findingsAssigned, undefined);
  store.db.exec('DROP TRIGGER reject_intent');
  store.publicationIntent(recovered, review);
  assert.equal(review.findings[0].id, 'F1');
  assert.equal(review.publication_id, recovered.publication_id);
  const durable = store.review(recovered.id);
  assert.equal(durable.status, 'publishing');
  assert.equal(durable.conclusion, null, 'durable evidence is not a published check or approval');
  assert.equal(durable.execution_exit_json, JSON.stringify(exit));
  store.close(); store = new Store(path);
  assert.deepEqual(store.review(recovered.id), durable);
  const replay = { result: { pass: true, raw: 'different retry result' }, findings: [{ ...review.findings[0], id: null }],
    publication_id: -2, stale_retry_field: true };
  store.publicationIntent(running, replay);
  assert.deepEqual(replay, JSON.parse(durable.result_json), 'intent replay reuses canonical result and assigned identities');
  assert.equal(store.review(recovered.id).result_json, durable.result_json);
  assert.deepEqual(store.findings(1).map((finding) => finding.id), ['F1'], 'recovery never assigns a second identity');
  assert.deepEqual(store.executionExited(running, exit), durable);
  assert.throws(() => store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'b'.repeat(40), due: 0, reason: 'opened' }, 3), /UNIQUE/u);
  store.update(recovered.id, { status: 'completed', conclusion: 'failure', finished_at: 4 });
  assert.equal(store.active(1), undefined);
  assert.equal(store.counts().publishing, 0);
  assert.ok(store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'b'.repeat(40), due: 0, reason: 'opened' }, 5));
});

test('finding changes and publication intent roll back together', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-intent-')); const store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  let row = store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'a'.repeat(40), due: 0, reason: 'opened' }, 1);
  row = store.update(row.id, { status: 'running' });
  const review = { result: { pass: true }, findings: [{ id: null, severity: 'P2', status: 'new',
    file: 'src/file.mjs', line: 1, title: 'bug', scenario: 'broken' }] };
  const update = store.update.bind(store);
  store.update = () => { throw new Error('intent write failed'); };
  assert.throws(() => store.publicationIntent(row, review), /intent write failed/u);
  assert.equal(store.findings(1).length, 0);
  assert.equal(store.review(row.id).result_json, null);
  assert.equal(store.review(row.id).status, 'running');
  assert.equal(review.findingsAssigned, undefined, 'a rolled-back intent must not mutate caller evidence');
  store.update = update;
  store.publicationIntent(row, { ...review, findingsAssigned: false });
  assert.equal(store.findings(1).length, 1);
  assert.notEqual(store.review(row.id).result_json, null);
  assert.equal(store.review(row.id).status, 'publishing', 'legacy direct running callers free their slot with durable intent');
});

test('ambiguity counter persists independently of execution attempts and migrates prior re-review rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-counter-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const execution = store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'a'.repeat(40), due: 0, reason: 'runner_lost', attempt: 2 }, 1);
  const ambiguity = store.enqueue({ base_ref: 'main', pr: 2, head_sha: 'b'.repeat(40), due: 0, reason: 'ambiguous_rereview',
    attempt: 1, ambiguousRereviews: 1 }, 1);
  assert.equal(execution.ambiguous_rereviews, 0); assert.equal(ambiguity.ambiguous_rereviews, 1);
  store.close(); store = new Store(path);
  assert.equal(store.review(execution.id).attempt, 2);
  assert.equal(store.review(execution.id).ambiguous_rereviews, 0);
  assert.equal(store.review(ambiguity.id).attempt, 1);
  assert.equal(store.review(ambiguity.id).ambiguous_rereviews, 1);
  store.db.exec('ALTER TABLE reviews DROP COLUMN ambiguous_rereviews');
  store.close(); store = new Store(path);
  assert.equal(store.review(execution.id).ambiguous_rereviews, 0);
  assert.equal(store.review(ambiguity.id).ambiguous_rereviews, 1);
});

test('durable rerequest IDs and review watermarks require completed same-PR pass/fail evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rerequest-rule-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const head = 'a'.repeat(40), payload = { repository: { full_name: 'example-org/example-project' },
    action: 'rerequested', check_run: { app: { id: 1001 }, name: 'codex-review', head_sha: head } };
  const old = store.enqueue({ base_ref: 'main', pr: 1, head_sha: head, due: 0, reason: 'opened' }, 1);
  store.update(old.id, { status: 'completed', conclusion: 'success', result_json: '{"result":{"pass":true}}' });
  store.receiveDelivery('R1', 'check_run', payload, 1);
  const first = store.get("SELECT * FROM rerequests WHERE delivery_id='R1'");
  assert.equal(old.rerequest_watermark, 0); assert.equal(first.satisfied_by_review_id, null);
  const fresh = store.enqueue({ base_ref: 'main', pr: 1, head_sha: head, due: 0, reason: 'rerequested' }, 1);
  assert.equal(fresh.rerequest_watermark, first.id);
  store.receiveDelivery('R2', 'check_run', payload, 1);
  const second = store.get("SELECT * FROM rerequests WHERE delivery_id='R2'");
  store.bindRerequest(first.id, 1); store.bindRerequest(second.id, 1);
  store.update(fresh.id, { status: 'completed', conclusion: 'success', result_json: '{"result":{"pass":true}}' });
  assert.equal(store.get('SELECT satisfied_by_review_id FROM rerequests WHERE id=?', first.id).satisfied_by_review_id, fresh.id);
  assert.equal(store.get('SELECT satisfied_by_review_id FROM rerequests WHERE id=?', second.id).satisfied_by_review_id, null);
  const wrongPr = store.enqueue({ base_ref: 'main', pr: 2, head_sha: head, due: 0, reason: 'rerequested' }, 1);
  store.update(wrongPr.id, { status: 'completed', conclusion: 'failure', result_json: '{"result":{"pass":true}}' });
  for (const status of ['queued', 'failed', 'cancelled']) {
    const row = store.enqueue({ base_ref: 'main', pr: 1, head_sha: head, due: 0, reason: 'rerequested' }, 1);
    assert.equal(store.get('SELECT satisfied_by_review_id FROM rerequests WHERE id=?', second.id).satisfied_by_review_id, null);
    store.update(row.id, { status: status === 'queued' ? 'failed' : status, conclusion: 'neutral' });
  }
  const fulfilled = store.enqueue({ base_ref: 'main', pr: 1, head_sha: head, due: 0, reason: 'rerequested' }, 1);
  store.update(fulfilled.id, { status: 'completed', conclusion: 'neutral', result_json: '{"result":{"pass":false}}' });
  assert.equal(store.get('SELECT satisfied_by_review_id FROM rerequests WHERE id=?', second.id).satisfied_by_review_id, null);
  store.update(fulfilled.id, { conclusion: 'failure', result_json: '{"result":{"pass":true}}' });
  assert.equal(store.get('SELECT satisfied_by_review_id FROM rerequests WHERE id=?', second.id).satisfied_by_review_id, fulfilled.id);
  store.receiveDelivery('R2', 'check_run', payload, 2);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM rerequests').n, 2);
  store.db.exec('ALTER TABLE deliveries ADD COLUMN review_floor_id INTEGER');
  store.close(); store = new Store(path);
  assert.equal(store.all('PRAGMA table_info(deliveries)').some((column) => column.name === 'review_floor_id'), false);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM rerequests').n, 2);
});

test('finding category and simplicity metadata survive persistence and closure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-simplicity-'));
  let store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const row = store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'a'.repeat(40), due: 0, reason: 'opened' }, 1);
  const finding = { id: null, severity: 'blocking', status: 'new', category: 'simplicity',
    file: 'src/file.mjs', line: 1, title: 'custom fence', scenario: 'duplicate concurrency protocol',
    stock_replacement: 'one DB transaction', introduced_by_pr: true };
  store.saveFindings(row, [finding]);
  store.close(); store = new Store(join(root, 'state.sqlite'));
  const prior = store.findings(1)[0];
  assert.equal(prior.category, finding.category);
  assert.equal(prior.stock_replacement, finding.stock_replacement);
  assert.equal(prior.introduced_by_pr, true);
  store.saveFindings(row, [{ ...prior, severity: 'P3', introduced_by_pr: false, status: 'resolved' }]);
  assert.equal(store.findings(1)[0].introduced_by_pr, false);
});

test('auto-merge owner migrates without reinterpreting old receipts and persists across restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'approval-migration-'));
  const path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  store.reserveApproval({ id: 1, publication_id: 1, pr: 1, head_sha: 'a'.repeat(40) }, 'PR_fixture', 1);
  store.updateApproval(1, { armed: 1, outcome: 'approved', github_review_id: 7 }, 1);
  store.db.exec('ALTER TABLE approvals DROP COLUMN auto_merge_owner');
  store.close(); store = new Store(path);
  assert.equal(store.approval(1).auto_merge_owner, null);
  assert.equal(store.approval(1).armed, 1);
  store.clearArmed(1, 2);
  store.updateApproval(1, { auto_merge_owner: 'human' }, 2);
  store.close(); store = new Store(path);
  assert.equal(store.approval(1).outcome, 'approved');
  assert.equal(store.approval(1).armed, 0);
  assert.equal(store.approval(1).auto_merge_owner, 'human');
  store.clearArmed(1, 3);
  assert.equal(store.approval(1).updated_at, 2, 'plain disarmed receipts remain unchanged');
});

test('arm error migrates as null and survives restart without altering approval identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'approval-arm-migration-'));
  const path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  store.reserveApproval({ id: 1, publication_id: 1, pr: 1, head_sha: 'a'.repeat(40) }, 'PR_fixture', 123);
  store.updateApproval(1, { outcome: 'approved', github_review_id: 7 }, 124);
  store.db.exec('ALTER TABLE approvals DROP COLUMN arm_error');
  store.close(); store = new Store(path);
  assert.equal(store.approval(1).arm_error, null);
  store.updateApproval(1, { arm_error: 'github_graphql_failed' }, 125);
  store.close(); store = new Store(path);
  assert.equal(store.approval(1).github_review_id, 7);
  assert.equal(store.approval(1).outcome, 'approved');
  assert.equal(store.approval(1).arm_error, 'github_graphql_failed');
});

test('legacy veto placeholders disappear while confirmed receipts remain plain disarmed approvals', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'approval-human-veto-migration-'));
  const path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  for (const id of [1, 2]) {
    store.reserveApproval({ id, publication_id: id, pr: id, head_sha: 'a'.repeat(40) }, `PR_${id}`, 123);
    store.updateApproval(id, { outcome: 'human_changes_requested', github_review_id: id === 2 ? 7 : null }, 124);
  }
  store.close(); store = new Store(path);
  assert.equal(store.approval(1), undefined);
  assert.equal(store.approval(2).outcome, 'approved');
  assert.equal(store.approval(2).github_review_id, 7);
  assert.equal(store.approval(2).armed, 0);
  assert.equal(store.approval(2).updated_at, 124);
  store.close(); store = new Store(path);
  assert.equal(store.approval(1), undefined);
  assert.equal(store.approval(2).armed, 0);
});

test('legacy admission-degraded receipts lose the obsolete reason without acquiring restoration authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'approval-degradation-migration-'));
  const path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  store.reserveApproval({ id: 1, publication_id: 1, pr: 1, head_sha: 'a'.repeat(40) }, 'PR_fixture', 123);
  store.updateApproval(1, { outcome: 'approved', github_review_id: 7 }, 124);
  store.db.exec(`ALTER TABLE approvals ADD COLUMN disarm_reason TEXT;
    UPDATE approvals SET disarm_reason='admission_degraded';`);
  store.close(); store = new Store(path);
  assert.equal(store.approval(1).outcome, 'approved');
  assert.equal(store.approval(1).armed, 0);
  assert.equal(store.approval(1).github_review_id, 7);
  assert.equal(store.approval(1).updated_at, 124);
  assert.equal(store.all('PRAGMA table_info(approvals)').some(column => column.name === 'disarm_reason'), false);
});

test('review target migration leaves old receipts unbound and only main can enqueue', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-target-migration-'));
  const path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const old = store.enqueue({ pr: 1, head_sha: 'a'.repeat(40), base_ref: 'main', due: 0, reason: 'opened' }, 1);
  store.db.exec('ALTER TABLE reviews DROP COLUMN base_ref');
  store.close(); store = new Store(path);
  assert.equal(store.review(old.id).base_ref, null);
  for (const base_ref of ['release', null, undefined]) {
    assert.throws(() => store.enqueue({ pr: 2, head_sha: 'b'.repeat(40), base_ref, due: 0, reason: 'opened' }, 1), /Unsupported review target/u);
  }
  const fresh = store.enqueue({ pr: 2, head_sha: 'b'.repeat(40), base_ref: 'main', due: 0, reason: 'opened' }, 1);
  assert.equal(fresh.base_ref, 'main');
});

test('deferrals survive restart and expired replies, but escalation and fixes clear tracking', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-deferral-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  const row = store.enqueue({ base_ref: 'main', pr: 1, head_sha: 'a'.repeat(40), due: 0, reason: 'opened' }, 1);
  const [initial] = store.saveFindings(row, [{ severity: 'P2', status: 'new',
    file: 'a.mjs', line: 1, title: 'edge', scenario: 'edge' }]);
  const open = { ...initial, status: 'still_open' };
  store.saveFindings(row, applyDeferrals([open], [initial], [{ finding_id: initial.id, body: 'TASK-1953 because separate work' }]));
  store.close(); store = new Store(path);
  const priors = store.findings(1, true);
  assert.equal(priors[0].deferred_to, 'TASK-1953');
  const [reapplied] = applyDeferrals([open], priors, []);
  assert.equal(reapplied.status, 'deferred');
  assert.equal(reapplied.deferred_to, 'TASK-1953');
  const [escalated] = applyDeferrals([{ ...open, severity: 'blocking' }], priors, []);
  assert.equal(escalated.status, 'still_open');
  store.saveFindings(row, [escalated]);
  assert.equal(store.findings(1)[0].deferred_to, null);
  store.saveFindings(row, [reapplied]);
  store.saveFindings(row, [{ ...reapplied, status: 'resolved' }]);
  assert.equal(store.findings(1)[0].deferred_to, null);
  assert.deepEqual(store.findings(1, true), []);
});

// Frozen pre-batch DDL: deliberately independent of the Store constructor.
const LEGACY_MERGE_DDL = `CREATE TABLE merge_lane(slot INTEGER PRIMARY KEY CHECK(slot=1),
  pr INTEGER NOT NULL,selected_at INTEGER NOT NULL,
  mutation_kind TEXT,mutation_head_sha TEXT,mutation_main_sha TEXT);`;
const batchHead = 'a'.repeat(40), batchBase = 'b'.repeat(40), batchTree = 'c'.repeat(40);
function journalMember(pr) {
  return { pr, head_sha: batchHead, review_id: pr, publication_id: pr, github_review_id: pr,
    pull_request_id: `PR_${pr}`, ci_run_id: pr, ci_attempt: 1, priority: null, created_at: '2026-10-01T00:00:00Z' };
}
function journalBatch(overrides = {}) {
  return { id: 'batch-test', generation: 1, kind: 'batch', state: 'selected',
    selected_at: 10, updated_at: 10, members: [journalMember(1), journalMember(2)],
    base_sha: batchBase, head_sha: batchHead, tree_sha: batchTree,
    carrier_branch: 'protected-carrier', manifest_digest: 'd'.repeat(64), ...overrides };
}
function journalIntent(id = 'intent-1', overrides = {}) {
  return { id, kind: 'native_merge', head_sha: batchHead, main_sha: batchBase, marker: null, ...overrides };
}
async function journalFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'review-batch-journal-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true }); });
  return {
    get store() { return store; },
    reopen() { store.close(); store = new Store(path); return store; },
  };
}

for (const kind of [null, 'merge', 'update']) {
  test(`frozen scalar selection migrates ${kind ?? 'idle'} uncertainty exactly and reopens idempotently`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'review-legacy-batch-')), path = join(root, 'state.sqlite');
    t.after(async () => { await rm(root, { recursive: true }); });
    const legacy = new DatabaseSync(path);
    legacy.exec(LEGACY_MERGE_DDL);
    legacy.prepare('INSERT INTO merge_lane VALUES(1,?,?,?,?,?)').run(99, 12345, kind,
      kind ? batchHead : null, kind ? batchBase : null);
    legacy.close();
    let store = new Store(path);
    try {
      const migrated = store.activeMergeBatch();
      assert.equal(migrated.id, 'legacy-merge-99');
      assert.equal(migrated.generation, 1);
      assert.equal(migrated.kind, 'single');
      assert.equal(migrated.target_pr, 99);
      assert.equal(migrated.selected_at, 12345);
      assert.equal(migrated.updated_at, 12345);
      assert.equal(migrated.needs_inspection, true);
      assert.equal(migrated.state, kind ? 'reconciling' : 'selected');
      assert.match(migrated.reason, /unknown/);
      assert.deepEqual(migrated.members, [{ pr: 99, head_sha: null, review_id: null, publication_id: null,
        github_review_id: null, pull_request_id: null, ci_run_id: null, ci_attempt: null, priority: null, created_at: null }]);
      assert.equal(migrated.head_sha, null);
      assert.equal(migrated.base_sha, null);
      assert.equal(migrated.merged_sha, null);
      assert.deepEqual(migrated.operations, []);
      assert.equal(store.get("SELECT name FROM sqlite_master WHERE name='merge_lane'"), undefined);
      if (kind) {
        assert.deepEqual(migrated.mutation, { id: 'legacy-merge-99-1', kind,
          head_sha: batchHead, main_sha: batchBase, marker: null });
        assert.throws(() => store.retireMergeBatch(migrated.id, 1, 'failed', 20), /pending/);
        assert.throws(() => store.updateMergeBatch(migrated.id, 1, { mutation: null }), /Immutable/);
        assert.throws(() => store.selectMergeBatch(journalBatch()), /active/);
      } else assert.equal(migrated.mutation, null);
      store.close(); store = new Store(path);
      assert.deepEqual(store.activeMergeBatch(), migrated);
      assert.deepEqual(store.mergeBatch(migrated.id, 1), migrated);
      if (kind) {
        const finished = store.finishBatchMutation(migrated.id, 1, migrated.mutation.id,
          { outcome: 'conclusively_rejected' }, 30);
        assert.deepEqual(finished.operations[0].intent, migrated.mutation);
        assert.equal(finished.needs_inspection, true);
      }
    } finally { store.close(); }
  });
}

test('malformed legacy mutation fails closed and rolls back the journal migration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-batch-rollback-')), path = join(root, 'state.sqlite');
  t.after(async () => { await rm(root, { recursive: true }); });
  const legacy = new DatabaseSync(path);
  legacy.exec(LEGACY_MERGE_DDL);
  legacy.prepare('INSERT INTO merge_lane VALUES(1,99,12345,NULL,?,NULL)').run(batchHead);
  legacy.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => new Store(path), /Malformed legacy/);
    const db = new DatabaseSync(path);
    try {
      assert.deepEqual({ ...db.prepare('SELECT * FROM merge_lane').get() },
        { slot: 1, pr: 99, selected_at: 12345, mutation_kind: null, mutation_head_sha: batchHead, mutation_main_sha: null });
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='merge_batches'").get(), undefined);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='active_merge_batch'").get(), undefined);
    } finally { db.close(); }
  }
});

test('journal selection is atomic, isolated, bounded, and claims only the empty slot', async (t) => {
  const fixture = await journalFixture(t);
  const { store } = fixture;
  for (const members of [[], [journalMember(1)], [journalMember(1), journalMember(1)],
    [1, 2, 3, 4, 5, 6].map(journalMember)]) {
    assert.throws(() => store.selectMergeBatch(journalBatch({ members })), /Invalid/);
    assert.equal(store.activeMergeBatch(), null);
  }
  const five = store.selectMergeBatch(journalBatch({ id: 'five', members: [1, 2, 3, 4, 5].map(journalMember) }));
  assert.equal(five.members.length, 5);
  store.retireMergeBatch(five.id, five.generation, 'retired', 12346);
  assert.throws(() => store.selectMergeBatch(journalBatch({ members: [journalMember(1), { ...journalMember(2), priority: Infinity }] })), /JSON/);
  assert.throws(() => store.transaction(() => {
    store.selectMergeBatch(journalBatch());
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(store.activeMergeBatch(), null);
  assert.equal(store.mergeBatch('batch-test', 1), null);
  const input = journalBatch();
  const chosen = store.selectMergeBatch(input);
  input.members[0].head_sha = batchBase;
  chosen.members[0].head_sha = batchBase;
  assert.equal(store.activeMergeBatch().members[0].head_sha, batchHead);
  assert.throws(() => store.selectMergeBatch(journalBatch({ id: 'competing' })), /active/);
  assert.equal(store.mergeBatch('competing', 1), null);
  assert.deepEqual(fixture.reopen().activeMergeBatch().members, [journalMember(1), journalMember(2)]);
});

test('sealed tuple and assign-once carrier identity cannot be rewritten or unsealed', async (t) => {
  const { store } = await journalFixture(t);
  store.selectMergeBatch(journalBatch());
  store.updateMergeBatch('batch-test', 1, { sealed: true });
  store.updateMergeBatch('batch-test', 1, { target_pr: 900, target_node_id: 'PR_900' });
  const before = store.activeMergeBatch();
  for (const patch of [
    { base_sha: batchHead }, { head_sha: batchBase }, { tree_sha: batchBase }, { carrier_branch: 'replacement' },
    { members: [journalMember(2), journalMember(1)] }, { manifest_digest: 'e'.repeat(64) },
    { kind: 'single', members: [journalMember(1)], target_pr: 1 }, { sealed: false },
    { target_pr: 901 }, { target_pr: null }, { target_node_id: 'PR_901' }, { target_node_id: null },
    { generation: 2 }, { id: 'other' }, { operations: [] },
  ]) {
    assert.throws(() => store.updateMergeBatch('batch-test', 1, patch));
    assert.deepEqual(store.activeMergeBatch(), before);
  }
  store.updateMergeBatch('batch-test', 1, { state: 'testing', ci: {
    run_id: 40, attempt: 1, tree_sha: batchTree, image_digest: 'sha256:proof', artifact_id: 41,
  } });
  assert.equal(store.activeMergeBatch().ci.run_id, 40);
});

test('mutation intent survives restart, exact completion audits it, and rollback never clears uncertainty', async (t) => {
  const fixture = await journalFixture(t);
  fixture.store.selectMergeBatch(journalBatch({ sealed: true }));
  for (const intent of [journalIntent('bad-head', { head_sha: batchBase }), journalIntent('bad-base', { main_sha: batchHead }),
    journalIntent('bad-tree', { tree_sha: batchHead }), journalIntent('bad-target', { target_pr: 999 })]) {
    assert.throws(() => fixture.store.beginBatchMutation('batch-test', 1, intent, 11), /mismatch/);
    assert.equal(fixture.store.activeMergeBatch().mutation, null);
  }
  const intent = journalIntent('native-merge-1', { tree_sha: batchTree, target_pr: null });
  fixture.store.beginBatchMutation('batch-test', 1, intent, 12);
  intent.kind = 'tampered';
  const store = fixture.reopen(), before = store.activeMergeBatch();
  assert.equal(before.mutation.kind, 'native_merge');
  assert.throws(() => store.beginBatchMutation('batch-test', 1, journalIntent('another'), 13), /pending/);
  for (const patch of [{ mutation: null }, { mutation: journalIntent('replace') }, { state: 'merged' }, { head_sha: batchBase }]) {
    assert.throws(() => store.updateMergeBatch('batch-test', 1, patch));
  }
  assert.throws(() => store.retireMergeBatch('batch-test', 1, 'merged', 14), /pending/);
  assert.throws(() => store.finishBatchMutation('batch-test', 1, 'wrong-id', { outcome: 'merged' }, 14), /mismatch/);
  assert.throws(() => store.transaction(() => {
    store.finishBatchMutation('batch-test', 1, before.mutation.id, { outcome: 'merged' }, 15);
    store.retireMergeBatch('batch-test', 1, 'merged', 15);
    throw new Error('rollback');
  }), /rollback/);
  assert.deepEqual(store.activeMergeBatch(), before);
  const receipt = { outcome: 'merged', merged_sha: batchHead };
  const finished = store.finishBatchMutation('batch-test', 1, before.mutation.id, receipt, 16);
  receipt.outcome = 'tampered';
  assert.equal(finished.mutation, null);
  assert.deepEqual(finished.operations, [{ intent: before.mutation,
    receipt: { outcome: 'merged', merged_sha: batchHead }, finished_at: 16 }]);
  assert.throws(() => store.finishBatchMutation('batch-test', 1, before.mutation.id, {}, 17), /mismatch/);
  assert.throws(() => store.beginBatchMutation('batch-test', 1, before.mutation, 17), /Invalid/);
  assert.deepEqual(fixture.reopen().activeMergeBatch(), finished);
});

test('old generation operations cannot release or mutate a newer active selection', async (t) => {
  const { store } = await journalFixture(t);
  store.selectMergeBatch(journalBatch());
  store.retireMergeBatch('batch-test', 1, 'invalidated', 20, 'new base required');
  assert.throws(() => store.selectMergeBatch(journalBatch({ generation: 1 })), /generation/);
  assert.throws(() => store.selectMergeBatch(journalBatch({ generation: 3 })), /generation/);
  store.selectMergeBatch(journalBatch({ generation: 2, selected_at: 21, updated_at: 21 }));
  const active = store.activeMergeBatch();
  store.retireMergeBatch('batch-test', 1, 'failed', 22);
  store.updateMergeBatch('batch-test', 1, { reason: 'historical detail' });
  assert.throws(() => store.beginBatchMutation('batch-test', 1, journalIntent(), 23), /not active/);
  assert.deepEqual(store.activeMergeBatch(), active);
  assert.equal(store.mergeBatch('batch-test', 1).reason, 'historical detail');
});

test('historical publications and forced-serial fallback remain durable independently of active slot', async (t) => {
  const fixture = await journalFixture(t), { store } = fixture;
  store.selectMergeBatch(journalBatch({ sealed: true }));
  store.retireMergeBatch('batch-test', 1, 'publishing', 20);
  store.selectMergeBatch(journalBatch({ id: 'fallback', state: 'fallback' }));
  store.retireMergeBatch('fallback', 1, 'fallback', 21);
  store.selectMergeBatch(journalBatch({ id: 'unrelated' }));
  assert.deepEqual(store.pendingBatchPublications().map((batch) => batch.id), ['batch-test']);
  assert.deepEqual(store.pendingBatchFallbacks().map((batch) => batch.id), ['fallback']);
  store.beginBatchMutation('batch-test', 1, journalIntent('publish-1', { kind: 'member_publication' }), 22);
  assert.throws(() => store.retireMergeBatch('batch-test', 1, 'merged', 23), /pending/);
  store.finishBatchMutation('batch-test', 1, 'publish-1', { comment_id: 55, outcome: 'posted' }, 24);
  store.updateMergeBatch('batch-test', 1, { member_results: { 1: { comment_id: 55 } } });
  store.updateMergeBatch('fallback', 1, { fallback_done: [1] });
  const reopened = fixture.reopen();
  assert.equal(reopened.pendingBatchPublications().length, 1);
  assert.equal(reopened.pendingBatchFallbacks().length, 1);
  reopened.updateMergeBatch('batch-test', 1, { member_results: { 1: { comment_id: 55 }, 2: { comment_id: 56 } } });
  reopened.updateMergeBatch('fallback', 1, { fallback_done: [1, 2] });
  assert.equal(reopened.pendingBatchPublications().length, 1, 'the final journal transition is still recoverable after the last per-PR receipt');
  reopened.updateMergeBatch('batch-test', 1, { state: 'merged' });
  assert.deepEqual(reopened.pendingBatchPublications(), []);
  assert.deepEqual(reopened.pendingBatchFallbacks(), []);
  assert.equal(reopened.activeMergeBatch().id, 'unrelated');
  assert.equal(reopened.mergeBatch('batch-test', 1).operations[0].receipt.comment_id, 55);
});

test('health counts expose only the explicitly safe batch summary', async (t) => {
  const { store } = await journalFixture(t);
  assert.equal(store.counts().merge_lane, null);
  store.selectMergeBatch(journalBatch({ reason: 'private reason' }));
  store.beginBatchMutation('batch-test', 1, journalIntent('safe-id', { private_detail: 'not-for-health' }), 11);
  assert.deepEqual(store.counts(), { queued: 0, running: 0, publishing: 0, merge_lane: {
    id: 'batch-test', generation: 1, kind: 'batch', state: 'selected', target_pr: null, selected_at: 10,
    members: [{ pr: 1, head_sha: batchHead }, { pr: 2, head_sha: batchHead }],
    mutation: { id: 'safe-id', kind: 'native_merge' },
  } });
});

test('pending legacy requests retain unknown expected SHAs instead of inventing authorization', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-unknown-batch-')), path = join(root, 'state.sqlite');
  t.after(async () => { await rm(root, { recursive: true }); });
  const legacy = new DatabaseSync(path);
  legacy.exec(LEGACY_MERGE_DDL);
  legacy.prepare('INSERT INTO merge_lane VALUES(1,99,12345,?,NULL,NULL)').run('update');
  legacy.close();
  const store = new Store(path);
  try {
    assert.deepEqual(store.activeMergeBatch().mutation, {
      id: 'legacy-merge-99-1', kind: 'update', head_sha: null, main_sha: null, marker: null,
    });
    assert.equal(store.activeMergeBatch().needs_inspection, true);
    assert.throws(() => store.updateMergeBatch('legacy-merge-99', 1, { head_sha: batchHead }), /pending/);
    assert.throws(() => store.retireMergeBatch('legacy-merge-99', 1, 'invalidated', 30), /pending/);
  } finally { store.close(); }
});

test('singleton journal targets the real member PR and rejected receipt writes preserve intent', async (t) => {
  const fixture = await journalFixture(t), { store } = fixture;
  assert.throws(() => store.selectMergeBatch(journalBatch({
    kind: 'single', members: [journalMember(1)], target_pr: 2,
  })), /Invalid/);
  store.selectMergeBatch(journalBatch({ kind: 'single', members: [journalMember(1)], target_pr: 1 }));
  const pending = store.beginBatchMutation('batch-test', 1, journalIntent(), 12);
  for (const receipt of [null, [], { invalid: undefined }, { invalid: Infinity }]) {
    assert.throws(() => store.finishBatchMutation('batch-test', 1, 'intent-1', receipt, 13));
    assert.deepEqual(store.activeMergeBatch(), pending);
  }
  assert.throws(() => store.updateMergeBatch('batch-test', 1, { member_results: { 1: { outcome: 'merged' } } }), /pending/);
  assert.deepEqual(fixture.reopen().activeMergeBatch(), pending);
});
