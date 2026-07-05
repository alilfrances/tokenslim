// Session state + savings ledger for tokenslim.
// Ledger lives at $XDG_CACHE_HOME/tokenslim/<sessionId>.json (or ~/.cache/tokenslim/...).
// All I/O is best-effort: any failure (permissions, corrupt JSON, missing dirs) yields a
// fresh/no-op state rather than throwing, so hooks never crash the tool pipeline.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
  return { version: 1, savings: {}, reads: {} };
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

export function saveState(sessionId, state) {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(statePath(sessionId), JSON.stringify(state), 'utf8');
  } catch {
    // best-effort only; never throw
  }
}

export function recordSavings(state, { tool, bytesIn, bytesOut }) {
  if (!state || typeof state !== 'object') return state;
  if (!state.savings || typeof state.savings !== 'object') state.savings = {};
  const key = String(tool ?? 'unknown');
  const entry = state.savings[key] || { events: 0, bytesIn: 0, bytesOut: 0 };
  entry.events += 1;
  entry.bytesIn += Number(bytesIn) || 0;
  entry.bytesOut += Number(bytesOut) || 0;
  state.savings[key] = entry;
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
  return { totalBytesIn, totalBytesOut, estTokensSaved, estCostSavedUsd, perTool };
}
