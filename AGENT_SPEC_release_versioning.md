# Release Versioning Spec

## Goal

Keep TokenSlim releases lightweight and reliable for a Claude/Codex plugin repository.

## Scope

- The source of truth is the plugin manifest version in `.codex-plugin/plugin.json`.
- `.claude-plugin/plugin.json` must match the Codex manifest version.
- Git tags must use `vX.Y.Z` and must match both plugin manifests.
- Release checks should fail before packaging when versions drift.
- GitHub release artifacts are optional; the repository should first produce verified tag artifacts.

## Non-Goals

- No npm package publishing.
- No semantic-release automation.
- No generated changelog automation.
- No signed attestations unless distribution risk increases later.

## Implementation

- Add `scripts/validate-release-version.mjs`.
- Add tests for manifest sync and tag mismatch failure.
- Run version validation in CI.
- Run tag validation in the release workflow before packaging.
- Document the manual release process in `RELEASE.md`.
