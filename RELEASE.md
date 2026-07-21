# Release Process

TokenSlim is a Claude/Codex plugin repository, not an npm package. Release versioning is intentionally lightweight.

## Version Source

Keep these versions identical:

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`
- Git tag, using `vX.Y.Z`

Example for version `0.3.1`:

```bash
node --test tests/*.test.mjs
node scripts/validate-release-version.mjs
node scripts/benchmark.mjs --format md  # verify README fixture table
# Complete live Claude/Codex smoke checks and record any blockers in the release notes.
git add -A
git commit -m "chore: release v0.3.1"
git tag v0.3.1
git push origin main --tags
```

## Release Checks

The release workflow runs on `v*` tags. It validates that the tag matches both plugin manifest versions before tests and packaging run.

The workflow uploads:

- `tokenslim-vX.Y.Z.tar.gz`
- `tokenslim-vX.Y.Z.tar.gz.sha256`

## Version Policy

Use SemVer:

- Patch: bug fixes, docs, internal test changes, release process fixes.
- Minor: new hook behavior, new supported tool output shape, new command capability.
- Major: breaking install layout, changed hook contract, removed command or manifest compatibility.

## GitHub Releases

Creating a GitHub Release from the tag is optional. For now, the tag plus verified workflow artifacts are enough for this plugin repository.

If broader distribution becomes important, add a release-publish workflow that attaches the generated archive and checksum to a GitHub Release.
