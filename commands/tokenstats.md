---
description: Show measured token savings across tokenslim history
allowed-tools: Bash(node:*)
---

## Savings report

The default report shows the aggregate summary and top commands. To request a view,
run the same script with: `--daily`, `--weekly`, `--monthly`, `--project [path]`,
`--graph`, `--top`, or `--format text|json|csv`. History is retained for 90 days;
when it is not available the current session ledger is used.

!`node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");const roots=[process.env.TOKENSLIM_PLUGIN_ROOT,process.env.CLAUDE_PLUGIN_ROOT,process.env.PLUGIN_ROOT].filter(Boolean);const cache=path.join(os.homedir(),".claude/plugins/cache/tokenslim/tokenslim");if(fs.existsSync(cache))for(const v of fs.readdirSync(cache).sort().reverse())roots.push(path.join(cache,v));roots.push(path.join(os.homedir(),".claude/plugins/marketplaces/tokenslim"));const found=roots.map((r)=>path.join(r,"scripts/stats.mjs")).find((p)=>fs.existsSync(p));if(found)process.exit(cp.spawnSync(process.execPath,[found],{stdio:"inherit"}).status??0);console.log("tokenslim: unable to locate scripts/stats.mjs. Reinstall or update the tokenslim plugin.");'`

Present the report above to the user exactly as printed, in a code block. Do not
re-derive or estimate numbers yourself — the report is the measurement. If it says no
savings were recorded, explain that tokenslim only fires on tool outputs above the
minimum size (default 500 chars) and savings appear as the session accumulates tool use.
