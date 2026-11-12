import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEFAULT_BATCH_SIZE, HARD_BATCH_SIZE, batchLimit, mergePriority, orderCandidates,
  selectClosedBatch, ancestryViolations, manifestDigest,
} from './batch-plan.mjs';

const sha = (n) => n.toString(16).padStart(40, '0');
const ready = (pr, extra = {}) => ({
  pr, head_sha: sha(pr), review_id: pr + 10, publication_id: pr + 20,
  github_review_id: pr + 30, pull_request_id: `PR_${pr}`,
  ci_run_id: pr + 40, ci_attempt: 1, priority: null,
  created_at: '2026-10-01T12:00:00Z', ...extra,
});
const head = (value) => ({ pr: value.pr, head_sha: value.head_sha });
function input(members, extra = {}) {
  return { ready: members, open: members.map(head),
    dependencies: new Map(members.map((value) => [value.pr, []])), ...extra };
}
const prs = (result) => result.members.map((value) => value.pr);

function freeze(value) {
  if (value instanceof Map) {
    for (const entry of value.values()) freeze(entry);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
  }
  return Object.freeze(value);
}

test('limits default to five and accept only integer capacities one through five', () => {
  assert.equal(DEFAULT_BATCH_SIZE, 5);
  assert.equal(HARD_BATCH_SIZE, 5);
  assert.equal(batchLimit(), 5);
  for (const value of [1, 2, 3, 4, 5]) assert.equal(batchLimit(value), value);
  for (const value of [0, 6, -1, 1.5, '3', null, NaN, Infinity]) {
    assert.throws(() => batchLimit(value), TypeError);
  }
});

test('priority takes the minimum valid label, including zero, without changing labels', () => {
  const pr = freeze({ labels: [
    { name: 'merge-priority:3' }, { name: 'merge-priority:0' }, { name: 'merge-priority:1' },
    { name: 'merge-priority:01' }, { name: 'merge-priority:-1' },
    { name: 'merge-priority:9007199254740992' }, { name: 'merge-priority:2x' },
  ] });
  assert.equal(mergePriority(pr), 0);
  assert.equal(mergePriority({ labels: [{ name: 'merge-priority:2' }] }), 2);
  assert.equal(mergePriority({}), null);
  assert.equal(mergePriority({ labels: [{ name: 'merge-priority:01' }] }), null);
});

test('ordering uses numeric priority, oldest timestamp, then PR number; null sorts last', () => {
  const members = freeze([
    ready(8, { priority: null, created_at: null }),
    ready(7, { priority: null, created_at: '2020-01-01T00:00:00Z' }),
    ready(6, { priority: 3, created_at: '2020-01-01T00:00:00Z' }),
    ready(5, { priority: 1, created_at: '2026-10-01T11:00:00Z' }),
    ready(4, { priority: 1, created_at: '2026-10-01T12:00:00+02:00' }),
    ready(3, { priority: 1, created_at: '2026-10-01T10:00:00Z' }),
  ]);
  assert.deepEqual(orderCandidates(members).map((value) => value.pr), [3, 4, 5, 6, 7, 8]);
  assert.equal(members[0].pr, 8);
  assert.deepEqual(prs(selectClosedBatch(input(members, { max: 4 }))), [3, 4, 5, 6]);
});

test('selection honors capacities one through five without implementing the lane fill wait', () => {
  const members = [1, 2, 3, 4, 5, 6].map((pr) => ready(pr));
  assert.deepEqual(prs(selectClosedBatch(input([]))), []);
  assert.deepEqual(prs(selectClosedBatch(input([members[0]]))), [1]);
  for (const max of [1, 2, 3, 4, 5]) {
    assert.deepEqual(prs(selectClosedBatch(input(members, { max }))), members.slice(0, max).map(({ pr }) => pr));
  }
  const five = selectClosedBatch(input(members));
  assert.deepEqual(prs(five), [1, 2, 3, 4, 5]);
  assert.deepEqual(five.deferred, [{ pr: 6, reason: 'capacity', dependencies: [6] }]);
  assert.match(manifestDigest({ id: 'five', generation: 1, base_sha: sha(10), members: members.slice(0, 5) }), /^[0-9a-f]{64}$/u);
});

test('recursive exact-head closure is selected atomically and deterministically ordered', () => {
  const members = [ready(1, { priority: 1 }), ready(2, { priority: 2 }), ready(3, { priority: 3 })];
  const args = freeze(input(members, { dependencies: new Map([
    [1, [head(members[1])]], [2, [head(members[2])]], [3, []],
  ]) }));
  const before = structuredClone(args);
  const result = selectClosedBatch(args);
  assert.deepEqual(prs(result), [1, 2, 3]);
  assert.deepEqual(result.deferred, []);
  assert.deepEqual(args, before);
});

