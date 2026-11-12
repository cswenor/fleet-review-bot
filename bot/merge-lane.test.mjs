import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { Scheduler } from './scheduler.mjs';
import { Approval } from './approval.mjs';
import { Shepherd } from './shepherd.mjs';
import { GitHubApp } from './github-app.mjs';
import { REVIEW_APP_ID, REVIEW_BOT, REPOSITORY } from './identity.mjs';

const sha = (n) => n.toString(16).padStart(40, '0');
const recordedSingleMerge = JSON.parse(await readFile(new URL('./fixtures/native-single-merge-2026.json', import.meta.url), 'utf8'));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'merge-lane-'));
  const path = join(root, 'state.sqlite');
  const store = new Store(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const f = { store, path, prs: new Map(), reviews: new Map(), ci: new Map(), behind: new Map(), mergeCommits: new Map(),
    main: sha(100), strict: true, updates: [], merges: [], events: [], signals: new Map(), failMerge: false };
  const app = { id: 15368, slug: 'github-actions' };
  const ciRuns = () => [...f.ci].map(([head, state], index) => ({
    id: index + 1, check_suite_id: index + 1001, run_attempt: 1, name: 'CI',
    event: 'pull_request', head_sha: head, path: '.github/workflows/ci.yml', workflow_id: 7,
    repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${index + 1}`, ...state,
  }));
  const github = { repo: REPOSITORY, appId: REVIEW_APP_ID,
    async request(method, url, body, guard) {
      const number = Number(/\/pulls\/(\d+)/u.exec(url)?.[1]);
      const pr = f.prs.get(number);
      const runId = /\/actions\/runs\/(\d+)$/u.exec(url);
      if (method === 'GET' && runId) {
        const run = ciRuns().find((candidate) => candidate.id === Number(runId[1]));
        if (!run) throw new Error(`unexpected CI run ${url}`);
        return run;
      }
      if (method === 'POST' && url.endsWith('/check-runs')) {
        await guard?.('before_send');
        const check = { id: 8000 + f.signals.size, app: { id: REVIEW_APP_ID }, ...structuredClone(body) };
        f.signals.set(check.id, check);
        return structuredClone(check);
      }
      const signal = /\/check-runs\/(\d+)$/u.exec(url);
      if (signal) {
        const check = f.signals.get(Number(signal[1]));
        if (!check) throw new Error('unknown scheduling check');
        if (method === 'PATCH') { await guard?.('before_send'); Object.assign(check, structuredClone(body)); }
        return structuredClone(check);
      }
      if (method === 'GET' && /\/pulls\/\d+$/u.test(url)) {
        if (f.recoveryFailure) throw new Error('github_timeout');
        return structuredClone(pr);
      }
      if (url.includes('/labels')) {
        const owner = f.prs.get(Number(/\/issues\/(\d+)/u.exec(url)?.[1]));
        if (method === 'POST' && owner) owner.labels.push(...body.labels.map((name) => ({ name })));
        return {};
      }
      if (method === 'GET' && url.endsWith('/git/ref/heads/main')) return { object: { sha: f.main } };
      if (method === 'GET' && url.includes('/commits/')) {
        const commit = url.split('/').at(-1);
        if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`GitHub request failed: GET ${url} HTTP 422`);
        return { sha: commit, commit: { tree: { sha: f.nativeTree ?? sha(1000) } } };
      }
      if (method === 'GET' && url.includes('/compare/main...')) {
        const head = url.split('...')[1].split('?')[0];
        const current = [...f.prs.values()].find((p) => p.head.sha === head);
        return { behind_by: f.behind.get(current.number), base_commit: { sha: f.main } };
      }
      if (method === 'GET' && url.includes('/compare/')) return { files: f.workflowDiff ? [{ filename: '.github/workflows/ci.yml' }] : [] };
      if (method === 'GET' && url.endsWith('/rules/branches/main')) return [
        { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: f.strict,
          required_status_checks: ['re-actors/alls-green', 'merge-gate', 'codex-review'].map((context) => ({ context, integration_id: REVIEW_APP_ID })) } },
      ];
      if (method === 'POST' && url.endsWith('/reviews')) {
        await guard?.('before_send');
        const review = { id: number * 100, user: { ...REVIEW_BOT, type: 'Bot' },
          commit_id: body.commit_id, state: 'APPROVED', body: body.body };
        f.reviews.get(number).push(review);
        return review;
      }
      if (method === 'PUT' && url.endsWith('/update-branch')) {
        if (f.beforeUpdate) await f.beforeUpdate();
        await guard?.('before_send');
        assert.equal(body.expected_head_sha, pr.head.sha);
        f.updates.push(number);
        if (f.updateError) throw new Error(f.updateError);
        pr.head.sha = sha(number + 10);
        f.behind.set(number, 0);
        f.ci.set(pr.head.sha, { status: 'in_progress', conclusion: null });
        return {};
      }
      if (method === 'PUT' && url.endsWith('/merge')) {
        if (f.beforeMutation) await f.beforeMutation();
        await guard('before_send');
        if (f.beforeMerge) await f.beforeMerge();
        if (!f.strict || f.behind.get(number) !== 0 || body.sha !== pr.head.sha) throw new Error('GitHub HTTP 405 stale merge');
        if (f.failMerge) throw new Error('github_timeout');
        f.merges.push(number);
        pr.state = 'closed'; pr.merged = true; pr.merged_by = { ...REVIEW_BOT };
        const mergedSha = f.nativeMergeSha ?? sha(2000 + number);
        f.mergeCommits.set(number, mergedSha);
        f.main = mergedSha;
        for (const other of f.prs.values()) if (other.state === 'open') f.behind.set(other.number, 1);
        return { merged: true };
      }
      throw new Error(`unexpected ${method} ${url}`);
    },
    async paginate(url) {
      if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs/u.test(url)
        || /\/actions\/runs\/\d+\/jobs\?filter=latest(?:&|$)/u.test(url)) return [];
      const signalHead = /\/commits\/([a-f0-9]{40})\/check-runs(?:\?|$)/u.exec(url);
      if (signalHead) return [...f.signals.values()].filter((check) => check.head_sha === signalHead[1]).map((check) => structuredClone(check));
      if (url.includes('/reviews')) return structuredClone(f.reviews.get(Number(/\/pulls\/(\d+)/u.exec(url)[1])));
      const commit = /\/commits\/([a-f0-9]{40})\/check-suites(?:\?|$)/u.exec(url);
      if (commit) return ciRuns().filter((run) => run.head_sha === commit[1]).map((run) => ({
        id: run.check_suite_id, head_sha: run.head_sha, app, repository: { full_name: REPOSITORY },
      }));
      const suite = /\/check-suites\/(\d+)\/check-runs(?:\?|$)/u.exec(url);
      if (suite) return ciRuns().filter((run) => run.check_suite_id === Number(suite[1])).map((run) => ({
        id: run.id + 2000, head_sha: run.head_sha, app, check_suite: { id: run.check_suite_id },
        details_url: `https://github.com/${REPOSITORY}/actions/runs/${run.id}/job/${run.id + 2000}`,
      }));
      if (url.includes('/pulls?state=open')) return [...f.prs.values()].filter((p) => p.state === 'open');
      throw new Error(`unexpected paginate ${url}`);
    },
    async graphql(_query, { number }, guard) {
      await guard?.();
      const pr = f.prs.get(number);
      return { repository: { pullRequest: { ...recordedSingleMerge.graphql.repository.pullRequest,
        id: pr.node_id, merged: pr.merged === true, headRefOid: pr.head.sha, baseRefName: pr.base.ref,
        mergeCommit: f.mergeCommits.has(number) ? { oid: f.mergeCommits.get(number) } : null } } };
    },
  };
  const approval = new Approval({ store, github, mode: 'approve', admit: async () => true });
  const shepherd = new Shepherd({ store, github });
  const options = { store, github, approval, shepherd, publisher: { updateEvidence: async () => {} },
    batchMaxSize: 1,
    mirror: { reviewModel: 'openai-codex/gpt-6.1-sol', reviewThinking: 'medium' },
    batchMirror: {
      dependencies: async (_batch, members) => new Map(members.map((member) => [member.pr, []])),
      ancestry: async (batch, members) => ({ baseAncestors: new Set(),
        combinedAncestors: new Set(members.filter((member) => batch.members.some((selected) => selected.pr === member.pr)).map((member) => member.pr)) }),
      discard: async () => {},
    },
    batchReadProof: async ({ batch }) => ({ state: 'green', receipt: {
      run_id: 1, attempt: 1, artifact_id: 1, tree_sha: batch.tree_sha, image_digest: null,
    } }),
    batchConfirmTree: async ({ batch }) => ({ tree_sha: batch.tree_sha, merge_sha: batch.merged_sha }),
    mode: 'approve', log: (event) => f.events.push(event) };
  f.scheduler = new Scheduler(options);
  f.restart = () => {
    f.scheduler = new Scheduler(options);
    f.scheduler.publishStatus = async () => ({ comment_id: 1 });
  };
  f.add = async (number, { priority, age = number, behind = 1, pull = null } = {}) => {
    const pr = { ...structuredClone(recordedSingleMerge.rest_pull), number, node_id: `PR_${number}`,
      state: 'open', merged: false, merged_at: null, merged_by: null, draft: false, mergeable: true,
      user: { id: 1, login: 'author', type: 'User' }, labels: priority === undefined ? [] : [{ name: `merge-priority:${priority}` }],
      created_at: new Date(age * 1000).toISOString(), body: '',
      head: { sha: sha(number), ref: `feature-${number}`, repo: { full_name: REPOSITORY } },
      base: { ref: 'main', repo: { full_name: REPOSITORY } } };
    if (pull) Object.assign(pr, structuredClone(pull),
      { state: 'open', merged: false, merged_at: null, merged_by: null, draft: false, mergeable: true });
    f.prs.set(number, pr); f.behind.set(number, behind); f.reviews.set(number, []);
    await f.approve(number);
    return pr;
  };
  f.approve = async (number) => {
    const pr = f.prs.get(number);
    const row = store.enqueue({ pr: number, head_sha: pr.head.sha, base_ref: 'main', due: 0, reason: 'opened' }, Date.now());
    const review = { publication_id: row.id, review_route: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
      result: { pass: true, evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } },
      verdict: { decision: 'approve' } };
    store.update(row.id, { status: 'completed', result_json: JSON.stringify(review) });
    await approval.run({ ...row, publication_id: row.id }, review);
    f.ci.set(pr.head.sha, { status: 'completed', conclusion: 'success' });
  };
  f.advance = () => f.scheduler.batchLane.advance([...f.prs.values()].filter((pr) => pr.state === 'open'));
  // Status publishing is unrelated to lane authorization; keep the real inspection/update path.
  f.scheduler.publishStatus = async () => ({ comment_id: 1 });
  return f;
}

