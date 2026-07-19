import { stripAnsi } from '../pipeline.mjs';

export const FAILURE_RE = /\b(?:FAIL(?:ED|URE)?|ERROR|Error:|AssertionError|Exception|panic(?:ked)?|fatal:)\b/i;

export function hasFailure(text, meta = {}) {
  return Boolean(meta.failed || meta.stderr || FAILURE_RE.test(String(text ?? '')));
}

export function result(text, rule) {
  return { text: String(text ?? '').replace(/\n+$/g, ''), rulesApplied: [rule] };
}

export function clean(text) {
  return stripAnsi(String(text ?? '')).replace(/\r\n/g, '\n').replace(/\n+$/g, '');
}

export function lines(text) {
  return clean(text).split('\n').filter((line) => line.trim());
}
