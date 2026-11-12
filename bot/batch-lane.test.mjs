import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from './store.mjs';
import { BatchLane } from './batch-lane.mjs';
import { Approval } from './approval.mjs';
import { Shepherd } from './shepherd.mjs';
import { mergeGate } from './merge-gate.mjs';
import { manifestDigest } from './batch-plan.mjs';
import { REPOSITORY, REVIEW_APP_ID, REVIEW_BOT } from './identity.mjs';
import { carrierBranch, carrierMarker } from './batch-author.mjs';
import { BatchMirror } from './batch-mirror.mjs';
import { createWebhookServer } from './server.mjs';
import { Scheduler } from './scheduler.mjs';
import { NativeCi } from './native-ci.mjs';
import { NATIVE_ADMISSION_CHECK, NATIVE_ADMISSION_JOB, NATIVE_DEFERRED_STEP } from './native-ci-protocol.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { Publisher } from './publish.mjs';
import { GitHubBudget, githubPriority } from './github-budget.mjs';
import { GitHubApp } from './github-app.mjs';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

const sha = (number) => number.toString(16).padStart(40, '0');
const recordedSingleMerge = JSON.parse(await readFile(new URL('./fixtures/native-single-merge-2026.json', import.meta.url), 'utf8'));
const recordedHealthTimeline = JSON.parse(await readFile(new URL('./fixtures/native-single-102-health-timeline.json', import.meta.url), 'utf8'));

// Native reads/writes are explicit and separate from the durable SQLite journal.
// The fake never reports indirect merge success until the test supplies it.
async function fixture(t, { carrierRef = 'integration/carrier', collectSeconds = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'batch-lane-'));
  const path = join(root, 'state.sqlite');
  const f = { path, store: new Store(path), main: sha(100), prs: new Map(), reviews: new Map(),
    ci: new Map(), behind: new Map(), mergeCommits: new Map(), requested: new Set(), vetoes: new Set(), merges: [], updates: [],
    closes: [], publications: [], proofReads: [], proofByHead: new Map(), ancestors: new Set([1, 2]),
    clock: 1000, timeout: false, blockPublication: false, signals: new Map(), jobs: new Map(), attemptJobs: new Map(), ciHistory: new Map(), reruns: [], nativeWrites: [] };
  t.after(async () => { f.store.close(); await rm(root, { recursive: true, force: true }); });
  const github = { repo: REPOSITORY, appId: REVIEW_APP_ID,
    async request(method, url, body, guard) {
      const number = Number(/\/pulls\/(\d+)/u.exec(url)?.[1]);
      const pr = f.prs.get(number);
      if (method === 'GET' && /\/actions\/runs\/\d+$/u.test(url)) {
        const run = [...f.ci.entries()].find(([, ci]) => ci.id === Number(url.split('/').at(-1)));
        return run ? { ...run[1], head_sha: run[0] } : null;
      }
      if (method === 'POST' && url.endsWith('/check-runs')) {
        await f.beforeAdmission?.();
        await guard?.('before_send');
        const check = { ...structuredClone(body), id: 10000 + f.signals.size, app: { id: REVIEW_APP_ID } };
        f.signals.set(check.id, check);
        f.nativeWrites.push({ kind: 'admit', head: check.head_sha });
        if (f.admissionTimeout) throw new Error('github_timeout');
        return structuredClone(check);
      }
      if (url.includes('/check-runs/')) {
        const check = f.signals.get(Number(url.split('/').at(-1)));
        if (method === 'GET') return structuredClone(check);
        if (method === 'PATCH') {
          await guard?.('before_send');
          Object.assign(check, structuredClone(body));
          f.nativeWrites.push({ kind: 'revoke', head: check.head_sha });
          if (f.revokeTimeout) throw new Error('github_timeout');
          return structuredClone(check);
        }
      }
      if (method === 'GET' && /\/pulls\/\d+$/u.test(url)) return structuredClone(pr);
      if (method === 'GET' && url.endsWith('/git/ref/heads/main')) return { object: { sha: f.main } };
      if (method === 'GET' && url.includes('/compare/main...')) {
        const head = url.split('...')[1].split('?')[0];
        const current = [...f.prs.values()].find((item) => item.head.sha === head);
        return { behind_by: f.behind.get(current.number), base_commit: { sha: f.main } };
      }
      if (method === 'GET' && url.includes('/commits/')) {
        const commit = url.split('/').at(-1);
        return { sha: commit, commit: { tree: { sha: f.commitTree ?? sha(900) } } };
      }
      if (method === 'GET' && url.endsWith('/rules/branches/main')) return [{ type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: true,
          required_status_checks: ['re-actors/alls-green', 'merge-gate', 'codex-review'].map((context) => ({ context, integration_id: REVIEW_APP_ID })) } }];
      if (method === 'PUT' && url.endsWith('/update-branch')) {
        await guard?.('before_send');
        f.updates.push(number);
        f.nativeWrites.push({ kind: 'update', head: pr.head.sha });
        assert.equal(body.expected_head_sha, pr.head.sha);
        pr.head.sha = sha(number + 1000);
        f.behind.set(number, 0);
        f.ci.set(pr.head.sha, { id: number + 1000, run_attempt: 1, status: 'in_progress', conclusion: null });
        return {};
      }
      if (method === 'PUT' && url.endsWith('/merge')) {
        await f.beforeSend?.();
        await guard('before_send');
        assert.equal(body.sha, pr.head.sha);
        assert.equal(body.merge_method, 'merge');
        f.merges.push(number);
        if (f.timeout) throw new Error('github_timeout');
        await f.afterFence?.();
        pr.state = 'closed'; pr.merged = true; pr.merged_by = { ...REVIEW_BOT };
        f.mergeCommits.set(number, sha(999)); f.main = sha(999);
        return { merged: true };
      }
      throw new Error(`unexpected ${method} ${url}`);
    },
    async paginate(url) {
      if (url.includes('/check-runs?')) return [...f.signals.values()].filter((check) => url.includes(check.head_sha)).map((check) => structuredClone(check));
      if (url.includes('/jobs')) {
        if (url.endsWith('/jobs?filter=latest')) return structuredClone(f.jobs.get(Number(/\/runs\/(\d+)\/jobs/u.exec(url)[1])) ?? []);
        const [, id, attempt] = /\/runs\/(\d+)\/attempts\/(\d+)\/jobs/u.exec(url);
        return structuredClone(f.attemptJobs.get(`${id}:${attempt}`) ?? f.jobs.get(Number(id)) ?? []);
      }
      if (url.includes('/reviews')) return structuredClone(f.reviews.get(Number(/\/pulls\/(\d+)/u.exec(url)[1])) ?? []);
      if (url.includes('/pulls?state=open')) return [...f.prs.values()].filter((pr) => pr.state === 'open').map((pr) => structuredClone(pr));
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
  const author = {
    async rerunCi(batch, ci, guard, { failedOnly = false } = {}) {
      await guard('before_send');
      f.reruns.push({ head: batch.head_sha, run: ci.id, failedOnly });
      if (f.rerunTimeout) throw new Error('github_timeout');
      f.attemptJobs.set(`${ci.id}:${ci.run_attempt}`, structuredClone(f.jobs.get(ci.id) ?? []));
      f.ci.set(batch.head_sha, { ...ci, run_attempt: ci.run_attempt + 1, status: 'in_progress', conclusion: null });
    },
    async closeCarrier(batch, guard) {
      await guard('before_send');
      f.closes.push(batch.target_pr);
      f.prs.get(batch.target_pr).state = 'closed';
      return structuredClone(f.prs.get(batch.target_pr));
    },
  };
  const mirror = {
    dependencies: async (_batch, members) => new Map(members.map((member) => [member.pr, []])),
    ancestry: async (batch, open) => ({ baseAncestors: new Set(),
      combinedAncestors: new Set(open.filter((member) => f.ancestors.has(member.pr)
        && batch.members.some((selected) => selected.pr === member.pr)).map((member) => member.pr)) }),
    discard: async () => {},
  };
  f.author = author;
  f.mirror = mirror;
  f.readProof = async ({ batch, expected }) => {
    f.proofReads.push({ target: batch.target_pr, base: batch.base_sha, head: batch.head_sha, expected });
    const proof = f.proofByHead.get(batch.head_sha);
    if (!proof || proof.base !== batch.base_sha) return { state: 'pending' };
    if (proof.red) return { state: 'red', run: { id: proof.run, conclusion: 'failure' } };
    return { state: 'green', receipt: { run_id: proof.run, attempt: 1,
      tree_sha: batch.tree_sha, artifact_id: proof.run, image_digest: `sha256:${'a'.repeat(64)}` } };
  };
  f.restart = () => {
    const approval = new Approval({ store: f.store, github, mode: 'approve', admit: async () => true });
    const shepherd = new Shepherd({ store: f.store, github });
    const host = { store: f.store, github, approval, shepherd, mode: 'approve', publisher: {},
      now: () => ++f.clock, log: () => {}, reconcileSoon: () => {},
      pendingRestart: () => false,
      hasPendingEnqueue: (row) => f.requested.has(row.pr),
      approvalCheckpoint(row) {
        if (f.requested.has(row.pr)) throw new Error('publication_cancelled');
        if (f.store.review(row.id)?.status !== 'completed') throw new Error('publication_cancelled');
      },
      latestCi: async (head) => f.ci.get(head),
      ciRuns: async (head) => f.ciHistory.get(head) ?? (f.ci.has(head) ? [{ ...f.ci.get(head), head_sha: head }] : []),
      async prepareReadiness(inspection) {
        const ready = await host.mergeReadiness(inspection);
        if (ready.row && await host.nativeCi.preparation(ready.ci) === 'deferred') return { ...ready, state: 'prepared', native: 'deferred' };
        return ready.state === 'ready' ? { ...ready, state: 'prepared', native: 'native' } : ready;
      },
      async mergeReadiness({ pr, behindBy }) {
        if (pr.state !== 'open' || pr.draft || !mergeGate(pr).pass || f.vetoes.has(pr.number)) return { state: 'blocked' };
        if (f.store.nativeCiFailure(pr.number, pr.head.sha)) return { state: 'blocked' };
        if (f.store.active(pr.number)) return { state: 'wait' };
        const row = f.store.latest(pr.number);
        if (!row || row.head_sha !== pr.head.sha) return { state: 'wait' };
        try { host.approvalCheckpoint(row); } catch { return { state: 'wait' }; }
        const ci = f.ci.get(pr.head.sha);
        if (!ci || ci.status !== 'completed') return { state: 'wait' };
        return { state: ci.conclusion === 'success' ? 'ready' : 'blocked', row, ci, behindBy, review: JSON.parse(row.result_json) };
      },
      async publishStatus(inspection) {
        if (f.blockPublication) return { pending: true };
        const batch = f.lane.statusBatch(inspection.pr.number);
        if (batch.member_proofs?.[inspection.pr.number]) f.publications.push(structuredClone(batch.member_proofs[inspection.pr.number]));
        return { comment_id: inspection.pr.number * 100 };
      },
    };
    f.host = host;
    host.nativeCi = new NativeCi(host);
    f.lane = new BatchLane({ host, author, mirror, maxSize: 3, collectSeconds, batchEnabled: true, readProof: f.readProof,
      selectionPaused: async () => Boolean(f.drain),
      confirmTree: async ({ batch, mergedSha }) => {
        assert.equal(mergedSha, sha(999));
        assert.equal(batch.tree_sha, sha(900));
        return { tree_sha: batch.tree_sha, merge_sha: mergedSha };
      } });
  };
  f.reopen = () => { f.store.close(); f.store = new Store(path); f.restart(); };
  f.add = (number, head = sha(number)) => {
    const pr = { ...structuredClone(recordedSingleMerge.rest_pull), number, node_id: `PR_${number}`,
      state: 'open', merged: false, merged_at: null, merged_by: null, draft: false, mergeable: true,
      labels: [], body: '', created_at: new Date(number * 1000).toISOString(),
      user: { id: 5, login: 'author', type: 'User' }, head: { sha: head, ref: `source-${number}`, repo: { full_name: REPOSITORY } },
      base: { ref: 'main', repo: { full_name: REPOSITORY } } };
    f.prs.set(number, pr); f.behind.set(number, 0); f.approve(number);
    return pr;
  };
  f.approve = (number) => {
    const pr = f.prs.get(number);
    const row = f.store.enqueue({ pr: number, head_sha: pr.head.sha, base_ref: 'main', due: 0, reason: 'opened' }, ++f.clock);
    f.store.update(row.id, { status: 'completed', result_json: JSON.stringify({
      review_route: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
      result: { pass: true, evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } },
      verdict: { decision: 'approve' } }) });
    f.store.reserveApproval({ ...row, publication_id: row.id }, pr.node_id, ++f.clock);
    f.store.updateApproval(row.id, { github_review_id: row.id * 100, outcome: 'approved' }, ++f.clock);
    f.reviews.set(number, [{ id: row.id * 100, user: { ...REVIEW_BOT, type: 'Bot' }, state: 'APPROVED', commit_id: pr.head.sha }]);
    f.ci.set(pr.head.sha, { id: row.id * 10, run_attempt: 1, status: 'completed', conclusion: 'success' });
    return row;
  };
  f.restart();
  f.add(1); f.add(2); f.add(90, sha(800));
  f.prs.get(90).head.ref = carrierRef;
  const members = [1, 2].map((number) => {
    const pr = f.prs.get(number), row = f.store.latest(number), approval = f.store.approvalForReview(row.id);
    return { pr: number, head_sha: pr.head.sha, review_id: row.id, publication_id: row.id,
      github_review_id: approval.github_review_id, pull_request_id: pr.node_id,
      ci_run_id: f.ci.get(pr.head.sha).id, ci_attempt: 1, priority: null, created_at: pr.created_at };
  });
  const record = { id: 'sealed-composition', generation: 1, kind: 'batch', state: 'testing',
    selected_at: ++f.clock, updated_at: f.clock, base_sha: f.main, head_sha: sha(800), tree_sha: sha(900),
    carrier_branch: carrierRef, target_pr: 90, target_node_id: 'PR_90', members, sealed: true };
  f.batch = f.store.selectMergeBatch({ ...record, manifest_digest: manifestDigest(record) });
  f.proofByHead.set(sha(800), { base: f.main, run: 500 });
  f.advance = () => f.lane.advance([...f.prs.values()].filter((pr) => pr.state === 'open'));
  f.nativeMembersMerged = () => { for (const number of [1, 2]) Object.assign(f.prs.get(number), { state: 'closed', merged: true }); };
  return f;
}

function transportMutation(f, method, path, remote = f.host.github.request.bind(f.host.github)) {
  let deferred = true;
  const app = new GitHubApp({ appId: REVIEW_APP_ID, repo: REPOSITORY, privateKey, now: () => f.clock,
    budget: { reserve() {
      assert.ok(f.store.activeMergeBatch().mutation, 'the durable intent precedes budget admission');
      if (deferred) throw Object.assign(new Error('local budget'), { code: 'github_budget_deferred', retryAt: f.clock + 10000 });
    }, settle() {} },
    fetchImpl: async (_url, options) => new Response(JSON.stringify(await remote(method, path,
      options.body && JSON.parse(options.body), async () => {}))) });
  app.cachedToken = { token: 'fixture-token', expiresAt: Infinity };
  const request = f.host.github.request.bind(f.host.github);
  f.host.github.request = (verb, target, ...args) => verb === method && target === path
    ? app.request(verb, target, ...args) : request(verb, target, ...args);
  return () => { deferred = false; };
}

async function collectingFixture(t, options = {}) {
  const f = await fixture(t, { collectSeconds: 180, ...options });
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', 2000);
  f.prs.delete(2); f.prs.delete(90);
  f.clock = 3000;
  f.host.now = () => f.clock;
  f.logs = [];
  f.host.log = (event) => f.logs.push(event);
  f.select = () => f.lane.select([...f.prs.values()]);
  return f;
}
test('essential discovery and selected fresh authority both use merge priority', async (t) => {
  const f = await collectingFixture(t, { collectSeconds: 0 });
  const calls = [];
  const inspect = f.host.shepherd.inspect.bind(f.host.shepherd);
  const prepare = f.host.prepareReadiness.bind(f.host);
  f.host.shepherd.inspect = async (...args) => {
    calls.push(['inspect', githubPriority(), Boolean(args[1]?.informational)]);
    return inspect(...args);
  };
  f.host.prepareReadiness = async (...args) => {
    calls.push(['readiness', githubPriority(), Boolean(args[1]?.informational)]);
    return prepare(...args);
  };
  assert.ok(await f.select());
  assert.deepEqual(calls, [
    ['inspect', 'merge', true], ['readiness', 'merge', true],
    ['inspect', 'merge', false], ['readiness', 'merge', false],
  ]);
});

test('selection budget deferral preserves hints, creates no journal and retries fresh authority', async (t) => {
  for (const changed of ['cancel', 'head', 'unchanged']) await t.test(changed, async (t) => {
    const f = await collectingFixture(t, { collectSeconds: 0 });
    const inspect = f.host.shepherd.inspect.bind(f.host.shepherd);
    const due = [];
    const calls = [];
    let deferred = true;
    f.host.reconcileSoon = (delay) => due.push(f.clock + delay);
    f.host.shepherd.inspect = async (...args) => {
      calls.push(githubPriority());
      if (!args[1]?.informational && deferred) throw Object.assign(new Error('GitHub API budget deferred'), {
        code: 'github_budget_deferred', retryAt: 9000,
      });
      return inspect(...args);
    };
    assert.equal(await f.select(), null);
    assert.equal(f.store.activeMergeBatch(), null);
    assert.deepEqual(due, [9000]);
    assert.deepEqual(f.merges, []);
    assert.deepEqual(f.nativeWrites, []);
    assert.equal(f.store.nativeCiFailure(1, sha(1)), null);
    const row = f.store.latest(1);
    assert.equal(row.status, 'completed');
    assert.equal(f.store.approvalForReview(row.id).outcome, 'approved');
    deferred = false;
    f.clock = 9000;
    if (changed === 'cancel') f.requested.add(1);
    if (changed === 'head') f.prs.get(1).head.sha = sha(500);
    const selected = await f.select();
    if (changed === 'unchanged') {
      assert.ok(selected);
      // The valid discovery hint survived; its final authority was not reused.
      assert.deepEqual(calls, ['merge', 'merge', 'merge']);
    } else assert.equal(selected, null);
    assert.deepEqual(f.merges, []);
    assert.deepEqual(f.nativeWrites, []);
  });
});