test('a missed CI webhook is recovered by a bounded lane probe without scanning ten approved PRs', async (t) => {
  const f = await fixture(t);
  f.scheduler.now = () => 1000000;
  for (let number = 1; number <= 10; number++) await f.add(number, { behind: 0 });
  for (const ci of f.ci.values()) { ci.status = 'in_progress'; ci.conclusion = null; }
  await f.scheduler.reconcile();
  const inspected = [], inspect = f.scheduler.shepherd.inspect.bind(f.scheduler.shepherd);
  f.scheduler.shepherd.inspect = async (number) => { inspected.push(number); return inspect(number); };
  await f.scheduler.reconcileLane();
  assert.deepEqual(inspected, [1]);
  assert.deepEqual(f.merges, []);
  f.ci.get(sha(2)).status = 'completed'; f.ci.get(sha(2)).conclusion = 'success';
  await f.scheduler.reconcileLane();
  assert.deepEqual(inspected, [1, 2]);
  assert.equal(f.scheduler.reconcileSoonAt, f.scheduler.now());
  assert.deepEqual(f.merges, [], 'a readiness probe cannot bypass the normal merge fences');
  await f.scheduler.tick();
  assert.deepEqual(f.merges, [2]);
});

test('only the highest-priority green approved PR refreshes, persists through retest, then advances', async (t) => {
  const f = await fixture(t);
  await f.add(1, { age: 1 }); await f.add(2, { priority: 0, age: 3 }); await f.add(3, { priority: 0, age: 2 });
  await f.advance();
  assert.deepEqual(f.updates, [3]); assert.deepEqual(f.merges, []);
  assert.equal(f.store.activeMergeBatch().members[0].pr, 3);
  f.restart();
  await f.advance();
  assert.deepEqual(f.updates, [3]); assert.equal(f.store.activeMergeBatch().members[0].pr, 3);
  await f.approve(3);
  await f.advance();
  assert.deepEqual(f.merges, [3]); assert.equal(f.store.activeMergeBatch().state, 'publishing');
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  assert.deepEqual(f.updates, [3], 'no second branch changes in the merge pass');
  await f.advance(); assert.deepEqual(f.updates, [3, 2]);
});

