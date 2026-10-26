# tool_response shapes (discovered empirically, Claude Code July 2026)

Captured via a logging PostToolUse hook + `claude -p` probe. Replacement via
`updatedToolOutput` with a mirrored shape **verified working for Read** (model received
the substituted content).

Codex compatibility note: current Codex PostToolUse docs do not document structured
`updatedToolOutput` replacement. tokenslim keeps these mirrored shapes for Claude Code,
then uses the documented Codex `continue: false` PostToolUse path to suppress the
original tool result with short stop text and send compact output via
`hookSpecificOutput.additionalContext`.

## Runtime detection verification matrix

`TOKENSLIM_HOOK_RUNTIME=claude|codex` always overrides automatic detection. Without
an override, a payload `turn_id` selects Codex even when Codex supplies
`CLAUDE_PLUGIN_ROOT` for compatibility. Otherwise, `CODEX_PLUGIN_ROOT` or
`PLUGIN_DATA` selects Codex only when `CLAUDE_PLUGIN_ROOT` is absent. All other
cases default to Claude.

| Runtime / version | Payload keys observed | Environment observed | Expected detection | Verification |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.215 | `permission_mode`, `tool_use_id`, and possibly `model` / `cwd`; no `turn_id` | `CLAUDE_PLUGIN_ROOT` may be absent for manual hooks | Claude | Confirmed by payload capture; these Claude fields must not select Codex. |
| Codex CLI (version to record during next smoke) | `turn_id` | May also set `CLAUDE_PLUGIN_ROOT` compatibility variables | Codex | Payload marker takes precedence; live smoke pending version capture. |
| Codex environment fallback | No `turn_id` available | `CODEX_PLUGIN_ROOT` or `PLUGIN_DATA`, without `CLAUDE_PLUGIN_ROOT` | Codex | Covered by detection-matrix tests; live smoke pending. |
| Unknown / incomplete payload | No `turn_id` | No Codex-positive environment variable | Claude | Safe default; prevents a Claude turn from receiving Codex `continue: false`. |

## PreToolUse Bash rewrite

Claude Code live smoke (v0.3.0, Claude Code 2.1.215) accepted this response shape and
reported the `permissionDecisionReason`; `updatedInput.command` carried the quieter command:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "tokenslim quiet-rewrite: npm-quiet",
    "updatedInput": { "command": "npm install --loglevel=error --no-fund --no-audit" }
  }
}
```

Codex has not been live-verified with `updatedInput`. By default it receives only a
`hookSpecificOutput.additionalContext` advisory; `TOKENSLIM_REWRITE_CODEX=1` opts into
trying the Claude-style shape.

## Bash

Claude Code shape:

```json
{
  "stdout": "command stdout",
  "stderr": "command stderr",
  "interrupted": false,
  "isImage": false
}
```

Codex CLI shape observed via `codex exec --dangerously-bypass-hook-trust`:

```json
"command stdout as a plain string"
```

## Read

```json
{
  "type": "text",
  "file": {
    "filePath": "/abs/path",
    "content": "raw file content, no line-number prefixes",
    "numLines": 4,
    "startLine": 1,
    "totalLines": 4
  }
}
```

Text field: `tool_response.file.content`. When replacing, update `numLines` to the new
line count; copy all other fields verbatim.

## Grep (output_mode: content)

```json
{
  "mode": "content",
  "numFiles": 0,
  "filenames": [],
  "content": "path:line:matched text\n...",
  "numLines": 3
}
```

Text field: `tool_response.content`. Other modes (`files_with_matches`, `count`) put
results in `filenames` — those are already compact; pass through.

## Glob

```json
{
  "filenames": ["test.txt"],
  "durationMs": 12,
  "numFiles": 1,
  "truncated": false,
  "totalMatches": 1,
  "countIsComplete": true
}
```

No single text field. Compression = shorten the `filenames` string array (grouped
summaries are still strings, shape stays valid). `durationMs` is nondeterministic — copy
verbatim, never synthesize.

## Open: PostToolUse vs native output persistence

Claude Code persists tool results above roughly 30KB itself and shows the model a short
preview with a `<persisted-output>` block. It is **not yet verified** whether a
`PostToolUse` hook sees the raw output (hook runs before persistence) or only that preview
(hook runs after). This matters for the Bash output cap (`bash.capChars`): the cap targets
the 8-30KB band that persistence never touches, so it works either way, but results above
~30KB may need to be skipped as already persisted if the hook only sees previews.

Probe procedure (needs a real Claude Code with credentials; the spike has **not been run**,
so the result is pending live verification):

1. Install a throwaway plugin whose `PostToolUse` Bash hook logs
   `tool_response.stdout.length` and returns `updatedToolOutput` with stdout replaced by
   `"PROBE " + length`.
2. Run `claude -p 'run: python3 -c "print(\"x\"*60000)"'`, then inspect the session
   transcript.
3. Interpret:
   - Hook logged 60000 and the transcript `tool_result` is `PROBE 60000` with no
     `<persisted-output>`: the hook runs **before** persistence, so the cap covers outputs
     above 30KB too. No code change needed.
   - Hook logged a ~2KB preview: it runs **after** persistence. Exclude persisted results in
     the Bash hook (as `scripts/lib/transcripts.mjs` already flags `isPersisted` for replay)
     and document it here.

Until this is run, tokenslim makes no assumption either way.
