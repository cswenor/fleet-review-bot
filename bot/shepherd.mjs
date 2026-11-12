import { createHash } from 'node:crypto';
import { sanitize } from './evidence.mjs';
import { builderUser, ownUser } from './approval.mjs';
import { APPROVER_NAMES } from './identity.mjs';
import { githubRequestNotDispatched } from './github-app.mjs';

export { HUMAN_APPROVERS } from './identity.mjs';

export const STATUS_MARKER = '<!-- codex-review status -->';
export const NEEDS_UPDATE_LABEL = 'needs-update';
export const COMMENT_REREVIEWS_PER_HEAD = 3;

// Renovate and other bot authors own their branches and keep them current;
// the review bot updates only human- and builder-App-authored branches.
export const botMayUpdateBranch = (pr) => !pr.head?.ref?.startsWith('renovate/')
  && !(pr.user?.type === 'Bot' && !builderUser(pr.user));

export const renovatePr = (pr) => pr.head?.ref?.startsWith('renovate/') === true;

export function statusLines({ number, conflicting, behindBy, update, active, review, failedReason, botApproved,
  reviewApproved = false, changesRequestedBy = [], ci, autoMerge, gate, mergeSelected = false, botUpdatesBranch = true, renovateBranch = false, batch = [],
  commentRereviewsLeft = COMMENT_REREVIEWS_PER_HEAD }) {
  const lines = [];
  const holds = [];
  if (gate?.held) holds.push('**`hold` label.** The required `merge-gate` check fails until the label is removed.');
  const unticked = gate?.gates?.filter((entry) => !entry.ticked).length ?? 0;
  if (unticked) holds.push(`**${unticked} unticked merge gate(s)** in the PR body. Tick each \`Gate:\` checkbox once its condition is met; the required \`merge-gate\` check fails until then.`);
  if (conflicting) lines.push(botUpdatesBranch
    ? '**Conflicts with `main`.** Merge `main` into this branch (or rebase), resolve the conflicts and push. The bot does not resolve conflicts; it removes the `needs-update` label once the PR is mergeable and up to date (or updatable).'
    : renovateBranch
      ? '**Conflicts with `main`.** This branch belongs to its bot author: Renovate rebases its own branches when they conflict or fall behind. The review bot never pushes to it; do not push to it by hand. To rebase now, tick the rebase checkbox in the PR body.'
      : '**Conflicts with `main`.** This branch belongs to its bot author, which must rebase or update it. The review bot never pushes to it.');
  if (update === 'accepted') {
    lines.push("**Behind `main`.** The bot merged `main` into this branch with GitHub's update-branch; the new head will be reviewed.", ...holds);
    return lines;
  }
  if (update === 'failed:workflows') lines.push("**Behind `main`.** Can't update automatically (this update includes workflow changes); merge `main` into the branch and push.");
  else if (update?.startsWith('failed:')) lines.push(`**Behind \`main\`.** Can't update automatically (GitHub refused the bot's branch update: \`${update}\`); merge \`main\` into the branch and push.`);
  if (active) lines.push(`**Review in progress** for this head (codex-review \`${active}\`).`);
  else if (review?.result?.pass === false || review?.verdict?.reason || (!review && failedReason)) lines.push(`**codex-review could not complete** (\`${review?.result?.reasons?.[0] ?? review?.verdict?.reason ?? failedReason}\`). ${commentRereviewsLeft > 0 ? 'Comment `/rereview` (or re-run the codex-review check).' : 'Re-run the codex-review check.'}`);
  else if (review?.verdict?.decision === 'block') {
    const findings = review.findings.filter((finding) => !['resolved', 'deferred'].includes(finding.status));
    const next = commentRereviewsLeft > 0
      ? `Push a fix, or reply on each finding with fixing-code file:line evidence (required for P0/P1); P2/P3 may instead be deferred with a TASK reference and reason. The bot re-reviews this head about a minute after a reply from the PR author or ${APPROVER_NAMES}. Comment \`/rereview\` to re-review now (${commentRereviewsLeft} automatic re-review(s) left for this head).`
      : 'Push a fix, or reply on each finding with fixing-code file:line evidence (required for P0/P1); P2/P3 may instead be deferred with a TASK reference and reason. Re-run the codex-review check (automatic re-reviews for this head are used up).';
    lines.push(`**${findings.length} codex-review finding(s) to fix or answer:** ${findings.map((finding) => finding.id).join(', ')}. ${next}`);
  } else if (review?.verdict?.decision === 'ambiguous' && review.waitingForHuman === true && !reviewApproved) lines.push(`**Needs a human approval** from ${APPROVER_NAMES} (not the author): codex-review stayed ambiguous after its re-review.`);
  else if (!review) lines.push('**Waiting for codex-review** on this head.');
  if (changesRequestedBy.length) lines.push(`**Changes requested** by ${changesRequestedBy.join(', ')}. Address them and ask for a re-review.`);
  if (['failure', 'timed_out', 'startup_failure'].includes(ci?.conclusion)) lines.push(`**CI failing:** [${ci.conclusion}](${ci.html_url}).`);
  if (batch.length) return [...lines, ...holds, ...batch];
  if (botUpdatesBranch && conflicting === false && behindBy > 0 && !update) {
    lines.push('**Behind `main`.** Only the single approved, green next-to-merge PR is refreshed. Compatible approved sources can share a carrier without member CI churn; resolve real conflicts yourself.');
  }
  lines.push(...holds);
  if (!lines.length) {
    if (botApproved || reviewApproved) lines.push(mergeSelected
      ? '**Selected merge lane.** Waiting for the exact refreshed head to pass review and CI; the bot then merges it before advancing.'
      : '**Waiting for the merge lane.** Approved PRs with green CI are ordered by `merge-priority:N` (lower first), then age; compatible batches share one carrier CI run.');
    else lines.push("**Waiting for the bot's approval** of this head.");
  }
  if (!botUpdatesBranch && conflicting === false && behindBy > 0) lines.push(renovateBranch
    ? '**Behind `main`.** Carrier-only while behind: this approved, green source may join a compatible companion without a branch update, but cannot merge alone. Renovate owns branch updates; the review bot never pushes to it.'
    : '**Behind `main`.** Carrier-only while behind: this approved, green source may join a compatible companion without a branch update, but cannot merge alone. Its bot author owns branch updates; the review bot never pushes to it.');
  return lines;
}
export function statusBody(facts) {
  return sanitize([STATUS_MARKER, `**What this PR is waiting on** (head \`${facts.headSha.slice(0, 12)}\`)`, '',
    ...statusLines(facts).map((line) => '- ' + line), '', '_The review bot edits this comment in place whenever this changes._'].join('\n'), { secrets: facts.secrets ?? [] });
}

