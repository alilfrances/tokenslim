// Session state + savings ledger for tokenslim.
// Ledger lives at $XDG_CACHE_HOME/tokenslim/<sessionId>.json (or ~/.cache/tokenslim/...).
// All I/O is best-effort: any failure (permissions, corrupt JSON, missing dirs) yields a
// fresh/no-op state rather than throwing, so hooks never crash the tool pipeline.
// Concurrent hooks can still race at the read-modify-write level, so ledger totals are
// best-effort. Writes themselves are atomic (temp file + rename), never torn JSON.

import { chmodSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BASH_GUARD_KEYS, READ_GUARD_KEYS, updateHistory } from './history.mjs';
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
  const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
    try { chmodSync(path, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  } finally {
    // A failed write/rename must not leave sensitive ledger contents behind.
    try { unlinkSync(temp); } catch { /* renamed or unavailable */ }
  }
}

// History receives only new events, rather than this cumulative ledger.
function flushHistory(sessionId, state) {
  try {
    const events = Array.isArray(state?.historyEvents) ? state.historyEvents : [];
    if (events.length && updateHistory(events)) {
      delete state.historyEvents;
      secureWriteState(sessionId, state);
    }
  } catch {
    // best-effort only; never throw
  }
}

export function saveState(sessionId, state) {
  try {
    secureWriteState(sessionId, state);
  } catch {
    // best-effort only; never throw
    return;
  }
  flushHistory(sessionId, state);
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

// Bytes of tool results that reached a hook's size check, whether or not they were compressed: the honest
// denominator for "% of attempted". Images are never passed in. Kept apart from savings so it never bumps their events.
export function recordAttempted(state, { tool, bytes, cwd }) {
  if (!state || typeof state !== 'object') return state;
  if (!state.attempted || typeof state.attempted !== 'object') state.attempted = {};
  const key = String(tool ?? 'unknown');
  const size = Number(bytes) || 0;
  const entry = state.attempted[key] || { events: 0, bytes: 0 };
  entry.events = (Number(entry.events) || 0) + 1;
  entry.bytes = (Number(entry.bytes) || 0) + size;
  state.attempted[key] = entry;
  if (!Array.isArray(state.historyEvents)) state.historyEvents = [];
  state.historyEvents.push({ kind: 'attempted', tool: key, bytes: size, cwd });
  return state;
}

// Recovery signals for the Bash cap: capped, teeRead, teeCat, rerun. Counted in the ledger diagnostics and as a compact
// daily counter in history, so the recovery rate survives past one session.
export function recordRecovery(state, outcome) {
  if (!state || typeof state !== 'object') return state;
  recordDiagnostic(state, { tool: 'Bash', event: 'recovery', outcome });
  if (!Array.isArray(state.historyEvents)) state.historyEvents = [];
  state.historyEvents.push({ kind: 'recovery', outcome: String(outcome) });
  return state;
}

// Guard counters, in the ledger (state[field]) and as a daily history event of the given kind. Counts and byte sums only:
// never a command, a path or a file name. `deltas` keys are `keys` (BASH_GUARD_KEYS / READ_GUARD_KEYS).
function recordGuard(state, field, keys, deltas) {
  if (!state || typeof state !== 'object') return state;
  const counters = state[field] && typeof state[field] === 'object' ? state[field] : {};
  const event = { kind: field };
  for (const key of keys) {
    const value = Number(deltas?.[key]) || 0;
    if (value <= 0) continue;
    counters[key] = (Number(counters[key]) || 0) + value;
    event[key] = value;
  }
  state[field] = counters;
  if (!Array.isArray(state.historyEvents)) state.historyEvents = [];
  state.historyEvents.push(event);
  return state;
}

// Bash dump guard counters (state.bashGuard, history kind 'bashGuard').
export function recordBashGuard(state, deltas) {
  return recordGuard(state, 'bashGuard', BASH_GUARD_KEYS, deltas);
}

// Read guard counters (state.readGuard, history kind 'readGuard').
export function recordReadGuard(state, deltas) {
  return recordGuard(state, 'readGuard', READ_GUARD_KEYS, deltas);
}

const RECENT_BASH = 3;

// Remembers the last few Bash commands as hashes only (never command text) and reports whether this one repeats a
// command whose output was capped, i.e. the model probably re-ran it to get what the cap hid.
export function noteBashCommand(state, command, capped) {
  if (!state || typeof state !== 'object' || typeof command !== 'string' || !command) return false;
  const ring = Array.isArray(state.recentBash) ? state.recentBash : [];
  const h = createHash('sha256').update(command, 'utf8').digest('hex').slice(0, 16);
  const rerun = ring.some((entry) => entry && entry.h === h && entry.capped === true);
  state.recentBash = [...ring, { h, capped: Boolean(capped) }].slice(-RECENT_BASH);
  return rerun;
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

const GUARD_DENIED_MAX = 200;

// Read-guard deny escape hatch: one load and at most one small write. `key` is sha256(path), so no raw
// paths reach the ledger. Returns 'deny' when this is the first unbounded Read (entry recorded),
// 'allow' when a deny is already pending (entry consumed, so a later third Read starts a new deny cycle),
// and 'error' when a first deny could not be recorded: the caller must then stay silent, because a deny
// that cannot be followed by an allowed repeat would block the Read for good.
// `record(state, verdict)` lets a guard add its counters to the same load/save (and flush them to history).
export function consumeGuardDeny(sessionId, key, record) {
  try {
    const state = loadState(sessionId);
    const denied = state.guardDenied && typeof state.guardDenied === 'object' ? state.guardDenied : {};
    if (Object.hasOwn(denied, key)) {
      delete denied[key];
      state.guardDenied = denied;
      try { record?.(state, 'allow'); } catch { /* counters are best-effort */ }
      try { secureWriteState(sessionId, state); } catch { /* a stale entry only delays the next deny cycle */ }
      flushHistory(sessionId, state);
      return 'allow';
    }
    denied[key] = Date.now();
    const keys = Object.keys(denied);
    for (const old of keys.slice(0, Math.max(0, keys.length - GUARD_DENIED_MAX))) delete denied[old];
    state.guardDenied = denied;
    try { record?.(state, 'deny'); } catch { /* counters are best-effort */ }
    secureWriteState(sessionId, state);
    flushHistory(sessionId, state);
    return 'deny';
  } catch {
    return 'error';
  }
}
