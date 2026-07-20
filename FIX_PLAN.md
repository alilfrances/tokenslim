# tokenslim Fix Plan — v0.3.0 evaluation findings

Full evaluation of the codebase as of `5faf963` (Feat/surpass rtk 0.3.0). Every finding
below was **reproduced against the real code** (unit-level and, for the critical ones,
end-to-end through the actual hook entrypoints) — none are speculative. All 120 existing
tests pass while these bugs exist: the suite has only positive-path coverage (compression
works on test-like fixtures) and no negative controls (non-matching content must pass
through untouched). Every work package therefore adds negative-control tests.

Guiding priorities, in order:
1. **Zero false positives** — compression must never destroy or hide content the agent
   needs. A false positive costs more tokens than it saves (retry loops, re-reads,
   failed Edits, wrong conclusions).
2. **No agent dumb-down** — kept content must be sufficient to act on (line numbers,
   diff hunks, match locations).
3. **Maximum token conservation** — subject to 1 and 2. Several fixes below *increase*
   real-world savings by unblocking compression that currently never fires.

## Global invariants (apply to every WP; add as shared test helpers first)

- **I1 — Never emit empty/near-empty output.** If a compressor's result is empty or
  loses >90% of a non-test, non-summary input, pass the original through. Today the
  hook can replace 5KB of file content with a bare `[tokenslim: ...]` marker.
- **I2 — Kept lines are verbatim** (already claimed by README; several rules violate it).
- **I3 — Determinism** (unchanged; do not regress).
- **I4 — Fail-open** (unchanged; do not regress).
- **I5 — Every lossy elision carries a marker with an accurate count.**

Suggested execution order: WP1 → WP2 → WP3 (critical false positives), then WP4/WP5
(agent capability), then WP6 (savings unlock, biggest real-world token win), then the
rest in any order. WPs are independent unless noted.

---

## WP1 — CRITICAL: `summarizeTestRunners` fires on non-test output and can delete everything

**Files:** `scripts/lib/pipeline.mjs` (`isTestOutput`, `SUMMARY_RE`,
`summarizeTestRunners`), `tests/pipeline.test.mjs`

**Defect.** `isTestOutput` uses one case-insensitive regex with two over-broad
alternatives, and its false positives are amplified by a boundary inconsistency with
the protective gates:

- `(?:^|\s)(?:FAIL|PASS)\s+\S+` matches ordinary prose such as `pass the event` or
  `fail gracefully` in comments/docs/source.
- `::.*(?:PASSED|FAILED)` was written for pytest node-ids
  (`tests/foo.py::test_bar PASSED`) but has **no word boundary and no anchor**, so it
  substring-matches C++/Rust/PHP scoped identifiers: `Status::PREPARE_FAILED`,
  `State::UPLOAD_PASSED`, `crate::mod::TEST_PASSED`. Confirmed against a real user
  report (Qt C++ codebase): an 11-line C++ snippet containing
  `Status::PREPARE_FAILED` classifies as test output.
- **Why the protective gate doesn't save it:** `failureOutput`/`FAIL_LINE_RE` use
  `\bFAILED\b` — in `PREPARE_FAILED` the underscore is a word character, so there is
  no boundary and the failure gate does NOT trip. The file then takes the *passing*
  branch, which keeps only `SUMMARY_RE` lines — for source/prose that is usually
  **zero lines**. Confirmed: the C++ snippet compresses 792 → 0 bytes. (Bare
  `Status::FAILED` *does* trip the gate and passes through untouched — so codebases
  using underscore-compound enum values like `PREPARE_FAILED`/`UPLOAD_FAILED` hit the
  worst path systematically, matching the user's "triggered a lot in one codebase"
  observation.)

Also confirmed end-to-end: `cat` of a 5KB guide containing "pass the token" came back
as a bare marker (0 content bytes).

