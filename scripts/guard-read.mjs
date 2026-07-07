#!/usr/bin/env node
// PreToolUse guard for large unbounded Read calls.

import { existsSync, readFileSync } from 'node:fs';
import { readFileSync as readStdinSync } from 'node:fs';
import { preToolUseAdditionalContextOutput } from './lib/hook-output.mjs';

const DEFAULT_THRESHOLD = 2000;
const CHARS_PER_TOKEN = 3;

function isDisabled() {
  const raw = (process.env.TOKENSLIM_DISABLE || '').toLowerCase();
  const flags = raw.split(',').map((s) => s.trim());
  return flags.includes('readguard') || flags.includes('all');
}

function countLines(text) {
  return text.split('\n').length;
}

function hasBounds(input) {
  return Boolean(input && (input.offset != null || input.limit != null));
}

function main(inputText) {
  let payload;
  try {
    payload = JSON.parse(inputText);
  } catch {
    return;
  }
  if (isDisabled()) return;

  const toolInput = payload?.tool_input || {};
  const filePath = toolInput.file_path;
  if (!filePath || hasBounds(toolInput) || !existsSync(filePath)) return;

  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  const threshold = Number(process.env.TOKENSLIM_READ_GUARD_LINES) || DEFAULT_THRESHOLD;
  const lines = countLines(content);
  if (lines <= threshold) return;

  const tokens = Math.round(content.length / CHARS_PER_TOKEN);
  const context = `[tokenslim] ${filePath} is ${lines} lines (~${tokens} tokens). Consider offset/limit or Grep.`;
  process.stdout.write(JSON.stringify(preToolUseAdditionalContextOutput(payload, context)));
}

try {
  main(readStdinSync(0, 'utf8'));
} catch {
  // fail-open
}
