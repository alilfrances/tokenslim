# tokenslim v0.4.1 / v0.5.0 fix plan

Source: review of v0.4.0 (`a0ab676`), which reported three defects. Each claim was reproduced against `main` before writing this plan. The plan follows the format of `docs/history/PLAN-v0.4.md`, and the ground rules there (§1) still apply: no dependencies, fail-open, `isolatedEnv()` in every test that spawns a process, verbatim kept lines, accurate markers, one commit per WP, and the full gate before each commit.

- **Fix release v0.4.1:** WP1 and WP2 (defects 1 and 2). These are small and safe to ship immediately.
- **Feature release v0.5.0:** WP3 to WP6 (defect 3). These change defaults only after the quality gate in §4.

---

## 0. Verdicts

### Defect 1: "Grep hits silently dropped". **Confirmed, high severity. Partly pre-existing, and 0.4.0 makes it more frequent.**

I reproduced it on `main` with 18 grep hits across 3 files, where each file has 6 hits on the same line text (`assert.equal(result.status, 0, result.stderr);`):

```
tests/pipeline.test.mjs
  40:    assert.equal(result.status, 0, result.stderr);
[tokenslim: 5 more similar lines collapsed]
...                                   → 3 of 18 hit locations survive
```

**Cause.** When `groupByPath` fires, `bash-hook.mjs` `compressed()` runs the whole generic pipeline over the grouped text (`compressBashOutput(shaped.text)`). `collapseRepeatedLines` replaces every number in its line fingerprint and accepts a run when about 60% of the tokens match. Grep hits whose text is the same and whose line numbers differ therefore collapse into a single line plus a count, and the locations are lost.

**On "0.3.2 never reached this path".** Not quite. v0.3.2's generic pipeline makes the same collapse on raw `path:line:text` output, as tested with the same input. The difference is the ratio gate.
- In 0.3.2, the collapse alone usually saved under 10%, so the 0.9 gate threw the whole result away and the output passed through untouched.
- In 0.4.0, grouping adds about 20% savings, so grouping plus collapse passes the gate and the lossy collapse comes along.
- So 0.4.0 turned a mostly dormant bug into a live one. The reviewer's 11 of 270 grouped outputs is consistent with this.

**Why "silently".** The marker shows a count but no locations. The original is saved to the tee file only at 4KB or more, so small grep outputs (the common case) cannot be recovered. This breaks invariant I5 ("every lossy elision carries a marker with an accurate count"). The count is accurate, but grep output exists to report locations, so a count alone is not enough.

### Defect 2: "Failing test names lost in odd output". **Confirmed in the function; rarely reachable through the hook. The reviewer's "real escapes are fine" is wrong.**

`summarizeTestRunners` on jest output whose escape codes are the **literal text** `\u001b[31mFAIL\u001b[39m src/sum.test.js` keeps only the two summary lines. It loses the `FAIL` file line, the `● sum › adds numbers` name, and the `Expected: 4` / `Received: 5` lines. The cause is commit `9ec3444` (0.4.0), which removed the optional literal-escape prefix from the FAIL regex and converted the fixtures that covered this case to real bytes.

Two extra findings:
- **Real escape characters are not fine either.** v0.3.2 and v0.4.0 both drop `Expected:` / `Received:` on real-ESC jest output. The failure block ends at the first blank line, and jest puts a blank line between the test name and the assertion detail. This loss predates 0.4.0.
- **The hook rarely reaches it.** Both variants come back `skippedFailure` from `processBashPayload`, because `FAILURE_RE` matches `1 failed` and the output passes through untouched.
  - It is reachable only when the failure gate misses: output cut before the summary (`npx jest 2>&1 | head -80`), mocha's indented `Error:` lines, or literal-escape logs where `^FAIL` does not match.
  - The fixture benchmark (`npm-test-failing.txt` shows an 85.7% pipeline reduction) runs it directly, which is how the review saw it.

### Defect 3: "Bash savings 2.42% vs the 12–14% target". **The number is expected. The target was never reachable with lossless defaults.**

- The 12–14% came from the original brief, which assumed:
  - the mid-band cap is **on by default** (about 7%);
  - the advisory outline saves tokens (about 4.7%). It cannot: the Read still runs in full. See correction 2 in PLAN-v0.4 §0.
- PLAN-v0.4 §6 already revised this to roughly 8–10% *with the cap enabled* and lossless-only gains at defaults.
- The brief's own lossless measurements add up to about 3% (grep grouping about 1%, cross-tool repeats about 0.8%, the rest smaller), and its generic re-run saved 0.03%. So 2.42% at defaults sits right at the lossless ceiling.
- Fixing defect 1 will lower that number slightly. Those savings came from dropped locations.
- **A bigger number needs a different mechanism, not cleverer compression of dense output.** Let the model choose which part of a large output it needs, and keep every dropped byte recoverable. WP3 to WP6 describe that architecture. Measured locally, whole-file dumps (`cat F`, `nl F`, `sed -n '1,$p' F`) are **35.8%** of Bash output chars, and dumps over 400 lines are **16.5%**. This corpus is small and biased (sessions that reviewed code), so WP3 first measures it on the maintainer's transcripts.

