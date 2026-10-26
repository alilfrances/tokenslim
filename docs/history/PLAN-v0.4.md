# tokenslim v0.4 implementation plan

Source: maintainer brief "tokenslim efficacy analysis + feature roadmap" (Oct 2026, v0.3.2).
This plan was checked against the code at `cc3aa93` (v0.3.2). It is written for an
implementing agent, so each work package (WP) lists files, changes, tests and an acceptance gate.

---

## 0. Verdict on the brief

The brief's diagnosis is correct. Several of its proposed fixes need changes before they are built.

### Confirmed against the code
| Claim | Evidence |
|---|---|
| Any `&&`, `;`, `\|` or `>` disables the specialized compressors and the rewrites | `scripts/lib/cmd-compressors/index.mjs:9` and `scripts/lib/rewrite-rules.mjs:5` (`UNSAFE_SHELL`). The generic pipeline still runs (`compress-bash.mjs` `compressed()` falls back to `compressBashOutput`). |
| `headTailTruncate` triggers only at 40,000 chars | `scripts/lib/pipeline.mjs:1`, applied at `:344`. Claude Code persists results over ~30KB itself (this session saw a 30.2KB result persisted). |
| The read guard sits at Read's own 2000-line cap | `scripts/guard-read.mjs:8`, `config.mjs` `readGuardLines: 2000` |
| Tests write into the real `~/.cache/tokenslim` | `tests/pipeline.test.mjs` spawns hooks with sessions `s-codex-bash-skip` (~L303) and `s-codex-no-turn` (~L393) without `XDG_CACHE_HOME`/`XDG_DATA_HOME`. Compressed test runs also land in the real `history.json`, which inflates `/tokenslim:tokenstats`. |
| `discover` reports "no transcripts found" when it shouldn't | Root cause 1: `commands/discover.md:9` passes `"$ARGUMENTS"` as **one** argv element, so `--since 7 --all` arrives as the single string `"--since 7 --all"` and every flag is ignored. Root cause 2: `discover.mjs:98` swallows every exception as "no transcripts found". |
| The transcript schema the auditor needs exists | Transcript lines with `type:"attachment"` carry `attachment.type` ∈ `skill_listing` (`content`, `names`, `skillCount`), `mcp_instructions_delta` (`addedNames`, `addedBlocks`), `deferred_tools_delta` (`addedNames`, `addedLines`), `agent_listing_delta` (`addedTypes`, `addedLines`), … (checked against a live 2.1.x transcript). |

### Additional defects found during the check
- **The CI syntax check checks only one file.** See WP0.5.
- **`discover.mjs:85-86` misclassifies outputs as already compressed.** It tests `output.includes('[tokenslim:')`, so any output that merely *contains* that string is dropped from "sinks". Reading tokenslim's own source does this: in this repo, `cat` produced 91KB that never showed up as a sink. Fix: match only a final-line marker. This also affects the F6 numbers.

