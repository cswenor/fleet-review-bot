import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class SubprocessOutputLimitError extends Error {
  constructor(limit) {
    super(`Subprocess output exceeds ${limit} bytes`);
    this.name = 'SubprocessOutputLimitError';
    this.code = 'subprocess_output_limit';
    this.limit = limit;
  }
}

function groupExists(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function killGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

// Linux deployment: detached children own a process group, but remain referenced.
// Never settle on `error`/`exit`: pipe closure and descendant cleanup precede release.
export function executeProcess(command, args, { timeout = 30000, signal, env = process.env,
  encoding = 'utf8', input, inputStream, stdoutSink, maxBuffer = 8 * 1024 * 1024,
  maxOutputBytes = maxBuffer, cleanupMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let bytes = 0; let failure; let closed = false;
    let closeTimer; let deadline;
    const pipes = [];
    const finish = (error, result) => {
      clearTimeout(deadline); clearTimeout(closeTimer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const terminate = (error) => {
      failure ??= error;
      try { killGroup(child.pid); } catch (killError) { failure = killError; }
      stdoutSink?.destroy(error);
      inputStream?.destroy(error);
      if (!closeTimer && !closed) closeTimer = setTimeout(() => {
        // Repeat the group kill before reporting a bounded close-wait failure.
        try { killGroup(child.pid); } catch { /* Original cleanup failure is retained. */ }
        finish(new Error('Subprocess close deadline exceeded', { cause: failure }));
      }, cleanupMs);
    };
    const abort = () => terminate(signal?.reason?.code === 'subprocess_output_limit' ? signal.reason
      : Object.assign(new Error('mirror_timeout'), { code: 'mirror_timeout', killed: true }));
    deadline = setTimeout(abort, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) terminate(new SubprocessOutputLimitError(maxBuffer));
      else target.push(chunk);
    };
    if (stdoutSink) {
      let outputBytes = 0;
      const counter = new Transform({ transform(chunk, encoding, callback) {
        outputBytes += chunk.length;
        callback(outputBytes > maxOutputBytes ? new SubprocessOutputLimitError(maxOutputBytes) : null, chunk);
      } });
      pipes.push(pipeline(child.stdout, counter, stdoutSink).catch(terminate));
    } else child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') terminate(error); });
    child.on('error', terminate);
    child.on('close', async (code) => {
      closed = true; clearTimeout(closeTimer); clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      closeTimer = setTimeout(() => {
        try { killGroup(child.pid); } catch { /* Report bounded cleanup failure. */ }
        finish(new Error('Subprocess stream cleanup deadline exceeded', { cause: failure }));
      }, cleanupMs);
      try {
        // Also dispose of stray descendants after an ordinary parent completion.
        killGroup(child.pid);
        await Promise.all(pipes);
        const until = Date.now() + cleanupMs;
        while (groupExists(child.pid) && Date.now() < until) await delay(20);
        if (groupExists(child.pid)) throw new Error('Subprocess process group cleanup deadline exceeded');
        if (failure) throw failure;
        const convert = (chunks) => { const buffer = Buffer.concat(chunks); return encoding === 'buffer' ? buffer : buffer.toString(encoding); };
        if (code !== 0) throw Object.assign(new Error(`Subprocess ${command} exited ${code}`),
          { exitCode: code, stdout: convert(stdout), stderr: convert(stderr) });
        finish(null, { stdout: convert(stdout), stderr: convert(stderr) });
      } catch (error) { finish(error); }
    });
    if (inputStream) pipes.push(pipeline(inputStream, child.stdin).catch(terminate));
    else child.stdin.end(input);
  });
}
