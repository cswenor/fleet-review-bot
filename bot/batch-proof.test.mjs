import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { confirmBatchTree, readBatchCiProof } from './batch-proof.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const OTHER = 'f'.repeat(40);
const DIGEST = `sha256:${'e'.repeat(64)}`;
const REPOSITORY = 'owner/repo';
const RECEIPT = { run_id: 42, attempt: 2, tree_sha: TREE, artifact_id: 99, image_digest: DIGEST };

function archive(tree, digest) {
  return execFileSync('python3', ['-c', [
    'import io, sys, zipfile',
    'data = io.BytesIO()',
    'with zipfile.ZipFile(data, "w") as archive:',
    '    archive.writestr("tree.txt", sys.argv[1] + "\\n")',
    '    if len(sys.argv) > 2: archive.writestr("image.digest", sys.argv[2] + "\\n")',
    'sys.stdout.buffer.write(data.getvalue())',
  ].join('\n'), tree, ...(digest === null ? [] : [digest])]);
}

function fixture() {
  const run = { id: 42, run_attempt: 2, event: 'pull_request', head_sha: HEAD, name: 'CI',
    workflow_id: 7, path: '.github/workflows/ci.yml', repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY }, status: 'completed', conclusion: 'success' };
  const state = {
    runs: [run], legacyRuns: [], artifactId: 99, artifactAttempt: 2, archiveTree: TREE, imageDigest: DIGEST,
    mergeTree: TREE, parents: [BASE, HEAD], pullHead: HEAD, pullNumber: 123, missingAssociation: false,
    pullState: 'closed', pullNode: 'PR_123', nativeMerge: MERGE, afterDownload: null, ciApp: 'github-actions',
  };
  const downloads = [];
  const batch = { head_sha: HEAD, tree_sha: TREE, target_pr: 123, ci: { ...RECEIPT } };
  const commit = () => ({ sha: MERGE, commit: { tree: { sha: state.mergeTree } },
    parents: state.parents.map((sha) => ({ sha })) });
  const artifacts = () => [{ id: state.artifactId, name: `ci-tested-tree-${state.artifactAttempt}`,
    size_in_bytes: 200, expired: false }];
  const suiteId = (run) => run.id + 1000;
  const app = { id: 15368, slug: 'github-actions' };
  const directRun = (id) => {
    const value = state.runs.find((candidate) => candidate.id === Number(id));
    if (!value) throw new Error(`Unexpected fixture run: ${id}`);
    return { ...value, check_suite_id: suiteId(value),
      html_url: `https://github.com/${REPOSITORY}/actions/runs/${value.id}` };
  };
  const rows = (input) => {
    const url = new URL(input, 'https://api.github.com');
    const path = url.pathname.replace(`/repos/${REPOSITORY}/`, '');
    if (path === 'actions/workflows/ci.yml/runs' || path === 'actions/runs') {
      if (state.legacyRuns instanceof Error) throw state.legacyRuns;
      return state.legacyRuns;
    }
    if (/^commits\/[a-f0-9]{40}\/check-suites$/u.test(path)) {
      const head = path.split('/')[1];
      return state.runs.filter((candidate) => candidate.head_sha === head).map((candidate) => ({
        id: suiteId(candidate), head_sha: candidate.head_sha, app: { ...app, slug: state.ciApp }, repository: { full_name: REPOSITORY },
      }));
    }
    const suite = /^check-suites\/(\d+)\/check-runs$/u.exec(path);
    if (suite) return state.runs.filter((candidate) => suiteId(candidate) === Number(suite[1])).map((candidate) => ({
      id: candidate.id + 2000, head_sha: candidate.head_sha, app, check_suite: { id: suiteId(candidate) },
      details_url: `https://github.com/${REPOSITORY}/actions/runs/${candidate.id}/job/${candidate.id + 2000}`,
    }));
    if (/^actions\/runs\/\d+\/artifacts$/u.test(path)) return artifacts();
    if (path === `commits/${MERGE}/pulls`) return state.missingAssociation ? [] : [{
      number: state.pullNumber, merged_at: '2026-10-18T00:00:00Z', merge_commit_sha: MERGE,
      base: { ref: 'main', repo: { full_name: REPOSITORY } },
      head: { sha: state.pullHead, repo: { full_name: REPOSITORY } },
    }];
    throw new Error(`Unexpected fixture list: ${input}`);
  };
  const github = {
    repo: REPOSITORY,
    token: async () => 'dummy-ci-token',
    paginate: async (path) => rows(path),
    request: async (method, path) => {
      assert.equal(method, 'GET');
      const run = new RegExp(`^/repos/${REPOSITORY}/actions/runs/(\\d+)$`, 'u').exec(path);
      if (run) return directRun(run[1]);
      if (path === `/repos/${REPOSITORY}/pulls/123`) return { number: state.pullNumber, node_id: state.pullNode,
        state: state.pullState, merged: true, head: { sha: state.pullHead, repo: { full_name: REPOSITORY } },
        base: { ref: 'main', repo: { full_name: REPOSITORY } } };
      assert.equal(path, `/repos/${REPOSITORY}/commits/${MERGE}`);
      return commit();
    },
    graphql: async () => ({ repository: { pullRequest: { id: state.pullNode, merged: true,
      headRefOid: state.pullHead, baseRefName: 'main', mergeCommit: { oid: state.nativeMerge } } } }),
    fetch: async (input, options = {}) => {
      const url = new URL(input);
      if (url.origin === 'https://archives.example') {
        downloads.push(options);
        state.afterDownload?.();
        return new Response(archive(state.archiveTree, state.imageDigest));
      }
      assert.equal(options.headers.Authorization, 'Bearer dummy-ci-token');
      const path = url.pathname.replace(`/repos/${REPOSITORY}/`, '');
      if (/^actions\/artifacts\/\d+\/zip$/u.test(path)) {
        return new Response(null, { status: 302, headers: { location: 'https://archives.example/tree.zip' } });
      }
      if (path === `commits/${MERGE}`) return Response.json(commit());
      const run = /^actions\/runs\/(\d+)$/u.exec(path);
      if (run) return Response.json(directRun(run[1]));
      const values = rows(url);
      return Response.json(path.endsWith('/artifacts') ? { artifacts: values }
        : path.endsWith('/check-suites') ? { check_suites: values }
          : path.endsWith('/check-runs') ? { check_runs: values }
            : path.endsWith('/runs') ? { workflow_runs: values } : values);
    },
  };
  return { state, batch, github, downloads, run };
}

