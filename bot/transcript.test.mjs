import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSession, classifyRun } from './transcript.mjs';

// Sanitized fixtures follow the real JSONL paths documented in transcript.mjs.
const sha = 'a'.repeat(40);
const report = { reviewed_sha: sha, inputs_sufficient: true, findings: [], suggestions: [], prior_findings_checked: true };
function fixture({ result = report, text, fallback = false } = {}) {
  return [
    { type: 'session', version: 3, id: 'review-session' },
    { type: 'model_change', model: 'openai-codex/gpt-6.1-sol', resolvedModelIsFallback: false },
    { type: 'thinking_level_change', thinkingLevel: 'medium', configured: null },
    { type: 'credential_pin', provider: 'openai-codex', hash: '0123456789ab-redacted' },
    ...['review/diff.patch', 'review/head/src/example.mjs:1-40'].flatMap((path, index) => [
      { type: 'custom', customType: 'tool_execution_start',
        data: { toolCallId: `read-${index}`, toolName: 'read', args: { path } } },
      { type: 'message', message: { role: 'toolResult', toolCallId: `read-${index}`,
        toolName: 'read', isError: false, content: [{ type: 'text', text: 'fixture source' }] } },
    ]),
    ...(fallback ? [{ type: 'model_change', model: 'anthropic/claude-opus-5-5', role: 'fallback', resolvedModelIsFallback: true },
      { type: 'message', message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-6.1-sol',
        stopReason: 'error', content: [], usage: { totalTokens: 0 } } }] : []),
    { type: 'message', message: { role: 'assistant', provider: fallback ? 'anthropic' : 'openai-codex',
      model: fallback ? 'claude-opus-5-5' : 'gpt-6.1-sol', stopReason: 'stop',
      content: [{ type: 'text', text: text ?? `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` }],
      usage: { input: 8, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 13 } } },
    { type: 'custom', customType: 'session_exit', data: { reason: 'dispose', kind: 'normal' } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
}
function rewriteFixture(change, options) {
  const entries = fixture(options).split('\n').map((line) => JSON.parse(line));
  change(entries);
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}
const inspectionFixture = (paths) => {
  const inspectionTargets = Object.fromEntries(paths.map((path) => [path, [path, `review/head/${path}`, `review/base/${path}`]]));
  return { inspectionTargets, exportedEntries: ['review/diff.patch', ...Object.values(inspectionTargets).flat()] };
};
const classify = (session, extra = {}) => classifyRun({ session, stdout: '', exitCode: 0,
  signal: null, headSha: sha, ...inspectionFixture(['src/example.mjs']), ...extra });
test('normal and fallback receipts derive served model from successful assistant usage', () => {
  for (const fallback of [false, true]) {
    const session = parseSession(fixture({ fallback }));
    assert.equal(classify(session).pass, true);
    assert.equal(session.servedModel, fallback ? 'anthropic/claude-opus-5-5' : 'openai-codex/gpt-6.1-sol');
    assert.equal(session.credentialPin.hashPrefix, '0123456789ab');
    assert.equal(session.usage.totalTokens, 13);
    assert.equal(session.id, 'review-session');
    if (fallback) assert.equal(session.modelChanges[1].role, 'fallback');
  }
});
test('configured primary model and effort must match every successful turn and model change', () => {
  for (const reviewModel of ['openai-codex/gpt-6.1-sol', 'anthropic/claude-opus-5-5']) {
    for (const reviewThinking of ['low', 'medium', 'high']) {
      const session = parseSession(rewriteFixture((entries) => {
        const [provider, model] = reviewModel.split('/');
        entries.find((entry) => entry.type === 'model_change').model = reviewModel;
        entries.find((entry) => entry.type === 'thinking_level_change').thinkingLevel = reviewThinking;
        entries.find((entry) => entry.type === 'credential_pin').provider = provider;
        Object.assign(entries.find((entry) => entry.message?.role === 'assistant').message, { provider, model });
      }));
      assert.equal(classify(session, { reviewModel, reviewThinking }).pass, true);
      const otherModel = reviewModel === 'openai-codex/gpt-6.1-sol'
        ? 'anthropic/claude-opus-5-5' : 'openai-codex/gpt-6.1-sol';
      assert.ok(classify(session, { reviewModel: otherModel, reviewThinking }).reasons.includes('model_not_allowed'));
      const changedModel = { ...session, modelChanges: [...session.modelChanges, { model: otherModel }] };
      assert.ok(classify(changedModel, { reviewModel, reviewThinking }).reasons.includes('model_not_allowed'));
      const changedTurn = { ...session, assistantTurns: [...session.assistantTurns,
        { servedModel: otherModel, stopReason: 'toolUse', fallbackAuthorized: false }] };
      assert.ok(classify(changedTurn, { reviewModel, reviewThinking }).reasons.includes('model_not_allowed'));
      assert.ok(classify(session, { reviewModel, reviewThinking: reviewThinking === 'high' ? 'low' : 'high' })
        .reasons.includes('effort_mismatch'));
      assert.ok(classify(session, { reviewModel: 'other/model', reviewThinking }).reasons.includes('model_not_allowed'));
      assert.ok(classify(session, { reviewModel, reviewThinking: 'arbitrary' }).reasons.includes('model_not_allowed'));
    }
  }
});
const cases = [
  ['exit_nonzero', {}, { exitCode: 1 }], ['killed', {}, { signal: 'SIGTERM' }],
  ['no_session_exit', { exitKind: null }], ['abnormal_exit', { exitKind: 'fatal' }],
  ['stop_reason_not_stop', { stopReason: 'error' }], ['json_missing', { jsonState: 'missing', json: null }],
  ['json_invalid', { jsonState: 'invalid', json: null }],
  ['sha_mismatch', { json: { ...report, reviewed_sha: 'b'.repeat(40) } }],
  ['inputs_insufficient', { json: { ...report, inputs_sufficient: false } }],
  ['no_source_inspection', { toolReads: [] }], ['model_not_allowed', { servedModel: 'other/model' }],
  ['effort_mismatch', { thinkingLevel: 'high' }],
];
for (const [reason, change, extra] of cases) test(`non-pass: ${reason}`, () => {
  const result = classify({ ...parseSession(fixture()), ...change }, extra);
  assert.equal(result.pass, false); assert.ok(result.reasons.includes(reason));
});
test('invalid fence, duplicate fences, schema and malformed JSONL fail closed', () => {
  for (const text of ['```json\n{\n```', '```json\n{}\n```', `${parseSession(fixture()).finalText}\n\`\`\`json\n{}\n\`\`\``]) {
    assert.ok(classify(parseSession(fixture({ text }))).reasons.includes('json_invalid'));
  }
  assert.ok(classify(parseSession(fixture() + '\n{broken')).reasons.includes('json_invalid'));
});
test('directory searches cannot substitute for reading diff and changed source', () => {
  const session = parseSession(fixture());
  session.toolReads = [{ toolName: 'glob', path: '**/*.mjs' }, { toolName: 'read', path: 'review/diff.patch' }];
  assert.ok(classify(session).reasons.includes('no_source_inspection'));
});

test('Opus exact reads and normalized checkout/snapshot paths prove changed-source inspection', () => {
  const session = parseSession(fixture({ fallback: true }));
  for (const prefix of ['', './', '/work/repo/']) {
    session.toolReads = [
      { toolName: 'read', path: `${prefix}review/diff.patch` },
      { toolName: 'grep', path: 'review/head' },
      { toolName: 'read', path: `${prefix}review/head/.github/workflows/deploy-kamal.yml` },
    ];
    assert.equal(classify(session, inspectionFixture(['.github/workflows/deploy-kamal.yml'])).pass, true);
    for (const side of ['review/base/', '']) {
      session.toolReads[2].path = `${prefix}${side}.github/workflows/deploy-kamal.yml:1-40`;
      assert.equal(classify(session, inspectionFixture(['.github/workflows/deploy-kamal.yml'])).pass, true);
    }
  }
});

test('silent max-time expiry requires an explicit runner receipt, not an empty session guess', () => {
  const empty = parseSession('');
  assert.ok(!classify(empty).reasons.includes('max_time'));
  assert.ok(classify(empty, { maxTimeExpired: true }).reasons.includes('max_time'));
});

test('measured auth failures work with stderr-only and persisted assistant errors', () => {
  for (const marker of ['auth-gateway 401: {"error":"unauthorized"}', 'No API key found for openai-codex.']) {
    assert.ok(classify(parseSession(''), { exitCode: 1, stderr: marker }).reasons.includes('auth_failed'));
    const session = parseSession(JSON.stringify({ type: 'message', message: {
      role: 'assistant', stopReason: 'error', content: [], errorMessage: marker, usage: { totalTokens: 0 },
    } }));
    assert.deepEqual(session.errorMessages, [marker]);
    assert.ok(classify(session, { exitCode: 1 }).reasons.includes('auth_failed'));
    assert.ok(!classify({ ...parseSession(fixture()), errorMessages: [marker] }).reasons.includes('auth_failed'));
  }
});

test('open stdin receives the measured startup phase reason', () => {
  const result = classify(parseSession(''), { exitCode: 124,
    stderr: 'Still starting after 10s — phase: readPipedInput' });
  assert.ok(result.reasons.includes('stdin_wait'));
  assert.equal(result.pass, false);
});

test('forced primary/fallback provider errors and live-session deadline are non-pass', () => {
  const markers = ['The socket connection was closed unexpectedly.',
    'getaddrinfo ETIMEOUT chatgpt.com', 'getaddrinfo ETIMEOUT gateway', 'Connection error.'];
  for (const marker of markers) {
    const session = { ...parseSession(fixture()), stopReason: 'aborted', errorMessages: [marker] };
    const result = classify(session, { exitCode: 1, stderr: 'Deadline exceeded\n' });
    assert.ok(result.reasons.includes('provider_error'));
    assert.ok(result.reasons.includes('max_time'));
    assert.equal(result.pass, false);
    assert.equal(classify({ ...parseSession(fixture()), errorMessages: [marker] }).pass, true);
  }
});

test('inspection requires correlated successful completions, not tool starts', () => {
  for (const mode of ['failed', 'missing', 'orphan', 'wrong-tool']) {
    const jsonl = rewriteFixture((entries) => {
      for (let index = entries.length - 1; index >= 0; index--) {
        const message = entries[index].message;
        if (message?.role !== 'toolResult') continue;
        if (mode === 'failed') {
          message.isError = true;
          message.content = [{ type: 'text', text: 'File not found' }];
        } else if (mode === 'missing') entries.splice(index, 1);
        else if (mode === 'orphan') message.toolCallId = `orphan-${index}`;
        else message.toolName = 'glob';
      }
    });
    const session = parseSession(jsonl);
    assert.deepEqual(session.toolReads, []);
    assert.ok(classify(session).reasons.includes('no_source_inspection'), mode);
  }
  assert.equal(parseSession(fixture()).toolReads.length, 2);
});

test('the final report cannot reuse an earlier successful model or usage receipt', () => {
  for (const mode of ['zero-usage', 'missing-usage', 'missing-provider', 'wrong-model', 'unreceipted-opus']) {
    const session = parseSession(rewriteFixture((entries) => {
      const finalIndex = entries.findLastIndex((entry) => entry.message?.role === 'assistant');
      const final = entries[finalIndex].message;
      entries.splice(finalIndex, 0, { type: 'message', message: { ...final,
        content: [{ type: 'text', text: 'Inspecting source.' }] } });
      if (mode === 'zero-usage') final.usage = { totalTokens: 0 };
      else if (mode === 'missing-usage') delete final.usage;
      else if (mode === 'missing-provider') delete final.provider;
      else if (mode === 'wrong-model') { final.provider = 'untrusted'; final.model = 'other'; }
      else { final.provider = 'anthropic'; final.model = 'claude-opus-5-5'; }
    }));
    assert.equal(session.jsonState, 'parsed');
    assert.ok(classify(session).reasons.includes('model_not_allowed'), mode);
    if (['zero-usage', 'missing-usage', 'missing-provider'].includes(mode)) assert.equal(session.servedModel, null);
  }
});

test('every successful assistant turn and non-primary model change must be authorized', () => {
  const intermediate = parseSession(rewriteFixture((entries) => {
    const finalIndex = entries.findLastIndex((entry) => entry.message?.role === 'assistant');
    entries.splice(finalIndex, 0, { type: 'message', message: {
      role: 'assistant', provider: 'untrusted', model: 'other', stopReason: 'toolUse',
      usage: { totalTokens: 3 }, content: [],
    } });
  }));
  assert.equal(intermediate.servedModel, 'openai-codex/gpt-6.1-sol');
  assert.ok(classify(intermediate).reasons.includes('model_not_allowed'));
  for (const change of [{ role: undefined }, { resolvedModelIsFallback: false },
    { model: 'anthropic/other' }]) {
    const session = parseSession(rewriteFixture((entries) => {
      Object.assign(entries.find((entry) => entry.type === 'model_change' && entry.role === 'fallback'), change);
    }, { fallback: true }));
    assert.ok(classify(session).reasons.includes('model_not_allowed'));
  }
  const unused = parseSession(rewriteFixture((entries) => entries.splice(1, 0, {
    type: 'model_change', model: 'anthropic/claude-opus-5-5', resolvedModelIsFallback: false,
  })));
  assert.ok(classify(unused).reasons.includes('model_not_allowed'));
  assert.equal(classify(parseSession(fixture({ fallback: true }))).pass, true);
});

test('closure requires each supplied prior finding exactly once with an explicit status and cited resolution', () => {
  const finding = { id: 'F1', severity: 'blocking', category: 'correctness', file: 'src/example.mjs', line: 12,
    title: 'guard', scenario: 'missing guard', status: 'resolved', resolution_reason: 'Fixed in src/example.mjs:12.' };
  const check = (findings, checked = true) => classify(parseSession(fixture({
    result: { ...report, findings, prior_findings_checked: checked },
  })), { priorFindingIds: ['F1'], exportedEntries: [...inspectionFixture(['src/example.mjs']).exportedEntries,
    'path', 'apps/worker/src/runners/infra-alert.ts', 'apps/worker/src/lib/infra-review.ts', 'empty-dir', 'empty-dir/',
    'review/head/CLAUDE.md', 'review/base/removed.mjs'] });
  for (const findings of [[], [finding, finding], [{ ...finding, status: 'new' }],
    [{ ...finding, id: 'F2' }], [{ ...finding, resolution_reason: '' }],
    [{ ...finding, resolution_reason: 'Fixed.' }], [{ ...finding, resolution_reason: 'src/example.mjs:0' }],
    [{ ...finding, resolution_reason: 'Fixed at https://example.invalid:12' }]]) {
    assert.ok(check(findings).reasons.includes('prior_findings_incomplete'));
  }
  assert.ok(check([finding], false).reasons.includes('prior_findings_incomplete'));
  assert.equal(check([finding]).pass, true);
  assert.equal(check([{ ...finding, status: 'still_open', resolution_reason: '' }]).pass, true);
  const realReason = 'apps/worker/src/runners/infra-alert.ts:329-349 loads … apps/worker/src/lib/infra-review.ts:432-453 …';
  for (const citation of [realReason, 'path:12', 'path:12-30', 'path:12,40', 'path:12-30,40',
    '`path:12-30`', 'path:12)', 'path:12.', 'path:12,', 'path:12;', 'path:12-30,40-50',
    './src/example.mjs:12', '/work/repo/src/example.mjs:12', 'review/head/src/example.mjs:12',
    'review/base/src/example.mjs:12', 'review/head/CLAUDE.md:12', 'review/base/removed.mjs:1',
    './review/head/CLAUDE.md:12', '/work/repo/review/base/removed.mjs:1',
    'review/head/path:12', 'review/base/path:12', 'Fixed (path:12).',
    'see (review/head/src/example.mjs:12-30,40); done', '(src/example.mjs:12)',
    'Head assigns it (review/head/src/example.mjs:76-78,103-107); disabled policy returns early (review/base/removed.mjs:1).',
    'path:62-77 now resolves the newest main push Build image run.']) {
    assert.equal(check([{ ...finding, resolution_reason: citation }]).pass, true, citation);
  }
  for (const citation of ['https://x:443', 'line 12', '12', '12:30', 'Fixed in release v1.2:3.',
    '12.5:30', 'example.com:443', 'nonexistent.mjs:12', 'src:12', 'empty-dir:12', 'path:30-12',
    'CLAUDE.md:12', 'removed.mjs:1', 'review/head/nonexistent.mjs:12', 'review/base/nonexistent.mjs:1',
    '(nonexistent.mjs:12)', '((https://x:443))',
    'Lines 62–77 now resolve the newest main push Build image run.', 'path:62–77']) {
    assert.ok(check([{ ...finding, resolution_reason: citation }]).reasons.includes('prior_findings_incomplete'), citation);
  }
  const twoPrior = classify(parseSession(fixture({ result: { ...report, findings: [finding] } })),
    { priorFindingIds: ['F1', 'F2'] });
  assert.ok(twoPrior.reasons.includes('prior_findings_incomplete'));
  assert.equal(classify(parseSession(fixture()), { priorFindingIds: [] }).pass, true);
});

test('simplicity requires a replacement and introduction flag; open existing code is P3 only', () => {
  const finding = { id: null, severity: 'blocking', category: 'simplicity', file: 'src/example.mjs', line: 1,
    title: 'Custom fence', scenario: 'New lease duplicates the existing transaction', status: 'new',
    resolution_reason: '', stock_replacement: 'one DB transaction', introduced_by_pr: true };
  const check = (value) => classify(parseSession(fixture({ result: { ...report, findings: [value] } })));
  assert.equal(check(finding).pass, true);
  assert.equal(check({ ...finding, severity: 'P3', introduced_by_pr: false }).pass, true);
  for (const patch of [{ category: undefined }, { category: 'other' }, { stock_replacement: '' },
    { stock_replacement: '   ' }, { introduced_by_pr: undefined }, { introduced_by_pr: false },
    { introduced_by_pr: false, severity: 'P2' }]) {
    assert.ok(check({ ...finding, ...patch }).reasons.includes('json_invalid'));
  }
});

test('a cited prior simplicity finding resolved as baseline code remains a valid report', () => {
  const finding = { id: 'F1', severity: 'blocking', category: 'simplicity', file: 'src/example.mjs', line: 12,
    title: 'Unused wrapper', scenario: 'The wrapper is unchanged baseline code outside the reviewed diff.',
    status: 'resolved', resolution_reason: 'src/example.mjs:12 is unchanged baseline code, not introduced by this PR.',
    stock_replacement: 'Use the existing owned store query directly.', introduced_by_pr: false };
  const session = parseSession(fixture({ result: { ...report, findings: [finding] } }));
  const result = classify(session, { priorFindingIds: ['F1'] });
  assert.equal(result.pass, true, JSON.stringify(result.reasons));
  assert.deepEqual(session.json.findings, [finding]);
});

test('tool selectors do not truncate literal colon-containing Git paths', () => {
  const session = parseSession(fixture());
  const source = 'src/renderer:raw-data.mjs';
  for (const prefix of ['', 'review/head/', 'review/base/']) {
    for (const suffix of ['', ':1', ':1-40', ':L1-L40', ':1..40', ':L1+L4', ':-4',
      ':1,4-9', ':raw', ':img', ':conflicts', ':1-4:raw', ':raw:1-4']) {
      session.toolReads = [{ toolName: 'read', path: 'review/diff.patch:1-40' },
        { toolName: 'read', path: `${prefix}${source}${suffix}` }];
      assert.equal(classify(session, inspectionFixture([source])).pass, true, `${prefix}${suffix}`);
    }
  }
  for (const [path, changedPath] of [['src/renderer', source], [source, 'src/renderer'],
    ['src/renderer:raw-data', 'src/renderer'], ['src/renderer:1+0', 'src/renderer'],
    ['src/renderer:4-1', 'src/renderer']]) {
    session.toolReads = [{ toolName: 'read', path: 'review/diff.patch' }, { toolName: 'read', path }];
    assert.ok(classify(session, inspectionFixture([changedPath])).reasons.includes('no_source_inspection'));
  }
  session.toolReads[1].path = 'review/head/src/renderer:raw:1-4';
  assert.equal(classify(session, inspectionFixture(['src/renderer:raw'])).pass, true);
});

test('a successful diff cannot compensate for a failed source read, or vice versa', () => {
  for (const toolCallId of ['read-0', 'read-1']) {
    const session = parseSession(rewriteFixture((entries) => {
      entries.find((entry) => entry.message?.role === 'toolResult'
        && entry.message.toolCallId === toolCallId).message.isError = true;
    }));
    assert.equal(session.toolReads.length, 1);
    assert.ok(classify(session).reasons.includes('no_source_inspection'));
  }
});

test('unchanged literal selector-looking files cannot prove changed-source inspection', () => {
  const session = parseSession(fixture());
  const inspection = inspectionFixture(['src/example.mjs']);
  for (const literal of ['src/example.mjs:raw', 'review/head/src/example.mjs:1-40']) {
    session.toolReads = [{ toolName: 'read', path: 'review/diff.patch' }, { toolName: 'read', path: literal }];
    assert.equal(classify(session, inspection).pass, true);
    assert.ok(classify(session, { ...inspection, exportedEntries: [...inspection.exportedEntries, literal] })
      .reasons.includes('no_source_inspection'));
  }
  assert.ok(classify(parseSession(fixture()), { inspectionTargets: {}, exportedEntries: [] })
    .reasons.includes('no_source_inspection'));
});