test('full reconciliation selects exact-approved work above both lower-priority budget ceilings', async (t) => {
  const f = await collectingFixture(t, { collectSeconds: 0 });
  f.add(2);
  f.store.updateApproval(f.store.latest(2).id, { github_review_id: null, outcome: 'failed:approval_interrupted' }, f.clock);
  f.reviews.delete(2);
  f.add(3);
  f.prs.get(3).head.sha = sha(503); // Approval exists only for the old head.
  for (const number of [1, 2]) {
    const row = f.store.latest(number);
    f.store.update(row.id, { result_json: JSON.stringify({ repo: REPOSITORY, pr: number, publication_id: row.id,
      head_sha: row.head_sha, base_sha: f.main, findings: [], suggestions: [], priorFindingIds: [],
      review_route: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
      result: { pass: true, reasons: [], evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } },
      verdict: { decision: 'approve' } }) });
  }
  const budget = new GitHubBudget({ store: f.store, scope: 'essential-selection', now: () => f.clock });
  for (const [priority, count] of [['presentation', 1150], ['review', 1763], ['merge', 468]]) {
    for (let i = 0; i < count; i++) budget.settle(budget.reserve(priority), { status: 200 });
  }
  assert.equal(budget.snapshot().total.primaryCharges, 3381);
  assert.throws(() => budget.reserve('presentation'), { code: 'github_budget_deferred' });
  assert.throws(() => budget.reserve('review'), { code: 'github_budget_deferred' });
  const calls = [];
  for (const method of ['request', 'paginate', 'graphql']) {
    const remote = f.host.github[method].bind(f.host.github);
    f.host.github[method] = async (...args) => {
      const priority = githubPriority() ?? 'review';
      const receipt = budget.reserve(priority);
      calls.push([priority, ...args.slice(0, 2)]);
      try { return await remote(...args); }
      finally { budget.settle(receipt, { status: 200 }); }
    };
  }
  const scheduler = new Scheduler({ store: f.store, github: f.host.github, shepherd: f.host.shepherd,
    publisher: new Publisher({ store: f.store, github: f.host.github }), approval: f.host.approval,
    mode: 'approve', mirror: { reviewModel: 'openai-codex/gpt-6.1-sol', reviewThinking: 'medium' },
    verdict: {}, now: () => f.clock });
  scheduler.reconcileCounts = { failed: 0, skipped: 0, deferred: 0 };
  scheduler.log = (entry) => f.logs.push(entry);
  scheduler.sweepSeen.set(1, { headSha: sha(1), dirty: false });
  const prepared = await scheduler.preparePresentation(f.prs.get(1));
  assert.equal(await scheduler.shepherdBefore(1, prepared.inspection, prepared.inspectionError), null);
  assert.equal(scheduler.reconcileCounts.failed, 0);
  assert.equal(scheduler.reconcileCounts.deferred, 1);
  assert.equal(scheduler.sweepSeen.get(1).dirty, true);
  assert.ok(scheduler.reconcileSoonAt > f.clock);
  assert.ok(f.logs.some((entry) => entry.status === 'DEFERRED' && entry.priority === 'presentation'
    && entry.reason === 'github_hourly_budget' && entry.retryAt > f.clock));
  assert.equal(calls.length, 0, 'denied presentation never dispatches');
  const dependencies = f.mirror.dependencies;
  f.mirror.dependencies = async (context, ready, open) => {
    assert.deepEqual(open.map((pr) => pr.pr), [1, 2, 3], 'closure retains unapproved open PRs');
    return dependencies(context, ready, open);
  };
  scheduler.batchLane = f.lane;
  await scheduler.reconcile();
  assert.equal(scheduler.lastReconcileCounts.failed, 0);
  assert.ok(f.logs.some((entry) => entry.event === 'merge_batch_selected'
    && JSON.stringify(entry.members) === '[1]'));
  assert.ok(calls.length > 0 && calls.every(([priority]) => priority === 'merge'));
  assert.ok(calls.every((call) => !/\/pulls\/[23](?:\/|$)/u.test(String(call[2] ?? call[1]))),
    'unapproved and old-head approvals never spend reserved candidate discovery');
  assert.throws(() => budget.reserve('presentation'), { code: 'github_budget_deferred' });
});

test('real durable budget defers ordinary status while active carrier retains merge reserve and fences', async (t) => {
  for (const changed of ['unchanged', 'cancel', 'head']) await t.test(changed, async (t) => {
    const f = await fixture(t);
    const budget = new GitHubBudget({ store: f.store, scope: `${REVIEW_APP_ID}:${REPOSITORY}`, now: () => f.clock,
      limits: { presentation: { charge: 1, wire: 1, floor: 0 }, review: { charge: 2, wire: 2, floor: 0 },
        merge: { charge: 200, wire: 200, floor: 0 } } });
    const background = budget.reserve('presentation');
    budget.settle(background, { status: 200, headers: {} });
    const priorities = [];
    for (const method of ['request', 'paginate', 'graphql']) {
      const original = f.host.github[method].bind(f.host.github);
      f.host.github[method] = async (...args) => {
        const priority = githubPriority();
        const receipt = budget.reserve(priority);
        priorities.push(priority);
        try {
          const result = await original(...args);
          budget.settle(receipt, { status: 200, headers: {} });
          return result;
        } catch (error) {
          budget.settle(receipt, { headers: {} });
          throw error;
        }
      };
    }
    const scheduler = new Scheduler({ store: f.store, github: f.host.github, shepherd: f.host.shepherd,
      publisher: {}, mirror: {}, verdict: {}, now: () => f.clock });
    await assert.rejects(scheduler.refreshStatus(1), { code: 'github_budget_deferred' });
    assert.equal(f.host.github.retryAt, undefined, 'local status pressure is not global GitHub backoff');
    assert.deepEqual(priorities, [], 'deferred presentation never dispatches');
    if (changed === 'cancel') f.requested.add(1);
    if (changed === 'head') f.prs.get(1).head.sha = sha(501);
    if (changed === 'cancel') await assert.rejects(f.advance(), /publication_cancelled/u);
    else if (changed === 'head') await assert.rejects(f.advance(), /batch_member_authorization_changed/u);
    else await f.advance();
    assert.ok(priorities.length > 0);
    assert.ok(priorities.every((priority) => priority === 'merge'));
    assert.deepEqual(f.merges, changed === 'unchanged' ? [90] : []);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.reruns, []);
    assert.equal(f.store.nativeCiFailure(1, sha(1)), null);
    assert.equal(f.store.latest(1).status, 'completed');
    await f.advance();
    assert.deepEqual(f.merges, changed === 'unchanged' ? [90] : [], 'retry never duplicates accepted merge');
  });
});

test('only the exact active sealed carrier head receives carrier review priority', async (t) => {
  const f = await fixture(t);
  const scheduler = new Scheduler({ store: f.store, github: f.host.github, publisher: {}, mirror: {}, verdict: {} });
  assert.equal(scheduler.reviewGitHubPriority({ pr: 90, head_sha: sha(800) }), 'merge');
  assert.equal(scheduler.reviewGitHubPriority({ pr: 90, head_sha: sha(801) }), 'review');
  assert.equal(scheduler.reviewGitHubPriority({ pr: 1, head_sha: sha(1) }), 'review');
  assert.equal(scheduler.reviewGitHubPriority({ pr: 500, head_sha: sha(800), reason: 'carrier', labels: ['merge'] }), 'review');
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  assert.equal(scheduler.reviewGitHubPriority({ pr: 90, head_sha: sha(800) }), 'review');
});

test('an unavailable candidate is excluded without blocking a healthy candidate', async (t) => {
  for (const step of ['inspection', 'readiness']) await t.test(step, async (t) => {
    const f = await collectingFixture(t, { collectSeconds: 0 });
    f.add(2);
    const inspect = f.host.shepherd.inspect.bind(f.host.shepherd);
    const prepare = f.host.prepareReadiness.bind(f.host);
    const failure = new Error('GitHub request failed: GET /commits/unavailable/check-suites HTTP 403');
    f.host.shepherd.inspect = async (number) => {
      if (step === 'inspection' && number === 1) throw failure;
      return inspect(number);
    };
    f.host.prepareReadiness = async (inspection) => {
      if (step === 'readiness' && inspection.pr.number === 1) throw failure;
      return prepare(inspection);
    };
    const selected = await f.select();
    assert.deepEqual(selected.members.map((member) => member.pr), [2]);
    assert.equal(f.store.approvalForReview(f.store.latest(1).id).outcome, 'approved');
    assert.ok(f.logs.some((row) => row.event === 'merge_candidate_failed' && row.pr === 1));
  });
});

for (const change of ['unrelated-head', 'unrelated-pr', 'selected-head', 'selected-pr', 'main', 'all', 'unscoped']) {
  test(`selected member final read fences ${change} invalidation without unrelated-head livelock`, async (t) => {
    const f = await collectingFixture(t, { collectSeconds: 0 });
    f.add(2);
    f.prs.get(2).draft = true;
    const inspect = f.host.shepherd.inspect.bind(f.host.shepherd);
    const request = f.host.github.request.bind(f.host.github);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let finalRead = false;
    let finalInspections = 0;
    f.host.shepherd.inspect = async (number, options) => {
      if (!options?.informational) {
        finalRead = true;
        finalInspections++;
      }
      return inspect(number, options);
    };
    f.host.github.request = async (method, path, ...args) => {
      const value = await request(method, path, ...args);
      if (finalRead && method === 'GET' && path.endsWith('/pulls/1')) {
        entered.resolve();
        await release.promise;
      }
      return value;
    };
    const selecting = f.select();
    await entered.promise;
    assert.equal(f.store.activeMergeBatch(), null, 'the member read precedes durable selection');
    // A check_run for head 2 must not revoke head 1's in-flight selection.
    // Conversely, selected-source and canonical-main invalidations must revoke
    // even an already returned green response for the selected source.
    const tags = {
      'unrelated-head': { headSha: sha(2) },
      'unrelated-pr': { pr: 2 },
      'selected-head': { headSha: sha(1) },
      'selected-pr': { pr: 1 },
      main: { main: true },
      all: { all: true },
      unscoped: {},
    }[change];
    f.lane.invalidateCandidates(tags);
    release.resolve();
    const selected = await selecting;
    assert.equal(finalInspections, 1, 'cached/discovered facts never replace the fresh selected read');
    if (change.startsWith('unrelated-')) {
      assert.deepEqual(selected.members.map(({ pr }) => pr), [1]);
      assert.equal(f.store.activeMergeBatch().id, selected.id);
      assert.equal(f.store.latestMergeBatchForPr(1).id, selected.id);
      assert.equal(f.logs.some(({ event }) => event === 'merge_candidate_revalidation_failed'), false);
    } else {
      assert.equal(selected, null);
      assert.equal(f.store.activeMergeBatch(), null);
      assert.equal(f.store.latestMergeBatchForPr(1).id, f.batch.id, 'no new selection journal was persisted');
      const failure = f.logs.find(({ event }) => event === 'merge_candidate_revalidation_failed');
      assert.equal(failure.fence_stage, 'selected_token_before_persistence');
      assert.equal(failure.pr, 1);
      assert.equal(failure.head_sha, sha(1));
      assert.deepEqual(failure.members, [{ pr: 1, head_sha: sha(1) }]);
    }
    assert.deepEqual(f.nativeWrites, [], 'selection never grants native admission itself');
    assert.deepEqual(f.merges, []);
  });
}

test('selected tokens remain fenced after the last approval checkpoint before persistence', async (t) => {
  const f = await collectingFixture(t, { collectSeconds: 0 });
  const checkpoint = f.host.approvalCheckpoint.bind(f.host);
  let finalRead = false;
  const inspect = f.host.shepherd.inspect.bind(f.host.shepherd);
  f.host.shepherd.inspect = async (number, options) => {
    if (!options?.informational) finalRead = true;
    return inspect(number, options);
  };
  let checkpoints = 0;
  f.host.approvalCheckpoint = (row) => {
    checkpoint(row);
    // Readiness and the explicit fresh approval checkpoint run first; the
    // local persisted-row checkpoint is the final synchronous authority read.
    if (finalRead && ++checkpoints === 3) f.lane.invalidateCandidates({ pr: 1 });
  };
  assert.equal(await f.select(), null);
  assert.equal(checkpoints, 3);
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal(f.store.latestMergeBatchForPr(1).id, f.batch.id);
  assert.equal(f.logs.find(({ event }) => event === 'merge_candidate_revalidation_failed').fence_stage,
    'selected_token_before_persistence');
  assert.deepEqual(f.nativeWrites, []);
});

test('a scoped invalidation during discovery excludes only that source, not an independent selection', async (t) => {
  const f = await collectingFixture(t, { collectSeconds: 0 });
  f.add(2);
  const inspect = f.host.shepherd.inspect.bind(f.host.shepherd);
  f.host.shepherd.inspect = async (number, options) => {
    const inspection = await inspect(number, options);
    if (number === 1 && options?.informational) f.lane.invalidateCandidates({ pr: 1 });
    return inspection;
  };
  const selected = await f.select();
  assert.deepEqual(selected.members.map(({ pr }) => pr), [2]);
  assert.equal(f.store.activeMergeBatch().id, selected.id);
  assert.deepEqual(f.nativeWrites, []);
});

test('collection holds a lone ready PR until max idle and readiness plus W, logging once', async (t) => {
  const f = await collectingFixture(t);
  f.ci.get(sha(1)).completed_at = new Date(4000).toISOString();
  useSchedulerReadiness(f);
  f.host.latestCi = Scheduler.prototype.latestCi.bind(f.host);
  f.clock = 5000;
  assert.equal(await f.select(), null);
  assert.equal(f.store.activeMergeBatch(), null);
  f.clock = 183999;
  assert.equal(await f.select(), null);
  assert.deepEqual(f.logs.filter(({ event }) => event === 'merge_batch_collecting'), [
    { event: 'merge_batch_collecting', members: [1], deadline: 184000 },
  ]);
  f.clock = 184000;
  assert.deepEqual((await f.select()).members.map(({ pr }) => pr), [1]);
});

test('collection wakes the real scheduler on the first deadline tick despite a five-minute lane interval', async (t) => {
  const f = await collectingFixture(t);
  f.clock = 1000000;
  f.ci.get(sha(1)).completed_at = new Date(f.clock).toISOString();
  const restartScheduler = () => {
    const scheduler = new Scheduler({ store: f.store, github: f.host.github, approval: f.host.approval,
      shepherd: f.host.shepherd, now: () => f.clock, mode: 'approve', log: f.host.log,
      batchMirror: f.mirror, batchEnabled: true, batchCollectSeconds: 180, reconcileIntervalMs: 300000 });
    scheduler.approvalCheckpoint = f.host.approvalCheckpoint;
    scheduler.ciRuns = f.host.ciRuns;
    // Review execution/status publication are outside this selection-clock owner.
    scheduler.shepherdBefore = (number) => scheduler.shepherd.inspect(number);
    scheduler.shepherdAfter = async () => {};
    scheduler.reconcileReview = async () => {};
    scheduler.advanceMergeLane = (open) => scheduler.batchLane.select(open);
    return scheduler;
  };
  let scheduler = restartScheduler();
  await scheduler.tick();
  assert.equal(f.store.activeMergeBatch(), null);
  f.clock = 1100000;
  await scheduler.reconcile(); // A full sweep clears its old wakeup before selecting again.
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal(scheduler.reconcileSoonAt, 1180000, 'full reconciliation re-arms the original deadline');
  f.clock = 1110000;
  scheduler = restartScheduler();
  await scheduler.tick(); // The first post-restart sweep must re-arm the same deadline.
  assert.equal(scheduler.reconcileSoonAt, 1180000, 'restart re-arms without extending the deadline');
  f.clock = 1175000;
  await scheduler.tick();
  assert.equal(f.store.activeMergeBatch(), null);
  f.clock = 1180000;
  await scheduler.tick();
  assert.equal(f.store.activeMergeBatch()?.selected_at, 1180000);
});

test('publication failures after writer retirement cannot extend collection', async (t) => {
  const f = await collectingFixture(t);
  Object.assign(f.prs.get(1), { state: 'closed', merged: true });
  f.add(3);
  f.store.updateMergeBatch(f.batch.id, 1, { state: 'publishing', merged_sha: sha(999),
    deploy_proof: { tree_sha: sha(900), merge_sha: sha(999) } });
  f.host.publishStatus = async () => { throw new Error('publication_unavailable'); };
  f.drain = true;
  await f.advance();
  f.drain = false;
  assert.equal(await f.select(), null);
  for (const now of [100000, 181999]) {
    f.clock = now;
    f.drain = true;
    await f.advance();
    f.drain = false;
    const historical = f.store.mergeBatch(f.batch.id, 1);
    assert.equal(historical.reason, 'publication_unavailable');
    assert.equal(historical.updated_at, now);
    assert.equal(await f.select(), null);
  }
  assert.deepEqual(f.logs.filter(({ event }) => event === 'merge_batch_collecting').map(({ deadline }) => deadline),
    [183003]);
  f.clock = 183003;
  assert.deepEqual((await f.select()).members.map(({ pr }) => pr), [3]);
  assert.throws(() => f.store.updateMergeBatch(f.batch.id, 1, { retired_at: 999999 }), /Immutable/u);
  f.store.retireMergeBatch(f.batch.id, 1, 'publishing', 999999);
  assert.equal(f.store.mergeBatch(f.batch.id, 1).retired_at, 2000);
});

