import { readTestedTreeArtifact, findTestedTree, findCommitWorkflowRuns } from '../scripts/ci-tested-tree.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const integer = (value) => Number.isSafeInteger(value) && value > 0;

export async function readBatchCiProof({ github, batch, expected = null, guard = async () => {} }) {
  if (!SHA.test(batch.head_sha) || !SHA.test(batch.tree_sha)) throw new Error('batch_tree_identity_missing');
  const runs = await findCommitWorkflowRuns({ sha: batch.head_sha, repository: github.repo,
    workflowPath: '.github/workflows/ci.yml', event: 'pull_request', guard,
    get: (path) => github.request('GET', `/repos/${github.repo}/${path}`, undefined, () => guard()),
    list: (path, key) => github.paginate(`/repos/${github.repo}/${path}`, key, () => guard()) });
  await guard();
  const run = runs.filter((run) => run.event === 'pull_request' && run.head_sha === batch.head_sha
    && run.head_repository?.full_name === github.repo).sort((left, right) => right.id - left.id)[0];
  if (!run || run.status !== 'completed') return { state: 'waiting', run: run ?? null };
  if (run.conclusion !== 'success') return { state: 'red', run };
  const attempt = run.run_attempt ?? 1;
  if (!integer(run.id) || !integer(attempt)) throw new Error('batch_ci_identity_invalid');
  if (expected && (expected.run_id !== run.id || expected.attempt !== attempt)) throw new Error('batch_ci_identity_changed');
  const artifacts = await github.paginate(`/repos/${github.repo}/actions/runs/${run.id}/artifacts`, 'artifacts', () => guard());
  await guard();
  const matches = artifacts.filter((artifact) => artifact.name === `ci-tested-tree-${attempt}` && !artifact.expired);
  if (matches.length !== 1 || !integer(matches[0].id)) throw new Error('batch_ci_artifact_missing_or_ambiguous');
  const token = await github.token();
  await guard();
  const proof = await readTestedTreeArtifact({ artifact: matches[0], repository: github.repo, token,
    fetchImpl: async (url, options) => {
      await guard();
      const response = await github.fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      await guard();
      return response;
    } });
  await guard();
  if (proof.tree !== batch.tree_sha) throw new Error('batch_ci_tree_mismatch');
  if (expected && (expected.tree_sha !== proof.tree || expected.artifact_id !== matches[0].id
    || expected.image_digest !== (proof.imageDigest ?? null))) throw new Error('batch_ci_proof_changed');
  return { state: 'green', run, receipt: { run_id: run.id, attempt, tree_sha: proof.tree,
    artifact_id: matches[0].id, image_digest: proof.imageDigest ?? null } };
}

// The lane's durable native merge receipt replaces only the eventually-consistent
// commit-to-PR index. CI discovery and the artifact parser remain authoritative.
async function recordedSingleProof({ github, batch, mergedSha, commit, guard }) {
  if (batch.kind !== 'single' || batch.merged_sha !== mergedSha || !batch.operations?.some(({ intent, receipt }) =>
    intent.kind === 'merge' && intent.head_sha === batch.head_sha && intent.target_pr === batch.target_pr
    && receipt.outcome === 'merged' && receipt.merge_sha === mergedSha && receipt.tree_sha === batch.tree_sha)) return null;
  async function nativeIdentity() {
    const pull = await github.request('GET', `/repos/${github.repo}/pulls/${batch.target_pr}`, undefined, () => guard());
    await guard();
    if (pull.number !== batch.target_pr || pull.node_id !== batch.target_node_id || pull.state !== 'closed'
      || pull.merged !== true || pull.head?.sha !== batch.head_sha || pull.base?.ref !== 'main'
      || pull.head?.repo?.full_name !== github.repo || pull.base?.repo?.full_name !== github.repo
      || !commit.parents?.some((parent) => parent.sha === batch.head_sha)) throw new Error('batch_merged_identity_mismatch');
    // The pinned REST API omits merge_commit_sha; use the same native identity
    // fence that wrote the lane's merge receipt.
    const [owner, name] = github.repo.split('/');
    const response = await github.graphql(`query MergeBatchProofReceipt($owner:String!,$name:String!,$number:Int!) {
      repository(owner:$owner,name:$name) { pullRequest(number:$number) {
        id merged headRefOid baseRefName mergeCommit { oid }
      } }
    }`, { owner, name, number: batch.target_pr }, () => guard());
    await guard();
    const native = response?.repository?.pullRequest;
    if (native?.id !== batch.target_node_id || native?.merged !== true || native?.headRefOid !== batch.head_sha
      || native?.baseRefName !== 'main' || native?.mergeCommit?.oid !== mergedSha) throw new Error('batch_merged_identity_mismatch');
  }
  await nativeIdentity();
  const tested = await readBatchCiProof({ github, batch, expected: batch.ci, guard });
  if (tested.state !== 'green') return null;
  // Do not accept an artifact from an attempt superseded while downloading.
  const current = await github.request('GET', `/repos/${github.repo}/actions/runs/${batch.ci.run_id}`, undefined, () => guard());
  await guard();
  if (current.id !== tested.run.id || current.run_attempt !== tested.run.run_attempt
    || current.head_sha !== batch.head_sha || current.event !== 'pull_request'
    || current.path !== '.github/workflows/ci.yml' || current.repository?.full_name !== github.repo
    || current.head_repository?.full_name !== github.repo || current.workflow_id !== tested.run.workflow_id
    || current.check_suite_id !== tested.run.check_suite_id
    || current.status !== 'completed' || current.conclusion !== 'success') throw new Error('batch_ci_identity_changed');
  await nativeIdentity();
  return { matched: true, source: 'pull_request', pr_number: batch.target_pr, tested_head_sha: batch.head_sha,
    tree_sha: tested.receipt.tree_sha, run_id: tested.receipt.run_id, run_attempt: tested.receipt.attempt,
    artifact_id: tested.receipt.artifact_id, image_digest: tested.receipt.image_digest };
}

export async function confirmBatchTree({ github, batch, mergedSha, guard = async () => {} }) {
  if (!SHA.test(mergedSha) || !batch.ci) throw new Error('batch_merged_proof_missing');
  const commit = await github.request('GET', `/repos/${github.repo}/commits/${mergedSha}`, undefined, () => guard());
  await guard();
  if (commit.sha !== mergedSha || commit.commit?.tree?.sha !== batch.tree_sha) throw new Error('batch_merged_tree_mismatch');
  const token = await github.token();
  let proof = await findTestedTree({ sha: mergedSha, repository: github.repo, token,
    fetchImpl: async (url, options) => {
      await guard();
      const response = await github.fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      await guard();
      return response;
    } });
  await guard();
  if (!proof.matched) proof = await recordedSingleProof({ github, batch, mergedSha, commit, guard });
  if (!proof) return null; // Native merge/CI association can arrive later.
  if (proof.source !== 'pull_request' || proof.pr_number !== batch.target_pr
    || proof.tested_head_sha !== batch.head_sha || proof.tree_sha !== batch.tree_sha
    || proof.run_id !== batch.ci.run_id || proof.run_attempt !== batch.ci.attempt
    || proof.artifact_id !== batch.ci.artifact_id || (proof.image_digest ?? null) !== batch.ci.image_digest) {
    throw new Error('batch_deploy_proof_mismatch');
  }
  return { merge_sha: mergedSha, tree_sha: batch.tree_sha, run_id: proof.run_id,
    image_digest: proof.image_digest ?? null, carrier_pr: batch.target_pr };
}
