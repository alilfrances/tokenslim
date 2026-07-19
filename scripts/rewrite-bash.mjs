#!/usr/bin/env node
// PreToolUse Bash quiet-flag rewrite. Any error deliberately leaves the command untouched.
import { readFileSync } from 'node:fs';
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

function main(input) {
  let payload;
  try { payload = JSON.parse(input); } catch { return; }
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  const config = loadConfig(cwd, process.env);
  if (isDisabled(config)) return;
  const result = rewriteCommand(payload?.tool_input?.command, config);
  if (!result) return;
  process.stdout.write(JSON.stringify(preToolUseRewriteOutput(payload, result.command, result.rules, process.env)));
}

try {
  main(readFileSync(0, 'utf8'));
} catch {
  // fail-open
}
