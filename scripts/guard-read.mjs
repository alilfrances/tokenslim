#!/usr/bin/env node
// PreToolUse guard for large unbounded Read calls.

import { existsSync, statSync, readFileSync as readStdinSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { detectRuntime, preToolUseAdditionalContextOutput, preToolUseDenyOutput } from './lib/hook-output.mjs';
import { loadConfig } from './lib/config.mjs';
import { isTextLikePath, outlineFile } from './lib/outline.mjs';
import { consumeGuardDeny, loadState, recordReadGuard, saveState } from './lib/state.mjs';
import { countLinesCapped } from './lib/line-count.mjs';
import { CHARS_PER_TOKEN, guardDenyReason } from './lib/guard-reason.mjs';

const DEFAULT_THRESHOLD = 2000;
const DEFAULT_READ_LINES = 2000;

function isDisabled(config) {
  const flags = Array.isArray(config?.disable) ? config.disable : [];
  const normalized = flags.map((flag) => String(flag).trim().toLowerCase());
  return normalized.includes('readguard') || normalized.includes('all');
}

function hasBounds(input) {
  return Boolean(input && (input.offset != null || input.limit != null));
}

// Read guard counters, so `readGuard.mode: "deny"` can be judged on real data. Counts and byte sums only: never a path, a
// file name or content. One load/save, best effort.
function count(sessionId, deltas) {
  try {
    const state = loadState(sessionId);
    recordReadGuard(state, deltas);
    saveState(sessionId, state);
  } catch {
    // counters are best-effort
  }
}

// Deny mode: first unbounded Read of a big text file is refused with a size line and outline; repeating
// the identical Read is allowed (the state entry is consumed, so a later third Read starts a new cycle).
// Returns false to fall back to the advisory hint (not a deny candidate), true when handled.
function denyOrAllow(payload, filePath, size, lineInfo) {
  if (!isTextLikePath(filePath) || typeof payload?.session_id !== 'string' || !payload.session_id) return false;
  if (detectRuntime(payload) === 'codex') {
    count(payload.session_id, { skippedRuntime: 1 });
    return false;
  }
  const verdict = consumeGuardDeny(
    payload.session_id,
    createHash('sha256').update(resolve(filePath)).digest('hex'),
    (state, outcome) => recordReadGuard(state, outcome === 'deny' ? { denied: 1 } : { repeated: 1 }),
  );
  if (verdict !== 'deny') return true;
  let outline = null;
  try {
    outline = outlineFile(filePath, size);
  } catch {
    // unreadable now: still deny with the size line; the repeat Read will surface the real error
  }
  const reason = guardDenyReason({ filePath, size, lineInfo, outline });
  process.stdout.write(JSON.stringify(preToolUseDenyOutput(payload, reason)));
  return true;
}

// Advise mode: count what deny would have acted on (same candidate test as denyOrAllow). The bytes are an estimate of what
// the Read would have returned: Claude Code's unbounded Read stops at readDefaultLines lines, and a capped line count is a
// lower bound, so the ratio is an upper bound either way.
function countWouldDeny(payload, filePath, size, lineInfo, config) {
  if (!isTextLikePath(filePath) || typeof payload?.session_id !== 'string' || !payload.session_id) return;
  if (detectRuntime(payload) === 'codex') return;
  const readLines = Number.isFinite(config.readDefaultLines) ? config.readDefaultLines : DEFAULT_READ_LINES;
  const returned = lineInfo.lines > 0 ? Math.round(size * Math.min(1, readLines / lineInfo.lines)) : size;
  count(payload.session_id, { wouldDeny: 1, wouldDenyBytes: returned });
}

function main(inputText) {
  let payload;
  try {
    payload = JSON.parse(inputText);
  } catch {
    return;
  }
  const config = loadConfig(payload?.cwd || process.cwd(), process.env);
  if (isDisabled(config) || config.readGuard?.mode === 'off') return;

  const toolInput = payload?.tool_input || {};
  const filePath = toolInput.file_path;
  if (!filePath || hasBounds(toolInput) || !existsSync(filePath)) return;

  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }

  let lineInfo;
  try {
    lineInfo = countLinesCapped(filePath, size);
  } catch {
    return;
  }

  const threshold = Number.isFinite(config.readGuard?.lines) ? config.readGuard.lines : DEFAULT_THRESHOLD;
  const maxBytes = config.readGuard?.bytes > 0 ? config.readGuard.bytes : 0;
  if (!lineInfo.capped && lineInfo.lines <= threshold && !(maxBytes && size > maxBytes)) return;

  if (config.readGuard?.mode === 'deny') {
    try {
      if (denyOrAllow(payload, filePath, size, lineInfo)) return;
    } catch {
      return;
    }
  } else {
    countWouldDeny(payload, filePath, size, lineInfo, config);
  }

  const lines = lineInfo.capped ? `>${lineInfo.lines}` : String(lineInfo.lines);
  const tokens = Math.round(size / CHARS_PER_TOKEN);
  const context = `[tokenslim] ${filePath} is ${lines} lines (~${tokens} tokens). Consider offset/limit or Grep.`;
  process.stdout.write(JSON.stringify(preToolUseAdditionalContextOutput(payload, context)));
}

try {
  main(readStdinSync(0, 'utf8'));
} catch {
  // fail-open
}