### Corrections to the brief's fixes
1. **F5 rewrite rules: do not make them segment-aware. Turn them off by default.** A rewrite returns `permissionDecision:"allow"` (`hook-output.mjs` `preToolUseRewriteOutput`), which **auto-approves the command and skips the user's permission prompt**. On `&&` chains this would auto-approve every segment that follows (`npm install && <anything>`). Even today it auto-approves `npm install` / `pip install` / `cargo build`, all of which execute arbitrary package scripts. With 0 hits in 30 days, the security cost is not worth keeping on by default.
2. **F4 advisory outline would add tokens without saving any.** PreToolUse `additionalContext` arrives *alongside* a Read that still runs in full, so a 40-line outline is pure overhead on every large read. The outline only pays off when the full Read is **denied**. Build it as an opt-in deny mode with an escape hatch (the model repeats the unbounded Read → allowed), and leave the default advisory as a single line.
3. **F2 self-tuning cap: ship the metric only.** A cap that changes mid-session from hidden state breaks determinism (invariant I3 in `FIX_PLAN.md`) and makes A/B results hard to interpret. Record recovery events and report them in stats. Tuning stays a human config decision.
4. **F2 needs more exemptions than bounded reads.** Truncating diff-shaped output (`git diff`, `git show`) or valid JSON (`jq`, `curl`, `gh api`) destroys structure the model needs. Exempt both. Ship the cap **off by default** (`bash.capChars: 0`) and make it default-on only after the A/B in §4. Raise `tee.maxFiles` from 20 to 100, because pruning a tee file that a marker still points to breaks recovery.
5. **F2 is not blocked by the "before/after native persistence" question.** The cap targets 8–30KB, a band native persistence never touches. The question only decides whether output above 30KB still needs handling, and the cap produces less than 30KB in either case. Keep the spike (WP-S), but run it in parallel instead of as a gate.
6. **F3 scope.** Grep grouping (−24%, lossless) already passes the existing 0.9 ratio gate, so per-shape gates are unnecessary. Defer timestamped-log factoring (0.7%; `collapseRepeatedLines` already fingerprints times) and diff-header trimming (tiny gain).
7. **F1 pruning reach is narrower than "up to ~14%".** `enabledPlugins:false` works for plugins. `disabledMcpjsonServers` only affects servers from the project's `.mcp.json`. User-scope servers (`~/.claude.json`) and claude.ai connectors cannot be disabled from project settings, so report them for manual action. `deferred_tools_*`, `agent_listing` (built-ins) and `instructions` cannot be pruned at all. The report must separate prunable from non-prunable overhead, and treat 14% as an upper bound.
8. **F6 "saved tokens × remaining calls" cannot be computed inside a hook** because the hook does not know the future. Compute it offline in the transcript replay (WP1). Stats can report only `bytesAttempted`, which needs to be recorded (today only an `attempted` event count exists).

---

## 1. Ground rules for the implementer

- No dependencies. Node ≥20, ESM `.mjs`, `node:test`. There is no `package.json`; do not add one.
- Before every commit run:
  `for f in scripts/*.mjs scripts/lib/*.mjs scripts/lib/*/*.mjs; do node --check "$f" || exit 1; done && node scripts/validate-release-version.mjs && node --test tests/*.test.mjs`
  `node --check` accepts only one file per call; see WP0.5.
- Hooks are **fail-open**: any exception passes the original through and the process exits 0. Never write to stderr in hook paths.
- Every lossy change ends with a fresh final-line marker `[tokenslim: …]` (see `markCompression`). Kept lines stay verbatim.
- Privacy: never persist full commands, paths from command arguments, or prompt text. Use `commandFamily()` (`scripts/lib/privacy.mjs`) or a sha256 (`read-format.mjs:48`).
- Every test that spawns a hook or script must set `XDG_CACHE_HOME`, `XDG_DATA_HOME` and `XDG_CONFIG_HOME` to a temp dir (WP0 adds a helper; use it).
- Match the surrounding style: terse comments that explain *why*, and no new comment banners.
- Make one commit per WP, with the message `feat|fix|chore(<area>): …`. Do not bump the version until WP9.

Order: WP0 → WP1 → (WP2, WP3, WP6 in any order) → WP4 → WP5 → WP7 → WP8 → WP9. WP-S can run at any time.

---

## WP0: Hygiene and measurement correctness (small; unblocks everything)

**Files:** `tests/helpers.mjs` (new), `tests/pipeline.test.mjs`, other tests that spawn hooks, `scripts/discover.mjs`, `commands/discover.md`, `.github/workflows/ci.yml`.

1. **Test isolation.** Add `tests/helpers.mjs` exporting `isolatedEnv(extra = {})`. It creates one temp root per call and returns `{ env: { ...process.env, XDG_CACHE_HOME, XDG_DATA_HOME, XDG_CONFIG_HOME, ...extra }, cleanup() }`. Route every `spawnSync`/`execFileSync` of a script under `scripts/` through it. Start with the two `pipeline.test.mjs` cases named above, then grep the whole `tests/` directory for spawns that pass `env: { ...process.env` without XDG overrides.
   - Add a guard test: run the full spawn set with `HOME` pointed at a temp dir and assert that nothing is created under it.
