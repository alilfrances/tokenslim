#!/usr/bin/env node
// PostToolUse hook for Edit/Write. Keeps Read dedup cache warm after safe edits.

import { readFileSync } from 'node:fs';
import { loadState, saveState, readCache, recordDiagnostic } from './lib/state.mjs';
import { DEFAULT_READ_LINE_LIMIT, readFileRaw, sha256 } from './lib/read-format.mjs';
import { postToolUseNoopOutput } from './lib/hook-output.mjs';
import { loadConfig } from './lib/config.mjs';


function isDisabled(config) {
  const flags = Array.isArray(config?.disable) ? config.disable : [];
  const normalized = flags.map((flag) => String(flag).trim().toLowerCase());
  return normalized.includes('edit') || normalized.includes('all');
}

function recordDiagnosticBestEffort(payload, outcome) {
  try {
    const state = loadState(payload?.session_id);
    recordDiagnostic(state, { tool: 'Edit', event: payload?.hook_event_name || 'PostToolUse', outcome });
    saveState(payload?.session_id, state);
  } catch {
    // best-effort only
  }
}

function passThrough(payload) {
  const output = postToolUseNoopOutput(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}

function filePathFromPayload(payload) {
  const input = payload?.tool_input;
  return input?.file_path || input?.filePath || input?.path;
}

function isSuccessful(payload) {
  const response = payload?.tool_response;
  if (payload?.is_error || payload?.error) return false;
  if (response && typeof response === 'object' && (response.is_error || response.error)) return false;
  return true;
}

function updateCache(payload, config) {
  const toolName = payload?.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write') return 'unsupportedTool';
  if (!isSuccessful(payload)) return 'toolFailed';

  const filePath = filePathFromPayload(payload);
  if (!filePath) return 'missingPath';

  const state = loadState(payload?.session_id);
  const cache = readCache(state);
  const existing = cache.get(filePath);
  if (toolName === 'Edit' && !existing) return 'skippedNoPriorRead';

  const text = readFileRaw(filePath);
  const lineCount = text.split('\n').length;
  const lineLimit = Number.isFinite(config?.readDefaultLines) ? config.readDefaultLines : DEFAULT_READ_LINE_LIMIT;
  if (lineCount > lineLimit) return 'skippedOversized';

  cache.set(filePath, {
    hash: sha256(text),
    headerLine: lineCount,
    source: toolName,
  });
  saveState(payload?.session_id, state);
  return 'updated';
}

function main(input) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  const config = loadConfig(payload?.cwd || process.cwd(), process.env);
  if (isDisabled(config)) {
    recordDiagnosticBestEffort(payload, 'disabled');
    passThrough(payload);
    return;
  }

  try {
    recordDiagnosticBestEffort(payload, updateCache(payload, config));
  } catch {
    recordDiagnosticBestEffort(payload, 'failedOpen');
  }
  passThrough(payload);
}

try {
  main(readFileSync(0, 'utf8'));
} catch {
  // fail-open
}