test('batch receipt authenticates exact CI despite an empty legacy run list and strips token at archive redirect', async () => {
  const f = fixture();
  const result = await readBatchCiProof(f);
  assert.equal(result.state, 'green');
  assert.deepEqual(result.receipt, RECEIPT);
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].headers, undefined);
  assert.equal(f.downloads[0].redirect, 'error');
});

test('latest queued then failed canonical CI wins despite a flaky legacy list and newer unrelated runs', async () => {
  const f = fixture();
  f.state.legacyRuns = new Error('legacy workflow-runs index unavailable');
  f.state.runs = [
    { ...f.run, id: 900, head_repository: { full_name: 'attacker/repo' } },
    { ...f.run, id: 42 },
    { ...f.run, id: 901, event: 'push' },
    { ...f.run, id: 43, status: 'queued', conclusion: null },
    { ...f.run, id: 902, head_sha: OTHER },
    { ...f.run, id: 903, path: '.github/workflows/other.yml' },
    { ...f.run, id: 904, repository: { full_name: 'attacker/repo' } },
  ];
  assert.equal((await readBatchCiProof(f)).state, 'waiting');
  assert.equal(f.downloads.length, 0);
  f.state.runs.find((run) => run.id === 43).status = 'completed';
  f.state.runs.find((run) => run.id === 43).conclusion = 'failure';
  assert.equal((await readBatchCiProof(f)).state, 'red');
  assert.equal(f.downloads.length, 0);
});

test('batch proof cannot authorize or download artifacts from foreign-only CI', async () => {
  const f = fixture();
  f.state.runs = [{ ...f.run, head_repository: { full_name: 'attacker/repo' } }];
  assert.deepEqual(await readBatchCiProof(f), { state: 'waiting', run: null });
  assert.equal(f.downloads.length, 0);
});

