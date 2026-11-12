import { APPROVER_NAMES } from './identity.mjs';

export function sanitize(text, { secrets = [], limit = 65000 } = {}) {
  let result = String(text ?? '');
  for (const secret of secrets.filter((value) => typeof value === 'string' && value.length)) result = result.split(secret).join('[redacted]');
  result = result.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[redacted]')
    .replace(/sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]*/gu, '[redacted]')
    .replace(/@(?=[A-Za-z0-9_-])/gu, '@\u200B');
  const suffix = '\n…[truncated]';
  return result.length > limit ? result.slice(0, Math.max(0, limit - suffix.length)) + suffix : result;
}
export function buildCheckOutput(review, { secrets = [] } = {}) {
  const evidence = review.result?.evidence ?? {};
  const clean = (value) => sanitize(typeof value === 'string' ? value : JSON.stringify(value ?? 'none'), { secrets });
  const policy = review.policy ?? {};
  const findings = review.findings ?? [];
  const reads = evidence.toolReads ?? [];
  const fallback = (evidence.modelChanges ?? []).filter((change) => change.role === 'fallback');
  const fields = [
    ['repo', review.repo], ['pr', review.pr], ['base_sha', review.base_sha], ['head_sha', review.head_sha],
    ['commit_set', review.commits ?? []], ['ci_run', review.ci ?? 'none'], ['policy.revision', policy.revision],
    ['policy.review_policy_path', policy.review_policy_path], ['policy.review_policy_sha256', policy.review_policy_sha256],
    ['policy.review_policy_source', policy.review_policy_source],
    ['policy.review_role', policy.review_role],
    ['policy.source', policy.source],
    ['reviewer.provider/model/effort', `${evidence.servedModel ?? 'unavailable'} ${evidence.thinkingLevel ?? 'unavailable'}`],
    ['reviewer.session_id', evidence.id], ['reviewer.fallback', fallback.length ? fallback : 'none'],
    ['reviewer.account_pin', evidence.credentialPin ?? 'gateway-resolved'],
    ['overlay', 'unadvised-review.yml + reviewer-overlay.yml'], ['advisor', 'disabled'], ['tools', 'read,grep,glob'],
    ['max_time', 600], ['source_inspection', { head_sha: review.source_review_head ?? review.head_sha,
      count: reads.length, paths: reads.slice(0, 50).map((read) => read.path) }],
    ['transcript_ref', review.transcript ?? 'none'], ['prior_review', review.prior_review ?? 'none'],
    ['exit_state', review.exit ?? 'none'], ['non-pass reasons', review.result?.reasons ?? []],
    ['verdict.decision', review.verdict?.decision ?? 'none'], ['verdict.reason', review.verdict?.reason ?? 'none'],
    ['verdict.model', review.verdict?.model ?? 'none'], ['verdict.request_ids', review.verdict?.request_ids ?? []],
    ['verdict.probabilities', review.verdict?.answers ?? {}], ['verdict.thresholds', review.verdict?.thresholds ?? 'none'],
    ['thresholds.source', review.verdict?.thresholds?.source ?? 'none'],
    ['verdict.thresholds_sha256', review.verdict?.thresholds?.sha256 ?? 'none'],
    ['verdict.usage', review.verdict?.usage ?? 'none'], ['verdict.latency_ms', review.verdict?.latencyMs ?? 'none'],
    ['approval', review.approval ?? 'none'], ['carry', review.carry ?? 'none'],
    ['findings.source_head', review.source_review_head ?? review.head_sha],
  ];
  const table = ['| id | severity | status | file:line | title |', '|---|---|---|---|---|',
    ...findings.map((finding) => `| ${finding.id} | ${finding.severity} | ${finding.status} | ${finding.file}:${finding.line} | ${finding.title} |`)];
  const manifest = findings.map(({ id, severity, status, file, line }) => ({
    id, severity, status, path: clean(file), line,
  }));
  const envelope = `<!-- dlq-findings v1 ${Buffer.from(JSON.stringify(manifest)).toString('base64')} -->`;
  // Reserve the final line before truncating prose. Never publish a partial manifest.
  const suffix = `\n${envelope.length <= 64_980 ? envelope : '<!-- dlq-findings unavailable -->'}`;
  return {
    title: sanitize(`codex-review ${review.outcome} · ${(evidence.servedModel ?? 'unavailable').split('/').at(-1)} ${evidence.thinkingLevel ?? 'unknown'} · ${review.head_sha.slice(0, 12)}`, { secrets, limit: 256 }),
    summary: sanitize(fields.map(([key, value]) => `${key}: ${clean(value)}`).join('\n')
      + (review.carried_forward_from ? `\ncarried_forward_from ${review.carried_forward_from}` : '')
      + (review.waitingForHuman ? `\nverdict: ambiguous after re-review; waiting for a human (override: ${APPROVER_NAMES})` : '')
      + '\n\n' + table.join('\n'), { secrets }),
    text: sanitize(findings.map((finding) => `${finding.id} ${finding.severity} ${finding.status}: ${finding.file}:${finding.line}\n${finding.title}\nCategory: ${finding.category ?? 'unavailable'}\nScenario: ${finding.scenario}\nResolution: ${finding.resolution_reason ?? ''}`
      + (finding.category === 'simplicity' ? `\nStock replacement: ${finding.stock_replacement}\nIntroduced by PR: ${finding.introduced_by_pr}` : '')).join('\n\n')
      + '\n\nSuggestions:\n' + (review.suggestions ?? []).map((suggestion) => `${suggestion.file}:${suggestion.line} ${suggestion.text}`).join('\n'),
      { secrets, limit: 65_000 - suffix.length }) + suffix,
  };
}