test('red CI, hold gates and changes-requested PRs cannot enter the lane', async (t) => {
  const f = await fixture(t);
  const held = await f.add(1, { priority: 0 }); held.body = '- [ ] Gate: owner';
  const red = await f.add(2, { priority: 0 }); f.ci.set(red.head.sha, { status: 'completed', conclusion: 'failure' });
  await f.add(3, { priority: 0 });
  f.reviews.get(3).push({ id: 301, user: { id: 5, login: 'human', type: 'User' }, state: 'CHANGES_REQUESTED', submitted_at: new Date().toISOString() });
  await f.add(4);
  await f.advance(); assert.deepEqual(f.updates, [4]);
});

test('a blocked selected retest releases the lane without touching unrelated pending branches', async (t) => {
  const f = await fixture(t);
  const first = await f.add(1, { priority: 0 }); await f.add(2);
  await f.advance(); await f.approve(1);
  f.ci.set(first.head.sha, { status: 'completed', conclusion: 'failure' });
  await f.advance(); await f.advance();
  assert.deepEqual(f.updates, [1, 2]); assert.deepEqual(f.merges, []);
});

test('main movement after the last client check is rejected by strict server checks', async (t) => {
  const f = await fixture(t); await f.add(1, { behind: 0 }); await f.add(2);
  f.beforeMerge = async () => { f.main = sha(200); f.behind.set(1, 1); };
  await assert.rejects(f.advance(), /stale merge/u);
  assert.deepEqual(f.merges, []); assert.deepEqual(f.updates, []);
  assert.equal(f.store.activeMergeBatch().members[0].pr, 1);
});

