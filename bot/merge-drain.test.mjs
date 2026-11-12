import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSelectionDrainRequest } from './merge-drain.mjs';

const execute = promisify(execFile);
const first = 'd66bd611-34ce-43c9-bbb6-34c323a9267f';
const second = '5d5ddc53-f903-45c4-b9d8-db82b02762ce';
const invalid = { request_id: null, error: 'invalid_request' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'merge-drain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, 'merge-selection-drain.request') };
}

test('absence, valid requests and atomic replacement are read freshly', async (t) => {
  const { root, path } = await fixture(t);
  assert.equal(await readSelectionDrainRequest(path), null);
  await writeFile(path, first);
  assert.deepEqual(await readSelectionDrainRequest(path), { request_id: first, error: null });
  const replacement = join(root, 'replacement');
  await writeFile(replacement, `${second}\n`);
  await rename(replacement, path);
  assert.deepEqual(await readSelectionDrainRequest(path), { request_id: second, error: null });
  await rm(path);
  assert.equal(await readSelectionDrainRequest(path), null);
});

test('only a lowercase UUID with optional trailing whitespace fits the 128-byte limit', async (t) => {
  const { path } = await fixture(t);
  for (const contents of ['', first.toUpperCase(), ` ${first}`, `${first}\n${second}`]) {
    await writeFile(path, contents);
    assert.deepEqual(await readSelectionDrainRequest(path), invalid);
  }
  await writeFile(path, first + ' '.repeat(128 - first.length));
  assert.deepEqual(await readSelectionDrainRequest(path), { request_id: first, error: null });
  await writeFile(path, first + ' '.repeat(129 - first.length));
  assert.deepEqual(await readSelectionDrainRequest(path), invalid);
});

test('directories and symlinks, including dangling links, cannot authorize a drain', async (t) => {
  const { root, path } = await fixture(t);
  await mkdir(path);
  assert.deepEqual(await readSelectionDrainRequest(path), invalid);
  await rm(path, { recursive: true });
  const target = join(root, 'target');
  await writeFile(target, first);
  await symlink(target, path);
  assert.deepEqual(await readSelectionDrainRequest(path), invalid);
  await rm(target);
  assert.deepEqual(await readSelectionDrainRequest(path), invalid);
});

test('a FIFO is rejected without waiting for a writer', async (t) => {
  const { path } = await fixture(t);
  await execute('mkfifo', [path]);
  // Isolate a potentially blocking regression so a failed assertion cannot leave
  // a filesystem worker holding the test runner open indefinitely.
  const moduleUrl = new URL('./merge-drain.mjs', import.meta.url).href;
  const script = `import { readSelectionDrainRequest } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await readSelectionDrainRequest(${JSON.stringify(path)})));`;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout), invalid);
});

test('non-ENOENT failures remain unavailable and never disclose input or paths', async (t) => {
  const { root, path } = await fixture(t);
  const secret = 'private-marker-content-do-not-disclose';
  await writeFile(path, secret);
  const malformed = await readSelectionDrainRequest(path);
  assert.deepEqual(malformed, invalid);
  const unavailable = await readSelectionDrainRequest(join(path, secret));
  assert.deepEqual(unavailable, { request_id: null, error: 'unavailable' });
  const serialized = JSON.stringify([malformed, unavailable]);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes('ENOTDIR'), false);
});
