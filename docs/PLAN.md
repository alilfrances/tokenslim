# tokenslim — Implementation Plan & Contracts

> Historical implementation note: this plan captured the v2 delivery work before release. The
> Edit/Write cache warmer, generic MCP compressor, and PreToolUse Read guard shipped in `0.2.0`.
> The v0.3.0 rewrite layer, command-aware Bash compressors, tee recovery, analytics, discovery,
> doctor, and benchmark harness are documented in the README and release notes. Treat this file
> as a design record, not current backlog.

## Task split (disjoint file ownership)

| Owner | Files | Task |
|---|---|---|
| codex agent | `scripts/lib/pipeline.mjs`, `scripts/compress-bash.mjs`, `tests/pipeline.test.mjs`, `tests/fixtures/bash/**` | Core bash-output heuristic engine + tests |
| sonnet agent | `scripts/lib/state.mjs`, `scripts/compress-read.mjs`, `scripts/compress-grep.mjs`, `tests/state.test.mjs`, `tests/read-grep.test.mjs`, `tests/fixtures/read/**` | Dedup cache, ledger, read/grep hooks + tests |
| main (Fable) | `.claude-plugin/plugin.json`, `hooks/hooks.json`, `commands/*`, `scripts/statusline.mjs`, `scripts/stats.mjs`, `scripts/lib/hook-output.mjs`, `README.md`, docs, integration, shape discovery | Scaffold, small modules, verify, integrate |

## Hook I/O contract (all hook scripts)

- stdin: JSON `{ session_id, cwd, hook_event_name: "PostToolUse", tool_name, tool_input, tool_response, tool_use_id }`
- stdout on compression for Claude Code: JSON
  `{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "updatedToolOutput": <same shape as tool_response, compressed> } }`
- stdout on compression for Codex: JSON
  `{ "continue": false, "stopReason": "Token Slim compacted <tool> output", "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "[tokenslim: compressed <tool> output]\n<compressed text>" } }`
- stdout on pass-through (too small / disabled / error): **nothing**, exit 0. Never exit non-zero.
- Bash `tool_response` shape: Claude Code uses `{ stdout, stderr, interrupted, isImage }`
  and Codex CLI can send plain text. Object responses compress `stdout`/`stderr` and
  preserve other fields; string responses compress the string directly.
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

`TOKENSLIM_DISABLE` (csv: `bash,read,grep,edit,mcp,readguard,rewrite,tee,all`; `Glob` shares `grep`),
`TOKENSLIM_HOOK_RUNTIME` (`claude|codex` override), `TOKENSLIM_MIN_CHARS` (default 500),
No `TOKENSLIM_DEBUG` runtime flag is shipped; `debug.log` is excluded from stats discovery.
