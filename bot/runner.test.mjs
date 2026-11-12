import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, lstat, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { validJob, createRunner } from './runner.mjs';
const job = { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium', maxTime: 600 };
const id = '1-aaaaaaaaaaaa-12345678';
const request = (server, method, url) => new Promise((done) => {
  const req = Readable.from([]); req.method = method; req.url = url;
  let status;
  server.emit('request', req, { writeHead: (value) => { status = value; }, end: (body) => done({ status, body: JSON.parse(body) }) });
});
test('job contract allows only supported review routes and effort levels with fixed fields and time', () => {
  for (const model of ['openai-codex/gpt-6.1-sol', 'anthropic/claude-opus-5-5']) {
    for (const thinking of ['low', 'medium', 'high']) assert.equal(validJob({ ...job, model, thinking }), true);
  }
  for (const invalid of [{ ...job, extra: true }, { ...job, model: 'other/model' },
    { ...job, model: 'anthropic/claude-opus-latest' }, { ...job, thinking: 'arbitrary' },
    { ...job, thinking: '' }, { ...job, maxTime: 1 }]) assert.equal(validJob(invalid), false);
});
test('runner rejects bad job without spawning, then launches with ignored stdin and allowlisted env', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-runner-'));
  t.after(() => rm(root, { recursive: true }));
  for (const name of ['work/' + id + '/repo', 'sessions', 'home', 'config']) await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, 'config', 'reviewer-models.yml'), 'providers: {}\n');
  const jobPath = join(root, 'work', id, 'job.json'); await writeFile(jobPath, JSON.stringify({ ...job, extra: true }));
  const spawned = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = (signal) => spawned.push(signal);
  const runner = createRunner({ workRoot: join(root, 'work'), sessionsRoot: join(root, 'sessions'), homeRoot: join(root, 'home'),
    configRoot: join(root, 'config'), token: 'test-gw-bearer', spawnImpl: (...args) => { spawned.push(args); return child; } });
  assert.equal((await request(runner.server, 'POST', '/runs/' + id)).status, 400); assert.equal(spawned.length, 0);
  await writeFile(jobPath, JSON.stringify(job));
  assert.equal((await request(runner.server, 'POST', '/runs/' + id)).status, 202);
  const [command, args, options] = spawned[0]; assert.equal(command, 'omp');
  assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'OMP_GATEWAY_TOKEN', 'PATH', 'PI_NATIVES_DIR']);
  assert.equal(options.env.PI_NATIVES_DIR, '/opt/omp-natives');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']); assert.ok(args.includes('--no-rules'));
  assert.ok(args.includes('--no-skills')); assert.ok(args.includes('--no-extensions'));
  assert.equal(args[args.indexOf('--model') + 1], job.model);
  assert.equal(args[args.indexOf('--thinking') + 1], job.thinking);
  assert.ok(args.includes(join(root, 'config', 'reviewer-overlay.yml')));
  assert.equal(await readFile(join(root, 'home', id, '.omp', 'agent', 'models.yml'), 'utf8'), 'providers: {}\n');
  child.stdout.emit('data', 'x'.repeat(70000)); child.stderr.emit('data', 'x'.repeat(20000));
  const state = await request(runner.server, 'GET', '/runs/' + id);
  assert.equal(state.body.stdoutTail.length, 65536); assert.equal(state.body.stderrTail.length, 16384);
  assert.equal((await request(runner.server, 'POST', '/runs/' + id)).status, 409);
  assert.equal((await request(runner.server, 'GET', '/runs/2-aaaaaaaaaaaa-12345678')).status, 404);
  await request(runner.server, 'DELETE', '/runs/' + id); assert.ok(spawned.includes('SIGTERM'));
  child.emit('close', 0, null);
  await runner.runs.get(id).completion;
  await assert.rejects(lstat(join(root, 'home', id)), { code: 'ENOENT' });
  assert.equal((await request(runner.server, 'GET', '/runs/' + id)).body.state, 'exited');
  assert.equal((await request(runner.server, 'DELETE', '/runs/' + id)).status, 200);
  assert.equal(runner.runs.size, 0);
  assert.equal((await request(runner.server, 'GET', '/runs/' + id)).status, 404);
});
test('startup removes stale run homes and symlinks without following them or deleting unrelated files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeRoot = join(root, 'home'), outside = join(root, 'outside');
  await mkdir(join(homeRoot, id), { recursive: true }); await mkdir(outside);
  await writeFile(join(homeRoot, id, 'stale'), 'stale');
  await writeFile(join(outside, 'keep'), 'keep');
  await writeFile(join(homeRoot, 'operator-file'), 'keep');
  const linked = '2-aaaaaaaaaaaa-12345678';
  await symlink(outside, join(homeRoot, linked));
  const runner = createRunner({ homeRoot }); await runner.ready;
  await assert.rejects(lstat(join(homeRoot, id)), { code: 'ENOENT' });
  await assert.rejects(lstat(join(homeRoot, linked)), { code: 'ENOENT' });
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'keep');
  assert.equal(await readFile(join(homeRoot, 'operator-file'), 'utf8'), 'keep');
});
test('normal exit removes HOME before reporting exited and preserves the session receipt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-exit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['work/' + id + '/repo', 'sessions', 'home', 'config']) await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, 'config', 'reviewer-models.yml'), 'providers: {}');
  await writeFile(join(root, 'work', id, 'job.json'), JSON.stringify(job));
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const runner = createRunner({ workRoot: join(root, 'work'), sessionsRoot: join(root, 'sessions'), homeRoot: join(root, 'home'),
    configRoot: join(root, 'config'), token: 'fixture', spawnImpl: () => child });
  assert.equal((await request(runner.server, 'POST', '/runs/' + id)).status, 202);
  await symlink(join(root, 'config'), join(root, 'home', id, 'outside-link'));
  child.emit('close', 0, null); await runner.runs.get(id).completion;
  assert.equal((await request(runner.server, 'GET', '/runs/' + id)).body.state, 'exited');
  await assert.rejects(lstat(join(root, 'home', id)), { code: 'ENOENT' });
  assert.equal((await readFile(join(root, 'config', 'reviewer-models.yml'), 'utf8')), 'providers: {}');
  assert.equal(JSON.parse(await readFile(join(root, 'sessions', id, 'runner-receipt.json'), 'utf8')).exitCode, 0);
});

for (const method of ['POST', 'GET']) {
  test(`${method} evicts completed runs older than one hour but never running entries`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'runner-retention-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const now = 10800000;
    const runner = createRunner({ homeRoot: join(root, 'home'), workRoot: join(root, 'work'), now: () => now });
    const recent = '2-aaaaaaaaaaaa-12345678', running = '3-aaaaaaaaaaaa-12345678';
    const entry = { startedAt: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, signal: null };
    runner.runs.set(id, { ...entry, state: 'exited', finishedAt: now - 3600001 });
    runner.runs.set(recent, { ...entry, state: 'exited', finishedAt: now - 3600000 });
    runner.runs.set(running, { ...entry, state: 'running' });
    const response = await request(runner.server, method, method === 'GET' ? '/health' : '/runs/4-aaaaaaaaaaaa-12345678');
    assert.equal(response.status, method === 'GET' ? 200 : 400);
    assert.equal(runner.runs.has(id), false);
    assert.equal(runner.runs.has(recent), true);
    assert.equal(runner.runs.has(running), true);
    assert.equal(runner.runs.size, 2);
    assert.equal((await request(runner.server, 'GET', '/runs/' + id)).status, 404);
    assert.equal((await request(runner.server, 'GET', '/runs/' + running)).body.state, 'running');
  });
}