test('collection admits a second PR ready within W into one two-member carrier', async (t) => {
  const f = await collectingFixture(t);
  assert.equal(await f.select(), null);
  f.clock = 90000; f.add(2);
  assert.equal(await f.select(), null);
  f.clock = 182000;
  const batch = await f.select();
  assert.equal(batch.kind, 'batch');
  assert.deepEqual(batch.members.map(({ pr }) => pr), [1, 2]);
});

test('priority zero bypasses collection', async (t) => {
  const f = await collectingFixture(t);
  f.prs.get(1).labels = [{ name: 'merge-priority:0' }];
  assert.equal((await f.select()).kind, 'single');
});

test('a full selection bypasses collection', async (t) => {
  const f = await collectingFixture(t);
  f.add(2); f.add(3);
  assert.equal((await f.select()).members.length, f.lane.maxSize);
});

test('forced-serial fallback bypasses collection', async (t) => {
  const f = await collectingFixture(t);
  f.store.updateMergeBatch(f.batch.id, 1, { state: 'fallback' });
  const batch = await f.select();
  assert.equal(batch.kind, 'single');
  assert.deepEqual(batch.fallback_of, { id: f.batch.id, generation: 1 });
});

test('reopening mid-collection preserves the durable deadline without extending or skipping it', async (t) => {
  const f = await collectingFixture(t);
  assert.equal(await f.select(), null);
  f.clock = 100000;
  f.reopen();
  f.host.now = () => f.clock;
  const logs = [];
  f.host.log = (event) => logs.push(event);
  assert.equal(await f.select(), null);
  assert.equal(logs.find(({ event }) => event === 'merge_batch_collecting').deadline, 182000);
  f.clock = 181999;
  assert.equal(await f.select(), null);
  f.clock = 182000;
  assert.equal((await f.select()).kind, 'single');
});

test('zero collection seconds preserves immediate underfilled selection', async (t) => {
  const f = await collectingFixture(t, { collectSeconds: 0 });
  assert.equal((await f.select()).kind, 'single');
  assert.deepEqual(f.logs.map(({ event }) => event), ['merge_batch_selected']);
});

function useSchedulerReadiness(f) {
  for (const name of ['sourceAuthorization', 'readinessCi', 'prepareReadiness', 'mergeReadiness']) {
    f.host[name] = Scheduler.prototype[name].bind(f.host);
  }
}

test('approved green BEHIND members form and merge a carrier without member refresh or CI rerun', async (t) => {
  const f = await collectingFixture(t, { collectSeconds: 0 });
  f.add(2);
  f.behind.set(1, 2); f.behind.set(2, 3);
  useSchedulerReadiness(f);
  const memberCi = [1, 2].map((pr) => structuredClone(f.ci.get(sha(pr))));
  let branch = null;
  f.mirror.assemble = async () => ({ head_sha: sha(801), tree_sha: sha(900), conflicts: [] });
  f.mirror.publish = async (batch, guard, record) => { await guard(); await record(); branch = batch.head_sha; };
  f.author.readBranch = async () => branch;
  f.author.createCarrier = async (batch, _body, guard) => {
    await guard('before_send');
    const pr = f.add(91, batch.head_sha);
    pr.head.ref = batch.carrier_branch;
    return pr;
  };
  await f.advance();
  const batch = f.store.activeMergeBatch();
  assert.equal(batch.kind, 'batch');
  assert.deepEqual(batch.members.map(({ pr }) => pr), [1, 2]);
  assert.equal(batch.target_pr, 91);
  await f.advance();
  assert.deepEqual(f.merges, [], 'no merge without carrier tree proof');
  f.proofByHead.set(sha(801), { base: f.main, run: 501 });
  await f.advance();
  assert.deepEqual(f.merges, [91]);
  assert.ok(f.proofReads.some(({ target, expected }) => target === 91 && expected));
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.reruns, []);
  assert.deepEqual([1, 2].map((pr) => f.ci.get(sha(pr))), memberCi);
  assert.deepEqual([1, 2].map((pr) => f.prs.get(pr).head.sha), [sha(1), sha(2)]);
});

test('non-updatable BEHIND source is carrier-only, never selected or refreshed alone', async (t) => {
  const f = await collectingFixture(t, { collectSeconds: 0 });
  f.prs.get(1).user = { id: 123, login: 'other[bot]', type: 'Bot' };
  f.behind.set(1, 2);
  useSchedulerReadiness(f);
  const inspection = await f.host.shepherd.inspect(1);
  assert.equal((await f.host.prepareReadiness(inspection)).carrierOnly, true);
  assert.equal((await f.host.mergeReadiness(inspection)).state, 'blocked');
  assert.equal(await f.select(), null);
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  f.add(2);
  const batch = await f.select();
  assert.equal(batch.kind, 'batch');
  assert.deepEqual(batch.members.map(({ pr }) => pr), [1, 2]);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.reruns, []);
});

for (const companionCarrierOnly of [false, true]) {
  test(`conflict reselection excludes carrier-only singletons (companion carrier-only=${companionCarrierOnly})`, async (t) => {
    const f = await collectingFixture(t, { collectSeconds: 0 });
    f.prs.get(1).user = { id: 123, login: 'other[bot]', type: 'Bot' };
    f.behind.set(1, 2);
    f.add(2);
    if (companionCarrierOnly) {
      f.prs.get(2).user = { id: 124, login: 'another[bot]', type: 'Bot' };
      f.behind.set(2, 1);
    }
    useSchedulerReadiness(f);
    let assemblies = 0;
    f.mirror.assemble = async (batch) => {
      assemblies++;
      assert.deepEqual(batch.members.map(({ pr }) => pr), [1, 2]);
      return { head_sha: sha(801), tree_sha: sha(900), conflicts: [{ pr: 2 }] };
    };
    const selected = await f.select();
    assert.equal(selected.kind, 'batch');
    await f.lane.advanceCarrier(selected);
    if (companionCarrierOnly) {
      assert.equal(f.store.activeMergeBatch(), null);
      assert.equal(f.store.mergeBatch(selected.id, selected.generation).state, 'invalidated');
      assert.equal(assemblies, 1);
      assert.deepEqual(f.merges, []);
      return;
    }
    const recovered = f.store.activeMergeBatch();
    assert.equal(recovered?.kind, 'single');
    assert.deepEqual(recovered.members.map(({ pr }) => pr), [2]);
    assert.equal(recovered.target_pr, 2);
    assert.equal(recovered.target_node_id, 'PR_2');
    assert.equal(recovered.head_sha, sha(2));
    f.proofByHead.set(sha(2), { base: f.main, run: 502 });
    await f.advance();
    assert.deepEqual(f.merges, [2]);
    await f.advance();
    await f.advance();
    assert.equal(f.store.activeMergeBatch(), null);
    assert.equal(assemblies, 1, 'the conflicting pair is not repeatedly selected');
    assert.deepEqual(f.updates, []);
  });
}

async function conflictMemoFixture(t) {
  const f = await collectingFixture(t, { collectSeconds: 0 });
  f.lane.maxSize = 2;
  f.add(2); f.add(3);
  f.ancestors.add(3);
  for (const number of [1, 2]) {
    f.prs.get(number).user = { id: 123 + number, login: `author-${number}[bot]`, type: 'Bot' };
    f.behind.set(number, 2);
  }
  useSchedulerReadiness(f);
  f.conflictingAssemblies = 0;
  f.mirror.assemble = async (batch) => {
    if (batch.members.some(({ pr }) => pr === 1) && batch.members.some(({ pr }) => pr === 2)) {
      f.conflictingAssemblies++;
      return { head_sha: sha(802), tree_sha: sha(900), conflicts: [{ pr: 2 }] };
    }
    return { head_sha: sha(801), tree_sha: sha(900), conflicts: [] };
  };
  let branch = null;
  f.mirror.publish = async (batch, guard, record) => { await guard(); await record(); branch = batch.head_sha; };
  f.author.readBranch = async () => branch;
  f.author.createCarrier = async (batch, _body, guard) => {
    await guard('before_send');
    const pr = f.add(91, batch.head_sha);
    pr.head.ref = batch.carrier_branch;
    return pr;
  };
  return f;
}

test('memoized carrier-only conflicts cannot capacity-starve a later ready PR', async (t) => {
  const f = await conflictMemoFixture(t);
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  await f.advance();
  const carrier = f.store.activeMergeBatch();
  assert.deepEqual(carrier?.members.map(({ pr }) => pr), [1, 3]);
  assert.ok(f.logs.some(({ event, reason, pr }) => event === 'merge_batch_deferred' && reason === 'known-conflict' && pr === 2));
  f.proofByHead.set(carrier.head_sha, { base: f.main, run: 503 });
  await f.advance();
  assert.deepEqual(f.merges, [91]);
  for (const number of [1, 3]) Object.assign(f.prs.get(number), { state: 'closed', merged: true });
  await f.advance();
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal(f.conflictingAssemblies, 1);
});

for (const change of ['main', 'head']) {
  test(`conflict memo retries an exact pair after ${change} changes`, async (t) => {
    const f = await conflictMemoFixture(t);
    await f.advance();
    assert.equal(f.conflictingAssemblies, 1);
    const compatible = await f.select();
    assert.deepEqual(compatible.members.map(({ pr }) => pr), [1, 3], 'unchanged pair remains excluded');
    f.store.retireMergeBatch(compatible.id, compatible.generation, 'fixture-setup', f.clock);
    if (change === 'main') f.main = sha(200);
    else { f.prs.get(2).head.sha = sha(22); f.approve(2); }
    await f.advance();
    assert.equal(f.conflictingAssemblies, 2);
  });
}

test('an earlier-ordered resolving descendant bypasses an untested conflict-memo prefix', async (t) => {
  const f = await conflictMemoFixture(t);
  await f.advance();
  assert.equal(f.conflictingAssemblies, 1);
  f.lane.maxSize = 3;
  f.prs.get(3).labels = [{ name: 'merge-priority:1' }];
  f.mirror.dependencies = async (_batch, members) => new Map(members.map(({ pr }) => [
    pr, pr === 3 ? [1, 2].map((number) => ({ pr: number, head_sha: sha(number) })) : [],
  ]));
  const selected = await f.select();
  assert.deepEqual(selected?.members.map(({ pr }) => pr), [3, 1, 2]);
  let assembled = false;
  f.mirror.assemble = async (batch) => {
    assert.deepEqual(batch.members.map(({ pr }) => pr), [3, 1, 2]);
    assembled = true;
    // C already contains the resolved A/B heads; assembly skips those ancestors.
    return { head_sha: sha(801), tree_sha: sha(900), conflicts: [] };
  };
  await f.lane.advanceCarrier(selected);
  assert.equal(assembled, true);
  assert.equal(f.store.activeMergeBatch().target_pr, 91);
  assert.equal(f.store.activeMergeBatch().state, 'testing');
  assert.equal(f.conflictingAssemblies, 1);
});

test('drain preserves a ready source without claiming a lane, and release admits it normally', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.prs.delete(2); f.prs.delete(90);
  f.drain = true;
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal(f.prs.get(1).state, 'open');
  assert.deepEqual(f.merges, []);
  f.drain = false;
  await f.advance();
  const selected = f.store.activeMergeBatch();
  assert.deepEqual(selected.members.map(({ pr, head_sha }) => ({ pr, head_sha })), [{ pr: 1, head_sha: sha(1) }]);
});

test('a drain requested during ancestry inspection prevents the subsequent journal claim', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.prs.delete(2); f.prs.delete(90);
  const dependencies = f.mirror.dependencies;
  f.mirror.dependencies = async (...args) => { f.drain = true; return dependencies(...args); };
  assert.equal(await f.lane.select([...f.prs.values()]), null);
  assert.equal(f.store.activeMergeBatch(), null);
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.updates, []);
});

test('pre-send readiness drift retires stale selection and schedules immediate fresh selection', async (t) => {
  const f = await fixture(t), wakes = [], logs = [];
  f.host.reconcileSoon = (delay) => wakes.push(delay);
  f.host.log = (entry) => logs.push(entry);
  f.beforeSend = async () => { f.vetoes.add(90); };
  await assert.rejects(f.advance(), /merge_batch_changed/);
  const stale = f.store.mergeBatch(f.batch.id, f.batch.generation);
  assert.equal(stale.state, 'invalidated');
  assert.equal(stale.mutation, null);
  assert.deepEqual(f.merges, []);
  assert.ok(wakes.includes(0));
  assert.deepEqual(logs.find((entry) => entry.event === 'merge_batch_failed').changes, ['authorization_blocked']);
  f.vetoes.clear(); f.prs.delete(2); f.prs.delete(90);
  const fresh = await f.lane.select([...f.prs.values()]);
  assert.notEqual(fresh.id, stale.id);
  assert.equal(fresh.members[0].review_id, f.store.latest(1).id);
});

test('dismissed native approval stays excluded before lane reads through ticks, metadata changes and restart', async (t) => {
  const f = await fixture(t);
  const member = f.batch.members[0];
  const approval = f.store.approvalForReview(member.review_id);
  f.reviews.get(1)[0].state = 'DISMISSED';
  await assert.rejects(f.advance(), /batch_member_approval_changed/u);
  const retired = f.store.mergeBatch(f.batch.id, f.batch.generation);
  assert.equal(retired.state, 'invalidated');
  assert.deepEqual(retired.rejected_approval, {
    pr: member.pr, head_sha: member.head_sha, review_id: member.review_id,
    publication_id: member.publication_id, github_review_id: member.github_review_id,
    pull_request_id: member.pull_request_id,
  });
  assert.deepEqual(retired.members, f.batch.members);
  assert.deepEqual(f.store.approvalForReview(member.review_id), approval);
  assert.deepEqual(f.merges, []);
  f.prs.delete(2); f.prs.delete(90);
  for (const change of ['tick', 'main', 'labels', 'receipt-timestamp', 'restart']) {
    if (change === 'main') f.main = sha(777);
    if (change === 'labels') f.prs.get(1).labels.push({ name: 'unrelated-label' });
    if (change === 'receipt-timestamp') f.store.updateApproval(member.publication_id, { outcome: 'approved' }, ++f.clock);
    if (change === 'restart') f.reopen();
    f.lane.invalidateCandidates({ all: true });
    const calls = [];
    const github = f.host.github;
    const request = github.request, paginate = github.paginate;
    github.request = async (...args) => { calls.push(args); return request(...args); };
    github.paginate = async (...args) => { calls.push(args); return paginate(...args); };
    try {
      assert.equal(await f.lane.select([...f.prs.values()]), null, change);
      await f.advance();
      assert.equal(f.store.activeMergeBatch(), null, change);
      assert.deepEqual(calls, [], `${change}: blocked authority costs no canonical-main or inspection reads`);
    } finally {
      github.request = request; github.paginate = paginate;
    }
  }
  assert.deepEqual(f.store.mergeBatch(f.batch.id, f.batch.generation), retired);
  assert.equal(f.store.approvalForReview(member.review_id).outcome, 'approved');
});

for (const state of ['missing', 'PENDING']) test(`${state} native review blocks merge without excluding the same ID later approved through restart`, async (t) => {
  const f = await fixture(t);
  const member = f.batch.members[0];
  const native = structuredClone(f.reviews.get(1)[0]);
  const approval = f.store.approvalForReview(member.review_id);
  f.reviews.set(1, state === 'missing' ? [] : [{ ...native, state }]);
  await assert.rejects(f.advance(), /batch_member_approval_changed/u);
  const retired = f.store.mergeBatch(f.batch.id, f.batch.generation);
  assert.equal(retired.state, 'invalidated');
  assert.equal(retired.rejected_approval, undefined);
  assert.equal(f.store.rejectedBatchApproval(member), false);
  assert.deepEqual(f.store.approvalForReview(member.review_id), approval);
  assert.deepEqual(f.merges, []);
  f.prs.delete(2); f.prs.delete(90);
  f.reopen();
  f.reviews.set(1, [native]);
  const selected = await f.lane.select([...f.prs.values()]);
  assert.deepEqual(selected.members.map(({ pr }) => pr), [1]);
  assert.equal(selected.members[0].review_id, member.review_id);
  assert.equal(selected.members[0].github_review_id, member.github_review_id);
  f.proofByHead.set(member.head_sha, { base: f.main, run: 701 });
  await f.advance();
  assert.deepEqual(f.merges, [1]);
  assert.deepEqual(f.store.mergeBatch(f.batch.id, f.batch.generation), retired);
});

for (const offending of [1, 2]) test(`native approval exclusion targets member ${offending}, allowing its peer to merge`, async (t) => {
  const f = await fixture(t);
  f.reviews.get(offending)[0].state = 'DISMISSED';
  await assert.rejects(f.advance(), /batch_member_approval_changed/u);
  const retired = f.store.mergeBatch(f.batch.id, f.batch.generation);
  assert.equal(retired.rejected_approval.pr, offending);
  const other = offending === 1 ? 2 : 1;
  f.proofByHead.set(sha(other), { base: f.main, run: 700 + other });
  const selected = await f.lane.select([...f.prs.values()]);
  assert.deepEqual(selected.members.map(({ pr }) => pr), [other]);
  await f.advance();
  assert.deepEqual(f.merges, [other]);
  assert.equal(f.store.approvalForReview(f.batch.members[offending - 1].review_id).outcome, 'approved');
});