**Fix spec.**
1. Make runner detection case-sensitive and anchored to real runner formats, e.g.:
   `^(?:PASS|FAIL)\s+\S+` (jest/vitest), `^ok\s+\d`, `^not ok\s`, `^\d+ passing\b`,
   `Test Suites:`, `Test Files\s`, `^test result:`, `^=+ .* (?:passed|failed).* =+$`,
   `^(?:PASSED|FAILED|ERROR)\s*:`. The pytest node-id alternative must require the
   status as a standalone terminal word: `::\S+\s+(?:PASSED|FAILED|ERROR|SKIPPED)\s*$`
   (case-sensitive) — never a bare `::.*FAILED` substring, which matches scoped
   identifiers like `Status::PREPARE_FAILED`. Drop the bare `cargo test` / `go test`
   substring alternatives (they match prose *about* those commands).
2. Require **two distinct** signal lines, or one signal line plus a summary line,
   before classifying output as test output.
3. In the passing branch: if the filtered result is empty, return the input unchanged
   (invariant I1).
4. In `compress-bash.mjs`, add the I1 backstop: if final compressed stdout (before
   marker) is empty while input was non-empty and no specialized compressor claimed it,
   pass through.

**Acceptance tests.**
- Prose/source fixtures containing "pass the X", "should pass", "fail gracefully",
  a Qt C++ snippet with `// pass ownership to the caller` → byte-identical output.
- A C++ scoped-enum fixture (`enum class Status { PREPARE_FAILED, UPLOAD_PASSED };`
  plus usage `Status::PREPARE_FAILED`) → byte-identical output. Cover Rust
  (`crate::state::TEST_PASSED`) and lowercase variants too.
- A real pytest node-id line (`tests/test_x.py::test_y PASSED`) still classifies and
  summarizes.
- Existing jest/pytest/cargo fixtures still summarize as before.
- Empty-result guard: any input whose summarization yields '' passes through.
- Boundary-consistency check: any token that trips `isTestOutput` in a "failure-ish"
  form must also be visible to the failure gates, or must not trip detection at all
  (no more underscore-compound blind spot).

---

## WP2 — CRITICAL: `stripProgressNoise` deletes markdown "- " bullet lines

**Files:** `scripts/lib/pipeline.mjs` (`isProgressNoise`), `tests/pipeline.test.mjs`

**Defect.** The spinner heuristic `^[|/\\-]\s+` treats any line starting with `- `
(dash + space) as spinner noise. Every markdown bullet, YAML list item, or CLI help
line formatted `- option: ...` in Bash output is silently deleted, no marker.
Confirmed: `- first item` / `- second item` dropped from output.

**Fix spec.** A spinner frame is a spinner character *alone* or followed by
progress-like content, not by words. Replace with something like:
`/^[|/\\-]$/` OR `/^[|/\\-]\s+(?=[\d\[])/` (spinner + counters/bars only). Never strip
a line containing 2+ consecutive word characters after the leading symbol.

**Acceptance tests.** Markdown bullet lists, YAML `- item` lists, `ls -l` style output
survive byte-identical; real spinner frames (`/ 12%`, `| downloading`, `- 3.2MB/s`)
are still stripped. Re-run fixture benchmark; docker-pull reduction must not regress
materially.

---

## WP3 — CRITICAL: `collapseRepeatedLines` silently deletes unique interleaved lines; marker overcounts

**Files:** `scripts/lib/pipeline.mjs` (`collapseRepeatedLines`, `flushRepeat`),
`tests/pipeline.test.mjs`

**Defect A (data loss).** A single non-matching line between two runs of similar lines
is buffered in `gap` and then **discarded** when the run resumes
(`if (current === fp) { buffer.push(line); gap = []; }`). Confirmed:
`fetch 1 / fetch 2 / IMPORTANT: unique warning / fetch 3 / fetch 4` →
`fetch 1 / [tokenslim: 4 similar lines collapsed]` — the warning is gone, unmarked.

**Defect B (miscount).** `flushRepeat` prints `buffer[0]` plus
"`buffer.length` similar lines collapsed" — the count includes the line shown, so the
marker overstates by one.

