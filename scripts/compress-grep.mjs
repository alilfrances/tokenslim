#!/usr/bin/env node
// PostToolUse hook for Grep/Glob.
//
// Confirmed shapes (docs/SHAPES.md, empirically verified):
//   Grep (output_mode: content): { mode:"content", numFiles, filenames, content, numLines }
//     text field: tool_response.content. Other modes (files_with_matches/count) have no
//     text field and are already compact -> passed through untouched.
//   Glob: { filenames:[...], durationMs, numFiles, truncated, totalMatches, countIsComplete }
//     no text field at all; compression shortens the filenames array itself. durationMs is
//     nondeterministic and is always copied verbatim, never synthesized.
// Defensive fallbacks (string / .content / .output / .text / text-block-array) are kept as
// secondary paths in case the runtime shape ever changes underneath us.

import { readFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { loadState, saveState, recordDiagnostic, recordSavings } from './lib/state.mjs';
import { postToolUseOutput } from './lib/hook-output.mjs';

const MIN_CHARS = Number(process.env.TOKENSLIM_MIN_CHARS) || 500;

function isDisabled() {
  const raw = (process.env.TOKENSLIM_DISABLE || '').toLowerCase();
  const flags = raw.split(',').map((s) => s.trim());
  return flags.includes('grep') || flags.includes('all');
}

function eventName(payload) {
  return payload?.hook_event_name || 'PostToolUse';
}

function diagnosticTool(payload) {
  return payload?.tool_name === 'Glob' ? 'Glob' : 'Grep';
}

function recordDiagnosticBestEffort(payload, outcome) {
  const sessionId = payload && payload.session_id;
  try {
    const state = loadState(sessionId);
    recordDiagnostic(state, { tool: diagnosticTool(payload), event: eventName(payload), outcome });
    saveState(sessionId, state);
  } catch {
    // best-effort diagnostics only
  }
}

// Locate the text-bearing field on a Grep tool_response. Returns
// { get(): string, set(newText): newToolResponse } or null if unrecognized / not text-bearing
// (e.g. Grep in files_with_matches/count mode).
function locateText(toolResponse) {
  if (typeof toolResponse === 'string') {
    return { get: () => toolResponse, set: (t) => t };
  }
  if (Array.isArray(toolResponse)) {
    const textBlocks = toolResponse
      .map((block, i) => ({ block, i }))
      .filter(({ block }) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string');
    if (textBlocks.length !== 1) return null;
    const { i } = textBlocks[0];
    return {
      get: () => toolResponse[i].text,
      set: (t) => {
        const copy = toolResponse.slice();
        copy[i] = { ...toolResponse[i], text: t };
        return copy;
      },
    };
  }
  if (toolResponse && typeof toolResponse === 'object') {
    // Primary, confirmed shape: Grep output_mode "content".
    if (toolResponse.mode === 'content' && typeof toolResponse.content === 'string') {
      return {
        get: () => toolResponse.content,
        set: (t) => ({ ...toolResponse, content: t, numLines: t.split('\n').length }),
      };
    }
    if (typeof toolResponse.content === 'string') {
      return { get: () => toolResponse.content, set: (t) => ({ ...toolResponse, content: t }) };
    }
    if (typeof toolResponse.output === 'string') {
      return { get: () => toolResponse.output, set: (t) => ({ ...toolResponse, output: t }) };
    }
    if (typeof toolResponse.text === 'string') {
      return { get: () => toolResponse.text, set: (t) => ({ ...toolResponse, text: t }) };
    }
  }
  return null;
}

function dedupExactLines(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

// ripgrep-style "path:line:content" prefix; falls back to no-file (null) for lines
// that don't match, which forces a group boundary.
function extractFile(line) {
  const m = line.match(/^([^\n]+?):\d+:/);
  return m ? m[1] : null;
}

// Collapse runs of 4+ consecutive lines from the same file down to the first 3 plus
// a one-line summary of how many more were omitted.
function collapseRepeatedMatches(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const file = extractFile(lines[i]);
    if (file == null) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && extractFile(lines[j]) === file) j += 1;
    const group = lines.slice(i, j);
    if (group.length > 3) {
      out.push(...group.slice(0, 3));
      out.push(`... [tokenslim: ${group.length - 3} more matches in ${file}]`);
    } else {
      out.push(...group);
    }
    i = j;
  }
  return out;
}

function compressGrepText(text) {
  const lines = text.split('\n');
  return collapseRepeatedMatches(dedupExactLines(lines)).join('\n');
}

// Groups a >100-entry Glob filenames array into per-directory summary strings.
// Each summary is itself a plain string, so the array shape stays valid.
function groupFilenames(filenames) {
  const byDir = new Map();
  const order = [];
  for (const p of filenames) {
    const dir = dirname(p);
    if (!byDir.has(dir)) {
      byDir.set(dir, []);
      order.push(dir);
    }
    byDir.get(dir).push(basename(p));
  }
  return order.map((dir) => {
    const files = byDir.get(dir);
    const shown = files.slice(0, 5).join(', ');
    const suffix = files.length > 5 ? ', ...' : '';
    return `${dir}/ (${files.length} files: ${shown}${suffix})`;
  });
}

function recordAndEmit(payload, updatedToolOutput, bytesIn, bytesOut) {
  const sessionId = payload && payload.session_id;
  try {
    const state = loadState(sessionId);
    recordDiagnostic(state, { tool: diagnosticTool(payload), event: eventName(payload), outcome: 'compressed' });
    // Both Grep and Glob roll up under a single "Grep" ledger bucket per spec.
    recordSavings(state, { tool: 'Grep', bytesIn, bytesOut });
    saveState(sessionId, state);
  } catch {
    // ledger is best-effort; never block the compressed output
  }
  process.stdout.write(
    JSON.stringify(postToolUseOutput(payload, updatedToolOutput))
  );
}

// Glob: no text field, so it's handled separately from the locateText/content path.
// Returns true if it handled (emitted or intentionally passed through) the response.
function tryHandleGlob(payload, toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object' || !Array.isArray(toolResponse.filenames)) {
    return false;
  }
  const filenames = toolResponse.filenames;
  const origSerialized = JSON.stringify(filenames);
  if (origSerialized.length < MIN_CHARS || filenames.length <= 100) {
    recordDiagnosticBestEffort(payload, 'skippedBelowThreshold');
    return true; // recognized, nothing to do
  }

  const grouped = groupFilenames(filenames);
  const newSerialized = JSON.stringify(grouped);
  const ratio = (origSerialized.length - newSerialized.length) / origSerialized.length;
  if (ratio < 0.1) {
    recordDiagnosticBestEffort(payload, 'skippedPoorRatio');
    return true;
  }

  const updatedToolOutput = { ...toolResponse, filenames: grouped };
  recordAndEmit(payload, updatedToolOutput, origSerialized.length, newSerialized.length);
  return true;
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
    return;
  }
  recordDiagnosticBestEffort(payload, 'attempted');

  const toolResponse = payload && payload.tool_response;
  const toolName = payload && payload.tool_name;
  if (!toolResponse) {
    recordDiagnosticBestEffort(payload, 'unsupportedShape');
    return;
  }

  if (toolName === 'Glob') {
    tryHandleGlob(payload, toolResponse);
    return;
  }

  const locator = locateText(toolResponse);
  if (!locator) {
    recordDiagnosticBestEffort(payload, 'unsupportedShape');
    return;
  }

  const text = locator.get();
  if (typeof text !== 'string') {
    recordDiagnosticBestEffort(payload, 'unsupportedShape');
    return;
  }
  if (text.length < MIN_CHARS) {
    recordDiagnosticBestEffort(payload, 'skippedBelowThreshold');
    return;
  }

  const compressed = compressGrepText(text);

  const saved = text.length - compressed.length;
  const ratio = text.length > 0 ? saved / text.length : 0;
  if (ratio < 0.1) {
    recordDiagnosticBestEffort(payload, 'skippedPoorRatio');
    return;
  }

  const updatedToolOutput = locator.set(compressed);
  recordAndEmit(payload, updatedToolOutput, text.length, compressed.length);
}

try {
  const input = readFileSync(0, 'utf8');
  main(input);
} catch {
  // fail open
}