for (const change of ['native-review', 'local-review', 'head']) test(`fresh ${change} authority releases only the new approval identity`, async (t) => {
  const f = await fixture(t);
  f.reviews.get(1)[0].state = 'DISMISSED';
  await assert.rejects(f.advance(), /batch_member_approval_changed/u);
  const retired = f.store.mergeBatch(f.batch.id, f.batch.generation);
  f.prs.delete(2); f.prs.delete(90);
  f.reopen();
  if (change === 'native-review') {
    const member = retired.members[0];
    f.store.updateApproval(member.publication_id, { github_review_id: 9876 }, ++f.clock);
    f.reviews.get(1).push({ id: 9876, user: { ...REVIEW_BOT, type: 'Bot' },
      state: 'APPROVED', commit_id: member.head_sha });
  } else {
    if (change === 'head') f.prs.get(1).head.sha = sha(444);
    f.approve(1);
  }
  const selected = await f.lane.select([...f.prs.values()]);
  assert.deepEqual(selected.members.map(({ pr }) => pr), [1]);
  assert.notDeepEqual(selected.members[0], retired.members[0]);
  await f.lane.fenceMembers(selected);
  assert.deepEqual(f.store.mergeBatch(f.batch.id, f.batch.generation), retired);
});

test('dismissal across an unresolved admitted merge neither records exclusion nor retires authority', async (t) => {
  const f = await fixture(t);
  f.timeout = true;
  await assert.rejects(f.advance(), /github_timeout/u);
  const pending = f.store.activeMergeBatch();
  const approval = f.store.approvalForReview(pending.members[1].review_id);
  f.reviews.get(2)[0].state = 'DISMISSED';
  f.reopen();
  await f.advance(); await f.advance();
  const current = f.store.activeMergeBatch();
  assert.deepEqual(current.mutation, pending.mutation);
  assert.deepEqual(current.operations, pending.operations);
  assert.equal(current.retired_at, null);
  assert.equal(current.rejected_approval, undefined);
  assert.equal(f.store.rejectedBatchApproval(pending.members[1]), false);
  await assert.rejects(f.lane.invalidate(current, 'batch_member_approval_changed', false, pending.members[1]),
    /batch_mutation_unresolved/u);
  assert.deepEqual(f.store.activeMergeBatch(), current);
  assert.deepEqual(f.store.approvalForReview(pending.members[1].review_id), approval);
  assert.deepEqual(f.closes, []);
  assert.deepEqual(f.merges, [90]);
});

for (const change of ['head', 'hold', 'veto', 'rerequest', 'main', 'carrier-head']) {
  test(`sealed carrier cannot merge after ${change} drift before the native send`, async (t) => {
    const f = await fixture(t);
    f.beforeSend = async () => {
      if (change === 'head') f.prs.get(2).head.sha = sha(222);
      if (change === 'hold') f.prs.get(2).labels.push({ name: 'hold' });
      if (change === 'veto') f.vetoes.add(2);
      if (change === 'rerequest') f.requested.add(2);
      if (change === 'main') f.main = sha(222);
      if (change === 'carrier-head') f.prs.get(90).head.sha = sha(222);
    };
    await assert.rejects(f.advance());
    assert.deepEqual(f.merges, []);
    assert.deepEqual(f.updates, []);
    const durable = f.store.mergeBatch(f.batch.id, f.batch.generation);
    assert.equal(durable.id, f.batch.id);
    assert.equal(durable.mutation, null, 'the rejected pre-send fence grants no uncertain native authority');
    assert.deepEqual(durable.members, f.batch.members);
    assert.equal(durable.head_sha, f.batch.head_sha);
  });
}

for (const change of ['main', 'carrier-head']) {
  test(`observed ${change} drift invalidates the sealed generation without updating it`, async (t) => {
    const f = await fixture(t);
    if (change === 'main') f.main = sha(222);
    else f.prs.get(90).head.sha = sha(222);
    await f.advance();
    assert.deepEqual(f.merges, []); assert.deepEqual(f.updates, []);
    assert.deepEqual(f.closes, [90]);
    assert.equal(f.store.activeMergeBatch(), null);
    const retired = f.store.mergeBatch(f.batch.id, f.batch.generation);
    assert.equal(retired.state, 'invalidated');
    assert.equal(retired.base_sha, f.batch.base_sha);
    assert.equal(retired.head_sha, f.batch.head_sha);
  });
}

test('a generic updater cannot replace a sealed carrier; a branch-name spoof is still an ordinary PR', async (t) => {
  const f = await fixture(t);
  f.behind.set(90, 1);
  await f.host.shepherd.updateBranch({ ...await f.host.shepherd.inspect(90), ready: true });
  assert.deepEqual(f.updates, []);
  assert.equal(f.prs.get(90).head.sha, f.batch.head_sha);
  assert.equal(f.store.activeMergeBatch().head_sha, f.batch.head_sha);
  const spoof = f.add(91);
  spoof.head.ref = f.batch.carrier_branch;
  f.behind.set(91, 1);
  await f.host.shepherd.updateBranch({ ...await f.host.shepherd.inspect(91), ready: true });
  assert.deepEqual(f.updates, [91], 'only the authoritative stored carrier identity is protected');
});

test('an uncertain native merge remains the sole authority through restart, drain, hold, red CI and main drift', async (t) => {
  const f = await fixture(t);
  f.timeout = true;
  await assert.rejects(f.advance(), /github_timeout/u);
  const intent = f.store.activeMergeBatch().mutation;
  assert.equal(intent.kind, 'merge');
  assert.equal(intent.head_sha, f.batch.head_sha);
  f.drain = true;
  f.prs.get(1).labels.push({ name: 'hold' });
  f.ci.get(f.batch.head_sha).conclusion = 'failure';
  f.main = sha(101);
  f.reopen();
  await f.advance(); await f.advance();
  assert.deepEqual(f.store.activeMergeBatch().mutation, intent);
  assert.deepEqual(f.merges, [90], 'never repeat the unresolved native PUT');
  assert.deepEqual(f.updates, []); assert.deepEqual(f.closes, []);
  f.timeout = false;
  Object.assign(f.prs.get(90), { state: 'closed', merged: true, merged_by: { ...REVIEW_BOT } });
  f.mergeCommits.set(90, sha(999));
  f.nativeMembersMerged();
  await f.advance();
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'merged');
  assert.deepEqual(f.merges, [90]);
});

test('composition failure falls back serially, refusing both combined proof and an old-base singleton proof', async (t) => {
  const f = await fixture(t);
  f.proofByHead.set(f.batch.head_sha, { base: f.batch.base_sha, run: 500, red: true });
  await f.advance();
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'fallback');
  assert.deepEqual(f.closes, [90]);
  assert.deepEqual(f.merges, []);
  f.main = sha(200);
  f.behind.set(1, 1); f.behind.set(2, 1);
  f.proofByHead.set(sha(1), { base: f.batch.base_sha, run: 10 });
  await f.advance();
  assert.equal(f.store.activeMergeBatch().kind, 'single');
  assert.deepEqual(f.store.activeMergeBatch().members.map((member) => member.pr), [1]);
  assert.deepEqual(f.updates, [1]); assert.deepEqual(f.merges, []);
  f.approve(1);
  await f.advance();
  assert.deepEqual(f.merges, [], 'green source CI is insufficient without a fresh exact-tree current-base receipt');
  const current = f.store.activeMergeBatch();
  f.proofByHead.set(current.head_sha, { base: f.batch.base_sha, run: 501 });
  await f.advance(); assert.deepEqual(f.merges, [], 'old base proof cannot authorize fallback');
  f.proofByHead.set(current.head_sha, { base: current.base_sha, run: 502 });
  await f.advance();
  assert.deepEqual(f.merges, [1]);
  assert.equal(f.store.activeMergeBatch().ci.run_id, 502);
  assert.notEqual(f.store.activeMergeBatch().ci.run_id, 500);
  await f.advance();
  assert.deepEqual(f.store.mergeBatch(f.batch.id, 1).fallback_done, [1]);
  await f.advance();
  assert.equal(f.store.activeMergeBatch().kind, 'single');
  assert.deepEqual(f.store.activeMergeBatch().members.map((member) => member.pr), [2]);
  assert.deepEqual(f.updates, [1, 2]);
  f.approve(2);
  f.proofByHead.set(f.prs.get(2).head.sha, { base: current.base_sha, run: 503 });
  await f.advance();
  assert.deepEqual(f.merges, [1], 'the preceding singleton merge invalidates every remaining old-base proof');
  const second = f.store.activeMergeBatch();
  f.proofByHead.set(second.head_sha, { base: second.base_sha, run: 504 });
  await f.advance(); await f.advance();
  assert.deepEqual(f.merges, [1, 2]);
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'fallback-completed');
});

test('source advancement after the final fence publishes only the pinned version actually applied', async (t) => {
  const f = await fixture(t);
  f.afterFence = async () => {
    f.prs.get(1).head.sha = sha(111);
    Object.assign(f.prs.get(2), { state: 'closed', merged: true });
  };
  await f.advance(); await f.advance();
  const completed = f.store.mergeBatch(f.batch.id, 1);
  assert.equal(completed.state, 'merged');
  assert.deepEqual(f.merges, [90]);
  assert.equal(f.prs.get(1).state, 'open');
  assert.equal(completed.member_results[1].outcome, 'pinned_applied_source_advanced');
  assert.equal(completed.member_results[1].pinned_head, sha(1));
  assert.equal(completed.member_results[1].observed_head, sha(111));
  assert.equal(completed.member_results[1].native_merged, false);
  assert.equal(completed.member_results[2].outcome, 'merged_via_batch');
  assert.deepEqual(f.publications.map((receipt) => receipt.outcome), ['pinned_applied_source_advanced', 'merged_via_batch']);
});

test('restart after main merged resumes publication without another merge or invented indirect status', async (t) => {
  const f = await fixture(t);
  f.blockPublication = true;
  f.drain = true;
  await f.advance();
  assert.equal(f.store.activeMergeBatch().state, 'publishing');
  assert.deepEqual(f.merges, [90]);
  f.reopen();
  await f.advance();
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'publishing');
  assert.equal(f.store.activeMergeBatch(), null, 'confirmed main/deploy proof releases the writer while native source visibility remains pending');
  assert.deepEqual(f.publications, [], 'open originals are not yet confirmed indirectly merged');
  assert.deepEqual(f.merges, [90]);
  f.nativeMembersMerged();
  await f.advance();
  assert.deepEqual(f.store.mergeBatch(f.batch.id, 1).member_results, {});
  f.blockPublication = false;
  f.reopen();
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'merged');
  assert.deepEqual(f.merges, [90]);
  assert.deepEqual(f.publications.map((receipt) => receipt.outcome), ['merged_via_batch', 'merged_via_batch']);
});

test('a persisted send intent with an already-merged native target is adopted after process loss', async (t) => {
  const f = await fixture(t);
  f.store.beginBatchMutation(f.batch.id, 1, {
    id: 'merge-before-process-loss', kind: 'merge', head_sha: f.batch.head_sha,
    main_sha: f.batch.base_sha, target_pr: 90, tree_sha: f.batch.tree_sha,
    manifest_digest: f.batch.manifest_digest, marker: null,
  }, ++f.clock);
  // Remote merge succeeded; the process died before any local receipt was written.
  Object.assign(f.prs.get(90), { state: 'closed', merged: true, merged_by: { ...REVIEW_BOT } });
  f.mergeCommits.set(90, sha(999));
  f.main = sha(999);
  f.blockPublication = true;
  f.reopen();
  await f.advance();
  assert.deepEqual(f.merges, [], 'recovery never sends the native merge again');
  const recovered = f.store.mergeBatch(f.batch.id, 1);
  assert.equal(recovered.mutation, null);
  assert.equal(recovered.state, 'publishing');
  assert.equal(recovered.merged_sha, sha(999));
  assert.equal(recovered.operations.length, 1);
  assert.equal(recovered.operations[0].intent.id, 'merge-before-process-loss');
  assert.equal(recovered.operations[0].receipt.outcome, 'merged');
  assert.deepEqual(recovered.member_results, {});
  f.nativeMembersMerged();
  f.blockPublication = false;
  f.reopen();
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  assert.deepEqual(f.merges, []);
  const completed = f.store.mergeBatch(f.batch.id, 1);
  assert.equal(completed.state, 'merged');
  assert.equal(completed.member_results[1].outcome, 'merged_via_batch');
  assert.equal(completed.member_results[2].outcome, 'merged_via_batch');
});

test('a failed publishing-state commit retains the successful native merge intent for recovery', async (t) => {
  const f = await fixture(t);
  f.store.run(`CREATE TRIGGER refuse_publishing BEFORE UPDATE ON merge_batches
    WHEN json_extract(NEW.record_json,'$.state')='publishing'
    BEGIN SELECT RAISE(ABORT,'publishing transition refused'); END`);
  await assert.rejects(f.advance(), /publishing transition refused/u);
  assert.deepEqual(f.merges, [90]);
  assert.equal(f.store.activeMergeBatch().mutation.kind, 'merge');
  assert.equal(f.store.activeMergeBatch().merged_sha, null);
  f.store.run('DROP TRIGGER refuse_publishing');
  f.nativeMembersMerged();
  f.reopen();
  await f.advance();
  assert.deepEqual(f.merges, [90], 'the already-applied merge is never sent twice');
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'merged');
  assert.equal(f.store.mergeBatch(f.batch.id, 1).member_results[1].outcome, 'merged_via_batch');
});

test('carrier creation receipt and native PR identity survive a failed transition atomically', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'replaced-for-creation-probe', ++f.clock);
  const record = { ...f.batch, generation: 2, target_pr: null, target_node_id: null, state: 'assembling',
    selected_at: ++f.clock, updated_at: f.clock };
  record.carrier_branch = carrierBranch(record);
  record.manifest_digest = manifestDigest(record);
  const batch = f.store.selectMergeBatch(record);
  const created = { ...structuredClone(f.prs.get(90)), number: 91, node_id: 'PR_91' };
  created.head.ref = batch.carrier_branch;
  f.prs.set(91, created); f.behind.set(91, 0);
  f.author.findCarrier = async () => structuredClone(created);
  let duplicatePosts = 0;
  f.author.createCarrier = async () => { duplicatePosts++; throw new Error('duplicate carrier POST'); };
  f.store.beginBatchMutation(batch.id, 2, { id: 'lost-create-response', kind: 'create_carrier',
    head_sha: batch.head_sha, main_sha: batch.base_sha, marker: carrierMarker(batch) }, ++f.clock);
  f.store.run(`CREATE TRIGGER refuse_target BEFORE UPDATE ON merge_batches
    WHEN json_extract(NEW.record_json,'$.target_pr')=91
    BEGIN SELECT RAISE(ABORT,'target transition refused'); END`);
  await assert.rejects(f.advance(), /target transition refused/u);
  assert.equal(f.store.activeMergeBatch().mutation.kind, 'create_carrier');
  assert.equal(f.store.activeMergeBatch().target_pr, null);
  f.store.run('DROP TRIGGER refuse_target');
  f.reopen();
  await f.advance();
  assert.equal(duplicatePosts, 0);
  assert.equal(f.store.activeMergeBatch().target_pr, 91);
  assert.equal(f.store.activeMergeBatch().target_node_id, 'PR_91');
  assert.equal(f.store.activeMergeBatch().mutation, null);
  assert.deepEqual(f.merges, [], 'source approvals do not substitute for a fresh carrier review');
});

test('confirmed main proof releases the writer while an unrelated source receipt remains uncertain', async (t) => {
  const f = await fixture(t);
  await f.advance();
  await f.advance(); // Main/CI tree proof is conclusive; indirect originals still look open.
  assert.equal(f.store.activeMergeBatch(), null);
  const old = f.store.mergeBatch(f.batch.id, 1);
  f.store.beginBatchMutation(old.id, 1, { id: 'lost-source-comment', kind: 'comment',
    head_sha: old.head_sha, main_sha: old.base_sha, marker: 'source-receipt-marker',
    comment_pr: 1, method: 'POST', comment_id: null, body_sha256: 'a'.repeat(64) }, ++f.clock);
  f.blockPublication = true;
  f.prs.get(1).head.sha = sha(111);
  f.approve(1); // Even this newly approved version cannot race its unfinished old receipt.
  f.add(3);
  f.behind.set(3, 1);
  await f.advance();
  assert.deepEqual(f.merges, [90]);
  assert.deepEqual(f.updates, [3]);
  assert.equal(f.store.activeMergeBatch().target_pr, 3);
  assert.equal(f.store.mergeBatch(old.id, 1).mutation.id, 'lost-source-comment');
  assert.equal(f.store.mergeBatch(old.id, 1).member_results[1], undefined);
});

test('same-base composition fallback reruns CI and requires a new review instead of reusing source green', async (t) => {
  const f = await fixture(t);
  const original = f.batch.members[0];
  f.proofByHead.get(f.batch.head_sha).red = true;
  await f.advance();
  const reruns = [];
  f.author.rerunCi = async (batch, expected, guard) => {
    await guard('before_send');
    assert.equal(f.store.activeMergeBatch().mutation.kind, 'ci_rerun');
    reruns.push(expected.id);
    f.ci.set(batch.head_sha, { ...f.ci.get(batch.head_sha), run_attempt: 2, status: 'in_progress', conclusion: null });
  };
  const request = f.host.github.request.bind(f.host.github);
  f.host.github.request = async (method, path, ...args) => {
    if (method === 'GET' && path.endsWith(`/actions/runs/${original.ci_run_id}`)) {
      return { ...f.ci.get(original.head_sha), head_sha: original.head_sha };
    }
    return request(method, path, ...args);
  };
  f.host.enqueue = async (operation) => f.store.enqueue(operation, ++f.clock);
  await f.advance();
  assert.deepEqual(reruns, [original.ci_run_id]);
  assert.deepEqual(f.merges, []);
  assert.equal(f.store.activeMergeBatch().mutation.kind, 'ci_rerun');
  await f.advance();
  assert.deepEqual(reruns, [original.ci_run_id], 'an accepted or uncertain rerun is never blindly repeated');
  assert.deepEqual(f.merges, []);
  const running = f.store.activeMergeBatch();
  assert.equal(running.mutation, null);
  f.clock = running.selection_wait.since + 60 * 60 * 1000;
  await f.advance();
  assert.equal(f.store.activeMergeBatch()?.id, running.id);
  assert.equal(f.store.activeMergeBatch().selected_at, running.selected_at);
  f.ci.get(original.head_sha).status = 'completed';
  f.ci.get(original.head_sha).conclusion = 'success';
  await f.advance();
  const review = f.store.active(1);
  assert.ok(review.id > original.review_id);
  assert.equal(review.head_sha, original.head_sha);
  assert.equal(review.reason, 'batch_fallback');
  assert.deepEqual(f.merges, [], 'fresh CI alone cannot reuse the pre-composition review');
});

