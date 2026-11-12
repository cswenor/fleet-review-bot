import { createHash } from 'node:crypto';

export const DEFAULT_BATCH_SIZE = 5;
export const HARD_BATCH_SIZE = 5;

const SHA = /^[0-9a-f]{40}$/u;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

function requireValue(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function batchLimit(value = DEFAULT_BATCH_SIZE) {
  requireValue(positiveInteger(value) && value <= HARD_BATCH_SIZE, 'batch limit must be an integer from 1 to 5');
  return value;
}

export function mergePriority(pr) {
  requireValue(pr && typeof pr === 'object', 'PR must be an object');
  const labels = pr.labels ?? [];
  requireValue(Array.isArray(labels), 'labels must be an array');
  let result = null;
  for (const label of labels) {
    const match = /^merge-priority:(0|[1-9]\d*)$/u.exec(label?.name ?? '');
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && (result === null || value < result)) result = value;
  }
  return result;
}

function snapshot(value) {
  requireValue(value && positiveInteger(value.pr), 'PR identity must be a positive safe integer');
  requireValue(typeof value.head_sha === 'string' && SHA.test(value.head_sha), 'head_sha must be a lowercase 40-hex SHA');
  return value;
}

function member(value) {
  snapshot(value);
  for (const field of ['review_id', 'publication_id', 'github_review_id', 'ci_run_id', 'ci_attempt']) {
    requireValue(positiveInteger(value[field]), `${field} must be a positive safe integer`);
  }
  requireValue(typeof value.pull_request_id === 'string' && value.pull_request_id.trim().length > 0,
    'pull_request_id must be a nonempty string');
  requireValue(value.priority === null || (Number.isSafeInteger(value.priority) && value.priority >= 0),
    'priority must be a nonnegative safe integer or null');
  requireValue(value.created_at === null || (typeof value.created_at === 'string'
    && /^\d{4}-\d{2}-\d{2}T/u.test(value.created_at) && Number.isFinite(Date.parse(value.created_at))),
  'created_at must be an ISO timestamp or null');
  return value;
}

function indexed(values, validate, name) {
  requireValue(Array.isArray(values), `${name} must be an array`);
  const result = new Map();
  const nodeIds = new Set();
  for (const value of values) {
    validate(value);
    requireValue(!result.has(value.pr), `duplicate ${name} PR ${value.pr}`);
    if (validate === member) {
      requireValue(!nodeIds.has(value.pull_request_id), `duplicate pull_request_id ${value.pull_request_id}`);
      nodeIds.add(value.pull_request_id);
    }
    result.set(value.pr, value);
  }
  return result;
}

function compare(a, b) {
  const priorityA = a.priority ?? Infinity;
  const priorityB = b.priority ?? Infinity;
  if (priorityA !== priorityB) return priorityA < priorityB ? -1 : 1;
  const ageA = a.created_at === null ? Infinity : Date.parse(a.created_at);
  const ageB = b.created_at === null ? Infinity : Date.parse(b.created_at);
  if (ageA !== ageB) return ageA < ageB ? -1 : 1;
  return a.pr - b.pr;
}

export function orderCandidates(members) {
  indexed(members, member, 'members');
  return [...members].sort(compare);
}