test('strict protection removal fails closed and an uncertain merge does not advance another PR', async (t) => {
  const f = await fixture(t); await f.add(1, { behind: 0 }); await f.add(2);
  f.strict = false;
  await assert.rejects(f.advance(), /merge_strict_checks_required/u);
  assert.deepEqual(f.merges, []); assert.equal(f.store.activeMergeBatch().members[0].pr, 1);
  f.strict = true; f.failMerge = true;
  await assert.rejects(f.advance(), /github_timeout/u);
  assert.deepEqual(f.updates, []); assert.equal(f.store.activeMergeBatch().members[0].pr, 1);
});

test('a fresh human veto releases the selected lane before mutation', async (t) => {
  const f = await fixture(t); await f.add(1); await f.add(2);
  await f.advance(); await f.approve(1);
  f.reviews.get(1).push({ id: 101, user: { id: 5, login: 'human', type: 'User' }, state: 'CHANGES_REQUESTED', submitted_at: new Date().toISOString() });
  await f.advance(); await f.advance(); assert.deepEqual(f.merges, []); assert.deepEqual(f.updates, [1, 2]);
});

test('real reconciliation refreshes only the selected lane and legacy cleanup failure blocks every merge', async (t) => {
  const f = await fixture(t); await f.add(1, { behind: 0 }); await f.add(2);
  const row = f.store.latest(2);
  f.store.updateApproval(row.id, { armed: 1 }, Date.now());
  f.prs.get(2).auto_merge = { enabled_by: { ...REVIEW_BOT } };
  // No DISABLE transport is available: durable legacy authority must remain fenced.
  await f.scheduler.reconcile();
  assert.equal(f.store.approval(row.id).armed, 1);
  assert.deepEqual(f.merges, []); assert.deepEqual(f.updates, []);
  f.store.updateApproval(row.id, { armed: 0 }, Date.now());
  f.prs.get(2).auto_merge = null;
  await f.scheduler.reconcile();
  assert.deepEqual(f.merges, [1]); assert.deepEqual(f.updates, []);
});