**Defect C (over-generalization).** `fingerprintLine` replaces all numbers/hex, so 30
*distinct* meaningful rows differing only in numbers (`port 3000 -> instance 0` …
`port 3029 -> instance 29`) collapse to one line + marker. The agent cannot see values
it may need. Confirmed.

**Fix spec.**
- A: when a run resumes across a gap line, first emit the gap line(s) into `output`
  (order-preserving), never clear them unseen. Simplest correct form: on
  `current === fp` with non-empty gap, flush buffer, emit gap, start new buffer.
  Alternative: only bridge gaps that are themselves blank.
- B: marker count = `buffer.length - 1` ("N more similar lines collapsed").
- C: tighten the collapse precondition: require the *raw* lines to share a common
  prefix of ≥16 chars (or ≥60% common tokens) in addition to equal fingerprints, and
  require run length ≥ 4 before collapsing. Numbered-but-distinct listings then survive.

**Acceptance tests.** Interleaved-unique-line case preserves the unique line; counts
are exact; the port-mapping listing passes through; npm reify spam still collapses.

---

## WP4 — HIGH: git compressors destroy content the agent explicitly asked for

**Files:** `scripts/lib/cmd-compressors/git.mjs`, `tests/cmd-compressors.test.mjs`

**Defects (all confirmed).**
- `diff()`: for any file with >12 changed lines, all hunks are dropped — output is just
  `src/app.js (+20/-0)`. `git diff` output *is* the deliverable; the agent cannot
  review changes it cannot see. (Generic pipeline would have left it alone as dense.)
- `log()`: `git log -p`, `git log --stat`, `git log --graph` are reduced to
  `hash subject` lines; patches/stats silently deleted.
- `status()`: the branch line `## main...origin/main [ahead 3]` loses `[ahead 3]` —
  the agent can no longer tell a push is needed.
- `push/pull/fetch/add/commit` → "last line only" is unreachable in practice (their
  output is on stderr, see WP6) but when reachable it drops merge summaries.

**Fix spec.**
- `diff`: never elide hunk content. Acceptable compression: strip `index`/mode lines
  and collapse pure-context runs >6 lines to a marker. If that saves <10%, pass through.
- `log`: bail out (return null) when tokens include `-p`, `-u`, `--patch`, `--stat`,
  `--graph`, `--name-status`, `--name-only`, or any `-L`/`-S`/`-G`.
- `status`: preserve everything after the branch name on the `## ` line (ahead/behind,
  gone). Keep per-file lines as today.
- `pull`: keep the full merge/ff summary block, not `.at(-1)`.

**Acceptance tests.** 20-line-change diff keeps every +/- line; `git log -p` passes
through; ahead/behind survives; small-diff fixture behavior unchanged.

---

## WP5 — HIGH: linter compressor drops line numbers and messages (breaks fix workflows, contradicts README)

**Files:** `scripts/lib/cmd-compressors/linters.mjs`, `tests/cmd-compressors.test.mjs`

**Defect.** Diagnostics are grouped to `file | rule: count`. Line numbers and messages
are deleted — confirmed: `12:5 error Unexpected var no-var` becomes
`/src/app.js | no-var: 1`. README promises "Never touched: … file paths, line numbers".
An agent asked to "fix the lint errors" now has to re-run the linter (whose output gets
compressed the same way) or guess.

**Fix spec.** Keep one verbatim line per diagnostic (file, line:col, rule, message) —
compress by deduplicating *identical* messages beyond the first 3 per file+rule with a
counted marker, and by dropping decorative/summary noise only. eslint/tsc/ruff output
is already dense; expected savings are modest and that is correct behavior.

**Acceptance tests.** Every distinct diagnostic's file, line, rule, and message survive;
50 identical `no-console` hits in one file collapse to 3 + marker with exact count;
`npx eslint`/path-prefixed binaries also dispatch (see WP8).

---

## WP6 — HIGH (biggest savings unlock): any non-empty stderr disables all Bash compression

