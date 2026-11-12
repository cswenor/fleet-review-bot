# Changelog

## Unreleased

- Add an annotated-semver release workflow with verified main ancestry, full tests/image build, protected publication environment, immutable digest receipts and refusal to replace existing image tags/releases.
- Add an App-owned app-approval required check for exact-head approvals and holds, signed review/head/merge-group events and periodic live reconciliation of every PR and queue prefix; generic Actions hold enforcement remains unchanged.

## 0.1.0

- Extract a project-neutral, single-repository review bot with synthetic fixtures and fresh public history.
- Default to review-only: both custom merge lane and batch merging are disabled.
- Keep native GitHub auto-merge/queue as the supported release path, with required hold enforcement and explicit release authority.
- Configure repository identity, policy, calibration and reviewer routing per instance; isolate Apps, credentials and persistent state.
- Pin public build dependencies and require independent review plus final-head CI for versioned releases.
- Bind approval readiness to the configured reviewer provider and make the standalone Builder CLI independent of missing private wrapper files.
- Preserve every hold-triggered workflow run; bind carried reviews to the original configured model/effort receipt as well as served-model evidence. Old reviews without the receipt require fresh execution.
- Reconcile shared-head PR holds before publishing SHA-scoped success; bind carry-forward to both trusted OMP configuration files and reject missing or changed inputs.
- Require matching reviewer-route evidence at recovered approvals and every legacy merge checkpoint; queue fresh execution instead of approving incompatible persisted reviews after restart.

No release tag or image publication is implied by this preparation. The first semver release requires independent review, green CI and explicit publication approval. The owner authorized MIT licensing and confirmed redistribution rights.
