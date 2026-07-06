#!/usr/bin/env node
import { compressBashOutput } from './lib/pipeline.mjs';
import { postToolUseNoopOutput, postToolUseOutput } from './lib/hook-output.mjs';
import { loadState, recordDiagnostic, recordSavings, saveState } from './lib/state.mjs';

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function disabled() {
  const flags = String(process.env.TOKENSLIM_DISABLE || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return flags.includes('all') || flags.includes('bash');
}

function recordLedgerBestEffort(sessionId, event, outcome, bytesIn = 0, bytesOut = 0) {
  try {
    const state = loadState(sessionId);
    recordDiagnostic(state, { tool: 'Bash', event, outcome });
    if (outcome === 'compressed') recordSavings(state, { tool: 'Bash', bytesIn, bytesOut });
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
    if (disabled()) {
      recordLedgerBestEffort(payload?.session_id, event, 'disabled');
      passThrough(payload);
      return;
    }
    recordLedgerBestEffort(payload?.session_id, event, 'attempted');
    const response = payload?.tool_response;
    const stringResponse = typeof response === 'string';
    const stdout = stringResponse ? response : String(response?.stdout ?? '');
    const stderr = stringResponse ? '' : String(response?.stderr ?? '');
    const minChars = Number.parseInt(process.env.TOKENSLIM_MIN_CHARS || '500', 10);
    const threshold = Number.isFinite(minChars) ? minChars : 500;
    if (stdout.length + stderr.length < threshold) {
      recordLedgerBestEffort(payload?.session_id, event, 'skippedBelowThreshold');
      passThrough(payload);
      return;
    }

    const compressedStdout = compressBashOutput(stdout);
    const compressedStderr = compressBashOutput(stderr);
    const bytesIn = compressedStdout.stats.bytesIn + compressedStderr.stats.bytesIn;
    const bytesOut = compressedStdout.stats.bytesOut + compressedStderr.stats.bytesOut;
    if (bytesIn === 0 || bytesOut / bytesIn > 0.9) {
      recordLedgerBestEffort(payload?.session_id, event, 'skippedPoorRatio');
      passThrough(payload);
      return;
    }

    const updatedToolOutput = stringResponse
      ? compressedStdout.text
      : {
          stdout: compressedStdout.text,
          stderr: compressedStderr.text,
          interrupted: response?.interrupted,
          isImage: response?.isImage,
        };
    const output = postToolUseOutput(payload, updatedToolOutput);
    process.stdout.write(JSON.stringify(output));
    recordLedgerBestEffort(payload?.session_id, event, 'compressed', bytesIn, bytesOut);
  } catch {
    // fail-open: original tool output passes through
  }
}

await main();
process.exit(0);