export class Shepherd {
  constructor({ github, store, secrets = [], now = Date.now, log = () => {} }) {
    Object.assign(this, { github, store, secrets, now, log });
    this.labelReady = false;
  }
  async inspect(number, options = {}) {
    const pr = await this.github.request('GET', `/repos/${this.github.repo}/pulls/${number}`, undefined, undefined, options);
    const conflicting = pr.mergeable === false ? true : pr.mergeable === true ? false : null;
    let behindBy = null;
    let mainSha = null;
    if (conflicting === false) {
      const compare = await this.github.request('GET', `/repos/${this.github.repo}/compare/main...${pr.head.sha}?per_page=1`,
        undefined, undefined, options.informational ? { ...options, headSha: pr.head.sha, pr: number } : options);
      behindBy = compare.behind_by;
      mainSha = compare.base_commit.sha;
    }
    return { pr, conflicting, behindBy, mainSha };
  }
  async ensureLabel(guard) {
    if (this.labelReady) return;
    const path = `/repos/${this.github.repo}/labels`;
    try { await this.github.request('GET', `${path}/${NEEDS_UPDATE_LABEL}`); }
    catch (error) {
      if (!error.message.includes('HTTP 404')) throw error;
      await this.github.request('POST', path, { name: NEEDS_UPDATE_LABEL, color: 'd93f0b',
        description: "Needs main merged in by hand: conflicts, or an update the bot can't apply" }, guard);
    }
    this.labelReady = true;
  }
  async syncLabel({ pr, needsUpdate, guard }) {
    if (needsUpdate === null) return;
    const present = pr.labels?.some((label) => label.name === NEEDS_UPDATE_LABEL);
    const path = `/repos/${this.github.repo}/issues/${pr.number}/labels`;
    if (needsUpdate && !present) {
      await this.ensureLabel(guard);
      await this.github.request('POST', path, { labels: [NEEDS_UPDATE_LABEL] }, guard);
    } else if (!needsUpdate && present) {
      try { await this.github.request('DELETE', `${path}/${NEEDS_UPDATE_LABEL}`, undefined, guard); }
      catch (error) { if (!error.message.includes('HTTP 404')) throw error; }
    }
  }
  async updateBranch({ pr, conflicting, behindBy, mainSha, ready, beforeSend = async () => {}, recordMutation }) {
    if (this.store.sealedCarrier(pr.number)) return null;
    if (!ready || !botMayUpdateBranch(pr)) return null;
    const failed = this.store.failedUpdate(pr.number, pr.head.sha);
    if (failed) return failed.outcome;
    if (conflicting !== false || !(behindBy > 0)) return null;
    const stored = this.store.updateAttempt(pr.number, pr.head.sha, mainSha);
    if (stored) return null;
    let outcome;
    let sent = false;
    try {
      await this.github.request('PUT', `/repos/${this.github.repo}/pulls/${pr.number}/update-branch`,
        { expected_head_sha: pr.head.sha }, async (phase) => {
          if (phase === 'before_send') {
            await beforeSend();
            // Reserve only at the send fence; the lane journal and attempt
            // commit together or neither survives a process crash.
            this.store.transaction(() => {
              recordMutation?.();
              this.store.saveUpdateAttempt(pr.number, pr.head.sha, mainSha, 'pending', this.now());
            });
            sent = true;
          }
        });
      outcome = 'accepted';
    } catch (error) {
      if (error.code === 'github_budget_deferred') {
        if (githubRequestNotDispatched(error, 'PUT', `/repos/${this.github.repo}/pulls/${pr.number}/update-branch`)) {
          this.store.cancelPendingUpdate(pr.number, pr.head.sha, mainSha);
        }
        throw error;
      }
      if (!sent) {
        // The transport fence proved no PUT was sent; allow a later legitimate
        // retry instead of persisting a false refusal or uncertain mutation.
        this.store.cancelPendingUpdate(pr.number, pr.head.sha, mainSha);
        throw error;
      }
      const code = /HTTP (\d+)/u.exec(error.message)?.[1];
      outcome = code ? `failed:HTTP ${code}` : error.message === 'github_timeout' ? 'failed:github_timeout' : 'failed:error';
      if (code?.startsWith('4')) {
        try {
          const compare = await this.github.request('GET', `/repos/${this.github.repo}/compare/${pr.head.sha}...${mainSha}`);
          if (compare.files?.some((file) => file.filename.startsWith('.github/workflows/'))) outcome = 'failed:workflows';
        } catch { /* Preserve the HTTP classification when comparison is unavailable. */ }
      }
    }
    this.store.saveUpdateAttempt(pr.number, pr.head.sha, mainSha, outcome, this.now());
    this.log({ event: 'shepherd_update', pr: pr.number, outcome });
    return outcome;
  }
  async publishStatus(number, body, journal = null, guard = async () => {}) {
    body = sanitize(body, { secrets: this.secrets });
    if (journal) body += `\n${journal.marker}`;
    const digest = createHash('sha256').update(body).digest('hex');
    const path = `/repos/${this.github.repo}/issues/${number}/comments`;
    const pending = journal?.pending();
    if (pending) {
      if (pending.kind !== 'comment' || pending.comment_pr !== number) return { pending: true };
      let comments;
      if (pending.comment_id) {
        try { comments = [await this.github.request('GET', `/repos/${this.github.repo}/issues/comments/${pending.comment_id}`)]; }
        catch (error) {
          if (error.message !== `GitHub request failed: GET /repos/${this.github.repo}/issues/comments/${pending.comment_id} HTTP 404`) throw error;
          // A missing comment cannot prove a previously sent PATCH never arrives.
          return { pending: true };
        }
      } else comments = await this.github.paginate(path);
      const matches = comments.filter((comment) => ownUser(comment.user)
        && comment.body?.includes(pending.marker)
        && createHash('sha256').update(comment.body).digest('hex') === pending.body_sha256);
      if (matches.length > 1) throw new Error('batch_comment_adoption_ambiguous');
      if (!matches.length) return { pending: true }; // Never repeat an uncertain POST.
      this.store.transaction(() => {
        this.store.saveShepherd(number, { comment_id: matches[0].id, status_sha256: pending.body_sha256 }, this.now());
        journal.finish({ outcome: 'published', comment_id: matches[0].id, body_sha256: pending.body_sha256 });
      });
    }
    const stored = this.store.shepherdState(number);
    if (stored?.status_sha256 === digest) return { comment_id: stored.comment_id, body_sha256: digest };
    const write = async (method, target, commentId = null) => {
      let intentId;
      try {
        const receipt = await this.github.request(method, target, { body }, async (phase) => {
          await guard(phase);
          await journal?.guard();
          if (phase === 'before_send' && journal) {
            journal.begin({ method, comment_id: commentId, body_sha256: digest });
            intentId = journal.pending()?.id;
          }
        });
        const id = receipt?.id ?? commentId;
        if (!Number.isSafeInteger(id) || id < 1) throw new Error('status_comment_receipt_invalid');
        this.store.transaction(() => {
          this.store.saveShepherd(number, { comment_id: id, status_sha256: digest }, this.now());
          journal?.finish({ outcome: 'published', comment_id: id, body_sha256: digest });
        });
        return receipt;
      } catch (error) {
        if (intentId && journal?.pending()?.id === intentId && githubRequestNotDispatched(error, method, target)) {
          journal.finish({ outcome: 'not_dispatched', reason: error.message });
        }
        if (/^GitHub request failed: (?:POST|PATCH) \/\S+ HTTP 4\d\d$/u.test(error.message) && journal?.pending()?.kind === 'comment') {
          journal.finish({ outcome: 'rejected', reason: error.message });
        }
        throw error;
      }
    };
    let id = stored?.comment_id;
    if (id) {
      try { await write('PATCH', `/repos/${this.github.repo}/issues/comments/${id}`, id); }
      catch (error) {
        if (!error.message.includes('HTTP 404')) throw error;
        id = null;
        this.store.saveShepherd(number, { comment_id: null, status_sha256: null }, this.now());
      }
    }
    if (!id) {
      const existing = (await this.github.paginate(path))
        .find((comment) => ownUser(comment.user) && comment.body?.startsWith(STATUS_MARKER));
      if (existing) {
        id = existing.id;
        await write('PATCH', `/repos/${this.github.repo}/issues/comments/${id}`, id);
      } else id = (await write('POST', path)).id;
    }
    return { comment_id: id, body_sha256: digest };
  }
}
