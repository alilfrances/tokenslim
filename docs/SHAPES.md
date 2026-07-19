# tool_response shapes (discovered empirically, Claude Code July 2026)

Captured via a logging PostToolUse hook + `claude -p` probe. Replacement via
`updatedToolOutput` with a mirrored shape **verified working for Read** (model received
the substituted content).

Codex compatibility note: current Codex PostToolUse docs do not document structured
`updatedToolOutput` replacement. tokenslim keeps these mirrored shapes for Claude Code,
then uses the documented Codex `continue: false` PostToolUse path to suppress the
original tool result with short stop text and send compact output via
`hookSpecificOutput.additionalContext`.

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
