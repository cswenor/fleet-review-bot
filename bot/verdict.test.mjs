import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyDeferrals, buildVerdictRequest, callJev, decide, JEV_QUESTIONS } from './verdict.mjs';

const thresholds = { block: 0.5, approveBlockingMax: 0.05, approveSevereMax: 0.05, priorResolvedMin: 0.95 };
const answers = (blocking = 0.05, severe = 0.05, prior = 0.95) => ({
  blocking_defect: { type: 'noul', noul: blocking },
  most_severe: { type: 'choice', choice: 'none', probabilities: { blocking: severe, non_blocking: 0, none: 1 - severe }, confidence: 0.9 },
  prior_resolved: { type: 'noul', noul: prior },
});
const decision = (result, extra = {}) => decide({ answers: result, thresholds, structuredFindings: [], hasPrior: false, ...extra });
test('clean validated findings approve despite blocking or ambiguous judge scores', () => {
  for (const blocking of [0.050001, 0.4, 0.5, 0.54, 0.69, 1]) {
    for (const structuredFindings of [[], [{ severity: 'blocking', status: 'resolved' }]]) {
      assert.equal(decision(answers(blocking, 0.9, 1), {
        structuredFindings, hasPrior: structuredFindings.length > 0,
      }), 'approve');
    }
  }
});
test('missing or invalid judge probabilities cannot approve', () => {
  assert.equal(decision({}, { hasPrior: true }), 'ambiguous');
  assert.equal(decision(answers(NaN)), 'ambiguous');
  assert.equal(decision({ ...answers(0, 0), prior_resolved: {} }, { hasPrior: true }), 'ambiguous');
});
const responseBody = { model: 'jev-1.13.0', answers: answers(), usage: { input_tokens: 20, output_tokens: 2 } };
const invoke = (fetchImpl) => callJev({ gatewayUrl: 'http://fake.invalid/', token: 'fixture-token',
  body: buildVerdictRequest({ prTitle: '', reportText: '', priorFindings: [], structuredFindings: [], model: 'jev-latest' }), fetchImpl });
