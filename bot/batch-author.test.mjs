import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { BatchAuthor, carrierBranch, carrierMarker } from './batch-author.mjs';
import { manifestDigest } from './batch-plan.mjs';
import { BUILDER_BOT, REVIEW_BOT, REVIEW_APP_ID, REPOSITORY } from './identity.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const now = Date.parse('2026-10-18T12:00:00Z');
const sha = (n) => n.toString(16).padStart(40, '0');
function batch() {
  const value = { id: 'author-proof', generation: 1, kind: 'batch', sealed: true,
    base_sha: sha(1), head_sha: sha(2), tree_sha: sha(3),
    members: [7, 8].map((pr) => ({ pr, head_sha: sha(pr), review_id: pr + 10,
      publication_id: pr + 20, github_review_id: pr + 30, pull_request_id: `PR_${pr}`,
      ci_run_id: pr + 40, ci_attempt: 1, priority: null, created_at: '2026-10-01T00:00:00Z' })) };
  value.manifest_digest = manifestDigest(value);
  value.carrier_branch = carrierBranch(value);
  return value;
}
function fixture() {
  const state = {
    app: { id: REVIEW_APP_ID + 100, slug: BUILDER_BOT.login.slice(0, -5) },
    installation: { id: 812, app_id: REVIEW_APP_ID + 100, suspended_at: null,
      repository_selection: 'selected', account: { login: REPOSITORY.split('/')[0] },
      permissions: { contents: 'write', pull_requests: 'write', workflows: 'write' } },
    user: { ...BUILDER_BOT, type: 'Bot' }, repositories: [{ full_name: REPOSITORY }],
    pulls: [], created: null, calls: [], reruns: [], workflow: { id: 321 }, run: null, beforeRunRead: null,
  };
  const fetchImpl = async (url, options = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = options.method ?? 'GET';
    state.calls.push({ method, pathname, body: options.body && JSON.parse(options.body) });
    const bearer = options.headers.Authorization.slice('Bearer '.length);
    if (bearer !== 'offline-installation-token') {
      const parts = bearer.split('.');
      assert.equal(parts.length, 3);
      assert.equal(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), publicKey,
        Buffer.from(parts[2], 'base64url')), true, 'only the ephemeral fixture key signs JWTs');
    }
    let result;
    if (method === 'GET' && pathname === '/app') result = state.app;
    else if (method === 'GET' && pathname === `/repos/${REPOSITORY}/installation`) result = state.installation;
    else if (method === 'POST' && pathname === '/app/installations/812/access_tokens') {
      assert.deepEqual(JSON.parse(options.body), { repositories: [REPOSITORY.split('/')[1]] });
      result = { token: 'offline-installation-token', expires_at: '2026-10-18T13:00:00Z' };
    } else if (method === 'GET' && pathname === `/users/${encodeURIComponent(BUILDER_BOT.login)}`) result = state.user;
    else if (method === 'GET' && pathname === '/installation/repositories') {
      const page = Number(searchParams.get('page'));
      result = { repositories: state.repositories.slice((page - 1) * 100, page * 100) };
    } else if (method === 'GET' && pathname === `/repos/${REPOSITORY}/pulls`) {
      const page = Number(searchParams.get('page'));
      result = state.pulls.slice((page - 1) * 100, page * 100);
    } else if (method === 'POST' && pathname === `/repos/${REPOSITORY}/pulls`) result = state.created;
    else if (method === 'GET' && pathname === `/repos/${REPOSITORY}/actions/workflows/ci.yml`) result = state.workflow;
    else if (method === 'GET' && pathname === `/repos/${REPOSITORY}/actions/runs/777`) {
      state.beforeRunRead?.();
      result = state.run;
    } else if (method === 'POST' && [`/repos/${REPOSITORY}/actions/runs/777/rerun`, `/repos/${REPOSITORY}/actions/runs/777/rerun-failed-jobs`].includes(pathname)) {
      state.reruns.push(state.run.id);
      state.run = { ...state.run, run_attempt: state.run.run_attempt + 1, status: 'queued' };
      return new Response(null, { status: 204 });
    }
    else throw new Error(`Unexpected offline request: ${method} ${pathname}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  return { state, author: new BatchAuthor({ clientId: 'IvOfflineBuilder', privateKey,
    fetchImpl, now: () => now }) };
}
function carrier(value, extra = {}) {
  return { number: 90, node_id: 'PR_carrier', user: { ...BUILDER_BOT },
    head: { ref: carrierBranch(value), sha: value.head_sha, repo: { full_name: REPOSITORY } },
    base: { ref: 'main', repo: { full_name: REPOSITORY } },
    body: `${carrierMarker(value)}\n\nCarrier`, ...extra };
}
const authored = (state) => state.calls.filter((call) => call.method === 'POST'
  && call.pathname === `/repos/${REPOSITORY}/pulls`);

test('proven Builder uses its configured native bot user and repository-only token', async () => {
  const { author, state } = fixture();
  const proof = await author.prove();
  assert.deepEqual(proof.user, { id: BUILDER_BOT.id, login: BUILDER_BOT.login });
  assert.equal(proof.repository, REPOSITORY);
  assert.notEqual(proof.app_id, REVIEW_APP_ID);
  assert.equal((await author.credentials()).token, 'offline-installation-token');
  const value = batch();
  state.created = carrier(value);
  assert.equal((await author.createCarrier(value, 'Offline proof')).number, 90);
  assert.equal(authored(state).length, 1);
});

test('Review App identity cannot acquire credentials or author even with Builder-shaped slug', async () => {
  const { author, state } = fixture();
  state.app.id = REVIEW_APP_ID;
  state.installation.app_id = REVIEW_APP_ID;
  await assert.rejects(author.credentials(), /builder_app_identity_mismatch/u);
  await assert.rejects(author.createCarrier(batch(), 'Forbidden'), /builder_app_identity_mismatch/u);
  assert.equal(authored(state).length, 0);
  assert.equal(state.calls.some((call) => call.pathname.endsWith('/access_tokens')), false);
});

for (const [name, change, error] of [
  ['wrong native user ID', (s) => { s.user.id = BUILDER_BOT.id + 1; }, /builder_user_identity_mismatch/u],
  ['Review bot user', (s) => { s.user = { ...REVIEW_BOT, type: 'Bot' }; }, /builder_user_identity_mismatch/u],
  ['wrong native login', (s) => { s.user.login = 'impostor[bot]'; }, /builder_user_identity_mismatch/u],
  ['non-bot user', (s) => { s.user.type = 'User'; }, /builder_user_identity_mismatch/u],
  ['all-repository installation', (s) => { s.installation.repository_selection = 'all'; }, /builder_installation_identity_mismatch/u],
  ['wrong installation App', (s) => { s.installation.app_id += 1; }, /builder_installation_identity_mismatch/u],
  ['wrong installation owner', (s) => { s.installation.account.login = 'elsewhere'; }, /builder_installation_identity_mismatch/u],
  ['suspended installation', (s) => { s.installation.suspended_at = '2026-10-18'; }, /builder_installation_identity_mismatch/u],
  ['extra token repository', (s) => { s.repositories.push({ full_name: 'elsewhere/private' }); }, /builder_token_repository_scope_mismatch/u],
  ['wrong token repository', (s) => { s.repositories = [{ full_name: 'elsewhere/private' }]; }, /builder_token_repository_scope_mismatch/u],
  ['missing workflow write', (s) => { delete s.installation.permissions.workflows; }, /builder_permission_missing:workflows:write/u],
  ['read-only workflow permission', (s) => { s.installation.permissions.workflows = 'read'; }, /builder_permission_missing:workflows:write/u],
]) {
  test(`${name} refuses carrier authorship`, async () => {
    const { author, state } = fixture();
    change(state);
    await assert.rejects(author.createCarrier(batch(), 'Forbidden'), error);
    assert.equal(authored(state).length, 0);
  });
}

test('carrier creation refreshes a previously successful permission proof', async () => {
  const { author, state } = fixture();
  await author.prove();
  state.installation.permissions.workflows = 'read';
  await assert.rejects(author.createCarrier(batch(), 'Forbidden'), /builder_permission_missing:workflows:write/u);
  assert.equal(authored(state).length, 0);
});

test('ambiguous carrier adoption across pagination refuses without posting another PR', async () => {
  const { author, state } = fixture();
  const value = batch();
  state.pulls = [carrier(value), ...Array.from({ length: 99 }, (_, index) => ({ number: index + 1000 })),
    carrier(value, { number: 91, node_id: 'PR_duplicate' })];
  await assert.rejects(author.findCarrier(value), /batch_carrier_adoption_ambiguous/u);
  assert.equal(authored(state).length, 0);
});

test('carrier marker cannot substitute for native author or repository identity', async () => {
  const { author, state } = fixture();
  const value = batch();
  state.pulls = [carrier(value, { user: { ...REVIEW_BOT } }),
    carrier(value, { user: { ...BUILDER_BOT, id: BUILDER_BOT.id + 1 } }),
    carrier(value, { head: { ref: carrierBranch(value), repo: { full_name: 'elsewhere/fork' } } })];
  assert.equal(await author.findCarrier(value), null);
  assert.equal(authored(state).length, 0);
});

test('an exactly authored carrier is adopted even after head drift, not recreated', async () => {
  const { author, state } = fixture();
  const value = batch();
  const moved = carrier(value);
  moved.head.sha = sha(999);
  moved.base.ref = 'other';
  state.pulls = [moved];
  assert.equal((await author.findCarrier(value)).head.sha, sha(999));
  assert.equal(authored(state).length, 0);
});

for (const failedOnly of [false, true]) for (const drift of ['actions-read', 'wrong-head', 'wrong-workflow', 'wrong-repository', 'wrong-attempt', 'late-head', 'running', 'wrong-event']) {
  test(`canonical ${failedOnly ? 'failed-only' : 'full'} rerun rejects changed authority: ${drift}`, async () => {
    const { author, state } = fixture();
    const value = batch();
    state.installation.permissions.actions = drift === 'actions-read' ? 'read' : 'write';
    state.run = { id: 777, workflow_id: 321, head_sha: value.head_sha, run_attempt: 1,
      head_repository: { full_name: REPOSITORY }, event: 'pull_request', status: 'completed' };
    if (drift === 'wrong-head') state.run.head_sha = sha(999);
    if (drift === 'wrong-workflow') state.run.workflow_id = 322;
    if (drift === 'wrong-repository') state.run.head_repository.full_name = 'other/repository';
    if (drift === 'wrong-attempt') state.run.run_attempt = 2;
    if (drift === 'running') state.run.status = 'in_progress';
    if (drift === 'wrong-event') state.run.event = 'push';
    if (drift === 'late-head') {
      let reads = 0;
      state.beforeRunRead = () => { if (++reads === 2) state.run.head_sha = sha(999); };
    }
    await assert.rejects(author.rerunCi(value, { id: 777, run_attempt: 1 }, async () => {}, { failedOnly }));
    assert.deepEqual(state.reruns, []);
  });
}

test('a canonical completed source rerun needs write permission and its own final send fence', async () => {
  const { author, state } = fixture();
  const value = batch();
  state.installation.permissions.actions = 'write';
  state.run = { id: 777, workflow_id: 321, head_sha: value.head_sha, run_attempt: 1,
    head_repository: { full_name: REPOSITORY }, event: 'pull_request', status: 'completed' };
  await assert.rejects(author.rerunCi(value, { id: 777, run_attempt: 1 }, async (phase) => {
    if (phase === 'before_send') throw new Error('source authorization revoked');
  }));
  assert.deepEqual(state.reruns, []);
  await author.rerunCi(value, { id: 777, run_attempt: 1 });
  assert.equal(state.run.status, 'queued');
  assert.equal(state.run.run_attempt, 2);
  assert.deepEqual(state.reruns, [777]);
});

test('failed-only native resumption uses only the failed-jobs endpoint with the final send fence', async () => {
  const { author, state } = fixture();
  const value = batch();
  state.installation.permissions.actions = 'write';
  state.run = { id: 777, workflow_id: 321, head_sha: value.head_sha, run_attempt: 1,
    head_repository: { full_name: REPOSITORY }, event: 'pull_request', status: 'completed' };
  await assert.rejects(author.rerunCi(value, { id: 777, run_attempt: 1 }, async (phase) => {
    if (phase === 'before_send') throw new Error('source authorization revoked');
  }, { failedOnly: true }));
  assert.deepEqual(state.reruns, []);
  await author.rerunCi(value, { id: 777, run_attempt: 1 }, async () => {}, { failedOnly: true });
  assert.deepEqual(state.reruns, [777]);
  assert.equal(state.run.run_attempt, 2);
  assert.ok(state.calls.some((call) => call.pathname.endsWith('/rerun-failed-jobs')));
  assert.ok(!state.calls.some((call) => call.pathname.endsWith('/rerun')));
});
