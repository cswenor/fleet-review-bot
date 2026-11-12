import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { CandidateHints, prepareInOrder } from './read-preparation.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('four preparation workers finish out of order but consumers commit in source order', async () => {
  const gates = Array.from({ length: 7 }, deferred);
  const started = [], committed = [];
  let active = 0, peak = 0;
  const work = (async () => {
    for await (const { item, error } of prepareInOrder(gates, async (gate, index) => {
      started.push(index); peak = Math.max(peak, ++active);
      await gate.promise;
      active--;
    })) {
      assert.equal(error, undefined);
      committed.push(gates.indexOf(item));
    }
  })();
  await setImmediate();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[3].resolve(); gates[2].resolve(); gates[1].resolve();
  await setImmediate();
  assert.deepEqual(committed, [], 'completion cannot move a later PR ahead of the first PR');
  gates[0].resolve();
  await setImmediate();
  assert.equal(peak, 4);
  gates[6].resolve(); gates[5].resolve(); gates[4].resolve();
  await work;
  assert.deepEqual(committed, [0, 1, 2, 3, 4, 5, 6]);
});

test('shared backoff stops unsent preparation while isolating the failing PR', async () => {
  const gates = Array.from({ length: 8 }, deferred);
  let allowed = true;
  const started = [], errors = [];
  const work = (async () => {
    for await (const { error } of prepareInOrder(gates, async (gate, index) => {
      started.push(index);
      await gate.promise;
      if (index === 1) { allowed = false; throw new Error('shared_backoff'); }
    }, () => allowed)) if (error) errors.push(error.message);
  })();
  await setImmediate();
  gates[1].resolve();
  await setImmediate();
  gates[0].resolve(); gates[2].resolve(); gates[3].resolve();
  await work;
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.deepEqual(errors, ['shared_backoff']);
});

test('candidate hints retain local identity checks and the five-minute cache bound', () => {
  let now = 10;
  const hints = new CandidateHints(() => now);
  const token = hints.capture(1, 'head-a');
  const value = { state: 'prepared' };
  hints.put(1, 'head-a', 'identity-a', value, token);
  value.state = 'mutated';
  assert.equal(hints.get(1, 'identity-a').value.state, 'prepared');
  assert.equal(hints.get(1, 'identity-a').token, token, 'tokens stay outside the cloned value');
  assert.equal(hints.get(1, 'identity-b'), null, 'changed local receipt or labels must rediscover');
  hints.put(1, 'head-a', 'identity-a', { state: 'wait', localIdentity: 'approval-a' }, token);
  assert.equal(hints.matchesLocal(1, 'head-a', 'approval-a'), true);
  assert.equal(hints.matchesLocal(1, 'head-b', 'approval-a'), false);
  assert.equal(hints.matchesLocal(1, 'head-a', 'approval-b'), false);
  now += 299999;
  assert.ok(hints.get(1, 'identity-a'));
  now++;
  assert.equal(hints.matchesLocal(1, 'head-a', 'approval-a'), false, 'duplicate status echoes never renew the five-minute safety bound');
  assert.equal(hints.get(1, 'identity-a'), null);
});

test('unrelated PR and head invalidations preserve cached and in-flight candidate facts', async () => {
  const hints = new CandidateHints(() => 10);
  const selected = hints.capture(1961, 'selected-head');
  const other = hints.capture(2, 'other-head');
  hints.put(1961, 'selected-head', 'key', { localIdentity: 'approval' }, selected);
  hints.put(2, 'other-head', 'key', {}, other);
  const gate = deferred();
  const preparation = (async () => {
    await gate.promise;
    hints.put(1961, 'selected-head', 'key', { localIdentity: 'approval', ready: true }, selected);
  })();
  hints.invalidate({ pr: 2 });
  hints.invalidate({ headSha: 'other-head' });
  assert.equal(hints.valid(1961, 'selected-head', selected), true);
  assert.equal(hints.get(1961, 'key').token, selected);
  assert.equal(hints.matchesLocal(1961, 'selected-head', 'approval'), true);
  assert.equal(hints.get(2, 'key'), null);
  gate.resolve();
  await preparation;
  assert.equal(hints.get(1961, 'key').value.ready, true);
  assert.equal(hints.valid(1961, 'selected-head', selected), true, 'final selection fence ignores unrelated events');
});

