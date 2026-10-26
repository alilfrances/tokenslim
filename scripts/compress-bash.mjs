#!/usr/bin/env node
import { loadConfig } from './lib/config.mjs';
import { bashDisabled, failureOutput, processBashPayload } from './lib/bash-hook.mjs';
import { postToolUseNoopOutput, postToolUseOutput } from './lib/hook-output.mjs';
import { loadState, noteBashCommand, recordAttempted, recordDiagnostic, recordRecovery, recordSavings, saveState } from './lib/state.mjs';
import { teeRoot } from './lib/tee.mjs';

// Kept for existing importers; the logic lives in lib/bash-hook.mjs.
export { failureOutput };

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function passThrough(payload) {
  const output = postToolUseNoopOutput(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}

// One ledger load and save per invocation. Everything is recorded in memory and flushed in `finally`, so a fail-open
// exception after 'attempted' is noted still leaves it in the ledger.
async function main() {
  let sessionId;
  let state = null;
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    sessionId = payload?.session_id;
    const event = payload?.hook_event_name || 'PostToolUse';
    const config = loadConfig(payload?.cwd || process.cwd(), process.env);
    state = loadState(sessionId);
    if (bashDisabled(config, process.env)) {
      recordDiagnostic(state, { tool: 'Bash', event, outcome: 'disabled' });
      passThrough(payload);
      return;
    }
    recordDiagnostic(state, { tool: 'Bash', event, outcome: 'attempted' });
    const result = processBashPayload(payload, { config, env: process.env });
    // Every result that reached the size check is a denominator byte, compressed or not; images are not text tokens.
    if (result.outcome !== 'disabled' && result.outcome !== 'skippedImage') {
      recordAttempted(state, { tool: 'Bash', bytes: result.bytesIn, cwd: payload?.cwd });
    }
    const capped = result.outcome === 'compressed' && result.rulesApplied.includes('capMidBand');
    if (capped) recordRecovery(state, 'capped');
    const command = payload?.tool_input?.command;
    if (typeof command === 'string' && command.includes(teeRoot(process.env))) recordRecovery(state, 'teeCat');
    if (noteBashCommand(state, command, capped)) recordRecovery(state, 'rerun');
    if (result.outcome !== 'compressed') {
      recordDiagnostic(state, { tool: 'Bash', event, outcome: result.outcome });
      passThrough(payload);
      return;
    }
    process.stdout.write(JSON.stringify(postToolUseOutput(payload, result.updatedToolOutput)));
    recordDiagnostic(state, { tool: 'Bash', event, outcome: 'compressed' });
    recordSavings(state, { tool: 'Bash', bytesIn: result.bytesIn, bytesOut: result.bytesOut, command, cwd: payload?.cwd });
  } catch {
    // fail-open: original tool output passes through
  } finally {
    if (state) saveState(sessionId, state);
  }
}

await main();
process.exit(0);
