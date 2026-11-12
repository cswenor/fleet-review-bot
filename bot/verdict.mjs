import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

// Resolve tracking evidence only after the reviewer report passes code-fix validation.
export function applyDeferrals(findings, priorFindings, replies) {
  const priorById = new Map(priorFindings.map((finding) => [finding.id, finding]));
  return findings.map((finding) => {
    const prior = priorById.get(finding.id);
    if (finding.status !== 'still_open' || !['P2', 'P3'].includes(finding.severity)
      || !prior || !['P2', 'P3'].includes(prior.severity)) return { ...finding };
    let evidence = null;
    for (const reply of replies ?? []) {
      if (reply.finding_id != null && reply.finding_id !== finding.id) continue;
      for (const line of (reply.body ?? '').split(/\r?\n/u)) {
        if (reply.finding_id == null && !line.match(/\bF\d+\b/gu)?.includes(finding.id)) continue;
        const task = /\bTASK-\d+\b/u.exec(line)?.[0];
        if (task) { evidence = { task, text: reply.body }; break; }
      }
    }
    const task = evidence?.task ?? (/^TASK-\d+$/u.test(prior.deferred_to ?? '') ? prior.deferred_to : null);
    if (!task) return { ...finding };
    return { ...finding, status: 'deferred', deferred_to: task,
      resolution_reason: `Deferred to ${task}: ${evidence?.text ?? 'saved tracking reference from prior review'}` };
  });
}

// Wire contract: https://docs.typesafe.ai/api.md; gateway route: omp://auth-broker-gateway.md.
// Choice options are criteria keys; Noul answers use `noul`, not a probabilities map.
export const JEV_QUESTIONS = Object.freeze({
  blocking_defect: {
    type: 'noul',
    instructions: 'The state is an automated code-review report for a pull request, with any prior findings and developer replies. Does the review identify at least one unresolved defect that must be fixed before merge: a correctness bug, security issue, data-integrity risk, broken contract, or missing test for changed behavior? Style, naming, documentation wording and optional suggestions do not count. Findings the report marks resolved do not count. P2/P3 marked deferred with deferred_to in the bot-provided finding_resolutions are settled, not unresolved defects, even if the original review_report describes their code as open.',
    criteria: { true: 'At least one such unresolved defect is identified', false: 'No such unresolved defect is identified' },
  },
  most_severe: {
    type: 'choice', instructions: 'What is the most severe unresolved finding in the review report? P2/P3 marked deferred with deferred_to in the bot-provided finding_resolutions are settled and must be excluded, even if the original review_report describes their code as open.',
    criteria: { blocking: 'must be fixed before merge (the categories above)',
      non_blocking: 'a real but minor issue or suggestion', none: 'the report states no unresolved findings' },
  },
  prior_resolved: { type: 'noul', instructions: 'Does the review explicitly mark every finding ID supplied in prior_findings as resolved, with a reason? Evaluate only these IDs. Deferred IDs excluded by the bot are settled and must not lower this score because the original review_report still calls their code open.' },
});

export function buildVerdictRequest({ prTitle, reportText, priorFindings, replies, structuredFindings, model }) {
  const findings = priorFindings?.findings ?? priorFindings ?? [];
  return { model, state: { pr_title: prTitle, review_report: reportText,
    prior_findings: findings, developer_replies: replies ?? [], finding_resolutions: structuredFindings },
  questions: { blocking_defect: JEV_QUESTIONS.blocking_defect, most_severe: JEV_QUESTIONS.most_severe,
    ...(findings.length ? { prior_resolved: JEV_QUESTIONS.prior_resolved } : {}) } };
}

export async function callJev({ gatewayUrl, token, body, fetchImpl = fetch }) {
  const started = performance.now();
  const requestId = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Jev request timed out after 10 s')), 10_000);
    let delay = [1000, 3000][attempt];
    try {
      const response = await fetchImpl(`${gatewayUrl.replace(/\/$/u, '')}/v1/systemone`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'X-Request-Id': requestId }, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) {
        if (![429, 529].includes(response.status) && response.status < 500) {
          throw Object.assign(new Error(`Jev HTTP ${response.status}`), { terminal: true, status: response.status });
        }
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter !== null) {
          const seconds = Number(retryAfter);
          delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
            : Math.max(0, Date.parse(retryAfter) - Date.now());
          if (!Number.isFinite(delay)) delay = [1000, 3000][attempt];
        }
        await response.body?.cancel();
        // A long retry-after cannot hold the serialized review scheduler indefinitely.
        // Decline the retry rather than sending it before the provider's requested time.
        if (delay > 30000) throw Object.assign(new Error('Jev retry-after exceeds the verdict deadline'), { terminal: true });
        throw new Error(`Jev HTTP ${response.status}`);
      }
      const result = await response.json();
      if (typeof result.model !== 'string' || !result.answers || !result.usage) throw new Error('Invalid Jev response');
      return { model: result.model, answers: result.answers, usage: result.usage,
        latencyMs: performance.now() - started,
        requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id')
          ?? response.headers.get('x-typesafe-request-id') ?? requestId };
    } catch (error) {
      if (error.terminal || attempt === 2) throw error;
    } finally { clearTimeout(timer); }
    await sleep(delay);
  }
}

export function decide({ model, answers, thresholds, structuredFindings, hasPrior }) {
  // The requested pin must still match the provider's returned calibration ID.
  // Provider misrouting never grants approval authority.
  if (thresholds.calibratedModel && model !== thresholds.calibratedModel) return 'ambiguous';
  const blocking = answers?.blocking_defect?.noul;
  const severe = answers?.most_severe?.probabilities;
  const prior = answers?.prior_resolved?.noul;
  const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
  if (!probability(blocking) || !severe || !['blocking', 'non_blocking', 'none'].every((key) => probability(severe[key]))
    || (hasPrior && !probability(prior))) return 'ambiguous';
  if (structuredFindings.some((finding) => ['P2', 'P3'].includes(finding.severity)
    && ['new', 'still_open'].includes(finding.status))) return 'block';
  if (structuredFindings.some((finding) => finding.severity === 'blocking' && finding.status !== 'resolved')) {
    return blocking >= 0.5 ? 'block' : 'ambiguous';
  }
  // Severity probabilities cannot invent a finding the validated review did
  // not identify. Retain the separate prior-fix evidence requirement.
  if (hasPrior && prior < thresholds.priorResolvedMin) return 'ambiguous';
  return 'approve';
}