2. **Argument splitting in `discover`.**
   - In `commands/discover.md`, change the spawn args to `...process.argv.slice(1).flatMap(a=>a.split(/\s+/)).filter(Boolean)`. Flags never contain spaces; a `--project` path with spaces is not supported and should be documented.
   - Make `discover.mjs` also accept a single argv element containing spaces the same way (defense in depth).
3. **Error reporting in `discover`.** In `discover.mjs:98`, only an empty file list prints "no transcripts found". Other exceptions print `tokenslim discover: error: <message>` (JSON: `{error}`) and exit 0.
4. **Compressed-marker detection.** Add `export const FINAL_MARKER_RE = /\n?\[tokenslim: [^\]\n]*\]\s*$/` to a new `scripts/lib/transcripts.mjs` (see WP1). Use it in place of `includes('[tokenslim:')` at `discover.mjs:85-86`. It must match only when our marker is the last line, or the last line is a `[tokenslim: full: …]` tee marker.
5. **CI syntax check is a no-op.** `node --check a.mjs b.mjs …` checks only the first file and treats the rest as argv (verified on Node 22: a broken second file still exits 0). So `ci.yml` "Syntax check scripts" only ever checks `scripts/benchmark.mjs`. Replace it with
   `for f in scripts/*.mjs scripts/lib/*.mjs scripts/lib/*/*.mjs; do node --check "$f" || exit 1; done`.

**Tests:** discover with `["--since 3650 --all"]` as one argument finds the fixture transcript; output containing `[tokenslim:` mid-text counts as a sink; the guard test above.
**Accept:** all tests pass; a full test run leaves `~/.cache/tokenslim` and `~/.local/share/tokenslim` untouched.

---

## WP1: Shared transcript walker and offline replay benchmark (F6 core)

This is how every later WP proves it helps. Build it before the features.

### 1a. Extract the Bash hook core so it can be imported
`scripts/compress-bash.mjs` runs `await main()` at top level (L188), so it cannot be imported.
- Move everything except stdin I/O into `scripts/lib/bash-hook.mjs`:
  `export function processBashPayload(payload, { config, env = process.env, dryRun = false })`, returning
  `{ outcome, updatedToolOutput|null, bytesIn, bytesOut, rulesApplied, recoveryPath|null }`.
  When `dryRun` is true, it must not tee, write the ledger or touch state.
- `compress-bash.mjs` becomes a thin wrapper: read stdin, call `processBashPayload`, write JSON, record the ledger. Hook behavior must stay **byte-identical**; the existing pipeline tests prove it.
- Move `failureOutput` with it and re-export it from `compress-bash.mjs` so existing imports keep working. Grep the tests for `failureOutput` imports.

### 1b. `scripts/lib/transcripts.mjs` (shared by discover, benchmark and budget)
Exports:
- `transcriptRoot(env)` and `transcriptFiles({ root, cwd, all })`, moved from `discover.mjs` together with its slug fallback. Includes subagent jsonl files, which `filesUnder` already does recursively.
- `function* readLines(file, { sinceMs })` yields parsed JSON lines. It skips malformed lines and lines with a timestamp older than the cutoff; lines with no timestamp are kept, as today.
- `toolPairs(files, { tools })` collects `tool_use` blocks (`{id,name,input}`) and `tool_result` blocks (`{tool_use_id, text, isImage, isPersisted}`):
  - Pairs are **deduplicated by `tool_use_id`** with the first result winning. Resumed and branched sessions duplicate lines.
  - `isImage` is set when the content contains a block with `type:"image"`.
  - `isPersisted` is set when the text contains `<persisted-output>`.
  - `isCompressed` uses `FINAL_MARKER_RE`.
- `apiCalls(lines)` counts assistant messages that carry `message.usage`, **deduplicated by `message.id`**, because streaming writes one message as several lines. It returns per-session ordered call timestamps or indices.
- `FINAL_MARKER_RE` (WP0).
- Refactor `discover.mjs` onto this module. Its tests must still pass.