// Readiness is supplied only by the caller's exact-head admission gate. Open is
// deliberately NOT that shortlist: it includes every page, held/draft/fork PRs too.
export function selectClosedBatch({ ready, open, dependencies, max = DEFAULT_BATCH_SIZE, forceSerial = [], knownConflicts = [] }) {
  const limit = batchLimit(max);
  const candidates = orderCandidates(ready);
  const readyByPr = new Map(candidates.map((value) => [value.pr, value]));
  const openByPr = indexed(open, snapshot, 'open');
  requireValue(dependencies instanceof Map, 'dependencies must be a Map');
  for (const [pr, heads] of dependencies) {
    requireValue(positiveInteger(pr), 'dependency key must be a PR identity');
    const byPr = indexed(heads, snapshot, 'dependencies');
    requireValue(!byPr.has(pr), 'dependencies must exclude their own PR');
  }
  requireValue(Array.isArray(knownConflicts), 'knownConflicts must be an array');
  for (const conflict of knownConflicts) {
    requireValue(conflict.length > 0, 'known conflicts must be nonempty');
    indexed(conflict, snapshot, 'known conflict');
  }
  requireValue(Array.isArray(forceSerial), 'forceSerial must be an array');
  const forced = new Set();
  for (const pr of forceSerial) {
    requireValue(positiveInteger(pr) && !forced.has(pr), 'forceSerial must contain unique PR identities');
    forced.add(pr);
  }
  // Stable sort retains priority/age within each group; isolation cannot starve behind ordinary work.
  if (forced.size) candidates.sort((left, right) => Number(forced.has(right.pr)) - Number(forced.has(left.pr)));

  const selected = new Map();
  const deferred = [];
  let serial = false;
  for (const candidate of candidates) {
    if (selected.has(candidate.pr)) continue;
    const closure = new Map();
    const blocked = new Set();
    const visited = new Map();
    let missingAncestry = false;
    function visit(head) {
      const prior = visited.get(head.pr);
      if (prior !== undefined) {
        if (prior !== head.head_sha) blocked.add(head.pr);
        return;
      }
      visited.set(head.pr, head.head_sha);
      const admitted = readyByPr.get(head.pr);
      if (openByPr.get(head.pr)?.head_sha !== head.head_sha || admitted?.head_sha !== head.head_sha) {
        blocked.add(head.pr);
        return;
      }
      closure.set(head.pr, admitted);
      if (!dependencies.has(head.pr)) {
        blocked.add(head.pr);
        missingAncestry = true;
        return;
      }
      for (const dependency of dependencies.get(head.pr)) visit(dependency);
    }
    visit(candidate);
    let reason = null;
    let affected = [...blocked];
    const combined = new Map([...selected, ...closure]);
    const composition = knownConflicts.length ? orderCandidates([...combined.values()]) : [];
    const knownConflict = knownConflicts.find((conflict) => conflict.every((member, index) =>
      composition[index]?.pr === member.pr && composition[index].head_sha === member.head_sha));
    if (blocked.size) reason = missingAncestry ? 'missing-ancestry' : 'unready-dependency';
    else if (serial || (forced.has(candidate.pr) && (selected.size > 0 || closure.size !== 1))
      || [...closure.keys()].some((pr) => forced.has(pr) && pr !== candidate.pr)) {
      reason = 'force-serial';
      affected = [...closure.keys()].filter((pr) => forced.has(pr));
    } else if ([...combined.values()].some((value) => value.priority === 0)
      && [...combined.values()].some((value) => value.priority !== 0)) {
      reason = 'priority-zero-only';
      affected = [...combined.values()].filter((value) => value.priority !== 0).map((value) => value.pr);
    } else if (knownConflict) {
      reason = 'known-conflict';
      affected = knownConflict.map((member) => member.pr);
    } else if (combined.size > limit) {
      reason = 'capacity';
      affected = [...closure.keys()].filter((pr) => !selected.has(pr));
    }
    if (reason) {
      deferred.push({ pr: candidate.pr, reason, dependencies: affected.sort((a, b) => a - b) });
      continue;
    }
    for (const [pr, value] of closure) selected.set(pr, value);
    serial = forced.has(candidate.pr);
  }
  return { members: orderCandidates([...selected.values()]), deferred, serial };
}

// These sets MUST be computed against exactly the heads in this open snapshot,
// not an older PR-number-only ancestry cache. A selected old head cannot cover a
// newly reachable open head, even when the PR number is unchanged.
export function ancestryViolations({ open, members, baseAncestors, combinedAncestors }) {
  const openByPr = indexed(open, snapshot, 'open');
  const selected = indexed(members, member, 'members');
  for (const set of [baseAncestors, combinedAncestors]) {
    requireValue(set instanceof Set, 'ancestor identities must be Sets');
    for (const pr of set) requireValue(positiveInteger(pr) && openByPr.has(pr), 'ancestor must identify a pinned open PR');
  }
  return [...openByPr.values()].filter((head) => combinedAncestors.has(head.pr)
    && !baseAncestors.has(head.pr) && selected.get(head.pr)?.head_sha !== head.head_sha)
    .sort((a, b) => a.pr - b.pr);
}

export function manifestDigest({ id, generation, base_sha, members }) {
  requireValue(typeof id === 'string' && id.trim().length > 0, 'id must be a nonempty string');
  requireValue(positiveInteger(generation), 'generation must be a positive safe integer');
  requireValue(typeof base_sha === 'string' && SHA.test(base_sha), 'base_sha must be a lowercase 40-hex SHA');
  indexed(members, member, 'members');
  requireValue(members.length > 0 && members.length <= HARD_BATCH_SIZE, 'manifest must have 1 to 5 members');
  // Explicit key order and complete admitted identity/receipts, never PR bodies,
  // labels, branch markers or arbitrary object insertion order. List order matters.
  const identity = { id, generation, base_sha, members: members.map((value) => ({
    pr: value.pr,
    head_sha: value.head_sha,
    review_id: value.review_id,
    publication_id: value.publication_id,
    github_review_id: value.github_review_id,
    pull_request_id: value.pull_request_id,
    ci_run_id: value.ci_run_id,
    ci_attempt: value.ci_attempt,
    priority: value.priority,
    created_at: value.created_at,
  })) };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
