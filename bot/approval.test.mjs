import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubApp } from './github-app.mjs';
import { GitHubBudget } from './github-budget.mjs';
import { Store } from './store.mjs';
import { Approval } from './approval.mjs';
import { createAdmission } from './server.mjs';

const HEAD = 'a'.repeat(40);
const BOT = { id: 1002, login: 'example-review[bot]', type: 'Bot' };
const HUMAN = { id: 1004, login: 'example-owner', type: 'User' };
const guard = async () => {};
const humanReview = (state, id = 101, user = HUMAN) => ({ id, user, state, submitted_at: new Date(id).toISOString() });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'approval-test-'));
  const store = new Store(join(dir, 'state.sqlite'));
  t.after(async () => { store.db.close(); await rm(dir, { recursive: true, force: true }); });
  const calls = [], reviews = [];
  const pr = { node_id: 'PR_node', state: 'open', draft: false,
    head: { sha: HEAD, repo: { full_name: 'example-org/example-project' } },
    base: { ref: 'main', repo: { full_name: 'example-org/example-project' } }, auto_merge: null };
  const github = { appId: 1001, repo: 'example-org/example-project',
    async request(method, path, body, fence = guard) {
      await fence('before_send'); calls.push({ method, path, body });
      if (method === 'GET') return structuredClone(pr);
      if (method === 'POST') {
        const receipt = { id: reviews.length + 1, user: BOT, state: 'APPROVED', ...body };
        if (!options.rejectPost) reviews.push(receipt);
        if (options.uncertainPost || options.rejectPost) throw new Error('lost response');
        return receipt;
      }
      if (method === 'PUT') {
        if (options.rejectMerge) throw new Error('merge failed');
        pr.merged = true; pr.merged_by = options.mergedBy ?? BOT; pr.state = 'closed';
        if (options.uncertainMerge) throw new Error('lost response');
        return { merged: true };
      }
      throw new Error('Unexpected mutation');
    },
    async paginate(_path, _key, fence = guard) { await fence(); return structuredClone(reviews); },
    async graphql(query, variables) {
      calls.push({ method: 'GRAPHQL', query, variables });
      assert.match(query, /disablePullRequestAutoMerge\(input:/u, 'approval never enables auto-merge');
      pr.auto_merge = null;
      return { disablePullRequestAutoMerge: { pullRequest: { id: pr.node_id } } };
    } };
  const approval = new Approval({ store, github, mode: options.mode ?? 'approve',
    admit: options.admit ?? (async () => true), now: () => 123, log: options.log });
  const row = { id: 1, publication_id: 101, pr: 2, head_sha: HEAD, base_ref: 'main' };
  const report = { result: { pass: true }, verdict: { decision: 'approve' }, findings: [] };
  return { store, github, approval, row, report, calls, reviews, pr };
}
const posts = (f) => f.calls.filter((call) => call.method === 'POST');
const merges = (f) => f.calls.filter((call) => call.method === 'PUT');
const disables = (f) => f.calls.filter((call) => call.method === 'GRAPHQL');
const approve = (f) => f.approval.run(f.row, f.report);
const merge = (f, fence = guard) => f.approval.merge(f.row, fence);
const budgetRefusal = () => Object.assign(new Error('fixture budget exhausted'), {
  code: 'github_budget_deferred', retryAt: 4000000,
});
const restartApproval = (f) => {
  f.approval = new Approval({ store: f.store, github: f.github, mode: 'approve', admit: async () => true, now: () => 124 });
};

for (const [method, nth, reserved] of [
  ['GET', 1, false], ['GET', 2, true], ['GET', 3, true],
  ['paginate', 1, false], ['paginate', 2, true],
]) test(`budget refusal at ${method} ${nth} retries preflight after restart`, async (t) => {
  const f = await fixture(t);
  const request = f.github.request, paginate = f.github.paginate;
  let reads = 0;
  const refuse = () => { if (++reads === nth) throw budgetRefusal(); };
  f.github.request = async (verb, ...args) => {
    if (method === verb) refuse();
    return request(verb, ...args);
  };
  f.github.paginate = async (...args) => {
    if (method === 'paginate') refuse();
    return paginate(...args);
  };
  await assert.rejects(approve(f), error => error.code === 'github_budget_deferred' && error.retryAt === 4000000);
  assert.equal(f.store.approval(101)?.outcome, reserved ? 'approval_review_blocked' : undefined);
  assert.equal(posts(f).length, 0);
  f.github.request = request; f.github.paginate = paginate;
  restartApproval(f);
  assert.equal((await approve(f)).outcome, 'approved');
  assert.equal(posts(f).length, 1);
});

