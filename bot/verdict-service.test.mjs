import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCheckOutput } from './evidence.mjs';
import { VerdictService } from './verdict-service.mjs';
import { loadThresholds } from './mirror.mjs';
const sha = 'a'.repeat(40), revision = 'b'.repeat(40);
const thresholds = { model: 'jev-1.13.0', calibratedModel: 'jev-1.13.0', block: 0.5,
  approveBlockingMax: 0.3, approveSevereMax: 0.05, priorResolvedMin: 0.8 };
const answers = { blocking_defect: { noul: 0.01 }, most_severe: { probabilities: { blocking: 0.01, non_blocking: 0.01, none: 0.98 } } };
function fixture({ model = 'jev-1.13.0', failure = false } = {}) {
  const calls = [];
  const service = new VerdictService({ token: 'fixture-token', judgeToken: 'fixture-judge-token',
    mirror: { thresholds: async () => ({ ...thresholds, source: 'main@' + sha }) },
    judgeImpl: async (request) => { calls.push(request); if (failure) throw new Error('unavailable');
      return { model, answers, requestId: 'receipt', latencyMs: 12, usage: { input_tokens: 10 } }; } });
  const review = { result: { pass: true }, policy: { revision: sha }, reportText: 'No findings.',
    prTitle: 'Change', findings: [], priorFindings: [], replies: [] };
  return { service, calls, review };
}
test('pass review uses trusted model and records all verdict evidence', async () => {
  const f = fixture(); const receipt = await f.service.evaluate(f.review);
  assert.equal(receipt.decision, 'approve'); assert.deepEqual(receipt.request_ids, ['receipt']);
  assert.equal(receipt.thresholds.source, 'main@' + sha); assert.equal(receipt.model, 'jev-1.13.0');
});
test('model drift is ambiguous and non-pass never calls jev', async () => {
  const f = fixture({ model: 'jev-2.0.0' });
  assert.equal((await f.service.evaluate(f.review)).decision, 'ambiguous');
  f.review.result.pass = false; assert.equal(await f.service.evaluate(f.review), null);
  assert.equal(f.calls.length, 1);
});
test('missing report and judge errors are explicitly unavailable', async () => {
  const f = fixture(); delete f.review.reportText;
  assert.equal((await f.service.evaluate(f.review)).reason, 'verdict_unavailable');
  assert.equal(f.calls.length, 0);
  const failed = fixture({ failure: true });
  assert.equal((await failed.service.evaluate(failed.review)).reason, 'verdict_unavailable');
});
test('missing hosted credentials never call the judge or approve', async () => {
  const f = fixture(); f.service.judgeToken = undefined;
  const result = await f.service.evaluate(f.review);
  assert.equal(result.reason, 'verdict_unavailable');
  assert.equal(result.decision, 'ambiguous');
  assert.equal(f.calls.length, 0);
});
test('carried verdict is re-scored against current trusted thresholds without a judge call', async () => {
  const f = fixture(); f.review.verdict = await f.service.evaluate(f.review);
  f.review.carry = { main_sha: sha };
  f.service.mirror.thresholds = async () => ({ ...thresholds, model: 'jev-1.14.0',
    calibratedModel: 'jev-1.14.0', source: 'main@' + revision });
  const receipt = await f.service.carry(f.review);
  assert.equal(receipt.decision, 'ambiguous'); assert.equal(receipt.thresholds.source, 'main@' + revision);
  assert.equal(f.calls.length, 1);
});
test('thresholds load only the exact main revision', async () => {
  const calls = [];
  const result = await loadThresholds({ git: async (...args) => {
    calls.push(args); return JSON.stringify(thresholds);
  }, mainSha: sha });
  assert.equal(result.source, 'main@' + sha);
  assert.deepEqual(calls, [['show', sha + ':bot/verdict-thresholds.json']]);
});