test('selected update refusal is durable across main changes and never updates another branch', async (t) => {
  const f = await fixture(t); const first = await f.add(1); await f.add(2);
  f.updateError = 'GitHub request failed: PUT /update-branch HTTP 403';
  await f.advance();
  assert.equal(f.store.failedUpdate(1, first.head.sha).outcome, 'failed:HTTP 403');
  assert.ok(first.labels.some((label) => label.name === 'needs-update'));
  f.main = sha(201); await f.advance();
  assert.deepEqual(f.updates, [1]); assert.deepEqual(f.merges, []);
  const reopened = new Store(f.path);
  try { assert.equal(reopened.activeMergeBatch().members[0].pr, 1); } finally { reopened.close(); }
});

for (const change of ['head', 'rerequest', 'hold']) {
  test(`late ${change} at the merge mutation boundary keeps the lane fenced`, async (t) => {
    const f = await fixture(t); const first = await f.add(1, { behind: 0 }); await f.add(2);
    f.beforeMutation = async () => {
      if (change === 'head') first.head.sha = sha(999);
      if (change === 'rerequest') f.scheduler.pendingEnqueues.add({ pr: 1, head_sha: first.head.sha });
      if (change === 'hold') first.labels.push({ name: 'hold' });
    };
    await assert.rejects(f.advance());
    assert.deepEqual(f.merges, []); assert.deepEqual(f.updates, []);
    assert.equal(f.store.latestMergeBatchForPr(1).members[0].pr, 1);
  });
}

for (const kind of ['update', 'merge']) {
  for (const blocked of ['hold', 'red-ci']) {
    test(`uncertain ${kind} survives ${blocked} and restart until its expected head is superseded`, async (t) => {
      const f = await fixture(t);
      const first = await f.add(1, { behind: kind === 'merge' ? 0 : 1 }); await f.add(2);
      if (kind === 'update') {
        f.updateError = 'github_timeout';
        await f.advance();
      } else {
        f.failMerge = true;
        await assert.rejects(f.advance(), /github_timeout/u);
      }
      assert.equal(f.store.activeMergeBatch().mutation.kind, kind);
      const reopened = new Store(f.path);
      try {
        assert.equal(reopened.activeMergeBatch().mutation.head_sha, first.head.sha);
        assert.equal(reopened.activeMergeBatch().mutation.main_sha, f.main);
      } finally { reopened.close(); }
      if (blocked === 'hold') first.labels.push({ name: 'hold' });
      else f.ci.set(first.head.sha, { status: 'completed', conclusion: 'failure' });
      f.restart();
      await f.advance();
      assert.equal(f.store.activeMergeBatch().members[0].pr, 1);
      assert.equal(f.store.activeMergeBatch().mutation.kind, kind);
      assert.deepEqual(f.updates, kind === 'update' ? [1] : []);
      assert.deepEqual(f.merges, []);
      // A new head makes the old expected-head request incapable of applying.
      first.head.sha = sha(999);
      if (blocked === 'red-ci') first.labels.push({ name: 'hold' });
      f.failMerge = false; f.updateError = null;
      await f.advance(); await f.advance(); await f.advance();
      assert.equal(f.store.activeMergeBatch().members[0].pr, 2);
      assert.deepEqual(f.updates, kind === 'update' ? [1, 2] : [2]);
    });
  }
}

test('a workflow-touching HTTP 503 update remains transport-uncertain, not a permission refusal', async (t) => {
  const f = await fixture(t); const first = await f.add(1); await f.add(2);
  f.updateError = 'GitHub request failed: PUT /update-branch HTTP 503';
  f.workflowDiff = true;
  await f.advance();
  assert.equal(f.store.failedUpdate(1, first.head.sha).outcome, 'failed:HTTP 503');
  assert.equal(f.store.activeMergeBatch().mutation.kind, 'update');
  first.labels.push({ name: 'hold' });
  f.restart();
  await f.advance();
  assert.deepEqual(f.updates, [1]); assert.equal(f.store.activeMergeBatch().members[0].pr, 1);
});

