# tokenslim — Implementation Plan & Contracts

## Task split (disjoint file ownership)

| Owner | Files | Task |
|---|---|---|
| codex agent | `scripts/lib/pipeline.mjs`, `scripts/compress-bash.mjs`, `tests/pipeline.test.mjs`, `tests/fixtures/bash/**` | Core bash-output heuristic engine + tests |
| sonnet agent | `scripts/lib/state.mjs`, `scripts/compress-read.mjs`, `scripts/compress-grep.mjs`, `tests/state.test.mjs`, `tests/read-grep.test.mjs`, `tests/fixtures/read/**` | Dedup cache, ledger, read/grep hooks + tests |
| main (Fable) | `.claude-plugin/plugin.json`, `hooks/hooks.json`, `commands/*`, `scripts/statusline.mjs`, `scripts/stats.mjs`, `README.md`, docs, integration, shape discovery | Scaffold, small modules, verify, integrate |

## Hook I/O contract (all hook scripts)

- stdin: JSON `{ session_id, cwd, hook_event_name: "PostToolUse", tool_name, tool_input, tool_response, tool_use_id }`
- stdout on compression: JSON
  `{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "updatedToolOutput": <same shape as tool_response, compressed> } }`
- stdout on pass-through (too small / disabled / error): **nothing**, exit 0. Never exit non-zero.
- Bash `tool_response` shape (documented): `{ stdout, stderr, interrupted, isImage }` — only compress `stdout`/`stderr`, preserve other fields verbatim.
- Read/Grep shape: **mirror whatever arrives** — modify only the text-bearing field(s), copy every other field byte-identical. Text-bearing field located defensively; if structure unrecognized, pass through.

## lib/pipeline.mjs contract (pure, deterministic)

```js
export function compressBashOutput(text, opts = {}) 
// -> { text: string, stats: { bytesIn, bytesOut, rulesApplied: string[] } }
```

No I/O, no Date/random in output text. Composable rule functions, each individually exported for tests.

## lib/state.mjs contract

```js
export function loadState(sessionId)   // -> state object (or fresh)
export function saveState(sessionId, state)
export function recordSavings(state, { tool, bytesIn, bytesOut })
export function readCache(state)       // { get(filePath) -> {hash,mtime}|undefined, set(filePath, entry) }
```

Ledger path: `~/.cache/tokenslim/<session_id>.json` (respect `XDG_CACHE_HOME`). Corrupt/missing file → fresh state, never throw outward.

## Order

1. Phase 0 (main): scaffold ✅, shape-discovery harness for Read/Grep.
2. Phase 1 (parallel): codex engine ∥ sonnet state/read/grep ∥ main small modules.
3. Phase 2 (main): integrate, `node --test`, live smoke test via `claude -p` with plugin loaded, README finalize.

## Env flags

`TOKENSLIM_DISABLE` (csv: `bash,read,grep,all`), `TOKENSLIM_MIN_CHARS` (default 500), `TOKENSLIM_DEBUG` (log to `~/.cache/tokenslim/debug.log`).