**Files:** `scripts/compress-bash.mjs` (`failureOutput`), `scripts/lib/cmd-compressors/shared.mjs`
(`hasFailure`), `tests/` (new end-to-end hook tests)

**Defect.** `failureOutput` returns true whenever `stderr.trim()` is non-empty, and the
hook then passes everything through. But healthy tools routinely write to stderr:
cargo/rustc emit *all* build progress there, npm prints warnings there, git
push/pull/fetch/clone write progress there, curl/docker write progress there. Net
effect, confirmed by inspection:
- the marquee fixtures (cargo-build 85%, npm-install 98.6%) essentially **never
  compress in production**;
- the `gitOperation` compressor is dead code for push/fetch/pull;
- README's benchmark table overstates real-world savings because `benchmark.mjs` calls
  the pipeline directly, bypassing this gate (see WP12).

Additionally `FAILURE_RE` (used both here and in `hasFailure`) matches successful
output: `test result: ok. 5 passed; 0 failed` (cargo), any text mentioning "error"
(logs about error handling, grep results, docs) — confirmed. Those outputs are never
compressed either.

**Fix spec.**
1. Failure signal = `FAILURE_RE.test(stderr)` OR structured failure markers in stdout —
   not stderr presence. (Claude's Bash tool_response has no exit code per
   docs/SHAPES.md; if one is ever observed, prefer it.)
2. Fix `FAILURE_RE` false positives: do not match zero counts
   (`\b0 (?:failed|errors)\b` must not trigger), require anchored/structured forms
   (`^Error:`, `\bFAILED\b` case-sensitive, `panicked at`, `fatal:` at line start), and
   drop the bare case-insensitive `ERROR` word-match.
3. When only stdout is failure-free, still compress stdout and apply *conservative*
   stderr rules (stripAnsi + stripProgressNoise only; keep everything else verbatim).
4. Keep the existing rule that genuinely failing output passes through untouched.

**Acceptance tests (end-to-end through `compress-bash.mjs`).**
- cargo build payload with stdout='' and typical stderr compiles down (progress
  stripped, warnings kept).
- `npm install` with a deprecation warning on stderr still compresses stdout.
- cargo test pass summary containing `0 failed` compresses.
- A payload with `error[E0308]` in stderr passes through untouched.

**Dependency:** land WP1–WP3 first (this WP widens the funnel into the generic
pipeline, so its false positives must be fixed before more traffic reaches it).

---

## WP7 — HIGH: runtime misdetection can halt a Claude agent (`continue:false`)

**Files:** `scripts/lib/hook-output.mjs` (`detectRuntime`), `tests/` (new detection matrix)

**Defect (confirmed).** Claude Code hook payloads include `permission_mode`, and newer
builds include `tool_use_id` (and can include `model`). Two rules misfire:
- `('model' in payload && 'cwd' in payload && 'tool_use_id' in payload)` → codex — and
  this branch **outranks** `CLAUDE_PLUGIN_ROOT`;
- `'permission_mode' in payload` → codex when `CLAUDE_PLUGIN_ROOT` is unset (manual
  hook installs, statusline-less setups).
On misdetection, every compressed PostToolUse returns `continue:false` +
`stopReason`, which stops the Claude agent's turn after each tool call — worst-case
behavior for a plugin whose job is to help the agent.

**Fix spec.** Detect Codex only on *positive, Codex-unique* markers: `turn_id` in
payload, or `CODEX_PLUGIN_ROOT`/`PLUGIN_DATA` env without `CLAUDE_PLUGIN_ROOT`.
Remove the `permission_mode` rule (it is a documented Claude field) and the
`model+cwd+tool_use_id` rule. `TOKENSLIM_HOOK_RUNTIME` override stays. Default remains
`claude` (its output shape is a harmless no-op under Codex compared with the reverse).
Document a live-verification matrix in docs/SHAPES.md (payload keys seen per runtime
per version).