### 1c. `scripts/benchmark.mjs --transcripts <dir> [--since N] [--format text|json|md] [--config <path>]`
- Without `--transcripts`, behavior is unchanged (fixture mode).
- With it, replay every **Bash** pair whose result is not an image, not persisted and not already compressed through `processBashPayload({tool_input:{command}, tool_response:{stdout:text, stderr:''}}, {config, dryRun:true})`.
  - Document the limitation: transcripts merge stdout and stderr, and the exit code is unknown, so `failureOutput` uses its regex fallback.
- Report:
  - pairs scanned, skipped (image / persisted / already-compressed / below-threshold / failure / poor-ratio), compressed;
  - chars in and out;
  - savings as **% of all replayed tool-result chars** (the honest denominator), plus a breakdown by `rulesApplied` and by `commandFamily`;
  - a **cost-weighted estimate**: for each compressed result, `savedTokens × (API calls after it in the same session)` × the cache-read price. Use chars/4 for tokens and state the ratio in the output.
- `--config <path>` loads an explicit tokenslim config layer, so a run can compare caps etc. without editing files.
- Read, Grep and MCP replay are optional stretch goals; Bash is required.

**Tests:** extend `tests/fixtures/transcripts/session.jsonl` (or add `replay.jsonl`) with the following cases, and assert exact counts in `tests/benchmark.test.mjs`:
- a duplicated `tool_use_id`;
- an image result;
- a `<persisted-output>` result;
- an already-compressed result (final marker);
- a result containing `[tokenslim:` mid-text;
- two assistant lines sharing one `message.id`.

**Accept:** the replay runs in under 30s on 10k pairs. The maintainer reruns it on their transcripts and gets roughly the brief's baseline (~1.7% of tool-result text).

---

## WP2: Context budget auditor (F1, the biggest lever)

**Files:** `scripts/budget.mjs` (new), `commands/budget.md` (new), `tests/budget.test.mjs` (new), `tests/fixtures/transcripts/budget.jsonl` (new), README.

### Parsing (via `lib/transcripts.mjs`)
Per session file, in line order:
- **Overhead items** come from `type:"attachment"` lines. Size is in chars of model-visible text; convert to tokens at chars/4.
  | attachment.type | attribute to | size from |
  |---|---|---|
  | `skill_listing` | each name in `names[]` → skill; the plugin is the prefix before `:` if present, else "user/project skill" | `content` length, split evenly across `names` unless per-skill lines can be matched in `content` (prefer matching lines that start with `- <name>:`) |
  | `mcp_instructions_delta` | `addedNames[i]` → MCP server | `addedBlocks[i]` length |
  | `deferred_tools_delta` | names `mcp__<server>__*` → that server; other names → "built-in (not prunable)" | the matching `addedLines[i]` length |
  | `agent_listing_delta` | each `addedTypes` entry; `plugin:agent` → plugin; `builtInTypes` → not prunable | the matching `addedLines` length |
  | `hook_success`, `hook_additional_context`, `hook_*` | the hook/plugin name field if present | `content` length; count per prompt |
  | `nested_memory` | its file path | content length |
  | anything else | "other (not prunable)" | JSON length |
- Field names vary by Claude Code version: read them defensively, never throw, and count unknown shapes under "other".
- **Weight** = tokens × the number of API calls in that session after the attachment's line. Use `apiCalls`, deduplicated by `message.id`. A `removedNames` entry in a later delta stops the accrual.
- **Usage** comes from assistant `tool_use` blocks:
  - `name==="Skill"` → `input.skill` (fall back to `input.command`/`input.name`);
  - `name` starting with `mcp__` → server = `name.split('__')[1]`;
  - `name` ∈ {`Agent`,`Task`} → `input.subagent_type`.

