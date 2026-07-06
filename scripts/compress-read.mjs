#!/usr/bin/env node
// PostToolUse hook for the Read tool.
//
// tool_response shape for Read is undocumented, so the text-bearing field is located
// defensively (see locateText below) and every other field is mirrored byte-identical.
// Fails open on anything unexpected: no stdout, exit 0.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadState, saveState, recordDiagnostic, recordSavings, readCache } from './lib/state.mjs';
import { postToolUseOutput } from './lib/hook-output.mjs';

const MIN_CHARS = Number(process.env.TOKENSLIM_MIN_CHARS) || 500;

function isDisabled() {
  const raw = (process.env.TOKENSLIM_DISABLE || '').toLowerCase();
  const flags = raw.split(',').map((s) => s.trim());
  return flags.includes('read') || flags.includes('all');
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

// Locate the text-bearing field inside the Read tool_response.
// Confirmed shape (docs/SHAPES.md, empirically verified): { type:"text", file:{ filePath,
// content, numLines, startLine, totalLines } }. That is checked first; other shapes are
// kept as defensive fallbacks in case the runtime shape ever changes underneath us.
// Returns { get(): string, set(newText): newToolResponse } or null if unrecognized.
function locateText(toolResponse) {
  if (typeof toolResponse === 'string') {
    return { get: () => toolResponse, set: (t) => t };
  }
  if (Array.isArray(toolResponse)) {
    const textBlocks = toolResponse
      .map((block, i) => ({ block, i }))
      .filter(({ block }) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string');
    if (textBlocks.length !== 1) return null; // ambiguous or absent -> unrecognized
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
    // Primary, confirmed shape: file.content, with numLines kept in sync on replace.
    if (toolResponse.file && typeof toolResponse.file === 'object' && typeof toolResponse.file.content === 'string') {
      return {
        get: () => toolResponse.file.content,
        set: (t) => ({
          ...toolResponse,
          file: { ...toolResponse.file, content: t, numLines: t.split('\n').length },
        }),
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

function isBlankLine(line) {
  const m = line.match(/^(\s*\d+\t)(.*)$/s);
  const content = m ? m[2] : line;
  return content.trim() === '';
}

function stripTrailingWhitespace(line) {
  const m = line.match(/^(\s*\d+\t)(.*)$/s);
  if (m) return m[1] + m[2].replace(/[ \t]+$/, '');
  return line.replace(/[ \t]+$/, '');
}

// First-read slim: strip trailing whitespace per line + collapse runs of 3+ blank
// lines to a single blank line. No comment/code changes.
function slimText(text) {
  const lines = text.split('\n').map(stripTrailingWhitespace);
  const out = [];
  let blankBuffer = [];
  const flush = () => {
    if (blankBuffer.length === 0) return;
    if (blankBuffer.length >= 3) out.push(blankBuffer[0]);
    else out.push(...blankBuffer);
    blankBuffer = [];
  };
  for (const line of lines) {
    if (isBlankLine(line)) {
      blankBuffer.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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
  if (isDisabled()) {
    recordDiagnosticBestEffort(sessionId, event, 'disabled');
    return;
  }
  recordDiagnosticBestEffort(sessionId, event, 'attempted');

  const toolResponse = payload && payload.tool_response;
  const toolInput = (payload && payload.tool_input) || {};
  const filePath = toolInput.file_path || (toolResponse && toolResponse.file && toolResponse.file.filePath);

  const locator = locateText(toolResponse);
  if (!locator) {
    recordDiagnosticBestEffort(sessionId, event, 'unsupportedShape');
    return;
  }

  const text = locator.get();
  if (typeof text !== 'string') {
    recordDiagnosticBestEffort(sessionId, event, 'unsupportedShape');
    return;
  }
  if (text.length < MIN_CHARS) {
    recordDiagnosticBestEffort(sessionId, event, 'skippedBelowThreshold');
    return;
  }

  const hash = sha256(text);
  const lineCount = text.split('\n').length;
  const dedupEligible =
    filePath != null && toolInput.offset == null && toolInput.limit == null;

  const state = loadState(sessionId);
  const cache = readCache(state);
  let stateDirty = false;

  if (dedupEligible) {
    const existing = cache.get(filePath);
    if (existing && existing.hash === hash) {
      const stub = `[tokenslim] ${filePath} unchanged since previous read in this session (${existing.headerLine} lines, sha256:${hash.slice(0, 12)}). Content already in context above.`;
      const updatedToolOutput = locator.set(stub);
      recordDiagnostic(state, { tool: 'Read', event, outcome: 'compressed' });
      recordSavings(state, { tool: 'Read', bytesIn: text.length, bytesOut: stub.length });
      saveState(sessionId, state);
      process.stdout.write(JSON.stringify(postToolUseOutput(payload, updatedToolOutput)));
      return;
    }
  }

  const slimmed = slimText(text);
  if (dedupEligible) {
    cache.set(filePath, { hash, headerLine: lineCount });
    stateDirty = true;
  }

  const saved = text.length - slimmed.length;
  const ratio = text.length > 0 ? saved / text.length : 0;
  if (ratio >= 0.1) {
    const updatedToolOutput = locator.set(slimmed);
    recordDiagnostic(state, { tool: 'Read', event, outcome: 'compressed' });
    recordSavings(state, { tool: 'Read', bytesIn: text.length, bytesOut: slimmed.length });
    stateDirty = true;
    saveState(sessionId, state);
    process.stdout.write(JSON.stringify(postToolUseOutput(payload, updatedToolOutput)));
    return;
  }

  recordDiagnostic(state, { tool: 'Read', event, outcome: 'skippedPoorRatio' });
  saveState(sessionId, state);
}

try {
  const input = readFileSync(0, 'utf8');
  main(input);
} catch {
  // fail open
}
