import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { exportWorkspace, WorkspaceExportError } from './workspace.mjs';
import { parseSession, classifyRun } from './transcript.mjs';

function successfulReview(headSha, paths) {
  const report = { reviewed_sha: headSha, inputs_sufficient: true, findings: [], suggestions: [], prior_findings_checked: true };
  return parseSession([
    { type: 'session', id: 'inspection-session' },
    { type: 'model_change', model: 'openai-codex/gpt-6.1-sol', resolvedModelIsFallback: false },
    { type: 'thinking_level_change', thinkingLevel: 'medium' },
    ...paths.flatMap((path, index) => [
      { type: 'custom', customType: 'tool_execution_start', data: { toolCallId: `read-${index}`, toolName: 'read', args: { path } } },
      { type: 'message', message: { role: 'toolResult', toolCallId: `read-${index}`, toolName: 'read',
        isError: false, content: [{ type: 'text', text: 'source' }] } },
    ]),
    { type: 'message', message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-6.1-sol',
      stopReason: 'stop', usage: { input: 8, output: 2, totalTokens: 10 },
      content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(report)}\n\`\`\`` }] } },
    { type: 'custom', customType: 'session_exit', data: { kind: 'normal' } },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
}

test('main policy wins; untrusted head policy remains available as review evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  const put = async (path, text) => { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), text); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await put('.omp/config.yml', 'main config'); await put('.omp/unadvised-review.yml', 'main overlay');
  await put('.github/review-policy.md', 'main criteria');
  await put('CLAUDE.md', 'main rules'); await put('removed.mjs', 'removed');
  await put('rename.mjs', 'rename contents');
  await put('src/example.mjs', 'main source'); await put('src/example.mjs:raw', 'unchanged literal');
  await put('.omp/payload', Buffer.alloc(1024 * 1024 + 1));
  await put('.omp/payload.skipped', 'main real blob');
  git('add', '.'); git('commit', '-qm', 'main'); const baseSha = git('rev-parse', 'HEAD'); git('branch', 'policy');
  await put('.omp/config.yml', 'head config'); await put('.omp/unadvised-review.yml', 'head overlay');
  await put('.github/review-policy.md', 'untrusted head criteria');
  await put('.omp/mcp.json', '{}'); await put('.claude/skills/untrusted.txt', 'head skill');
  const untrustedSources = ['.mcp.json', 'mcp.json', 'AGENTS.md', 'nested/AGENTS.md', 'GEMINI.md',
    '.cursor/mcp.json', '.codex/config.toml', '.gemini/settings.json', '.vscode/mcp.json',
    '.codeium/windsurf/mcp_config.json', '.opencode/mcp.json', '.config/opencode/AGENTS.md',
    'opencode.json', 'opencode.jsonc', '.agent/AGENTS.md', '.agents/SYSTEM_TEMPLATE.md',
    '.windsurf/rules/rule.md', '.windsurfrules', '.cursorrules', '.clinerules/rule.md',
    '.pi/extensions/untrusted.js', '.omp/extensions/untrusted.js', '.omp/tools/untrusted.js',
    '.omp/hooks/pre/untrusted.js', '.omp/plugins/package.json', '.claude/hooks/pre/untrusted.js',
    '.github/copilot-instructions.md', '.github/instructions/rule.instructions.md', '.github/skills/untrusted/SKILL.md',
    'SYSTEM.md', 'SYSTEM_TEMPLATE.md', 'APPEND_SYSTEM.md', 'TITLE_SYSTEM.md', '.ssh.json', 'ssh.json'];
  for (const path of untrustedSources) await put(path, `untrusted source: ${path}`);
  await put('CLAUDE.md', 'head rules'); await put('large.bin', Buffer.alloc(1024 * 1024 + 1));
  await put('src/example.mjs', 'head source');
  await put('.omp/payload.skipped', 'head real blob');
  await rm(join(source, 'removed.mjs')); git('mv', 'rename.mjs', 'renamed.mjs');
  git('add', '.'); git('commit', '-qm', 'head'); const headSha = git('rev-parse', 'HEAD');
  const result = await exportWorkspace({ gitDir: join(source, '.git'), mainRef: 'policy', baseSha, headSha,
    pr: { repo: 'owner/repo', number: 1, title: 'change', body: 'body' }, outDir: join(root, 'work') });
  assert.ok((await readFile(join(result.repoDir, 'review/prompt.md'), 'utf8')).includes('main criteria'));
  assert.ok(!(await readFile(join(result.repoDir, 'review/prompt.md'), 'utf8')).includes('untrusted head criteria'));
  for (const [path, expected] of [['.omp/config.yml', 'main config'], ['.omp/unadvised-review.yml', 'main overlay'],
    ['review/head/.omp/config.yml', 'head config'], ['review/head/.omp/unadvised-review.yml', 'head overlay'],
    ['review/head/CLAUDE.md', 'head rules'], ['review/base/removed.mjs', 'removed'], ['review/head/renamed.mjs', 'rename contents']]) {
    assert.equal(await readFile(join(result.repoDir, path), 'utf8'), expected);
  }
  for (const path of ['CLAUDE.md', '.claude', '.omp/mcp.json', 'review/head/removed.mjs', 'review/head/large.bin']) {
    await assert.rejects(lstat(join(result.repoDir, path)), { code: 'ENOENT' });
  }
  for (const path of untrustedSources) {
    await assert.rejects(lstat(join(result.repoDir, path)), { code: 'ENOENT' });
    assert.equal(await readFile(join(result.reviewDir, 'head', path), 'utf8'), `untrusted source: ${path}`);
  }
  assert.match(await readFile(join(result.reviewDir, 'skipped/head/large.bin'), 'utf8'), /1 MiB/u);
  const inspection = JSON.parse(await readFile(join(result.reviewDir, 'inspection.json'), 'utf8'));
  assert.deepEqual(inspection.inspectionTargets, result.inspectionTargets);
  assert.deepEqual(new Set(inspection.exportedEntries), result.exportedEntries);
  assert.deepEqual(result.inspectionTargets['.omp/config.yml'],
    ['review/head/.omp/config.yml', 'review/base/.omp/config.yml']);
  assert.deepEqual(result.inspectionTargets['removed.mjs'], ['review/base/removed.mjs']);
  for (const targets of Object.values(result.inspectionTargets)) {
    for (const path of targets) assert.equal((await lstat(join(result.repoDir, path))).isFile(), true);
  }
  const actualEntries = new Set();
  const collectEntries = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      actualEntries.add(path);
      if (entry.isDirectory()) {
        actualEntries.add(`${path}/`);
        await collectEntries(join(directory, entry.name), path);
      }
    }
  };
  await collectEntries(result.repoDir);
  assert.deepEqual(result.exportedEntries, actualEntries);
  const classifyInspection = (path) => classifyRun({ session: successfulReview(headSha, ['review/diff.patch', path]),
    stdout: '', exitCode: 0, signal: null, headSha, ...inspection });
  assert.ok(classifyInspection('src/example.mjs:raw').reasons.includes('no_source_inspection'));
  assert.equal(classifyInspection('src/example.mjs').pass, true);
  assert.equal(await readFile(join(result.reviewDir, 'head/.omp/payload.skipped'), 'utf8'), 'head real blob');
  assert.equal(await readFile(join(result.reviewDir, 'base/.omp/payload.skipped'), 'utf8'), 'main real blob');
  assert.match(await readFile(join(result.reviewDir, 'skipped/head/.omp/payload'), 'utf8'), /1 MiB/u);
  assert.deepEqual(result.inspectionTargets['.omp/payload.skipped'],
    ['review/head/.omp/payload.skipped', 'review/base/.omp/payload.skipped']);
  assert.equal(classifyInspection('review/head/.omp/payload.skipped').pass, true);
  assert.ok(classifyInspection('review/skipped/head/.omp/payload').reasons.includes('no_source_inspection'));
  const pr = JSON.parse(await readFile(join(result.reviewDir, 'pr.json'), 'utf8'));
  assert.equal(pr.head_sha, headSha); assert.deepEqual(pr.commits, [{ sha: headSha, subject: 'head' }]);
  assert.deepEqual(JSON.parse(await readFile(join(result.reviewDir, 'prior-findings.json'), 'utf8')),
    { prior_head_sha: null, findings: [], replies: [] });
  await assert.rejects(exportWorkspace({ gitDir: join(source, '.git'), mainRef: 'missing', baseSha, headSha,
    pr, outDir: join(root, 'failure') }), (error) => error instanceof WorkspaceExportError && /git rev-parse/u.test(error.message));
});

