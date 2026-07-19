# v0.3.0 smoke evidence

Run date: 2026-07-19. This record distinguishes executed checks from checks that could not
be executed; **not runnable is not a pass**.

| Check | Status | Evidence |
| --- | --- | --- |
| Claude (a): `npm install` rewrite | **PASS** | Claude Code `2.1.215` was run in a scratch project with `claude -p --plugin-dir /Users/alilkuizon/Personal Projects/tokenslim`. Its `PreToolUse:Bash` hook response was exit 0 and contained `permissionDecisionReason: "tokenslim quiet-rewrite: npm-quiet"` plus `updatedInput.command: "npm install --help --loglevel=error --no-fund --no-audit"`. |
| Claude (b): `git status` porcelain compression | **NOT RUNNABLE** | Not executed in the live Claude session. No pass is claimed. |
| Claude (c): tee marker, raw-file Read recovery | **NOT RUNNABLE** | Not executed end-to-end in a live Claude session. Unit coverage passed, but that is not a live smoke pass. |
| Claude (d): slash commands `tokenstats`, `discover`, `doctor` | **NOT RUNNABLE** | Not executed through an interactive Claude session. `node scripts/doctor.mjs` and the automated suites ran separately; neither verifies slash-command registration. |
| Codex install (0.3.0) | **NOT RUNNABLE** | A prior isolated `CODEX_HOME` install succeeded with plugin version `0.2.0`, before this release's manifest bump. It is useful historical evidence for marketplace wiring only; it does **not** verify installation of 0.3.0 and is not counted as a release smoke pass. |
| Codex (e): advisory rewrite and `additionalContext` compression | **NOT RUNNABLE** | A real `codex exec` was attempted with the installed plugin and `--dangerously-bypass-hook-trust`, but it could not start a model turn: API returned `401 Unauthorized: Missing bearer or basic authentication`. The CLI emitted hook-trust notices, but no Bash tool call occurred, so advisory/compression behavior was not verified. |

## Automated and local gates run

- `node --test tests/*.test.mjs`: **PASS** — 114 tests, 0 failures (final local validation).
- `node scripts/validate-release-version.mjs`: **PASS** after the manifest bump — validated
  matching `v0.3.0` manifests.
- `node scripts/benchmark.mjs --format md`: **PASS** after the CLI entrypoint correction; the
  table embedded in `README.md` is generated from that fixture corpus.

## Follow-up before declaring a fully live-verified release

Authenticate Codex in an isolated `CODEX_HOME`, reinstall the `0.3.0` plugin, confirm the
reported version, then run a Bash command through `codex exec` and inspect the hook event for
the advisory and compressed `additionalContext`. In Claude, run checks (b)–(d) in one scratch
session and record the transcript/hook evidence, including a tee path and successful Read of
the raw file.
