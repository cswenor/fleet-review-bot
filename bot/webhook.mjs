import { createHmac, timingSafeEqual } from 'node:crypto';
import { REPOSITORY, REPOSITORY_OWNER, REVIEW_APP_ID } from './identity.mjs';
import { builderUser } from './approval.mjs';

export function isRereviewCommand(body) {
  return typeof body === 'string' && body.split(/\r?\n/u).some((line) => line.trim() === '/rereview');
}

// Finding IDs (F1, F2, …) cited in a comment, unique in first-seen order, at most 20.
export function findingRefs(body) {
  if (typeof body !== 'string') return [];
  return [...new Set(body.match(/\bF[1-9]\d{0,3}\b/gu) ?? [])].slice(0, 20);
}

export function minimalPayload(payload) {
  const result = { action: payload.action, number: payload.number,
    repository: { full_name: payload.repository?.full_name } };
  if (payload.pull_request) result.pull_request = { number: payload.pull_request.number, draft: payload.pull_request.draft,
    merged: payload.pull_request.merged,
    head: { sha: payload.pull_request.head?.sha, ref: payload.pull_request.head?.ref,
      repo: { full_name: payload.pull_request.head?.repo?.full_name } },
    base: { ref: payload.pull_request.base?.ref } };
  if (payload.changes?.base) result.changes = { base: true };
  if (payload.merge_group) result.merge_group = Object.fromEntries(
    ['head_sha', 'base_sha', 'base_ref', 'head_ref'].map((key) => [key, payload.merge_group[key]]));
  // Retain only invalidation identities, not check-suite/status/push bodies.
  if (payload.check_suite) result.check_suite = { head_sha: payload.check_suite.head_sha };
  if (typeof payload.sha === 'string') result.sha = payload.sha;
  if (typeof payload.ref === 'string') result.ref = payload.ref;
  if (payload.check_run) result.check_run = { id: payload.check_run.id, name: payload.check_run.name, head_sha: payload.check_run.head_sha,
    status: payload.check_run.status, conclusion: payload.check_run.conclusion,
    app: { id: payload.check_run.app?.id }, check_suite: { head_branch: payload.check_run.check_suite?.head_branch } };
  if (payload.workflow_run) result.workflow_run = Object.fromEntries(
    ['name', 'head_sha', 'head_branch', 'conclusion', 'id', 'html_url'].map((key) => [key, payload.workflow_run[key]]));
  // Comment text is never persisted: only the /rereview command or, for builder-App PR comments, the cited finding IDs.
  if (payload.comment) result.comment = { id: payload.comment.id, in_reply_to_id: payload.comment.in_reply_to_id ?? null,
    created_at: payload.comment.created_at,
    user: { id: payload.comment.user?.id, login: payload.comment.user?.login, type: payload.comment.user?.type },
    body: isRereviewCommand(payload.comment.body) ? '/rereview' : payload.issue && builderUser(payload.comment.user) ? findingRefs(payload.comment.body).join(' ') : '' };
  if (payload.issue) result.issue = { number: payload.issue.number, pull_request: Boolean(payload.issue.pull_request) };
  return result;
}