for (const nativeApproved of [false, true]) test(`a known-unsent preflight read failure recovers after restart (native approval=${nativeApproved})`, async (t) => {
  const f = await fixture(t), request = f.github.request;
  let reads = 0;
  f.github.request = async (method, ...args) => {
    if (method === 'GET' && ++reads === 2) throw new Error('GitHub request failed: GET /pulls/2 HTTP 503');
    return request(method, ...args);
  };
  assert.equal((await approve(f)).outcome, 'failed:preflight');
  assert.equal(posts(f).length, 0);
  f.github.request = request;
  if (nativeApproved) f.reviews.push({ id: 901, user: BOT, state: 'APPROVED', commit_id: HEAD,
    body: '<!-- codex-review approval 99 -->\nAn existing exact-head approval.' });
  restartApproval(f);
  const recovered = await approve(f);
  assert.equal(recovered.outcome, 'approved');
  assert.equal(recovered.head_sha, HEAD);
  assert.equal(posts(f).length, nativeApproved ? 0 : 1);
  if (nativeApproved) assert.equal(recovered.github_review_id, 901);
});

for (const read of ['live', 'human']) test(`nested ${read} budget refusal at first APPROVE fence safely retries`, async (t) => {
  const f = await fixture(t), request = f.github.request, paginate = f.github.paginate;
  let inPost = false, blocked = true;
  f.github.request = async (method, ...args) => {
    if (method === 'POST') inPost = true;
    if (method === 'GET' && inPost && blocked && read === 'live') throw budgetRefusal();
    return request(method, ...args);
  };
  f.github.paginate = async (...args) => {
    if (inPost && blocked && read === 'human') throw budgetRefusal();
    return paginate(...args);
  };
  await assert.rejects(approve(f), error => error.code === 'github_budget_deferred');
  assert.equal(f.store.approval(101).outcome, 'approval_review_blocked');
  assert.equal(posts(f).length, 0);
  blocked = false;
  restartApproval(f);
  assert.equal((await approve(f)).outcome, 'approved');
  assert.equal(posts(f).length, 1);
});

test('real transport reserve refusal after APPROVE authorization persists unsent proof across restart', async (t) => {
  const f = await fixture(t), request = f.github.request;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let now = 1000000, attempts = 0;
  const budget = new GitHubBudget({ store: f.store, scope: 'approval-test',
    now: () => now, limits: { presentation: { charge: 1, wire: 1 }, review: { charge: 1, wire: 1 } } });
  budget.settle(budget.reserve('review'), { status: 200, headers: new Headers() });
  const app = new GitHubApp({ appId: f.github.appId, repo: f.github.repo,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), budget, now: () => now,
    fetchImpl: async (_url, options) => {
      attempts++;
      const body = JSON.parse(options.body);
      const approved = { id: 99, user: BOT, state: 'APPROVED', ...body };
      f.reviews.push(approved);
      return new Response(JSON.stringify(approved), { status: 201 });
    } });
  f.github.request = (method, path, body, fence) => method === 'POST'
    ? app.send(method, path, body, 'fixture-token', fence)
    : request(method, path, body, fence);
  let retryAt;
  await assert.rejects(approve(f), error => {
    retryAt = error.retryAt;
    return error.code === 'github_budget_deferred' && retryAt > now;
  });
  assert.equal(attempts, 0);
  assert.equal(f.store.approval(101).outcome, 'approval_review_blocked');
  restartApproval(f);
  now = retryAt;
  assert.equal((await approve(f)).outcome, 'approved');
  assert.equal(attempts, 1);
  assert.equal(f.reviews[0].commit_id, HEAD);
});

