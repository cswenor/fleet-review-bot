import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { routeEvent, verifySignature, resolvePullRequests, minimalPayload, isRereviewCommand } from './webhook.mjs';
const sha = 'a'.repeat(40);
const payload = (action, draft = false) => ({ action, repository: { full_name: 'example-org/example-project' },
  pull_request: { number: 7, draft, base: { ref: 'main' }, head: { sha, ref: 'feature', repo: { full_name: 'example-org/example-project' } } } });
test('HMAC accepts exact bytes and rejects missing, malformed and mismatched signatures', () => {
  const raw = Buffer.from('{"a":1}');
  const header = 'sha256=' + createHmac('sha256', 'fixture-secret').update(raw).digest('hex');
  assert.equal(verifySignature(raw, header, 'fixture-secret'), true);
  for (const wrong of [null, 'sha256=x', 'sha256=' + '0'.repeat(64)]) assert.equal(verifySignature(raw, wrong, 'fixture-secret'), false);
  assert.equal(verifySignature(Buffer.from('{}'), header, 'fixture-secret'), false);
});
test('PR actions debounce, skip drafts, cancel and reuse exact-head completion', () => {
  for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
    assert.deepEqual(routeEvent('pull_request', payload(action), { now: 10 }), [{ type: 'enqueue', pr: 7, head_sha: sha, base_ref: 'main', due: 60010, reason: action }]);
    assert.equal(routeEvent('pull_request', payload(action, true))[0].type, 'markDraft');
  }
  assert.equal(routeEvent('pull_request', payload('ready_for_review'), { completed: true })[0].type, 'reuseVerdict');
  assert.equal(routeEvent('pull_request', payload('closed'))[0].reason, 'closed');
  assert.equal(routeEvent('pull_request', payload('converted_to_draft'))[0].reason, 'draft');
  for (const action of ['edited', 'labeled', 'unlabeled']) {
    assert.deepEqual(routeEvent('pull_request', payload(action)), [{ type: 'mergeChanged' }]);
  }
});
test('foreign repos, forks and irrelevant workflow/app events are ignored', () => {
  const foreign = payload('opened'); foreign.repository.full_name = 'other/repo';
  assert.deepEqual(routeEvent('pull_request', foreign), []);
  const fork = payload('opened'); fork.pull_request.head.repo.full_name = 'other/repo';
  assert.equal(routeEvent('pull_request', fork)[0].reason, 'fork_refused');
  const run = { repository: { full_name: 'example-org/example-project' }, action: 'completed', workflow_run: { name: 'CI', head_sha: sha, head_branch: 'feature', id: 8, conclusion: 'success', html_url: 'https://example.invalid/run' } };
  assert.equal(routeEvent('workflow_run', run)[0].type, 'ciCompleted');
  assert.deepEqual(routeEvent('workflow_run', { ...run, workflow_run: { ...run.workflow_run, name: 'Other' } }), []);
  const check = { repository: run.repository, action: 'rerequested', check_run: { app: { id: 1001 }, name: 'codex-review', head_sha: sha } };
  assert.equal(routeEvent('check_run', check, { now: 3 })[0].allowDraft, true);
  assert.equal(routeEvent('check_run', check, { now: 3 })[0].due, 3);
  assert.deepEqual(routeEvent('check_run', { ...check, check_run: { ...check.check_run, app: { id: 1 } } }), []);
  assert.deepEqual(routeEvent('pull_request_review', payload('submitted')), []);
});
test('PR resolution uses branch then commit SHA, not empty webhook pull_requests', async () => {
  const calls = [];
  const github = { repo: 'example-org/example-project', paginate: async (path) => { calls.push(path); return path.includes('/commits/') ? [{ state: 'open', number: 7, head: { sha } }] : []; } };
  assert.equal((await resolvePullRequests(github, { head_sha: sha, branch: 'feature', pull_requests: [] }))[0].number, 7);
  assert.match(calls[0], /head=example-org%3Afeature/u);
  assert.match(calls[1], /\/commits\/a{40}\/pulls/u);
  github.paginate = async () => [{ number: 9, head: { sha } }, { number: 10, head: { sha: 'b'.repeat(40) } }];
  assert.deepEqual((await resolvePullRequests(github, { head_sha: sha, branch: 'feature' })).map((pr) => pr.number), [9]);
});

