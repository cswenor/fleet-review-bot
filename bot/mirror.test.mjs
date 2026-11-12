import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReviewPolicy, loadThresholds, Mirror } from './mirror.mjs';
import { createHash } from 'node:crypto';
import { buildCheckOutput } from './evidence.mjs';
const mainSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const thresholds = { model: 'jev-1.13.0', calibratedModel: 'jev-1.13.0', block: 0.5,
  approveBlockingMax: 0.3, approveSevereMax: 0.05, priorResolvedMin: 0.8 };
test('mirror defaults to Sol/medium and validates instance review configuration', () => {
  const defaults = new Mirror({ github: {} });
  assert.equal(defaults.reviewModel, 'openai-codex/gpt-6.1-sol');
  assert.equal(defaults.reviewThinking, 'medium');
  const opus = new Mirror({ github: {}, reviewModel: 'anthropic/claude-opus-5-5', reviewThinking: 'high' });
  assert.equal(opus.reviewModel, 'anthropic/claude-opus-5-5');
  assert.equal(opus.reviewThinking, 'high');
  for (const config of [{ reviewModel: 'other/model' }, { reviewModel: '' }, { reviewThinking: '' },
    { reviewThinking: 'arbitrary' }]) assert.throws(() => new Mirror({ github: {}, ...config }), /Invalid review model or thinking/u);
});
test('closure includes builder-bot and human replies, but excludes other bots', async () => {
  const builder = { id: 1003, login: 'builder[bot]', type: 'Bot' };
  const other = { id: 9, login: 'other[bot]', type: 'Bot' };
  const human = { id: 42, login: 'author', type: 'User' };
  const mirror = new Mirror({ github: { repo: 'example-org/example-project', paginate: async (path) => {
    if (path === '/repos/example-org/example-project/pulls/7/comments') {
      return [builder, other, human].map((user) => ({ in_reply_to_id: 500, user, body: 'Fixed finding' }));
    }
    assert.equal(path, '/repos/example-org/example-project/issues/7/comments');
    return [{ user: builder, body: 'Ready for review', created_at: '2026-10-10T20:01:00Z' }];
  } } });
  const replies = await mirror.closure({ number: 7, findings: [{ id: 'F1', comment_id: 500 }],
    commentsSince: Date.parse('2026-10-10T20:00:00Z') });
  assert.deepEqual(replies.map((reply) => reply.author), ['builder[bot]', 'author', 'builder[bot]']);
  assert.deepEqual(replies.map((reply) => reply.finding_id), ['F1', 'F1', null]);
});
test('closure retains conversation evidence before a later review finished, but not before the findings window', async () => {
  const commentsSince = Date.parse('2026-10-10T20:00:00Z');
  const laterFinished = Date.parse('2026-10-10T20:03:00Z');
  const user = { id: 1003, login: 'builder[bot]', type: 'Bot' };
  const comments = [
    { user, body: 'Old evidence', created_at: '2026-10-10T19:59:00Z' },
    { user, body: 'At window start', created_at: '2026-10-10T20:00:00Z' },
    { user, body: 'F1 evidence survives a neutral review', created_at: '2026-10-10T20:01:00Z' },
  ];
  assert.ok(Date.parse(comments[2].created_at) < laterFinished);
  const mirror = new Mirror({ github: { repo: 'example-org/example-project', paginate: async () => comments } });
  const replies = await mirror.closure({ number: 7, findings: [], commentsSince });
  assert.deepEqual(replies.map((reply) => reply.body), ['F1 evidence survives a neutral review']);
  for (const window of [undefined, null, NaN, Infinity]) {
    assert.deepEqual(await mirror.closure({ number: 7, findings: [], commentsSince: window }), []);
  }
});
test('absent, empty, unreadable and invalid main thresholds fail closed', async () => {
  for (const text of ['', ' \n', '{', JSON.stringify({ ...thresholds, block: 2 }), JSON.stringify({ ...thresholds, calibratedModel: '' }),
    JSON.stringify({ ...thresholds, model: 'jev-latest' }), JSON.stringify({ ...thresholds, calibratedModel: 'jev-1.14.0' })]) {
    await assert.rejects(loadThresholds({ git: async () => text, mainSha }), /verdict_unavailable/u);
  }
  for (const message of ['path absent', 'unreadable', 'mirror_timeout']) {
    await assert.rejects(loadThresholds({ git: async () => { throw new Error(message); }, mainSha }), /verdict_unavailable/u);
  }
});