### Report (`--since 30`, `--project`/`--all`, `--format text|json`, `--min-tokens 500`)
- Rows by plugin, MCP server, user skill, hook and memory file, showing tokens per session, weighted tokens, % of all API-call input, uses, and a `prunable` flag with how to prune it.
- "Candidates": `uses===0` and weighted tokens ≥ the threshold.
- `--emit-settings` prints, **and never writes**, a JSON snippet for `<project>/.claude/settings.local.json`:
  - `enabledPlugins: { "<name>@<marketplace>": false }`, resolved by matching plugin names against `enabledPlugins` keys in `~/.claude/settings.json` and `<project>/.claude/settings.json` (read-only). Skip a plugin if no key resolves.
  - `disabledMcpjsonServers: [...]` **only** for servers defined in `<project>/.mcp.json`.
  - Everything else goes in a "manual" list with the reason (user-scope MCP → `/mcp`; connector → the claude.ai connector settings; built-in → not prunable).
- Privacy: output names and sizes only, never prompt, tool or attachment text.

### `commands/budget.md`
Copy the root-discovery wrapper from `discover.md`, including the WP0 argument split. The instructions must say: show the report verbatim; if the user wants to apply the diff, show it, **ask for explicit confirmation**, then merge it into `.claude/settings.local.json` (create it if missing, preserve existing keys); never edit `~/.claude/settings.json`.

**Tests:** a fixture covering a skill listing with 3 skills of which 1 is used, two MCP servers of which 1 is used and 1 has `removedNames` mid-session, a duplicated `message.id`, and an unknown attachment type. Assert exact weights, the candidate list, the emitted snippet (with temp project `.mcp.json` and settings), and that nothing is written.
**Accept:** on the maintainer's transcripts, the identified overhead is within ±20% of the brief's figures (skill_listing ≈6.7k, mcp ≈1.6k, …).

---

## WP3: Shape-based compressor for grep-shaped Bash output (F3, lossless)

**Files:** `scripts/lib/shape-compressors/index.mjs`, `scripts/lib/shape-compressors/grep.mjs` (new), `scripts/lib/bash-hook.mjs`, `tests/shape-compressors.test.mjs`, `tests/fixtures/bash/grep-*.txt`.

- **Dispatch order** in `bash-hook.mjs` `compressed()`: specialized command compressor (unchanged) → **shape compressor** → generic `compressBashOutput`. Shape dispatch looks only at the output text and never at the command, so `UNSAFE_SHELL` does not apply to it. If the shape compressor fires, still run the generic pipeline on its result: ANSI/progress cleanup stays safe, and it is a no-op on grouped output.
- **Detector (`grep.mjs`).**
  - Fire only if at least 60% of non-empty lines, and at least 8 lines, match `^(?<path>[^\s:][^:\n]*?):(?<line>\d+)[:-](?<text>.*)$`. The `-` separator covers `-C` context lines.
  - The same path must appear on at least 2 consecutive lines at least once; otherwise grouping saves nothing.
- **Transform (lossless).** Each consecutive run with the same path becomes `path` on its own line, followed by `  <line>:<text>` (or `  <line>-<text>` for context lines).
  - Keep `--` separators and non-matching lines verbatim, in place.
  - Do not reorder; group consecutive runs only.
  - Leave lines without a line number untouched. That covers `grep -l` (bare path) and `grep -c` (`path:count` with nothing after the count): require `path:<digits>` followed by `:` or `-`. Cover `path:12` (count, not grouped) versus `path:12:text` (grouped) with tests.
- Mark the output with the rule name `groupByPath`. This rule is **lossless**, so `isLossy()` must treat it like ANSI stripping and not tee. Do that by having shape compressors return `{ text, rulesApplied, lossless: true }` and making `isLossy` honor that flag.
- The 0.9 ratio gate is unchanged.

**Tests:**
- Fixtures from realistic `rg -n`, `grep -rn`, and `grep -rn -C2` output.
- A round-trip helper `ungroup(grouped) === original` proves losslessness on every fixture.
- Negative controls must pass through unchanged: `ls -l`, a source file containing `foo:12:` once, `grep -c` output, timestamped logs (`12:34:56`), and a URL list (`http://host:8080/…`).
- Mixed output: `sed -n` text followed by grep lines groups only the grep region and leaves the rest byte-identical.

