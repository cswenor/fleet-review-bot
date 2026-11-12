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

const appUser = { id: 1007, login: 'example-review[bot]', type: 'Bot',
  html_url: 'https://github.com/apps/example-review' };
const appReview = (changes = {}) => ({ id: 1, user: appUser, state: 'APPROVED',
  commit_id: prHead, submitted_at: '2026-11-12T12:00:00Z', ...changes });
function appHarness(options = {}, reviews = () => [appReview()]) {
  const h = harness(options);
  h.reviewApp = 'example-review';
  h.github.rest.users = { getByUsername: async () => ({ data: appUser }) };
  h.github.rest.pulls.listReviews = async (args) => ({ data: reviews(args) });
  h.github.rest.pulls.list = async () => ({ data: [1, 2].map((number) =>
    typeof options.pulls?.[number] === 'object' ? options.pulls[number] : pull(number)) });
  return h;
}

test('configured App requires exact-head approval, not a stale, dismissed, human or wrong-App review', async () => {
  const options = { event: 'pull_request_target', payload: { action: 'edited', pull_request: pull(1) } };
  const valid = appHarness(options);
  assert.equal(await runHoldCheck(valid), true);
  assert.equal(valid.statuses.at(-1).state, 'success');
  for (const review of [
    null, appReview({ commit_id: base }), appReview({ state: 'DISMISSED' }),
    appReview({ user: { ...appUser, id: 1008 } }),
    appReview({ user: { ...appUser, login: 'different-review[bot]' } }),
    appReview({ user: { ...appUser, type: 'User' } }),
  ]) {
    const h = appHarness(options, () => review ? [review] : []);
    assert.equal(await runHoldCheck(h), false);
    assert.equal(h.statuses.at(-1).state, 'failure');
    assert.ok(!h.statuses.some((s) => s.state === 'success'));
  }
});

test('latest decisive App review revokes an earlier approval; comment-only reviews do not', async () => {
  const options = { event: 'approval_reconcile', payload: { action: 'reconcile' } };
  for (const state of ['DISMISSED', 'CHANGES_REQUESTED']) {
    const h = appHarness(options, () => [appReview(),
      appReview({ id: 2, state, submitted_at: '2026-11-12T13:00:00Z' })]);
    assert.equal(await runHoldCheck(h), false);
    assert.ok(!h.statuses.some((s) => s.state === 'success'));
  }
  const comment = appHarness(options, () => [appReview(),
    appReview({ id: 2, state: 'COMMENTED', submitted_at: '2026-11-12T13:00:00Z' })]);
  assert.equal(await runHoldCheck(comment), true);
});

test('every queue member needs its own exact-head App approval', async () => {
  const wrongHead = sha('e');
  const queue = [entries[0], { ...entries[1], pullRequest: { number: 2, headRefOid: wrongHead } }];
  const options = { queue, pulls: { 2: pull(2, { head: { sha: wrongHead } }) } };
  const denied = appHarness(options, () => [appReview()]);
  assert.equal(await runHoldCheck(denied), false);
  assert.equal(denied.statuses.findLast((s) => s.sha === head).state, 'failure');
  const valid = appHarness(options, ({ pull_number }) => [
    appReview({ commit_id: pull_number === 2 ? wrongHead : prHead }),
  ]);
  assert.equal(await runHoldCheck(valid), true);
  assert.equal(valid.statuses.at(-1).sha, head);
  assert.equal(valid.statuses.at(-1).state, 'success');
});

test('App identity and unavailable or unstable review pagination fail closed', async () => {
  const options = { event: 'pull_request_target', payload: { action: 'edited', pull_request: pull(1) } };
  const identity = appHarness(options);
  identity.github.rest.users.getByUsername = async () => ({ data: { ...appUser, type: 'User' } });
  assert.equal(await runHoldCheck(identity), false);
  const unavailable = appHarness(options, () => { throw new Error('API unavailable'); });
  assert.equal(await runHoldCheck(unavailable), false);
  const repeated = appHarness(options, () => Array.from({ length: 100 }, () => appReview()));
  assert.equal(await runHoldCheck(repeated), false);
  const later = appHarness(options, ({ page }) => page === 1
    ? Array.from({ length: 100 }, (_, i) => appReview({ id: i + 10, user: { id: 123 } }))
    : [appReview()]);
  assert.equal(await runHoldCheck(later), true);
});

test('approval revoked between authority reads prevents success', async () => {
  let reads = 0;
  const h = appHarness({ event: 'approval_reconcile', payload: { action: 'reconcile' } },
    () => [appReview({ state: ++reads > 1 ? 'DISMISSED' : 'APPROVED' })]);
  assert.equal(await runHoldCheck(h), false);
  assert.ok(!h.statuses.some((s) => s.state === 'success'));
});

test('reconciliation cannot select authority or hide live PRs via extra payload metadata', async () => {
  const h = appHarness({ event: 'approval_reconcile', payload: { action: 'reconcile',
    workflow_run: { conclusion: 'success', pull_requests: [], review_app: '', head_sha: base } } },
  ({ pull_number }) => pull_number === 1 ? [appReview()] : []);
  assert.equal(await runHoldCheck(h), false);
  assert.ok(h.errors.some((error) => error.includes('exact-head approval')));
  assert.ok(h.statuses.some((s) => s.sha === prHead && s.state === 'failure'));
});

test('PR-controlled review trigger has no direct merge-gate authority', async () => {
  const h = appHarness({ event: 'pull_request_review',
    payload: { action: 'submitted', pull_request: pull(1) } });
  assert.equal(await runHoldCheck(h), false);
  assert.ok(!h.statuses.some((s) => s.state === 'success'));
});

test('unapproved PR outside the queue cannot revoke approved synthetic authority during review sweep', async () => {
  const extra = pull(3, { head: { sha: sha('f') } });
  const h = appHarness({ pulls: { 3: extra } },
    ({ pull_number }) => pull_number === 3 ? [] : [appReview()]);
  h.github.rest.pulls.list = async () => ({ data: [pull(1), pull(2), extra] });
  assert.equal(await runHoldCheck(h), true);
  h.context.eventName = 'approval_reconcile';
  h.context.payload = { action: 'reconcile' };
  assert.equal(await runHoldCheck(h), false);
  assert.equal(h.statuses.findLast((status) => status.sha === head).state, 'success');
  assert.equal(h.statuses.findLast((status) => status.sha === extra.head.sha).state, 'failure');
});

test('a later queued member losing approval revokes only prefixes containing it', async () => {
  const second = pull(2, { head: { sha: sha('e') } });
  const queue = [entries[0], { ...entries[1], pullRequest: { number: 2, headRefOid: second.head.sha } }];
  const h = appHarness({ queue, pulls: { 2: second }, event: 'pull_request_target',
    payload: { action: 'edited', pull_request: second } }, () => []);
  assert.equal(await runHoldCheck(h), false);
  assert.equal(h.statuses.findLast((status) => status.sha === head).state, 'failure');
  assert.ok(!h.statuses.some((status) => status.sha === middle));
});