test('archive symlinks cannot alias discovery sources or escape the checkout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-symlinks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, '.omp'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, '.omp/config.yml'), 'main config');
  await writeFile(join(source, '.omp/unadvised-review.yml'), 'main overlay');
  await mkdir(join(source, 'payload'));
  await writeFile(join(source, 'payload/copilot-instructions.md'), 'untrusted instructions');
  await mkdir(join(source, 'nested'));
  await symlink('payload', join(source, 'existing-link'));
  git('add', '.'); git('commit', '-qm', 'main');
  const baseSha = git('rev-parse', 'HEAD'); git('branch', 'policy');
  await rm(join(source, 'existing-link'));
  const links = [['.github', 'payload'], ['outside', '../'], ['nested/AGENTS.md', '../payload/copilot-instructions.md'],
    ['existing-link', '../']];
  for (const [path, target] of links) await symlink(target, join(source, path));
  git('add', '.'); git('commit', '-qm', 'head');
  const headSha = git('rev-parse', 'HEAD');
  const outDir = join(root, 'work');
  await mkdir(outDir); await writeFile(join(outDir, 'sentinel'), 'outside checkout');
  const result = await exportWorkspace({ gitDir: join(source, '.git'), mainRef: 'policy', baseSha, headSha, reviewPolicy: 'Trusted fixture criteria',
    pr: { repo: 'owner/repo', number: 2, title: 'symlinks', body: '' }, outDir });
  for (const [path, target] of links) {
    await assert.rejects(lstat(join(result.repoDir, path)), { code: 'ENOENT' });
    assert.equal(await readFile(join(result.reviewDir, 'symlinks/head', path), 'utf8'), target);
  }
  const assertNoSymlinks = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, join(path, entry.name));
      if (entry.isDirectory()) await assertNoSymlinks(join(path, entry.name));
    }
  };
  await assertNoSymlinks(result.repoDir);
  assert.equal(await readFile(join(outDir, 'sentinel'), 'utf8'), 'outside checkout');
  assert.equal(await readFile(join(result.repoDir, 'payload/copilot-instructions.md'), 'utf8'), 'untrusted instructions');
  assert.deepEqual(new Set(result.changedPaths), new Set(links.map(([path]) => path)));
  assert.deepEqual(result.inspectionTargets['existing-link'],
    ['review/symlinks/head/existing-link', 'review/symlinks/base/existing-link']);
  for (const targets of Object.values(result.inspectionTargets)) {
    assert.ok(targets.every((path) => path.startsWith('review/symlinks/')));
  }
  const inspection = JSON.parse(await readFile(join(result.reviewDir, 'inspection.json'), 'utf8'));
  for (const side of ['head', 'base']) {
    const classified = classifyRun({ session: successfulReview(headSha,
      ['review/diff.patch', `review/symlinks/${side}/existing-link:raw`]), stdout: '', exitCode: 0,
      signal: null, headSha, ...inspection });
    assert.equal(classified.pass, true);
  }
  const overlay = await readFile(new URL('./config/reviewer-overlay.yml', import.meta.url), 'utf8');
  for (const basename of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'copilot-instructions.md']) {
    assert.ok(overlay.includes(`context-file:project:${basename}`));
  }
  assert.match(overlay, /includeWorkspaceTree: false/u);
});

