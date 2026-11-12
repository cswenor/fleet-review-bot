#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_ARCHIVE_BYTES = 1024 * 1024;

// Shared by pre-merge carrier fences and the existing post-merge deploy lookup.
// The allowlist/size bounds are one contract, not separate bot/deploy parsers.
export async function readTestedTreeArtifact({
  artifact,
  repository,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
    throw new Error("Repository and GitHub token are required");
  const root = `${apiUrl.replace(/\/$/, "")}/repos/${repository}/`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (!Number.isSafeInteger(artifact.id) || artifact.size_in_bytes > MAX_ARCHIVE_BYTES)
    throw new Error("Invalid CI tree artifact");
  let response = await fetchImpl(`${root}actions/artifacts/${artifact.id}/zip`, {
    headers,
    redirect: "manual",
  });
  if (response.status === 302) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Missing artifact download location");
    const url = new URL(location);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      (apiUrl.startsWith("https:") && url.protocol !== "https:")
    )
      throw new Error("Invalid artifact download protocol");
    response = await fetchImpl(url, { redirect: "error" });
  }
  if (!response.ok) throw new Error(`CI artifact download failed (${response.status})`);
  if (Number(response.headers.get("content-length")) > MAX_ARCHIVE_BYTES)
    throw new Error("CI artifact exceeds its size bound");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("CI artifact exceeds its size bound");
  const directory = await mkdtemp(join(tmpdir(), "project-alpha-ci-tree-"));
  try {
    const file = join(directory, "tree.zip");
    await writeFile(file, bytes, { mode: 0o600 });
    const value = execFileSync(
      "python3",
      [
        "-c",
        [
          "import json, sys, zipfile",
          "with zipfile.ZipFile(sys.argv[1]) as archive:",
          "    files = [entry for entry in archive.infolist() if not entry.is_dir()]",
          "    names = {entry.filename for entry in files}",
          '    if len(files) != len(names) or names not in ({"tree.txt"}, {"tree.txt", "image.digest"}) or any(entry.file_size > 128 for entry in files):',
          '        raise ValueError("invalid CI tree archive")',
          '    print(json.dumps({entry.filename: archive.read(entry).decode("utf-8").strip() for entry in files}))',
        ].join("\n"),
        file,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const proof = JSON.parse(value);
    if (!SHA.test(proof["tree.txt"])) throw new Error("Invalid tested tree OID");
    if ("image.digest" in proof && !DIGEST.test(proof["image.digest"]))
      throw new Error("Invalid tested image digest");
    return { tree: proof["tree.txt"], imageDigest: proof["image.digest"] };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Run-list filters can hide existing runs. Commit-scoped GitHub Actions checks
// locate candidates; direct run responses remain the authority for every field.
export async function findCommitWorkflowRuns({
  sha,
  repository,
  workflowPath,
  event,
  get,
  list,
  guard = async () => {},
  requireComplete = false,
}) {
  const events = Array.isArray(event) ? event : [event];
  if (
    !SHA.test(sha) ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflowPath) ||
    (!events.length || events.some((value) => !["pull_request", "push", "workflow_dispatch"].includes(value)))
  )
    throw new Error("Invalid exact-commit workflow lookup");
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const incomplete = () => {
    if (requireComplete) throw new Error("Incomplete or ambiguous commit workflow authority");
    return [];
  };
  async function read(operation) {
    await guard();
    const value = await operation();
    await guard();
    return value;
  }
  const suites = await read(() => list(`commits/${sha}/check-suites`, "check_suites"));
  if (!Array.isArray(suites)) throw new Error("Invalid commit check-suite response");
  const candidates = new Map();
  for (const suite of suites) {
    if (suite.app?.slug !== "github-actions" || suite.head_sha !== sha) continue;
    if (!positive(suite.id)) throw new Error("Invalid GitHub Actions check-suite identity");
    const checks = await read(() =>
      list(`check-suites/${suite.id}/check-runs?filter=all`, "check_runs"),
    );
    if (!Array.isArray(checks)) throw new Error("Invalid check-run response");
    const ids = new Set();
    for (const check of checks) {
      if (
        check.app?.slug !== "github-actions" ||
        check.head_sha !== sha ||
        check.check_suite?.id !== suite.id
      )
        continue;
      let url;
      try {
        url = new URL(check.details_url);
      } catch {
        return incomplete();
      }
      const prefix = `/${repository}/actions/runs/`;
      const match = url.pathname.startsWith(prefix)
        ? url.pathname.slice(prefix.length).match(/^([1-9]\d*)(?:\/job\/[1-9]\d*|\/attempts\/[1-9]\d*)?\/?$/)
        : null;
      if (
        url.origin !== "https://github.com" ||
        url.username ||
        url.password ||
        !match ||
        !positive(Number(match[1]))
      )
        return incomplete();
      ids.add(Number(match[1]));
    }
    // A cancelled workflow can have a suite before any check run was created.
    // Resolve its run identity before deciding whether its workflow is relevant.
    if (checks.length === 0) {
      const indexed = await read(() =>
        list(`actions/runs?check_suite_id=${suite.id}`, "workflow_runs"),
      );
      if (!Array.isArray(indexed)) throw new Error("Invalid suite workflow-run response");
      for (const run of indexed) {
        if (run?.check_suite_id !== suite.id) continue;
        if (!positive(run.id)) return incomplete();
        ids.add(run.id);
      }
    }
    // Unknown or mixed identities still cannot expose an older green.
    if (ids.size !== 1) return incomplete();
    const id = [...ids][0];
    const previous = candidates.get(id);
    if (previous && previous.suiteId !== suite.id) return incomplete();
    candidates.set(id, { suiteId: suite.id, empty: checks.length === 0 || previous?.empty === true });
  }
  const runs = [];
  for (const [id, { suiteId, empty }] of candidates) {
    const run = await read(() => get(`actions/runs/${id}`));
    if (
      run.id !== id ||
      run.check_suite_id !== suiteId ||
      !positive(run.workflow_id) ||
      !positive(run.run_attempt) ||
      (empty && (
        run.head_sha !== sha ||
        run.repository?.full_name !== repository ||
        run.head_repository?.full_name !== repository ||
        typeof run.path !== "string" || !run.path ||
        typeof run.event !== "string" || !run.event
      ))
    )
      return incomplete();
    if (
      run.head_sha === sha &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      run.path === workflowPath &&
      events.includes(run.event)
    )
      runs.push(run);
  }
  return runs.sort((left, right) => right.id - left.id);
}

export async function findReviewBotImage({ sha, ancestors, repository, get, list }) {
  if (!SHA.test(sha) || !Array.isArray(ancestors) || ancestors[0] !== sha
    || ancestors.some((ancestor) => !SHA.test(ancestor)))
    throw new Error("Invalid dispatched main ancestry");
  for (const ancestor of ancestors) {
    const runs = await findCommitWorkflowRuns({
      sha: ancestor, repository,
      workflowPath: ".github/workflows/build-review-bot-image.yml",
      event: ["push", "workflow_dispatch"], get, list, requireComplete: true,
    });
    const run = runs.find((candidate) => candidate.head_branch === "main"
      && candidate.status === "completed" && candidate.conclusion === "success");
    if (run) return { sha: ancestor, run_id: run.id, run_attempt: run.run_attempt };
  }
  throw new Error("No successful Build review bot image run in dispatched main ancestry");
}

// GitHub's successful PR workflow owns the artifact. Git's tree OID, not a
// matching branch/head SHA, proves that the merged source was actually tested.
export async function findTestedTree({
  sha,
  repository,
  token,
  apiUrl = "https://api.github.com",
  includeMain = false,
  pullRequest,
  fetchImpl = fetch,
}) {
  if (!SHA.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) {
    throw new Error("A full commit SHA, repository and GitHub token are required");
  }
  const root = `${apiUrl.replace(/\/$/, "")}/repos/${repository}/`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  async function get(path) {
    const response = await fetchImpl(root + path, { headers });
    if (!response.ok)
      throw new Error(`GitHub lookup failed (${response.status}) for ${path.split("?")[0]}`);
    return response.json();
  }
  async function list(path, key) {
    const values = [];
    for (let page = 1; ; page += 1) {
      const response = await fetchImpl(
        `${root}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        { headers },
      );
      if (!response.ok)
        throw new Error(`GitHub list failed (${response.status}) for ${path.split("?")[0]}`);
      const data = await response.json();
      const rows = key ? data[key] : data;
      if (!Array.isArray(rows)) throw new Error("Invalid GitHub list response");
      values.push(...rows);
      if (!response.headers.get("link")?.includes('rel="next"')) return values;
    }
  }
  const sameRepository = (name) =>
    typeof name === "string" && name.toLowerCase() === repository.toLowerCase();
  const trustedRun = (run, event, head) =>
    run.event === event && run.head_sha === head && sameRepository(run.head_repository?.full_name);
  const commit = await get(`commits/${sha}`);
  const tree = commit.commit?.tree?.sha;
  if (commit.sha !== sha || !SHA.test(tree))
    throw new Error("Invalid selected commit/tree response");
  const missing = () => ({
    matched: false,
    reason: "No successful same-PR CI proof for the exact selected tree",
    head_sha: sha,
    tree_sha: tree,
  });
  if (pullRequest !== undefined) {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1 || includeMain)
      throw new Error("Invalid same-PR proof request");
    const pull = await get(`pulls/${pullRequest}`);
    if (
      pull.number !== pullRequest ||
      pull.state !== "open" ||
      pull.base?.ref !== "main" ||
      !sameRepository(pull.base?.repo?.full_name) ||
      !sameRepository(pull.head?.repo?.full_name) ||
      !SHA.test(pull.head.sha) ||
      (sha !== pull.head.sha && !commit.parents?.some((parent) => parent.sha === pull.head.sha))
    )
      return missing();
    const candidates = await list(
      `actions/workflows/ci.yml/runs?event=pull_request&branch=${encodeURIComponent(pull.head.ref)}&status=success`,
      "workflow_runs",
    );
    // Native associations identify the PR, but their head SHA tracks its current
    // head rather than this older run. Branch reuse also requires a creation fence.
    const authorized = (run) =>
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      SHA.test(run.head_sha) &&
      Number.isSafeInteger(run.workflow_id) &&
      run.workflow_id > 0 &&
      trustedRun(run, "pull_request", run.head_sha) &&
      sameRepository(run.repository?.full_name) &&
      run.path === ".github/workflows/ci.yml" &&
      run.head_branch === pull.head.ref &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      Array.isArray(run.pull_requests) &&
      run.pull_requests.length === 1 &&
      run.pull_requests[0].number === pullRequest &&
      run.pull_requests[0].base?.ref === "main" &&
      Number.isFinite(Date.parse(pull.created_at)) &&
      Date.parse(run.created_at) >= Date.parse(pull.created_at);
    async function workflowIdentity(ref) {
      const directory = await get(`contents/.github?ref=${ref}`);
      const workflows =
        Array.isArray(directory) &&
        directory.find((entry) => entry.path === ".github/workflows" && entry.type === "dir");
      const helper = await get(`contents/scripts/ci-tested-tree.mjs?ref=${ref}`);
      if (!SHA.test(workflows?.sha) || helper.type !== "file" || !SHA.test(helper.sha))
        throw new Error("Invalid CI workflow identity");
      return `${workflows.sha}:${helper.sha}`;
    }
    function checkedOutSource(run) {
      const references = Array.isArray(run.referenced_workflows) ? run.referenced_workflows : [];
      const local = references.filter(
        (entry) =>
          SHA.test(entry.sha) &&
          entry.ref === `refs/pull/${pullRequest}/merge` &&
          entry.path?.toLowerCase() ===
            `${repository}/.github/workflows/build-image.yml@${entry.sha}`.toLowerCase(),
      );
      return local.length === 1 ? local[0].sha : null;
    }
    for (const listed of candidates) {
      if (!authorized(listed)) continue;
      const run = await get(`actions/runs/${listed.id}`);
      if (
        !authorized(run) ||
        run.id !== listed.id ||
        run.head_sha !== listed.head_sha ||
        run.workflow_id !== listed.workflow_id ||
        run.run_attempt !== listed.run_attempt
      )
        continue;
      // A local reusable workflow resolves from the caller's checked-out merge
      // commit. Native metadata authenticates that source, not artifact text alone.
      const source = checkedOutSource(run);
      if (!source) continue;
      const producer = await get(`commits/${source}`);
      if (
        producer.sha !== source ||
        producer.commit?.tree?.sha !== tree ||
        (source !== run.head_sha &&
          !producer.parents?.some((parent) => parent.sha === run.head_sha)) ||
        (await workflowIdentity(source)) !== (await workflowIdentity(sha))
      )
        continue;
      const artifacts = await list(`actions/runs/${run.id}/artifacts`, "artifacts");
      const matches = artifacts.filter(
        (artifact) => artifact.name === `ci-tested-tree-${run.run_attempt}` && !artifact.expired,
      );
      if (matches.length !== 1) continue;
      const artifact = matches[0];
      if (
        artifact.workflow_run?.id !== run.id ||
        artifact.workflow_run?.head_sha !== run.head_sha ||
        !Number.isFinite(Date.parse(run.run_started_at)) ||
        Date.parse(artifact.created_at) < Date.parse(run.run_started_at) ||
        !Number.isFinite(Date.parse(artifact.created_at))
      )
        continue;
      const proof = await readTestedTreeArtifact({
        artifact,
        repository,
        token,
        apiUrl,
        fetchImpl,
      });
      if (proof.tree !== tree) continue;
      // A rerun begun during artifact validation invalidates the former attempt.
      const current = await get(`actions/runs/${run.id}`);
      if (
        !authorized(current) ||
        current.id !== run.id ||
        current.head_sha !== run.head_sha ||
        current.workflow_id !== run.workflow_id ||
        current.run_attempt !== run.run_attempt ||
        checkedOutSource(current) !== source
      )
        continue;
      return {
        matched: true,
        source: "pull_request",
        run_id: run.id,
        run_attempt: run.run_attempt,
        artifact_id: artifact.id,
        pr_number: pullRequest,
        head_sha: sha,
        tested_head_sha: run.head_sha,
        tree_sha: tree,
        ...(proof.imageDigest ? { image_digest: proof.imageDigest } : {}),
      };
    }
    return missing();
  }

  const pulls = await list(`commits/${sha}/pulls`);
  for (const pull of pulls) {
    if (
      !pull.merged_at ||
      pull.merge_commit_sha !== sha ||
      pull.base?.ref !== "main" ||
      !sameRepository(pull.base?.repo?.full_name) ||
      !sameRepository(pull.head?.repo?.full_name) ||
      !commit.parents?.some((parent) => parent.sha === pull.head.sha)
    )
      continue;
    const [run] = await findCommitWorkflowRuns({
      sha: pull.head.sha, repository, workflowPath: ".github/workflows/ci.yml",
      event: "pull_request", get, list,
    });
    if (
      !run ||
      !trustedRun(run, "pull_request", pull.head.sha) ||
      run.status !== "completed" ||
      run.conclusion !== "success"
    )
      continue;
    const name = `ci-tested-tree-${run.run_attempt ?? 1}`;
    const artifacts = await list(`actions/runs/${run.id}/artifacts`, "artifacts");
    for (const artifact of artifacts) {
      if (artifact.name !== name || artifact.expired) continue;
      const proof = await readTestedTreeArtifact({
        artifact,
        repository,
        token,
        apiUrl,
        fetchImpl,
      });
      if (proof.tree === tree) {
        return {
          matched: true,
          source: "pull_request",
          run_id: run.id,
          run_attempt: run.run_attempt ?? 1,
          artifact_id: artifact.id,
          pr_number: pull.number,
          head_sha: sha,
          tested_head_sha: run.head_sha,
          tree_sha: tree,
          ...(proof.imageDigest ? { image_digest: proof.imageDigest } : {}),
        };
      }
    }
  }

  if (includeMain) {
    // Direct/unproven main pushes still need native CI. Its aggregate can finish
    // before post-merge-only diagnostics; those diagnostics alert independently.
    const [run] = await findCommitWorkflowRuns({
      sha, repository, workflowPath: ".github/workflows/ci.yml",
      event: "push", get, list,
    });
    if (run && trustedRun(run, "push", sha)) {
      const jobs = await list(
        `actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs`,
        "jobs",
      );
      if (
        jobs.some(
          (job) =>
            job.name === "re-actors/alls-green" &&
            job.status === "completed" &&
            job.conclusion === "success",
        )
      ) {
        return { matched: true, source: "main", run_id: run.id, head_sha: sha, tree_sha: tree };
      }
    }
  }
  return {
    matched: false,
    reason: "No successful same-repository CI proof for the exact selected tree",
    head_sha: sha,
    tree_sha: tree,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const index = process.argv.indexOf("--pull-request");
    const pullRequest = index === -1 ? undefined : Number(process.argv[index + 1]);
    const result = await findTestedTree({
      sha: process.argv[2],
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
      includeMain: process.argv.includes("--include-main"),
      pullRequest,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`CI reuse lookup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
