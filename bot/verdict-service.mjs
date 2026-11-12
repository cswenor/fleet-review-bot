import { buildVerdictRequest, callJev, decide } from './verdict.mjs';
import { sanitize } from './evidence.mjs';

function unsettledPriors(review) {
  const currentById = new Map(review.findings.map((finding) => [finding.id, finding]));
  return review.priorFindings.filter((prior) => {
    const current = currentById.get(prior.id);
    return !(current?.status === 'deferred' && ['P2', 'P3'].includes(current.severity)
      && ['P2', 'P3'].includes(prior.severity) && /^TASK-\d+$/u.test(current.deferred_to ?? ''));
  });
}

export class VerdictService {
  constructor({ mirror, token, judgeToken, fetchImpl = fetch, judgeImpl = callJev }) {
    Object.assign(this, { mirror, token, judgeToken, fetchImpl, judgeImpl });
  }
  async evaluate(review) {
    if (!review.result.pass) return null;
    try {
      if (typeof review.reportText !== 'string' || !review.reportText.trim() || typeof review.prTitle !== 'string'
        || !Array.isArray(review.priorFindings) || !Array.isArray(review.replies)) throw new Error('Missing verdict inputs');
      if (typeof this.judgeToken !== 'string' || !this.judgeToken || /\s/u.test(this.judgeToken)) throw new Error('Missing hosted judge credential');
      const thresholds = await this.mirror.thresholds(review.policy.revision);
      const priorFindings = unsettledPriors(review);
      const body = buildVerdictRequest({ prTitle: review.prTitle, reportText: review.reportText,
        priorFindings, replies: review.replies, structuredFindings: review.findings, model: thresholds.model });
      // Reviewer output is untrusted, including any bearer it might have read. Redact
      // the complete JSON state before forwarding it upstream; never truncate verdict inputs.
      body.state = JSON.parse(sanitize(JSON.stringify(body.state),
        { secrets: [this.token, this.judgeToken].filter(Boolean).map((secret) => JSON.stringify(secret).slice(1, -1)), limit: Infinity }));
      // OMP 18.8.7 rejects pinned judge IDs. Use hosted TypeSafe without an alias
      // fallback; its credential remains in this trusted web process only.
      const response = await this.judgeImpl({ gatewayUrl: 'https://api.typesafe.ai', token: this.judgeToken, body, fetchImpl: this.fetchImpl });
      return { ...response, request_ids: [response.requestId], thresholds,
        decision: decide({ answers: response.answers, thresholds, model: response.model,
          structuredFindings: review.findings, hasPrior: priorFindings.length > 0 }) };
    } catch {
      // Provider/configuration errors are evidence of no verdict, not permission to approve.
      return { decision: 'ambiguous', reason: 'verdict_unavailable', request_ids: [] };
    }
  }
  async carry(review) {
    try {
      const thresholds = await this.mirror.thresholds(review.carry.main_sha);
      return { ...review.verdict, thresholds,
        decision: decide({ answers: review.verdict.answers, thresholds, model: review.verdict.model,
          structuredFindings: review.findings, hasPrior: unsettledPriors(review).length > 0 }) };
    } catch {
      return { decision: 'ambiguous', reason: 'verdict_unavailable', request_ids: [] };
    }
  }
}