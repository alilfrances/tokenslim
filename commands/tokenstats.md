---
description: Show measured token savings from tokenslim this session
allowed-tools: Bash(node:*)
---

## Savings report

!`node "${CLAUDE_PLUGIN_ROOT:-.}/scripts/stats.mjs"`

Present the report above to the user exactly as printed, in a code block. Do not
re-derive or estimate numbers yourself — the report is the measurement. If it says no
savings were recorded, explain that tokenslim only fires on tool outputs above the
minimum size (default 500 chars) and savings appear as the session accumulates tool use.
