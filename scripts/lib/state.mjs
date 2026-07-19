// Session state + savings ledger for tokenslim.
// Ledger lives at $XDG_CACHE_HOME/tokenslim/<sessionId>.json (or ~/.cache/tokenslim/...).
// All I/O is best-effort: any failure (permissions, corrupt JSON, missing dirs) yields a
// fresh/no-op state rather than throwing, so hooks never crash the tool pipeline.

import { chmodSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { updateHistory } from './history.mjs';
import { commandFamily } from './privacy.mjs';

const CHARS_PER_TOKEN = 3; // rough heuristic for code/log text (~3 chars/token)
const INPUT_USD_PER_MTOK = 3; // assumption: $3 / 1M input tokens (Claude Sonnet-class pricing)

function cacheDir() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'tokenslim');
}

// Path traversal guard: only allow [A-Za-z0-9_-] in the session id used for the filename.
function sanitizeSessionId(sessionId) {
  const s = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return s.length > 0 ? s : 'unknown';
}

function statePath(sessionId) {
  return join(cacheDir(), `${sanitizeSessionId(sessionId)}.json`);
}

function freshState() {
  return { version: 1, savings: {}, reads: {}, diagnostics: {} };
}

function isValidState(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.version === 1 &&
    typeof state.savings === 'object' &&
    state.savings !== null &&
    typeof state.reads === 'object' &&
    state.reads !== null
  );
}

export function loadState(sessionId) {
  try {
    const raw = readFileSync(statePath(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    if (isValidState(parsed)) return parsed;
    return freshState();
  } catch {
    return freshState();
  }
}

function secureWriteState(sessionId, state) {
  const directory = cacheDir();
  const path = statePath(sessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  writeFileSync(path, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
}

export function saveState(sessionId, state) {
  try {
    secureWriteState(sessionId, state);
    // History receives only new savings events, rather than this cumulative ledger.
    const events = Array.isArray(state?.historyEvents) ? state.historyEvents : [];
    if (events.length && updateHistory(events)) {
      delete state.historyEvents;
      secureWriteState(sessionId, state);
    }
  } catch {
    // best-effort only; never throw
  }
}

export function recordSavings(state, { tool, bytesIn, bytesOut, command, cwd }) {
  if (!state || typeof state !== 'object') return state;
  if (!state.savings || typeof state.savings !== 'object') state.savings = {};
  const key = String(tool ?? 'unknown');
  const entry = state.savings[key] || { events: 0, bytesIn: 0, bytesOut: 0 };
  entry.events += 1;
  entry.bytesIn += Number(bytesIn) || 0;
  entry.bytesOut += Number(bytesOut) || 0;
  state.savings[key] = entry;
  // Kept only until saveState atomically incorporates this delta into daily history.
  if (!Array.isArray(state.historyEvents)) state.historyEvents = [];
  state.historyEvents.push({ tool: key, bytesIn, bytesOut, command: commandFamily(command || key), cwd });
  return state;
}

export function recordDiagnostic(state, { tool, event, outcome }) {
  if (!state || typeof state !== 'object') return state;
  if (!state.diagnostics || typeof state.diagnostics !== 'object') state.diagnostics = {};
  const toolKey = String(tool ?? 'unknown');
  const eventKey = String(event ?? 'unknown');
  const outcomeKey = String(outcome ?? 'unknown');
  if (!state.diagnostics[toolKey] || typeof state.diagnostics[toolKey] !== 'object') {
    state.diagnostics[toolKey] = {};
  }
  if (!state.diagnostics[toolKey][eventKey] || typeof state.diagnostics[toolKey][eventKey] !== 'object') {
    state.diagnostics[toolKey][eventKey] = {};
  }
  state.diagnostics[toolKey][eventKey][outcomeKey] = (
    Number(state.diagnostics[toolKey][eventKey][outcomeKey]) || 0
  ) + 1;
  return state;
}

export function readCache(state) {
  if (!state || typeof state !== 'object') state = freshState();
  if (!state.reads || typeof state.reads !== 'object') state.reads = {};
  return {
    get(filePath) {
      return state.reads[filePath];
    },
    set(filePath, entry) {
      state.reads[filePath] = entry;
    },
  };
}

// Rough, transparent estimate: bytes / CHARS_PER_TOKEN ~= tokens; cost at INPUT_USD_PER_MTOK.
export function summarize(state) {
  const perTool = {};
  let totalBytesIn = 0;
  let totalBytesOut = 0;
  const savings = (state && state.savings) || {};
  for (const [tool, entry] of Object.entries(savings)) {
    const bytesIn = Number(entry.bytesIn) || 0;
    const bytesOut = Number(entry.bytesOut) || 0;
    const events = Number(entry.events) || 0;
    totalBytesIn += bytesIn;
    totalBytesOut += bytesOut;
    perTool[tool] = { events, bytesIn, bytesOut, bytesSaved: bytesIn - bytesOut };
  }
  const bytesSaved = totalBytesIn - totalBytesOut;
  const estTokensSaved = Math.max(0, Math.round(bytesSaved / CHARS_PER_TOKEN));
  const estCostSavedUsd = (estTokensSaved / 1_000_000) * INPUT_USD_PER_MTOK;
  return {
    totalBytesIn,
    totalBytesOut,
    estTokensSaved,
    estCostSavedUsd,
    perTool,
    diagnostics: (state && state.diagnostics) || {},
  };
}
