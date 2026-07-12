# tokenslim v2 — Gap-Closure Plan (2026-07-07)

> Historical delivery note: this plan describes the v2 gap-closure work before it landed. The
> Edit/Write-aware Read cache, generic MCP compression, and PreToolUse Read guard shipped in
> `0.2.0`; the sections below are retained as design history rather than pending scope.

## Research summary (why these features)

Measured token-spend ranking for coding agents (arXiv 2601.14470 "Tokenomics", Stanford
Digital Economy Lab, Vantage agentic-cost analysis, 2026 tooling surveys):

| Rank | Token sink | Share / evidence | tokenslim v1 coverage |
|---|---|---|---|
| 1 | Accumulated context resend (input tokens each turn) | ~85% of session cost; input:output ≈ 20-25:1 | Indirect — smaller injected results shrink every later resend |
| 2 | Review / repair / iteration loops | 59.4% of tokens in ChatDev study | Out of scope (behavioral, caveman plugin territory) |
| 3 | File reads + re-reads | Top tool-result category in Claude Code sessions | Partial — dedup only for *unchanged* files; any Edit invalidates → next Read re-dumps full file |
| 4 | Build/test/bash logs | 50-90% reducible (RTK/chop/Microsoft pruning) | ✅ Covered (pipeline.mjs) |
| 5 | MCP tool results + metadata | Blobby JSON; metadata alone 40-50% of some contexts | ❌ Not covered |
| 6 | Search/navigation output | "60-80% of tokens spent finding things" | ✅ Grep/Glob covered; prevention side not covered |
| 7 | Web fetch/search dumps | Large markdown payloads | ❌ Not covered (low priority — WebFetch pre-summarizes) |

Two structural gaps, i.e. "different angles" beyond v1's compress-after-fetch model:

- **Cross-tool session knowledge**: hooks fire per-tool but the ledger/cache is shared.
  v1 never uses knowledge from one tool to shrink another tool's output
  (e.g. Edit/Write should keep the Read-dedup cache warm).
- **Prevention vs compression**: PreToolUse can stop waste before it enters context;
  v1 only shrinks after the fact.

## Feature A — Edit/Write-aware read cache (shipped in 0.2.0)

Problem: `compress-read.mjs` dedups a re-read only when the file content hash is unchanged.
Every Edit/Write changes the hash, so the very common pattern *read → edit → re-read* always
re-injects the full file even though the model already has the old content plus the edit diff
in context.

Implementation:

1. New hook `scripts/compress-edit.mjs`, PostToolUse matcher `Edit|Write` in `hooks/hooks.json`.
2. On successful Edit/Write of `filePath`, recompute the hash the Read hook would produce for
   that file and update the shared read cache (`readCache` in `scripts/lib/state.mjs`).
3. Hash parity requirement: the Read tool returns `cat -n`-style text (line numbers + tab) and
   `compress-read.mjs` hashes that delivered text. The Edit hook must reproduce that exact
   formatting from the on-disk file. **Phase 0 discovery required** (repo precedent:
   `docs/SHAPES.md`): capture a real Read `tool_response` and a real Edit/Write
   `tool_response` via a debug hook, confirm the number-column format (width, padding, tab)
   and the default truncation limit.
4. Safety guards (content must already be reconstructible from context):
   - Edit: update cache **only if** `filePath` already has a cache entry (file was previously
     read this session). Model context = old full content + edit snippet.
   - Write: model authored the full content → always safe to cache.
   - Skip files whose line count exceeds the Read default-read limit discovered in Phase 0
     (Read would truncate; hash would never match).
   - Any uncertainty (shape mismatch, fs error, formatting ambiguity) → do nothing (fail-open,
     cache simply stays invalidated — v1 behavior).
5. Stub text on subsequent dedup hit stays informative:
   `[tokenslim] <path> unchanged since your last Edit/Write in this session (...) — content reconstructible from context above.`
   (distinct wording from the plain re-read stub so the model knows an edit happened).
