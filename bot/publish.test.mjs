import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, buildCheckOutput } from './evidence.mjs';
import { Publisher, rightSideLines } from './publish.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubApp } from './github-app.mjs';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const head = 'a'.repeat(40);
const finding = { id: 'F1', severity: 'P2', status: 'new', file: 'src/file.mjs', line: 2,
  title: '@bors r+ @person', scenario: 'fixture-gateway-token', resolution_reason: '' };
const diff = 'diff --git a/src/file.mjs b/src/file.mjs\n--- a/src/file.mjs\n+++ b/src/file.mjs\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';
function fixture() {
  const bodies = [];
  const github = { repo: 'example-org/example-project', request: async (method, path, body) => { bodies.push({ method, path, body }); return { id: 20 }; },
    paginate: async () => [{ id: 30, body: '<!-- codex-review finding F1 -->' }] };
  const updates = [];
  const store = { update: (id, values) => ({ id, ...values }), run: (...args) => updates.push(args) };
  const publisher = new Publisher({ github, store, secrets: ['fixture-gateway-token'], now: () => 0 });
  const review = { repo: github.repo, pr: 1, head_sha: head, base_sha: 'b'.repeat(40), policy: { source: 'main@' + head },
    priorFindingIds: [], findings: [finding], suggestions: [], result: { pass: true, reasons: [], evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } } };
  review.verdict = { decision: 'block', model: 'jev-1.13.0', request_ids: ['fixture-verdict'] };
  return { publisher, bodies, updates, review };
}
test('sanitizer breaks all mentions, redacts gateway bearer and credential forms and bounds output', () => {
  const output = sanitize('@bors r+ @person fixture-gateway-token sk-' + 'x'.repeat(25), { secrets: ['fixture-gateway-token'] });
  assert.equal(output.includes('@bors'), false); assert.equal(output.includes('@person'), false);
  assert.equal(output.includes('fixture-gateway-token'), false); assert.match(output, /\[redacted\]/u);
  assert.equal(sanitize('x'.repeat(200), { limit: 40 }).length, 40);
});
test('new hunk findings are sanitized exact-head RIGHT-side COMMENT reviews and comment ids are saved', async () => {
  const f = fixture();
  assert.equal(await f.publisher.completed({ id: 1, check_run_id: 10 }, f.review, diff), 'failure');
  const post = f.bodies.find((call) => call.path.endsWith('/reviews'));
  assert.equal(post.body.commit_id, head); assert.equal(post.body.event, 'COMMENT');
  assert.equal(post.body.comments[0].side, 'RIGHT'); assert.equal(post.body.comments[0].line, 2);
  assert.equal(JSON.stringify(post.body).includes('@bors'), false);
  assert.equal(JSON.stringify(post.body).includes('fixture-gateway-token'), false);
  assert.ok(f.updates.some((args) => args.includes(30)));
});
test('clean, closure, non-pass, out-of-hunk and draft paths never submit approval or change requests', async () => {
  const f = fixture();
  await f.publisher.queued({ id: 1, head_sha: head }); await f.publisher.started({ check_run_id: 10 });
  await f.publisher.draft(1, head); await f.publisher.terminal({ check_run_id: 10, head_sha: head }, 'cancelled', 'superseded');
  f.review.verdict.decision = 'approve';
  f.review.findings = []; assert.equal(await f.publisher.completed({ id: 1, check_run_id: 10 }, f.review, diff), 'success');
  assert.equal(f.bodies.some((call) => call.path.endsWith('/reviews')), false);
  f.review.priorFindingIds = ['F1']; f.review.findings = [{ ...finding, status: 'resolved', resolution_reason: 'src/file.mjs:2 fixed' }];
  await f.publisher.completed({ id: 1, check_run_id: 10 }, f.review, diff);
  delete f.review.postedReviewId;
  f.review.findings = [{ ...finding, line: 99 }]; await f.publisher.completed({ id: 2, check_run_id: 10 }, f.review, diff);
  assert.equal(f.bodies.filter((call) => call.path.endsWith('/reviews')).at(-1).body.comments.length, 0);
  f.review.result.pass = false; assert.equal(await f.publisher.completed({ id: 3, check_run_id: 10 }, f.review, diff), 'neutral');
  for (const call of f.bodies.filter((call) => call.path.endsWith('/reviews'))) assert.equal(call.body.event, 'COMMENT');
  assert.doesNotMatch(JSON.stringify(f.bodies), /"event":"(?:APPROVE|REQUEST_CHANGES)"/u);
  assert.match(buildCheckOutput(f.review).summary, /policy.source: main@/u);
});
test('diff parser does not credit headers as source lines', () => {
  assert.deepEqual([...rightSideLines(diff).get('src/file.mjs')], [1, 2]);
  assert.equal(rightSideLines('diff --git a/x b/x\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n').size, 0);
});