test('thresholds hash binds raw git-show bytes rather than parsed JSON serialization', async () => {
  const bytes = Buffer.from(`{\r\n  ${JSON.stringify(thresholds).slice(1, -1)}, "note": "é"\r\n}\r\n`);
  let encoding;
  const mirror = new Mirror({ github: {}, executeImpl: async (_command, _args, options) => {
    encoding = options.encoding;
    return { stdout: bytes };
  } });
  const receipt = await loadThresholds({ git: (...args) => mirror.git(...args), mainSha });
  assert.equal(encoding, 'buffer');
  assert.equal(receipt.note, 'é');
  assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.notEqual(receipt.sha256, createHash('sha256').update(JSON.stringify({ ...thresholds, note: receipt.note })).digest('hex'));
});

test('fetch authentication is scoped to child environment, never argv or persisted config', async () => {
  const token = 'fixture-installation-token';
  const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
  const calls = [];
  const mirror = new Mirror({ github: { token: async () => token },
    executeImpl: async (...args) => { calls.push(args); return { stdout: '' }; } });
  await mirror.fetchHead(7);
  const [command, args, options] = calls[0];
  assert.equal(command, 'git'); assert.equal(args.includes('fetch'), true);
  assert.equal(JSON.stringify(args).includes(token), false); assert.equal(JSON.stringify(args).includes(auth), false);
  assert.equal(args.includes('-c'), false);
  assert.equal(options.env.GIT_CONFIG_COUNT, '3');
  assert.equal(options.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(options.env.GIT_CONFIG_VALUE_0, 'AUTHORIZATION: basic ' + auth);
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
  await mirror.git('rev-parse', 'main');
  assert.equal(calls[1][2].env.GIT_CONFIG_COUNT, '2');
  assert.equal(JSON.stringify(calls[1][2].env).includes(auth), false, 'authentication must not bleed into other git operations');
  assert.equal(options.timeout, 120000); assert.equal(options.killSignal, 'SIGKILL');
  assert.equal(calls[1][2].timeout, 30000);
  assert.equal(options.env.GIT_CONFIG_KEY_1, 'http.lowSpeedLimit');
  assert.equal(options.env.GIT_CONFIG_VALUE_1, '1000');
  assert.equal(options.env.GIT_CONFIG_KEY_2, 'http.lowSpeedTime');
  assert.equal(options.env.GIT_CONFIG_VALUE_2, '30');
});
test('unavailable prior Git object declines carry so the current head can receive full review', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'carry-mirror-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'mirror.git'));
  const mirror = new Mirror({ github: {}, stateRoot: root, executeImpl: async (command, args) => {
    if (args.includes('--version')) return { stdout: 'git version 2.39.5' };
    if (args.includes('patch-id')) return { stdout: '' };
    throw new Error('old object absent');
  } });
  mirror.fetchHead = async () => {};
  mirror.git = async (...args) => args.at(-1) === 'main' ? mainSha : headSha;
  const prior = { base_ref: 'main', head_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40), result_json: JSON.stringify({
    result: { pass: true, evidence: { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'medium' } },
    review_route: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
    verdict: { decision: 'approve' }, reportText: 'No findings.',
  }) };
  assert.equal(await mirror.carry({ pr: 1, head_sha: headSha, base_ref: 'main' }, prior), null);
});

test('review criteria load only main and fail closed when absent, empty or unreadable', async () => {
  const calls = [];
  const git = async (...args) => { calls.push(args); return 'Main criteria'; };
  assert.deepEqual(await loadReviewPolicy({ git, mainSha }),
    { text: 'Main criteria', source: `main@${mainSha}`, sha256: createHash('sha256').update('Main criteria').digest('hex') });
  assert.deepEqual(calls, [['show', `${mainSha}:.github/review-policy.md`]]);
  for (const text of ['', ' \n']) {
    await assert.rejects(loadReviewPolicy({ git: async () => text, mainSha }), /policy_unavailable/u);
  }
  for (const message of ['path absent', 'unreadable', 'mirror_timeout']) {
    await assert.rejects(loadReviewPolicy({ git: async () => { throw new Error(message); }, mainSha }), /policy_unavailable/u);
  }
});