test('a failed singleton generation replacement preserves the selected source through restart', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  const single = { ...f.batch, generation: 2, kind: 'single', state: 'selected', sealed: false,
    target_pr: 1, target_node_id: 'PR_1', head_sha: sha(1), carrier_branch: null, manifest_digest: null,
    members: [f.batch.members[0]], selected_at: ++f.clock, updated_at: f.clock };
  f.store.selectMergeBatch(single);
  f.prs.get(1).head.sha = sha(111);
  f.store.run(`CREATE TRIGGER refuse_replacement BEFORE INSERT ON merge_batches WHEN NEW.generation=3
    BEGIN SELECT RAISE(ABORT,'generation transition refused'); END`);
  await assert.rejects(f.advance(), /generation transition refused/u);
  assert.equal(f.store.activeMergeBatch().generation, 2);
  assert.equal(f.store.activeMergeBatch().target_pr, 1);
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.updates, []);
  f.store.run('DROP TRIGGER refuse_replacement');
  f.reopen();
  await f.advance();
  assert.equal(f.store.activeMergeBatch().generation, 3);
  assert.equal(f.store.activeMergeBatch().target_pr, 1);
  assert.equal(f.store.activeMergeBatch().members[0].head_sha, sha(111));
  assert.equal(f.store.activeMergeBatch().members[0].review_id, null, 'replacement inherits no authorization');
});

for (const provenance of ['carried', 'different-source-head']) {
  test(`serial isolation rejects renumbered reviewer evidence with ${provenance} provenance`, async (t) => {
    const f = await fixture(t);
    const original = f.batch.members[0];
    f.proofByHead.get(f.batch.head_sha).red = true;
    await f.advance();
    f.main = sha(200);
    f.behind.set(1, 1); f.behind.set(2, 1);
    await f.advance();
    assert.deepEqual(f.updates, [1]);
    const row = f.approve(1);
    const review = JSON.parse(f.store.review(row.id).result_json);
    review.head_sha = row.head_sha;
    review.source_review_head = original.head_sha;
    if (provenance === 'carried') review.carried_forward_from = original.head_sha;
    f.store.update(row.id, { result_json: JSON.stringify(review) });
    f.proofByHead.set(row.head_sha, { base: f.main, run: 501 });
    f.host.enqueue = async (operation) => f.store.enqueue(operation, ++f.clock);
    await f.advance();
    assert.deepEqual(f.merges, [], 'new row/native approval plus current-base CI cannot replace actual fresh reviewer execution');
    const fresh = f.store.active(1);
    assert.ok(fresh.id > row.id);
    assert.equal(fresh.head_sha, row.head_sha);
    assert.equal(fresh.reason, 'batch_fallback');
    await f.advance();
    assert.equal(f.store.active(1).id, fresh.id, 'pending fresh execution is not repeatedly enqueued');
    assert.deepEqual(f.merges, []);
  });
}

test('singleton refresh deletes only retired generation scratch after the replacement transaction commits', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  const old = { ...f.batch, generation: 2, kind: 'single', state: 'selected', sealed: false,
    target_pr: 1, target_node_id: 'PR_1', head_sha: sha(1), carrier_branch: null, manifest_digest: null,
    members: [f.batch.members[0]], selected_at: ++f.clock, updated_at: f.clock };
  f.store.selectMergeBatch(old);
  const disk = new BatchMirror({ author: {}, root: join(dirname(f.path), 'mirrors') });
  const oldDirectory = disk.directory(old);
  const replacementDirectory = disk.directory({ ...old, generation: 3 });
  await mkdir(oldDirectory, { recursive: true });
  await mkdir(replacementDirectory, { recursive: true });
  await writeFile(join(oldDirectory, 'object-witness'), 'retired objects');
  await writeFile(join(replacementDirectory, 'object-witness'), 'replacement objects');
  f.mirror.discard = async (retired) => {
    assert.equal(f.store.activeMergeBatch().generation, 3, 'replacement is already durable before filesystem cleanup');
    return disk.discard(retired);
  };
  f.prs.get(1).head.sha = sha(111);
  await f.advance();
  await assert.rejects(stat(oldDirectory), { code: 'ENOENT' });
  assert.equal(await readFile(join(replacementDirectory, 'object-witness'), 'utf8'), 'replacement objects');
  assert.equal(f.store.mergeBatch(old.id, 2).state, 'refreshed');
  assert.equal(f.store.mergeBatch(old.id, 2).members[0].head_sha, sha(1));
  assert.equal(f.store.activeMergeBatch().members[0].head_sha, sha(111));
});

test('the recorded production gen-2 merging singleton recovers its native SHA without repeating or clearing the intent', async (t) => {
  const f = await fixture(t);
  const recorded = recordedSingleMerge.journal;
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  // Restore the persisted row exactly as exported, including its existing
  // comment receipt and unresolved merge intent. This is not a new admission.
  f.store.run('INSERT INTO merge_batches(id,generation,record_json) VALUES(?,?,?)',
    recorded.id, recorded.generation, JSON.stringify(recorded));
  f.store.run('INSERT INTO active_merge_batch(slot,id,generation) VALUES(1,?,?)', recorded.id, recorded.generation);
  const nativePull = structuredClone(recordedSingleMerge.rest_pull);
  // bot/test.env uses different numeric principals; preserve the native
  // response shape while binding its merge actor to this isolated test App.
  nativePull.merged_by = { ...nativePull.merged_by, ...REVIEW_BOT };
  f.prs.set(recorded.target_pr, nativePull);
  f.reopen();
  const request = f.host.github.request.bind(f.host.github);
  f.host.github.request = async (method, path, ...args) => {
    if (method === 'GET' && path.includes('/commits/')) {
      const selected = path.split('/').at(-1);
      if (!/^[0-9a-f]{40}$/u.test(selected)) throw new Error(`GitHub request failed: GET ${path} HTTP 422`);
      assert.equal(selected, recordedSingleMerge.native_commit.sha);
      return structuredClone(recordedSingleMerge.native_commit);
    }
    return request(method, path, ...args);
  };
  let nativeReceipt = structuredClone(recordedSingleMerge.graphql);
  nativeReceipt.repository.pullRequest.mergeCommit = null;
  f.host.github.graphql = async (_query, variables, guard) => {
    assert.equal(variables.number, recorded.target_pr);
    await guard?.();
    return structuredClone(nativeReceipt);
  };
  await assert.rejects(f.lane.reconcileMutation(f.store.activeMergeBatch()), /batch_merged_identity_mismatch/u);
  assert.deepEqual(f.store.activeMergeBatch().mutation, recorded.mutation, 'an unavailable native SHA never settles the intent');
  nativeReceipt = structuredClone(recordedSingleMerge.graphql);
  await f.lane.reconcileMutation(f.store.activeMergeBatch());
  const recovered = f.store.activeMergeBatch();
  assert.equal(recovered.state, 'publishing');
  assert.equal(recovered.merged_sha, recordedSingleMerge.native_commit.sha);
  assert.equal(recovered.mutation, null);
  assert.deepEqual(recovered.operations[0], recorded.operations[0]);
  assert.equal(recovered.operations[1].intent.id, recorded.mutation.id);
  assert.equal(recovered.operations[1].receipt.merge_sha, recordedSingleMerge.native_commit.sha);
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.closes, []);
});

async function httpHealth(f) {
  const server = createWebhookServer({
    store: f.store,
    scheduler: { batchLane: f.lane, lastTickCompletedAt: f.clock, lastReconcileOkAt: f.clock },
    secret: 'fixture-health-webhook', mode: 'approve', now: () => f.clock,
    fetchImpl: async () => ({ ok: true }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the recorded 102 live-work timeline is healthy before and after the writer is released', async (t) => {
  for (const observed of recordedHealthTimeline.observations) {
    await t.test(observed.at, async (t) => {
      const f = await fixture(t);
      f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
      f.clock = Date.parse(observed.at);
      const summary = observed.lane ?? observed.failures[0];
      if (summary) {
        const head = observed.lane?.members[0].head_sha ?? recordedHealthTimeline.final_head;
        // The capture is a projected HTTP observation, not a full authorization
        // journal. Unknown review/CI authority stays null and is never exercised.
        let batch = f.store.selectMergeBatch({
          id: summary.id, generation: summary.generation, kind: 'single', state: summary.state,
          selected_at: observed.lane?.selected_at ?? f.clock, updated_at: f.clock,
          base_sha: recordedHealthTimeline.base_sha, head_sha: head,
          target_pr: summary.target_pr, target_node_id: recordedHealthTimeline.native.id,
          members: [{ pr: summary.target_pr, head_sha: head, review_id: null, publication_id: null,
            github_review_id: null, pull_request_id: recordedHealthTimeline.native.id,
            ci_run_id: null, ci_attempt: null, priority: null, created_at: null }],
        });
        if (!observed.lane) batch = f.store.retireMergeBatch(batch.id, batch.generation, 'publishing', ++f.clock);
        const kind = observed.lane?.mutation?.kind ?? observed.failures[0]?.mutation;
        if (kind) f.lane.begin(batch, kind, observed.lane?.mutation ?? {});
      }
      const health = await httpHealth(f);
      assert.equal(health.status, 200, `ordinary live progress at ${observed.at} is not a failure`);
      assert.equal(health.body.ok, true);
      assert.deepEqual(health.body.mergeFailures, []);
    });
  }
});

test('a live merge becomes unhealthy after restart until its durable intent is reconciled', async (t) => {
  const f = await fixture(t);
  f.batch = f.store.updateMergeBatch(f.batch.id, 1, { state: 'merging' });
  const live = f.lane.begin(f.batch, 'merge', { target_pr: 90, tree_sha: f.batch.tree_sha,
    manifest_digest: f.batch.manifest_digest });
  assert.equal((await httpHealth(f)).status, 200);
  f.reopen();
  const uncertain = await httpHealth(f);
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.body.mergeFailures[0].mutation, 'merge');
  assert.equal(uncertain.body.mergeFailures[0].reason, null);
  assert.equal(f.store.activeMergeBatch().mutation.id, live.mutation.id);
  assert.equal(await f.lane.reconcileMutation(f.store.activeMergeBatch()), false);
  assert.equal((await httpHealth(f)).status, 503, 'absence of native proof does not heal uncertainty');
  Object.assign(f.prs.get(90), { state: 'closed', merged: true, merged_by: { ...REVIEW_BOT } });
  f.mergeCommits.set(90, sha(999));
  f.main = sha(999);
  await f.lane.reconcileMutation(f.store.activeMergeBatch());
  assert.equal(f.store.activeMergeBatch().mutation, null);
  assert.equal((await httpHealth(f)).status, 200, 'confirmed proof leaves only unattempted publication');
  assert.deepEqual(f.merges, [], 'health and recovery do not send the native merge again');
});

test('an unattempted source receipt is healthy but a recorded publication failure stays unhealthy across restart', async (t) => {
  const f = await fixture(t);
  await f.advance();
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'publishing');
  assert.equal((await httpHealth(f)).status, 200);
  f.nativeMembersMerged();
  f.host.publishStatus = async () => { throw new Error('fixture_source_receipt_failed'); };
  await f.advance();
  const failed = await httpHealth(f);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.mergeFailures[0].reason, 'fixture_source_receipt_failed');
  f.reopen();
  assert.equal((await httpHealth(f)).status, 503);
  await f.advance();
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'merged');
  assert.equal((await httpHealth(f)).status, 200);
  assert.deepEqual(f.merges, [90]);
});

for (const failure of [{ reason: 'fixture_lane_failed' }, { reason: '' }, { needs_inspection: true }]) {
  test(`lane health preserves an explicit failure ${JSON.stringify(failure)}`, async (t) => {
    const f = await fixture(t);
    f.store.updateMergeBatch(f.batch.id, 1, failure);
    const health = await httpHealth(f);
    assert.equal(health.status, 503);
    assert.equal(health.body.mergeFailures.length, 1);
  });
}

test('a timed-out shepherdAfter status publication stays unhealthy while its native comment is absent', async (t) => {
  const f = await fixture(t);
  const github = f.host.github;
  const request = github.request.bind(github);
  const paginate = github.paginate.bind(github);
  const privateValue = 'fixture-status-publication-private-value';
  let posts = 0;
  github.paginate = async (path) => path.endsWith('/issues/1/comments') ? [] : paginate(path);
  github.request = async (method, path, body, guard) => {
    if (method === 'POST' && path.endsWith('/issues/1/comments')) {
      await guard('before_send');
      posts++;
      throw new Error(`github_timeout ${privateValue} ${'x'.repeat(1500)}`);
    }
    return request(method, path, body, guard);
  };
  const scheduler = new Scheduler({
    store: f.store, github, shepherd: f.host.shepherd, approval: f.host.approval,
    publisher: { secrets: [privateValue] }, mode: 'approve', now: () => ++f.clock,
  });
  scheduler.reconcileCounts = { failed: 0 };
  scheduler.latestCi = async (head) => f.ci.get(head);
  f.lane = scheduler.batchLane;
  const inspection = await scheduler.shepherd.inspect(1);
  await scheduler.shepherdAfter({ inspection, update: null });
  const pending = f.store.activeMergeBatch();
  assert.equal(posts, 1);
  assert.equal(scheduler.reconcileCounts.failed, 1);
  assert.equal(pending.mutation.kind, 'comment');
  assert.equal(pending.mutation.comment_pr, 1);
  assert.match(pending.reason, /github_timeout/u);
  assert.equal(pending.reason.includes(privateValue), false);
  assert.ok(pending.reason.length <= 1000);
  assert.equal((await httpHealth(f)).status, 503);
  assert.equal(await f.lane.reconcileMutation(pending), false);
  assert.equal((await httpHealth(f)).status, 503);
  assert.equal(f.store.activeMergeBatch().mutation.id, pending.mutation.id);
  assert.equal(posts, 1, 'an absent native comment never authorizes a duplicate POST');
});

for (const [message, outcome] of [['github_timeout', 'failed:github_timeout'],
  ['GitHub request failed: PUT /repos/example-org/example-project/pulls/1/update-branch HTTP 502', 'failed:HTTP 502']]) {
  test(`failed singleton update ${outcome} remains unhealthy without native progress or duplicate PUTs`, async (t) => {
    const f = await fixture(t);
    f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
    const single = f.store.selectMergeBatch({ ...f.batch, generation: 2, kind: 'single',
      state: 'selected', sealed: false, members: [f.batch.members[0]], target_pr: 1,
      target_node_id: 'PR_1', head_sha: sha(1), carrier_branch: null, manifest_digest: null,
      selected_at: ++f.clock, updated_at: f.clock });
    f.behind.set(1, 1);
    const github = f.host.github;
    const request = github.request.bind(github);
    let puts = 0;
    github.request = async (method, path, body, guard) => {
      if (method === 'PUT' && path.endsWith('/pulls/1/update-branch')) {
        await guard('before_send');
        puts++;
        throw new Error(message);
      }
      if (method === 'GET' && path.endsWith('/labels/needs-update')) return { name: 'needs-update' };
      if (method === 'POST' && path.endsWith('/issues/1/labels')) return [];
      return request(method, path, body, guard);
    };
    await f.advance();
    const pending = f.store.activeMergeBatch();
    assert.equal(f.store.updateAttempt(1, single.head_sha, single.base_sha).outcome, outcome);
    assert.equal(pending.mutation.kind, 'update');
    assert.equal(f.prs.get(1).head.sha, single.head_sha);
    assert.equal((await httpHealth(f)).status, 503);
    assert.equal(pending.reason, outcome);
    await f.advance();
    assert.equal((await httpHealth(f)).status, 503);
    assert.equal(f.store.activeMergeBatch().mutation.id, pending.mutation.id);
    f.reopen();
    await f.advance();
    assert.equal((await httpHealth(f)).status, 503);
    assert.equal(f.store.activeMergeBatch().reason, outcome);
    assert.equal(f.store.activeMergeBatch().mutation.id, pending.mutation.id);
    assert.equal(puts, 1, 'unchanged native head never authorizes a duplicate update PUT');
    assert.deepEqual(f.merges, []);
  });
}

