import { validJob } from './runner.mjs';

const PRIMARY_MODEL = 'openai-codex/gpt-6.1-sol';
const FALLBACK_MODEL = 'anthropic/claude-opus-5-5';
const authorizedFallback = (change) => change.model === FALLBACK_MODEL
  && change.role === 'fallback' && change.resolvedModelIsFallback === true;
export function matchesReviewRoute(review, model, thinking) {
  return typeof model === 'string' && typeof thinking === 'string'
    && review?.review_route?.model === model && review.review_route.thinking === thinking
    && review.result?.evidence?.servedModel === model && review.result.evidence.thinkingLevel === thinking;
}
export function parseSession(jsonlText) {
  const session = { id: null, modelChanges: [], thinkingLevel: null, servedModel: null,
    stopReason: null, exitKind: null, credentialPin: null, toolReads: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    finalText: '', json: null, jsonState: 'missing', malformed: false, errorMessages: [],
    assistantTurns: [], reportReceipt: null };
  const pendingTools = new Map();
  let fallbackAuthorized = false;
  for (const line of jsonlText.split('\n').filter((value) => value.trim())) {
    let entry;
    try { entry = JSON.parse(line); } catch { session.malformed = true; continue; }
    if (entry.type === 'session') session.id = entry.id;
    if (entry.type === 'model_change') {
      const change = { model: entry.model, role: entry.role ?? null,
        resolvedModelIsFallback: entry.resolvedModelIsFallback ?? false };
      session.modelChanges.push(change);
      fallbackAuthorized = authorizedFallback(change);
    }
    if (entry.type === 'thinking_level_change') session.thinkingLevel = entry.thinkingLevel;
    if (entry.type === 'credential_pin') session.credentialPin = {
      provider: entry.provider, hashPrefix: entry.hash.slice(0, 12) };
    if (entry.type === 'custom' && entry.customType === 'session_exit') session.exitKind = entry.data.kind;
    if (entry.type === 'custom' && entry.customType === 'tool_execution_start') {
      const { toolCallId, toolName, args } = entry.data;
      if (typeof toolCallId === 'string' && ['read', 'grep', 'glob'].includes(toolName)) {
        pendingTools.set(toolCallId, { toolName, path: args?.path ?? args?.pattern ?? null });
      }
    }
    if (entry.type === 'message' && entry.message?.role === 'toolResult') {
      const message = entry.message;
      const started = pendingTools.get(message.toolCallId);
      pendingTools.delete(message.toolCallId);
      if (started && message.toolName === started.toolName && message.isError === false) {
        session.toolReads.push({ ...started, toolCallId: message.toolCallId });
      }
    }
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const message = entry.message;
    if (message.stopReason === 'error' && typeof message.errorMessage === 'string') {
      session.errorMessages.push(message.errorMessage);
    }
    session.stopReason = message.stopReason;
    session.finalText = (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    const receipt = { provider: message.provider ?? null, model: message.model ?? null,
      servedModel: message.provider && message.model ? `${message.provider}/${message.model}` : null,
      usage: message.usage ?? null, stopReason: message.stopReason, fallbackAuthorized };
    session.assistantTurns.push(receipt);
    session.reportReceipt = receipt;
    session.servedModel = message.stopReason !== 'error' && message.usage?.totalTokens > 0
      ? receipt.servedModel : null;
    for (const key of Object.keys(session.usage)) session.usage[key] += message.usage?.[key] ?? 0;
  }
  const blocks = [...session.finalText.matchAll(/(?:^|\n)```json\s*\n([\s\S]*?)\n```/gu)];
  if (blocks.length) {
    session.jsonState = 'invalid';
    if (blocks.length === 1 && session.finalText.slice(blocks[0].index + blocks[0][0].length).trim() === '') {
      try { session.json = JSON.parse(blocks[0][1]); session.jsonState = 'parsed'; } catch { /* invalid JSON */ }
    }
  }
  return session;
}

function validReport(report) {
  return report && /^[0-9a-f]{40}$/u.test(report.reviewed_sha)
    && typeof report.inputs_sufficient === 'boolean' && typeof report.prior_findings_checked === 'boolean'
    && Array.isArray(report.findings) && report.findings.every((finding) =>
      (finding.id === null || /^F[1-9][0-9]*$/u.test(finding.id))
      && ['blocking', 'P2', 'P3'].includes(finding.severity)
      && ['correctness', 'security', 'data_integrity', 'contract', 'test', 'simplicity'].includes(finding.category)
      && (finding.category !== 'simplicity' || (typeof finding.stock_replacement === 'string'
        && finding.stock_replacement.trim().length > 0 && typeof finding.introduced_by_pr === 'boolean'
        && (finding.introduced_by_pr || finding.severity === 'P3' || finding.status === 'resolved')))
      && ['new', 'still_open', 'resolved'].includes(finding.status)
      && typeof finding.file === 'string' && Number.isInteger(finding.line) && finding.line >= 1
      && ['title', 'scenario', 'resolution_reason'].every((key) => typeof finding[key] === 'string'))
    && Array.isArray(report.suggestions) && report.suggestions.every((suggestion) =>
      typeof suggestion.file === 'string' && Number.isInteger(suggestion.line) && suggestion.line >= 0
      && typeof suggestion.text === 'string');
}

// omp://tools/read.md: recognize complete suffixes only. The full exported-entry
// inventory enforces literal file/directory precedence; Git names are not inferred.
function isReadSelector(suffix) {
  if (!suffix.startsWith(':')) return false;
  const parts = suffix.slice(1).split(':');
  const isRange = (value) => value.split(',').every((part) => {
    if (/^-[1-9]\d*$/u.test(part)) return true;
    const match = /^L?([1-9]\d*)(?:(-|\.\.|\+)L?([1-9]\d*)?)?$/u.exec(part);
    return Boolean(match) && (match[2] !== '+' || match[3] !== undefined)
      && (!match[3] || match[2] === '+' || Number(match[3]) >= Number(match[1]));
  });
  if (parts.length === 1) return ['raw', 'img', 'conflicts'].includes(parts[0]) || isRange(parts[0]);
  return parts.length === 2 && ((parts[0] === 'raw' && isRange(parts[1]))
    || (isRange(parts[0]) && parts[1] === 'raw'));
}

function hasFileLineReference(text, files) {
  if (typeof text !== 'string') return false;
  for (const match of text.matchAll(/(?:^|[\s`(])([^\s`(][^\s`]*):([1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*)(?=$|[\s`),.;])/gu)) {
    const path = match[1].replace(/^(?:\.\/)+/u, '').replace(/^\/work\/repo\//u, '');
    const alias = path.replace(/^review\/(?:head|base)\//u, '');
    if (!path.includes('://') && (files.has(path) || files.has(alias))
      && isReadSelector(`:${match[2]}`)) return true;
  }
  return false;
}

function completePriorFindings(report, ids, entries) {
  if (report?.prior_findings_checked !== true || !Array.isArray(report.findings)) return false;
  const directories = new Set();
  for (const entry of entries) {
    if (entry.endsWith('/')) directories.add(entry.slice(0, -1));
    for (let slash = entry.indexOf('/'); slash >= 0; slash = entry.indexOf('/', slash + 1)) {
      directories.add(entry.slice(0, slash));
    }
  }
  const files = new Set([...entries].filter((entry) => !entry.endsWith('/') && !directories.has(entry)));
  return ids.every((id) => {
    const matches = report.findings.filter((finding) => finding?.id === id);
    if (matches.length !== 1 || !['still_open', 'resolved'].includes(matches[0].status)) return false;
    return matches[0].status !== 'resolved' || hasFileLineReference(matches[0].resolution_reason, files);
  });
}

export function classifyRun({ session, stdout, stderr = '', maxTimeExpired = false, exitCode, signal,
  headSha, inspectionTargets = {}, exportedEntries = [], priorFindingIds = [],
  reviewModel = PRIMARY_MODEL, reviewThinking = 'medium' }) {
  const reasons = [];
  if (exitCode !== 0) reasons.push('exit_nonzero');
  if (signal) reasons.push('killed');
  // Measured --max-time 20 exited 0 without JSONL or a textual timeout marker;
  // require the runner's elapsed-time/no-session-exit receipt, never infer from silence.
  if (maxTimeExpired) reasons.push('max_time');
  const diagnostic = [stderr, stdout, ...(session.errorMessages ?? [])].join('\n');
  // Measured markers from prototype/out/ac3-{d,e,g}/stderr.txt (OMP 18.8.7).
  if ((exitCode !== 0 || session.stopReason === 'error')
      && /auth-gateway 401:|No API key found for openai-codex\./u.test(diagnostic)) reasons.push('auth_failed');
  if (/phase: readPipedInput/u.test(stderr)) reasons.push('stdin_wait');
  // Forced gateway egress loss produced these primary/fallback error messages;
  // recovered retries on an otherwise successful run must not fail the review.
  if ((exitCode !== 0 || session.stopReason !== 'stop')
      && /getaddrinfo ETIMEOUT (?:gateway|chatgpt\.com)|Connection error\.|socket connection was closed unexpectedly/u.test(diagnostic)) {
    reasons.push('provider_error');
  }
  // With a live session the same OMP deadline ends with a normal session_exit.
  // Measured scenarios b-final and c stderr: "Deadline exceeded".
  if (!maxTimeExpired && /(?:^|\n)Deadline exceeded(?:\n|$)/u.test(stderr)) reasons.push('max_time');
  if (!session.exitKind) reasons.push('no_session_exit');
  else if (session.exitKind !== 'normal') reasons.push('abnormal_exit');
  if (session.stopReason !== 'stop') reasons.push('stop_reason_not_stop');
  if (session.jsonState === 'missing') reasons.push('json_missing');
  else if (session.malformed || !validReport(session.json)) reasons.push('json_invalid');
  if (session.json && session.json.reviewed_sha !== headSha) reasons.push('sha_mismatch');
  if (session.json?.inputs_sufficient === false) reasons.push('inputs_insufficient');
  const entries = exportedEntries instanceof Set ? exportedEntries : new Set(exportedEntries);
  if (session.json?.prior_findings_checked === false
      || (priorFindingIds.length > 0 && !completePriorFindings(session.json, priorFindingIds, entries))) {
    reasons.push('prior_findings_incomplete');
  }
  const changedTargets = Object.values(inspectionTargets).flat().filter((target) => entries.has(target));
  const reads = session.toolReads.filter((read) => read.toolName === 'read' && typeof read.path === 'string')
    .map((read) => read.path.replace(/^\/work\/repo\//u, '').replace(/^(?:\.\/)+/u, ''));
  const inspected = (target) => entries.has(target) && reads.some((path) => path === target
    || (!entries.has(path) && path.startsWith(`${target}:`) && isReadSelector(path.slice(target.length))));
  if (!inspected('review/diff.patch') || !changedTargets.some(inspected)) reasons.push('no_source_inspection');
  const allowedFallback = (change) => reviewModel === PRIMARY_MODEL && authorizedFallback(change);
  const allowedTurn = (turn) => turn.servedModel === reviewModel
    || (reviewModel === PRIMARY_MODEL && turn.servedModel === FALLBACK_MODEL && turn.fallbackAuthorized);
  if (!validJob({ model: reviewModel, thinking: reviewThinking, maxTime: 600 })
      || ![PRIMARY_MODEL, FALLBACK_MODEL].includes(session.servedModel)
      || !session.reportReceipt || !(session.reportReceipt.usage?.totalTokens > 0)
      || !allowedTurn(session.reportReceipt)
      || session.assistantTurns.some((turn) => turn.stopReason !== 'error' && !allowedTurn(turn))
      || session.modelChanges.some((change) => change.model !== reviewModel && !allowedFallback(change))) {
    reasons.push('model_not_allowed');
  }
  if (session.thinkingLevel !== reviewThinking) reasons.push('effort_mismatch');
  return { pass: reasons.length === 0, reasons, evidence: { ...session, stdout, stderr, maxTimeExpired } };
}