for (const accepted of [true, false]) test(`budget-limited uncertain POST recovery never replays; accepted=${accepted}`, async (t) => {
  const f = await fixture(t, { uncertainPost: accepted, rejectPost: !accepted });
  const paginate = f.github.paginate;
  let blocked = true;
  f.github.paginate = async (...args) => {
    if (posts(f).length && blocked) throw budgetRefusal();
    return paginate(...args);
  };
  await assert.rejects(approve(f), error => error.code === 'github_budget_deferred');
  assert.equal(f.store.approval(101).outcome, 'reserved');
  assert.equal(posts(f).length, 1);
  restartApproval(f);
  await assert.rejects(approve(f), error => error.code === 'github_budget_deferred');
  assert.equal(f.store.approval(101).outcome, 'reserved');
  blocked = false;
  const receipt = await approve(f);
  assert.equal(receipt.outcome, accepted ? 'approved' : 'failed:approval_interrupted');
  assert.equal(receipt.github_review_id, accepted ? f.reviews[0].id : null);
  assert.equal(posts(f).length, 1);
});

for (const fence of ['head', 'human', 'publication']) test(`unsent budget retry rechecks ${fence} authority`, async (t) => {
  const f = await fixture(t), request = f.github.request;
  let reads = 0;
  f.github.request = async (method, ...args) => {
    if (method === 'GET' && ++reads === 2) throw budgetRefusal();
    return request(method, ...args);
  };
  await assert.rejects(approve(f), error => error.code === 'github_budget_deferred');
  assert.equal(f.store.approval(101).outcome, 'approval_review_blocked');
  f.github.request = request;
  restartApproval(f);
  if (fence === 'head') f.pr.head.sha = 'b'.repeat(40);
  if (fence === 'human') f.reviews.push(humanReview('CHANGES_REQUESTED'));
  assert.equal(await f.approval.run(f.row, f.report, async () => {
    if (fence === 'publication') throw new Error('publication_cancelled');
  }), null);
  assert.equal(posts(f).length, 0);
});

test('run posts exactly one exact-head approval and never arms or merges', async (t) => {
  const f = await fixture(t);
  const receipt = await approve(f);
  assert.equal(receipt.outcome, 'approved'); assert.equal(receipt.armed, 0);
  assert.equal(receipt.github_review_id, f.reviews[0].id);
  assert.equal(posts(f)[0].body.event, 'APPROVE'); assert.equal(posts(f)[0].body.commit_id, HEAD);
  assert.match(posts(f)[0].body.body, /^<!-- codex-review approval 101 -->\n/u);
  const count = f.calls.length;
  assert.deepEqual(await approve(f), receipt);
  assert.equal(f.calls.length, count);
  assert.equal(disables(f).length + merges(f).length, 0);
});

for (const match of ['exact', 'absent', 'wrong-marker', 'wrong-head', 'wrong-bot']) {
  test(`restart adopts only exact unfinished approval: ${match}`, async (t) => {
    const f = await fixture(t);
    f.store.reserveApproval(f.row, f.pr.node_id, 123);
    if (match !== 'absent') f.reviews.push({ id: 9, user: match === 'wrong-bot' ? HUMAN : BOT, state: 'APPROVED',
      commit_id: match === 'wrong-head' ? 'b'.repeat(40) : HEAD,
      body: `<!-- codex-review approval ${match === 'wrong-marker' ? 102 : 101} -->\nApproved` });
    const receipt = await approve(f);
    assert.equal(receipt.outcome, match === 'exact' ? 'approved' : 'failed:approval_interrupted');
    assert.equal(receipt.github_review_id, match === 'exact' ? 9 : null);
    await approve(f);
    assert.equal(posts(f).length + merges(f).length + disables(f).length, 0);
  });
}

for (const uncertainPost of [true, false]) test(`uncertain approval is never reposted; sent=${uncertainPost}`, async (t) => {
  const f = await fixture(t, { uncertainPost, rejectPost: !uncertainPost });
  assert.equal((await approve(f)).outcome, uncertainPost ? 'approved' : 'failed:approval_unconfirmed');
  await approve(f);
  assert.equal(posts(f).length, 1); assert.equal(merges(f).length, 0);
});

test('cancellation before send prevents POST and never becomes merge authority', async (t) => {
  const f = await fixture(t);
  const request = f.github.request;
  let cancelled = false;
  f.github.request = async (method, ...args) => {
    if (method === 'POST') cancelled = true;
    return request(method, ...args);
  };
  const receipt = await f.approval.run(f.row, f.report, async () => {
    if (cancelled) throw new Error('publication_cancelled');
  });
  assert.equal(receipt.outcome, 'failed:publication_cancelled');
  assert.equal(posts(f).length + merges(f).length, 0);
});