test('a refreshed single survives a cancelled status and waits for its own new-head approval', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.store.selectMergeBatch({ ...f.batch, id: 'status-race-single', generation: 1,
    kind: 'single', state: 'selected', sealed: false, members: [f.batch.members[0]], target_pr: 1,
    target_node_id: 'PR_1', head_sha: sha(1), tree_sha: null, carrier_branch: null, manifest_digest: null,
    selected_at: ++f.clock, updated_at: f.clock });
  f.behind.set(1, 1);
  await f.advance();
  const row = f.store.enqueue({ pr: 1, head_sha: f.prs.get(1).head.sha,
    base_ref: 'main', due: 0, reason: 'synchronize' }, ++f.clock);
  const logs = [];
  const status = new Scheduler({ store: f.store, github: f.host.github, mode: 'approve',
    now: f.host.now, log: (event) => logs.push(event) });
  status.batchLane = f.lane;
  status.shepherd = f.host.shepherd;
  status.latestCi = f.host.latestCi;
  f.host.publishStatus = (...args) => status.publishStatus(...args);
  const request = f.host.github.request.bind(f.host.github);
  const paginate = f.host.github.paginate.bind(f.host.github);
  let race = true, commentFence = false, writes = 0;
  f.host.github.paginate = (path, ...args) => path.endsWith('/comments') ? [] : paginate(path, ...args);
  f.host.github.request = async (method, path, body, guard) => {
    if (['POST', 'PATCH'].includes(method) && /\/(?:issues\/1\/comments|issues\/comments\/100)$/u.test(path)) {
      commentFence = true;
      try { await guard('before_send'); } finally { commentFence = false; }
      writes++;
      return { id: 100 };
    }
    if (race && commentFence && method === 'GET' && path.endsWith('/pulls/1')) {
      race = false;
      f.store.update(row.id, { status: 'running', started_at: ++f.clock });
    }
    return request(method, path, body, guard);
  };
  await f.advance();
  const selected = f.store.activeMergeBatch();
  assert.equal(selected?.id, 'status-race-single');
  assert.equal(selected.generation, 2);
  assert.equal(selected.state, 'selected');
  assert.equal(writes, 0, 'the stale status must not be sent');
  assert.equal(selected.mutation, null, 'no status mutation was dispatched');
  assert.equal(logs.find((event) => event.event === 'status_publication_cancelled')?.cause,
    'presentation_identity_changed');
  await f.advance();
  assert.deepEqual(f.merges, [], 'old-head approval cannot authorize the new head');
  f.store.update(row.id, { status: 'cancelled' });
  const approved = f.approve(1), ci = f.ci.get(approved.head_sha);
  f.proofByHead.set(approved.head_sha, { base: f.main, run: ci.id });
  await f.advance();
  assert.deepEqual(f.merges, [1], 'fresh approval and CI resume the same selection');
  await f.advance();
  const publication = f.store.mergeBatch(selected.id, selected.generation);
  assert.equal(publication.state, 'merged');
  assert.equal(publication.member_results[1].outcome, 'merged_direct',
    'the later post-merge status completes without weakening the earlier stale-status fence');
});

test('merged batch members publish through the scheduler guard and finish the durable batch', async (t) => {
  const f = await fixture(t);
  await f.advance();
  f.nativeMembersMerged();
  const status = new Scheduler({ store: f.store, github: f.host.github, mode: 'approve',
    now: f.host.now, log: f.host.log });
  status.batchLane = f.lane;
  status.shepherd = f.host.shepherd;
  status.latestCi = f.host.latestCi;
  f.host.publishStatus = (...args) => status.publishStatus(...args);
  const request = f.host.github.request.bind(f.host.github);
  const paginate = f.host.github.paginate.bind(f.host.github);
  const comments = [];
  f.host.github.paginate = (path, ...args) => path.endsWith('/comments') ? [] : paginate(path, ...args);
  f.host.github.request = async (method, path, body, guard) => {
    if (method === 'POST' && /\/issues\/[12]\/comments$/u.test(path)) {
      await guard('before_send');
      comments.push(body.body);
      return { id: comments.length + 100 };
    }
    return request(method, path, body, guard);
  };
  // Ordinary closed-PR presentation has no batch publication authority.
  const closed = structuredClone(f.prs.get(1));
  await assert.rejects(status.presentationGuard(closed)('before_send'),
    { message: 'publication_cancelled', presentationCause: 'source_not_open' });
  await f.advance();
  const completed = f.store.mergeBatch(f.batch.id, 1);
  assert.equal(completed.state, 'merged');
  assert.equal(comments.length, 2);
  for (const number of [1, 2]) {
    assert.equal(completed.member_results[number].outcome, 'merged_via_batch');
    assert.equal(completed.member_results[number].native_merged, true);
    assert.ok(completed.member_results[number].comment_id);
  }
  // A completed batch cannot authorize a new closed-PR presentation either.
  await assert.rejects(status.presentationGuard(closed, completed)('before_send'),
    { message: 'publication_cancelled', presentationCause: 'source_not_open' });
});

test('repeated pending member publication is durable and visible in HTTP health', async (t) => {
  const f = await fixture(t);
  await f.advance();
  f.nativeMembersMerged();
  f.blockPublication = true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await f.advance();
    assert.equal(f.store.mergeBatch(f.batch.id, 1).publication_wait.attempts, attempt);
    if (attempt === 2) f.reopen();
  }
  const stalled = await httpHealth(f);
  assert.equal(stalled.status, 503);
  assert.equal(f.store.mergeBatch(f.batch.id, 1).reason, 'publication_pending:pr_1:attempts_3');
  assert.match(JSON.stringify(stalled), /publication_pending:pr_1:attempts_3/u);
  f.blockPublication = false;
  await f.advance();
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'merged');
  assert.equal(f.store.mergeBatch(f.batch.id, 1).reason, null);
});

for (const restartDuringUpdate of [false, true]) {
  test(`ordinary known-head refresh stays healthy while new review and CI are pending (restart=${restartDuringUpdate})`, async (t) => {
    const f = await fixture(t);
    f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
    const single = f.store.selectMergeBatch({ ...f.batch, id: 'refresh-health-single', generation: 1,
      kind: 'single', state: 'selected', sealed: false, members: [f.batch.members[0]], target_pr: 1,
      target_node_id: 'PR_1', head_sha: sha(1), tree_sha: null, carrier_branch: null, manifest_digest: null,
      selected_at: ++f.clock, updated_at: f.clock });
    f.behind.set(1, 1);
    await f.advance();
    const pending = f.store.activeMergeBatch();
    assert.equal(pending.mutation.kind, 'update');
    assert.equal((await httpHealth(f)).status, 200, 'the current process owns the live update');
    assert.notEqual(f.prs.get(1).head.sha, single.head_sha, 'the native update advanced the actual source head');
    if (restartDuringUpdate) {
      f.reopen();
      const uncertain = await httpHealth(f);
      assert.equal(uncertain.status, 503, 'restart cannot assume the pending native write settled');
      assert.equal(uncertain.body.mergeFailures[0].mutation, 'update');
      assert.equal(f.store.activeMergeBatch().mutation.id, pending.mutation.id);
    }
    await f.advance();
    const refreshed = f.store.activeMergeBatch();
    assert.equal(refreshed.generation, 2);
    assert.equal(refreshed.head_sha, f.prs.get(1).head.sha);
    assert.equal(refreshed.mutation, null, 'the native head observation settled the old update');
    const waitingReview = await httpHealth(f);
    assert.equal(waitingReview.status, 200, 'a known refreshed head waiting for its review is ordinary progress');
    assert.deepEqual(waitingReview.body.mergeFailures, []);
    assert.equal(refreshed.sealed, false);
    for (const key of ['review_id', 'publication_id', 'github_review_id', 'ci_run_id', 'ci_attempt']) {
      assert.equal(refreshed.members[0][key], null, `the refreshed head inherits no ${key} authority`);
    }
    await f.advance();
    assert.deepEqual(f.merges, [], 'the previous head approval cannot authorize the refreshed head');
    const row = f.approve(1);
    const ci = f.ci.get(row.head_sha);
    ci.status = 'in_progress';
    ci.conclusion = null;
    await f.advance();
    const waitingCi = await httpHealth(f);
    assert.equal(waitingCi.status, 200, 'a reviewed head waiting for current CI is ordinary progress');
    assert.deepEqual(waitingCi.body.mergeFailures, []);
    assert.deepEqual(f.merges, [], 'a fresh review alone does not authorize a merge');
    ci.status = 'completed';
    ci.conclusion = 'success';
    f.proofByHead.set(row.head_sha, { base: f.main, run: ci.id });
    await f.advance();
    assert.deepEqual(f.merges, [1], 'only the fresh head review and current-base CI allow the protected merge');
    assert.equal(f.prs.get(1).merged, true);
    assert.equal(f.store.activeMergeBatch().merged_sha, sha(999));
    assert.equal((await httpHealth(f)).status, 200);
    await f.advance();
    assert.equal(f.store.activeMergeBatch(), null);
    assert.equal(f.store.mergeBatch(single.id, 2).state, 'merged');
    assert.equal((await httpHealth(f)).status, 200);
    assert.deepEqual(f.updates, [1], 'reconciliation never sends the native update again');
    assert.deepEqual(f.merges, [1], 'publication never sends the native merge again');
  });
}

async function approvedLaneFixture(t, { select = true } = {}) {
  const f = await fixture(t);
  f.prs.delete(2); f.prs.delete(90);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  if (select) {
    const selected = { ...f.batch, id: 'approved-single', kind: 'single', state: 'testing',
      head_sha: sha(1), target_pr: 1, target_node_id: 'PR_1', members: [f.batch.members[0]],
      carrier_branch: null };
    f.store.selectMergeBatch({ ...selected, manifest_digest: manifestDigest(selected) });
  }
  const row = f.store.latest(1), report = { ...JSON.parse(row.result_json), publication_id: row.id };
  f.store.update(row.id, { result_json: JSON.stringify(report) });
  f.proofByHead.set(row.head_sha, { base: f.main, run: f.ci.get(row.head_sha).id });
  const scheduler = new Scheduler({ store: f.store, github: f.host.github, approval: f.host.approval,
    shepherd: f.host.shepherd, mode: 'approve', now: () => ++f.clock,
    mirror: { reviewModel: 'openai-codex/gpt-6.1-sol', reviewThinking: 'medium' },
    publisher: { updateEvidence: async () => { throw new Error('informational update unavailable'); } },
    batchMirror: f.mirror, batchReadProof: f.readProof,
    batchConfirmTree: async ({ batch, mergedSha }) => ({ tree_sha: batch.tree_sha, merge_sha: mergedSha }) });
  scheduler.latestCi = async (head) => f.ci.get(head);
  scheduler.ciRuns = f.host.ciRuns;
  return { ...f, scheduler, row, report };
}

test('a fresh approval merges its selected head before an unavailable informational evidence update', async (t) => {
  const f = await approvedLaneFixture(t);
  f.store.run('DELETE FROM approvals WHERE publication_id=?', f.row.id);
  await assert.rejects(f.scheduler.approveCompleted(f.row, f.report), /informational update unavailable/u);
  assert.deepEqual(f.merges, [1]);
});

for (const select of [false, true]) {
  test(`current approved-head CI completion merges without a full sweep (selected=${select})`, async (t) => {
    const f = await approvedLaneFixture(t, { select });
    await f.scheduler.apply({ type: 'ciCompleted', pr: 1, head_sha: f.row.head_sha });
    assert.deepEqual(f.merges, [1]);
  });
}

function deferNative(f, number) {
  const ci = f.ci.get(f.prs.get(number).head.sha);
  Object.assign(ci, { status: 'completed', conclusion: 'failure' });
  f.jobs.set(ci.id, [
    { id: 700, name: NATIVE_ADMISSION_JOB, status: 'completed', conclusion: 'failure',
      steps: [{ name: NATIVE_DEFERRED_STEP, conclusion: 'failure' }] },
    ...['Reuse tested PR tree', 'Rust checks', 'TypeScript', 'Bots', 'PR image / build'].map((name) => ({
      name, status: 'completed', conclusion: 'success' })),
    { name: 'Rust tests / linux', status: 'completed', conclusion: 'skipped' },
  ]);
  return ci;
}

async function selectedNativeSingle(t, { behind = 0 } = {}) {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.prs.delete(2); f.prs.delete(90);
  deferNative(f, 1);
  f.behind.set(1, behind);
  await f.advance();
  assert.equal(f.store.activeMergeBatch().kind, 'single');
  return f;
}

test('deferred source admission precedes folding and never reruns stale native CI', async (t) => {
  const f = await selectedNativeSingle(t, { behind: 1 });
  assert.deepEqual(f.nativeWrites.map(({ kind, head }) => ({ kind, head })), [
    { kind: 'admit', head: sha(1) }, { kind: 'update', head: sha(1) },
  ]);
  assert.deepEqual(f.reruns, []);
  assert.deepEqual(f.merges, []);
  await f.advance();
  const folded = f.prs.get(1).head.sha;
  assert.notEqual(folded, sha(1));
  await f.advance();
  assert.deepEqual(f.reruns, [], 'a pending exact-fold review/CI is not invalidation or stale-head rerun');
  assert.equal(f.store.activeMergeBatch().head_sha, folded);
  const row = f.approve(1);
  f.proofByHead.set(folded, { base: f.main, run: f.ci.get(folded).id });
  await f.advance();
  assert.deepEqual(f.merges, [1]);
  assert.equal(row.head_sha, folded);
});

test('up-to-date deferred selection requests failed jobs once and still requires final native proof', async (t) => {
  const f = await selectedNativeSingle(t);
  assert.deepEqual(f.reruns, [{ head: sha(1), run: f.ci.get(sha(1)).id, failedOnly: true }]);
  assert.deepEqual(f.merges, []);
  assert.equal(f.store.activeMergeBatch().mutation.purpose, 'native_admission');
  f.reopen();
  await f.advance();
  assert.equal(f.reruns.length, 1);
  const ci = f.ci.get(sha(1));
  f.attemptJobs.set(`${ci.id}:${ci.run_attempt}`, f.jobs.get(ci.id).filter((job) =>
    ['Native admission', 'Rust tests', 'Rust', 're-actors/alls-green'].includes(job.name)));
  Object.assign(ci, { status: 'completed', conclusion: 'failure' });
  await f.advance(); await f.advance();
  assert.equal(f.reruns.length, 1, 'a second deferred attempt cannot trigger another automatic rerun');
  assert.equal(f.store.activeMergeBatch().state, 'selected');
  Object.assign(ci, { conclusion: 'success' });
  await f.advance();
  assert.deepEqual(f.merges, [], 'green canonical CI alone does not replace artifact/tree proof');
  f.proofByHead.set(sha(1), { base: f.main, run: ci.id });
  await f.advance();
  assert.deepEqual(f.merges, [1]);
});

test('unknown failed-only write is retained through restart without blind retry', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.prs.delete(2); f.prs.delete(90);
  deferNative(f, 1);
  f.rerunTimeout = true;
  await assert.rejects(f.advance(), /github_timeout/u);
  const pending = f.store.activeMergeBatch().mutation;
  f.reopen();
  await f.advance(); await f.advance();
  assert.equal(f.store.activeMergeBatch().mutation.id, pending.id);
  assert.equal(f.reruns.length, 1);
  assert.deepEqual(f.merges, []);
});

test('lost admission response is adopted before any fold and unknown admission is not retried', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.prs.delete(2); f.prs.delete(90);
  deferNative(f, 1); f.behind.set(1, 1); f.admissionTimeout = true;
  await assert.rejects(f.advance(), /github_timeout/u);
  const pending = f.store.activeMergeBatch().mutation;
  const saved = [...f.signals.entries()];
  f.signals.clear();
  f.reopen();
  await f.advance();
  assert.equal(f.store.activeMergeBatch().mutation.id, pending.id);
  assert.deepEqual(f.updates, []);
  for (const [id, check] of saved) f.signals.set(id, check);
  f.admissionTimeout = false;
  await f.advance();
  assert.deepEqual(f.updates, [1]);
  assert.equal(f.nativeWrites.filter(({ kind }) => kind === 'admit').length, 1);
});

test('selection authorization is rechecked at scheduling-check send, before folding', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.prs.delete(2); f.prs.delete(90);
  deferNative(f, 1); f.behind.set(1, 1);
  f.beforeAdmission = async () => f.vetoes.add(1);
  await assert.rejects(f.advance(), /batch_member_authorization_changed/u);
  assert.equal(f.signals.size, 0);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.reruns, []);
});

test('invalidation revokes historical folded-parent scheduling checks and recovers lost revoke responses', async (t) => {
  const f = await selectedNativeSingle(t, { behind: 1 });
  await f.advance();
  const batch = f.store.activeMergeBatch();
  assert.equal(batch.generation, 2);
  f.revokeTimeout = true;
  await assert.rejects(f.lane.invalidate(batch, 'fixture_invalidated'), /github_timeout/u);
  assert.equal(f.store.activeMergeBatch().mutation.kind, 'native_admission_revoke');
  f.reopen();
  f.revokeTimeout = false;
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal([...f.signals.values()][0].conclusion, 'cancelled');
  assert.equal(f.nativeWrites.filter(({ kind }) => kind === 'revoke').length, 1);
});

for (const isolated of [false, true]) {
  test(`exact selected native execution failure quarantines only that head (serial fallback=${isolated})`, async (t) => {
    const f = await selectedNativeSingle(t);
    let batch = f.store.activeMergeBatch();
    await f.lane.reconcileMutation(batch);
    batch = f.store.activeMergeBatch();
    if (isolated) {
      const parent = f.store.mergeBatch(f.batch.id, 1);
      f.store.updateMergeBatch(parent.id, 1, { state: 'fallback' });
      f.lane.patch(batch, { fallback_of: { id: parent.id, generation: 1 } });
    }
    const ci = f.ci.get(sha(1));
    Object.assign(ci, { status: 'completed', conclusion: 'failure' });
    f.jobs.set(ci.id, [{ id: 701, name: 'Rust tests / linux', status: 'completed', conclusion: 'failure', completed_at: new Date(f.clock + 10).toISOString(),
      steps: [{ name: 'Native test failures reported by nextest', conclusion: 'failure' }] }]);
    await f.advance();
    assert.equal(f.store.nativeCiFailure(1, sha(1)).job_id, 701);
    assert.equal(f.store.nativeCiFailure(2, sha(2)), null);
    assert.equal([...f.signals.values()][0].conclusion, 'cancelled');
    assert.equal(f.store.activeMergeBatch(), null);
    if (isolated) assert.deepEqual(f.store.mergeBatch(f.batch.id, 1).fallback_done, [1]);
    await f.advance();
    assert.equal(f.store.activeMergeBatch(), null, 'same head remains excluded');
    f.prs.get(1).head.sha = sha(111); f.approve(1);
    await f.advance();
    assert.equal(f.store.activeMergeBatch().head_sha, sha(111), 'new push is eligible independently');
  });
}

