import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.mjs';
import { Scheduler } from './scheduler.mjs';
import { createWebhookServer } from './server.mjs';

test('review-only HTTP health ignores frozen carrier failures without hiding live source failures', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const head = 'a'.repeat(40), now = 1000000;
  const failure = { first_failed_at: now - 100, last_failed_at: now, attempts: 2 };
  const carrier = store.enqueue({ pr: 99, head_sha: head, base_ref: 'main', due: 0, reason: 'opened' }, now);
  store.update(carrier.id, { status: 'publishing', result_json: JSON.stringify({ publication_failure: failure }) });
  store.run('INSERT INTO merge_batches(id,generation,record_json) VALUES(?,?,?)', 'frozen', 1,
    JSON.stringify({ id: 'frozen', generation: 1, kind: 'batch', sealed: true, target_pr: 99,
      state: 'publishing', reason: 'old publication failure', members: [] }));
  store.run('INSERT INTO active_merge_batch(slot,id,generation) VALUES(1,?,?)', 'frozen', 1);
  const before = { row: store.review(carrier.id), journal: store.all('SELECT * FROM merge_batches') };
  let journalReads = 0;
  const activeMergeBatch = store.activeMergeBatch.bind(store);
  store.activeMergeBatch = () => { journalReads++; return activeMergeBatch(); };
  const scheduler = new Scheduler({ store, mode: 'approve', mergeLaneEnabled: false, now: () => now });
  const server = createWebhookServer({ store, scheduler, secret: 'fixture-only-secret', mode: 'approve',
    revision: head, now: () => now, fetchImpl: async () => ({ ok: true }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/health`;
  const healthy = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const body = await healthy.json();
  assert.equal(healthy.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.publicationFailures, []);
  assert.deepEqual(body.mergeFailures, []);
  assert.equal(body.merge_lane, null);
  assert.equal(journalReads, 0, 'live health does not reconstruct frozen merge authority');
  assert.deepEqual(store.review(carrier.id), before.row);
  assert.deepEqual(store.all('SELECT * FROM merge_batches'), before.journal);

  const source = store.enqueue({ pr: 1, head_sha: 'b'.repeat(40), base_ref: 'main', due: 0, reason: 'opened' }, now);
  store.update(source.id, { status: 'publishing', result_json: JSON.stringify({ publication_failure: failure }) });
  const blocked = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const blockedBody = await blocked.json();
  assert.equal(blocked.status, 503);
  assert.deepEqual(blockedBody.publicationFailures.map(row => row.pr), [1]);
  assert.equal(journalReads, 0);
  assert.deepEqual(store.review(carrier.id), before.row);
});
