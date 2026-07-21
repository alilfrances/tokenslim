import { stripAnsi } from '../pipeline.mjs';

// Match only recognizable command-failure records. In particular, a successful
// `0 failed` summary and prose mentioning "error" must not close the compression
// funnel. Keep this deliberately structured: callers use it for stderr, while
// stdout is handled by the Bash hook's command-aware failure gate.
export const FAILURE_RE = /(?:^Error:\s|^error(?:\[[A-Z]\d+\])?:|^fatal:\s|^npm ERR!(?:\s|$)|^FAIL(?:ED)?\b|(?<!0 )\bFAILED\b|\bpanicked at\b|\bAssertionError(?::|\b)|\b[1-9]\d*\s+(?:[Ff][Aa][Ii][Ll][Ee][Dd]|[Ee][Rr][Rr][Oo][Rr][Ss]?)\b)/m;

export function hasFailure(text, meta = {}) {
  return Boolean(meta.failed || FAILURE_RE.test(stripAnsi(text)) || FAILURE_RE.test(stripAnsi(meta.stderr)));
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