for (const [name, mutate] of [
  ['different tested tree', (f) => { f.state.archiveTree = OTHER; }],
  ['artifact from previous attempt', (f) => { f.state.artifactAttempt = 1; }],
  ['rerun after receipt capture', (f) => { f.run.run_attempt = 3; f.state.artifactAttempt = 3; }],
  ['different canonical run', (f) => { f.run.id = 43; }],
  ['replacement artifact', (f) => { f.state.artifactId = 100; }],
  ['different immutable image', (f) => { f.state.imageDigest = `sha256:${'1'.repeat(64)}`; }],
  ['missing immutable image', (f) => { f.state.imageDigest = null; }],
]) {
  test(`sealed batch rejects ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(readBatchCiProof({ ...f, expected: RECEIPT }));
  });
}

test('normally merged carrier confirms deployment only from the recorded CI identity', async () => {
  const f = fixture();
  assert.deepEqual(await confirmBatchTree({ ...f, mergedSha: MERGE }), {
    merge_sha: MERGE, tree_sha: TREE, run_id: 42, image_digest: DIGEST, carrier_pr: 123,
  });
});

test('latest canonical successful run supplies the receipt, not list order or an older success', async () => {
  const f = fixture();
  f.state.runs = [{ ...f.run, id: 41 }, { ...f.run, id: 44 }, f.run];
  const result = await readBatchCiProof(f);
  assert.equal(result.state, 'green');
  assert.deepEqual(result.receipt, { ...RECEIPT, run_id: 44 });
});

for (const [name, mutate] of [
  ['carrier PR association', (f) => { f.state.pullNumber = 124; }],
  ['carrier head association', (f) => { f.state.pullHead = OTHER; f.state.parents = [BASE, OTHER]; f.run.head_sha = OTHER; }],
  ['CI run association', (f) => { f.run.id = 43; }],
  ['CI attempt', (f) => { f.run.run_attempt = 3; f.state.artifactAttempt = 3; }],
  ['artifact identity', (f) => { f.state.artifactId = 100; }],
  ['image digest', (f) => { f.state.imageDigest = `sha256:${'1'.repeat(64)}`; }],
  ['selected merge tree', (f) => { f.state.mergeTree = OTHER; }],
]) {
  test(`post-merge confirmation rejects drift in ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(confirmBatchTree({ ...f, mergedSha: MERGE }));
  });
}

test('indirect original association cannot confirm carrier even with equal tested tree', async () => {
  const f = fixture();
  f.state.pullHead = OTHER;
  f.run.head_sha = OTHER;
  assert.equal(await confirmBatchTree({ ...f, mergedSha: MERGE }), null);
  assert.equal(f.downloads.length, 0);
});

function recordedMergeFixture() {
  const f = fixture();
  Object.assign(f.batch, { kind: 'single', target_node_id: 'PR_123', merged_sha: MERGE,
    operations: [{ intent: { kind: 'merge', head_sha: HEAD, target_pr: 123 },
      receipt: { outcome: 'merged', merge_sha: MERGE, tree_sha: TREE } }] });
  f.state.missingAssociation = true;
  return f;
}

test('own recorded single merge publishes exact artifact despite a permanently empty commit PR index', async () => {
  const f = recordedMergeFixture();
  assert.deepEqual(await confirmBatchTree({ ...f, mergedSha: MERGE }), {
    merge_sha: MERGE, tree_sha: TREE, run_id: 42, image_digest: DIGEST, carrier_pr: 123,
  });
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].headers, undefined);
});

for (const [name, mutate, absent = false] of [
  ['no own receipt', (f) => { f.batch.operations = []; }, true],
  ['carrier not original single', (f) => { f.batch.kind = 'batch'; }, true],
  ['different receipt merge', (f) => { f.batch.operations[0].receipt.merge_sha = OTHER; }, true],
  ['different native PR', (f) => { f.state.pullNumber = 124; }],
  ['different native node', (f) => { f.state.pullNode = 'PR_other'; }],
  ['still open original', (f) => { f.state.pullState = 'open'; }],
  ['different native head', (f) => { f.state.pullHead = OTHER; }],
  ['different native merge', (f) => { f.state.nativeMerge = OTHER; }],
  ['missing merge parent', (f) => { f.state.parents = [BASE, OTHER]; }],
  ['replacement artifact', (f) => { f.state.artifactId = 100; }],
  ['different tree artifact', (f) => { f.state.archiveTree = OTHER; }],
  ['different image', (f) => { f.state.imageDigest = `sha256:${'1'.repeat(64)}`; }],
  ['different attempt', (f) => { f.run.run_attempt = 3; f.state.artifactAttempt = 3; }],
  ['foreign CI', (f) => { f.run.repository.full_name = 'attacker/repo'; }, true],
  ['rerun during artifact read', (f) => { f.state.afterDownload = () => { f.run.run_attempt++; }; }],
  ['native drift during artifact read', (f) => { f.state.afterDownload = () => { f.state.nativeMerge = OTHER; }; }],
  ['non-Actions CI App', (f) => { f.state.ciApp = 'other-app'; }, true],
]) {
  test(`recorded single proof refuses ${name}`, async () => {
    const f = recordedMergeFixture();
    mutate(f);
    if (absent) assert.equal(await confirmBatchTree({ ...f, mergedSha: MERGE }), null);
    else await assert.rejects(confirmBatchTree({ ...f, mergedSha: MERGE }));
  });
}