test('known exact-head conflicts reject completed dependency closures, not partial witnesses', () => {
  const members = [1, 2, 3, 4].map((pr) => ready(pr));
  const knownConflicts = [[head(members[0]), head(members[1])]];
  const dependencies = new Map([[1, []], [2, []], [3, [head(members[1])]], [4, []]]);
  const selected = selectClosedBatch(input(members, { dependencies, knownConflicts }));
  assert.deepEqual(prs(selected), [1, 4]);
  assert.deepEqual(selected.deferred, [
    { pr: 2, reason: 'known-conflict', dependencies: [1, 2] },
    { pr: 3, reason: 'known-conflict', dependencies: [1, 2] },
  ]);
  const prefix = selectClosedBatch(input(members, { knownConflicts: [members.slice(0, 3).map(head)] }));
  assert.deepEqual(prs(prefix), [1, 2, 4], 'a larger composition witness does not invent conflicting pairs');
});

test('a closure that does not fit is deferred; a compatible later candidate still runs', () => {
  const members = [1, 2, 3, 4, 5].map((pr) => ready(pr));
  const dependencies = new Map([[1, [head(members[1])]], [2, [head(members[2])]],
    [3, [head(members[3])]], [4, []], [5, []]]);
  const result = selectClosedBatch(input(members, { dependencies, max: 3 }));
  assert.deepEqual(prs(result), [2, 3, 4]);
  assert.deepEqual(result.deferred[0], { pr: 1, reason: 'capacity', dependencies: [1, 2, 3, 4] });
  const single = selectClosedBatch(input(members, { dependencies, max: 1 }));
  assert.deepEqual(prs(single), [4]);
});

test('held, draft, fork and nonmain dependencies from all-open never gain admission', () => {
  for (const excluded of [
    { held: true }, { draft: true }, { head: { repo: { full_name: 'other/fork' } } },
    { base: { ref: 'release' } },
  ]) {
    const admitted = [ready(1), ready(3)];
    const hidden = { ...head(ready(2)), ...excluded };
    const result = selectClosedBatch(input(admitted, {
      open: [head(admitted[0]), hidden, head(admitted[1])],
      dependencies: new Map([[1, [head(hidden)]], [3, []]]),
    }));
    assert.deepEqual(prs(result), [3]);
    assert.deepEqual(result.deferred, [{ pr: 1, reason: 'unready-dependency', dependencies: [2] }]);
  }
});

test('missing open identity, stale ready head and stale dependency head fail closed', () => {
  const a = ready(1);
  const b = ready(2);
  for (const extra of [
    { open: [head(a)] },
    { open: [head(a), { pr: 2, head_sha: sha(20) }] },
    { dependencies: new Map([[1, [{ pr: 2, head_sha: sha(20) }]], [2, []]]) },
  ]) {
    const result = selectClosedBatch(input([a, b], {
      dependencies: new Map([[1, [head(b)]], [2, []]]), ...extra,
    }));
    assert.ok(!prs(result).includes(1));
    assert.equal(result.deferred[0].reason, 'unready-dependency');
    assert.deepEqual(result.deferred[0].dependencies, [2]);
  }
  const missing = selectClosedBatch(input([a], { dependencies: new Map() }));
  assert.deepEqual(missing, { members: [], serial: false,
    deferred: [{ pr: 1, reason: 'missing-ancestry', dependencies: [1] }] });
});

test('priority zero companions must all be zero, including recursive dependencies', () => {
  const members = [ready(1, { priority: 0 }), ready(2, { priority: 1 }),
    ready(3, { priority: 0 }), ready(4)];
  assert.deepEqual(prs(selectClosedBatch(input(members))), [1, 3]);
  const result = selectClosedBatch(input(members, {
    dependencies: new Map([[1, [head(members[1])]], [2, []], [3, []], [4, []]]),
  }));
  assert.deepEqual(prs(result), [3]);
  assert.deepEqual(result.deferred[0], { pr: 1, reason: 'priority-zero-only', dependencies: [2] });
  assert.ok(result.deferred.some((value) => value.pr === 2 && value.reason === 'priority-zero-only'));
});

test('forced serial fallback is a true singleton, never a companion or an open dependency bypass', () => {
  const members = [ready(1), ready(2), ready(3)];
  const forced = selectClosedBatch(input(members, { forceSerial: [1] }));
  assert.deepEqual(prs(forced), [1]);
  assert.equal(forced.serial, true);
  const blocked = selectClosedBatch(input(members, { forceSerial: [1],
    dependencies: new Map([[1, [head(members[1])]], [2, []], [3, []]]) }));
  assert.deepEqual(prs(blocked), [2, 3]);
  assert.equal(blocked.serial, false);
  assert.equal(blocked.deferred[0].reason, 'force-serial');
  const companion = selectClosedBatch(input(members, { forceSerial: [2],
    dependencies: new Map([[1, [head(members[1])]], [2, []], [3, []]]) }));
  assert.deepEqual(prs(companion), [2]);
  assert.equal(companion.serial, true);
});

test('ready isolation singletons precede higher-priority ordinary work and retain their own priority and age order', () => {
  const members = [
    ready(3, { priority: 2, created_at: '2026-10-01T12:00:00Z' }),
    ready(1, { priority: 0, created_at: '2020-01-01T00:00:00Z' }),
    ready(2, { priority: 3, created_at: '2020-01-01T00:00:00Z' }),
    ready(4, { priority: 2, created_at: '2026-10-01T11:00:00Z' }),
  ];
  const result = selectClosedBatch(input(members, { forceSerial: [3, 2, 4] }));
  assert.deepEqual(prs(result), [4]);
  assert.equal(result.serial, true);
});

