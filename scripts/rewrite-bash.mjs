#!/usr/bin/env node
// PreToolUse Bash hook: first the whole-file-dump guard (shadow by default, see lib/bash-guard.mjs), then the opt-in
// quiet-flag rewrite. Any error deliberately leaves the command untouched.
import { readFileSync } from 'node:fs';
import { bashGuard } from './lib/bash-guard.mjs';
import { loadConfig } from './lib/config.mjs';
import { preToolUseRewriteOutput } from './lib/hook-output.mjs';
import { rewriteCommand } from './lib/rewrite-rules.mjs';

function isDisabled(config) {
  const flags = new Set([
    ...(Array.isArray(config.disable) ? config.disable : []),
    ...String(process.env.TOKENSLIM_DISABLE || '').split(','),
  ].map((flag) => String(flag).trim().toLowerCase()).filter(Boolean));
  return flags.has('all') || flags.has('rewrite');
}

async function main(input) {
  let payload;
  try { payload = JSON.parse(input); } catch { return; }
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  const config = loadConfig(cwd, process.env);
  // The guard runs before the rewrite opt-in check: it is on (shadow) by default. A deny output ends the hook.
  if (await bashGuard(payload, config, process.env)) return;
  // Off by default: a rewrite returns permissionDecision "allow", which skips the permission prompt.
  if (config.rewrite?.enabled !== true || isDisabled(config)) return;
  const result = rewriteCommand(payload?.tool_input?.command, config);
  if (!result) return;
  process.stdout.write(JSON.stringify(preToolUseRewriteOutput(payload, result.command, result.rules, process.env)));
}

try {
  await main(readFileSync(0, 'utf8'));
} catch {
  // fail-open
}
