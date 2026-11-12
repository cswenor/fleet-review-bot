import { mergeGate } from './merge-gate.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const MAX_PAGES = 100;
const requireData = (condition, message) => {
  if (!condition) throw new Error(message);
};

// Queue entry baseCommit is not a documented membership chain. Inspect the
// conservative complete queue prefix through the uniquely matching group head,
// including entries whose baseCommit is shared. This can overblock an earlier
// queued PR not present in this group, but never skips it based on chain guesses.
export function groupMembers(group, entries) {
  requireData(SHA.test(group?.head_sha) && SHA.test(group?.base_sha), 'Unknown group SHA');
  requireData(Array.isArray(entries) && entries.length > 0, 'Empty merge queue');
  const byHead = new Map();
  const numbers = new Set();
  for (const entry of entries) {
    requireData(SHA.test(entry?.headCommit?.oid) && SHA.test(entry?.baseCommit?.oid)
      && Number.isSafeInteger(entry?.pullRequest?.number) && entry.pullRequest.number > 0
      && SHA.test(entry.pullRequest.headRefOid)
      && Number.isSafeInteger(entry.position) && entry.position > 0, 'Incomplete queue entry');
    requireData(!byHead.has(entry.headCommit.oid) && !numbers.has(entry.pullRequest.number), 'Ambiguous queue entries');
    byHead.set(entry.headCommit.oid, entry);
    numbers.add(entry.pullRequest.number);
  }
  requireData(group.head_sha !== group.base_sha, 'Empty merge group');
  const target = byHead.get(group.head_sha);
  requireData(target, 'Unknown synthetic queue head');
  const members = entries.filter((entry) => entry.position <= target.position)
    .sort((a, b) => a.position - b.position);
  requireData(members.length === target.position
    && members.every((entry, index) => entry.position === index + 1), 'Partial or noncontiguous queue prefix');
  requireData(members.some((entry) => entry.baseCommit.oid === group.base_sha)
    || members.slice(0, -1).some((entry) => entry.headCommit.oid === group.base_sha), 'Unknown synthetic group base');
  return members;
}

export function inspectPull(pr, { number, head, base }) {
  requireData(pr?.number === number && pr.state === 'open' && pr.base?.ref === base
    && SHA.test(pr.head?.sha) && typeof pr.draft === 'boolean'
    && (pr.body === null || typeof pr.body === 'string')
    && Array.isArray(pr.labels) && pr.labels.every((label) => typeof label?.name === 'string'), 'Unknown live PR data');
  requireData(!head || pr.head.sha === head, 'Stale event head');
  const gate = mergeGate(pr);
  return { pass: !pr.draft && gate.pass, sha: pr.head.sha, number, gate };
}

const QUEUE_QUERY = `query($owner:String!,$repo:String!,$branch:String!,$after:String) {
  repository(owner:$owner,name:$repo) {
    mergeQueue(branch:$branch) {
      entries(first:100,after:$after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { position baseCommit { oid } headCommit { oid } pullRequest { number headRefOid } }
      }
    }
  }
}`;

export async function readQueue(github, repo, branch) {
  const entries = [];
  const cursors = new Set();
  let after = null;
  let count;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await github.graphql(QUEUE_QUERY, { ...repo, branch, after });
    if (data?.repository?.mergeQueue === null) {
      requireData(page === 0, 'Queue disappeared during pagination');
      return [];
    }
    const connection = data?.repository?.mergeQueue?.entries;
    requireData(connection && Number.isSafeInteger(connection.totalCount) && connection.totalCount >= 0
      && Array.isArray(connection.nodes) && typeof connection.pageInfo?.hasNextPage === 'boolean', 'Unknown queue page');
    count ??= connection.totalCount;
    requireData(count === connection.totalCount && connection.nodes.every(Boolean), 'Queue changed or partial page');
    entries.push(...connection.nodes);
    requireData(entries.length <= count, 'Inconsistent queue count');
    if (!connection.pageInfo.hasNextPage) {
      requireData(entries.length === count, 'Truncated queue membership');
      return entries;
    }
    after = connection.pageInfo.endCursor;
    requireData(connection.nodes.length > 0 && typeof after === 'string' && after && !cursors.has(after), 'Invalid queue pagination');
    cursors.add(after);
  }
  throw new Error('Queue pagination limit exceeded');
}

function snapshot(entries) {
  return JSON.stringify([...entries].sort((a, b) => a.position - b.position));
}

