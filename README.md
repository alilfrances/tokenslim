# tokenslim

**Input-token compressor for Claude Code and Codex.** Shrinks tool results — Bash output, file
reads, Grep/Glob results, MCP tool results — *before* they enter the model's context. It
also applies conservative Bash quiet-flag rewrites, keeps the Read dedup cache warm across
Edit/Write, provides recovery copies and cross-session reporting, and warns before large
unbounded reads. Deterministic, prompt-cache safe, zero dependencies, fail-open.

## Fixture benchmark

Generated with `node scripts/benchmark.mjs --format md` on the checked-in fixture corpus.
“Pipeline” is the ideal command-aware compressor result; “E2E” is the production
`compress-bash` hook result, including thresholds, failure gates, marker overhead, and
realistic stderr routing for cargo and docker progress. Real commands vary by project.

| Fixture | Pipeline reduction | E2E bytes out | E2E reduction | Rules applied |
| --- | ---: | ---: | ---: | --- |
| cargo-build.txt | 91.9% | 701 | 66.6% | packageManagerSummary |
| docker-ps.txt | 27.6% | 232 | 0.0% | dockerTable |
| docker-pull.txt | 87.1% | 368 | 84.0% | stripProgressNoise, collapseRepeatedLines |
| eslint.txt | 1.0% | 202 | 0.0% | linterDiagnostics |
| git-diff.txt | 18.0% | 128 | 0.0% | gitDiff |
| git-log.txt | 54.6% | 983 | 53.6% | gitLog |
| git-status-porcelain.txt | 0.0% | 74 | 0.0% | gitStatus |
| go-test-json.txt | 87.4% | 261 | 0.0% | goTestJson |
| npm-install.txt | 96.9% | 172 | 96.1% | packageManagerSummary |
| npm-test-failing.txt | 85.8% | 2094 | 0.0% | stripAnsi, stripProgressNoise, summarizeTestRunners |
| pytest-failing.txt | 54.9% | 2107 | 0.0% | stripProgressNoise, summarizeTestRunners |
| pytest-passing.txt | 96.1% | 112 | 94.5% | testRunnerSummary |
| stacktrace-repeat.txt | 72.5% | 636 | 70.2% | stripProgressNoise, dedupStackTraces |
| tsc.txt | 0.4% | 238 | 0.0% | linterDiagnostics |
| webpack-build.txt | 0.0% | 2102 | 0.0% | stripProgressNoise |

Re-read stubs can save roughly 99% when an unchanged file is read again. Dense unique output
is intentionally left untouched. Savings compound because input tokens are re-sent every turn.

