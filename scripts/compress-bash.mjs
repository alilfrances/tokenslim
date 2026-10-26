#!/usr/bin/env node
import { loadConfig } from './lib/config.mjs';
import { bashDisabled, failureOutput, processBashPayload } from './lib/bash-hook.mjs';
import { postToolUseNoopOutput, postToolUseOutput } from './lib/hook-output.mjs';
import { loadState, recordDiagnostic, recordSavings, saveState } from './lib/state.mjs';

// Kept for existing importers; the logic lives in lib/bash-hook.mjs.
export { failureOutput };

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function recordLedgerBestEffort(sessionId, event, outcome, bytesIn = 0, bytesOut = 0, command, cwd) {
  try {
    const state = loadState(sessionId);
    recordDiagnostic(state, { tool: 'Bash', event, outcome });
    if (outcome === 'compressed') recordSavings(state, { tool: 'Bash', bytesIn, bytesOut, command, cwd });
    saveState(sessionId, state);
  } catch {
    // best-effort ledger only
  }
}

function passThrough(payload) {
  const output = postToolUseNoopOutput(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    const event = payload?.hook_event_name || 'PostToolUse';
    const config = loadConfig(payload?.cwd || process.cwd(), process.env);
    if (bashDisabled(config, process.env)) {
      recordLedgerBestEffort(payload?.session_id, event, 'disabled');
      passThrough(payload);
      return;
    }
    // Recorded before processing so a fail-open exception still leaves an attempt in the ledger.
    recordLedgerBestEffort(payload?.session_id, event, 'attempted');
    const result = processBashPayload(payload, { config, env: process.env });
    if (result.outcome !== 'compressed') {
      recordLedgerBestEffort(payload?.session_id, event, result.outcome);
      passThrough(payload);
      return;
    }
    process.stdout.write(JSON.stringify(postToolUseOutput(payload, result.updatedToolOutput)));
    recordLedgerBestEffort(payload?.session_id, event, 'compressed', result.bytesIn, result.bytesOut, payload?.tool_input?.command, payload?.cwd);
  } catch {
    // fail-open: original tool output passes through
  }
}

await main();
process.exit(0);
