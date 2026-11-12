import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canCarryForward, fingerprintDiff } from './carry-forward.mjs';

async function repo(t) {
  const dir = await mkdtemp(join(tmpdir(), 'carry-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, input: '', encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture' } });
  git('init', '-b', 'main');
  await writeFile(join(dir, 'source.txt'), 'first\nsecond\nthird\n');
  git('add', '.'); git('commit', '-m', 'base');
  const priorBase = git('rev-parse', 'HEAD').trim();
  git('checkout', '-b', 'change');
  await writeFile(join(dir, 'source.txt'), 'first\n  second\nthird\n');
  git('add', '.'); git('commit', '-m', 'change');
  const priorHead = git('rev-parse', 'HEAD').trim();
  const patchFingerprint = async (base, head) => fingerprintDiff(execFileSync('git',
    ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index', '--binary', base, head], { cwd: dir }));
  return { dir, git, priorBase, priorHead, patchFingerprint };
}
test('pure main merge with identical PR patch carries forward', async (t) => {
  const f = await repo(t);
  f.git('checkout', 'main'); await writeFile(join(f.dir, 'main.txt'), 'main-only\n');
  f.git('add', '.'); f.git('commit', '-m', 'main advances');
  const mainSha = f.git('rev-parse', 'HEAD').trim();
  f.git('checkout', 'change'); f.git('merge', '--no-ff', 'main', '-m', 'update branch');
  const headSha = f.git('rev-parse', 'HEAD').trim();
  assert.equal(await canCarryForward({ ...f, mainSha, headSha }), true);
});
test('indentation-only conflict resolution forces a fresh review', async (t) => {
  const f = await repo(t);
  f.git('checkout', 'main'); await writeFile(join(f.dir, 'source.txt'), 'first\nsecond   \nthird\n');
  f.git('add', '.'); f.git('commit', '-m', 'main whitespace');
  const mainSha = f.git('rev-parse', 'HEAD').trim();
  f.git('checkout', 'change'); assert.throws(() => f.git('merge', '--no-ff', 'main'));
  await writeFile(join(f.dir, 'source.txt'), 'first\n    second\nthird\n');
  f.git('add', '.'); f.git('commit', '--no-edit');
  const headSha = f.git('rev-parse', 'HEAD').trim();
  assert.equal(await canCarryForward({ ...f, mainSha, headSha }), false);
});
test('ordinary PR commits never carry forward even when content returns to the old patch', async (t) => {
  const f = await repo(t); f.git('commit', '--allow-empty', '-m', 'ordinary commit');
  assert.equal(await canCarryForward({ ...f, mainSha: f.priorBase, headSha: f.git('rev-parse', 'HEAD').trim() }), false);
});
test('old or unavailable verbatim capability forces re-review', async () => {
  const sha = 'a'.repeat(40);
  for (const version of ['git version 2.38.5', 'git version 2.39.5']) {
    const git = async (...args) => { if (args[0] === '--version') return version; throw new Error('unavailable'); };
    assert.equal(await canCarryForward({ git, patchFingerprint: () => assert.fail('No comparison allowed'),
      mainSha: sha, priorHead: sha, priorBase: sha, headSha: sha }), false);
  }
});
test('fingerprint normalizes only hunk offsets and preserves whitespace, metadata and arbitrary bytes', () => {
  const diff = Buffer.from('@@ -1,3 +1,4 @@ function\n unchanged\n+  changed\n');
  assert.equal(fingerprintDiff(diff), fingerprintDiff(Buffer.from(diff.toString().replace('-1,3 +1,4', '-21,3 +24,4'))));
  assert.notEqual(fingerprintDiff(diff), fingerprintDiff(Buffer.from(diff.toString().replace('+  changed', '+    changed'))));
  assert.notEqual(fingerprintDiff(diff), fingerprintDiff(Buffer.concat([diff, Buffer.from('\\ No newline at end of file\n')])));
  assert.notEqual(fingerprintDiff(Buffer.concat([diff, Buffer.from([255])])), fingerprintDiff(Buffer.concat([diff, Buffer.from([254])])));
});