test('cancellation after uncertain send still adopts the exact posted approval', async (t) => {
  const f = await fixture(t, { uncertainPost: true });
  let cancelled = false;
  const request = f.github.request;
  f.github.request = async (method, ...args) => {
    try { return await request(method, ...args); } finally { if (method === 'POST') cancelled = true; }
  };
  assert.equal((await f.approval.run(f.row, f.report, async () => {
    if (cancelled) throw new Error('publication_cancelled');
  })).outcome, 'approved');
  assert.equal(posts(f).length, 1); assert.equal(merges(f).length, 0);
});

for (const reason of ['advisory', 'admission', 'nonpass', 'block', 'ambiguous', 'base']) {
  test(`ineligible ${reason} does not reserve or mutate`, async (t) => {
    const f = await fixture(t);
    if (reason === 'advisory') f.approval.mode = 'advisory';
    if (reason === 'admission') f.approval.admit = async () => false;
    if (reason === 'nonpass') f.report.result.pass = false;
    if (['block', 'ambiguous'].includes(reason)) f.report.verdict.decision = reason;
    if (reason === 'base') f.row.base_ref = 'release';
    assert.equal(await approve(f), null);
    assert.equal(f.store.approval(101), undefined); assert.deepEqual(f.calls, []);
  });
}

const invalidLive = {
  head: (f) => { f.pr.head.sha = 'b'.repeat(40); },
  base: (f) => { f.pr.base.ref = 'release'; },
  fork: (f) => { f.pr.head.repo.full_name = 'other/repo'; },
  baseRepo: (f) => { f.pr.base.repo.full_name = 'other/repo'; },
  draft: (f) => { f.pr.draft = true; },
  closed: (f) => { f.pr.state = 'closed'; },
  identity: (f) => { f.pr.node_id = null; },
  conflicts: (f) => { f.pr.mergeable = false; },
};
for (const [reason, change] of Object.entries(invalidLive)) {
  test(`invalid ${reason} preflight prevents approval`, async (t) => {
    const f = await fixture(t); change(f);
    assert.equal(await approve(f), null); assert.equal(f.store.approval(101), undefined);
    assert.equal(posts(f).length, 0);
  });
  test(`late ${reason} at APPROVE boundary prevents POST`, async (t) => {
    const f = await fixture(t), request = f.github.request;
    f.github.request = async (method, ...args) => { if (method === 'POST') change(f); return request(method, ...args); };
    assert.match((await approve(f)).outcome, /^failed:/u); assert.equal(posts(f).length, 0);
  });
  test(`late ${reason} at merge boundary prevents PUT`, async (t) => {
    const f = await fixture(t); await approve(f);
    const request = f.github.request;
    f.github.request = async (method, ...args) => { if (method === 'PUT') change(f); return request(method, ...args); };
    await assert.rejects(merge(f), /approval_/u);
    assert.equal(merges(f).length, 0); assert.equal(f.store.approval(101).outcome, 'approved');
  });
}

for (const phase of ['preflight', 'before_send']) for (const failure of ['veto', 'read']) {
  test(`${phase} human ${failure} blocks approval and can retry`, async (t) => {
    const f = await fixture(t), request = f.github.request, paginate = f.github.paginate;
    let blocked = phase === 'preflight';
    f.github.request = async (method, ...args) => {
      if (method === 'POST' && phase === 'before_send') blocked = true;
      return request(method, ...args);
    };
    f.github.paginate = async (...args) => {
      if (blocked && failure === 'read') throw new Error('reviews unavailable');
      const reviews = await paginate(...args);
      return blocked ? [...reviews, humanReview('CHANGES_REQUESTED')] : reviews;
    };
    assert.equal(await approve(f), null); assert.equal(posts(f).length, 0);
    assert.equal(f.store.approval(101), undefined);
    blocked = false; f.github.request = request;
    assert.equal((await approve(f)).outcome, 'approved');
    assert.equal(posts(f).length, 1); assert.equal(disables(f).length + merges(f).length, 0);
  });
}

for (const state of ['COMMENTED', 'PENDING', 'APPROVED', 'DISMISSED']) {
  test(`human CHANGES_REQUESTED followed by ${state} uses effective decision state`, async (t) => {
    const f = await fixture(t);
    f.reviews.push(humanReview('CHANGES_REQUESTED'), humanReview(state, 102));
    const veto = ['COMMENTED', 'PENDING'].includes(state);
    assert.equal((await approve(f))?.outcome ?? null, veto ? null : 'approved');
    assert.equal(posts(f).length, veto ? 0 : 1);
  });
}
test('human veto is per author, not latest global review', async (t) => {
  const f = await fixture(t);
  f.reviews.push(humanReview('CHANGES_REQUESTED'), humanReview('APPROVED', 102, { ...HUMAN, id: 99 }));
  assert.equal(await approve(f), null); assert.equal(posts(f).length, 0);
});