for (const change of ['rerequest', 'hold', 'human-veto', 'admission']) {
  test(`late ${change} before update sends no PUT and leaves no uncertain reservation`, async (t) => {
    const f = await fixture(t); const first = await f.add(1); await f.add(2);
    f.beforeUpdate = async () => {
      if (change === 'rerequest') f.scheduler.pendingEnqueues.add({ pr: 1, head_sha: first.head.sha });
      if (change === 'hold') first.labels.push({ name: 'hold' });
      if (change === 'human-veto') f.reviews.get(1).push({ id: 101, user: { id: 5, login: 'human', type: 'User' },
        state: 'CHANGES_REQUESTED', submitted_at: new Date().toISOString() });
      if (change === 'admission') f.scheduler.approval.admit = async () => false;
    };
    await assert.rejects(f.advance(), /publication_cancelled|merge_lane_changed|merge_batch_changed|approval_admission_failed/u);
    assert.deepEqual(f.updates, []); assert.deepEqual(f.merges, []);
    assert.equal(f.store.latestMergeBatchForPr(1).mutation, null);
    assert.equal(f.store.updateAttempt(1, first.head.sha, f.main), undefined);
    f.beforeUpdate = null;
    f.scheduler.pendingEnqueues.clear();
    first.labels = first.labels.filter((label) => label.name !== 'hold');
    f.scheduler.approval.admit = async () => true;
    if (change === 'human-veto') f.reviews.get(1).push({ id: 102, user: { id: 5, login: 'human', type: 'User' },
      state: 'DISMISSED', submitted_at: new Date(Date.now() + 1000).toISOString() });
    await f.advance();
    assert.deepEqual(f.updates, [1], 'a proven-unsent cancellation permits a fresh authorized retry');
  });
}

for (const bot of ['renovate', 'other']) {
  test(`a behind ${bot} branch cannot reserve the lane, but an already-current one may merge`, async (t) => {
    const f = await fixture(t);
    const owned = await f.add(1, { priority: 0 });
    owned.user = { id: 9, login: `${bot}[bot]`, type: 'Bot' };
    if (bot === 'renovate') owned.head.ref = 'renovate/dependency';
    await f.add(2);
    await f.advance();
    assert.deepEqual(f.updates, [2]); assert.equal(f.store.activeMergeBatch().members[0].pr, 2);
    // Finish that lane before considering another PR; external bot owns its own rebase.
    await f.approve(2); await f.advance(); await f.advance(); await f.advance();
    f.behind.set(1, 0);
    await f.advance();
    assert.deepEqual(f.merges, [2, 1]);
    assert.deepEqual(f.updates, [2]);
  });
}

for (const recoveryFailure of [false, true]) {
test(`stock transport preserves a strict stale-base rejection${recoveryFailure ? ' despite a recovery read outage' : ''} and releases its definite mutation`, async (t) => {
  const f = await fixture(t); const first = await f.add(1, { behind: 0 }); await f.add(2);
  const backend = f.scheduler.github.request;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const transport = new GitHubApp({ appId: REVIEW_APP_ID, privateKey: key, repo: REPOSITORY,
    fetchImpl: async (url, options) => {
      try {
        const result = await backend(options.method, new URL(url).pathname,
          options.body ? JSON.parse(options.body) : undefined, async () => {});
        return new Response(JSON.stringify(result));
      } catch (error) {
        const status = /HTTP (\d{3})/u.exec(error.message)?.[1];
        if (!status) throw error;
        return new Response('server rejected the mutation', { status: Number(status) });
      }
    } });
  transport.cachedToken = { token: 'local-only-fixture', expiresAt: Date.now() + 3600000 };
  f.scheduler.github.request = transport.request.bind(transport);
  f.beforeMerge = async () => { f.main = sha(200); f.behind.set(1, 1); f.recoveryFailure = recoveryFailure; };
  await assert.rejects(f.advance(), /HTTP 405/u);
  assert.deepEqual(f.merges, []);
  assert.equal(f.store.activeMergeBatch().mutation, null, 'a received rejection is not an uncertain PUT');
  first.labels.push({ name: 'hold' });
  f.beforeMerge = null;
  f.recoveryFailure = false;
  f.restart();
  await f.advance(); await f.advance();
  assert.deepEqual(f.updates, [2]);
  assert.equal(f.store.activeMergeBatch().members[0].pr, 2);
});
}

