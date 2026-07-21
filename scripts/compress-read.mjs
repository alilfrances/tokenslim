#!/usr/bin/env node
// PostToolUse hook for Read.

import { readFileSync } from 'node:fs';
import { loadState, saveState, recordDiagnostic, recordSavings, readCache } from './lib/state.mjs';
import { postToolUseNoopOutput, postToolUseOutput } from './lib/hook-output.mjs';
import { hasBoundedRead, locateText, sha256 } from './lib/read-format.mjs';
import { loadConfig } from './lib/config.mjs';

function isDisabled(config) {
  const flags = Array.isArray(config?.disable) ? config.disable : [];
  const normalized = flags.map((flag) => String(flag).trim().toLowerCase());
  return normalized.includes('read') || normalized.includes('all');
}

function recordDiagnosticBestEffort(sessionId, event, outcome) {
  try {
    const state = loadState(sessionId);
    recordDiagnostic(state, { tool: 'Read', event, outcome });
    saveState(sessionId, state);
  } catch {
    // best-effort diagnostics only
  }
}

function passThrough(payload) {
  const output = postToolUseNoopOutput(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}

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
  if (isDisabled(config)) {
    recordDiagnosticBestEffort(sessionId, event, 'disabled');
    passThrough(payload);
    return;
  }
  recordDiagnosticBestEffort(sessionId, event, 'attempted');

  const toolResponse = payload && payload.tool_response;
  const toolInput = (payload && payload.tool_input) || {};
  const filePath = toolInput.file_path || (toolResponse && toolResponse.file && toolResponse.file.filePath);
  const locator = locateText(toolResponse);
  if (!locator) {
    recordDiagnosticBestEffort(sessionId, event, 'unsupportedShape');
    passThrough(payload);
    return;
  }

  const text = locator.get();
  if (typeof text !== 'string') {
    recordDiagnosticBestEffort(sessionId, event, 'unsupportedShape');
    passThrough(payload);
    return;
  }
  if (text.length < config.minChars) {
    recordDiagnosticBestEffort(sessionId, event, 'skippedBelowThreshold');
    passThrough(payload);
    return;
  }

  const hash = sha256(text);
  const lineCount = text.split('\n').length;
  const dedupEligible = Boolean(filePath) && !hasBoundedRead(toolInput);
  const state = loadState(sessionId);
  const cache = readCache(state);

  if (dedupEligible) {
    const existing = cache.get(filePath);
    if (existing && existing.hash === hash) {
      const fromEdit = existing.source === 'Edit' || existing.source === 'Write';
      const stub = fromEdit
        ? `[tokenslim] ${filePath} unchanged since your last Edit/Write in this session (${existing.headerLine} lines, sha256:${hash.slice(0, 12)}) — content reconstructible from context above. If the content is no longer in context, re-read with offset/limit (bounded reads bypass this stub).`
        : `[tokenslim] ${filePath} unchanged since previous read in this session (${existing.headerLine} lines, sha256:${hash.slice(0, 12)}). Content already in context above. If the content is no longer in context, re-read with offset/limit (bounded reads bypass this stub).`;
      const updatedToolOutput = locator.set(stub);
      recordDiagnostic(state, { tool: 'Read', event, outcome: 'deduped' });
      recordSavings(state, { tool: fromEdit ? 'Edit' : 'Read', bytesIn: Buffer.byteLength(text), bytesOut: Buffer.byteLength(stub), command: toolInput?.file_path || 'Read', cwd: payload?.cwd });
      saveState(sessionId, state);
      process.stdout.write(JSON.stringify(postToolUseOutput(payload, updatedToolOutput)));
      return;
    }
  }

  // A first read must be byte-identical to disk: Edit old_string matching depends on it.
  // Savings come only from later unchanged full-file reads.
  if (dedupEligible) cache.set(filePath, { hash, headerLine: lineCount, source: 'Read' });
  recordDiagnostic(state, { tool: 'Read', event, outcome: 'skippedFirstRead' });
  saveState(sessionId, state);
  passThrough(payload);
}

try {
  const input = readFileSync(0, 'utf8');
  main(input);
} catch {
  // fail-open
}