test('late head change during approval human-review read is fenced', async (t) => {
  const f = await fixture(t), paginate = f.github.paginate;
  let readingBeforeSend = false;
  const request = f.github.request;
  f.github.request = async (method, ...args) => { if (method === 'POST') readingBeforeSend = true; return request(method, ...args); };
  f.github.paginate = async (...args) => {
    const reviews = await paginate(...args);
    if (readingBeforeSend) f.pr.head.sha = 'b'.repeat(40);
    return reviews;
  };
  assert.equal((await approve(f)).outcome, 'failed:approval_head_changed'); assert.equal(posts(f).length, 0);
});

test('explicit merge uses the exact SHA and records the existing receipt', async (t) => {
  const f = await fixture(t); const receipt = await approve(f);
  let guarded = 0;
  const merged = await merge(f, async () => { guarded++; });
  assert.equal(merged.outcome, 'merged_direct'); assert.equal(merged.armed, 0);
  assert.equal(merged.github_review_id, receipt.github_review_id);
  assert.deepEqual(merges(f).map(({ path, body }) => ({ path, body })), [{
    path: '/repos/example-org/example-project/pulls/2/merge', body: { sha: HEAD, merge_method: 'merge' },
  }]);
  assert.ok(guarded > 1); assert.equal(disables(f).length, 0);
  assert.equal((await merge(f)).outcome, 'merged_direct'); assert.equal(merges(f).length, 1);
});

test('merge requires an explicit parent guard and an approved durable receipt', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.approval.merge(f.row), /approval_merge_guard_required/u);
  assert.equal(await merge(f), null); assert.equal(merges(f).length, 0);
});
for (const reason of ['mode', 'admission', 'guard', 'late-admission', 'late-mode']) {
  test(`merge cannot bypass ${reason}`, async (t) => {
    const f = await fixture(t); await approve(f);
    if (reason === 'mode') f.approval.mode = 'advisory';
    if (reason === 'admission') f.approval.admit = async () => false;
    const request = f.github.request;
    f.github.request = async (method, ...args) => {
      if (method === 'PUT' && reason === 'late-admission') f.approval.admit = async () => false;
      if (method === 'PUT' && reason === 'late-mode') f.approval.mode = 'off';
      return request(method, ...args);
    };
    if (['mode', 'admission'].includes(reason)) assert.equal(await merge(f), null);
    else await assert.rejects(merge(f, async () => { if (reason === 'guard') throw new Error('publication_cancelled'); }));
    assert.equal(merges(f).length, 0); assert.equal(f.store.approval(101).outcome, 'approved');
  });
}
for (const reason of ['dismissed', 'wrong-head', 'wrong-user', 'wrong-id', 'missing', 'wrong-node', 'wrong-row']) {
  test(`merge rejects ${reason} approval receipt`, async (t) => {
    const f = await fixture(t); await approve(f);
    if (reason === 'dismissed') f.reviews[0].state = 'DISMISSED';
    if (reason === 'wrong-head') f.reviews[0].commit_id = 'b'.repeat(40);
    if (reason === 'wrong-user') f.reviews[0].user = HUMAN;
    if (reason === 'wrong-id') f.reviews[0].id = 999;
    if (reason === 'missing') f.reviews.length = 0;
    if (reason === 'wrong-node') f.pr.node_id = 'other-node';
    if (reason === 'wrong-row') f.row.pr = 3;
    await assert.rejects(merge(f), /approval_/u); assert.equal(merges(f).length, 0);
  });
}
for (const late of [false, true]) for (const failure of ['veto', 'read', 'malformed']) {
  test(`merge fails closed on human ${failure}, late=${late}`, async (t) => {
    const f = await fixture(t); await approve(f);
    const request = f.github.request, paginate = f.github.paginate;
    let blocked = !late;
    f.github.request = async (method, ...args) => { if (method === 'PUT') blocked = true; return request(method, ...args); };
    f.github.paginate = async (...args) => {
      if (blocked && failure === 'read') throw new Error('reviews unavailable');
      const reviews = await paginate(...args);
      if (!blocked) return reviews;
      return [...reviews, failure === 'malformed' ? { state: 'CHANGES_REQUESTED', user: HUMAN } : humanReview('CHANGES_REQUESTED')];
    };
    if (!late && failure === 'veto') assert.equal(await merge(f), null);
    else await assert.rejects(merge(f));
    assert.equal(merges(f).length, 0); assert.equal(f.store.approval(101).outcome, 'approved');
  });
}

