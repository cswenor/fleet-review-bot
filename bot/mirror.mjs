import { executeProcess } from './subprocess.mjs';
import { createHash } from 'node:crypto';
import { canCarryForward, fingerprintDiff } from './carry-forward.mjs';
import { mkdir, writeFile, readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { exportWorkspace } from './workspace.mjs';
import { parseSession, classifyRun, matchesReviewRoute } from './transcript.mjs';
import { sanitize } from './evidence.mjs';
import { builderUser } from './approval.mjs';
import { applyDeferrals } from './verdict.mjs';
import { validJob } from './runner.mjs';

async function loadTrustedSource({ git, mainSha, path, reason }) {
  try {
    const content = await git('show', `${mainSha}:${path}`);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const text = bytes.toString('utf8');
    if (!text.trim()) throw new Error('Empty trusted policy');
    return { text, source: `main@${mainSha}`, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch { throw new Error(reason); }
}

async function loadTrustedJson(options) {
  const receipt = await loadTrustedSource(options);
  try {
    const value = JSON.parse(receipt.text);
    if (!options.validate(value)) throw new Error('Invalid trusted configuration');
    return { ...value, source: receipt.source, sha256: receipt.sha256 };
  } catch { throw new Error(options.reason); }
}

export async function loadReviewPolicy({ git, mainSha }) {
  const receipt = await loadTrustedSource({ git, mainSha,
    path: '.github/review-policy.md', reason: 'policy_unavailable' });
  return receipt;
}

export function loadThresholds({ git, mainSha }) {
  return loadTrustedJson({ git, mainSha,
    path: 'bot/verdict-thresholds.json', reason: 'verdict_unavailable',
    validate: (value) => typeof value?.model === 'string' && /^jev-\d+\.\d+\.\d+$/u.test(value.model)
      && value.calibratedModel === value.model
      && ['block', 'approveBlockingMax', 'approveSevereMax', 'priorResolvedMin']
        .every((key) => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1) });
}

export class Mirror {
  constructor({ github, stateRoot = '/state', workRoot = '/work', sessionsRoot = '/sessions', secrets = [],
    reviewModel = 'openai-codex/gpt-6.1-sol', reviewThinking = 'medium',
    executeImpl = executeProcess, timeouts = { fetch: 120000, git: 30000 } }) {
    if (!validJob({ model: reviewModel, thinking: reviewThinking, maxTime: 600 })) throw new Error('Invalid review model or thinking');
    Object.assign(this, { github, stateRoot, workRoot, sessionsRoot, secrets, reviewModel, reviewThinking,
      execute: executeImpl, timeouts });
    this.gitDir = join(stateRoot, 'mirror.git');
    this.chain = Promise.resolve();
  }
  async command(args, { fetch = false, env = {}, signal: parentSignal, encoding = 'utf8' } = {}) {
    const timeout = fetch ? this.timeouts.fetch : this.timeouts.git;
    const signal = parentSignal ? AbortSignal.any([AbortSignal.timeout(timeout), parentSignal]) : AbortSignal.timeout(timeout);
    const offset = Number(env.GIT_CONFIG_COUNT ?? 0);
    try {
      return await this.execute('git', args, { maxBuffer: 16 * 1024 * 1024, encoding,
        timeout, signal, detached: true, killSignal: 'SIGKILL',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env, GIT_CONFIG_COUNT: String(offset + 2),
          [`GIT_CONFIG_KEY_${offset}`]: 'http.lowSpeedLimit', [`GIT_CONFIG_VALUE_${offset}`]: '1000',
          [`GIT_CONFIG_KEY_${offset + 1}`]: 'http.lowSpeedTime', [`GIT_CONFIG_VALUE_${offset + 1}`]: '30' } });
    } catch (error) {
      throw new Error(signal.aborted || error.killed ? 'mirror_timeout' : 'Mirror git command failed');
    }
  }
  async git(...args) {
    return (await this.command([`--git-dir=${this.gitDir}`, ...args],
      { encoding: args[0] === 'show' ? 'buffer' : 'utf8' })).stdout;
  }
  async fetchHead(pr) {
    const token = await this.github.token();
    const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
    await this.command([`--git-dir=${this.gitDir}`, 'fetch', '--prune', 'origin',
      '+refs/heads/main:refs/heads/main', `+refs/pull/${pr}/head:refs/pull/${pr}/head`], {
      fetch: true, env: { GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` },
    });
  }
  async closure(pr) {
    const ids = new Map(pr.findings.filter((finding) => finding.comment_id).map((finding) => [finding.comment_id, finding.id]));
    const replies = [];
    if (ids.size) for (const comment of await this.github.paginate(`/repos/${this.github.repo}/pulls/${pr.number}/comments`)) {
      if (ids.has(comment.in_reply_to_id) && (comment.user?.type !== 'Bot' || builderUser(comment.user))) replies.push({ finding_id: ids.get(comment.in_reply_to_id),
        author: sanitize(comment.user.login, { secrets: this.secrets }), body: sanitize(comment.body, { secrets: this.secrets, limit: 4000 }) });
    }
    if (Number.isFinite(pr.commentsSince)) for (const comment of await this.github.paginate(`/repos/${this.github.repo}/issues/${pr.number}/comments`)) {
      if ((comment.user?.type !== 'Bot' || builderUser(comment.user)) && Date.parse(comment.created_at) > pr.commentsSince) replies.push({ finding_id: null,
        author: sanitize(comment.user.login, { secrets: this.secrets }), body: sanitize(comment.body, { secrets: this.secrets, limit: 4000 }) });
    }
    return replies;
  }
  async policyReceipt(mainSha) {
    const reviewPolicy = await loadReviewPolicy({ git: (...args) => this.git(...args), mainSha });
    const configReceipt = await loadTrustedSource({ git: (...args) => this.git(...args), mainSha,
      path: '.omp/config.yml', reason: 'policy_unavailable' });
    const overlay = await loadTrustedSource({ git: (...args) => this.git(...args), mainSha,
      path: '.omp/unadvised-review.yml', reason: 'policy_unavailable' });
    const config = configReceipt.text;
    const roleBlock = /^modelRoles:\s*\n((?:[ \t].*(?:\n|$))*)/mu.exec(config)?.[1] ?? '';
    const role = /^\s+review:\s*(.+)$/mu.exec(roleBlock)?.[1]?.trim();
    if (!role) throw new Error('policy_unavailable');
    return { revision: mainSha, source: reviewPolicy.source, review_role: role,
      review_policy_path: '.github/review-policy.md', review_policy_sha256: reviewPolicy.sha256,
      review_policy_source: reviewPolicy.source, review_policy_text: reviewPolicy.text,
      review_config_sha256: configReceipt.sha256, review_overlay_sha256: overlay.sha256 };
  }
  async patchFingerprint(baseSha, headSha, signal) {
    const result = await this.command([`--git-dir=${this.gitDir}`, 'diff', '--no-color', '--no-ext-diff', '--no-textconv',
      '--full-index', '--binary', baseSha, headSha], { encoding: 'buffer', signal });
    return fingerprintDiff(result.stdout);
  }
  carry(row, previous) {
    const work = this.chain.then(async () => {
      if (row.base_ref !== 'main' || previous?.base_ref !== 'main' || !previous.result_json) return null;
      const prior = JSON.parse(previous.result_json);
      if (!prior.result?.pass || !['approve', 'block'].includes(prior.verdict?.decision)
        || prior.verdict.reason || !prior.reportText) return null;
      if (!matchesReviewRoute(prior, this.reviewModel, this.reviewThinking)) return null;
      try { await lstat(this.gitDir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      await this.fetchHead(row.pr);
      if ((await this.git('rev-parse', `refs/pull/${row.pr}/head`)).trim() !== row.head_sha) {
        throw new Error('Head superseded during fetch');
      }
      const mainSha = (await this.git('rev-parse', 'main')).trim();
      const signal = AbortSignal.timeout(this.timeouts.git);
      let proven;
      try {
        proven = await canCarryForward({ mainSha, priorHead: previous.head_sha, priorBase: previous.base_sha,
          headSha: row.head_sha, git: async (...args) => (await this.command([`--git-dir=${this.gitDir}`, ...args], { signal })).stdout,
          patchFingerprint: (base, head) => this.patchFingerprint(base, head, signal) });
      } catch (error) {
        // An expired/unavailable old Git object cannot prove reuse; inspect the current head afresh.
        if (error.message !== 'Mirror git command failed') throw error;
        return null;
      }
      if (!proven) return null;
      const policy = await this.policyReceipt(mainSha);
      if (policy.review_policy_sha256 !== prior.policy?.review_policy_sha256) return null;
      if (policy.review_config_sha256 !== prior.policy?.review_config_sha256
        || policy.review_overlay_sha256 !== prior.policy?.review_overlay_sha256) return null;
      const baseSha = (await this.git('merge-base', mainSha, row.head_sha)).trim();
      const commits = (await this.git('log', '--reverse', '--format=%H%x00%s', `${baseSha}..${row.head_sha}`)).trimEnd()
        .split('\n').filter(Boolean).map((line) => { const [sha, subject] = line.split('\0'); return { sha, subject }; });
      const review = { ...prior, head_sha: row.head_sha, base_sha: baseSha, commits, diff: '',
        prior_review: { check_run_id: previous.check_run_id, head_sha: previous.head_sha },
        carried_forward_from: previous.head_sha, source_review_head: prior.source_review_head ?? previous.head_sha,
        carry: { main_sha: mainSha, policy, patch_fingerprint: 'sha256-normalized-hunk-offsets' }, publication_state: 'pending' };
      delete review.postedReviewId;
      delete review.approval;
      delete review.waitingForHuman;
      return review;
    });
    this.chain = work.catch(() => {});
    return work;
  }
  prepare(row, pr, findings, previous, commentsSince) {
    // One mirror fetch/export at a time: main must not change mid-policy receipt.
    const work = this.chain.then(async () => {
      if (row.base_ref !== 'main' || pr.base?.ref !== 'main') throw new Error('Unsupported review target');
      await mkdir(this.stateRoot, { recursive: true });
      try { await lstat(this.gitDir); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await this.command(['init', '--bare', this.gitDir]);
        await this.git('remote', 'add', 'origin', `https://github.com/${this.github.repo}.git`);
      }
      await this.fetchHead(row.pr);
      const fetched = (await this.git('rev-parse', `refs/pull/${row.pr}/head`)).trim();
      if (fetched !== row.head_sha) throw new Error('Head superseded during fetch');
      const baseSha = (await this.git('merge-base', 'main', row.head_sha)).trim();
      const mainSha = (await this.git('rev-parse', 'main')).trim();
      const policy = await this.policyReceipt(mainSha);
      const replies = await this.closure({ number: row.pr, findings, commentsSince });
      const prior = { prior_head_sha: previous?.head_sha ?? null, findings };
      const outDir = join(this.workRoot, row.run_id);
      const exported = await exportWorkspace({ gitDir: this.gitDir, mainRef: mainSha, baseSha,
        headSha: row.head_sha, pr: { repo: this.github.repo, number: row.pr, title: pr.title, body: pr.body ?? '' },
        priorFindings: prior, replies, outDir, reviewPolicy: policy.review_policy_text });
      await writeFile(join(outDir, 'job.json'), JSON.stringify({ model: this.reviewModel, thinking: this.reviewThinking, maxTime: 600 }), { flag: 'wx', mode: 0o644 });
      const metadata = { base_sha: baseSha, commits: exported.commits, priorFindingIds: findings.map((finding) => finding.id),
        prior_review: previous ? { check_run_id: previous.check_run_id, head_sha: previous.head_sha } : null,
        policy, review_route: { model: this.reviewModel, thinking: this.reviewThinking } };
      await writeFile(join(outDir, 'metadata.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o644 });
      return metadata;
    });
    this.chain = work.catch(() => {});
    return work;
  }
  thresholds(mainSha) {
    return loadThresholds({ git: (...args) => this.git(...args), mainSha });
  }
  async result(row, exit) {
    const work = join(this.workRoot, row.run_id);
    const metadata = JSON.parse(await readFile(join(work, 'metadata.json'), 'utf8'));
    const inspection = JSON.parse(await readFile(join(work, 'repo', 'review', 'inspection.json'), 'utf8'));
    const prData = JSON.parse(await readFile(join(work, 'repo', 'review', 'pr.json'), 'utf8'));
    const prior = JSON.parse(await readFile(join(work, 'repo', 'review', 'prior-findings.json'), 'utf8'));
    const directory = join(this.sessionsRoot, row.run_id);
    const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'));
    if (names.length > 1) throw new Error('Multiple reviewer transcripts');
    let text = '';
    let transcript = null;
    if (names.length) {
      const path = join(directory, names[0]);
      if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error('Invalid reviewer transcript');
      text = await readFile(path, 'utf8');
      transcript = { path: `/var/lib/project-alpha-review-bot/sessions/${row.run_id}/${names[0]}`,
        sha256: createHash('sha256').update(text).digest('hex') };
    }
    const session = parseSession(text);
    const prefix = `${work}/repo/`;
    session.toolReads = session.toolReads.map((read) => typeof read.path === 'string' && read.path.startsWith(prefix)
      ? { ...read, path: read.path.slice(prefix.length) } : read);
    const result = classifyRun({ session, stdout: exit.stdoutTail, stderr: exit.stderrTail, exitCode: exit.exitCode,
      signal: exit.signal, headSha: row.head_sha, ...inspection, priorFindingIds: metadata.priorFindingIds,
      reviewModel: this.reviewModel, reviewThinking: this.reviewThinking,
      maxTimeExpired: exit.durationMs >= 600000 && !session.exitKind });
    return { repo: this.github.repo, pr: row.pr, head_sha: row.head_sha, ...metadata, result, transcript,
      prTitle: prData.title, reportText: session.finalText, priorFindings: prior.findings, replies: prior.replies,
      findings: result.pass ? applyDeferrals(session.json.findings, prior.findings, prior.replies) : [],
      suggestions: result.pass ? session.json.suggestions : [], exit,
      diff: await readFile(join(work, 'repo', 'review', 'diff.patch'), 'utf8') };
  }
}
