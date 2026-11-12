import { createHash } from 'node:crypto';
import { sanitize, buildCheckOutput } from './evidence.mjs';
import { REVIEW_APP_ID } from './identity.mjs';
import { ownUser } from './approval.mjs';
import { githubRequestNotDispatched } from './github-app.mjs';

export function rightSideLines(diff) {
  const lines = new Map();
  let path = null;
  let line = 0;
  let remaining = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) { path = null; remaining = 0; }
    if (text.startsWith('+++ b/')) { path = text.slice(6); if (!lines.has(path)) lines.set(path, new Set()); }
    else if (text.startsWith('+++ "b/')) {
      // Git quotes unusual names; only plain JSON-compatible quoting is used inline.
      try { path = JSON.parse(text.slice(4)).slice(2); if (!lines.has(path)) lines.set(path, new Set()); } catch { path = null; }
    } else {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(text);
      if (hunk) { line = Number(hunk[1]); remaining = hunk[2] === undefined ? 1 : Number(hunk[2]); }
      else if (path && remaining > 0 && (text.startsWith('+') || text.startsWith(' '))) {
        lines.get(path).add(line++); remaining--;
      }
    }
  }
  return lines;
}
export class Publisher {
  constructor({ github, store, secrets = [], draftConclusion = 'skipped', now = Date.now }) {
    Object.assign(this, { github, store, secrets, draftConclusion, now });
    this.queuedPending = new Map();
  }
  async guarded(guard, operation) {
    await guard();
    const result = await operation();
    await guard();
    return result;
  }
  async findCheck(row, guard = async () => {}) {
    const checks = await this.guarded(guard, () => this.github.paginate(`/repos/${this.github.repo}/commits/${row.head_sha}/check-runs?check_name=codex-review&app_id=${this.github.appId ?? REVIEW_APP_ID}`, 'check_runs', guard));
    return checks.find((check) => check.app?.id === Number(this.github.appId ?? REVIEW_APP_ID)
      && check.head_sha === row.head_sha && check.external_id === String(row.publication_id ?? row.id));
  }
  async queued(row, guard = async () => {}) {
    let work = this.queuedPending.get(row.id);
    if (!work) {
      work = this.createQueued(row, guard).finally(() => {
        if (this.queuedPending.get(row.id) === work) this.queuedPending.delete(row.id);
      });
      this.queuedPending.set(row.id, work);
    }
    const current = await work;
    await guard();
    if (current.head_sha !== row.head_sha || current.pr !== row.pr
      || current.publication_id !== row.publication_id) throw new Error('publication_cancelled');
    return current;
  }
  async createQueued(row, guard) {
    const current = () => {
      const live = this.store.review ? this.store.review(row.id) : row;
      if (!live || live.head_sha !== row.head_sha || live.pr !== row.pr
        || live.publication_id !== row.publication_id) throw new Error('publication_cancelled');
      return live;
    };
    await guard();
    if (current().check_run_id) return current();
    let check = await this.findCheck(row, guard);
    if (!check) {
      try {
        check = await this.guarded(guard, () => this.github.request('POST', `/repos/${this.github.repo}/check-runs`, {
          name: 'codex-review', head_sha: row.head_sha, status: 'queued', external_id: String(row.publication_id ?? row.id),
          output: { title: `codex-review queued · ${row.head_sha.slice(0, 12)}`, summary: 'Review queued.' } }, guard));
      } catch (error) {
        if (githubRequestNotDispatched(error, 'POST', `/repos/${this.github.repo}/check-runs`)) throw error;
        // A cancellation may race an accepted POST. Read-only adoption retains
        // its exact identity so cancellation can terminalize it after this lease.
        check = await this.findCheck(row, error.message === 'publication_cancelled' ? undefined : guard);
        if (!check) throw error;
        current();
        this.store.update(row.id, { check_run_id: check.id });
        if (error.message === 'publication_cancelled') throw error;
      }
    }
    const live = current();
    const saved = this.store.update(row.id, { check_run_id: live.check_run_id ?? check.id });
    await guard();
    return { ...live, ...saved };
  }
  async findReview(review, marker, guard = async () => {}) {
    return (await this.guarded(guard, () => this.github.paginate(`/repos/${this.github.repo}/pulls/${review.pr}/reviews`, null, guard)))
      .find((receipt) => ownUser(receipt.user)
        && receipt.commit_id === review.head_sha && receipt.body?.split('\n', 1)[0] === marker);
  }
  async started(row, guard = async () => {}) {
    await this.github.request('PATCH', `/repos/${this.github.repo}/check-runs/${row.check_run_id}`, {
      status: 'in_progress', started_at: new Date(this.now()).toISOString() }, guard);
  }
  async terminal(row, conclusion, summary) {
    if (!row.check_run_id) return;
    // An uncertain terminal PATCH must not leave an older output receipt reusable.
    this.#forgetOutput(row);
    await this.github.request('PATCH', `/repos/${this.github.repo}/check-runs/${row.check_run_id}`, {
      status: 'completed', conclusion, completed_at: new Date(this.now()).toISOString(),
      output: { title: `codex-review ${conclusion} · ${row.head_sha.slice(0, 12)}`, summary: sanitize(summary, { secrets: this.secrets }) } });
  }
  async draft(pr, head_sha, guard = async () => {}) {
    const identity = { id: `draft:${pr}:${head_sha}`, head_sha };
    if (await this.findCheck(identity, guard)) return;
    try {
      await this.guarded(guard, () => this.github.request('POST', `/repos/${this.github.repo}/check-runs`, {
        name: 'codex-review', head_sha, external_id: identity.id, status: 'completed', conclusion: this.draftConclusion,
        completed_at: new Date(this.now()).toISOString(), output: {
          title: `codex-review skipped · draft · ${head_sha.slice(0, 12)}`, summary: 'Re-run this check to review the draft.' } }, guard));
    } catch (error) {
      if (githubRequestNotDispatched(error, 'POST', `/repos/${this.github.repo}/check-runs`)) throw error;
      if (error.message === 'publication_cancelled' || !await this.findCheck(identity, guard)) throw error;
    }
  }
  async postReview(review, diff, row, guard = async () => {}) {
    if (!review.result.pass || review.carried_forward_from || (!review.findings.length && !review.priorFindingIds.length)) return;
    const clean = (text) => sanitize(text, { secrets: this.secrets });
    const eligible = rightSideLines(diff);
    const comments = review.findings.filter((finding) => finding.status === 'new' && eligible.get(finding.file)?.has(finding.line)
      && clean(finding.file) === finding.file)
      .map((finding) => ({ path: finding.file, line: finding.line, side: 'RIGHT',
        body: clean(`<!-- codex-review finding ${finding.id} -->\n${finding.severity}: ${finding.title}\n\n${finding.scenario}`) }));
    const output = buildCheckOutput(review, { secrets: this.secrets });
    if (!review.postedReviewId) {
      const marker = `<!-- codex-review review ${review.publication_id ?? row.publication_id ?? row.id} -->`;
      let receipt = await this.findReview(review, marker, guard);
      if (!receipt) {
        try {
          receipt = await this.guarded(guard, () => this.github.request('POST', `/repos/${this.github.repo}/pulls/${review.pr}/reviews`, {
            commit_id: review.head_sha, event: 'COMMENT', body: clean(`${marker}\n${output.summary}\n\n${output.text}`), comments }, guard));
        } catch (error) {
          if (githubRequestNotDispatched(error, 'POST', `/repos/${this.github.repo}/pulls/${review.pr}/reviews`)) throw error;
          if (error.message === 'publication_cancelled') throw error;
          receipt = await this.findReview(review, marker, guard);
          if (!receipt && comments.length && error.github?.status === 422) {
            // GitHub conclusively rejected the anchors. Keep the same exact-head
            // review and finding body, but make only one body-only attempt.
            try {
              receipt = await this.guarded(guard, () => this.github.request('POST', `/repos/${this.github.repo}/pulls/${review.pr}/reviews`, {
                commit_id: review.head_sha, event: 'COMMENT', body: clean(`${marker}\n${output.summary}\n\n${output.text}`) }, guard));
            } catch (fallbackError) {
              if (githubRequestNotDispatched(fallbackError, 'POST', `/repos/${this.github.repo}/pulls/${review.pr}/reviews`)) throw fallbackError;
              if (fallbackError.message === 'publication_cancelled') throw fallbackError;
              receipt = await this.findReview(review, marker, guard);
              if (!receipt) throw fallbackError;
            }
          }
          if (!receipt) throw error;
        }
      }
      review.postedReviewId = receipt.id;
      review.publication_state = 'review_posted';
      if (row.id !== undefined) this.store.update(row.id, { result_json: JSON.stringify(review) });
    }
    if (comments.length) {
      const posted = await this.guarded(guard, () => this.github.paginate(`/repos/${this.github.repo}/pulls/${review.pr}/reviews/${review.postedReviewId}/comments`, null, guard));
      for (const comment of posted) {
        const id = /<!-- codex-review finding (F[1-9]\d*) -->/u.exec(comment.body)?.[1];
        if (id) this.store.run('UPDATE findings SET comment_id=? WHERE pr=? AND finding_id=?', comment.id, review.pr, id);
      }
    }
  }
  async completed(row, review, diff, guard = async () => {}) {
    const conclusion = !review.result.pass ? 'neutral'
      : review.verdict?.decision === 'approve' ? 'success' : review.verdict?.decision === 'block' ? 'failure' : 'neutral';
    review.outcome = conclusion;
    await this.guarded(guard, () => this.postReview(review, diff, row, guard));
    const output = buildCheckOutput(review, { secrets: this.secrets });
    this.#forgetOutput(row);
    await this.guarded(guard, () => this.github.request('PATCH', `/repos/${this.github.repo}/check-runs/${row.check_run_id}`, {
      status: 'completed', conclusion, completed_at: new Date(this.now()).toISOString(), output }, guard));
    this.#recordOutput(this.#outputReceipt(row, review, output));
    review.publication_state = 'check_posted';
    if (row.id !== undefined) this.store.update(row.id, { result_json: JSON.stringify(review) });
    return conclusion;
  }
  #outputReceipt(row, review, output) {
    return [Number(this.github.appId ?? REVIEW_APP_ID), this.github.repo, row.check_run_id,
      String(row.publication_id ?? row.id), row.head_sha ?? review.head_sha,
      createHash('sha256').update(JSON.stringify(output)).digest('hex')];
  }
  #recordOutput(receipt) {
    this.store.run(`INSERT INTO check_output_receipts(app_id,repo,check_run_id,publication_id,head_sha,output_sha256)
      VALUES(?,?,?,?,?,?) ON CONFLICT(app_id,repo,check_run_id) DO UPDATE SET
      publication_id=excluded.publication_id,head_sha=excluded.head_sha,output_sha256=excluded.output_sha256`, ...receipt);
  }
  #forgetOutput(row) {
    this.store.run('DELETE FROM check_output_receipts WHERE app_id=? AND repo=? AND check_run_id=?',
      Number(this.github.appId ?? REVIEW_APP_ID), this.github.repo, row.check_run_id);
  }
  async updateEvidence(row, review) {
    review.outcome = row.conclusion;
    const output = buildCheckOutput(review, { secrets: this.secrets });
    const receipt = this.#outputReceipt(row, review, output);
    // Scheduler serializes publication. This is only an accepted display-output
    // receipt, never review/approval/admission authority or a completion shortcut.
    if (this.store.get(`SELECT 1 FROM check_output_receipts WHERE app_id=? AND repo=? AND check_run_id=?
      AND publication_id=? AND head_sha=? AND output_sha256=?`, ...receipt)) return;
    // A failed response may still mean GitHub accepted the idempotent PATCH.
    // Invalidate the old receipt before sending, not just after a known success.
    this.#forgetOutput(row);
    await this.github.request('PATCH', `/repos/${this.github.repo}/check-runs/${row.check_run_id}`, { output });
    this.#recordOutput(receipt);
  }
}
