---
description: Verify tokenslim installation, hooks, storage, configuration, and runtime
allowed-tools: Bash(node:*)
---

Run the tokenslim installation health check:

!`node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");const roots=[process.env.TOKENSLIM_PLUGIN_ROOT,process.env.CLAUDE_PLUGIN_ROOT,process.env.PLUGIN_ROOT,process.cwd()].filter(Boolean);const cache=path.join(os.homedir(),".claude/plugins/cache/tokenslim/tokenslim");if(fs.existsSync(cache))for(const v of fs.readdirSync(cache).sort().reverse())roots.push(path.join(cache,v));roots.push(path.join(os.homedir(),".claude/plugins/marketplaces/tokenslim"));const script=roots.map(r=>path.join(r,"scripts/doctor.mjs")).find(fs.existsSync);if(!script){console.log("tokenslim: unable to locate scripts/doctor.mjs. Reinstall or update the plugin.");process.exit(0)}process.exit(cp.spawnSync(process.execPath,[script],{stdio:"inherit"}).status??0)'`

Present the result exactly as printed in a code block. If it lists problems, explain the
actionable fixes; do not claim the installation is healthy.