test('long admitted execution preserves the selection window for late native failure quarantine', async (t) => {
  const f = await selectedNativeSingle(t);
  const selected = f.store.activeMergeBatch(), ci = f.ci.get(sha(1));
  assert.equal(selected.mutation.kind, 'ci_rerun');
  await f.advance();
  const waiting = f.store.activeMergeBatch();
  assert.equal(waiting.mutation, null);
  assert.equal(waiting.sealed, false);
  f.reopen();
  f.clock = waiting.selection_wait.since + 60 * 60 * 1000;
  await f.advance();
  assert.equal(f.store.activeMergeBatch()?.id, selected.id);
  assert.equal(f.store.activeMergeBatch().selected_at, selected.selected_at);
  assert.equal((await httpHealth(f)).status, 200);
  f.attemptJobs.set(`${ci.id}:2`, [{ id: 703, name: 'Rust tests (ares-2, weighted)', status: 'completed',
    conclusion: 'failure', completed_at: new Date(f.clock + 10).toISOString(),
    steps: [{ name: 'Native test failures reported by nextest', conclusion: 'failure' }] }]);
  Object.assign(ci, { run_attempt: 3, status: 'completed', conclusion: 'success' });
  f.jobs.set(ci.id, []);
  f.reopen();
  await f.advance();
  assert.equal(f.store.nativeCiFailure(1, sha(1)).run_attempt, 2);
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal([...f.signals.values()][0].conclusion, 'cancelled');
  assert.deepEqual(f.merges, []);
});

for (const greenBeforeInspection of [false, true]) {
  test(`main drift cannot retire an unchanged selected head's native failure (newer green=${greenBeforeInspection})`, async (t) => {
    const f = await selectedNativeSingle(t);
    await f.lane.reconcileMutation(f.store.activeMergeBatch());
    const selected = f.store.activeMergeBatch(), ci = f.ci.get(selected.head_sha);
    const failed = { id: 705, name: 'Rust tests / linux', status: 'completed', conclusion: 'failure',
      completed_at: new Date(f.clock + 10).toISOString(),
      steps: [{ name: 'Native test failures reported by nextest', conclusion: 'failure' }] };
    f.attemptJobs.set(`${ci.id}:2`, [failed]);
    f.jobs.set(ci.id, []);
    Object.assign(ci, { run_attempt: greenBeforeInspection ? 3 : 2, status: 'completed',
      conclusion: greenBeforeInspection ? 'success' : 'failure' });
    f.main = sha(200); f.behind.set(1, 1);
    f.prs.get(1).user = { id: 123, login: 'other[bot]', type: 'Bot' };
    if (greenBeforeInspection) f.reopen();
    await f.advance();
    const failure = f.store.nativeCiFailure(1, selected.head_sha);
    assert.equal(failure.head_sha, sha(1));
    assert.equal(failure.run_id, ci.id);
    assert.equal(failure.run_attempt, 2);
    assert.equal(failure.job_id, failed.id);
    assert.equal(f.store.mergeBatch(selected.id, selected.generation).state, 'invalidated');
    assert.equal(f.store.activeMergeBatch(), null);
    assert.equal([...f.signals.values()][0].conclusion, 'cancelled');
    assert.deepEqual(f.updates, [], 'drift must not fold the failed head before latching it');
    assert.deepEqual(f.merges, []);
    Object.assign(ci, { run_attempt: 3, conclusion: 'success' });
    await f.advance();
    assert.equal(f.store.activeMergeBatch(), null, 'a later green cannot reselect the failed head');
    f.reopen();
    await f.advance();
    assert.equal(f.store.activeMergeBatch(), null, 'the exact-head exclusion survives restart');
    assert.equal(f.store.nativeCiFailure(1, sha(1)).job_id, failed.id);
    f.prs.get(1).head.sha = sha(111); f.behind.set(1, 0); f.approve(1);
    await f.advance();
    assert.equal(f.store.activeMergeBatch().head_sha, sha(111), 'a newly approved push remains eligible');
    assert.equal(f.store.nativeCiFailure(1, sha(111)), null);
  });
}

test('drift failure inspection excludes native failures before selection and deferred unexecuted jobs', async (t) => {
  const f = await selectedNativeSingle(t);
  await f.lane.reconcileMutation(f.store.activeMergeBatch());
  const selected = f.store.activeMergeBatch(), ci = f.ci.get(selected.head_sha);
  f.attemptJobs.set(`${ci.id}:1`, [{ id: 706, name: 'Rust tests / linux', status: 'completed', conclusion: 'failure',
    completed_at: new Date(selected.selected_at - 1).toISOString(),
    steps: [{ name: 'Native test failures reported by nextest', conclusion: 'failure' }] }]);
  deferNative(f, 1);
  f.main = sha(200); f.behind.set(1, 1);
  await f.advance();
  assert.equal(f.store.nativeCiFailure(1, sha(1)), null);
  assert.equal(f.store.activeMergeBatch().head_sha, sha(1));
  await f.advance();
  assert.deepEqual(f.updates, [1], 'ordinary deferred source folding remains available');
  assert.equal(f.store.nativeCiFailure(1, sha(1)), null);
});

test('a changed source head is refreshed before examining the prior selected head failure', async (t) => {
  const f = await selectedNativeSingle(t);
  await f.lane.reconcileMutation(f.store.activeMergeBatch());
  const ci = f.ci.get(sha(1));
  Object.assign(ci, { status: 'completed', conclusion: 'failure' });
  f.jobs.set(ci.id, [{ id: 707, name: 'Rust tests / linux', status: 'completed', conclusion: 'failure',
    completed_at: new Date(f.clock + 10).toISOString(),
    steps: [{ name: 'Native test failures reported by nextest', conclusion: 'failure' }] }]);
  f.main = sha(200); f.behind.set(1, 1);
  f.prs.get(1).head.sha = sha(111);
  f.approve(1);
  await f.advance();
  assert.equal(f.store.activeMergeBatch().head_sha, sha(111));
  assert.equal(f.store.nativeCiFailure(1, sha(1)), null);
  assert.equal(f.store.nativeCiFailure(1, sha(111)), null, 'old-head evidence never quarantines a new push');
  assert.deepEqual(f.updates, []);
});

test('drift does not bypass strict native failure history availability', async (t) => {
  const f = await selectedNativeSingle(t);
  await f.lane.reconcileMutation(f.store.activeMergeBatch());
  const selected = f.store.activeMergeBatch();
  f.main = sha(200); f.behind.set(1, 1);
  f.ciHistory.set(sha(1), []);
  await assert.rejects(f.advance(), /native_ci_history_incomplete/u);
  assert.equal(f.store.activeMergeBatch().generation, selected.generation);
  assert.equal(f.store.nativeCiFailure(1, sha(1)), null);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.merges, []);
});

for (const failure of ['setup', 'quota', 'typescript']) {
  test(`${failure} failure does not become durable native execution quarantine`, async (t) => {
    const f = await selectedNativeSingle(t);
    await f.lane.reconcileMutation(f.store.activeMergeBatch());
    const ci = f.ci.get(sha(1));
    Object.assign(ci, { status: 'completed', conclusion: 'failure' });
    f.jobs.set(ci.id, [{ id: 702, name: failure === 'typescript' ? 'TypeScript' : 'Rust tests / linux',
      status: 'completed', conclusion: 'failure',
      steps: [{ name: failure === 'setup' ? 'Set up job' : failure === 'quota' ? 'Runner quota' : 'Typecheck', conclusion: 'failure' }] }]);
    await f.advance();
    assert.equal(f.store.nativeCiFailure(1, sha(1)), null);
    assert.deepEqual(f.merges, []);
  });
}

for (const failure of ['compile', 'nextest-setup', 'runner-timeout']) {
  test(`${failure} can recover through green native CI on the same head`, async (t) => {
    const f = await selectedNativeSingle(t);
    await f.lane.reconcileMutation(f.store.activeMergeBatch());
    const ci = f.ci.get(sha(1));
    const conclusion = failure === 'runner-timeout' ? 'timed_out' : 'failure';
    Object.assign(ci, { run_attempt: 2, status: 'completed', conclusion });
    const failed = { id: 705, name: 'Rust tests (ares-2, weighted)', status: 'completed',
      conclusion, completed_at: new Date(f.clock + 10).toISOString(),
      steps: [{ name: failure === 'compile' ? 'Compile native tests from persistent target' : 'Native tests from persistent target',
        conclusion: failure === 'runner-timeout' ? null : 'failure',
        started_at: new Date(f.clock).toISOString() }] };
    f.jobs.set(ci.id, [failed]);
    f.attemptJobs.set(`${ci.id}:2`, [failed]);
    await f.advance();
    Object.assign(ci, { run_attempt: 3, conclusion: 'success' });
    f.jobs.set(ci.id, []);
    f.proofByHead.set(sha(1), { base: f.main, run: ci.id });
    f.reopen();
    for (let tick = 0; tick < 4 && f.merges.length === 0; tick++) await f.advance();
    assert.deepEqual(f.merges, [1]);
    assert.equal(f.prs.get(1).head.sha, sha(1), 'retry did not require a new source push');
  });
}

test('a later green cannot hide unattributed composition native failure or mass-quarantine members', async (t) => {
  const f = await fixture(t), ci = f.ci.get(f.batch.head_sha);
  Object.assign(ci, { run_attempt: 3, conclusion: 'success' });
  f.attemptJobs.set(`${ci.id}:2`, [{ id: 704, name: 'Rust tests (ares-2, weighted)', status: 'completed',
    conclusion: 'failure', completed_at: new Date(f.clock + 10).toISOString(),
    steps: [{ name: 'Native test failures reported by nextest', conclusion: 'failure' }] }]);
  await f.advance();
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'fallback');
  assert.equal(f.store.nativeCiFailure(1, sha(1)), null);
  assert.equal(f.store.nativeCiFailure(2, sha(2)), null);
});

test('published carrier gets exact-C scheduling admission before opening and deferred sources are not native proof', async (t) => {
  const f = await fixture(t);
  deferNative(f, 1); deferNative(f, 2);
  const members = f.batch.members.map((member) => ({ ...member }));
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  let branch = null;
  f.mirror.assemble = async () => ({ head_sha: sha(801), tree_sha: sha(900), conflicts: [] });
  f.mirror.publish = async (batch, guard, record) => {
    await guard(); await record(); branch = batch.head_sha;
  };
  f.author.readBranch = async () => branch;
  f.author.createCarrier = async (batch, body, guard) => {
    await guard('before_send');
    const check = [...f.signals.values()].find((signal) => signal.head_sha === batch.head_sha);
    assert.equal(check.name, NATIVE_ADMISSION_CHECK);
    assert.equal(check.conclusion, 'success');
    assert.equal(JSON.parse(check.output.text).carrier_branch, batch.carrier_branch);
    assert.match(body, /preparation CI.*not final native proof/u);
    return { number: 91, node_id: 'PR_91', head: { sha: batch.head_sha } };
  };
  const batch = f.store.selectMergeBatch({ id: 'native-carrier', generation: 1, kind: 'batch', state: 'selected',
    selected_at: ++f.clock, updated_at: f.clock, base_sha: f.main, members });
  await f.lane.advanceCarrier(batch);
  assert.equal(f.store.activeMergeBatch().target_pr, 91);
  assert.equal(f.store.activeMergeBatch().head_sha, sha(801));
  assert.deepEqual(f.merges, []);
});

test('a deferred exact carrier resumes failed native admission once instead of composition fallback', async (t) => {
  const f = await fixture(t, { carrierRef: 'fleet-review-bot-batch/sealed-composition/1' });
  deferNative(f, 90);
  f.proofByHead.get(f.batch.head_sha).red = true;
  await f.advance();
  assert.equal(f.reruns.length, 1);
  assert.equal(f.reruns[0].failedOnly, true);
  assert.equal(f.store.activeMergeBatch().mutation.purpose, 'native_admission');
  f.reopen();
  await f.advance();
  deferNative(f, 90);
  await f.advance(); await f.advance();
  assert.equal(f.reruns.length, 1);
  assert.equal(f.store.activeMergeBatch().state, 'testing');
  assert.deepEqual(f.closes, []);
  assert.deepEqual(f.merges, []);
});

test('failed-only resume rechecks source authorization before consuming the rerun intent', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.prs.delete(2); f.prs.delete(90);
  deferNative(f, 1);
  const rerun = f.author.rerunCi;
  f.author.rerunCi = async (...args) => {
    f.vetoes.add(1);
    return rerun(...args);
  };
  await assert.rejects(f.advance(), /batch_member_authorization_changed/u);
  assert.deepEqual(f.reruns, []);
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal([...f.signals.values()][0].conclusion, 'cancelled');
  const retired = f.store.latestMergeBatchForPr(1);
  assert.ok(!retired.operations.some(({ intent }) => intent.kind === 'ci_rerun'));
});

test('member preparation admits deferred receipts but still fences exact review and CI identity', async (t) => {
  const f = await fixture(t);
  deferNative(f, 1); deferNative(f, 2);
  await f.lane.fenceMembers(f.batch);
  f.ci.get(sha(2)).run_attempt++;
  await assert.rejects(f.lane.fenceMembers(f.batch), /batch_member_authorization_changed/u);
  f.ci.get(sha(2)).run_attempt--;
  f.reviews.get(1)[0].commit_id = sha(999);
  await assert.rejects(f.lane.fenceMembers(f.batch), /batch_member_approval_changed/u);
  assert.deepEqual(f.merges, []);
});

