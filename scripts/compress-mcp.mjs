#!/usr/bin/env node
// PostToolUse hook for generic MCP tool results.

import { readFileSync } from 'node:fs';
import { loadState, saveState, recordDiagnostic, recordSavings } from './lib/state.mjs';
import { postToolUseNoopOutput, postToolUseOutput } from './lib/hook-output.mjs';
import { locateText } from './lib/read-format.mjs';
import { loadConfig } from './lib/config.mjs';
import { appendTeePath, teeOriginalOutput } from './lib/tee.mjs';
const BASE64_RE = /(?:data:[^,;\s]+;base64,)?[A-Za-z0-9+/]{257,}={0,2}/g;

function isDisabled(config) {
  const flags = Array.isArray(config?.disable) ? config.disable : [];
  const normalized = flags.map((flag) => String(flag).toLowerCase());
  return normalized.includes('mcp') || normalized.includes('all');
}

function eventName(payload) {
  return payload?.hook_event_name || 'PostToolUse';
}

function recordDiagnosticBestEffort(payload, outcome) {
  try {
    const state = loadState(payload?.session_id);
    recordDiagnostic(state, { tool: 'MCP', event: eventName(payload), outcome });
    saveState(payload?.session_id, state);
  } catch {
    // best-effort diagnostics only
  }
}

function passThrough(payload) {
  const output = postToolUseNoopOutput(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}

function collapseHomogeneousTopLevelArray(value) {
  if (process.env.TOKENSLIM_MCP_ARRAYS !== '1') return value;
  if (!Array.isArray(value) || value.length <= 50) return value;
  if (!value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) return value;

  const keys = Object.keys(value[0]).sort();
  const sameKeys = value.every((item) => {
    const itemKeys = Object.keys(item).sort();
    return itemKeys.length === keys.length && itemKeys.every((key, i) => key === keys[i]);
  });
  if (!sameKeys) return value;

  return [
    ...value.slice(0, 10),
    `[tokenslim: ${value.length - 10} more items, same keys: ${keys.join(',')}]`,
  ];
}

function transformText(text) {
  let transformed = text;
  let lossy = false;
  try {
    const parsed = JSON.parse(text);
    const collapsed = collapseHomogeneousTopLevelArray(parsed);
    lossy = JSON.stringify(collapsed) !== JSON.stringify(parsed);
    transformed = JSON.stringify(collapsed);
  } catch {
    // Not JSON; base64 truncation still applies to raw text.
  }

  transformed = transformed.replace(BASE64_RE, (match) => {
    lossy = true;
    return `${match.slice(0, 64)}[tokenslim: ${match.length - 64} base64 chars omitted]`;
  });
  return { text: transformed, lossy };
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
  recordDiagnosticBestEffort(payload, 'attempted');

  const locator = locateText(payload?.tool_response);
  if (!locator) {
    recordDiagnosticBestEffort(payload, 'unsupportedShape');
    passThrough(payload);
    return;
  }

  const text = locator.get();
  if (typeof text !== 'string') {
    recordDiagnosticBestEffort(payload, 'unsupportedShape');
    passThrough(payload);
    return;
  }
  const minChars = Number.isFinite(config.minChars) ? config.minChars : 500;
  if (text.length < minChars) {
    recordDiagnosticBestEffort(payload, 'skippedBelowThreshold');
    passThrough(payload);
    return;
  }

  let compressed;
  try {
    compressed = transformText(text);
  } catch {
    recordDiagnosticBestEffort(payload, 'failedOpen');
    passThrough(payload);
    return;
  }

  const saved = text.length - compressed.text.length;
  const ratio = text.length > 0 ? saved / text.length : 0;
  if (ratio < 0.1) {
    recordDiagnosticBestEffort(payload, 'skippedPoorRatio');
    passThrough(payload);
    return;
  }

  const recoveryPath = teeOriginalOutput(text, {
    sessionId: payload?.session_id,
    toolUseId: payload?.tool_use_id,
    config,
    env: process.env,
    lossy: compressed.lossy,
    failed: Boolean(payload?.tool_response?.stderr || payload?.tool_response?.exitCode || payload?.tool_response?.exit_code),
  });
  const updatedToolOutput = locator.set(appendTeePath(compressed.text, recoveryPath));
  try {
    const state = loadState(payload?.session_id);
    recordDiagnostic(state, { tool: 'MCP', event: eventName(payload), outcome: 'compressed' });
    recordSavings(state, { tool: 'MCP', bytesIn: Buffer.byteLength(text, 'utf8'), bytesOut: Buffer.byteLength(appendTeePath(compressed.text, recoveryPath), 'utf8'), command: payload?.tool_name || 'MCP', cwd: payload?.cwd });
    saveState(payload?.session_id, state);
  } catch {
    // savings are best-effort
  }
  process.stdout.write(JSON.stringify(postToolUseOutput(payload, updatedToolOutput)));
}

try {
  main(readFileSync(0, 'utf8'));
} catch {
  // fail-open
}