---

## v0.4.1: fix release

### WP1: Grep hit locations are never dropped (defect 1)
**Files:** `scripts/lib/bash-hook.mjs`, `scripts/lib/pipeline.mjs`, `scripts/lib/shape-compressors/grep.mjs`, tests.

1. **Shape path runs only display-only cleanup.** In `compressed()`, after `compressShapeOutput` fires, apply `stripAnsi` and CRLF normalization, not `compressBashOutput`. Grep-shaped output has no progress bars, test runners or stack traces worth removing, and this restores the shape path's lossless guarantee. With nothing lossy left, the `lossless` computation becomes `shaped.lossless === true`.
2. **Defense in depth in the generic pipeline.** `collapseRepeatedLines` must never merge two lines that carry *different* locations.
   - Treat these as location-bearing: the raw grep forms `^(path):(\d+)[:-]` and the grouped member form `^\s{2}\d+[:-]`.
   - Export the matcher from `grep.mjs`; do not duplicate the regex.
   - A run may include a location-bearing line only if the raw lines are **byte-identical**. A run of byte-identical lines keeps today's marker.
   - This also fixes the pre-existing 0.3.2 case on raw grep output that misses the shape thresholds (for example, under 60% grep lines).
3. **Optional lossless gain (keep only if the round-trip test passes).** Inside a grouped file, consecutive members whose *text after the line number* is byte-identical become one line listing the line numbers, `  40,47,54,61:    assert.equal(...)`.
   - Extend `ungroup()` to expand the list. Prove byte-exact round-trip on every shape fixture and on the reproduction above.
   - Context lines (`-` separator) are never merged.
4. **Tests.**
   - The exact reproduction: all 18 `(path, line)` pairs must be present, with no `collapseRepeatedLines` in `rulesApplied`.
   - A raw-form reproduction through the generic path.
   - A **location-preservation invariant** run on every bash fixture, shape fixture and the WP1 reproductions: the set of `(path, line)` pairs parsed from the input equals the set recoverable from the output (via `ungroup` when grouped).
   - A replay assertion that no result reports both `groupByPath` and `collapseRepeatedLines`.
5. **Replay audit.** Add `--audit` to `benchmark.mjs --transcripts`. It counts results where the input's grep-location set is not recoverable from the output and prints those as `locationLoss: N`. This must be 0 after WP1. It also gives the maintainer a reproducible version of the "11 of 270" check.

### WP2: Failing tests keep names and assertion detail (defect 2)
**Files:** `scripts/lib/pipeline.mjs`, `scripts/lib/cmd-compressors/shared.mjs`, `scripts/lib/bash-hook.mjs`, fixtures, tests, the README table (regenerated only).

1. **A detection view that never changes output.** Add `detectionText(line)`, which strips real ESC sequences **and** literal escape spellings (`\u001b[..m`, `\x1b[..m`, `\033[..m`, `\e[..m`) and is used **only for regex matching**. Kept lines stay verbatim; this keeps the I2 guarantee that 0.4.0 established.
   - Use it in `isTestOutput`, `TEST_SIGNAL_RE`, `FAIL_LINE_RE`, the failure-block start test in `summarizeTestRunners`, and `FAILURE_RE` matching in `failureOutput`/`hasFailure`. Literal-escaped failing output is then recognized as a failure and passes through untouched, as real-ESC output already does.
2. **Failure blocks survive blank lines.** An indented failure block continues across blank lines until a line that starts a new file or test header (PASS/FAIL/ok/not ok, pytest `___ name ___`, go `--- FAIL`), a summary line, or a non-blank non-indented line.
   - Inside a failure region, never drop a line matching `/\b(Expected|Received|expected|actual|Difference|Assertion)/`.
   - Covers jest `●` blocks, pytest sections and mocha numbered failures.
3. **Fixtures.**
   - Keep the real-byte fixtures.
   - **Add back** the literal-escape variants as separate files: `npm-test-failing-literal-escapes.txt` and `cargo-build-literal-escapes.txt`.
   - Add `jest-failing-blank-lines.txt` with real ESC and a blank line between the name and the `Expected`/`Received` lines, plus a truncated variant without the summary (the `| head` case).
   - Register them in `FIXTURE_COMMANDS` and regenerate the README table with `node scripts/benchmark.mjs --format md`; never hand-edit it.
4. **Invariant test.** For every test-runner fixture that contains failures, every failing test name (`FAIL <file>`, `● <name>`, `FAILED <nodeid>`, `--- FAIL: <name>`) and every `Expected`/`Received` line in the input appears verbatim in the output, both from the pipeline and from the hook.

