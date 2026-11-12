# Fleet Review Bot

A single-repository GitHub Review App with exact-head reviews and isolated read-only model execution. Each installation owns its App credentials, state database, workspaces, runner, broker and gateway. This repository contains the generic implementation, not a shared multi-tenant service.

## Safety defaults

`MERGE_LANE_ENABLED=false` and `MERGE_BATCH_ENABLED=false` by default. Review-only means the bot can publish checks and exact-head APPROVE reviews; it does not merge, enqueue, enable auto-merge, or update branches. Use GitHub native auto-merge or merge queue as the supported merge path. An authorized release actor arms GitHub only after independent review, required final-head CI, exact-head Review App approval and release authorization. A new push invalidates that authorization.

The legacy direct merge lane remains available only with explicit `MERGE_LANE_ENABLED=true`; its Builder App, CI protocol and batch settings require separate project-specific approval. Do not enable it for native merge mode.

A held PR can still be reviewed and approved. Therefore installations MUST require the `merge-gate` status in their actual live branch ruleset, alongside CI and App-bound review authority. Committed workflow files alone do not enforce protection. Configure stale-review dismissal, independent last-push approval and no builder/admin bypass. Keep an owner-controlled repair path outside the bot's own gate.

## Quickstart for installation tooling

Fleet's planned `fleet review-bot` commands will drive this contract; those commands are not implemented here.

1. Pin an independently reviewed source commit and a tested image **digest**. Never auto-follow a branch or mutable image tag. Create a separate selected-repository Review App and separate Builder App identity for each instance; never reuse another project's keys or SQLite database.
2. Add trusted-main files to the consuming repository: `.github/review-policy.md`, `.omp/config.yml` with its `modelRoles.review` binding, `.omp/unadvised-review.yml`, and `bot/verdict-thresholds.json`. Policy and thresholds are read from the consuming repository's trusted `main`, not from a PR or the image. Missing or malformed policy refuses approval.
3. Calibrate the judge model and thresholds on the consuming project's own data. The shipped threshold file is an **uncalibrated starting example**, not approval to adopt another project's calibration. Retain local calibration evidence privately. The judge's returned model must match `calibratedModel` exactly.
4. Supply the instance environment below through a private secret manager or mode-0600 environment file. Never commit real values. Configure runner model routes and overlays through an instance-specific read-only configuration mount. Saved-reset spending is disabled in the stock overlay; do not enable automatic spending.
5. Deploy the pinned image as separate control-plane, broker, gateway and no-egress read-only runner processes. The image ENTRYPOINT supplies `tini`, not a deployment topology. Use `node /opt/pr-review-bot/bot/server.mjs` for the control plane and `node /opt/pr-review-bot/bot/runner.mjs` for the runner. Isolate `/state`, `/work` and `/sessions` per instance. Keys and judge credentials belong only in the trusted control plane/gateway, never the reviewed checkout or model runner. Hosting, secrets and network adapters are deployment-owner choices; no host or secret-store project is embedded.
6. Install the reusable merge-gate workflow pinned to the same reviewed commit; see its contract below. Require its status in the live ruleset. All other required CI must run on both pull requests and `merge_group` synthetic heads. Enable native queue only when repository capability and synthetic-head checks are proved.
7. Prove a scratch PR: hold blocks before and after queueing, unticked Gate boxes block, a failing review/CI blocks, push dismisses stale approval, fresh exact-head approval permits authorized native auto-merge, actual merge is observed, and rollback restores the pinned compatible image/state. A successful build is not deployment or wake-delivery evidence.

### Per-instance configuration