**Accept:** WP1 replay shows a gain on grep-shaped results of roughly 20% or more, with zero round-trip failures.

---

## WP4: Mid-band output cap with recovery (F2, opt-in)

**Files:** `scripts/lib/config.mjs`, `scripts/lib/pipeline.mjs`, `scripts/lib/bash-hook.mjs`, `scripts/lib/shell-segments.mjs` (new), `scripts/lib/tee.mjs`, tests.

1. **Config.**
   - Add to `DEFAULT_CONFIG`: `bash: { capChars: 0, capHeadLines: 60, capTailLines: 60 }`, where `0` means off.
   - Validate in `validLayer`: integers ≥ 0, and `capChars` is either 0 or at least 2000.
   - Add `'bash'` to the nested-merge list at `config.mjs:88`.
   - Add env `TOKENSLIM_BASH_CAP_CHARS`, and include it in the `loadConfig` cache key.
   - Change the `tee.maxFiles` default from 20 to 100.
2. **Inspection-only segment splitter (`shell-segments.mjs`).** `splitSegments(command)` splits on unquoted `|`, `||`, `&&`, `;` and newline. It reuses the quote-tracking approach of `tokenizeCommand`, executes nothing, and returns `null` on malformed quoting. `lastSegment(command)` returns the final pipeline segment's tokens.
3. **Exemptions.** Apply no cap when any of the following holds:
   - **Bounded read:** the last segment is `head`/`tail` with `-n N`/`-N`, `sed -n '<a>,<b>p'`, or `awk` with `NR` in its program, and the output is at most 2× `capChars`.
   - **Diff-shaped output:** the output contains `^diff --git ` or a `^@@ -\d+(,\d+)? \+\d+` hunk line.
   - **JSON:** `JSON.parse(output.trim())` succeeds, after a cheap first-char check for `{`/`[`.
   - **Failures:** already skipped upstream.
4. **Cap step.** Run it last in `processBashPayload`, after specialized/shape/generic, when `capChars > 0` and the output length exceeds `capChars`. Call `headTailTruncate(output, { maxChars: capChars, headLines, tailLines })`, which keeps important lines.
   - Extend it with a `grepCounts` option: when the omitted region is grep-shaped (reuse the WP3 detector), append `[tokenslim: omitted matches by file]` followed by `path: N` lines.
   - The cap is lossy, so the existing tee path applies and the `[tokenslim: full: <path>]` marker is emitted. If tee fails or is disabled, **do not cap**: without a recovery path the cap is unsafe.
5. **Keep `DEFAULT_MAX_CHARS = 40000`** for the generic path when `capChars` is 0. That preserves current behavior until the A/B.
6. **WP-S feeds in here:** if the spike shows the hook sees output after native persistence, document that outputs above ~30KB already arrive as previews and skip them via `isPersisted`. No code depends on the answer otherwise.

**Tests:**
- cap off → byte-identical to today;
- cap on, 20KB plain output → head and tail kept, an accurate omitted count, important lines kept, a tee file whose contents equal the original, and the marker path pointing at it;
- `cmd | head -n 400` below 2× cap → not capped;
- `git diff` → not capped;
- `jq .` output → not capped;
- tee disabled → not capped;
- grep-shaped omitted region → per-file counts are correct;
- `splitSegments` cases: quotes, escaped pipes, `||`, and malformed input returning `null`.

**Accept:** WP1 replay with `--config cap8000.json` shows the cap's added savings (brief: ~7% of tool-result text) and the count of exempted outputs.

---

## WP5: Honest stats and recovery tracking (rest of F6)

**Files:** `scripts/lib/state.mjs`, `scripts/lib/bash-hook.mjs`, `scripts/compress-read.mjs`, `scripts/stats.mjs`, `scripts/lib/history.mjs`, tests.

