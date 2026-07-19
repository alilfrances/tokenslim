import { hasFailure, lines, result } from './shared.mjs';

const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'cargo']);

export function compress(text, meta = {}) {
  if (!MANAGERS.has(meta.binary) || hasFailure(text, meta)) return null;
  const input = lines(text);
  const summary = input.filter((line) => /(?:added|removed|changed|audited)\s+\d+\s+(?:packages?|dependencies)|Successfully installed|Finished\s+(?:dev|release)|Downloaded\s+\d+\s+packages?/i.test(line)).at(-1);
  if (!summary) return null;
  return result(`${meta.binary} ${meta.subcommand || 'command'}: ${summary}`, 'packageManagerSummary');
}
