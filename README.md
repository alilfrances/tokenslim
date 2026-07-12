# tokenslim

**Input-token compressor for Claude Code and Codex.** Shrinks tool results — Bash output, file
reads, Grep/Glob results, MCP tool results — *before* they enter the model's context, keeps the
Read dedup cache warm across Edit/Write, and warns before large unbounded reads.
Deterministic, prompt-cache safe, zero dependencies, fail-open.

Measured on this repo's fixture corpus and live sessions:

| Source | Reduction |
|---|---|
| Noisy bash output (live session) | **99%** (21.5KB → 134B) |
| pytest (passing suite) | **96%** |
| npm test (failing — failures kept verbatim) | **88%** |
| docker pull | **87%** |
| npm install | **86%** |
| cargo build | **85%** |
| Repeated stack traces | **73%** |
| Re-read of unchanged file | **~99%** (stub replaces full content) |
| Dense output (git log, unique lines) | 0% — correctly left untouched |

On tool-heavy sessions this lands well above the 50% target, consistent with published
numbers from comparable approaches (RTK 60–90%, chop 50–90%, Microsoft context-pruning
63.9%). And because input tokens are re-sent every turn, savings compound over a session.

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

Five `PostToolUse` matchers cover Bash, Read, Edit|Write, `mcp__.*`, and Grep|Glob, replacing tool results with compressed
versions before the model ever sees them, plus one `PreToolUse` guard. Claude Code
receives structured `updatedToolOutput`; Codex receives a short `continue: false`
stop message while the compressed output is added through
`hookSpecificOutput.additionalContext`:

- **Bash** — strips ANSI codes, progress bars/spinners, `\r`-overwritten lines; collapses
  repeated log lines (timestamp/id-normalized fingerprinting); summarizes test-runner
  output to counts while keeping every failing test's name and error **verbatim**; dedups
  repeated stack traces; head+tail truncates only outputs still over 40KB, always
  preserving error/warning lines from the omitted middle.
- **Read** — hashes file content per session. Re-reading an unchanged file returns a short
  `[tokenslim] ... unchanged since previous read` stub instead of the full content. First
  reads get whitespace-only slimming. **Comments and docstrings are never stripped**
  (research shows a measurable task-accuracy drop when they are).
- **Grep/Glob** — dedups identical match lines, collapses runs of matches from the same
  file, groups huge glob listings by directory. Compact modes pass through untouched.
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

- **`/tokenslim:tokenstats`** (Claude Code) — measured savings this session: bytes
  in/out per tool, estimated tokens and dollars saved. Real measurements from the
  ledger, not estimates. In Codex, run `node /path/to/tokenslim/scripts/stats.mjs`.
- **`/tokenslim:slim-memory <file>`** — mechanical CLAUDE.md/rules slimmer: dedups
  redundant rules, strips markdown noise, keeps every directive/path/command byte-identical.
  Shows a preview and asks before writing; original backed up to `<file>.original.md`.

## Configuration (env vars)

| Var | Default | Effect |
|---|---|---|
| `TOKENSLIM_DISABLE` | – | CSV kill switch: `bash`, `read`, `grep`, `edit`, `mcp`, `readguard`, or `all` |
| `TOKENSLIM_MIN_CHARS` | `500` | Outputs smaller than this pass through untouched |
| `TOKENSLIM_MCP_ARRAYS` | off | Set to `1` to collapse >50-item homogeneous arrays in MCP JSON results |
| `TOKENSLIM_READ_GUARD_LINES` | `2000` | Read-guard hint threshold (lines) |
| `TOKENSLIM_READ_DEFAULT_LINES` | `2000` | Files longer than this are never cache-warmed after Edit/Write (Read would truncate) |

`TOKENSLIM_HOOK_RUNTIME=claude|codex` forces the Claude/Codex hook-output adapter when
auto-detection is not enough.

`TOKENSLIM_DISABLE` supports `bash`, `read`, `grep`, `edit`, `mcp`, `readguard`, and
`all`. `Glob` shares the Grep hook and disable path.

## Design guarantees

- **Prompt-cache safe.** Compression happens once, at injection time, and is fully
  deterministic (same input → byte-identical output; no timestamps or randomness). The
  compressed version is the only version that ever enters history, so cached prefixes are
  never invalidated.
- **Fail-open.** Any error, unrecognized shape, or oversized-input edge → the hook emits
  nothing and Claude Code uses the original output. A tokenslim bug can never lose data.
- **Accuracy-first.** Kept lines are verbatim. Never touched: error messages, exception
  types, failing test names, file paths, line numbers, identifiers, numeric literals,
  comments/docstrings. Dense output (unique lines, e.g. `git log`) is left alone rather
  than mangled — compression below 10% savings is skipped entirely.
- **Zero runtime dependencies.** Plain Node scripts, no model, no network, <50ms per hook.
- **Runtime-compatible hook output.** Claude Code gets the original structured
  replacement shape. Codex gets a short `PostToolUse` `continue: false`
  replacement plus compact output in `additionalContext`.

## Stacking with Cortex

[Cortex](https://github.com/alilfrances/Cortex) and tokenslim are complementary and safe
to run together: Cortex proactively *selects* which repo context enters the conversation
(graph-ranked, token-budgeted bundles over MCP), while tokenslim reactively *compresses*
tool results after they arrive. As of v0.2.0 the `mcp__*` hook also touches Cortex's MCP
results, but only with lossless transforms (JSON minify, base64 truncation) — content is
never dropped unless you opt into `TOKENSLIM_MCP_ARRAYS=1`. To exempt MCP results
entirely, set `TOKENSLIM_DISABLE=mcp`. If you pipe `cortex bundle` output through Bash
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
node --test tests/*.test.mjs   # 70 tests: rules, determinism, fail-open, ratio floors
```

Repo layout: `scripts/lib/pipeline.mjs` (pure compression rules), `scripts/lib/state.mjs`
(ledger + read cache), `scripts/lib/read-format.mjs` (shared Read text/hash helpers),
`scripts/compress-{bash,read,grep,edit,mcp}.mjs` and `scripts/guard-read.mjs` (hook
entrypoints), `hooks/hooks.json` (wiring), `docs/` (design spec, plan, discovered
tool_response shapes), `scripts/lib/hook-output.mjs` (Claude/Codex hook response adapter).

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