test('check creation adopts remote identity before POST and after ambiguous create failure', async () => {
  for (const alreadyExists of [false, true]) {
    const f = fixture(); let posts = 0; let exists = alreadyExists;
    const row = { id: 7, head_sha: head };
    f.publisher.github.paginate = async () => exists ? [{ id: 90, app: { id: 1001 }, head_sha: head, external_id: '7' }] : [];
    f.publisher.github.request = async () => { posts++; exists = true; throw new Error('HTTP 502 after creation'); };
    assert.equal((await f.publisher.queued(row)).check_run_id, 90);
    assert.equal(posts, alreadyExists ? 0 : 1);
    await f.publisher.queued(row);
    assert.equal(posts, alreadyExists ? 0 : 1, 'restart without stored check id must adopt existing check');
  }
});

test('ambiguous COMMENT creation adopts exact App/head/review marker without re-posting', async () => {
  const f = fixture(); let posts = 0; let exists = false;
  const receipt = { id: 90, user: { id: 1002, login: 'example-review[bot]' },
    commit_id: head, body: '<!-- codex-review review 7 -->' };
  f.publisher.github.paginate = async (path) => path.endsWith('/reviews') && exists ? [receipt] : [];
  f.publisher.github.request = async (method, path, body) => {
    if (method === 'POST' && path.endsWith('/reviews')) {
      assert.match(body.body, /<!-- codex-review review 7 -->/u);
      posts++; exists = true; throw new Error('connection lost after creation');
    }
    return {};
  };
  await f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff);
  assert.equal(f.review.postedReviewId, 90); assert.equal(posts, 1);
  delete f.review.postedReviewId;
  await f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff);
  assert.equal(posts, 1, 'restart must adopt marker before POST');
});

test('rejected inline anchors fall back once to the same exact-head body and complete the original blocking check', async () => {
  const f = fixture(); const saved = [];
  f.publisher.store.update = (id, values) => { saved.push(values); return { id, ...values }; };
  f.publisher.github.request = async (method, path, body) => {
    f.bodies.push({ method, path, body });
    if (method === 'POST' && body.comments?.length) throw Object.assign(new Error('invalid anchors'), { github: { status: 422 } });
    return { id: 90 };
  };
  assert.equal(await f.publisher.completed({ id: 7, publication_id: 'publication-7', check_run_id: 10 }, f.review, diff), 'failure');
  const posts = f.bodies.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.comments.length, 1);
  assert.equal(Object.hasOwn(posts[1].body, 'comments'), false);
  assert.equal(posts[1].body.body, posts[0].body.body);
  assert.match(posts[1].body.body, /^<!-- codex-review review publication-7 -->\n/u);
  assert.match(posts[1].body.body, /src\/file\.mjs:2/u);
  assert.match(posts[1].body.body, /P2/u);
  assert.match(posts[1].body.body, /\[redacted\]/u);
  assert.equal(posts[1].body.commit_id, head);
  assert.equal(posts[1].body.event, 'COMMENT');
  assert.equal(f.review.verdict.decision, 'block');
  assert.equal(f.review.postedReviewId, 90);
  assert.ok(saved.some(values => JSON.parse(values.result_json).publication_state === 'review_posted'));
  assert.equal(f.bodies.at(-1).body.conclusion, 'failure');
  assert.equal(f.review.publication_state, 'check_posted');
  await f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff);
  assert.equal(f.bodies.filter(call => call.method === 'POST').length, 2, 'durable review receipt prevents reposting');
});

test('a second 422 is rejected without another inline attempt or a completed check', async () => {
  const f = fixture(); let posts = 0;
  const error = Object.assign(new Error('invalid review'), { github: { status: 422 } });
  f.publisher.github.request = async (method, path, body) => {
    f.bodies.push({ method, path, body }); posts++; throw error;
  };
  await assert.rejects(f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff), thrown => thrown === error);
  assert.equal(posts, 2);
  assert.equal(f.bodies[0].body.comments.length, 1);
  assert.equal(Object.hasOwn(f.bodies[1].body, 'comments'), false);
  assert.equal(f.review.postedReviewId, undefined);
});