test('policy receipt and check evidence bind the exact trusted criteria bytes', async () => {
  const text = 'Main simplicity criteria\n';
  const mirror = new Mirror({ github: {} });
  mirror.git = async (command, ...args) => {
    const path = args[0].slice(mainSha.length + 1);
    return path === '.github/review-policy.md' ? text
      : path === '.omp/config.yml' ? 'modelRoles:\n  review: openai-codex/gpt-6.1-sol:medium\n' : 'unexpected';
  };
  const receipt = await mirror.policyReceipt(mainSha);
  assert.equal(receipt.review_policy_text, text);
  assert.equal(receipt.review_policy_path, '.github/review-policy.md');
  assert.equal(receipt.review_policy_sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(receipt.review_policy_source, `main@${mainSha}`);
  const output = buildCheckOutput({ head_sha: mainSha, policy: receipt });
  for (const key of ['review_policy_path', 'review_policy_sha256', 'review_policy_source']) {
    assert.ok(output.summary.includes(`policy.${key}: ${receipt[key].replace(/@(?=[A-Za-z0-9_-])/gu, '@\u200B')}`));
  }
  assert.ok(!output.summary.includes(text));
});

test('carry requires reviewer evidence matching the current instance model and effort', async () => {
  const mirror = new Mirror({ github: {}, reviewModel: 'anthropic/claude-opus-5-5', reviewThinking: 'high' });
  mirror.gitDir = '.';
  mirror.fetchHead = async () => assert.fail('Incompatible review must not enter carry verification');
  for (const evidence of [undefined,
    { servedModel: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'high' },
    { servedModel: 'anthropic/claude-opus-5-5', thinkingLevel: 'medium' }]) {
    const prior = { base_ref: 'main', result_json: JSON.stringify({ result: { pass: true, evidence },
      review_route: { model: 'anthropic/claude-opus-5-5', thinking: 'high' },
      verdict: { decision: 'approve' }, reportText: 'No findings.' }) };
    assert.equal(await mirror.carry({ pr: 1, head_sha: headSha, base_ref: 'main' }, prior), null);
  }
  for (const review_route of [undefined, { model: 'openai-codex/gpt-6.1-sol', thinking: 'high' },
    { model: 'anthropic/claude-opus-5-5', thinking: 'medium' }]) {
    const fallbackPrior = { base_ref: 'main', result_json: JSON.stringify({ review_route,
      result: { pass: true, evidence: { servedModel: 'anthropic/claude-opus-5-5', thinkingLevel: 'high',
        modelChanges: [{ model: 'openai-codex/gpt-6.1-sol' }, { model: 'anthropic/claude-opus-5-5', role: 'fallback' }] } },
      verdict: { decision: 'approve' }, reportText: 'No findings.',
    }) };
    assert.equal(await mirror.carry({ pr: 1, head_sha: headSha, base_ref: 'main' }, fallbackPrior), null);
  }
});

test('real main-merge carry binds trusted reviewer config and overlay bytes', async (t) => {
  for (const change of ['unrelated', 'config', 'overlay', 'missing-overlay']) {
    const root = await mkdtemp(join(tmpdir(), 'carry-policy-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '--initial-branch=main');
    git('config', 'user.name', 'Example'); git('config', 'user.email', 'example@example.invalid');
    await mkdir(join(root, '.github')); await mkdir(join(root, '.omp'));
    await writeFile(join(root, '.github/review-policy.md'), 'Review criteria\n');
    await writeFile(join(root, '.omp/config.yml'), 'modelRoles:\n  review: openai-codex/gpt-6.1-sol:medium\n');
    await writeFile(join(root, '.omp/unadvised-review.yml'), 'modelFallback: false\n');
    git('add', '.'); git('commit', '-qm', 'Initial policy');
    const priorBase = git('rev-parse', 'HEAD');
    const mirror = new Mirror({ github: {}, stateRoot: root });
    mirror.gitDir = join(root, '.git'); mirror.fetchHead = async () => {};
    const policy = await mirror.policyReceipt(priorBase);
    git('switch', '-qc', 'feature');
    await writeFile(join(root, 'feature.mjs'), 'export const value = 1;\n');
    git('add', '.'); git('commit', '-qm', 'Feature');
    const priorHead = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    if (change === 'config') await writeFile(join(root, '.omp/config.yml'), 'modelRoles:\n  review: openai-codex/gpt-6.1-sol:medium\ninstructions: Stricter\n');
    else if (change === 'overlay') await writeFile(join(root, '.omp/unadvised-review.yml'), 'modelFallback: false\ninstructions: Stricter\n');
    else if (change === 'missing-overlay') await rm(join(root, '.omp/unadvised-review.yml'));
    else await writeFile(join(root, 'README.md'), 'Unrelated main change\n');
    git('add', '-A'); git('commit', '-qm', 'Update trusted main');
    git('switch', '-q', 'feature'); git('merge', '--no-edit', 'main');
    const current = git('rev-parse', 'HEAD'); git('update-ref', 'refs/pull/1/head', current);
    const prior = { base_ref: 'main', head_sha: priorHead, base_sha: priorBase, result_json: JSON.stringify({
      policy, review_route: { model: mirror.reviewModel, thinking: mirror.reviewThinking },
      result: { pass: true, evidence: { servedModel: mirror.reviewModel, thinkingLevel: mirror.reviewThinking } },
      verdict: { decision: 'approve' }, reportText: 'No findings.' }) };
    const carried = mirror.carry({ pr: 1, head_sha: current, base_ref: 'main' }, prior);
    if (change === 'missing-overlay') await assert.rejects(carried, /policy_unavailable/u);
    else if (change === 'unrelated') assert.equal((await carried)?.carried_forward_from, priorHead);
    else assert.equal(await carried, null, change);
  }
});
