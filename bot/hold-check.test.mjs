import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMembers, inspectPull, readQueue, runHoldCheck } from './hold-check.mjs';

const sha = (digit) => digit.repeat(40);
const base = sha('a');
const middle = sha('b');
const head = sha('c');
const prHead = sha('d');
const group = { base_sha: base, head_sha: head, base_ref: 'refs/heads/main', head_ref: 'refs/heads/gh-readonly-queue/main/pr-2-test' };
const entry = (number, position, from, to) => ({ position, baseCommit: { oid: from }, headCommit: { oid: to }, pullRequest: { number, headRefOid: prHead } });
const entries = [entry(1, 1, base, middle), entry(2, 2, middle, head)];
const pull = (number, changes = {}) => ({ number, state: 'open', draft: false, labels: [], body: '', head: { sha: prHead }, base: { ref: 'main' }, ...changes });
const page = (nodes, totalCount = nodes.length, hasNextPage = false, endCursor = null) => ({ repository: { mergeQueue: { entries: { nodes, totalCount, pageInfo: { hasNextPage, endCursor } } } } });

function harness({ queue = entries, pulls = {}, failQueue = false, ref = head, event = 'merge_group', payload } = {}) {
  const statuses = [];
  const errors = [];
  const readNumbers = [];
  const context = { repo: { owner: 'example', repo: 'project' }, eventName: event, runId: 123,
    payload: payload ?? { action: 'checks_requested', merge_group: group } };
  const github = {
    graphql: async () => { if (failQueue) throw new Error('API unavailable'); return page(queue); },
    rest: {
      repos: { createCommitStatus: async (status) => { statuses.push(status); } },
      git: { getRef: async () => ({ data: { object: { sha: ref } } }) },
      pulls: { list: async () => ({ data: [pull(1), pull(2)] }), get: async ({ pull_number }) => {
        readNumbers.push(pull_number);
        const value = pulls[pull_number];
        return { data: typeof value === 'function' ? value() : value ?? pull(pull_number) };
      } },
    },
  };
  const core = { setFailed: (error) => errors.push(error), error: (error) => errors.push(error) };
  return { github, context, core, statuses, errors, readNumbers };
}

test('conservative prefix resolves every PR, not only the entry matching the group head', () => {
  assert.deepEqual(groupMembers(group, entries).map((member) => member.pullRequest.number), [1, 2]);
  for (const queue of [[], [entries[1]], [entries[0]], [...entries, entries[0]]]) {
    assert.throws(() => groupMembers(group, queue));
  }
  assert.throws(() => groupMembers(group, [entries[0], { ...entries[1], position: 4 }]));
  assert.throws(() => groupMembers({ ...group, base_sha: head }, entries));
  assert.throws(() => groupMembers({ ...group, base_sha: sha('e') }, entries));
  assert.deepEqual(groupMembers(group, [entries[0], entry(2, 2, base, head)])
    .map((member) => member.pullRequest.number), [1, 2]);
  // A known prior queue head may be the event base, but retaining the full
  // prefix deliberately overblocks rather than guessing exact membership.
  assert.deepEqual(groupMembers({ ...group, base_sha: middle }, entries)
    .map((member) => member.pullRequest.number), [1, 2]);
});

test('current PR holds, drafts and Gate boxes block; missing live data and stale heads reject', () => {
  const expected = { number: 1, head: prHead, base: 'main' };
  for (const changes of [{ labels: [{ name: 'HOLD' }] }, { draft: true }, { body: '- [ ] Gate: deployment proof' }]) {
    assert.equal(inspectPull(pull(1, changes), expected).pass, false);
  }
  assert.equal(inspectPull(pull(1, { body: '- [x] Gate: proof' }), expected).pass, true);
  for (const changes of [{ labels: null }, { body: undefined }, { draft: undefined }, { state: 'closed' }, { head: { sha: head } }]) {
    assert.throws(() => inspectPull(pull(1, changes), expected));
  }
});

test('queue pagination includes later pages and rejects failed, partial, changing or looping pages', async () => {
  let calls = 0;
  const github = { graphql: async (_query, args) => {
    calls++;
    assert.equal(args.after, calls === 1 ? null : 'next');
    return calls === 1 ? page([entries[0]], 2, true, 'next') : page([entries[1]], 2);
  } };
  assert.deepEqual(await readQueue(github, { owner: 'example', repo: 'project' }, 'main'), entries);
  for (const response of [page([entries[0]], 2), page([null]), page([], 2, true, 'next'), { repository: null }]) {
    await assert.rejects(readQueue({ graphql: async () => response }, {}, 'main'));
  }
  await assert.rejects(readQueue({ graphql: async () => { throw new Error('offline'); } }, {}, 'main'));
  await assert.rejects(readQueue({ graphql: async () => page([entries[0]], 5, true, 'same') }, {}, 'main'));
  calls = 0;
  await assert.rejects(readQueue({ graphql: async () => ++calls === 1 ? page([entries[0]], 2, true, 'next') : page([entries[1]], 3) }, {}, 'main'));
  calls = 0;
  await assert.rejects(readQueue({ graphql: async () => ++calls === 1
    ? page([entries[0]], 2, true, 'next') : { repository: { mergeQueue: null } } }, {}, 'main'), /disappeared/u);
});

test('held earlier member fails the synthetic head even though final member passes', async () => {
  const h = harness({ pulls: { 1: pull(1, { labels: [{ name: 'hold' }] }) } });
  assert.equal(await runHoldCheck(h), false);
  assert.deepEqual(h.readNumbers, [1, 2]);
  assert.equal(h.statuses.at(-1).sha, head);
  assert.equal(h.statuses.at(-1).state, 'failure');
  assert.ok(!h.statuses.some((status) => status.state === 'success'));
});