export function verifySignature(rawBody, header, secret) {
  if (typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/u.test(header)) return false;
  const supplied = Buffer.from(header.slice(7), 'hex');
  return timingSafeEqual(createHmac('sha256', secret).update(rawBody).digest(), supplied);
}
export function routeEvent(name, payload, { appId = REVIEW_APP_ID, now = Date.now(), completed = false } = {}) {
  if (payload.repository?.full_name !== REPOSITORY) return [];
  if (name === 'pull_request') {
    const pr = payload.pull_request;
    if (!pr || pr.head?.repo?.full_name !== REPOSITORY) return [{ type: 'ignore', reason: 'fork_refused' }];
    const identity = { pr: pr.number ?? payload.number, head_sha: pr.head.sha, base_ref: pr.base?.ref };
    if (['closed', 'converted_to_draft'].includes(payload.action)) {
      const operations = [{ type: 'cancel', ...identity, reason: payload.action === 'closed' ? 'closed' : 'draft' }];
      if (payload.action === 'closed' && pr.merged === true && pr.base?.ref === 'main') operations.push({ type: 'mainMoved' });
      return operations;
    }
    if (payload.action === 'edited' && payload.changes?.base) {
      const operations = [{ type: 'cancel', ...identity, reason: 'target_changed' }];
      if (pr.base?.ref === 'main') operations.push({ type: 'enqueue', ...identity, due: now, reason: 'retargeted' });
      return operations;
    }
    if (pr.base?.ref !== 'main') return [];
    if (['labeled', 'unlabeled', 'edited'].includes(payload.action)) return [{ type: 'mergeChanged' }];
    if (!['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(payload.action)) return [];
    if (pr.draft) return [{ type: 'markDraft', ...identity }];
    if (payload.action === 'ready_for_review' && completed) return [{ type: 'reuseVerdict', ...identity }];
    return [{ type: 'enqueue', ...identity, due: now + 60000, reason: payload.action }];
  }
  if (name === 'check_run' && payload.action === 'rerequested'
    && payload.check_run?.app?.id === Number(appId) && payload.check_run.name === 'codex-review') {
    return [{ type: 'enqueue', head_sha: payload.check_run.head_sha,
      branch: payload.check_run.check_suite?.head_branch, due: now, reason: 'rerequested', allowDraft: true }];
  }
  if (name === 'workflow_run' && payload.action === 'completed') {
    const run = payload.workflow_run;
    if (run?.name !== 'CI') return [];
    return [{ type: 'ciCompleted', head_sha: run.head_sha, head_branch: run.head_branch,
      conclusion: run.conclusion, run_id: run.id, html_url: run.html_url }];
  }
  if (name === 'pull_request_review_comment' && payload.action === 'created') {
    const pr = payload.pull_request;
    const comment = payload.comment;
    if (!pr || !comment?.in_reply_to_id || (comment.user?.type === 'Bot' && !builderUser(comment.user))
      || pr.head?.repo?.full_name !== REPOSITORY) return [];
    return [{ type: 'commentRereview', pr: pr.number, trigger: 'finding_reply', comment_id: comment.id,
      in_reply_to_id: comment.in_reply_to_id, created_at: Date.parse(comment.created_at),
      commenter: { id: comment.user?.id, login: comment.user?.login }, due: now + 60000 }];
  }
  if (name === 'issue_comment' && payload.action === 'created') {
    const comment = payload.comment;
    if (!payload.issue?.pull_request || !comment || (comment.user?.type === 'Bot' && !builderUser(comment.user))) return [];
    const request = { type: 'commentRereview', pr: payload.issue.number, comment_id: comment.id,
      created_at: Date.parse(comment.created_at), commenter: { id: comment.user?.id, login: comment.user?.login } };
    if (isRereviewCommand(comment.body)) return [{ ...request, trigger: 'command', due: now }];
    // TASK-1387: the builder App answers findings in PR comments that cite their IDs.
    const findings = builderUser(comment.user) ? findingRefs(comment.body) : [];
    return findings.length ? [{ ...request, trigger: 'builder_answer', findings, due: now + 60000 }] : [];
  }
  return [];
}
export async function resolvePullRequests(github, { head_sha, branch, head_branch }) {
  const selectedBranch = branch ?? head_branch;
  if (selectedBranch) {
    const rows = await github.paginate(`/repos/${github.repo}/pulls?state=open&head=${encodeURIComponent(`${REPOSITORY_OWNER}:${selectedBranch}`)}`);
    const matches = rows.filter((pr) => pr.head.sha === head_sha);
    if (matches.length) return matches;
  }
  return (await github.paginate(`/repos/${github.repo}/commits/${head_sha}/pulls`))
    .filter((pr) => pr.state === 'open' && pr.head.sha === head_sha);
}