1. **`bytesAttempted`.** Every Bash, Read, Grep and MCP hook that reaches its size check adds the tool-result byte size to `state.attempted[tool]`, and through `historyEvents` into the daily `byTool[tool].bytesAttempted`.
   - Images are excluded (`skippedImage` already exists; Read images must be checked by `isImage`/`type`).
   - Keep the ledger format backward compatible: the new fields are optional and missing reads as 0.
2. **Recovery events.** `teeRoot(env)` already exists in shape as `teePath`; export the directory root.
   - (a) In `compress-read.mjs`, when `file_path` starts with the tee root → `recordDiagnostic({tool:'Bash', event:'recovery', outcome:'teeRead'})`.
   - (b) In `bash-hook`, when the command string contains the tee root → the same diagnostic with outcome `teeCat`.
   - (c) **Re-run:** keep `state.recentBash`, a ring of the last 3 entries `{ h: sha256(command).slice(0,16), capped: boolean }`. If a new command's hash matches a capped entry → outcome `rerun`. Store only hashes.
   - Count `capped` events as `outcome:'capped'` so a rate can be computed.
3. **`stats.mjs`.**
   - Add `% of attempted` per tool and in total.
   - Add a `recovery rate = (teeRead+teeCat+rerun)/capped` line when `capped > 0`, flagged `⚠` above 15%.
   - Exclude images from totals.
   - Leave the cost-weighted figure to `benchmark --transcripts` (WP1), and add a one-line note pointing there.

**Tests:** ledger and history round-trips with the new fields; an old ledger without them still renders; each recovery path increments correctly; the ring buffer stores no raw command (assert the serialized state does not contain the command text).

---

## WP6: Rewrite rules off by default (F5; security)

**Files:** `scripts/lib/config.mjs`, `scripts/rewrite-bash.mjs`, `tests/rewrite-*.test.mjs`, `docs/REWRITE-RULES.md`, README.

- `DEFAULT_CONFIG.rewrite.enabled` → `false`.
- In `rewrite-bash.mjs`, exit before tokenizing when it is disabled; it already returns `null` via `rewriteCommand`, so just make sure no state I/O happens first.
- **Do not** add support for `&&` segments.
- Update the tests that assume rewrites are on by default so they opt in explicitly. Add a test that the default config produces no PreToolUse output for `npm install`.
- Docs: explain that enabling the rewrites auto-approves the rewritten command (`permissionDecision:"allow"`), so it bypasses Claude Code's permission prompt for those commands.
- Leave the `hooks.json` PreToolUse Bash entry registered so opt-in keeps working. The maintainer can drop it later to save a node spawn per Bash call.

---

## WP7: Read guard (F4, revised)

**Files:** `scripts/lib/config.mjs`, `scripts/guard-read.mjs`, `scripts/lib/outline.mjs` (new), `scripts/lib/hook-output.mjs`, `scripts/lib/state.mjs`, tests.

1. **Config.**
   - Add `readGuard: { mode: 'advise', lines: 2000, bytes: 0 }`. Mode is one of `'advise'|'deny'|'off'`; `bytes: 0` means unused.
   - Keep `readGuardLines` and `TOKENSLIM_READ_GUARD_LINES` as aliases for `readGuard.lines`, since existing users rely on them.
   - Add `'readGuard'` to the nested-merge list. Add env `TOKENSLIM_READ_GUARD_MODE`.
2. **`advise` (default) is unchanged apart from config plumbing:** a single-line hint and no outline, because the outline would cost tokens without saving any (§0 correction 2).
3. **`deny` (opt-in).** Applies when the file exceeds the thresholds, has a text extension (an allowlist covering source, config and docs; never images, PDFs or notebooks), and the Read has no `offset`/`limit`.
   - Return a PreToolUse `permissionDecision:"deny"` whose reason contains:
     - the file's size;
     - an outline of at most 40 lines from `outline.mjs`;
     - the instruction: "Re-read with offset/limit for the section you need. Repeating this exact Read will return the full file."
   - **Escape hatch:** record `sha256(path)` in `state.guardDenied`. A second unbounded Read of the same path in the session is allowed with no output. Quality is never blocked, only delayed by one call.
   - Add `preToolUseDenyOutput(payload, reason)` to `hook-output.mjs`. For Codex, fall back to the advise output, because deny has not been verified there.