test('unsupported targets are ignored and base edits cancel before a fresh main-target enqueue', () => {
  for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
    const unsupported = payload(action); unsupported.pull_request.base.ref = 'release';
    assert.deepEqual(routeEvent('pull_request', unsupported), []);
  }
  const edited = payload('edited'); edited.changes = { base: { ref: { from: 'main' } } };
  edited.pull_request.base.ref = 'release';
  const stored = minimalPayload(edited);
  assert.equal(stored.pull_request.base.ref, 'release');
  assert.deepEqual(stored.changes, { base: true });
  assert.deepEqual(routeEvent('pull_request', stored), [{ type: 'cancel', pr: 7, head_sha: sha,
    base_ref: 'release', reason: 'target_changed' }]);
  edited.pull_request.base.ref = 'main';
  assert.deepEqual(routeEvent('pull_request', minimalPayload(edited), { now: 10 }), [
    { type: 'cancel', pr: 7, head_sha: sha, base_ref: 'main', reason: 'target_changed' },
    { type: 'enqueue', pr: 7, head_sha: sha, base_ref: 'main', due: 10, reason: 'retargeted' },
  ]);
  edited.pull_request.draft = true;
  assert.equal(routeEvent('pull_request', minimalPayload(edited)).at(-1).type, 'enqueue',
    'Every retarget to main gets a fresh queued identity; the pre-run draft fence still applies');
});

test('merged main closure triggers a sweep and minimal payload retains merged', () => {
  const merged = payload('closed'); merged.pull_request.merged = true;
  const minimal = minimalPayload(merged);
  assert.equal(minimal.pull_request.merged, true);
  assert.deepEqual(routeEvent('pull_request', minimal), [
    { type: 'cancel', pr: 7, head_sha: sha, base_ref: 'main', reason: 'closed' }, { type: 'mainMoved' },
  ]);
  merged.pull_request.merged = false;
  assert.deepEqual(routeEvent('pull_request', minimalPayload(merged)), [
    { type: 'cancel', pr: 7, head_sha: sha, base_ref: 'main', reason: 'closed' },
  ]);
  merged.pull_request.merged = true; merged.pull_request.base.ref = 'release';
  assert.equal(routeEvent('pull_request', minimalPayload(merged)).length, 1);
});

const reviewComment = (overrides = {}) => ({ action: 'created', repository: { full_name: 'example-org/example-project' },
  pull_request: payload('opened').pull_request,
  comment: { id: 900, in_reply_to_id: 500, created_at: '2026-10-10T20:00:00Z', body: 'Evidence: token=s3cret at a.rb:12',
    user: { id: 42, login: 'author', type: 'User' }, ...overrides } });
const issueComment = (body, overrides = {}) => ({ action: 'created', repository: { full_name: 'example-org/example-project' },
  issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/example-org/example-project/pulls/7' } },
  comment: { id: 901, created_at: '2026-10-10T20:00:00Z', body, user: { id: 42, login: 'author', type: 'User' } }, ...overrides });

test('finding replies and /rereview commands route to a comment re-review', () => {
  const created = Date.parse('2026-10-10T20:00:00Z');
  assert.deepEqual(routeEvent('pull_request_review_comment', reviewComment(), { now: 10 }), [{ type: 'commentRereview', pr: 7,
    trigger: 'finding_reply', comment_id: 900, in_reply_to_id: 500, created_at: created,
    commenter: { id: 42, login: 'author' }, due: 60010 }]);
  assert.deepEqual(routeEvent('issue_comment', issueComment('Answered F1.\r\n  /rereview  \n'), { now: 10 }), [{ type: 'commentRereview',
    pr: 7, trigger: 'command', comment_id: 901, created_at: created, commenter: { id: 42, login: 'author' }, due: 10 }]);
  assert.deepEqual(routeEvent('pull_request_review_comment', reviewComment({ in_reply_to_id: undefined })), []);
  assert.deepEqual(routeEvent('pull_request_review_comment', reviewComment({ user: { id: 1, login: 'b[bot]', type: 'Bot' } })), []);
  const fork = reviewComment(); fork.pull_request = structuredClone(fork.pull_request);
  fork.pull_request.head.repo.full_name = 'other/repo';
  assert.deepEqual(routeEvent('pull_request_review_comment', fork), []);
  assert.deepEqual(routeEvent('pull_request_review_comment', { ...reviewComment(), action: 'edited' }), []);
  for (const body of ['please /rereview', '/rereview now', '', undefined]) {
    assert.deepEqual(routeEvent('issue_comment', issueComment(body)), [], String(body));
  }
  assert.deepEqual(routeEvent('issue_comment', issueComment('/rereview', { issue: { number: 7 } })), []);
  const bot = issueComment('/rereview'); bot.comment.user.type = 'Bot';
  assert.deepEqual(routeEvent('issue_comment', bot), []);
  assert.deepEqual(routeEvent('issue_comment', { ...issueComment('/rereview'), action: 'edited' }), []);
  assert.equal(isRereviewCommand('/rereview'), true);
});

