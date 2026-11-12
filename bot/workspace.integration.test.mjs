import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportWorkspace } from './workspace.mjs';

// Real git/tar and ~100 MiB of archive payload exercise pipe backpressure and tar EOF.
// Distinct compressible blobs and a packed bare clone mirror production's object lookup/cleanup.
test('real-size archive is fully consumed; streaming budget overflow still aborts both processes', { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-large-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, '.omp'), { recursive: true });
  await mkdir(join(source, 'large'));
  await writeFile(join(source, '.omp/config.yml'), 'modelRoles:\n  review: openai-codex/gpt-6.1-sol:medium\n');
  await writeFile(join(source, '.omp/unadvised-review.yml'), 'advisor: {enabled: false}\n');
  const count = 3000;
  const payload = Buffer.alloc(35000, 'a');
  for (let index = 0; index < count; index++) {
    payload.write(String(index).padStart(4, '0'), 0, 'ascii');
    await writeFile(join(source, 'large', `part-${String(index).padStart(4, '0')}.txt`), payload);
  }
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture.invalid', 'commit', '-qm', 'large archive fixture');
  const gitDir = join(root, 'mirror.git');
  git('clone', '--quiet', '--bare', '--no-local', source, gitDir);
  const headSha = git('rev-parse', 'HEAD');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = join(root, 'bin');
  await mkdir(bin);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  // Keep the real producer's stdout open briefly after the last tar record. Real packed
  // repository exports hit this cleanup/EOF race; the delay makes the regression deterministic.
  await writeFile(join(bin, 'git'), `#!/bin/sh\n${quote(realGit)} "$@"\nstatus=$?\nfor arg do\n  if [ "$arg" = archive ]; then sleep 0.25; break; fi\ndone\nexit "$status"\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const options = { gitDir, mainRef: headSha, baseSha: headSha, headSha, reviewPolicy: 'Trusted fixture criteria',
    pr: { repo: 'owner/repo', number: 1, title: 'real-size export', body: '' } };
  const result = await exportWorkspace({ ...options, outDir: join(root, 'export') });
  const files = await readdir(join(result.repoDir, 'large'));
  assert.equal(files.length, count);
  let bytes = 0;
  for (const name of files) {
    const actual = await readFile(join(result.repoDir, 'large', name));
    assert.equal(actual.subarray(0, 4).toString('ascii'), name.slice(5, 9), name);
    assert.deepEqual(actual.subarray(4), payload.subarray(4), name);
    bytes += actual.length;
  }
  assert.equal(bytes, 105000000);
  assert.match(await readFile(join(result.repoDir, '.omp/config.yml'), 'utf8'), /modelRoles:/u);
  // Blob sizes pass preflight. Tar headers/padding then exceed this budget while streaming.
  const overflowDir = join(root, 'overflow');
  await assert.rejects(exportWorkspace({ ...options, outDir: overflowDir, maxExportBytes: bytes + 1000 }),
    (error) => error.code === 'workspace_too_large' && /git archive .*\| tar -x/u.test(error.message));
  await assert.rejects(lstat(join(overflowDir, 'repo')), { code: 'ENOENT' });
});
