import { lines, result } from './shared.mjs';

const BINARIES = new Set(['eslint', 'tsc', 'ruff']);

function diagnostic(line, currentFile) {
  // TypeScript's native format includes the path and position on each line.
  let match = /^(.+?)\((\d+(?:,\d+)?)\):\s*(error|warning)\s+(.+)$/i.exec(line);
  if (match) {
    const rule = match[4].match(/\b(TS\d+|[A-Z]\d{3,4})\b/)?.[1] || 'diagnostic';
    return { key: `${match[1]}\0${rule}\0${match[4]}`, rule };
  }
  // ESLint's stylish formatter prints a path heading followed by diagnostics.
  match = /^\s*(\d+:\d+)\s+(warning|error)\s+(.+?)\s{2,}([\w/@-]+)\s*$/i.exec(line);
  if (match) {
    return { key: `${currentFile}\0${match[4]}\0${match[3]}`, rule: match[4] };
  }
  // Ruff's concise format: path:line:column: RULE message.
  match = /^(.+?):(\d+):(\d+):\s*([A-Z]\d+)\s+(.+)$/.exec(line);
  if (match) return { key: `${match[1]}\0${match[4]}\0${match[5]}`, rule: match[4] };
  return null;
}

export function compress(text, meta = {}) {
  // Linter diagnostics are the expected output of these commands, not runner failures.
  if (!BINARIES.has(meta.binary) || meta.failed) return null;
  const input = lines(text);
  const output = [];
  const seen = new Map();
  let currentFile = '';
  let emittedFile = '';
  for (const line of input) {
    if (/^(?:\/|[\w.-]+\/)[\w./-]+\.[\w]+$/.test(line)) {
      currentFile = line;
      continue;
    }
    const parsed = diagnostic(line, currentFile);
    if (!parsed) continue; // summaries and formatter decoration are not actionable.
    const entry = seen.get(parsed.key) || { count: 0, file: currentFile, rule: parsed.rule };
    entry.count += 1;
    seen.set(parsed.key, entry);
    if (entry.count <= 3) {
      // ESLint's file heading is needed to interpret its location-only records.
      // Keep both it and the diagnostic as exact input lines; never synthesize a
      // convenient-but-nonexistent combined line.
      if (currentFile && emittedFile !== currentFile) {
        output.push(currentFile);
        emittedFile = currentFile;
      }
      output.push(line);
    }
  }
  if (output.length) {
    for (const { count, file, rule } of seen.values()) {
      if (count > 3) output.push(`... [tokenslim: ${count - 3} identical diagnostics omitted${file ? ` for ${file}` : ''}${rule ? ` (${rule})` : ''}]`);
    }
    return result(output.join('\n'), 'linterDiagnostics');
  }
  const success = input.filter((line) => /(?:no problems|found 0 errors|all checks passed)/i.test(line));
  return success.length ? result(success.join('\n'), 'linterSummary') : null;
}
