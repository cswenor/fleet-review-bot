import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchMirror } from './batch-mirror.mjs';
import { carrierBranch } from './batch-author.mjs';
import { ancestryViolations } from './batch-plan.mjs';
import { executeProcess } from './subprocess.mjs';
import { BUILDER_BOT, REVIEW_BOT, REPOSITORY } from './identity.mjs';

// Only transport is substituted: Git really fetches and pushes a disposable bare
// repository. All merge/tree/parent/ancestry/ref-lease operations run unchanged.
// No command is allowed to contact GitHub, read ambient credentials, or check out.
async function fixture(t, { filtering = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'batch-mirror-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'origin.git');
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Offline fixture', GIT_COMMITTER_NAME: 'Offline fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '@1792324800 +0000', GIT_COMMITTER_DATE: '@1792324800 +0000' };
  const run = async (directory, args, input, extraEnv = {}) => (await executeProcess('git',
    ['-c', 'core.hooksPath=/dev/null', `--git-dir=${directory}`, ...args],
    { env: { ...env, ...extraEnv }, input })).stdout.trim();
  await executeProcess('git', ['init', '--bare', remote], { env });
  if (filtering) await run(remote, ['config', 'uploadpack.allowFilter', 'true']);
  let sequence = 0;
  async function commit(parent, changes, message = 'fixture') {
    const index = join(root, `index-${sequence++}`);
    const extra = { GIT_INDEX_FILE: index };
    await run(remote, ['read-tree', parent ?? '--empty'], undefined, extra);
    for (const [path, text] of Object.entries(changes)) {
      const blob = await run(remote, ['hash-object', '-w', '--stdin'], text);
      await run(remote, ['update-index', '--add', '--cacheinfo', '100644', blob, path], undefined, extra);
    }
    const tree = await run(remote, ['write-tree'], undefined, extra);
    const head = await run(remote, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
    await run(remote, ['update-ref', `refs/heads/fixture-${sequence}`, head]);
    return head;
  }
  const base = await commit(null, { 'shared.txt': 'base\n', 'base.txt': 'base\n' }, 'base');
  await run(remote, ['update-ref', 'refs/heads/main', base]);
  const calls = [];
  const author = { credentials: async () => ({ token: 'offline-only-token',
    identity: { user: { ...BUILDER_BOT }, repository: REPOSITORY } }) };
  const mirror = new BatchMirror({ author, root: join(root, 'scratch'), executeImpl: async (command, args, options) => {
    assert.equal(command, 'git');
    assert.equal(args.some((arg) => /^(?:checkout|switch|worktree)$/u.test(arg)), false,
      'the trusted assembler cannot materialize PR content');
    const local = args.map((arg) => arg === `https://github.com/${REPOSITORY}.git` ? `file://${remote}`
      : arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg);
    assert.equal(local.some((arg) => /https?:\/\//u.test(arg)), false, 'offline transport only');
    calls.push(args);
    return executeProcess(command, local, options);
  } });
  const batch = (members, extra = {}) => ({ id: 'offline-proof', generation: 1,
    selected_at: 1792324800000, base_sha: base, members, ...extra });
  return { root, remote, base, run, commit, mirror, batch, calls, author };
}
const member = (pr, head_sha) => ({ pr, head_sha, review_id: pr + 10, publication_id: pr + 20,
  github_review_id: pr + 30, pull_request_id: `PR_${pr}`, ci_run_id: pr + 40, ci_attempt: 1,
  priority: null, created_at: '2026-10-01T00:00:00Z' });
const read = (f, batch, args) => f.run(f.mirror.directory(batch), args);

async function seal(f, batch) {
  const assembled = await f.mirror.assemble(batch);
  return { ...batch, ...assembled, sealed: true, carrier_branch: carrierBranch(batch) };
}

test('compatible heads form ordered normal two-parent merges with the exact combined tree', async (t) => {
  const f = await fixture(t);
  const first = await f.commit(f.base, { 'first.txt': 'first\n' }, 'first');
  const second = await f.commit(f.base, { 'second.txt': 'second\n' }, 'second');
  const batch = f.batch([member(1, first), member(2, second)]);
  const result = await f.mirror.assemble(batch);
  assert.deepEqual(result.accepted, batch.members);
  assert.deepEqual(result.conflicts, []);
  const parents = (await read(f, batch, ['rev-list', '--parents', '-n', '1', result.head_sha])).split(' ');
  assert.equal(parents.length, 3);
  assert.equal(parents[2], second);
  assert.deepEqual((await read(f, batch, ['rev-list', '--parents', '-n', '1', parents[1]])).split(' ').slice(1),
    [f.base, first]);
  assert.equal(await read(f, batch, ['show', `${result.head_sha}:first.txt`]), 'first');
  assert.equal(await read(f, batch, ['show', `${result.head_sha}:second.txt`]), 'second');
  assert.equal(await read(f, batch, ['rev-parse', `${result.head_sha}^{tree}`]), result.tree_sha);
  assert.equal(await read(f, batch, ['show', '-s', '--format=%an|%ae|%cn', result.head_sha]),
    `${BUILDER_BOT.login}|${BUILDER_BOT.id}+${BUILDER_BOT.login}@users.noreply.github.com|${BUILDER_BOT.login}`);
  const repeated = await f.mirror.assemble(batch);
  assert.equal(repeated.head_sha, result.head_sha, 'same pinned inputs produce the same carrier');
});

test('a conflicting member is never resolved or included, while later compatible work survives', async (t) => {
  const f = await fixture(t);
  const first = await f.commit(f.base, { 'shared.txt': 'first\n' });
  const conflict = await f.commit(f.base, { 'shared.txt': 'conflict\n' });
  const later = await f.commit(f.base, { 'later.txt': 'later\n' });
  const batch = f.batch([member(1, first), member(2, conflict), member(3, later)]);
  const result = await f.mirror.assemble(batch);
  assert.deepEqual(result.accepted.map((m) => m.pr), [1, 3]);
  assert.deepEqual(result.conflicts, [{ pr: 2, head_sha: conflict, paths: ['shared.txt'] }]);
  assert.equal(await read(f, batch, ['show', `${result.head_sha}:shared.txt`]), 'first');
  assert.equal(await read(f, batch, ['show', `${result.head_sha}:later.txt`]), 'later');
  const context = await f.mirror.context(batch);
  assert.equal(await f.mirror.ancestor(context, conflict, result.head_sha), false);
});

test('ancestry closure includes foreign, draft and non-main open heads and rechecks changed pinned heads', async (t) => {
  const f = await fixture(t);
  const foreign = await f.commit(f.base, { 'foreign.txt': 'foreign\n' });
  const draft = await f.commit(foreign, { 'draft.txt': 'draft\n' });
  const selected = await f.commit(draft, { 'selected.txt': 'selected\n' });
  const batch = f.batch([member(1, selected)]);
  const open = [member(1, selected), { ...member(2, foreign), head: { repo: { full_name: 'elsewhere/fork' } } },
    { ...member(3, draft), draft: true, base: { ref: 'release' } }, member(4, f.base)];
  const dependencies = await f.mirror.dependencies(batch, batch.members, open);
  assert.deepEqual(dependencies.get(1), [{ pr: 2, head_sha: foreign }, { pr: 3, head_sha: draft }]);
  const assembled = await f.mirror.assemble(batch);
  const ancestry = await f.mirror.ancestry({ ...batch, ...assembled }, open);
  assert.deepEqual([...ancestry.baseAncestors], [4]);
  assert.deepEqual([...ancestry.combinedAncestors], [1, 2, 3, 4]);
  assert.deepEqual(ancestryViolations({ open, members: batch.members, ...ancestry }).map((m) => m.pr), [2, 3]);
  const changed = await f.commit(foreign, { 'new-open-head.txt': 'not included\n' });
  const freshOpen = open.map((pr) => pr.pr === 2 ? { ...pr, head_sha: changed } : pr);
  const fresh = await f.mirror.ancestry({ ...batch, ...assembled }, freshOpen);
  assert.equal(fresh.combinedAncestors.has(2), false, 'old reachable head cannot authorize a newer open head');
  assert.equal(fresh.combinedAncestors.has(3), true);
  const newlyOpened = [...freshOpen, member(5, foreign)];
  const latest = await f.mirror.ancestry({ ...batch, ...assembled }, newlyOpened);
  assert.deepEqual(ancestryViolations({ open: newlyOpened, members: batch.members, ...latest }).map((m) => m.pr), [3, 5]);
});

test('assembly stays bare and never executes hooks or repository checkout content', async (t) => {
  const f = await fixture(t);
  const sentinel = join(f.root, 'executed');
  const head = await f.commit(f.base, { '.gitattributes': '* filter=hostile\n',
    'untrusted.sh': `#!/bin/sh\nprintf hostile > '${sentinel}'\n` });
  const batch = f.batch([member(1, head)]);
  await f.mirror.context(batch);
  const directory = f.mirror.directory(batch);
  await mkdir(join(directory, 'hooks'), { recursive: true });
  for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'post-merge', 'reference-transaction']) {
    await writeFile(join(directory, 'hooks', hook), `#!/bin/sh\nprintf hook > '${sentinel}'\nexit 1\n`, { mode: 0o700 });
  }
  await f.run(directory, ['config', 'filter.hostile.smudge', `sh -c "printf filter > '${sentinel}'"`]);
  const result = await f.mirror.assemble(batch);
  assert.equal(await read(f, batch, ['rev-parse', '--is-bare-repository']), 'true');
  assert.equal(await read(f, batch, ['show', `${result.head_sha}:untrusted.sh`]),
    `#!/bin/sh\nprintf hostile > '${sentinel}'`);
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
  assert.equal((await readdir(directory)).includes('untrusted.sh'), false);
  assert.equal((await readFile(join(directory, 'config'), 'utf8')).includes('offline-only-token'), false);
});

test('offline publish creates a ref only after durable intent and refuses a different existing fast-forward base', async (t) => {
  const f = await fixture(t);
  const head = await f.commit(f.base, { 'first.txt': 'first\n' });
  const batch = await seal(f, f.batch([member(1, head)]));
  const events = [];
  const receipt = await f.mirror.publish(batch, async () => { events.push('guard'); }, async () => {
    events.push('intent');
    assert.equal(f.calls.some((args) => args.includes('push')), false);
  });
  assert.deepEqual(events, ['guard', 'intent']);
  assert.equal(receipt.head_sha, batch.head_sha);
  const ref = `refs/heads/${batch.carrier_branch}`;
  assert.equal(await f.run(f.remote, ['rev-parse', ref]), batch.head_sha);
  // The existing ref is a proper ancestor, so an ordinary push would succeed.
  // Empty expected lease must still reject it without overwriting any object.
  await f.run(f.remote, ['update-ref', ref, f.base]);
  await assert.rejects(f.mirror.publish(batch, async () => {}, async () => {}),
    (error) => error.knownRejected === true && /batch_branch_publish_failed/u.test(error.message));
  assert.equal(await f.run(f.remote, ['rev-parse', ref]), f.base);
});

test('offline publish fences abort before touching the remote when guard or intent persistence fails', async (t) => {
  const f = await fixture(t);
  const head = await f.commit(f.base, { 'first.txt': 'first\n' });
  const batch = await seal(f, f.batch([member(1, head)]));
  for (const failAt of ['guard', 'intent']) {
    await assert.rejects(f.mirror.publish(batch,
      async () => { if (failAt === 'guard') throw new Error('fence closed'); },
      async () => { throw new Error('intent unavailable'); }), /fence closed|intent unavailable/u);
  }
  assert.equal(f.calls.some((args) => args.includes('push')), false);
});

test('Review bot credentials cannot initialize a trusted authoring mirror', async (t) => {
  const f = await fixture(t);
  f.author.credentials = async () => ({ token: 'offline-only-token',
    identity: { user: { ...REVIEW_BOT }, repository: REPOSITORY } });
  await assert.rejects(f.mirror.assemble(f.batch([])), /batch_builder_identity_missing/u);
  assert.equal(f.calls.length, 0);
});

test('filtered smart transport lazily supplies blobs for compatible edits in the same existing file', async (t) => {
  const f = await fixture(t, { filtering: true });
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  const base = await f.commit(f.base, { 'shared.txt': lines.join('\n') + '\n' });
  const firstLines = [...lines]; firstLines[2] = 'first branch edit';
  const secondLines = [...lines]; secondLines[35] = 'second branch edit';
  const first = await f.commit(base, { 'shared.txt': firstLines.join('\n') + '\n' });
  const second = await f.commit(base, { 'shared.txt': secondLines.join('\n') + '\n' });
  const batch = f.batch([member(1, first), member(2, second)], { base_sha: base });
  const context = await f.mirror.context(batch);
  await f.mirror.fetch(context, [base, first, second]);
  const missing = await read(f, batch, ['rev-list', '--objects', '--missing=print', first, second]);
  assert.match(missing, /^\?[0-9a-f]{40}$/mu, 'the server really honored blob filtering; this is not a full local fetch');
  const result = await f.mirror.assemble(batch);
  const combined = [...lines]; combined[2] = firstLines[2]; combined[35] = secondLines[35];
  assert.equal(await read(f, batch, ['show', `${result.head_sha}:shared.txt`]), combined.join('\n'));
  assert.deepEqual(result.accepted, batch.members);
  assert.deepEqual(result.conflicts, []);
  assert.equal(await read(f, batch, ['rev-parse', `${result.head_sha}^{tree}`]), result.tree_sha);
});