| Surface | Contract |
|---|---|
| Identity | `GITHUB_REPOSITORY=example-org/example-project`; numeric `GITHUB_APP_ID`, `REVIEW_BOT_USER_ID`; `REVIEW_BOT_LOGIN=example-review[bot]` |
| Builder identity | `BUILDER_BOT_LOGIN=example-builder[bot]`, numeric `BUILDER_BOT_USER_ID`; identity metadata is currently required even in review-only, but Builder credentials are not |
| Human authority | `REVIEW_APPROVERS=example-owner:1004`; explicit nonempty comma-separated login:id pairs |
| Mode | `REVIEW_BOT_MODE=off|advisory|approve` is required; use advisory until calibration and live protection are proved |
| Credentials | `GITHUB_APP_PRIVATE_KEY_B64`, `GITHUB_WEBHOOK_SECRET`, `OMP_GATEWAY_TOKEN`, `TYPESAFE_API_KEY`; names only, never values in source/logs/argv |
| Runtime | `RUNNER_URL` (default `http://runner:8081`), `GATEWAY_URL` (`http://gateway:4000`), `STATE_ROOT=/state`, `WORK_ROOT=/work`, `SESSIONS_ROOT=/sessions`, `PORT=8080` |
| Reviewer route | `REVIEW_MODEL` defaults to `openai-codex/gpt-6.1-sol`; also supports `anthropic/claude-opus-5-5`. `REVIEW_THINKING=low|medium|high` defaults to medium. The runner and transcript classifier reject unsupported or mismatched routes |
| Runner policy | Mount per-instance `reviewer-models.yml` and `reviewer-overlay.yml` read-only at `/opt/pr-review-bot/config`; stock policy disables fallback, advisors and saved-reset spending |
| Builder CLI | `scripts/builder/builder.mjs gh ...` uses `REVIEW_BOT_BUILDER_REAL_GH` for the installed real gh executable; mark builder checkouts with `git config review-bot.builder true` to require Builder App credentials and refuse `gh auth`. Unmarked checkouts retain ordinary gh identity |
| Limits | `REVIEW_CONCURRENCY=2`, `RETENTION_DAYS=180`, `RECONCILE_INTERVAL_MS=60000`; deployment owner selects capacity and budgets |
| Native mode | Explicitly set `MERGE_LANE_ENABLED=false`, `MERGE_BATCH_ENABLED=false`; configure GitHub rulesets, not a second custom merger |
| Legacy opt-in | Builder client/key environment, `MERGE_BATCH_MAX_SIZE` (1–5), `MERGE_BATCH_COLLECT_SECONDS` (0–900); not needed by supported native mode |

The current protocol targets the `main` base branch. Each instance is single-repository; webhook repository identity and installation grants must match it. Approval mode degrades to advisory if gateway/judge readiness is unavailable; inspect `/health` rather than assuming requested mode became effective. `/health` includes image revision and merge-lane state. Verify the deployed image digest separately.

## Merge hold gate

The reusable workflow is `.github/workflows/merge-gate.yml`. Pin `uses: cswenor/fleet-review-bot/.github/workflows/merge-gate.yml@<reviewed-full-commit>` in a trusted consuming workflow and grant only its documented permissions. Never execute PR-controlled scripts with write credentials. A `hold` label (case-insensitive), draft state, or any unticked `Gate:` checkbox blocks release. Queue evaluation must inspect every group member and refuse unknown or incomplete membership; checking only the last queue PR is unsafe.

Callers must pass literal `source_repository: cswenor/fleet-review-bot` and `source_sha: <the-same-reviewed-full-commit>`, trigger on `pull_request_target` hold/body/draft changes and `merge_group: checks_requested`, and grant `contents: read`, `pull-requests: read`, `statuses: write`. See the workflow's complete invocation example. It publishes the explicit `merge-gate` commit status on the live PR or synthetic head, not a misleading base-SHA Actions check. Protect the caller workflow and its source pin as release authority. Queue membership is conservatively the complete contiguous prefix through the matching synthetic head; this can block an earlier entry outside the minimal group rather than risk omitting a held member.

### App-owned approval gate (native bot mode)

With `MERGE_LANE_ENABLED=false`, the independently deployed Review App publishes
`app-approval` check runs using its own installation identity. Require both
`app-approval` and `codex-review` bound to that Review App integration ID, plus
the project's required CI. The generic Actions `merge-gate` remains hold-only;
it is not the configured App's approval authority.

Signed `pull_request_review` submitted/edited/dismissed, PR head/hold/body/draft
changes, and `merge_group: checks_requested` cause fresh live-state evaluation.
The scheduler also rechecks every open PR and current synthetic queue ref every
300 seconds, independently of whether a review job is active. PR-controlled
workflows, webhook review bodies, workflow artifacts and human approvals never
grant authority. A PR cannot suppress this service's webhook subscriptions by
editing its workflow files. No Actions-write or repository-dispatch permission
is needed.

The gate resolves the App's canonical Bot identity and requires its latest
decisive review to be `APPROVED` on the exact live head, for every queue member
and every open PR sharing a check head. Stale, dismissed, wrong-App or human
reviews do not satisfy it. Missing identity, API failures or incomplete
pagination block the gate. New heads have no success until evaluated.
Missing approvals revoke only queue prefixes containing that PR or its shared
head, not unrelated approved groups; periodic reconciliation reevaluates
current groups after approval returns.
Only publication receipts and immutable Bot identity are cached; approval,
hold and queue authority are always read afresh. Unchanged results are not
republished, avoiding check-event churn and unnecessary review API consumption.