test('empty, failed, partial queue resolution and stale synthetic ref never pass', async () => {
  for (const options of [{ queue: [] }, { failQueue: true }, { queue: [entries[1]] }, { ref: middle }]) {
    const h = harness(options);
    assert.equal(await runHoldCheck(h), false);
    assert.equal(h.statuses.at(-1).state, 'failure');
  }
});

test('complete clear group reads every live member twice and publishes exact synthetic SHA', async () => {
  const h = harness();
  assert.equal(await runHoldCheck(h), true);
  assert.deepEqual(h.readNumbers, [1, 2, 1, 2]);
  assert.equal(h.statuses.at(-1).sha, head);
  assert.equal(h.statuses.at(-1).context, 'merge-gate');
  assert.equal(h.statuses.at(-1).state, 'success');
});

test('membership and hold changes during evaluation fail closed', async () => {
  const h = harness();
  let calls = 0;
  h.github.graphql = async () => page(++calls === 1 ? entries : [entries[1]]);
  assert.equal(await runHoldCheck(h), false);
  let reads = 0;
  const changed = harness({ pulls: { 1: () => pull(1, { draft: ++reads > 1 }) } });
  assert.equal(await runHoldCheck(changed), false);
});

test('PR-target status is on current PR head, never base; hold invalidates queued authorities', async () => {
  const payload = { action: 'labeled', pull_request: pull(1) };
  const h = harness({ event: 'pull_request_target', payload, pulls: { 1: pull(1, { body: '- [ ] Gate: wait' }) } });
  assert.equal(await runHoldCheck(h), false);
  assert.deepEqual(h.statuses.filter((status) => status.state === 'failure').map((status) => status.sha), [prHead, middle, head]);
  const clear = harness({ event: 'pull_request_target', payload });
  assert.equal(await runHoldCheck(clear), true);
  assert.equal(clear.statuses.at(-1).sha, prHead);
});

test('stale PR event head cannot grant success to old or new head', async () => {
  const h = harness({ event: 'pull_request_target', payload: { action: 'synchronize', pull_request: pull(1) }, pulls: { 1: pull(1, { head: { sha: head } }) } });
  assert.equal(await runHoldCheck(h), false);
  assert.ok(h.errors.some((message) => message.includes('Stale event head')));
  assert.ok(!h.statuses.some((status) => status.state === 'success'));
});

test('queued PR whose live head changed rejects the stale synthetic group', async () => {
  const h = harness({ pulls: { 1: pull(1, { head: { sha: middle } }) } });
  assert.equal(await runHoldCheck(h), false);
  assert.ok(!h.statuses.some((status) => status.state === 'success'));
});

test('shared entry bases cannot hide an earlier held queue member', async () => {
  const h = harness({
    queue: [entries[0], entry(2, 2, base, head)],
    pulls: { 1: pull(1, { labels: [{ name: 'hold' }] }) },
  });
  assert.equal(await runHoldCheck(h), false);
  assert.deepEqual(h.readNumbers, [1, 2]);
  assert.ok(!h.statuses.some((status) => status.state === 'success'));
});

test('a clear PR cannot overwrite a held PR sharing the same commit status SHA', async () => {
  const h = harness({ event: 'pull_request_target', payload: { action: 'edited', pull_request: pull(1) } });
  h.github.rest.pulls.list = async () => ({ data: [pull(1), pull(2, { labels: [{ name: 'hold' }] })] });
  assert.equal(await runHoldCheck(h), false);
  assert.ok(!h.statuses.some((status) => status.state === 'success'));
  assert.equal(h.statuses.find((status) => status.state === 'failure').sha, prHead);
});

test('shared-head checks include later open-PR pages and reject unstable membership', async () => {
  const h = harness({ event: 'pull_request_target', payload: { action: 'edited', pull_request: pull(1) } });
  h.github.rest.pulls.list = async ({ page }) => ({ data: page === 1
    ? Array.from({ length: 100 }, (_, i) => pull(i + 2, { head: { sha: base } }))
    : [pull(102, { draft: true }), pull(1)] });
  assert.equal(await runHoldCheck(h), false);
  assert.ok(h.errors.some((error) => error.includes('sharing this head')));
  assert.ok(!h.statuses.some((status) => status.state === 'success'));
  const changing = harness({ event: 'pull_request_target', payload: { action: 'edited', pull_request: pull(1) } });
  let reads = 0;
  changing.github.rest.pulls.list = async () => ({ data: ++reads === 1 ? [pull(1)] : [pull(1), pull(2)] });
  assert.equal(await runHoldCheck(changing), false);
  assert.ok(changing.errors.some((error) => error.includes('authority changed')));
});

test('PR events cannot authorize a shared synthetic queue head, including another base branch', async () => {
  const candidate = pull(3, { head: { sha: head }, base: { ref: 'release' } });
  const h = harness({ event: 'pull_request_target', payload: { action: 'edited', pull_request: candidate },
    pulls: { 3: candidate } });
  h.github.rest.pulls.list = async () => ({ data: [candidate, pull(1)] });
  h.github.graphql = async (_query, { branch }) => branch === 'main' ? page(entries) : { repository: { mergeQueue: null } };
  assert.equal(await runHoldCheck(h), false);
  assert.ok(h.errors.some((error) => error.includes('aliases a synthetic')));
  assert.ok(!h.statuses.some((status) => status.state === 'success'));
});

test('native auto-merge can pass without an enabled merge queue', async () => {
  const h = harness({ event: 'pull_request_target', payload: { action: 'edited', pull_request: pull(1) } });
  h.github.graphql = async () => ({ repository: { mergeQueue: null } });
  assert.equal(await runHoldCheck(h), true);
  assert.equal(h.statuses.at(-1).state, 'success');
});
