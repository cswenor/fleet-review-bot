import { mkdir, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { executeProcess } from './subprocess.mjs';
import { sanitize } from './evidence.mjs';
import { BUILDER_BOT, REPOSITORY } from './identity.mjs';
import { carrierBranch } from './batch-author.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const ID = /^[a-z0-9-]{1,100}$/u;
const FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
  '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true',
  '-c', 'commit.gpgSign=false', '-c', 'http.followRedirects=false'];

// Bare, trusted scratch: merge-tree uses Git's normal merge machinery and
// commit-tree preserves both parents. Never checkout or execute PR content.
export class BatchMirror {
  constructor({ author, root = '/state/batches', repo = REPOSITORY, executeImpl = executeProcess }) {
    if (repo !== REPOSITORY) throw new Error('batch_repository_mismatch');
    Object.assign(this, { author, root: resolve(root), repo, execute: executeImpl });
  }

  directory(batch) {
    if (!ID.test(batch.id ?? '') || !Number.isSafeInteger(batch.generation) || batch.generation < 1) throw new Error('batch_identity_invalid');
    return join(this.root, `${batch.id}-${batch.generation}.git`);
  }

  async context(batch) {
    const credentials = await this.author.credentials();
    if (credentials.identity?.user?.id !== BUILDER_BOT.id || credentials.identity.user.login !== BUILDER_BOT.login
      || credentials.identity.repository !== this.repo || typeof credentials.token !== 'string' || !credentials.token) {
      throw new Error('batch_builder_identity_missing');
    }
    const directory = this.directory(batch);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { if ((await lstat(directory)).isSymbolicLink()) throw new Error('batch_scratch_symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const auth = Buffer.from(`x-access-token:${credentials.token}`).toString('base64');
    const date = `@${Math.floor(batch.selected_at / 1000)} +0000`;
    if (!Number.isSafeInteger(batch.selected_at) || batch.selected_at < 0) throw new Error('batch_timestamp_invalid');
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: this.root,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
      GIT_AUTHOR_NAME: BUILDER_BOT.login, GIT_COMMITTER_NAME: BUILDER_BOT.login,
      GIT_AUTHOR_EMAIL: `${BUILDER_BOT.id}+${BUILDER_BOT.login}@users.noreply.github.com`,
      GIT_COMMITTER_EMAIL: `${BUILDER_BOT.id}+${BUILDER_BOT.login}@users.noreply.github.com`,
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const context = { directory, env, secrets: [credentials.token, auth] };
    await this.command(context, ['init', '--bare', directory]);
    return context;
  }

  async command(context, args, { fetch = false, allow = [0], input } = {}) {
    try {
      const result = await this.execute('git', [...FLAGS, ...args], { env: context.env, input,
        timeout: fetch ? 120000 : 30000, maxBuffer: 16 * 1024 * 1024 });
      return { ...result, exitCode: 0 };
    } catch (error) {
      if (Number.isInteger(error.exitCode) && allow.includes(error.exitCode)) return {
        stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.exitCode,
      };
      const clean = sanitize(error.stderr ?? error.message, { secrets: context.secrets, limit: 1000 });
      throw Object.assign(new Error(`batch_git_failed:${args.find((arg) => !arg.startsWith('-')) ?? 'git'}:${clean}`),
        { exitCode: error.exitCode, code: error.code,
          knownRejected: args.includes('push') && /requested URL returned error: (?:401|403|404|422)/u.test(error.stderr ?? '') });
    }
  }

  git(context, args, options) { return this.command(context, [`--git-dir=${context.directory}`, ...args], options); }

  async fetch(context, heads) {
    if (heads.some((head) => !SHA.test(head))) throw new Error('batch_head_invalid');
    const missing = [];
    for (const head of new Set(heads)) {
      const local = await this.git(context, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`], { allow: [0, 1] });
      if (local.exitCode !== 0) missing.push(head);
    }
    for (let index = 0; index < missing.length; index += 50) {
      await this.git(context, ['fetch', '--no-tags', '--no-write-fetch-head', '--filter=blob:none',
        `https://github.com/${this.repo}.git`, ...missing.slice(index, index + 50)], { fetch: true });
    }
  }

  async ancestor(context, head, descendant) {
    if (!SHA.test(head) || !SHA.test(descendant)) throw new Error('batch_head_invalid');
    const result = await this.git(context, ['merge-base', '--is-ancestor', head, descendant], { allow: [0, 1] });
    return result.exitCode === 0;
  }

  async dependencies(batch, ready, open) {
    const context = await this.context(batch);
    await this.fetch(context, [batch.base_sha, ...ready.map((member) => member.head_sha), ...open.map((pr) => pr.head_sha)]);
    const dependencies = new Map(ready.map((member) => [member.pr, []]));
    for (const pr of open) {
      if (await this.ancestor(context, pr.head_sha, batch.base_sha)) continue;
      for (const member of ready) {
        if (pr.pr !== member.pr && await this.ancestor(context, pr.head_sha, member.head_sha)) {
          dependencies.get(member.pr).push({ pr: pr.pr, head_sha: pr.head_sha });
        }
      }
    }
    return dependencies;
  }

  async assemble(batch) {
    const context = await this.context(batch);
    await this.fetch(context, [batch.base_sha, ...batch.members.map((member) => member.head_sha)]);
    let head = batch.base_sha;
    const accepted = [];
    const conflicts = [];
    for (const member of batch.members) {
      if (!await this.ancestor(context, member.head_sha, head)) {
        const merge = await this.git(context, ['merge-tree', '--write-tree', '--name-only', '--no-messages', head, member.head_sha], { allow: [0, 1] });
        const [tree, ...paths] = merge.stdout.trimEnd().split('\n');
        if (!SHA.test(tree)) throw new Error('batch_merge_tree_receipt_invalid');
        if (merge.exitCode === 1) {
          conflicts.push({ pr: member.pr, head_sha: member.head_sha,
            paths: paths.filter(Boolean).map((path) => sanitize(path, { secrets: context.secrets, limit: 4096 })) });
          continue;
        }
        const message = `Project Alpha batch ${batch.id}/${batch.generation}: merge PR #${member.pr} at ${member.head_sha}`;
        head = (await this.git(context, ['commit-tree', tree, '-p', head, '-p', member.head_sha, '-m', message])).stdout.trim();
        if (!SHA.test(head)) throw new Error('batch_merge_commit_receipt_invalid');
      }
      accepted.push(member);
    }
    const tree = (await this.git(context, ['rev-parse', `${head}^{tree}`])).stdout.trim();
    if (!SHA.test(tree)) throw new Error('batch_tree_receipt_invalid');
    return { head_sha: head, tree_sha: tree, accepted, conflicts };
  }

  async ancestry(batch, open, descendant = batch.head_sha) {
    const context = await this.context(batch);
    await this.fetch(context, [batch.base_sha, descendant, ...open.map((pr) => pr.head_sha)]);
    const baseAncestors = new Set();
    const combinedAncestors = new Set();
    for (const pr of open) {
      if (await this.ancestor(context, pr.head_sha, batch.base_sha)) baseAncestors.add(pr.pr);
      if (await this.ancestor(context, pr.head_sha, descendant)) combinedAncestors.add(pr.pr);
    }
    return { baseAncestors, combinedAncestors };
  }

  async publish(batch, guard, recordIntent) {
    if (!batch.sealed || batch.carrier_branch !== carrierBranch(batch) || !SHA.test(batch.head_sha)) throw new Error('batch_not_sealed');
    const context = await this.context(batch);
    await guard();
    await recordIntent();
    const ref = `refs/heads/${batch.carrier_branch}`;
    // An EMPTY expected lease is create-only CAS: it can NEVER update an
    // existing different ref, even by fast-forward. No main push/force update.
    const result = await this.git(context, ['push', '--porcelain', `--force-with-lease=${ref}:`,
      `https://github.com/${this.repo}.git`, `${batch.head_sha}:${ref}`], { fetch: true, allow: [0, 1] });
    if (result.exitCode !== 0) {
      const rejected = result.stdout.split('\n').some((line) => line.startsWith('!\t')
        && line.split('\t')[1]?.endsWith(`:${ref}`) && /\[(?:rejected|remote rejected)\]/u.test(line));
      const clean = sanitize(result.stderr || result.stdout, { secrets: context.secrets, limit: 1000 });
      throw Object.assign(new Error(`batch_branch_publish_failed:${clean}`), { knownRejected: rejected });
    }
    return { head_sha: batch.head_sha, branch: batch.carrier_branch };
  }

  async discard(batch) {
    if (batch.mutation) throw new Error('batch_mutation_unresolved');
    await rm(this.directory(batch), { recursive: true, force: true });
  }
}