A successful `codex-review` judge check alone does not prove an approval was
published. Ordinary approval-count rules cannot select a required App reviewer.

### Minimal native App permissions

| App | Repository permissions | Used endpoints / events |
|---|---|---|
| Review | contents read; pull_requests write; checks write; actions read; issues read; statuses read; implicit metadata read | Mirror contents/commits; PR reviews/comments; codex-review and app-approval checks; CI run/job reads; issue-comment reads; status invalidation. No legacy merge/update-branch/label writes. |
| Builder | contents write; pull_requests write; implicit metadata read | Native branch publication and PR creation/comments/auto-merge. No administration, ruleset, Actions write or legacy batch permissions. Workflow-file publication requires a separately approved workflows permission. |

Review webhook subscriptions: `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `issue_comment`, `check_run`, `check_suite`,
`status`, `push`, `workflow_run`, `merge_group`. Builder needs no webhook events.
Keep both Apps private and install with **Only select repositories**, selecting
exactly the instance's repository. Installation tooling must verify this scope;
a manifest alone cannot enforce repository selection.

Do not add workflow concurrency to the gate or its caller: GitHub replaces pending runs even with `cancel-in-progress: false`, which can discard a held PR's status revocation. Every trigger must run its live-state evaluation.

Because commit statuses are SHA-scoped, the gate checks every open PR sharing the event head, across paginated live membership, before granting success. A held/draft/incomplete PR on another branch with the same commit conservatively blocks that shared authority.
PR events also refuse to authorize a head currently used by an observed synthetic queue entry: only a merge-group evaluation may grant that authority. Queue lookups cover every base represented in open PRs; unavailable membership fails closed.

GitHub webhooks/checks are asynchronous. For an emergency hold after auto-merge is armed or a queue group starts, also disable auto-merge/dequeue the PR and verify removal; a delayed workflow cannot revoke a merge GitHub already completed. Do not describe label delivery as a synchronous atomic merge fence.

## Development and maintenance

Requires Node 24, Git, Python 3 and Docker. The fixture identity is synthetic and intentionally independent of the triggering repository:

```sh
env -u GITHUB_REPOSITORY node --env-file=bot/test.env --test --test-concurrency=4 bot/*.test.mjs
docker build --platform linux/amd64 --build-arg GIT_SHA=$(git rev-parse HEAD) -f bot/Dockerfile .
```

CI runs the full existing suite and real Linux image build, without pushing or deploying. The image pins the public OMP release and checksum. Consumer OMP configuration must be compatible with that exact version.

Changes require PRs, green final-head CI and an independent read-only unadvised review. Release with semver tags and CHANGELOG entries; build an immutable source-SHA image and retain its registry digest. Consumers opt into updates explicitly. Before schema-changing rollout, back up SQLite with writers stopped and document backward compatibility; do not assume an older image can read new state. Keep rollback image/config/state receipts per instance.

### Release procedure

Before the first release, configure the GitHub `release` environment with required
owner/Main reviewers and disallow self-approval. Restrict release tag creation to
authorized maintainers with a tag ruleset; never grant builders a bypass.
The workflow does not establish those GitHub settings itself.
After independent review, green final-head CI and explicit release GO, a
maintainer creates an **annotated** `vMAJOR.MINOR.PATCH` tag on that approved
commit in `main` history. The matching `## MAJOR.MINOR.PATCH` changelog heading
must exist. Pushing that tag runs `Release`: tests and the real image build run
before the protected publication job. No moving `latest` tag is published.

The release asset `release.json` records the full source commit, exact
`ghcr.io/...@sha256:...` image, platform and workflow URL. Both semver and
`sha-<full-commit>` tags are write-once by workflow policy; existing tags or
releases refuse replacement. Registry administrators can still change/delete
tags: consumers must use the digest, never trust tag immutability alone.
GHCR creates a first package private by default. After the first authorized
publication, the owner must make that package public in its GitHub package
settings and verify an anonymous pull of the receipt's digest before accepting
it for installation. Public source does not prove a public package.

An interrupted publication can leave an image without a release. Preserve the
run's metadata/digest; do not delete/repoint tags or blindly rerun. Reconcile
the exact image revision and successful verification job, then have the
authorized maintainer publish the missing receipt/release only. No image
rebuild or new digest is implied by that recovery.

## Provenance

Derived from an existing single-repository review bot and its maintained fork, including exact-head approval, budget/authority fencing, review-only isolation and durable recovery fixes. This public repository starts with one sanitized root commit; private source history, deployment identifiers and captured project content are intentionally not distributed.

## License

MIT. See [LICENSE](LICENSE).