6. Ledger: record savings under new tool bucket `Edit` only when a later Read actually dedups
   (the Edit hook itself saves nothing directly — attribute at Read time as today).

## Feature B — Generic MCP tool-result compressor (shipped in 0.2.0)

Problem: MCP tools return pretty-printed JSON, base64 blobs, and giant homogeneous arrays;
none of the v1 hooks match `mcp__*` tools.

Implementation:

1. New hook `scripts/compress-mcp.mjs`, PostToolUse matcher `mcp__.*` in `hooks/hooks.json`.
2. Locate text-bearing field with the same defensive `locateText` pattern (string /
   text-block array / `.content` / `.output` / `.text`). Unrecognized → pass through.
3. Transforms, in order (all deterministic, all preserving every key and value semantics):
   - **JSON minify**: if the text parses as JSON, re-serialize compact (`JSON.stringify`, no
     whitespace). Pretty-printed API responses shrink 20-40% with zero information loss.
   - **Base64 / data-URI truncation**: any base64-looking run > 256 chars →
     first 64 chars + `[tokenslim: <N> base64 chars omitted]`. Images/screenshots/blobs are
     useless to the model as raw base64.
   - **Homogeneous-array collapse** (env-gated, `TOKENSLIM_MCP_ARRAYS=1`, off by default):
     arrays of > 50 objects sharing an identical key set → first 10 items +
     `[tokenslim: <N> more items, same keys: <k1,k2,...>]`. Off by default because items may
     be individually load-bearing.
4. Same rails as every v1 hook: `MIN_CHARS` 500, ratio floor 0.1, `TOKENSLIM_DISABLE=mcp`,
   fail-open, ledger bucket `MCP`.

## Feature C — PreToolUse Read guard (shipped in 0.2.0)

1. New hook `scripts/guard-read.mjs`, **PreToolUse** matcher `Read`.
2. If `tool_input.file_path` exists on disk, line count > threshold (default 2000, env
   `TOKENSLIM_READ_GUARD_LINES`), and no `offset`/`limit` given → emit non-blocking
   `additionalContext`: `[tokenslim] <path> is <N> lines (~<tokens> tokens). Consider offset/limit or Grep.`
   Never deny — hint only, so behavior is advisory and fail-open.
3. Disable flag `TOKENSLIM_DISABLE=readguard`. No ledger entry (nothing measurable saved
   directly).

## Explicitly deferred (assessed, not in this round)

- WebFetch/WebSearch slimming — WebFetch already model-summarizes; poor ratio expected.
- Grep↔Read overlap dedup (collapse grep matches inside already-read files) — real but
  smaller win; revisit after A ships since it reuses the same cache.
- Review-loop / conversation compaction — Claude Code `/compact` + prompt caching own this
  layer; out of plugin scope.

## Testing (repo conventions: node:test, zero deps, fixtures, golden outputs)

- `tests/edit-cache.test.mjs`: cat-n formatting parity (golden fixtures), Edit-with-prior-read
  updates cache, Edit-without-prior-read does not, Write always does, oversized file skipped,
  fail-open on malformed stdin.
- `tests/mcp.test.mjs`: minify golden, base64 truncation, array collapse behind env flag,
  ratio floor, determinism double-run, fail-open.
- `tests/read-guard.test.mjs`: hint above threshold, silence below / with offset/limit,
  fail-open.
- Update `tests/plugin-packaging.test.mjs` for new hooks.json entries.

## Rollout / risk

- Feature A is the only risky one (hash parity). Its failure mode is benign: hash never
  matches → v1 behavior, zero regression. The shipped surface includes per-hook disable values
  such as `TOKENSLIM_DISABLE=edit`, `mcp`, and `readguard`.
- All hooks keep the Codex-runtime adapter path via `scripts/lib/hook-output.mjs`.
- Conventional commits, one commit per feature.
