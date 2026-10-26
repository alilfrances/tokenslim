#!/usr/bin/env node
// PostToolUse hook for Read.

import { readFileSync } from 'node:fs';
import { loadState, saveState, recordAttempted, recordDiagnostic, recordRecovery, recordSavings, readCache } from './lib/state.mjs';
import { postToolUseNoopOutput, postToolUseOutput } from './lib/hook-output.mjs';
import { hasBoundedRead, isMediaResponse, locateText, sha256 } from './lib/read-format.mjs';
import { isTeePath } from './lib/tee.mjs';
import { loadConfig } from './lib/config.mjs';

function isDisabled(config) {
  const flags = Array.isArray(config?.disable) ? config.disable : [];
  const normalized = flags.map((flag) => String(flag).trim().toLowerCase());
  return normalized.includes('read') || normalized.includes('all');
}

function passThrough(payload) {
  const output = postToolUseNoopOutput(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}

// One ledger load and save per invocation, flushed in `finally` so a fail-open exception keeps what was recorded.
function main(input) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  const sessionId = payload && payload.session_id;
  const event = payload?.hook_event_name || 'PostToolUse';
  const config = loadConfig(payload?.cwd || process.cwd(), process.env);
  const state = loadState(sessionId);
  const note = (outcome) => recordDiagnostic(state, { tool: 'Read', event, outcome });
  try {
    run(payload, config, state, note);
  } finally {
    saveState(sessionId, state);
  }
}

function run(payload, config, state, note) {
  if (isDisabled(config)) {
    note('disabled');
    passThrough(payload);
    return;
  }
  note('attempted');

  const toolResponse = payload && payload.tool_response;
  const toolInput = (payload && payload.tool_input) || {};
  const filePath = toolInput.file_path || (toolResponse && toolResponse.file && toolResponse.file.filePath);
  // Reading a tee file back is the model recovering output the Bash cap hid.
  if (isTeePath(filePath, process.env)) recordRecovery(state, 'teeRead');
  const locator = locateText(toolResponse);
  if (!locator) {
    note('unsupportedShape');
    passThrough(payload);
    return;
  }

  const text = locator.get();
  if (typeof text !== 'string') {
    note('unsupportedShape');
    passThrough(payload);
    return;
  }
  if (!isMediaResponse(toolResponse)) {
    recordAttempted(state, { tool: 'Read', bytes: Buffer.byteLength(text, 'utf8'), cwd: payload?.cwd });
  }
  if (text.length < config.minChars) {
    note('skippedBelowThreshold');
    passThrough(payload);
    return;
  }

  const hash = sha256(text);
  const lineCount = text.split('\n').length;
  const dedupEligible = Boolean(filePath) && !hasBoundedRead(toolInput);
  const cache = readCache(state);

  if (dedupEligible) {
    const existing = cache.get(filePath);
    if (existing && existing.hash === hash) {
      const fromEdit = existing.source === 'Edit' || existing.source === 'Write';
      const stub = fromEdit
        ? `[tokenslim] ${filePath} unchanged since your last Edit/Write in this session (${existing.headerLine} lines, sha256:${hash.slice(0, 12)}) — content reconstructible from context above. If the content is no longer in context, re-read with offset/limit (bounded reads bypass this stub).`
        : `[tokenslim] ${filePath} unchanged since previous read in this session (${existing.headerLine} lines, sha256:${hash.slice(0, 12)}). Content already in context above. If the content is no longer in context, re-read with offset/limit (bounded reads bypass this stub).`;
      const updatedToolOutput = locator.set(stub);
      note('deduped');
      recordSavings(state, { tool: fromEdit ? 'Edit' : 'Read', bytesIn: Buffer.byteLength(text), bytesOut: Buffer.byteLength(stub), command: toolInput?.file_path || 'Read', cwd: payload?.cwd });
      process.stdout.write(JSON.stringify(postToolUseOutput(payload, updatedToolOutput)));
      return;
    }
  }

  // A first read must be byte-identical to disk: Edit old_string matching depends on it.
  // Savings come only from later unchanged full-file reads.
  if (dedupEligible) cache.set(filePath, { hash, headerLine: lineCount, source: 'Read' });
  note('skippedFirstRead');
  passThrough(payload);
}

try {
  const input = readFileSync(0, 'utf8');
  main(input);
} catch {
  // fail-open
}