4. **`outline.mjs`.**
   - Regex outlines for JS/TS (`function`, `class`, `export const … =>`, methods), Python (`def`/`class` with indent), C/C++ (top-level function signatures, `class`/`struct`/`namespace`), QML (`Item {`-style object ids and `function`), Markdown (headings), and JSON/YAML (top-level keys).
   - Each entry is `L<start>-L<end>  <signature>`, where the end is the next entry's start minus 1.
   - Cap at 40 entries with a `… N more` line. Read at most 1MB.
   - Unknown language → no outline, size line only.

**Tests:**
- advise output unchanged at the default;
- deny for a 3000-line `.js` → deny shape, outline present with correct ranges;
- immediate repeat → allowed;
- bounded Read → allowed;
- `.png` → never denied;
- Codex runtime → advise;
- outline fixtures for each language, including ≤40 entries and line ranges.

**Accept:** deny stays opt-in. Changing the default needs the §4 A/B.

---

## WP8: Remove dead paths and update docs

- README: new features and config keys (`bash.capChars`, `readGuard.*`, `rewrite.enabled:false`), `/tokenslim:budget`, `benchmark --transcripts`. Re-measure the README savings table with `node scripts/benchmark.mjs --format md`; do not edit numbers by hand.
- `docs/SHAPES.md`: record the WP-S result.
- `FIX_PLAN.md` belongs to v0.3.0 and is complete. Move it to `docs/history/FIX_PLAN-v0.3.0.md`, and move this plan to `docs/history/` once it is done.
- Keep both Read dedup paths and the Grep/Glob hook, as the brief recommends; no change.

## WP9: Release

Bump to `0.4.0` following `RELEASE.md` (all manifest versions identical) and run `node scripts/validate-release-version.mjs`.

## WP-S: Spike on PostToolUse vs native persistence (parallel, non-blocking)

Install a probe plugin whose PostToolUse Bash hook logs `tool_response.stdout.length` and returns `updatedToolOutput` with stdout replaced by `"PROBE " + length`. Run `claude -p 'run: python3 -c "print(\"x\"*60000)"'`, then inspect the session transcript:
- If the hook logged 60000 and the transcript `tool_result` is `PROBE 60000` with no `<persisted-output>`, the hook runs **before** persistence, and the WP4 cap covers more than 30KB too.
- If the hook logged a ~2KB preview, it runs **after** persistence. Exclude persisted results in `bash-hook` (`isPersisted`) and document it.

This needs a real Claude Code with credentials. If the implementer cannot run it, leave a note for the maintainer.

---

## 4. Quality gate before any default change (maintainer-run)
`bash.capChars>0` or `readGuard.mode:'deny'` becomes a default only if all of the following hold:
1. WP1 replay shows savings on the maintainer's transcripts;
2. a blinded A/B on a fixed set of 8–10 real engineering tasks (tokenslim feature on vs off, same model, graded by a judge that cannot see the condition) scores within noise;
3. the WP5 recovery rate stays at or below 15% over a week of real use.

## 5. Explicitly not doing
MCP JSON minify (≤8%), cross-tool block dedup (0.8%), further Read dedup (≈0), timestamped-log factoring (0.7%), diff-header trimming, adaptive or self-tuning caps, and segment-aware rewrites (security).

## 6. Expected outcome (from the brief's measurements, adjusted)
- Tool-output side: WP3 (~1%) plus WP4 when enabled (~7%) on top of today's 1.7%, giving about 8–10% of tool-result text. The brief's 12–14% assumed F4 advisory savings, which this plan does not count.
- Fixed-overhead side (WP2): most of the "relevant again" gain, but delivered as a report the user acts on. The real share depends on how much of the overhead is prunable (§0 correction 7).
