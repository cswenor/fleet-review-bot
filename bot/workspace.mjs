import { executeProcess, SubprocessOutputLimitError } from './subprocess.mjs';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { buildPrompt } from './prompt.mjs';
import { Transform, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export class WorkspaceExportError extends Error {
  constructor(command, cause) {
    super(`Workspace export failed: ${command}`, { cause });
    this.name = 'WorkspaceExportError';
    this.code = cause?.code === 'workspace_too_large' || cause?.code === 'subprocess_output_limit' ? 'workspace_too_large'
      : cause?.code === 'mirror_timeout' || cause?.message === 'mirror_timeout' ? 'mirror_timeout' : 'workspace_export_failed';
  }
}

function gitEnvironment() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.lowSpeedLimit', GIT_CONFIG_VALUE_0: '1000',
    GIT_CONFIG_KEY_1: 'http.lowSpeedTime', GIT_CONFIG_VALUE_1: '30' };
}
async function run(command, args, options = {}) {
  return (await executeProcess(command, args, { ...options, timeout: 30000, encoding: 'buffer', env: gitEnvironment() })).stdout;
}

async function inspectExportTree(gitDir, headSha, maxExportBytes, maxEntries) {
  let pending = ''; let count = 0; let size = 0; const paths = [];
  const decoder = new StringDecoder('utf8');
  const sink = new Writable({ write(chunk, encoding, callback) {
    try {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf('\0')) !== -1) {
        const entry = pending.slice(0, end); pending = pending.slice(end + 1);
        const tab = entry.indexOf('\t');
        const fields = entry.slice(0, tab).trim().split(/\s+/u);
        count++;
        if (fields[1] === 'blob') size += Number(fields[3]);
        if (count > maxEntries) throw Object.assign(new Error(`Workspace exceeds ${maxEntries} entries`), { code: 'workspace_too_large' });
        if (size > maxExportBytes) throw new SubprocessOutputLimitError(maxExportBytes);
        if (fields[1] !== 'tree') paths.push(entry.slice(tab + 1));
      }
      callback();
    } catch (error) { callback(error); }
  } });
  await executeProcess('git', [`--git-dir=${resolve(gitDir)}`, 'ls-tree', '-r', '-t', '-l', '-z', headSha],
    { stdoutSink: sink, env: gitEnvironment() });
  return paths;
}