test('429 honors retry-after and sends authentication and exact route', async () => {
  let calls = 0; const started = Date.now();
  const result = await invoke(async (url, options) => {
    assert.equal(url, 'http://fake.invalid/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    assert.equal(JSON.parse(options.body).model, 'jev-latest');
    calls++;
    return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0.01' } })
      : Response.json(responseBody, { headers: { 'x-typesafe-request-id': 'receipt' } });
  });
  assert.equal(calls, 2); assert.ok(Date.now() - started >= 10); assert.equal(result.requestId, 'receipt');
});
test('requestId header precedence and client UUID fallback', async () => {
  for (const header of ['x-request-id', 'request-id', 'x-typesafe-request-id', null]) {
    let sent;
    const result = await invoke(async (_url, options) => {
      sent = options.headers['X-Request-Id'];
      return Response.json(responseBody, { headers: header ? { [header]: 'server-id' } : {} });
    });
    assert.equal(result.requestId, header ? 'server-id' : sent);
    assert.match(sent, /^[0-9a-f-]{36}$/u);
  }
});
test('timeout aborts each attempt and exhausts three attempts', async () => {
  let calls = 0;
  await assert.rejects(invoke((_url, { signal }) => {
    calls++;
    return new Promise((_accept, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }), /timed out after 10 s/u);
  assert.equal(calls, 3);
});
test('pinned responses require matching identity and conservative approval evidence', () => {
  const pinned = JSON.parse(readFileSync(new URL('./verdict-thresholds.json', import.meta.url), 'utf8'));
  assert.equal(decision(answers(), { thresholds: pinned, model: 'jev-1.14.0' }), 'approve');
  assert.equal(decision(answers(), { thresholds: pinned, model: 'jev-1.13.0' }), 'ambiguous');
  assert.equal(decision(answers(0.9), { thresholds: pinned, model: 'jev-1.13.0' }), 'ambiguous');
  assert.equal(decision(answers(), { thresholds: pinned }), 'ambiguous');
});
test('unsupported versioned model exposes status without retrying', async () => {
  let calls = 0;
  await assert.rejects(invoke(async () => {
    calls++;
    return Response.json({ error: { message: 'Unknown model' } }, { status: 404 });
  }), (error) => error.status === 404 && error.terminal);
  assert.equal(calls, 1);
});
test('unresolved blocking simplicity cannot approve regardless of clean judge probabilities', () => {
  const structuredFindings = [{ category: 'simplicity', severity: 'blocking', status: 'new',
    introduced_by_pr: true, stock_replacement: 'one DB transaction' }];
  assert.equal(decision(answers(0, 0), { structuredFindings }), 'ambiguous');
  assert.equal(decision(answers(0.5, 0), { structuredFindings }), 'block');
  assert.equal(decision(answers(0, 0), { structuredFindings: [{ ...structuredFindings[0], status: 'resolved' }] }), 'approve');
});

test('only attributed low-severity tracking evidence defers open prior findings', () => {
  for (const severity of ['P2', 'P3']) {
    const finding = { id: 'F4', severity, status: 'still_open', file: 'a.mjs', line: 4,
      category: 'correctness', scenario: 'edge' };
    const reply = { finding_id: 'F4', body: 'Deferred to TASK-1953 because this edge needs separate work' };
    const [deferred] = applyDeferrals([finding], [finding], [reply]);
    assert.equal(deferred.status, 'deferred');
    assert.equal(deferred.deferred_to, 'TASK-1953');
    assert.match(deferred.resolution_reason, /TASK-1953.*because/u);
    assert.equal(deferred.file, finding.file);
    assert.equal(deferred.scenario, finding.scenario);
    assert.equal(finding.status, 'still_open');
    for (const replies of [undefined, [], [{ ...reply, body: 'Will handle later' }],
      [{ ...reply, finding_id: 'F5' }],
      [{ finding_id: null, body: 'F40 TASK-1953\nF4 still needs attention' }],
      [{ finding_id: null, body: 'F5 TASK-1953\nF4 still needs attention' }]]) {
      assert.equal(applyDeferrals([finding], [finding], replies)[0].status, 'still_open');
    }
    assert.equal(applyDeferrals([{ ...finding, status: 'new' }], [], [reply])[0].status, 'new');
    assert.equal(applyDeferrals([{ ...finding, status: 'resolved' }], [finding], [reply])[0].status, 'resolved');
    assert.equal(applyDeferrals([{ ...finding, severity: 'blocking' }], [finding], [reply])[0].status, 'still_open');
    assert.equal(applyDeferrals([finding], [{ ...finding, severity: 'blocking' }], [reply])[0].status, 'still_open');
    const [last] = applyDeferrals([finding], [finding], [reply,
      { finding_id: null, body: 'F4: TASK-2000 then TASK-2001 because separate scope' }]);
    assert.equal(last.deferred_to, 'TASK-2000');
  }
});

test('unanswered first-review or prior P2/P3 hold approval even with clean judge scores', () => {
  for (const severity of ['P2', 'P3']) for (const status of ['new', 'still_open']) {
    assert.equal(decision(answers(0, 0), { structuredFindings: [{ severity, status }] }), 'block');
  }
  for (const severity of ['P2', 'P3']) {
    assert.equal(decision(answers(0, 0), { structuredFindings: [{ severity, status: 'deferred', deferred_to: 'TASK-1953' }] }), 'approve');
  }
  assert.notEqual(decision(answers(0, 0), { structuredFindings: [{ severity: 'blocking', status: 'deferred', deferred_to: 'TASK-1953' }] }), 'approve');
});

test('mixed blocking and unanswered P2/P3 findings stay actionable rather than needs-human', () => {
  for (const severity of ['P2', 'P3']) for (const status of ['new', 'still_open']) {
    const structuredFindings = [{ severity: 'blocking', status: 'still_open' }, { severity, status }];
    assert.equal(decision(answers(0, 0), { structuredFindings }), 'block');
  }
});