**Acceptance tests.** Claude payload with permission_mode/tool_use_id/model, env empty
→ `claude`. Codex payload with turn_id but CLAUDE_PLUGIN_ROOT set (Codex compat env)
→ `codex`. Existing codex fixture payloads keep detecting codex.

---

## WP8 — MEDIUM: Read whitespace-slimming makes the model's view diverge from disk (breaks Edit)

**Files:** `scripts/compress-read.mjs` (`slimText`), `tests/read-grep.test.mjs`

**Defect (confirmed).** First reads strip trailing whitespace and collapse 3+ blank
lines to 1. Edit requires exact `old_string` match against the *disk* content; an
agent that copies from its slimmed view fails to match whenever the span includes
stripped trailing spaces or a collapsed blank run. Failed Edits trigger retry loops or
full-file `Write` rewrites — a net token *loss* and a correctness hazard.

**Fix spec.** Remove content-mutating slimming from Read entirely; keep the dedup-stub
path (that is where the real savings are — "~99% on re-reads"). If any slimming is
retained, restrict it to non-editable contexts (e.g. files the agent cannot Edit is not
knowable → prefer removal). Update README ("whitespace-only slimming" claim).

**Acceptance tests.** First-read output is byte-identical to `file.content`; dedup stub
still fires on unchanged re-read; savings ledger no longer records first-read events.

---

## WP9 — MEDIUM: Read dedup stub can strand the agent after context compaction

**Files:** `scripts/compress-read.mjs`, `tests/read-grep.test.mjs`

**Defect.** The stub says "Content already in context above", but after Claude's
auto-compaction the earlier read may be summarized away. The re-read returns the stub
again (hash unchanged) — the agent has no in-tool path back to the content and may act
on a false belief that it has it.

**Fix spec.**
1. Append an explicit escape hatch to both stub variants:
   "If the content is no longer in context, re-read with offset/limit (bounded reads
   bypass this stub)." — bounded reads already bypass dedup (`hasBoundedRead`), so this
   is documentation of a real, working escape.
2. Optional hardening: cap stub reuse — after N consecutive dedup hits for the same
   path without an intervening Edit/Write, serve full content once and reset.

**Acceptance tests.** Stub text contains the escape hint; bounded read after a stub
returns full content (existing behavior, now asserted); optional counter behavior.

---

## WP10 — MEDIUM: Grep/Glob compression hides locations the agent may need to enumerate

**Files:** `scripts/compress-grep.mjs`, `tests/read-grep.test.mjs`

**Defects (confirmed).**
- Grep content mode: >3 consecutive matches per file → only first 3 survive plus a
  count. An agent enumerating all call sites (rename/refactor) cannot recover the rest;
  re-running Grep re-compresses identically. Also `dedupExactLines` merges `--` context
  separators, so `-A/-B/-C` blocks visually merge.
- Glob >100 files: per-directory summaries show only 5 basenames + `...`; remaining
  names are irrecoverable.

**Fix spec.**
- Grep: replace omitted match *content* with a compact location list —
  `... [tokenslim: 5 more at src/handlers.js:31,38,45,52,59]`. Enumerability is
  preserved; savings stay large (content is the expensive part). Skip dedup for pure
  `--` separator lines.
- Glob: group by directory but list **all** basenames (dropping the repeated dir
  prefix is the savings); only elide with `...` beyond a much higher per-dir cap
  (e.g. 50), keeping an exact count.

**Acceptance tests.** All match line numbers recoverable from compressed Grep output;
context-mode output keeps separators; Glob compressed output contains every basename
up to the cap; savings ratio still ≥10% on the repetitive fixtures.

---

## WP11 — MEDIUM: package-manager summary drops security/deprecation lines

**Files:** `scripts/lib/cmd-compressors/package-managers.mjs`, `tests/cmd-compressors.test.mjs`

**Defect (confirmed).** Only the last "added N packages…" style line is kept.
`npm warn deprecated`, `N vulnerabilities (X moderate, Y high)`, and peer-dependency
warnings are deleted. Security-relevant signal is lost, and the agent may re-run
`npm audit` (more tokens) or miss it entirely.

