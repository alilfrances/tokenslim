# tokenslim

**Input-token compressor for Claude Code and Codex.** Shrinks tool results — Bash output, file
reads, grep results — *before* they enter the model's context. Deterministic, prompt-cache
safe, zero dependencies, fail-open.

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

**Option A — try it for one session:**

```bash
claude --plugin-dir /path/to/tokenslim
```

**Option B — install permanently from a local clone:**

```bash
git clone https://github.com/alilfrances/tokenslim.git
claude plugin marketplace add /path/to/tokenslim
claude plugin install tokenslim@tokenslim
```

**Option C — from GitHub (easiest):**

```bash
claude plugin marketplace add alilfrances/tokenslim
claude plugin install tokenslim@tokenslim
```

### Codex

This repo includes a Codex plugin manifest at `.codex-plugin/plugin.json` and a local
marketplace file at `.agents/plugins/marketplace.json`.

```bash
git clone https://github.com/alilfrances/tokenslim.git
codex plugin marketplace add /path/to/tokenslim
codex plugin add tokenslim@tokenslim
```

Then restart Codex. The bundled `PostToolUse` hooks live in `hooks/hooks.json`;
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

Three `PostToolUse` hooks intercept tool results and replace them with compressed
versions before the model ever sees them. Claude Code receives structured
`updatedToolOutput`; Codex receives a short `continue: false` stop message while
the compressed output is added through `hookSpecificOutput.additionalContext`:

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
| `TOKENSLIM_DISABLE` | – | CSV kill switch: `bash`, `read`, `grep`, or `all` |
| `TOKENSLIM_MIN_CHARS` | `500` | Outputs smaller than this pass through untouched |

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
tool results after they arrive. Cortex's MCP tool results are untouched by tokenslim —
the PostToolUse matchers only cover Bash/Read/Grep/Glob — so the two never double-process
the same content. If you pipe `cortex bundle` output through Bash instead of MCP, very
large bundles (>40KB) can be head/tail truncated by tokenslim; prefer the MCP tools.

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
node --test tests/*.test.mjs   # 44 tests: rules, determinism, fail-open, ratio floors
```

Repo layout: `scripts/lib/pipeline.mjs` (pure compression rules), `scripts/lib/state.mjs`
(ledger + read cache), `scripts/compress-{bash,read,grep}.mjs` (hook entrypoints),
`hooks/hooks.json` (wiring), `docs/` (design spec, plan, discovered tool_response shapes),
`scripts/lib/hook-output.mjs` (Claude/Codex hook response adapter).

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