test('builder-bot finding replies and /rereview route, but an impostor bot is ignored', () => {
  const user = { id: 1003, login: 'builder[bot]', type: 'Bot' };
  const created = Date.parse('2026-10-10T20:00:00Z');
  assert.deepEqual(routeEvent('pull_request_review_comment', reviewComment({ user }), { now: 10 }), [
    { type: 'commentRereview', pr: 7, trigger: 'finding_reply', comment_id: 900, in_reply_to_id: 500,
      created_at: created, commenter: { id: user.id, login: user.login }, due: 60010 },
  ]);
  const command = issueComment('/rereview'); command.comment.user = user;
  assert.deepEqual(routeEvent('issue_comment', command, { now: 10 }), [
    { type: 'commentRereview', pr: 7, trigger: 'command', comment_id: 901,
      created_at: created, commenter: { id: user.id, login: user.login }, due: 10 },
  ]);
  const impostor = { id: 1, login: 'builder[bot]', type: 'Bot' };
  assert.deepEqual(routeEvent('pull_request_review_comment', reviewComment({ user: impostor })), []);
  command.comment.user = impostor;
  assert.deepEqual(routeEvent('issue_comment', command), []);
});

test('a builder-App PR comment citing findings routes a debounced builder answer; humans and other bots do not', () => {
  const builder = { id: 1003, login: 'builder[bot]', type: 'Bot' };
  const body = 'Re review-bot **F2** (`a.mjs:55`, token=s3cret): not applicable. See F2 and F10.';
  const builderComment = issueComment(body); builderComment.comment.user = builder;
  const routed = routeEvent('issue_comment', builderComment, { now: 10 });
  assert.deepEqual(routed, [{ type: 'commentRereview', pr: 7, trigger: 'builder_answer', findings: ['F2', 'F10'],
    comment_id: 901, created_at: Date.parse('2026-10-10T20:00:00Z'),
    commenter: { id: builder.id, login: builder.login }, due: 60010 }]);
  assert.deepEqual(routeEvent('issue_comment', issueComment(body), { now: 10 }), []);
  for (const user of [{ id: 1002, login: 'example-review[bot]', type: 'Bot' },
    { id: 1, login: 'builder[bot]', type: 'Bot' }]) {
    const comment = issueComment(body); comment.comment.user = user;
    assert.deepEqual(routeEvent('issue_comment', comment, { now: 10 }), []);
  }
  const noFinding = issueComment('Pushed a fix.'); noFinding.comment.user = builder;
  assert.deepEqual(routeEvent('issue_comment', noFinding, { now: 10 }), []);
  const command = issueComment('Answered F2\n/rereview'); command.comment.user = builder;
  const operations = routeEvent('issue_comment', command, { now: 10 });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].trigger, 'command');
  assert.equal(operations[0].due, 10);
  const minimal = minimalPayload(builderComment);
  assert.equal(minimal.comment.body, 'F2 F10');
  assert.doesNotMatch(JSON.stringify(minimal), /s3cret|applicable/u);
  assert.deepEqual(routeEvent('issue_comment', minimal, { now: 10 }), routed);
});

test('minimal comment payloads keep only the command, never other comment text', () => {
  const reply = minimalPayload(reviewComment());
  assert.equal(reply.comment.body, '');
  assert.doesNotMatch(JSON.stringify(reply), /s3cret|Evidence/u);
  assert.deepEqual(routeEvent('pull_request_review_comment', reply, { now: 10 }),
    routeEvent('pull_request_review_comment', reviewComment(), { now: 10 }));
  const command = minimalPayload(issueComment('Fixed per a.rb:3 token=s3cret\n/rereview'));
  assert.equal(command.comment.body, '/rereview');
  assert.deepEqual(command.issue, { number: 7, pull_request: true });
  assert.doesNotMatch(JSON.stringify(command), /s3cret/u);
  assert.deepEqual(routeEvent('issue_comment', command, { now: 10 }),
    routeEvent('issue_comment', issueComment('Fixed per a.rb:3 token=s3cret\n/rereview'), { now: 10 }));
});