test('matching PR or head invalidation rejects old tokens and in-flight puts', async () => {
  for (const invalidation of [{ pr: 1 }, { headSha: 'shared-head' }]) {
    const hints = new CandidateHints(() => 10);
    const token = hints.capture(1, 'shared-head');
    const samePr = hints.capture(1, 'new-head');
    const sameHead = hints.capture(2, 'shared-head');
    hints.put(1, 'shared-head', 'key', { localIdentity: 'approval' }, token);
    const gate = deferred();
    const preparation = (async () => {
      await gate.promise;
      hints.put(1, 'shared-head', 'key', {}, token);
    })();
    hints.invalidate(invalidation);
    assert.equal(hints.valid(1, 'shared-head', token), false);
    assert.equal(hints.valid(1, 'new-head', samePr), invalidation.pr === undefined);
    assert.equal(hints.valid(2, 'shared-head', sameHead), invalidation.headSha === undefined);
    assert.equal(hints.get(1, 'key'), null);
    assert.equal(hints.matchesLocal(1, 'shared-head', 'approval'), false);
    gate.resolve();
    await preparation;
    assert.equal(hints.get(1, 'key'), null, 'invalidated in-flight work cannot resurrect a hint');
    const fresh = hints.capture(1, 'shared-head');
    assert.equal(hints.valid(1, 'shared-head', token), false, 'recapture cannot revive an old epoch');
    hints.put(1, 'shared-head', 'key', {}, fresh);
    assert.ok(hints.get(1, 'key'));
  }
});

test('combined scoped invalidation matches either scope without invalidating unrelated candidates', () => {
  const hints = new CandidateHints(() => 10);
  const bindings = [[1, 'a'], [2, 'b'], [3, 'c']];
  const tokens = bindings.map(([pr, head]) => {
    const token = hints.capture(pr, head);
    hints.put(pr, head, 'key', {}, token);
    return token;
  });
  hints.invalidate({ pr: 1, headSha: 'b' });
  for (let index = 0; index < bindings.length; index++) {
    const [pr, head] = bindings[index];
    assert.equal(hints.valid(pr, head, tokens[index]), index === 2);
    assert.equal(Boolean(hints.get(pr, 'key')), index === 2);
  }
});

test('explicit all and truly unscoped invalidation fence every token including in-flight work', () => {
  for (const invalidation of [{ all: true }, {}, { all: false }, { pr: undefined, headSha: undefined }]) {
    const hints = new CandidateHints(() => 10);
    const tokens = [hints.capture(1, 'a'), hints.capture(2, 'b')];
    hints.put(1, 'a', 'key', {}, tokens[0]);
    hints.invalidate(invalidation);
    assert.equal(hints.get(1, 'key'), null);
    hints.capture(1, 'a');
    hints.capture(2, 'b');
    for (const [index, head] of ['a', 'b'].entries()) {
      assert.equal(hints.valid(index + 1, head, tokens[index]), false);
      hints.put(index + 1, head, 'key', {}, tokens[index]);
      assert.equal(hints.get(index + 1, 'key'), null);
    }
  }
});

test('candidate tokens are immutable and reject wrong PR, head, instance, or missing binding', () => {
  const hints = new CandidateHints(() => 10);
  const token = hints.capture(1, 'a');
  hints.capture(2, 'b');
  assert.equal(Object.isFrozen(token), true);
  assert.equal(hints.valid(1, 'a', token), true);
  assert.equal(hints.valid(2, 'a', token), false);
  assert.equal(hints.valid(1, 'b', token), false);
  assert.equal(hints.valid(1, 'a', undefined), false);
  assert.equal(hints.valid(1, 'a', {}), false);
  const other = new CandidateHints(() => 10);
  other.capture(1, 'a');
  assert.equal(other.valid(1, 'a', token), false);
  hints.put(2, 'b', 'key', {}, token);
  assert.equal(hints.get(2, 'key'), null);
});

test('PR and head epoch storage is bounded and eviction fails closed without ABA', () => {
  for (const scope of ['pr', 'head']) {
    const hints = new CandidateHints(() => 10);
    const token = hints.capture(0, 'head-0');
    hints.put(0, 'head-0', 'key', { localIdentity: 'approval' }, token);
    for (let index = 1; index <= 256; index++) {
      hints.capture(scope === 'pr' ? index : 0, scope === 'head' ? `head-${index}` : 'head-0');
    }
    assert.equal(hints.valid(0, 'head-0', token), false, `${scope} epochs must be bounded`);
    assert.equal(hints.matchesLocal(0, 'head-0', 'approval'), false, 'local matches reject evicted tokens');
    assert.equal(hints.get(0, 'key'), null, 'cached entries reject evicted tokens');
    const fresh = hints.capture(0, 'head-0');
    assert.equal(hints.valid(0, 'head-0', token), false, 'recreated scopes never reuse an evicted epoch');
    hints.put(0, 'head-0', 'key', {}, token);
    assert.equal(hints.get(0, 'key'), null);
    hints.put(0, 'head-0', 'key', {}, fresh);
    assert.ok(hints.get(0, 'key'));
  }
});

test('candidate hint entries retain the 256-entry bound', () => {
  const hints = new CandidateHints(() => 10);
  for (let pr = 0; pr < 257; pr++) {
    hints.put(pr, `head-${pr}`, 'key', {}, hints.capture(pr, `head-${pr}`));
  }
  assert.equal(hints.get(0, 'key'), null, 'bounded eviction is not durable state');
  assert.ok(hints.get(256, 'key'));
});