### WP-R1: Release v0.4.1
Bump the manifests per `RELEASE.md`. The PR body lists both fixes and the verdict nuances above. Tag after merge (the maintainer pushes the tag).

---

## v0.5.0: reaching double-digit savings without losing accuracy (defect 3)

Design principle: **no blind truncation of content the model asked for.** A large output is replaced by a structural map, and the model asks for exactly the part it needs. Everything stays recoverable, every new behavior ships opt-in, and a default changes only after the §4 gate.

### WP3: Measure first, then build (replay classification)
Extend `benchmark.mjs --transcripts` with `--classify`. It buckets Bash results by output kind, using the WP4 detector and `shell-segments.mjs`:
- whole-file dump, broken down by line count (≤400, 400–2000, over 2000);
- grep-shaped;
- path lists (`find`, `ls -1`, `git ls-files`);
- test runner;
- JSON;
- other.

For each bucket it reports chars and the cost-weighted share. For file dumps it also reports an **upper bound** on WP4 savings: dump chars − outline chars, assuming no follow-up read. The real figure needs the live A/B, because the model reads some ranges afterwards. **Go/no-go:** build WP4 only if file dumps over the threshold make up at least 8% of Bash chars on the maintainer's 30-day corpus.

### WP4: Outline-first for Bash file dumps (the main lever)
A PreToolUse Bash hook that extends `guard-read.mjs`. It is a separate script, or a mode of `rewrite-bash.mjs` that never rewrites.
- **Trigger.** The command's final segment (via `shell-segments.mjs`, inspection only) is a whole-file dump of a single text file: `cat F`, `nl F`, `sed -n '1,$p' F`, or `head -n N F` with N above the threshold. A leading `cd X &&` is allowed.
  - The file resolves to a regular file that passes the read-guard text allowlist and is over `readGuard.lines` or `bytes`.
  - Pipes into other tools (`cat F | grep x`), redirects, globs and multiple files are **not** triggered.
- **Action.** `permissionDecision: "deny"` with the WP7 outline and the text: "Read it with the Read tool using offset/limit, or `sed -n 'a,bp'` for the range you need. Repeating this exact command returns the full output."
  - It reuses `consumeGuardDeny`, keyed by a sha256 of `cwd + command`, so repeating the command is always allowed.
  - **Deny only.** It never returns `allow` and never rewrites, so it cannot bypass permissions.
- **Config:** `bashGuard: { mode: 'off'|'deny', lines, bytes }`, default `off`, and env `TOKENSLIM_BASH_GUARD_MODE`. Codex and a missing `session_id` fall back to no-op.
- **Stats.** Count `bashGuard.denied` and `bashGuard.repeated`. A repeat rate above 30% means the outline was not enough and the threshold should go up. This is the same idea as the cap's recovery rate.
- **Tests:** every trigger and non-trigger form, the escape hatch, the 3rd-read cycle, no raw command or path in state, binary and non-text files never denied, fail-open on stat errors, and Codex fallback.

### WP5: Cheap lossless shapes, kept only if measured
Ship each one only if `--classify` shows at least 0.5% of Bash chars for its bucket on the maintainer corpus:
- **`pathList` shape:** for output where 80% or more of lines are paths (`find`, `ls -1`, `git ls-files`), print a directory header followed by indented basenames. It is lossless, with an `ungroup`-style round-trip test, and reuses WP1's identical-line logic where relevant.
- **WP1.3 identical-hit lists:** may already be shipped in v0.4.1.
- **Not doing:** JSON minification of Bash output. It is risky when the model copies text from `cat file.json` into an Edit, and for tokens rather than chars the gain is small.

### WP6: Defaults, after the gate
Once §4 passes:
1. `bashGuard.mode: 'deny'` and `readGuard.mode: 'deny'` become defaults with conservative thresholds (start at 800 lines or 40KB; tune from the repeat rate).
2. `bash.capChars: 12000` becomes the default **for non-file-dump output only**, since file dumps are WP4's job. The cap stays tee-guarded, and its recovery rate must stay at or below 15%.
3. Stats and the README report savings as **cost-weighted share of tool-result tokens and of total input**. `/tokenslim:budget` covers the fixed-overhead side, which is still the largest single lever.

**Expected effect (to verify, not promise):** lossless defaults about 2.5–3%. With WP4 and the cap enabled, roughly 10–15% of Bash tool-result text on file-dump-heavy corpora. The live A/B decides, not the replay.

---

## 4. Quality gate (required before WP6; maintainer-run)
Same as PLAN-v0.4 §4, with three additions:
- the WP4 repeat rate stays at or below 30%;
- the WP1 replay audit shows `locationLoss` = 0;
- the WP2 invariant holds on all fixtures.

The A/B uses the same model and 8–10 real tasks, graded blind; accept only if the score stays within noise.

## 5. Order
WP1 → WP2 → WP-R1 (release 0.4.1) → WP3 (measure; go/no-go) → WP4 → WP5 → §4 gate → WP6 → release 0.5.0.