test('verdict and check evidence retain the raw main thresholds digest', async () => {
  const bytes = Buffer.from(JSON.stringify(thresholds, null, 2) + '\r\n');
  const expected = createHash('sha256').update(bytes).digest('hex');
  const f = fixture();
  f.service.mirror.thresholds = (mainSha) => loadThresholds({ git: async () => bytes, mainSha });
  const verdict = await f.service.evaluate(f.review);
  assert.equal(verdict.thresholds.sha256, expected);
  assert.notEqual(expected, createHash('sha256').update(JSON.stringify(thresholds)).digest('hex'));
  const output = buildCheckOutput({ ...f.review, head_sha: sha, verdict });
  assert.ok(output.summary.includes(`verdict.thresholds_sha256: ${expected}`));
});
test('absent, empty, unreadable and invalid main thresholds fail closed before calling the judge', async () => {
  for (const text of ['', ' \n', '{', JSON.stringify({ ...thresholds, block: 2 })]) {
    await assert.rejects(loadThresholds({ git: async () => text, mainSha: sha }), /verdict_unavailable/u);
  }
  for (const message of ['path absent', 'unreadable', 'mirror_timeout']) {
    await assert.rejects(loadThresholds({ git: async () => { throw new Error(message); }, mainSha: sha }), /verdict_unavailable/u);
  }
  const f = fixture();
  f.service.mirror.thresholds = (mainSha) => loadThresholds({
    git: async () => { throw new Error('path absent'); }, mainSha,
  });
  assert.equal((await f.service.evaluate(f.review)).reason, 'verdict_unavailable');
  assert.equal(f.calls.length, 0);
});
test('untrusted report, title and prior data never forward either bearer upstream', async () => {
  const f = fixture();
  f.review.reportText = 'fixture-token fixture-judge-token'; f.review.prTitle = 'fixture-token fixture-judge-token';
  f.review.priorFindings = [{ title: 'fixture-token fixture-judge-token' }];
  await f.service.evaluate(f.review);
  const state = JSON.stringify(f.calls[0].body.state);
  assert.equal(state.includes('fixture-token'), false);
  assert.equal(state.includes('fixture-judge-token'), false);
});

test('settled deferred priors approve without a prior score in evaluation and carry', async () => {
  const f = fixture();
  f.review.priorFindings = [{ id: 'F4', severity: 'P2', status: 'still_open' }];
  f.review.findings = [{ id: 'F4', severity: 'P2', status: 'deferred', deferred_to: 'TASK-1953' }];
  f.review.reportText = 'F4 remains open in code.';
  f.review.verdict = await f.service.evaluate(f.review);
  assert.equal(f.review.verdict.decision, 'approve');
  f.review.carry = { main_sha: revision };
  assert.equal((await f.service.carry(f.review)).decision, 'approve');
});

test('mixed deferrals and code fixes still require the fixing-code prior score', async () => {
  const f = fixture();
  f.review.priorFindings = [{ id: 'F4', severity: 'P2' }, { id: 'F5', severity: 'P2' }];
  f.review.findings = [{ id: 'F4', severity: 'P2', status: 'deferred', deferred_to: 'TASK-1953' },
    { id: 'F5', severity: 'P2', status: 'resolved', resolution_reason: 'Fixed in a.mjs:4' }];
  f.service.judgeImpl = async ({ body }) => {
    assert.deepEqual(body.state.prior_findings.map((finding) => finding.id), ['F5']);
    assert.ok(body.questions.prior_resolved);
    return { model: 'jev-1.13.0', answers: { ...answers, prior_resolved: { noul: 0.03 } } };
  };
  f.review.verdict = await f.service.evaluate(f.review);
  assert.equal(f.review.verdict.decision, 'ambiguous');
  f.review.carry = { main_sha: revision };
  assert.equal((await f.service.carry(f.review)).decision, 'ambiguous');
  f.review.verdict.answers.prior_resolved.noul = 0.99;
  assert.equal((await f.service.carry(f.review)).decision, 'approve');
});
