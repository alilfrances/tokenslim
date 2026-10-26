#!/usr/bin/env node
// PreToolUse guard for large unbounded Read calls.

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync as readStdinSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { detectRuntime, preToolUseAdditionalContextOutput, preToolUseDenyOutput } from './lib/hook-output.mjs';
import { loadConfig } from './lib/config.mjs';
import { isTextLikePath, outlineFile } from './lib/outline.mjs';
import { consumeGuardDeny } from './lib/state.mjs';
import { CHARS_PER_TOKEN, guardDenyReason } from './lib/guard-reason.mjs';

const DEFAULT_THRESHOLD = 2000;
const COUNT_BYTE_CAP = 5 * 1024 * 1024;

function isDisabled(config) {
  const flags = Array.isArray(config?.disable) ? config.disable : [];
  const normalized = flags.map((flag) => String(flag).trim().toLowerCase());
  return normalized.includes('readguard') || normalized.includes('all');
}

// Count incrementally so a PreToolUse hook never materializes a giant artifact.
// `capped` means this is a lower bound, not an exact line count.
function countLinesCapped(filePath, size) {
  const limit = Math.min(size, COUNT_BYTE_CAP);
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, limit)));
  let position = 0;
  let newlines = 0;
  let fd;
  try {
    fd = openSync(filePath, 'r');
    while (position < limit) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, limit - position), position);
      if (!read) break;
      for (let i = 0; i < read; i += 1) if (buffer[i] === 10) newlines += 1;
      position += read;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { lines: newlines + 1, capped: size > position };
}

function hasBounds(input) {
  return Boolean(input && (input.offset != null || input.limit != null));
}

// Deny mode: first unbounded Read of a big text file is refused with a size line and outline; repeating
// the identical Read is allowed (the state entry is consumed, so a later third Read starts a new cycle).
// Returns false to fall back to the advisory hint (not a deny candidate), true when handled.
function denyOrAllow(payload, filePath, size, lineInfo) {
  if (!isTextLikePath(filePath) || typeof payload?.session_id !== 'string' || !payload.session_id) return false;
  if (detectRuntime(payload) === 'codex') return false;
  const verdict = consumeGuardDeny(payload.session_id, createHash('sha256').update(resolve(filePath)).digest('hex'));
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