**Fix spec.** Keep, in addition to the summary line: lines matching
`/\bwarn\b|deprecat|vulnerabilit|peer dep|EBADENGINE|ERESOLVE/i` (deduped with counts
if repeated). Everything else as today.

**Acceptance tests.** Deprecation and vulnerability lines survive; clean install still
compresses to ~1–3 lines.

---

## WP12 — MEDIUM: benchmark and README overstate production behavior

**Files:** `scripts/benchmark.mjs`, `README.md`, `tests/benchmark.test.mjs`

**Defect.** `benchmarkFixtures` calls the pipeline directly, bypassing the production
gates (`failureOutput`, minChars, 0.9 ratio, marker overhead). With today's
`failureOutput`, several showcased fixtures (cargo-build, npm-install with warnings,
git push/pull) cannot compress in production at all — the README table is a best-case
that the shipped hook does not deliver.

**Fix spec.** After WP6 lands: add an end-to-end mode that pipes each fixture through
`compress-bash.mjs` as a real payload (stdout/stderr split per tool reality — e.g.
cargo fixture on stderr) and report *those* numbers in the README, alongside the pure
pipeline numbers. Regenerate the table.

**Acceptance tests.** Benchmark test asserts end-to-end reductions within a tolerance
of pipeline reductions for stdout-only fixtures, and nonzero for stderr-carried ones.

---

## WP13 — LOW: assorted hardening (batchable)

**Files:** as noted; `tests/` for each.

1. `compress-bash.mjs`: skip compression when `tool_response.isImage === true`
   (image payloads must never be text-mangled).
2. Binary normalization for dispatch and `failureOutput`'s linter allowlist: strip
   leading env assignments (`FOO=1 eslint …`), take path basename
   (`./node_modules/.bin/eslint`), and unwrap `npx`/`pnpm exec`/`yarn` prefixes so
   linters/test runners dispatch correctly. (`scripts/lib/cmd-compressors/index.mjs`,
   `compress-bash.mjs`, reuse `privacy.mjs` token-walk logic.)
3. `rewrite-rules.mjs`: `hasVerboseFlag`'s `^-v+` also matches `-version`; anchor it
   (`^-v+$`). Reconsider `mvn -q` (hides "Tests run:" summaries → agent can't confirm
   success); either drop mvn from the rewrite list or pair it with
   `-Dsurefire.printSummary=true`-safe behavior.
4. `compress-mcp.mjs` BASE64_RE: 257+ chars of `[A-Za-z0-9+/]` also matches long hex
   dumps/minified identifiers and GitHub MCP base64 file contents the agent intends to
   use. Require a `data:` / `;base64,` prefix OR (length ≥ 1024 AND valid base64
   padding) before truncating.
5. Ledger consistency: `compress-read.mjs` records char counts where Bash records UTF-8
   bytes; unify on `Buffer.byteLength`.
6. Concurrent hook writes to the same session ledger are read-modify-write races
   (parallel tool calls); acceptable for best-effort stats, but note it in state.mjs
   docs and make `saveState` write via temp-file + rename like history.mjs already does.

---

## Verification checklist for the integrator (after all WPs)

1. `node --test tests/*.test.mjs` — all green, including the new negative-control suite.
2. `node scripts/benchmark.mjs --format md` — regenerate README table (pipeline + e2e).
3. Manual smoke in a live Claude Code session (`claude --plugin-dir .`):
   - `cat` a markdown file with bullet lists and the word "pass" → byte-identical.
   - `cargo build` / `npm install` (warnings on stderr) → compressed.
   - `git diff` with a 30-line change → hunks visible.
   - eslint with errors → file:line:rule:message visible.
   - Read → Edit (file with trailing spaces + blank runs) → Edit succeeds first try.
   - Re-read unchanged file → stub with escape-hatch text; bounded re-read returns
     full content.
4. Confirm no `continue:false` ever reaches a Claude runtime (grep transcript).