test('literal directories with selector-looking names receive no source credit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-literal-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, '.omp'), { recursive: true });
  await mkdir(join(source, 'src/example.mjs:raw'), { recursive: true });
  await writeFile(join(source, '.omp/config.yml'), 'main config');
  await writeFile(join(source, '.omp/unadvised-review.yml'), 'main overlay');
  await writeFile(join(source, 'src/example.mjs'), 'main source');
  await writeFile(join(source, 'src/example.mjs:raw/unchanged'), 'unchanged');
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-qm', 'main'); const baseSha = git('rev-parse', 'HEAD'); git('branch', 'policy');
  await writeFile(join(source, 'src/example.mjs'), 'head source');
  git('add', '.'); git('commit', '-qm', 'head'); const headSha = git('rev-parse', 'HEAD');
  const result = await exportWorkspace({ gitDir: join(source, '.git'), mainRef: 'policy', baseSha, headSha, reviewPolicy: 'Trusted fixture criteria',
    pr: { repo: 'owner/repo', number: 3, title: 'directory', body: '' }, outDir: join(root, 'work') });
  assert.equal((await lstat(join(result.repoDir, 'src/example.mjs:raw'))).isDirectory(), true);
  assert.ok(result.exportedEntries.has('src/example.mjs:raw'));
  const inspection = JSON.parse(await readFile(join(result.reviewDir, 'inspection.json'), 'utf8'));
  const classified = classifyRun({ session: successfulReview(headSha, ['review/diff.patch', 'src/example.mjs:raw']),
    stdout: '', exitCode: 0, signal: null, headSha, ...inspection });
  assert.ok(classified.reasons.includes('no_source_inspection'));
});