async function streamArchive(gitDir, headSha, repoDir, budget) {
  const controller = new AbortController();
  const pipe = new Transform({ transform(chunk, encoding, callback) {
    try { budget.take(chunk.length); callback(null, chunk); }
    catch (error) { callback(error); }
  } });
  const options = { signal: controller.signal, env: gitEnvironment() };
  const stop = (error) => { controller.abort(error); throw error; };
  // GNU tar otherwise exits at its zero-block end marker, before the producer closes
  // stdout. Consume through actual EOF so pipeline() observes a normal stdin finish.
  const extract = executeProcess('tar', ['-x', '--ignore-zeros', '-C', repoDir], { ...options, inputStream: pipe }).catch(stop);
  const archive = executeProcess('git', [`--git-dir=${resolve(gitDir)}`, 'archive', headSha],
    { ...options, stdoutSink: pipe, maxOutputBytes: budget.limit }).catch(stop);
  const results = await Promise.allSettled([archive, extract]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

// Discovery sources: omp://{context-files,mcp-config,config-usage,extension-loading,
// custom-tools,system-prompt-customization}.md. Strip at every tree depth so
// nested context cannot become trusted policy; retain blobs as review/head data.
function policyRoot(path) {
  const parts = path.split('/');
  const directories = new Set(['.omp', '.claude', '.codex', '.gemini', '.agent', '.agents',
    '.cursor', '.windsurf', '.clinerules', '.vscode', '.codeium', '.opencode', '.pi']);
  for (let index = 0; index < parts.length; index++) {
    if (directories.has(parts[index])) return parts.slice(0, index + 1).join('/');
    if (parts[index] === '.github' && ['copilot-instructions.md', 'instructions', 'skills'].includes(parts[index + 1])) {
      return parts.slice(0, index + 2).join('/');
    }
    if (parts[index] === '.config' && parts[index + 1] === 'opencode') return parts.slice(0, index + 2).join('/');
  }
  const name = parts.at(-1).toLowerCase();
  if (['agents.md', 'claude.md', 'gemini.md', 'system.md', 'system_template.md', 'append_system.md',
    'title_system.md', 'mcp.json', '.mcp.json', 'opencode.json', 'opencode.jsonc', '.cursorrules',
    '.windsurfrules', '.clinerules', 'ssh.json', '.ssh.json'].includes(name)) return path;
  return null;
}

async function walkCheckout(root, visit, prefix = '') {
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    await visit(path, entry);
    if (entry.isDirectory()) await walkCheckout(root, visit, path);
  }
}

export async function exportWorkspace(options) {
  let ownsCheckout = false;
  try { return await exportWorkspaceData(options, () => { ownsCheckout = true; }); }
  catch (error) {
    if (ownsCheckout) await rm(resolve(options.outDir, 'repo'), { recursive: true, force: true });
    if (error instanceof WorkspaceExportError) throw error;
    throw new WorkspaceExportError('git workspace export', error);
  }
}

async function exportWorkspaceData({ gitDir, mainRef, baseSha, headSha, pr, priorFindings, replies, outDir,
  reviewPolicy, maxExportBytes = 512 * 1024 * 1024, maxEntries = 200000 }, onCreated) {
  const budget = { limit: maxExportBytes, used: 0, take(bytes) {
    this.used += bytes;
    if (this.used > this.limit) throw new SubprocessOutputLimitError(this.limit);
  } };
  const git = async (...args) => {
    try { return await run('git', [`--git-dir=${resolve(gitDir)}`, ...args]); }
    catch (cause) { throw new WorkspaceExportError(`git ${args.join(' ')}`, cause); }
  };
  for (const sha of [baseSha, headSha]) {
    if (!/^[0-9a-f]{40}$/u.test(sha)) throw new WorkspaceExportError('git archive/diff (invalid SHA)');
  }
  const mainSha = (await git('rev-parse', '--verify', `${mainRef}^{commit}`)).toString().trim();
  const repoDir = resolve(outDir, 'repo');
  const headPaths = await inspectExportTree(gitDir, headSha, maxExportBytes, maxEntries);
  await mkdir(resolve(outDir), { recursive: true });
  await mkdir(repoDir);
  onCreated();
  try { await streamArchive(gitDir, headSha, repoDir, budget); }
  catch (cause) { throw new WorkspaceExportError(`git archive ${headSha} | tar -x`, cause); }
  const symlinkPaths = new Set();
  // Dirents never follow a link, including links to directories outside repo.
  await walkCheckout(repoDir, async (path, entry) => {
    if (entry.isSymbolicLink()) {
      symlinkPaths.add(path);
      await rm(resolve(repoDir, path));
    }
  });
  const strippedPaths = headPaths.filter((path) => policyRoot(path));
  const roots = new Set(strippedPaths.map(policyRoot));
  roots.add('review');
  for (const path of roots) await rm(resolve(repoDir, path), { recursive: true, force: true });
  const checkoutFiles = new Set();
  await walkCheckout(repoDir, async (path, entry) => {
    if (entry.isFile()) checkoutFiles.add(path);
  });
  await mkdir(resolve(repoDir, '.omp'));
  for (const path of ['.omp/config.yml', '.omp/unadvised-review.yml']) {
    try {
      const content = await git('show', `${mainSha}:${path}`);
      budget.take(content.length);
      await writeFile(resolve(repoDir, path), content, { flag: 'wx' });
    }
    catch (cause) { throw new WorkspaceExportError(`git show ${mainSha}:${path} | exclusive policy write`, cause); }
  }
  const trustedPolicyPaths = new Set(['.omp', '.omp/config.yml', '.omp/unadvised-review.yml']);
  await walkCheckout(repoDir, async (path, entry) => {
    if (entry.isSymbolicLink() || (policyRoot(path) && !trustedPolicyPaths.has(path))) {
      throw new WorkspaceExportError(`git archive (unsafe checkout path ${path})`);
    }
  });
  const reviewDir = resolve(repoDir, 'review');
  await mkdir(reviewDir);
  const put = async (path, content) => {
    const target = resolve(reviewDir, path);
    if (!target.startsWith(`${reviewDir}/`)) throw new WorkspaceExportError('git diff (unsafe path)');
    budget.take(Buffer.byteLength(content));
    await mkdir(dirname(target), { recursive: true });
    try { await writeFile(target, content, { flag: 'wx' }); }
    catch (cause) { throw new WorkspaceExportError(`git archive (exclusive export write ${path})`, cause); }
  };
  const range = `${baseSha}..${headSha}`;
  await put('diff.patch', await git('diff', '--no-color', '--find-renames', range));
  await put('commits.txt', await git('log', '--reverse', '--format=%H %s', range));
  await put('changed-files.txt', await git('diff', '--name-status', '--find-renames', range));
  await put('tree.txt', await git('ls-tree', '-r', '--name-only', headSha));
  // Without rename pairing, both the old and new names are exported on the available side.
  const paths = (await git('diff', '--name-only', '--no-renames', '-z', range)).toString().split('\0').filter(Boolean);
  const inspectionTargets = Object.fromEntries(paths.map((path) => [path, checkoutFiles.has(path) ? [path] : []]));
  const uninspectablePaths = new Set();
  for (const [side, sha] of [['head', headSha], ['base', baseSha]]) {
    const tree = (await git('ls-tree', '-r', '-z', sha)).toString().split('\0').filter(Boolean);
    const blobs = new Map(tree.map((entry) => {
      const tab = entry.indexOf('\t');
      return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')];
    }));
    const exportPaths = side === 'head' ? new Set([...paths, ...strippedPaths, ...symlinkPaths]) : paths;
    for (const path of exportPaths) {
      const entry = blobs.get(path);
      if (!entry) continue;
      if (entry[1] !== 'blob') {
        await put(`skipped/${side}/${path}`, 'Not a blob (submodule)\n');
        uninspectablePaths.add(path);
        continue;
      }
      if (entry[0] === '120000') {
        await put(`symlinks/${side}/${path}`, await git('cat-file', 'blob', entry[2]));
        if (Object.hasOwn(inspectionTargets, path)) inspectionTargets[path].push(`review/symlinks/${side}/${path}`);
        continue;
      }
      const size = Number((await git('cat-file', '-s', entry[2])).toString());
      if (size > 1024 * 1024) {
        await put(`skipped/${side}/${path}`, 'File exceeds 1 MiB\n');
        uninspectablePaths.add(path);
        continue;
      }
      await put(`${side}/${path}`, await git('cat-file', 'blob', entry[2]));
      if (Object.hasOwn(inspectionTargets, path)) inspectionTargets[path].push(`review/${side}/${path}`);
    }
  }
  // Oversized or unsupported changed sources cannot borrow credit from a
  // checkout copy, another side, or a generated skip receipt.
  for (const path of uninspectablePaths) {
    if (Object.hasOwn(inspectionTargets, path)) inspectionTargets[path] = [];
  }
  const commits = (await git('log', '--reverse', '--format=%H%x00%s', range)).toString().trimEnd()
    .split('\n').filter(Boolean).map((line) => { const [sha, subject] = line.split('\0'); return { sha, subject }; });
  const prior = { prior_head_sha: priorFindings?.prior_head_sha ?? null,
    findings: priorFindings?.findings ?? [], replies: replies ?? [] };
  await put('pr.json', JSON.stringify({ repo: pr.repo, number: pr.number, title: pr.title, body: pr.body,
    base_sha: baseSha, head_sha: headSha, commits }, null, 2));
  await put('prior-findings.json', JSON.stringify(prior, null, 2));
  // Standalone exports must use the same main revision, never a local/image policy.
  if (reviewPolicy === undefined) reviewPolicy = (await git('show', `${mainSha}:.github/review-policy.md`)).toString();
  await put('prompt.md', buildPrompt({ repo: pr.repo, pr, baseSha, headSha, commits,
    priorFindings: prior, replies: prior.replies, mainSha, reviewPolicy }));
  const exportedEntries = new Set();
  await walkCheckout(repoDir, async (path, entry) => {
    exportedEntries.add(path);
    if (entry.isDirectory()) exportedEntries.add(`${path}/`);
  });
  exportedEntries.add('review/inspection.json');
  await put('inspection.json', JSON.stringify({ inspectionTargets, exportedEntries: [...exportedEntries].sort() }, null, 2));
  return { repoDir, reviewDir, mainSha, commits, changedPaths: paths, inspectionTargets, exportedEntries };
}
