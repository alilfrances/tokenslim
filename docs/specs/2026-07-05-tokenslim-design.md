# tokenslim — Design Spec (2026-07-05)

## Goal

Claude Code plugin that cuts **input-token** usage 50%+ on tool-heavy sessions by compressing
tool results (Bash, Read, Grep/Glob output) *before* they enter model context. Complements the
caveman plugin (output-side compression). Zero runtime dependencies, deterministic, fail-open.

## Why this design (research-backed)

- PostToolUse hooks support `updatedToolOutput`, which **replaces** the tool result the model
  sees. Bash output shape is documented (`{stdout, stderr, interrupted, isImage}`); Read/Grep
  shapes are undocumented and must be discovered empirically (wrong shape = silently ignored).
- Comparable heuristic tools (RTK, chop) report 50–90% reduction on bash/build/test output;
  Microsoft context-pruning paper reports 63.9% from pruning alone. 50%+ is realistic.
- Prompt-cache safety: compressing **at injection time** with **deterministic** output never
  invalidates cache (the compressed version is the only version that ever exists in history).
- Accuracy pitfalls (from LLMLingua-2 / SWE-bench literature): never strip code identifiers,
  numeric literals, error messages, or unique stack frames. No comment/docstring stripping by
  default (measured 12% task-resolution drop).

## Components

1. **Bash compressor** (`scripts/compress-bash.mjs` + `scripts/lib/pipeline.mjs`)
   Pipeline: ANSI strip → progress-bar/spinner removal → repeated-line fingerprint collapse →
   test-runner summarization (pass/fail counts; failures verbatim) → stack-trace dedup (unique
   frames + exception message kept) → head+tail truncation for giant logs with `[N lines omitted]`.
2. **Read dedup + slim** (`scripts/compress-read.mjs`)
   Session content-hash cache; re-read of unchanged file → short "unchanged since last read" stub.
   First read: trailing-whitespace strip + blank-run collapse only. No comment stripping.
3. **Grep/Glob compactor** (`scripts/compress-grep.mjs`)
   Collapse near-duplicate matches, dedup repeated path prefixes.
4. **Savings ledger** (`scripts/lib/state.mjs`)
   Per-session JSON at `~/.cache/tokenslim/<session_id>.json`; bytes in/out per hook fire +
   read-hash table. Ledger I/O never affects compressed content (determinism preserved).
5. **`/tokenstats`** (`commands/tokenstats.md` + `scripts/stats.mjs`) — measured savings report.
6. **Statusline** (`scripts/statusline.mjs`) — context % + tokens saved (opt-in via settings).
7. **`/slim-memory`** (`commands/slim-memory.md`) — mechanical CLAUDE.md/rules slimmer
   (dedup, markdown-noise strip; not caveman-speak).

## Safety rails

- Fail-open: any exception → emit nothing (original output passes through).
- Skip outputs < 500 chars (overhead not worth it).
- Deterministic: same input → same output, always. No timestamps/randomness in output content.
- Never modify: error messages, exception types, failing test names, identifiers, numbers.
- Per-tool kill switches via `TOKENSLIM_DISABLE` env (e.g. `TOKENSLIM_DISABLE=read,grep`).

## Risk plan

Read/Grep `tool_response` shape undocumented → Phase-0 discovery harness (debug hook logging
`tool_response` via `claude -p`). If replacement proves flaky: v1 ships Bash-only replacement
(documented shape) + Read-dedup downgraded to `additionalContext` hint; still ≥50% on
tool-heavy sessions per comparable-tool numbers.

## Testing

`node:test`, zero deps. Fixture corpus of real npm/pytest/cargo/webpack/git outputs; golden
outputs; determinism assertion (double-run equality); per-fixture compression-ratio floors;
fail-open tests (malformed stdin → empty stdout, exit 0).