test('oversized-only changes cannot borrow checkout, base or skip-receipt credit', async (t) => {
  for (const mode of ['added', 'grown']) {
    const root = await mkdtemp(join(tmpdir(), 'review-oversized-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'source');
    await mkdir(join(source, '.omp'), { recursive: true });
    await writeFile(join(source, '.omp/config.yml'), 'main config');
    await writeFile(join(source, '.omp/unadvised-review.yml'), 'main overlay');
    if (mode === 'grown') await writeFile(join(source, 'oversized.bin'), 'small base');
    const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.'); git('commit', '-qm', 'main'); const baseSha = git('rev-parse', 'HEAD'); git('branch', 'policy');
    await writeFile(join(source, 'oversized.bin'), Buffer.alloc(1024 * 1024 + 1));
    git('add', '.'); git('commit', '-qm', 'head'); const headSha = git('rev-parse', 'HEAD');
    const result = await exportWorkspace({ gitDir: join(source, '.git'), mainRef: 'policy', baseSha, headSha, reviewPolicy: 'Trusted fixture criteria',
      pr: { repo: 'owner/repo', number: 4, title: 'oversized', body: '' }, outDir: join(root, 'work') });
    assert.deepEqual(result.changedPaths, ['oversized.bin']);
    assert.deepEqual(result.inspectionTargets['oversized.bin'], []);
    assert.match(await readFile(join(result.reviewDir, 'skipped/head/oversized.bin'), 'utf8'), /1 MiB/u);
    await assert.rejects(lstat(join(result.reviewDir, 'head/oversized.bin')), { code: 'ENOENT' });
    const inspection = JSON.parse(await readFile(join(result.reviewDir, 'inspection.json'), 'utf8'));
    for (const path of ['oversized.bin', 'review/base/oversized.bin', 'review/skipped/head/oversized.bin']) {
      const classified = classifyRun({ session: successfulReview(headSha, ['review/diff.patch', path]),
        stdout: '', exitCode: 0, signal: null, headSha, ...inspection });
      assert.ok(classified.reasons.includes('no_source_inspection'), `${mode}: ${path}`);
    }
  }
});

test('aggregate bytes, streaming archive bytes and entry caps fail closed without partial checkout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-export-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(join(source, '.omp'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, '.omp/config.yml'), 'main config');
  await writeFile(join(source, '.omp/unadvised-review.yml'), 'main overlay');
  git('add', '.'); git('commit', '-qm', 'main'); const baseSha = git('rev-parse', 'HEAD'); git('branch', 'policy');
  await writeFile(join(source, 'source.bin'), Buffer.alloc(8192));
  git('add', '.'); git('commit', '-qm', 'head'); const headSha = git('rev-parse', 'HEAD');
  const options = { gitDir: join(source, '.git'), mainRef: 'policy', baseSha, headSha, reviewPolicy: 'Trusted fixture criteria',
    pr: { repo: 'owner/repo', number: 5, title: 'budget', body: '' } };
  for (const [name, limits] of [
    ['blob-preflight', { maxExportBytes: 1024 }],
    ['archive-stream', { maxExportBytes: 10000 }],
    ['entries', { maxEntries: 1 }],
  ]) {
    const outDir = join(root, name);
    await assert.rejects(exportWorkspace({ ...options, ...limits, outDir }),
      (error) => error instanceof WorkspaceExportError && error.code === 'workspace_too_large');
    await assert.rejects(lstat(join(outDir, 'repo')), { code: 'ENOENT' });
  }
  const normal = await exportWorkspace({ ...options, maxExportBytes: 128 * 1024, outDir: join(root, 'normal') });
  assert.equal((await readFile(join(normal.repoDir, 'source.bin'))).length, 8192);
  assert.equal(await readFile(join(normal.repoDir, '.omp/config.yml'), 'utf8'), 'main config');
});