// Actual loopback HTTP measures discovery traffic, independently of transport ETags.
async function wireCandidateFixture(t, { evidence = false } = {}) {
  const f = await collectingFixture(t);
  const github = f.host.github, request = github.request.bind(github), paginate = github.paginate.bind(github);
  f.wire = [];
  f.evidenceWrites = [];
  const server = createServer(async (req, res) => {
    f.wire.push(req.url);
    try {
      let body;
      const relative = req.url.replace(`/repos/${github.repo}/`, '');
      const suite = /^commits\/([a-f0-9]{40})\/check-suites/u.exec(relative);
      const checks = /^check-suites\/(\d+)\/check-runs/u.exec(relative);
      const run = /^actions\/runs\/(\d+)$/u.exec(relative);
      const entry = run ? [...f.ci.entries()].find(([, ci]) => ci.id === Number(run[1])) : null;
      if (evidence && req.method === 'PATCH' && /^check-runs\/\d+$/u.test(relative)) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        f.evidenceWrites.push({ id: Number(relative.split('/').at(-1)), body: JSON.parse(Buffer.concat(chunks)) });
        body = { id: Number(relative.split('/').at(-1)) };
      } else if (relative.startsWith('pulls?')) body = await paginate(req.url);
      else if (suite) {
        const ci = f.ci.get(suite[1]);
        body = { check_suites: ci ? [{ id: ci.id + 1000, head_sha: suite[1], app: { id: 15368, slug: 'github-actions' },
          repository: { full_name: github.repo } }] : [] };
      } else if (checks) {
        const found = [...f.ci.entries()].find(([, ci]) => ci.id + 1000 === Number(checks[1]));
        body = { check_runs: found ? [{ id: found[1].id + 2000, head_sha: found[0], app: { id: 15368, slug: 'github-actions' },
          check_suite: { id: Number(checks[1]) },
          details_url: `https://github.com/${github.repo}/actions/runs/${found[1].id}/job/2000` }] : [] };
      } else if (entry) {
        body = { ...entry[1], head_sha: entry[0], name: 'CI', event: 'pull_request', path: '.github/workflows/ci.yml',
          workflow_id: 7, check_suite_id: entry[1].id + 1000,
          repository: { full_name: github.repo }, head_repository: { full_name: github.repo } };
      } else if (/\/reviews(?:\?|$)/u.test(req.url)) body = await paginate(req.url);
      else body = await request(req.method, req.url);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    } catch (error) {
      res.writeHead(500); res.end(JSON.stringify({ message: error.message }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  github.request = async (method, path, body, guard) => {
    assert.ok(method === 'GET' || evidence && method === 'PATCH' && /\/check-runs\/\d+$/u.test(path),
      'this fixture allows discovery reads and real review-evidence PATCHes, never native mutations');
    if (method === 'GET') assert.equal(body, undefined);
    await guard?.('before_send');
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`candidate_wire_http_${response.status}`);
    return response.json();
  };
  github.paginate = async (path, key, guard, options) => {
    const body = await github.request('GET', path, undefined, guard, options);
    return key ? body[key] : body;
  };
  const scheduler = new Scheduler({ store: f.store, github, approval: f.host.approval, shepherd: f.host.shepherd,
    mode: 'approve', now: () => f.clock, batchCollectSeconds: 180,
    mirror: { reviewModel: 'openai-codex/gpt-6.1-sol', reviewThinking: 'medium' } });
  f.host = scheduler;
  f.lane.host = scheduler;
  scheduler.batchLane = f.lane;
  return f;
}

test('unchanged candidates require only a shared canonical-main HTTP read while selected admission re-reads unconditionally', async (t) => {
  const f = await wireCandidateFixture(t);
  assert.equal(await f.select(), null, 'collection has not reached its durable deadline');
  const first = f.wire.length;
  assert.ok(first > 0);
  assert.equal(await f.select(), null);
  assert.deepEqual(f.wire.slice(first), [`/repos/${f.host.github.repo}/git/ref/heads/main`],
    'an unchanged pass revalidates the shared base, not each candidate inspection/review/CI');
  f.clock = 200000;
  const batch = await f.select();
  assert.deepEqual(batch.members.map((member) => member.pr), [1]);
  assert.ok(f.wire.length > first, 'cached ready is only a hint; selection requires fresh remote facts');
  assert.ok(f.wire.slice(first).some((path) => path.endsWith('/reviews')));
  assert.ok(f.wire.slice(first).some((path) => /\/actions\/runs\/\d+$/u.test(path)));
});

for (const change of ['status', 'head', 'live-rerequest']) {
  test(`cached ready candidate cannot select after fresh ${change} changes`, async (t) => {
    const f = await wireCandidateFixture(t);
    assert.equal(await f.select(), null);
    if (change === 'status') Object.assign(f.ci.get(sha(1)), { status: 'queued', conclusion: null });
    if (change === 'head') f.prs.get(1).head.sha = sha(111);
    if (change === 'live-rerequest') {
      f.host.noteCancellation({ type: 'enqueue', pr: 1, head_sha: sha(1), reason: 'rerequested' });
    }
    f.clock = 200000;
    assert.equal(await f.select(), null);
    assert.ok(!f.store.activeMergeBatch());
    assert.deepEqual(f.nativeWrites, []);
    if (change === 'status') {
      Object.assign(f.ci.get(sha(1)), { status: 'completed', conclusion: 'success' });
      assert.deepEqual((await f.select()).members.map((member) => member.pr), [1],
        'changed selected hint was discarded, allowing a fresh next pass rather than a blind same-pass retry');
    }
  });
}

test('signed HTTP ingress preserves invalidation identities and wakes cached negatives before serialized dispatch', async (t) => {
  const f = await wireCandidateFixture(t);
  const secret = 'candidate-ingress-fixture';
  const server = createWebhookServer({ store: f.store, scheduler: f.host, secret, mode: 'approve', now: () => f.clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const dispatch = f.host.processDelivery.bind(f.host);
  let accepted, delivery;
  f.host.processDelivery = (id) => { delivery = dispatch(id); accepted.resolve(); return delivery; };
  for (const [id, event, payload] of [
    ['suite', 'check_suite', { action: 'completed', check_suite: { head_sha: sha(1), output: 'unretained-detail' } }],
    ['status', 'status', { sha: sha(1), description: 'unretained-detail' }],
    ['review', 'pull_request_review', { action: 'submitted', pull_request: f.prs.get(1), review: { state: 'APPROVED' } }],
    ['main', 'push', { ref: 'refs/heads/main', before: sha(100), after: sha(101), commits: ['unretained-detail'] }],
  ]) {
    Object.assign(f.ci.get(sha(1)), { status: 'queued', conclusion: null });
    f.lane.invalidateCandidates({ pr: 1 });
    assert.equal(await f.select(), null);
    Object.assign(f.ci.get(sha(1)), { status: 'completed', conclusion: 'success' });
    const before = f.wire.length;
    const release = Promise.withResolvers(), entered = Promise.withResolvers();
    accepted = Promise.withResolvers();
    const block = f.host.serialize(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const raw = JSON.stringify({ repository: { full_name: f.host.github.repo }, ...payload });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/github`, {
      method: 'POST', body: raw, headers: { 'x-github-delivery': id, 'x-github-event': event,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` },
    });
    assert.equal(response.status, 202);
    await accepted.promise;
    assert.doesNotMatch(f.store.get('SELECT payload_json FROM deliveries WHERE id=?', id).payload_json, /unretained-detail/u);
    await f.select();
    assert.ok(f.wire.slice(before).some((path) => path.endsWith('/pulls/1')),
      `${event} must invalidate its negative through minimized persisted ingress, without waiting for dispatch`);
    release.resolve();
    await Promise.allSettled([block, delivery]);
  }
});

test('approved discovery hints survive real idempotent publication and signed duplicate status echoes, but not changed authority facts', async (t) => {
  const f = await wireCandidateFixture(t, { evidence: true });
  f.add(2); f.add(3);
  f.lane.maxSize = 5; // Keep this approved prefix in the real collection window.
  const complete = (number) => {
    const row = f.store.latest(number);
    return f.store.update(row.id, { check_run_id: 9000 + row.id, conclusion: 'success',
      result_json: JSON.stringify({ repo: f.host.github.repo, pr: number, head_sha: row.head_sha,
        publication_id: row.publication_id, review_route: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
        result: { pass: true, evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } },
        verdict: { decision: 'approve' }, findings: [] }) });
  };
  for (const number of [1, 2, 3]) complete(number);
  f.host.publisher = new Publisher({ github: f.host.github, store: f.store });
  // Issue-comment rendering is a separate owner; retain real approval recovery
  // and its real Publisher.updateEvidence HTTP PATCH on every reconciliation.
  f.host.publishStatus = async () => ({ comment_id: 1 });
  const laneReads = [], select = f.lane.select.bind(f.lane);
  f.lane.select = async (open) => {
    const before = f.wire.length;
    const result = await select(open);
    laneReads.push(f.wire.slice(before));
    return result;
  };
  const secret = 'approved-status-fixture';
  const ingress = createWebhookServer({ store: f.store, scheduler: f.host, secret, mode: 'approve', now: () => f.clock });
  ingress.listen(0, '127.0.0.1');
  await once(ingress, 'listening');
  t.after(async () => { ingress.closeAllConnections(); await new Promise((done) => ingress.close(done)); });
  let sequence = 0;
  const deliver = async (event, payload) => {
    const raw = JSON.stringify({ repository: { full_name: f.host.github.repo }, ...payload });
    const response = await fetch(`http://127.0.0.1:${ingress.address().port}/github`, {
      method: 'POST', body: raw, headers: { 'x-github-delivery': `semantic-${++sequence}`, 'x-github-event': event,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` },
    });
    assert.equal(response.status, 202);
    await response.json();
    await f.host.operations;
  };
  const status = (number, overrides = {}) => {
    const row = f.store.latest(number);
    return { action: 'completed', check_run: { id: row.check_run_id, name: 'codex-review', head_sha: row.head_sha,
      status: 'completed', conclusion: row.conclusion, app: { id: f.host.github.appId }, ...overrides } };
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    f.clock += 1000;
    for (const pr of f.prs.values()) {
      // Same semantics, changed normal PR metadata and receipt audit timestamp.
      pr.updated_at = new Date(f.clock).toISOString();
      f.store.updateApproval(f.store.latest(pr.number).publication_id, { arm_error: null }, f.clock);
    }
    await f.host.reconcile();
    assert.equal(f.host.lastReconcileCounts.failed, 0);
    for (const number of [1, 2, 3]) await deliver('check_run', status(number));
    if (cycle > 0) assert.deepEqual(laneReads.at(-1), [`/repos/${f.host.github.repo}/git/ref/heads/main`],
      'idempotent approved publication and its same-semantic webhook cannot repeat per-candidate discovery GETs');
  }
  assert.equal(f.evidenceWrites.length, 9, 'the original approved-review evidence PATCHes really ran, rather than being bypassed');
  assert.ok(f.evidenceWrites.every(({ body }) => body.output?.summary?.includes('verdict.decision: approve')));
  for (const change of ['conclusion', 'human-veto', 'head']) {
    if (change === 'conclusion') await deliver('check_run', status(1, { conclusion: 'failure' }));
    if (change === 'human-veto') {
      f.reviews.get(1).push({ id: 999, state: 'CHANGES_REQUESTED', user: { id: 999, login: 'human', type: 'User' } });
      await deliver('pull_request_review', { action: 'submitted', pull_request: f.prs.get(1) });
    }
    if (change === 'head') {
      const oldStatus = status(1);
      f.prs.get(1).head.sha = sha(111); f.approve(1); complete(1);
      await deliver('check_run', oldStatus);
    }
    await f.host.reconcile();
    assert.ok(laneReads.at(-1).some((path) => path.endsWith('/pulls/1')), `${change} must revoke unchanged-status reuse`);
    assert.ok(!f.store.activeMergeBatch(), 'hints and heartbeat echoes do not themselves admit a native mutation');
  }
  assert.deepEqual(f.nativeWrites, []);
});

for (const changed of [false, true]) test(`unsent merge budget refusal survives restart without wedging and rechecks authority (changed=${changed})`, async (t) => {
  const f = await fixture(t);
  const resume = transportMutation(f, 'PUT', `/repos/${REPOSITORY}/pulls/90/merge`);
  await f.advance();
  const batch = f.store.activeMergeBatch();
  assert.equal(batch.mutation, null);
  assert.equal(batch.operations.at(-1).intent.kind, 'merge');
  assert.equal(batch.operations.at(-1).receipt.outcome, 'not_dispatched');
  assert.deepEqual(f.merges, []);
  f.reopen(); resume();
  if (changed) f.requested.add(1);
  if (changed) await assert.rejects(f.advance(), /publication_cancelled/u);
  else await f.advance();
  assert.deepEqual(f.merges, changed ? [] : [90]);
});

test('budget refusal never clears an earlier uncertain merge intent or repeats the PUT', async (t) => {
  const f = await fixture(t);
  f.timeout = true;
  await assert.rejects(f.advance(), /github_timeout/u);
  const intent = f.store.activeMergeBatch().mutation;
  f.reopen();
  transportMutation(f, 'PUT', `/repos/${REPOSITORY}/pulls/90/merge`);
  await f.advance();
  assert.deepEqual(f.store.activeMergeBatch().mutation, intent);
  assert.deepEqual(f.merges, [90]);
});

test('unsent failed-only rerun does not consume its single retry across restart', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.prs.delete(2); f.prs.delete(90);
  deferNative(f, 1);
  const ci = f.ci.get(sha(1));
  const path = `/repos/${REPOSITORY}/actions/runs/${ci.id}/rerun-failed-jobs`;
  const remote = async (_method, _path, _body, guard) => {
    await f.originalRerun(f.store.activeMergeBatch(), ci, guard, { failedOnly: true });
    return {};
  };
  f.originalRerun = f.author.rerunCi.bind(f.author);
  f.author.rerunCi = (_batch, _ci, guard) => f.host.github.request('POST', path, undefined, guard);
  const resume = transportMutation(f, 'POST', path, remote);
  await f.advance();
  assert.equal(f.store.activeMergeBatch().mutation, null);
  assert.equal(f.store.activeMergeBatch().operations.at(-1).receipt.outcome, 'not_dispatched');
  assert.deepEqual(f.reruns, []);
  f.reopen(); resume();
  await f.advance();
  assert.equal(f.reruns.length, 1);
  assert.equal(f.reruns[0].failedOnly, true);
});

test('unsent source fold releases both lane intent and shepherd reservation before retry', async (t) => {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.store.selectMergeBatch({ ...f.batch, generation: 2, kind: 'single', state: 'selected', sealed: false,
    members: [f.batch.members[0]], target_pr: 1, target_node_id: 'PR_1', head_sha: sha(1),
    carrier_branch: null, manifest_digest: null, selected_at: ++f.clock, updated_at: f.clock });
  f.behind.set(1, 1);
  const resume = transportMutation(f, 'PUT', `/repos/${REPOSITORY}/pulls/1/update-branch`);
  await f.advance();
  assert.equal(f.store.activeMergeBatch().mutation, null);
  assert.equal(f.store.activeMergeBatch().operations.at(-1).receipt.outcome, 'not_dispatched');
  assert.equal(f.store.updateAttempt(1, sha(1), f.main), undefined);
  assert.equal(f.store.failedUpdate(1, sha(1)), undefined);
  assert.deepEqual(f.updates, []);
  f.reopen(); resume();
  const request = f.host.github.request.bind(f.host.github);
  f.host.github.request = (method, path, ...args) => method === 'GET' && path.endsWith('/labels/needs-update')
    ? Promise.resolve({ name: 'needs-update' }) : request(method, path, ...args);
  await f.advance();
  assert.deepEqual(f.updates, [1]);
});

async function unsealedSingleFixture(t) {
  const f = await fixture(t);
  f.store.retireMergeBatch(f.batch.id, 1, 'fixture-setup', ++f.clock);
  f.prs.delete(2); f.prs.delete(90);
  f.single = f.store.selectMergeBatch({ ...f.batch, id: 'unsealed-single', generation: 1,
    kind: 'single', state: 'selected', sealed: false, members: [f.batch.members[0]],
    target_pr: 1, target_node_id: 'PR_1', head_sha: sha(1), tree_sha: null,
    carrier_branch: null, manifest_digest: null, selected_at: ++f.clock, updated_at: f.clock });
  return f;
}

for (const merged of [false, true]) {
  test(`restarted uncertain update settles unchanged-head closed original (merged=${merged}) after one 503`, async (t) => {
    const f = await unsealedSingleFixture(t);
    f.lane.begin(f.single, 'update');
    f.reopen();
    const inspect = f.host.shepherd.inspect.bind(f.host.shepherd);
    let failed = false;
    f.host.shepherd.inspect = async (...args) => {
      if (!failed) { failed = true; throw new Error('GitHub request failed: GET /repos/example-org/example-project/pulls/1 HTTP 503'); }
      return inspect(...args);
    };
    Object.assign(f.prs.get(1), { state: 'closed', merged });
    await assert.rejects(f.advance(), /HTTP 503/u);
    assert.equal(f.store.activeMergeBatch().mutation.kind, 'update');
    assert.equal((await httpHealth(f)).status, 503);
    await f.advance();
    const retired = f.store.mergeBatch(f.single.id, 1);
    assert.equal(retired.mutation, null);
    assert.deepEqual(retired.operations.at(-1).receipt.outcome, 'settled');
    assert.equal(retired.operations.at(-1).receipt.reason, 'closed');
    assert.equal(retired.reason, 'source_closed');
    assert.equal(f.store.activeMergeBatch(), null);
    assert.equal((await httpHealth(f)).status, 200);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.merges, []);
  });
}

test('uncertain same-head open update survives restart and the selection stall interval', async (t) => {
  const f = await unsealedSingleFixture(t);
  f.lane.begin(f.single, 'update');
  f.reopen();
  f.clock += 2 * 60 * 60 * 1000;
  await f.advance();
  assert.equal(f.store.activeMergeBatch().mutation.kind, 'update');
  assert.equal(f.store.activeMergeBatch().operations.length, 0);
  assert.equal((await httpHealth(f)).status, 503);
  assert.deepEqual(f.updates, []);
});

test('unsealed selected readiness wait survives a 503, exposes cause, and retires after bounded no progress across restart', async (t) => {
  const f = await unsealedSingleFixture(t);
  const inspect = f.host.shepherd.inspect.bind(f.host.shepherd);
  f.host.shepherd.inspect = async () => { throw new Error('GitHub request failed: GET /repos/example-org/example-project/pulls/1 HTTP 503'); };
  await assert.rejects(f.advance(), /HTTP 503/u);
  f.host.shepherd.inspect = inspect;
  f.host.mergeReadiness = async () => ({ state: 'wait', reason: 'native_check_pending' });
  f.host.prepareReadiness = async () => ({ state: 'prepared', row: f.store.latest(1), ci: f.ci.get(sha(1)) });
  await f.advance();
  let current = f.store.activeMergeBatch();
  assert.equal(current.reason, 'selection_wait:readiness:wait:native_check_pending');
  assert.ok(f.lane.statusLines(1, current).some((line) => line.includes('native_check_pending')));
  const health = await httpHealth(f);
  assert.equal(health.status, 503);
  assert.equal(health.body.mergeFailures[0].reason, current.reason);
  const since = current.selection_wait.since;
  f.reopen();
  f.host.mergeReadiness = async () => ({ state: 'wait', reason: 'native_check_pending' });
  f.host.prepareReadiness = async () => ({ state: 'prepared', row: f.store.latest(1), ci: f.ci.get(sha(1)) });
  f.clock = since + 29 * 60 * 1000;
  await f.advance();
  assert.equal(f.store.activeMergeBatch().selection_wait.since, since);
  f.clock = since + 31 * 60 * 1000;
  await f.advance();
  current = f.store.mergeBatch(f.single.id, 1);
  assert.equal(current.state, 'invalidated');
  assert.equal(current.reason, 'selection_stalled');
  assert.equal(f.store.activeMergeBatch(), null);
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.updates, []);
});

test('fresh CI wait stays healthy and a new run resets the conservative no-progress clock', async (t) => {
  const f = await unsealedSingleFixture(t);
  f.ci.get(sha(1)).status = 'in_progress';
  await f.advance();
  const first = f.store.activeMergeBatch().selection_wait.since;
  assert.equal((await httpHealth(f)).status, 200);
  assert.match(f.store.activeMergeBatch().reason, /^selection_wait:preparation:wait/u);
  f.clock = first + 29 * 60 * 1000;
  f.ci.get(sha(1)).id++;
  await f.advance();
  const next = f.store.activeMergeBatch().selection_wait.since;
  assert.ok(next > first);
  f.clock = first + 31 * 60 * 1000;
  await f.advance();
  assert.equal(f.store.activeMergeBatch().selection_wait.since, next);
  assert.equal((await httpHealth(f)).status, 200);
  assert.deepEqual(f.merges, []);
});

test('sealed readiness wait is surfaced but never retired by the unsealed selection timeout', async (t) => {
  const f = await unsealedSingleFixture(t);
  f.lane.patch(f.single, { sealed: true, state: 'testing', tree_sha: sha(900), manifest_digest: 'f'.repeat(64) });
  f.host.prepareReadiness = async () => ({ state: 'wait', reason: 'review_pending' });
  await f.advance();
  const since = f.store.activeMergeBatch().selection_wait.since;
  f.clock = since + 2 * 60 * 60 * 1000;
  await f.advance();
  assert.equal(f.store.activeMergeBatch().state, 'testing');
  assert.equal(f.store.activeMergeBatch().sealed, true);
  assert.equal((await httpHealth(f)).status, 503);
  assert.deepEqual(f.merges, []);
});

test('fallback fresh-review wait exposes its actual gate and retires only the unsealed child', async (t) => {
  const f = await unsealedSingleFixture(t);
  f.store.updateMergeBatch(f.batch.id, 1, { state: 'fallback' });
  f.lane.patch(f.single, { fallback_of: { id: f.batch.id, generation: 1 } });
  f.ci.get(sha(1)).id++;
  const enqueued = [];
  f.host.enqueue = async (request) => { enqueued.push(request); };
  await f.advance();
  const current = f.store.activeMergeBatch();
  assert.equal(current.reason, 'selection_wait:fallback:waiting:fresh_review');
  assert.equal(enqueued[0].reason, 'batch_fallback');
  assert.equal((await httpHealth(f)).status, 200);
  f.clock = current.selection_wait.since + 31 * 60 * 1000;
  await f.advance();
  assert.equal(f.store.activeMergeBatch(), null);
  assert.equal(f.store.mergeBatch(f.single.id, 1).reason, 'selection_stalled');
  assert.equal(f.store.mergeBatch(f.batch.id, 1).state, 'fallback');
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.reruns, []);
});
