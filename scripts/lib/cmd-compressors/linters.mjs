import { lines, result } from './shared.mjs';

const BINARIES = new Set(['eslint', 'tsc', 'ruff']);

export function compress(text, meta = {}) {
  // Linter diagnostics are the expected output of these commands, not runner failures.
  if (!BINARIES.has(meta.binary) || meta.failed || meta.stderr) return null;
  const input = lines(text);
  const diagnostics = input.filter((line) => /\b(?:warning|error)\b/i.test(line));
  if (!diagnostics.length) {
    const success = input.filter((line) => /(?:no problems|found 0 errors|all checks passed)/i.test(line));
    return success.length ? result(success.join('\n'), 'linterSummary') : null;
  }
  let currentFile = '';
  const grouped = new Map();
  for (const line of input) {
    if (/^(?:\/|[\w.-]+\/)[\w./-]+\.[\w]+$/.test(line)) { currentFile = line; continue; }
    if (!/\b(?:warning|error)\b/i.test(line)) continue;
    const file = line.match(/^(.+?)\(\d+(?:,\d+)?\):/)?.[1] || currentFile || '<unknown>';
    const rule = line.match(/\b(TS\d+|[A-Z]\d{3,4})\b/)?.[1]
      || line.trim().split(/\s{2,}/).at(-1)?.match(/^[\w/-]+$/)?.[0]
      || 'diagnostic';
    const key = `${file} | ${rule}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  return result([...grouped].map(([key, count]) => `${key}: ${count}`).join('\n'), 'linterRules');
}
