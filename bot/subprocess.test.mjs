import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeProcess, SubprocessOutputLimitError } from './subprocess.mjs';

for (const mode of ['timeout', 'abort']) test(`fake git's long-lived grandchild is gone before ${mode} rejection`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-process-group-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-git'); const pidFile = join(root, 'grandchild.pid');
  await writeFile(executable, '#!/bin/sh\nsh -c \'sleep 600 & echo $! > "$1"; wait\' child "$1" &\nwait\n', { mode: 0o755 });
  const controller = new AbortController();
  const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 250) : null;
  try {
    await assert.rejects(executeProcess(executable, [pidFile], {
      timeout: mode === 'timeout' ? 250 : 30000, signal: controller.signal,
    }), /mirror_timeout/u);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.equal(Number.isInteger(pid) && pid > 1, true);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'grandchild must be reaped before queue release');
  } finally { clearTimeout(timer); }
});

test('ordinary referenced process completion preserves output and Buffer mode', async () => {
  const text = await executeProcess('/bin/sh', ['-c', 'printf ordinary; printf diagnostic >&2']);
  assert.equal(text.stdout, 'ordinary'); assert.equal(text.stderr, 'diagnostic');
  const binary = await executeProcess('/bin/sh', ['-c', 'cat'], { encoding: 'buffer', input: Buffer.from('archive') });
  assert.equal(Buffer.isBuffer(binary.stdout), true); assert.equal(binary.stdout.toString(), 'archive');
});

test('output overflow returns a typed failure only after the entire process group is gone', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-output-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-git'); const pidFile = join(root, 'grandchild.pid');
  await writeFile(executable, '#!/bin/sh\nsh -c \'sleep 600 & echo $! > "$1"; wait\' child "$1" &\nwhile [ ! -s "$1" ]; do sleep 0.01; done\ndd if=/dev/zero bs=4096 count=4 2>/dev/null\nwait\n', { mode: 0o755 });
  await assert.rejects(executeProcess(executable, [pidFile], { maxBuffer: 1024 }), (error) => {
    assert.equal(error instanceof SubprocessOutputLimitError, true);
    assert.equal(error.code, 'subprocess_output_limit'); assert.equal(error.limit, 1024);
    assert.equal('stdout' in error, false, 'overflow must not return a silently truncated result');
    return true;
  });
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('the default captured-output ceiling is eight MiB', async () => {
  await assert.rejects(executeProcess('/bin/sh', ['-c', 'dd if=/dev/zero bs=1048576 count=9 2>/dev/null']),
    (error) => error instanceof SubprocessOutputLimitError && error.limit === 8 * 1024 * 1024);
});
