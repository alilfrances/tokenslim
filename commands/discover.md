---
description: Find large uncompressed Bash outputs and missed quiet-rewrite opportunities in Claude transcripts
allowed-tools: Bash(node:*)
argument-hint: [--since days] [--project [path]|--all] [--limit N] [--format text|json]
---

Run tokenslim transcript discovery (read-only):

!`node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");const roots=[process.env.TOKENSLIM_PLUGIN_ROOT,process.env.CLAUDE_PLUGIN_ROOT,process.env.PLUGIN_ROOT,process.cwd()].filter(Boolean);const cache=path.join(os.homedir(),".claude/plugins/cache/tokenslim/tokenslim");if(fs.existsSync(cache))for(const v of fs.readdirSync(cache).sort().reverse())roots.push(path.join(cache,v));roots.push(path.join(os.homedir(),".claude/plugins/marketplaces/tokenslim"));const script=roots.map(r=>path.join(r,"scripts/discover.mjs")).find(fs.existsSync);if(!script){console.log("tokenslim: unable to locate scripts/discover.mjs. Reinstall or update the plugin.");process.exit(0)}process.exit(cp.spawnSync(process.execPath,[script,...process.argv.slice(1)],{stdio:"inherit"}).status??0)' "$ARGUMENTS"`

Present the report exactly as printed in a code block. Explain that discovery only reads
local Claude transcripts and that a missing transcript directory is normal on a new install.