test('head change during merge review read is fenced after the read', async (t) => {
  const f = await fixture(t); await approve(f);
  const paginate = f.github.paginate;
  f.github.paginate = async (...args) => { const reviews = await paginate(...args); f.pr.head.sha = 'b'.repeat(40); return reviews; };
  await assert.rejects(merge(f), /approval_head_changed/u); assert.equal(merges(f).length, 0);
});

for (const owner of ['own', 'human', 'wrong-id', 'wrong-login', 'wrong-head', 'wrong-repo', 'not-merged']) {
  test(`uncertain merge adopts only same-head own-App merge: ${owner}`, async (t) => {
    const f = await fixture(t, { uncertainMerge: true }); await approve(f);
    const request = f.github.request;
    f.github.request = async (method, ...args) => {
      try { return await request(method, ...args); } catch (error) {
        if (method === 'PUT') {
          if (owner === 'human') f.pr.merged_by = HUMAN;
          if (owner === 'wrong-id') f.pr.merged_by = { ...BOT, id: 42 };
          if (owner === 'wrong-login') f.pr.merged_by = { ...BOT, login: 'other[bot]' };
          if (owner === 'wrong-head') f.pr.head.sha = 'b'.repeat(40);
          if (owner === 'wrong-repo') f.pr.head.repo.full_name = 'other/repo';
          if (owner === 'not-merged') f.pr.merged = false;
        }
        throw error;
      }
    };
    if (owner === 'own') assert.equal((await merge(f)).outcome, 'merged_direct');
    else { await assert.rejects(merge(f), /lost response/u); assert.equal(f.store.approval(101).outcome, 'approved'); }
    assert.equal(merges(f).length, 1);
  });
}

test('failed merge throws without destroying the approved receipt', async (t) => {
  const f = await fixture(t, { rejectMerge: true }); await approve(f);
  await assert.rejects(merge(f), /merge failed/u);
  assert.equal(f.store.approval(101).outcome, 'approved');
  await approve(f); assert.equal(merges(f).length, 1); assert.equal(posts(f).length, 1);
});
test('unconfirmed merge response throws unless live own-App merge proves success', async (t) => {
  const f = await fixture(t); await approve(f);
  const request = f.github.request;
  f.github.request = async (method, path, body, fence) => {
    if (method !== 'PUT') return request(method, path, body, fence);
    await fence('before_send'); return { merged: false };
  };
  await assert.rejects(merge(f), /approval_merge_unconfirmed/u);
  assert.equal(f.store.approval(101).outcome, 'approved');
});

for (const owner of [BOT, HUMAN]) test(`restart after merge adopts only our App: ${owner.login}`, async (t) => {
  const f = await fixture(t); await approve(f);
  f.pr.merged = true; f.pr.state = 'closed'; f.pr.merged_by = owner;
  if (owner === BOT) assert.equal((await merge(f)).outcome, 'merged_direct');
  else {
    await assert.rejects(merge(f), /approval_closed/u);
    assert.equal(f.store.approval(101).outcome, 'approved');
  }
  assert.equal(merges(f).length, 0);
});

test('parent cancellation at the PUT boundary prevents merge', async (t) => {
  const f = await fixture(t); await approve(f);
  const request = f.github.request;
  let cancelled = false;
  f.github.request = async (method, ...args) => {
    if (method === 'PUT') cancelled = true;
    return request(method, ...args);
  };
  await assert.rejects(merge(f, async () => {
    if (cancelled) throw new Error('publication_cancelled');
  }), /publication_cancelled/u);
  assert.equal(merges(f).length, 0); assert.equal(f.store.approval(101).outcome, 'approved');
});

