#!/usr/bin/env node
// PostToolUse hook for generic MCP tool results.

import { readFileSync } from 'node:fs';
import { loadState, saveState, recordDiagnostic, recordSavings } from './lib/state.mjs';
import { postToolUseNoopOutput, postToolUseOutput } from './lib/hook-output.mjs';
import { locateText } from './lib/read-format.mjs';

const MIN_CHARS = Number(process.env.TOKENSLIM_MIN_CHARS) || 500;
const BASE64_RE = /(?:data:[^,;\s]+;base64,)?[A-Za-z0-9+/]{257,}={0,2}/g;

function isDisabled() {
  const raw = (process.env.TOKENSLIM_DISABLE || '').toLowerCase();
  const flags = raw.split(',').map((s) => s.trim());
  return flags.includes('mcp') || flags.includes('all');
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
  try {
    const parsed = JSON.parse(text);
    transformed = JSON.stringify(collapseHomogeneousTopLevelArray(parsed));
  } catch {
    // Not JSON; base64 truncation still applies to raw text.
  }

  return transformed.replace(BASE64_RE, (match) => (
    `${match.slice(0, 64)}[tokenslim: ${match.length - 64} base64 chars omitted]`
  ));
}

function main(input) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  if (isDisabled()) {
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
  if (text.length < MIN_CHARS) {
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

  const saved = text.length - compressed.length;
  const ratio = text.length > 0 ? saved / text.length : 0;
  if (ratio < 0.1) {
    recordDiagnosticBestEffort(payload, 'skippedPoorRatio');
    passThrough(payload);
    return;
  }

  const updatedToolOutput = locator.set(compressed);
  try {
    const state = loadState(payload?.session_id);
    recordDiagnostic(state, { tool: 'MCP', event: eventName(payload), outcome: 'compressed' });
    recordSavings(state, { tool: 'MCP', bytesIn: text.length, bytesOut: compressed.length });
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