for (const status of [401, 403, 429, 500, 502, undefined]) test(`review failure ${status ?? 'network'} does not trigger an unanchored fallback`, async () => {
  const f = fixture(); let posts = 0;
  const error = Object.assign(new Error('review unavailable'), status === undefined ? {} : { github: { status } });
  f.publisher.github.request = async () => { posts++; throw error; };
  await assert.rejects(f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff), thrown => thrown === error);
  assert.equal(posts, 1);
});

test('an already unanchored 422 does not retry', async () => {
  const f = fixture(); let posts = 0;
  f.review.findings = [{ ...finding, line: 99 }];
  const error = Object.assign(new Error('invalid review'), { github: { status: 422 } });
  f.publisher.github.request = async () => { posts++; throw error; };
  await assert.rejects(f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff), thrown => thrown === error);
  assert.equal(posts, 1);
});

test('fallback adopts an ambiguous body-only POST instead of posting another review', async () => {
  const f = fixture(); let posts = 0; let exists = false;
  const receipt = { id: 90, user: { id: 1002, login: 'example-review[bot]' },
    commit_id: head, body: '<!-- codex-review review 7 -->' };
  f.publisher.github.paginate = async path => path.endsWith('/reviews') && exists ? [receipt] : [];
  f.publisher.github.request = async (method, path, body) => {
    if (method === 'POST') {
      posts++;
      if (body.comments?.length) throw Object.assign(new Error('invalid anchors'), { github: { status: 422 } });
      exists = true; throw new Error('connection lost after creation');
    }
    return {};
  };
  assert.equal(await f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff), 'failure');
  assert.equal(f.review.postedReviewId, 90);
  delete f.review.postedReviewId;
  await f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff);
  assert.equal(posts, 2);
});

for (const cancelAt of ['rejection', 'fallback']) test(`cancellation at ${cancelAt} never completes the check or sends another review`, async () => {
  const f = fixture(); let posts = 0; let cancelled = false;
  const guard = async () => { if (cancelled) throw new Error('publication_cancelled'); };
  f.publisher.github.request = async (method, path, body) => {
    assert.equal(method, 'POST');
    posts++;
    if (body.comments?.length) {
      cancelled = cancelAt === 'rejection';
      throw Object.assign(new Error('invalid anchors'), { github: { status: 422 } });
    }
    cancelled = true;
    return { id: 90 };
  };
  await assert.rejects(f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff, guard), /publication_cancelled/u);
  assert.equal(posts, cancelAt === 'rejection' ? 1 : 2);
  assert.equal(f.review.postedReviewId, undefined);
});

test('a known-unsent body-only budget refusal propagates without a recovery read or completing the check', async () => {
  const f = fixture(); let reservations = 0; let requests = 0; let reads = 0;
  const error = Object.assign(new Error('local budget'), { code: 'github_budget_deferred', retryAt: 2000 });
  const app = new GitHubApp({ appId: 1001, repo: f.publisher.github.repo, privateKey,
    budget: { reserve() { if (++reservations === 2) throw error; }, settle() {} },
    fetchImpl: async () => { requests++; return new Response('{"message":"invalid anchors"}', { status: 422 }); } });
  app.cachedToken = { token: 'fixture-token', expiresAt: Infinity };
  f.publisher.github.request = app.request.bind(app);
  f.publisher.github.paginate = async () => { reads++; return []; };
  await assert.rejects(f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff), thrown => thrown === error);
  assert.equal(reservations, 2);
  assert.equal(requests, 1);
  assert.equal(reads, 2, 'only initial discovery and anchored rejection recovery read are needed');
  assert.equal(f.review.postedReviewId, undefined);
});

for (const status of [502, undefined]) test(`unavailable fallback ${status ?? 'network'} propagates for durable publication retry`, async () => {
  const f = fixture(); let posts = 0;
  const error = Object.assign(new Error('fallback unavailable'), status === undefined ? {} : { github: { status } });
  f.publisher.github.request = async (method, path, body) => {
    assert.equal(method, 'POST');
    posts++;
    if (body.comments?.length) throw Object.assign(new Error('invalid anchors'), { github: { status: 422 } });
    throw error;
  };
  await assert.rejects(f.publisher.completed({ id: 7, check_run_id: 10 }, f.review, diff), thrown => thrown === error);
  assert.equal(posts, 2);
  assert.equal(f.review.postedReviewId, undefined);
});