test('a crash before the update send fence leaves no reservation blocking restart', async (t) => {
  const f = await fixture(t); const pr = await f.add(1); await f.add(2);
  f.store.selectMergeBatch({ id: 'before-update-crash', generation: 1, kind: 'single', state: 'selected',
    selected_at: Date.now(), updated_at: Date.now(), target_pr: 1, needs_inspection: true,
    head_sha: pr.head.sha, base_sha: f.main, members: [{ pr: 1, head_sha: pr.head.sha,
      review_id: null, publication_id: null, github_review_id: null, pull_request_id: pr.node_id,
      ci_run_id: null, ci_attempt: null, priority: null, created_at: pr.created_at }] });
  const child = `
    import { Store } from ${JSON.stringify(new URL('./store.mjs', import.meta.url).href)};
    import { Shepherd } from ${JSON.stringify(new URL('./shepherd.mjs', import.meta.url).href)};
    const [path, encoded, mainSha] = process.argv.slice(1);
    const store = new Store(path);
    const shepherd = new Shepherd({ store, github: { repo: ${JSON.stringify(REPOSITORY)},
      request: async () => process.exit(0) } });
    await shepherd.updateBranch({ pr: JSON.parse(encoded), conflicting: false, behindBy: 1, mainSha, ready: true });
    process.exit(99);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', child, f.path, JSON.stringify(pr), f.main], { timeout: 5000 });
  f.restart();
  await f.advance();
  assert.deepEqual(f.updates, [1]);
  assert.equal(f.store.activeMergeBatch().members[0].pr, 1, 'restart resumes the selected PR instead of skipping to another');
});

test('a reservation write failure rolls back its lane journal before any update is sent', async (t) => {
  const f = await fixture(t); await f.add(1);
  f.store.run(`CREATE TRIGGER refuse_update_reservation BEFORE INSERT ON update_attempts
    BEGIN SELECT RAISE(ABORT, 'reservation refused'); END`);
  await assert.rejects(f.advance(), /reservation refused/u);
  assert.deepEqual(f.updates, []);
  assert.equal(f.store.activeMergeBatch().mutation, null);
  f.store.run('DROP TRIGGER refuse_update_reservation');
  f.restart();
  await f.advance();
  assert.deepEqual(f.updates, [1]);
});

function useStockTransport(f, { remaining = 5000, beforeMerge } = {}) {
  const request = f.scheduler.github.request, paginate = f.scheduler.github.paginate, graphql = f.scheduler.github.graphql;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const transport = new GitHubApp({ appId: REVIEW_APP_ID, privateKey: key, repo: REPOSITORY,
    fetchImpl: async (url, options) => {
      if (--remaining < 0) return new Response('API rate limit exceeded', {
        status: 403, headers: { 'x-ratelimit-remaining': '0' },
      });
      const path = new URL(url);
      let result;
      if (options.method === 'GET' && path.pathname.endsWith('/reviews')) result = await paginate(path.pathname + path.search);
      else if (options.method === 'GET' && path.pathname.endsWith('/check-suites')) result = { check_suites: await paginate(path.pathname + path.search) };
      else if (options.method === 'GET' && path.pathname.endsWith('/check-runs')) result = { check_runs: await paginate(path.pathname + path.search) };
      else if (options.method === 'GET' && path.pathname.endsWith('/jobs')) result = { jobs: await paginate(path.pathname + path.search) };
      else if (options.method === 'GET' && path.pathname.endsWith('/pulls')) result = await paginate(path.pathname + path.search);
      else if (options.method === 'POST' && path.pathname === '/graphql') {
        if (f.graphqlStatus) return new Response('GraphQL read refused', { status: f.graphqlStatus });
        const body = JSON.parse(options.body);
        result = { data: await graphql(body.query, body.variables, async () => {}) };
      }
      else result = await request(options.method, path.pathname,
        options.body ? JSON.parse(options.body) : undefined, async () => {});
      return new Response(JSON.stringify(result));
    } });
  transport.cachedToken = { token: 'local-only-fixture', expiresAt: Date.now() + 3600000 };
  f.scheduler.github.request = async (method, path, ...args) => {
    if (method === 'PUT' && path.endsWith('/merge')) await beforeMerge?.();
    return transport.request(method, path, ...args);
  };
  f.scheduler.github.paginate = transport.paginate.bind(transport);
  f.scheduler.github.graphql = transport.graphql.bind(transport);
}

test('a selected merge completes with a partially spent GitHub API budget through stock pagination and transport', async (t) => {
  const f = await fixture(t); await f.add(1, { behind: 0 }); await f.add(2);
  // Other reviews may have used 4,500 of the installation's 5,000 requests.
  useStockTransport(f, { remaining: 500 });
  await f.advance();
  assert.deepEqual(f.merges, [1]);
  assert.deepEqual(f.updates, []);
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
});

for (const change of ['rerequest', 'hold', 'human-veto', 'admission']) {
  test(`stock transport preserves late ${change} at the real merge fence`, async (t) => {
    const f = await fixture(t); const first = await f.add(1, { behind: 0 });
    let inject = true;
    useStockTransport(f, { beforeMerge: async () => {
      if (!inject) return;
      if (change === 'rerequest') f.scheduler.pendingEnqueues.add({ pr: 1, head_sha: first.head.sha });
      if (change === 'hold') first.labels.push({ name: 'hold' });
      if (change === 'human-veto') f.reviews.get(1).push({ id: 101, user: { id: 5, login: 'human', type: 'User' },
        state: 'CHANGES_REQUESTED', submitted_at: new Date().toISOString() });
      if (change === 'admission') f.scheduler.approval.admit = async () => false;
    } });
    await assert.rejects(f.advance(), /publication_cancelled|merge_lane_changed|merge_batch_changed|batch_member_authorization_changed|human_changes_requested|approval_admission_failed/u);
    assert.deepEqual(f.merges, []);
    assert.equal(f.store.latestMergeBatchForPr(1).mutation, null);
    inject = false;
    f.scheduler.pendingEnqueues.clear();
    first.labels = first.labels.filter((label) => label.name !== 'hold');
    f.scheduler.approval.admit = async () => true;
    if (change === 'human-veto') f.reviews.get(1).push({ id: 102, user: { id: 5, login: 'human', type: 'User' },
      state: 'DISMISSED', submitted_at: new Date(Date.now() + 1000).toISOString() });
    await f.advance();
    assert.deepEqual(f.merges, [1], 'the proven-unsent refusal still permits an authorized retry');
  });
}

test('the first N=1 native merge records the native GraphQL SHA through stock transport and releases the completed lane', async (t) => {
  const f = await fixture(t);
  f.nativeMergeSha = recordedSingleMerge.native_commit.sha;
  f.nativeTree = recordedSingleMerge.native_commit.commit.tree.sha;
  await f.add(101, { behind: 0, pull: recordedSingleMerge.rest_pull });
  useStockTransport(f);
  await f.advance();
  const publishing = f.store.activeMergeBatch();
  assert.equal(publishing.state, 'publishing');
  assert.equal(publishing.merged_sha, recordedSingleMerge.native_commit.sha);
  assert.notEqual(publishing.merged_sha, publishing.head_sha, 'the actual merge is not the tested source head');
  assert.equal(publishing.mutation, null);
  const merge = publishing.operations.find((operation) => operation.intent.kind === 'merge');
  assert.equal(merge.receipt.merge_sha, recordedSingleMerge.native_commit.sha);
  await f.advance();
  f.restart();
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal(f.store.latestMergeBatchForPr(101).state, 'merged');
  assert.deepEqual(f.scheduler.batchLane.failures(), []);
  assert.deepEqual(f.merges, [101], 'restart does not repeat the completed native merge');
});

test('a GraphQL receipt-read refusal after native merge preserves the merge intent through restart and recovery', async (t) => {
  const f = await fixture(t);
  f.nativeMergeSha = recordedSingleMerge.native_commit.sha;
  f.nativeTree = recordedSingleMerge.native_commit.commit.tree.sha;
  await f.add(101, { behind: 0, pull: recordedSingleMerge.rest_pull });
  f.graphqlStatus = 403;
  useStockTransport(f);
  await assert.rejects(f.advance(), /GitHub request failed: POST \/graphql HTTP 403/u);
  const pending = f.store.activeMergeBatch();
  assert.equal(pending.state, 'merging');
  assert.equal(pending.mutation?.kind, 'merge', 'a refused read is not rejection of the successful merge PUT');
  assert.deepEqual(f.merges, [101]);
  f.restart();
  f.graphqlStatus = null;
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  const completed = f.store.latestMergeBatchForPr(101);
  assert.equal(completed.state, 'merged');
  assert.equal(completed.merged_sha, recordedSingleMerge.native_commit.sha);
  assert.equal(completed.operations.find((op) => op.intent.kind === 'merge').receipt.outcome, 'merged');
  assert.deepEqual(f.merges, [101], 'recovery never sends a second merge');
});