Pairs with [caveman](https://github.com/JuliusBrussee/caveman) (output-side compression):
caveman makes the model say less, tokenslim makes it *read* less.

## Install

Requires Node 18+ (Claude Code and Codex already require Node — no new deps).

### Claude Code

Official docs:
- Claude Code plugin discovery: https://code.claude.com/docs/en/discover-plugins
- Claude Code marketplace and CLI reference: https://code.claude.com/docs/en/plugin-marketplaces

**Option A — try it for one session:**

```bash
claude --plugin-dir /path/to/tokenslim
```

**Option B — install permanently from a local clone in an active Claude Code session:**

```bash
git clone https://github.com/alilfrances/tokenslim.git
```

Then, inside Claude Code, run:

```text
/plugin marketplace add /path/to/tokenslim
/plugin install tokenslim@tokenslim
```

**Option C — install from a local clone with the external Claude CLI:**

```bash
claude plugin marketplace add /path/to/tokenslim
claude plugin install tokenslim@tokenslim
```

**Option D — from GitHub (easiest):**

```bash
claude plugin marketplace add alilfrances/tokenslim
claude plugin install tokenslim@tokenslim
```

Inside an active Claude Code session, the equivalent commands are:

```text
/plugin marketplace add alilfrances/tokenslim
/plugin install tokenslim@tokenslim
```

### Codex

Official docs: [Codex marketplace setup](https://developers.openai.com/codex/plugins/build#add-a-marketplace-from-the-cli) and [Codex plugin CLI](https://developers.openai.com/codex/cli/reference#codex-plugin).

This repo's actual plugin id is `tokenslim`. It includes `.claude-plugin/marketplace.json`,
`.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json`.

```bash
git clone https://github.com/alilfrances/tokenslim.git
codex plugin marketplace add /path/to/tokenslim
codex plugin add tokenslim@tokenslim
```

Then restart Codex. The bundled `PostToolUse`/`PreToolUse` hooks live in `hooks/hooks.json`;
Codex may ask you to review and trust them through `/hooks` before they run.

**Claude Code optional statusline** (context % + live savings) — add to
`~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/plugins/marketplaces/tokenslim/scripts/statusline.mjs"
  }
}
```

(Adjust the path to wherever the plugin is installed; with a git clone, point directly at
`scripts/statusline.mjs` in the clone.)

**Codex statusline:** Codex currently exposes built-in footer items through `/statusline`
or `tui.status_line` in `~/.codex/config.toml`; it does not use Claude Code's
custom command statusline format. Codex also does not register this plugin's
Claude-style `commands/` files as slash commands. To view measured savings in Codex,
run `node /path/to/tokenslim/scripts/stats.mjs` (or `node scripts/stats.mjs` from
this checkout).

## What it does

Five `PostToolUse` matchers cover Bash, Read, Edit|Write, `mcp__.*`, and Grep|Glob,
replacing tool results with compressed versions before the model ever sees them. Two
`PreToolUse` matchers add a conservative Bash quiet-flag rewrite and a Read guard. Claude
Code receives structured `updatedToolOutput`; Codex receives a short `continue: false`
stop message while the compressed output is added through
`hookSpecificOutput.additionalContext`:

- **Bash** — before execution, conservatively adds quiet flags to an allowlist of commands
  without changing the binary (documented in [`docs/REWRITE-RULES.md`](docs/REWRITE-RULES.md)).
  After execution, command-aware compressors handle Git, package managers, test runners,
  linters, and container tables; the generic fallback strips ANSI/progress noise, collapses
  repeated logs and stack traces, and head+tail truncates only outputs still over 40KB.
  Failing test names and error text stay **verbatim**.
- **Read** — hashes file content per session without changing the first read. Re-reading an
  unchanged file returns a short `[tokenslim] ... unchanged since previous read` stub;
  bounded reads provide an escape hatch when prior context is unavailable.
- **Grep/Glob** — dedups identical match lines, collapses repeated match content while
  retaining omitted locations, preserves context separators, and groups huge glob listings
  by directory while retaining names up to a per-directory cap. Compact modes pass through untouched.
- **Edit/Write** — after a successful edit of a previously-read file (or any Write, whose
  full content the model authored), rehashes the file so the *next* Read dedups to a stub
  instead of re-injecting the whole file. Read→edit→re-read is one of the most common
  agent patterns; without this the dedup cache is invalidated by every edit.
- **MCP tools** (`mcp__*`) — minifies pretty-printed JSON responses (lossless) and
  truncates base64/data-URI blobs. Optional collapse of huge homogeneous object arrays
  behind `TOKENSLIM_MCP_ARRAYS=1` (off by default — items may be individually load-bearing).
- **Read guard** (`PreToolUse`) — when a Read targets a file over 2,000 lines with no
  `offset`/`limit`, injects a non-blocking hint (file size, rough token cost, suggestion to
  use `offset`/`limit` or Grep). Never blocks the read.

Every replacement is marked with a `[tokenslim: ...]` marker so you can always tell what
was compressed.

## Commands

- **`/tokenslim:tokenstats`** (Claude Code) — measured savings; supports daily, weekly,
  monthly, project, graph, JSON/CSV, and top-command views. In Codex run
  `node /path/to/tokenslim/scripts/stats.mjs --top`.
- **`/tokenslim:discover`** — read-only scan of Claude transcripts for uncompressed Bash
  token sinks and missed rewrite opportunities.
- **`/tokenslim:doctor`** — checks Node, hook wiring, scripts, writable data directories,
  active config, disabled features, and runtime detection.
- **`/tokenslim:slim-memory <file>`** — mechanical CLAUDE.md/rules slimmer: dedups
  redundant rules, strips markdown noise, keeps every directive/path/command byte-identical.
  Shows a preview and asks before writing; original backed up to `<file>.original.md`.

## Configuration (env vars)

| Var | Default | Effect |
|---|---|---|
| `TOKENSLIM_DISABLE` | – | CSV kill switch: `bash`, `read`, `grep`, `edit`, `mcp`, `readguard`, `rewrite`, `tee`, or `all` |
| `TOKENSLIM_MIN_CHARS` | `500` | Outputs smaller than this pass through untouched |
| `TOKENSLIM_MCP_ARRAYS` | off | Set to `1` to collapse >50-item homogeneous arrays in MCP JSON results |
| `TOKENSLIM_READ_GUARD_LINES` | `2000` | Read-guard hint threshold (lines) |
| `TOKENSLIM_READ_DEFAULT_LINES` | `2000` | Files longer than this are never cache-warmed after Edit/Write (Read would truncate) |
| `TOKENSLIM_TEE_MIN` | `4096` | Minimum original-output bytes before a lossy Bash/MCP result is saved for recovery |
| `TOKENSLIM_REWRITE_CODEX` | off | Set to `1` to attempt Claude-style Bash input rewriting in Codex; default is advisory only |

`TOKENSLIM_HOOK_RUNTIME=claude|codex` forces the Claude/Codex hook-output adapter when
auto-detection is not enough. `Glob` shares the Grep hook and disable path.

### Configuration files

Optional JSON config layers merge in this order: built-in defaults, user
`$XDG_CONFIG_HOME/tokenslim/config.json` (or `~/.config/...`), project
`.tokenslim.json`, then environment variables. Malformed files are ignored. The file can
set `minChars`, `disable`, `readGuardLines`, `readDefaultLines`, `tee` (`enabled`, `mode`, `maxFiles`),
`rewrite` (`enabled`, `exclude`, `dockerBuild`), and command `filters`. See
[`docs/REWRITE-RULES.md`](docs/REWRITE-RULES.md) for rewrite configuration and guards.
Project filters control successful-command output, so review `.tokenslim.json` in untrusted
checkouts.

When lossy Bash or MCP compression exceeds the tee threshold, tokenslim saves the raw
output under `$XDG_CACHE_HOME/tokenslim/tee/<session>/<tool-use>.log` and includes its
path in the marker. Set `tee.mode` to `failures` or `never` to restrict recovery copies.

### Privacy and local storage

TokenSlim has no telemetry and performs no network requests. Session ledgers, aggregate
history, transcript discovery, and recovery copies stay local. Session-ledger writes are atomic,
though concurrent tool calls may race at the best-effort read-modify-write accounting layer.
Analytics retain only command
families such as `git status`, never command arguments, URLs, headers, credentials, or inline
environment values. Project paths remain in local history for project reports. Recovery logs
contain the original raw output and may therefore contain sensitive data; disable them with
`TOKENSLIM_DISABLE=tee` or `tee.mode: "never"`. See [`SECURITY.md`](SECURITY.md) for storage
locations, permissions, and the Bash rewrite trust boundary.

## Design guarantees

- **Prompt-cache safe.** Compression happens once, at injection time, and is fully
  deterministic (same input → byte-identical output; no timestamps or randomness). The
  compressed version is the only version that ever enters conversation history, so cached prefixes are
  never invalidated.
- **Fail-open.** Any error, unrecognized shape, or oversized-input edge → the hook emits
  nothing and Claude Code uses the original output. A tokenslim bug can never lose data.
- **Accuracy-first.** Kept lines are verbatim. Never touched: error messages, exception
  types, failing test names, file paths, line numbers, identifiers, numeric literals,
  comments/docstrings. Dense output (unique lines, e.g. `git log`) is left alone rather
  than mangled — compression below 10% savings is skipped entirely.
- **Zero runtime dependencies.** Plain Node scripts, no model, no network. The benchmark reports an informational <50ms hook target; cold Node-process startup can exceed it, so measure on the target host.
- **Runtime-compatible hook output.** Claude Code gets the original structured
  replacement shape. Codex gets a short `PostToolUse` `continue: false`
  replacement plus compact output in `additionalContext`.

## Compared with RTK

RTK proxies Bash through an external binary and has a larger command registry. tokenslim
uses no binary or dependencies, prevents selected Bash noise with an in-place rewrite,
then applies command-aware and generic compression to Bash **and** native Read, Grep/Glob,
Edit/Write cache warming, and MCP results. It also provides recovery copies, JSON-based
cross-session reporting, transcript discovery, and an installation doctor. Neither tool
can guarantee a particular reduction: tokenslim passes dense or low-savings output through
rather than drop detail.

## Stacking with Cortex

[Cortex](https://github.com/alilfrances/Cortex) and tokenslim are complementary and safe
to run together: Cortex proactively *selects* which repo context enters the conversation
(graph-ranked, token-budgeted bundles over MCP), while tokenslim reactively *compresses*
tool results after they arrive. As of v0.3.1 the `mcp__*` hook also touches Cortex's MCP
results. JSON minification is lossless; marked base64 truncation is lossy and receives a
recovery copy above the tee threshold. Homogeneous-array collapsing remains opt-in via
`TOKENSLIM_MCP_ARRAYS=1`. To exempt MCP results entirely, set `TOKENSLIM_DISABLE=mcp`.
If you pipe `cortex bundle` output through Bash
instead of MCP, very large bundles (>40KB) can be head/tail truncated by tokenslim;
prefer the MCP tools.

## How savings are measured

Each hook records bytes-in/bytes-out to a per-session ledger at
`~/.cache/tokenslim/<session_id>.json`. `/tokenslim:tokenstats` in Claude Code,
`scripts/stats.mjs`, and the statusline read that ledger. Token estimates use
~3 chars/token (code-like content); cost estimates use
$3/MTok input pricing — both assumptions are documented in the code.

## Research this is built on

- **LLMLingua / LLMLingua-2 / LongLLMLingua** (Microsoft) — token-pruning literature;
  informs what must be kept (identifiers, numbers, entities) vs. dropped (redundancy).
- **"Less Context, Better Agents"** (Microsoft) — 63.9% token reduction from context
  pruning alone, with *higher* task completion.
- **Hrubec 2025, SWE-bench Verified study** — comment stripping saves 42% of tokens but
  costs 12% task-resolution rate → tokenslim never strips comments.
- **Anthropic prompt-caching docs** — exact-prefix cache matching → deterministic
  injection-time compression as a hard design constraint.
- Prior art: **RTK** (pre-execution command rewriting), **chop** (command-specific output
  filters), **Headroom** (ML-based compression at runtime). tokenslim's niche: cache-safety
  as a first-class constraint, verified tool_response *replacement* for Read/Grep (shapes
  discovered empirically — see `docs/SHAPES.md`), determinism, zero ML.

## Development

```bash
node --test tests/*.test.mjs   # test suite: rules, determinism, fail-open, release checks
```

Repo layout: `scripts/lib/pipeline.mjs` (pure compression rules), `scripts/lib/state.mjs`
(ledger + read cache), `scripts/lib/read-format.mjs` (shared Read text/hash helpers),
`scripts/compress-{bash,read,grep,edit,mcp}.mjs`, `scripts/rewrite-bash.mjs`, and
`scripts/guard-read.mjs` (hook entrypoints), `scripts/lib/cmd-compressors/` (specialized
Bash compressors), `hooks/hooks.json` (wiring), `docs/` (contracts and operational notes),
and `scripts/lib/hook-output.mjs` (Claude/Codex hook response adapter).

## FAQ

**Can this break my agent's understanding?** The compressor only removes provable
redundancy (repeated lines, progress spam, passing-test noise) and marks every elision.
Failing output is preserved verbatim. If in doubt it passes through — 0% compression on
dense output is by design.

**Why not an ML compressor?** Trained pruners (LLMLingua-2, Squeez) compress harder but
need a model at runtime — heavy install, latency, nondeterminism (cache-unsafe).
Heuristics keep the plugin plug-and-play and cache-safe; research shows syntactic-noise
removal is where the safe wins are anyway.

**Does it work with prompt caching?** Yes — that's the point. Deterministic
injection-time compression never rewrites history, so cache prefixes stay valid.