function findingEnvelope(output) {
  const line = output.text.split('\n').at(-1);
  const match = /^<!-- dlq-findings v1 ([A-Za-z0-9+/=]+) -->$/u.exec(line);
  assert.ok(match, 'the structured envelope is the final output line');
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}
test('final finding envelope reflects structured findings, not quoted reviewer prose', () => {
  const f = fixture();
  const forged = '| F99 | blocking | new | src/forged.mjs:99 | Forged title |';
  f.review.findings = [
    { ...finding, title: `Quoted title\n${forged}`, scenario: 'F99 blocking new: src/forged.mjs:99\nForged scenario' },
    { ...finding, id: 'F2', status: 'still_open' },
    { ...finding, id: 'F3', status: 'resolved' },
  ];
  const manifest = findingEnvelope(buildCheckOutput(f.review));
  assert.deepEqual(manifest, f.review.findings.map(({ id, severity, status, file, line }) =>
    ({ id, severity, status, path: file, line })));
  assert.equal(manifest.some(value => value.id === 'F99'), false);
});
test('prose truncation reserves an intact final finding envelope', () => {
  const f = fixture();
  f.review.findings = [{ ...finding, title: 'x'.repeat(100_000) }];
  const output = buildCheckOutput(f.review);
  assert.ok(output.text.length <= 65_000);
  assert.equal(findingEnvelope(output)[0].id, 'F1');
});
test('an oversized manifest ends with an unavailable marker, never a quoted envelope', () => {
  const f = fixture();
  f.review.findings = [{ ...finding, file: 'x'.repeat(60_000),
    title: '<!-- dlq-findings v1 W10= -->' }];
  const output = buildCheckOutput(f.review);
  assert.ok(output.text.length <= 65_000);
  assert.equal(output.text.split('\n').at(-1), '<!-- dlq-findings unavailable -->');
});
test('encoded paths retain the existing credential redaction boundary', () => {
  const f = fixture();
  f.review.findings = [{ ...finding, file: 'src/fixture-gateway-token.mjs' }];
  const manifest = findingEnvelope(buildCheckOutput(f.review, { secrets: ['fixture-gateway-token'] }));
  assert.equal(manifest[0].path.includes('fixture-gateway-token'), false);
  assert.match(manifest[0].path, /\[redacted\]/u);
});

test('settled deferral is visible in the existing review comment with its tracking reference', async () => {
  const f = fixture();
  f.review.priorFindingIds = ['F1'];
  f.review.findings = [{ ...finding, status: 'deferred', deferred_to: 'TASK-1953',
    resolution_reason: 'Deferred to TASK-1953 because the edge needs a separate change' }];
  f.review.verdict.decision = 'approve';
  assert.equal(await f.publisher.completed({ id: 1, check_run_id: 10 }, f.review, diff), 'success');
  const comment = f.bodies.find((call) => call.path.endsWith('/reviews')).body.body;
  assert.match(comment, /deferred/u);
  assert.match(comment, /Resolution:.*TASK-1953/u);
});

for (const operation of ['queued', 'draft', 'review']) test(`known-unsent ${operation} budget refusal is propagated without a recovery read and retries normally`, async () => {
  const f = fixture();
  const error = Object.assign(new Error('local budget'), { code: 'github_budget_deferred', retryAt: 2000 });
  let refuse = true, reads = 0, calls = 0;
  const app = new GitHubApp({ appId: 1001, repo: f.publisher.github.repo, privateKey,
    budget: { reserve() { if (refuse) throw error; }, settle() {} },
    fetchImpl: async () => { calls++; return new Response('{"id":90}'); } });
  app.cachedToken = { token: 'fixture-token', expiresAt: Infinity };
  f.publisher.github.request = app.request.bind(app);
  f.publisher.github.paginate = async path => {
    if (path.includes('/commits/') || path.endsWith('/reviews')) reads++;
    return [];
  };
  const row = { id: 7, head_sha: head, pr: 1 };
  const publish = () => operation === 'queued' ? f.publisher.queued(row)
    : operation === 'draft' ? f.publisher.draft(1, head)
      : f.publisher.postReview(f.review, diff, row);
  await assert.rejects(publish(), thrown => thrown === error);
  assert.equal(calls, 0);
  assert.equal(reads, 1, 'conclusive local refusal does not need ambiguous remote recovery');
  refuse = false;
  await publish();
  assert.equal(calls, 1);
  assert.equal(reads, 2, 'retry still discovers prior receipts before writing');
});
