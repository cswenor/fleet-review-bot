import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, copyFile, lstat, realpath, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RUN_ID = /^[0-9]+-[0-9a-f]{12}-[0-9a-z]{8}$/u;
export function validJob(job) {
  return job && Object.keys(job).sort().join(',') === 'maxTime,model,thinking'
    && ['openai-codex/gpt-6.1-sol', 'anthropic/claude-opus-5-5'].includes(job.model)
    && ['low', 'medium', 'high'].includes(job.thinking) && job.maxTime === 600;
}
const tail = (old, chunk, limit) => Buffer.concat([old, Buffer.from(chunk)]).subarray(-limit);
async function cleanRunHomes(homeRoot) {
  await mkdir(homeRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(homeRoot)) !== resolve(homeRoot)) throw new Error('Invalid runner HOME root');
  for (const name of await readdir(homeRoot)) {
    // rm unlinks symlinks rather than following them. Non-run operator files remain.
    if (RUN_ID.test(name)) await rm(join(homeRoot, name), { recursive: true, force: true });
  }
}
export function createRunner({ workRoot = '/work', sessionsRoot = '/sessions', homeRoot = '/home/review',
  configRoot = '/opt/pr-review-bot/config', token, spawnImpl = spawn, wallMs = 660000, killGraceMs = 10000,
  now = Date.now } = {}) {
  const runs = new Map();
  const ready = cleanRunHomes(homeRoot);
  const evictExpired = () => {
    const cutoff = now() - 3600000;
    for (const [id, run] of runs) if (run.state === 'exited' && run.finishedAt < cutoff) runs.delete(id);
  };
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const stop = (run) => {
    if (run.state !== 'running') return;
    run.child.kill('SIGTERM');
    run.killTimer ??= setTimeout(() => { if (run.state === 'running') run.child.kill('SIGKILL'); }, killGraceMs);
    run.killTimer.unref();
  };
  const server = createServer(async (req, res) => {
    let preparedHome = null;
    try {
      await ready;
      if (req.method === 'POST' || req.method === 'GET') evictExpired();
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
      const match = /^\/runs\/([^/]+)$/u.exec(req.url);
      if (!match || !RUN_ID.test(match[1])) return send(res, 404, { error: 'not_found' });
      const id = match[1];
      if (req.method === 'GET' || req.method === 'DELETE') {
        const run = runs.get(id);
        if (!run) return send(res, 404, { error: 'not_found' });
        if (req.method === 'DELETE') {
          if (run.state === 'exited') runs.delete(id);
          else stop(run);
        }
        return send(res, 200, { state: run.state, exitCode: run.exitCode, signal: run.signal,
          durationMs: (run.finishedAt ?? now()) - run.startedAt,
          stdoutTail: run.stdout.toString(), stderrTail: run.stderr.toString() });
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'not_found' });
      if (runs.has(id)) return send(res, 409, { error: 'already_started' });
      const work = join(workRoot, id);
      const jobPath = join(work, 'job.json');
      if ((await realpath(work)) !== resolve(work) || !(await lstat(jobPath)).isFile() || (await lstat(jobPath)).isSymbolicLink()) {
        return send(res, 400, { error: 'invalid_job' });
      }
      const job = JSON.parse(await readFile(jobPath, 'utf8'));
      if (!validJob(job)) return send(res, 400, { error: 'invalid_job' });
      const home = join(homeRoot, id);
      const sessions = join(sessionsRoot, id);
      await mkdir(home, { mode: 0o700 });
      preparedHome = home;
      await mkdir(join(home, '.omp', 'agent'), { recursive: true, mode: 0o700 });
      await mkdir(sessions, { recursive: true, mode: 0o700 });
      await copyFile(join(configRoot, 'reviewer-models.yml'), join(home, '.omp', 'agent', 'models.yml'));
      if (runs.has(id)) return send(res, 409, { error: 'already_started' });
      const repo = join(work, 'repo');
      const args = ['--cwd', repo, '--model', job.model, '--thinking', job.thinking,
        '--config', join(repo, '.omp', 'unadvised-review.yml'), '--config', join(configRoot, 'reviewer-overlay.yml'),
        '--session-dir', sessions, '--no-prewalk', '--no-title', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp',
        '--tools', 'read,grep,glob', '--approval-mode', 'always-ask', '--max-time', '600', '--print', `@${join(repo, 'review', 'prompt.md')}`];
      const child = spawnImpl('omp', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home,
          OMP_GATEWAY_TOKEN: token, PI_NATIVES_DIR: '/opt/omp-natives' } });
      const run = { state: 'running', child, startedAt: now(), exitCode: null, signal: null,
        stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), killTimer: null };
      runs.set(id, run);
      preparedHome = null;
      child.stdout.on('data', (chunk) => { run.stdout = tail(run.stdout, chunk, 65536); });
      child.stderr.on('data', (chunk) => { run.stderr = tail(run.stderr, chunk, 16384); });
      const finish = (exitCode, signal) => {
        if (run.completion) return;
        clearTimeout(run.wallTimer); clearTimeout(run.killTimer);
        run.finishedAt = now();
        run.completion = (async () => {
          try {
            await rm(home, { recursive: true, force: true });
            await writeFile(join(sessions, 'runner-receipt.json'), JSON.stringify({ exitCode, signal,
              startedAt: run.startedAt, finishedAt: run.finishedAt }), { mode: 0o600 });
          } catch {
            exitCode = 1;
            run.stderr = tail(run.stderr, 'Runner HOME cleanup or receipt write failed\\n', 16384);
          }
          run.state = 'exited'; run.exitCode = exitCode; run.signal = signal;
        })();
      };
      child.once('error', () => finish(1, null));
      child.once('close', (code, signal) => finish(code, signal));
      run.wallTimer = setTimeout(() => stop(run), wallMs); run.wallTimer.unref();
      return send(res, 202, { state: 'running' });
    } catch {
      if (preparedHome) await rm(preparedHome, { recursive: true, force: true });
      return send(res, 400, { error: 'invalid_job' });
    }
  });
  server.on('close', () => { for (const run of runs.values()) { clearTimeout(run.wallTimer); stop(run); } });
  return { server, runs, stop, ready };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const token = process.env.OMP_GATEWAY_TOKEN;
  if (!token || /\s/u.test(token)) throw new Error('Invalid OMP_GATEWAY_TOKEN');
  const { server, ready } = createRunner({ token, workRoot: process.env.WORK_ROOT ?? '/work',
    sessionsRoot: process.env.SESSIONS_ROOT ?? '/sessions', homeRoot: process.env.REVIEW_HOME_ROOT ?? '/home/review' });
  await ready;
  server.listen(Number(process.env.PORT ?? 8081), '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); });
}