test('final ancestry fence catches any reachable unselected or new pinned open head', () => {
  const members = [ready(1), ready(2)];
  const open = [head(members[0]), { pr: 2, head_sha: sha(200) },
    { ...head(ready(3)), draft: true }, { ...head(ready(4)), held: true }, head(ready(5))];
  const args = freeze({ open, members, baseAncestors: new Set([4]), combinedAncestors: new Set([1, 2, 3, 4]) });
  assert.deepEqual(ancestryViolations(args), [open[1], open[2]]);
  assert.deepEqual(ancestryViolations({ ...args, combinedAncestors: new Set([1, 4]) }), []);
  assert.deepEqual(ancestryViolations({ ...args, members: [], combinedAncestors: new Set([5]) }), [open[4]]);
});

test('manifest is canonical complete identity JSON, preserving member order and every receipt', () => {
  const members = [ready(2), ready(1, { priority: 0 })];
  const args = freeze({ id: 'batch-a', generation: 1, base_sha: sha(100), members });
  const expected = createHash('sha256').update(JSON.stringify(args)).digest('hex');
  const digest = manifestDigest(args);
  assert.equal(digest, expected);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  const reorderedKeys = members.map((value) => Object.fromEntries(Object.entries(value).reverse()));
  assert.equal(manifestDigest({ members: reorderedKeys, base_sha: args.base_sha, generation: 1, id: args.id }), digest);
  assert.notEqual(manifestDigest({ ...args, members: [...members].reverse() }), digest);
  for (const field of ['pr', 'head_sha', 'review_id', 'publication_id', 'github_review_id',
    'pull_request_id', 'ci_run_id', 'ci_attempt', 'priority', 'created_at']) {
    const changed = { ...members[0] };
    changed[field] = field === 'head_sha' ? sha(999)
      : field === 'pull_request_id' ? 'PR_changed'
        : field === 'priority' ? 2
          : field === 'created_at' ? '2026-10-02T12:00:00Z' : changed[field] + 100;
    assert.notEqual(manifestDigest({ ...args, members: [changed, members[1]] }), digest, field);
  }
  for (const change of [{ id: 'batch-b' }, { generation: 2 }, { base_sha: sha(101) }]) {
    assert.notEqual(manifestDigest({ ...args, ...change }), digest);
  }
  assert.equal(manifestDigest({ ...args, members: members.map((value) => ({ ...value,
    body: '<!-- manifest: forged -->', carrier_branch: 'forged', labels: [{ name: 'merge-priority:0' }],
  })) }), digest);
});

test('malformed and duplicate member identities and incomplete receipts are rejected', () => {
  for (const change of [
    { pr: 0 }, { pr: '1' }, { head_sha: null }, { head_sha: 'bad' },
    { review_id: null }, { publication_id: 0 }, { github_review_id: undefined },
    { pull_request_id: '' }, { ci_run_id: null }, { ci_attempt: 0 },
    { priority: undefined }, { priority: Infinity }, { priority: -1 }, { priority: '0' },
    { created_at: 'invalid' }, { created_at: 1 },
  ]) {
    const bad = ready(1, change);
    assert.throws(() => orderCandidates([bad]), TypeError);
    assert.throws(() => manifestDigest({ id: 'x', generation: 1, base_sha: sha(10), members: [bad] }), TypeError);
  }
  const duplicate = [ready(1), ready(1, { head_sha: sha(2) })];
  assert.throws(() => selectClosedBatch(input(duplicate)), /duplicate/u);
  assert.throws(() => manifestDigest({ id: 'x', generation: 1, base_sha: sha(10), members: duplicate }), /duplicate/u);
  assert.throws(() => orderCandidates([ready(1), ready(2, { pull_request_id: 'PR_1' })]), /duplicate pull_request_id/u);
  assert.throws(() => selectClosedBatch(input([ready(1)], { open: [head(ready(1)), head(ready(1))] })), /duplicate/u);
  assert.throws(() => selectClosedBatch(input([ready(1)], { dependencies: new Map([[1, [head(ready(1))]]]) })), /exclude/u);
  assert.throws(() => selectClosedBatch(input([ready(1)], { dependencies: new Map([[1, [head(ready(2)), head(ready(2))]]]) })), /duplicate/u);
  assert.throws(() => selectClosedBatch(input([ready(1)], { forceSerial: [1, 1] })), TypeError);
  assert.throws(() => ancestryViolations({ open: [head(ready(1))], members: [],
    baseAncestors: new Set(), combinedAncestors: new Set([2]) }), TypeError);
  for (const change of [{ generation: 0 }, { id: '' }, { base_sha: 'bad' }, { members: [] },
    { members: [1, 2, 3, 4, 5, 6].map((pr) => ready(pr)) }]) {
    assert.throws(() => manifestDigest({ id: 'x', generation: 1, base_sha: sha(10), members: [ready(1)], ...change }), TypeError);
  }
});