for (const state of ['COMMENTED', 'PENDING', 'APPROVED', 'DISMISSED']) {
  test(`merge checks effective human veto after approval: ${state}`, async (t) => {
    const f = await fixture(t); await approve(f);
    f.reviews.push(humanReview('CHANGES_REQUESTED'), humanReview(state, 102));
    const veto = ['COMMENTED', 'PENDING'].includes(state);
    assert.equal((await merge(f))?.outcome ?? null, veto ? null : 'merged_direct');
    assert.equal(merges(f).length, veto ? 0 : 1);
  });
}

test('restart releases a proven-unsent blocked reservation before retrying approval', async (t) => {
  const f = await fixture(t);
  f.store.reserveApproval(f.row, f.pr.node_id, 123);
  f.store.updateApproval(101, { outcome: 'approval_review_blocked' }, 123);
  assert.equal((await approve(f)).outcome, 'approved');
  assert.equal(posts(f).length, 1); assert.equal(merges(f).length, 0);
});

test('terminal interrupted approval and dismissed confirmed approval are never reposted', async (t) => {
  const f = await fixture(t); await approve(f);
  f.reviews[0].state = 'DISMISSED';
  assert.equal((await approve(f)).outcome, 'approved');
  f.store.updateApproval(101, { outcome: 'failed:approval_interrupted' }, 124);
  assert.equal((await approve(f)).outcome, 'failed:approval_interrupted');
  assert.equal(posts(f).length, 1); assert.equal(merges(f).length, 0);
});

for (const owner of ['bot', 'human', 'wrong-id', 'wrong-login']) test(`disable legacy request only for exact bot ownership: ${owner}`, async (t) => {
  const f = await fixture(t); await approve(f);
  f.store.updateApproval(101, { armed: 1 }, 124);
  const actor = owner === 'bot' ? BOT : owner === 'human' ? HUMAN
    : owner === 'wrong-id' ? { ...BOT, id: 42 } : { ...BOT, login: 'other[bot]' };
  f.pr.auto_merge = { enabled_by: actor };
  await f.approval.disable(f.row.pr);
  assert.equal(disables(f).length, owner === 'bot' ? 1 : 0);
  assert.equal(f.store.approval(101).armed, 0);
  if (owner !== 'bot') assert.deepEqual(f.pr.auto_merge, { enabled_by: actor });
});
test('disable without durable owned intent never mutates a human request', async (t) => {
  const f = await fixture(t); f.pr.auto_merge = { enabled_by: HUMAN };
  await approve(f); assert.equal(await f.approval.disable(f.row.pr), false);
  assert.equal(disables(f).length + merges(f).length, 0); assert.deepEqual(f.pr.auto_merge, { enabled_by: HUMAN });
});
test('disable identity mismatch retains legacy armed intent', async (t) => {
  const f = await fixture(t); await approve(f); f.store.updateApproval(101, { armed: 1 }, 124);
  f.pr.node_id = 'different'; f.pr.auto_merge = { enabled_by: BOT };
  await assert.rejects(f.approval.disable(2), /approval_identity_missing/u);
  assert.equal(f.store.approval(101).armed, 1); assert.equal(disables(f).length, 0);
});

test('wrong App/repository binding is rejected before mutation', () => {
  for (const github of [{ appId: 42, repo: 'example-org/example-project' }, { appId: 1001, repo: 'other/repo' }]) {
    assert.throws(() => new Approval({ store: {}, github, mode: 'approve' }), /binding/u);
  }
});
test('default admission never authorizes approval', async (t) => {
  const f = await fixture(t);
  const approval = new Approval({ store: f.store, github: f.github, mode: 'approve' });
  assert.equal(await approval.run(f.row, f.report), null); assert.deepEqual(f.calls, []);
});
test('cached positive cannot authorize approval after gateway loss', async (t) => {
  let ready = true;
  const admission = createAdmission({ mode: 'approve', now: () => 1000000,
    gatewayUrl: 'http://gateway:4000', token: 'fixture-token', judgeToken: 'fixture-judge-token', fetchImpl: async () => {
      if (!ready) throw new Error('Gateway unavailable');
      return { ok: true, json: async () => ({ credentials: [{ provider: 'openai-codex', type: 'oauth', ok: true }] }) };
    } });
  await admission.refresh(); ready = false;
  const f = await fixture(t, { admit: async () => (await admission.refresh({ fresh: true })).mode === 'approve' });
  assert.equal(await approve(f), null); assert.deepEqual(f.calls, []); assert.equal(admission.state.mode, 'advisory');
});
