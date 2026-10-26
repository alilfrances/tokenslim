---
description: Audit always-on context overhead (skills, MCP servers, agents, hooks, memory) and suggest what to turn off
allowed-tools: Bash(node:*)
argument-hint: [--since days] [--project [path]|--all] [--min-tokens N] [--format text|json] [--emit-settings]
---

Run the tokenslim context budget audit (read-only; it never writes any file):

!`node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");const roots=[process.env.TOKENSLIM_PLUGIN_ROOT,process.env.CLAUDE_PLUGIN_ROOT,process.env.PLUGIN_ROOT,process.cwd()].filter(Boolean);const cache=path.join(os.homedir(),".claude/plugins/cache/tokenslim/tokenslim");if(fs.existsSync(cache))for(const v of fs.readdirSync(cache).sort().reverse())roots.push(path.join(cache,v));roots.push(path.join(os.homedir(),".claude/plugins/marketplaces/tokenslim"));const script=roots.map(r=>path.join(r,"scripts/budget.mjs")).find(fs.existsSync);if(!script){console.log("tokenslim: unable to locate scripts/budget.mjs. Reinstall or update the plugin.");process.exit(0)}process.exit(cp.spawnSync(process.execPath,[script,...process.argv.slice(1).flatMap(a=>a.split(/\s+/)).filter(Boolean)],{stdio:"inherit"}).status??0)' "$ARGUMENTS"`

Present the report exactly as printed, in a code block. Explain that it only reads local Claude
transcripts and settings, that "weighted tokens" is the size of an item times the API calls that carried
it, and that the overhead figure is an upper bound because built-in tools, built-in agents, MCP
instructions and user-scope servers cannot be turned off from project settings.
Arguments are split on whitespace, so a `--project` path containing spaces is not supported.

If the user wants to apply the suggestions:
1. Run this command again with `--emit-settings` added (same other arguments) and show the printed JSON
   snippet and the manual list.
2. Show the exact diff against `<project>/.claude/settings.local.json` and **ask for explicit confirmation**
   before changing anything. Do not apply it on an ambiguous answer.
3. Only after the user confirms, merge the snippet into `<project>/.claude/settings.local.json`: create the
   file if it is missing and preserve every existing key. Merge `enabledPlugins` key by key and union the
   `disabledMcpjsonServers` arrays instead of replacing them.
4. Never edit `~/.claude/settings.json` or any other user-level settings file. Items on the manual list
   cannot be changed from project settings; tell the user how to handle each one and do not edit files for them.