export async function runHoldCheck({ github, context, core, reviewApp = '', publishStatus }) {
  if (context.eventName === 'approval_reconcile') {
    // Only the independently deployed App invokes this sweep, never a
    // PR-controlled workflow. All authority comes from fresh live API reads.
    const pulls = [];
    const seen = new Set();
    try {
      requireData(context.payload?.action === 'reconcile', 'Unsupported approval reconcile');
      let complete = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { data } = await github.rest.pulls.list({ ...context.repo, state: 'open', per_page: 100, page });
        requireData(Array.isArray(data) && data.length <= 100, 'Unknown review-signal PR page');
        for (const pr of data) {
          requireData(Number.isSafeInteger(pr?.number) && !seen.has(pr.number), 'Unknown review-signal membership');
          seen.add(pr.number);
          pulls.push(pr);
        }
        if (data.length < 100) { complete = true; break; }
      }
      requireData(complete, 'Review-signal PR pagination limit exceeded');
      let pass = true;
      for (const pr of pulls) {
        const result = await runHoldCheck({ github, core, reviewApp, publishStatus,
          context: { ...context, eventName: 'pull_request_target', payload: { action: 'edited', pull_request: pr } } });
        pass = result && pass;
      }
      return pass;
    } catch (error) {
      core.setFailed(error.message);
      return false;
    }
  }
  const repo = context.repo;
  const event = context.payload;
  const group = event.merge_group;
  const pull = event.pull_request;
  const target = group?.head_sha ?? pull?.head?.sha;
  requireData(SHA.test(target), 'Missing event target SHA');
  const status = async (sha, state, description) => {
    requireData(SHA.test(sha), 'Invalid status SHA');
    if (publishStatus) return publishStatus(sha, state, description);
    await github.rest.repos.createCommitStatus({ ...repo, sha, state, context: 'merge-gate', description,
      target_url: `${context.serverUrl ?? 'https://github.com'}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}` });
  };
  let reviewer;
  const requireApproval = async (number, sha) => {
    if (!reviewer) return;
    let latest;
    let complete = false;
    const seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await github.rest.pulls.listReviews({ ...repo, pull_number: number, per_page: 100, page });
      requireData(Array.isArray(data) && data.length <= 100, 'Unknown review page');
      for (const review of data) {
        requireData(Number.isSafeInteger(review?.id) && !seen.has(review.id), 'Unknown or repeated review');
        seen.add(review.id);
        if (review.user?.id !== reviewer.id || review.user?.login !== reviewer.login
          || review.user?.type !== 'Bot'
          || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
        const time = Date.parse(review.submitted_at);
        requireData(Number.isFinite(time) && SHA.test(review.commit_id), 'Unknown App review authority');
        if (!latest || time > latest.time || (time === latest.time && review.id > latest.review.id)) {
          latest = { time, review };
        }
      }
      if (data.length < 100) { complete = true; break; }
    }
    requireData(complete, 'Review pagination limit exceeded');
    requireData(latest?.review.state === 'APPROVED' && latest.review.commit_id === sha,
      'Missing configured Review App exact-head approval');
  };
  const livePull = async (number, head, base) => {
    const { data } = await github.rest.pulls.get({ ...repo, pull_number: number });
    await requireApproval(number, data?.head?.sha);
    if (reviewer && group) {
      const shared = await sharedHeadPulls(head);
      requireData(shared.pulls.some((candidate) => candidate.number === number)
        && shared.pulls.every((candidate) => candidate.pass), 'A PR sharing a queue member head lacks authority');
    }
    return inspectPull(data, { number, head, base });
  };
  const sharedHeadPulls = async (sharedHead = target) => {
    const results = [];
    const numbers = new Set();
    const bases = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await github.rest.pulls.list({ ...repo, state: 'open', per_page: 100, page });
      requireData(Array.isArray(data) && data.length <= 100, 'Unknown open PR page');
      for (const candidate of data) {
        requireData(Number.isSafeInteger(candidate?.number) && !numbers.has(candidate.number)
          && SHA.test(candidate.head?.sha) && typeof candidate.base?.ref === 'string', 'Unknown open PR membership');
        numbers.add(candidate.number);
        bases.add(candidate.base.ref);
        if (candidate.head.sha === sharedHead) {
          await requireApproval(candidate.number, sharedHead);
          results.push(inspectPull(candidate,
            { number: candidate.number, head: sharedHead, base: candidate.base.ref }));
        }
      }
      if (data.length < 100) return { pulls: results.sort((a, b) => a.number - b.number), bases: [...bases].sort() };
    }
    throw new Error('Open PR pagination limit exceeded');
  };
  let entries;
  let base;
  try {
    await status(target, 'pending', 'Inspecting live holds and complete queue membership');
    requireData(typeof reviewApp === 'string' && (!reviewApp
      || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(reviewApp)), 'Invalid Review App slug');
    if (reviewApp) {
      const login = `${reviewApp}[bot]`;
      const { data } = await github.rest.users.getByUsername({ username: login });
      requireData(data?.login === login && data.type === 'Bot' && Number.isSafeInteger(data.id)
        && data.id > 0 && data.html_url === `https://github.com/apps/${reviewApp}`, 'Unknown Review App identity');
      reviewer = { id: data.id, login };
    }
    if (group) {
      requireData(context.eventName === 'merge_group' && event.action === 'checks_requested', 'Unsupported merge group event');
      requireData(typeof group.base_ref === 'string' && group.base_ref.startsWith('refs/heads/')
        && typeof group.head_ref === 'string' && group.head_ref.startsWith('refs/heads/gh-readonly-queue/'), 'Unknown merge group refs');
      base = group.base_ref.slice('refs/heads/'.length);
      if (reviewer) requireData(base === 'main', 'Configured App approval supports main only');
      const checkRef = async () => {
        const { data } = await github.rest.git.getRef({ ...repo, ref: group.head_ref.slice('refs/'.length) });
        requireData(data?.object?.sha === target, 'Stale group head');
      };
      await checkRef();
      entries = await readQueue(github, repo, base);
      const members = groupMembers(group, entries);
      const results = [];
      for (const member of members) results.push(await livePull(member.pullRequest.number, member.pullRequest.headRefOid, base));
      requireData(results.every((result) => result.pass), 'A merge group member is held, draft, or has an unticked Gate');
      requireData(snapshot(entries) === snapshot(await readQueue(github, repo, base)), 'Queue changed during evaluation');
      // Read each member again after resolving the queue; no cached webhook body is authority.
      for (const result of results) requireData((await livePull(result.number, result.sha, base)).pass, 'Merge group member changed');
      await checkRef();
    } else {
      requireData(context.eventName === 'pull_request_target'
        && Number.isSafeInteger(pull?.number) && typeof pull.base?.ref === 'string', 'Unsupported or incomplete PR event');
      base = pull.base.ref;
      if (reviewer) requireData(base === 'main', 'Configured App approval supports main only');
      const result = await livePull(pull.number, target, base);
      requireData(result.pass, 'PR is held, draft, or has an unticked Gate');
      requireData((await livePull(pull.number, target, base)).pass, 'PR changed during evaluation');
    }
    // Commit statuses are SHA-scoped, not PR-scoped: another branch with this
    // head must not clear a held PR's failure. Reconcile all matching open PRs.
    const shared = await sharedHeadPulls();
    requireData(group || shared.pulls.some((candidate) => candidate.number === pull.number), 'Event PR missing from live membership');
    requireData(shared.pulls.every((candidate) => candidate.pass), 'A PR sharing this head is held, draft, or has an unticked Gate');
    if (!group) {
      // A PR branch may point directly at a synthetic queue commit. Its PR
      // event cannot grant that SHA authority without checking group members.
      for (const branch of shared.bases) {
        const queued = await readQueue(github, repo, branch);
        requireData(!queued.some((entry) => entry.headCommit?.oid === target), 'PR head aliases a synthetic queue head');
      }
    }
    requireData(JSON.stringify(shared) === JSON.stringify(await sharedHeadPulls()), 'Shared-head PR authority changed');
    await status(target, 'success', 'Live hold, draft, and Gate checks passed');
    return true;
  } catch (error) {
    await status(target, 'failure', 'Hold gate blocked or live membership could not be verified');
    if (!group && base) {
      // Hold-only callers retain conservative base-wide revocation. When App
      // approvals are required, ordinary unapproved PRs are expected: revoke
      // only queue prefixes containing this PR (or its SHA-scoped authority).
      // GitHub has no atomic read/check/merge API; this is not a race-free
      // guarantee. A revoked group requires a fresh group evaluation.
      try {
        entries = await readQueue(github, repo, base);
        const affected = reviewApp ? entries.filter((entry) =>
          groupMembers({ head_sha: entry?.headCommit?.oid, base_sha: entry?.baseCommit?.oid }, entries)
            .some((member) => member.pullRequest.number === pull.number || member.pullRequest.headRefOid === target))
          : entries;
        for (const sha of new Set(affected.map((entry) => entry?.headCommit?.oid))) {
          await status(sha, 'failure', 'PR hold or approval invalidated queue authority; re-evaluation required');
        }
      } catch (invalidationError) {
        core.error(`Queue authority could not be fully invalidated: ${invalidationError.message}`);
      }
    }
    core.setFailed(error.message);
    return false;
  }
}
