import { hasFailure, lines, result } from './shared.mjs';

const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'cargo']);
const SIGNAL = /\bwarn\b|deprecat|vulnerabilit|peer dep|EBADENGINE|ERESOLVE/i;

function retainSignals(input) {
  const output = [];
  const counts = new Map();
  const signals = input.filter((item) => SIGNAL.test(item));
  for (const line of signals) {
    const count = counts.get(line) || 0;
    counts.set(line, count + 1);
    if (count === 0) output.push(line);
  }
  for (const count of counts.values()) if (count > 1) output.push(`... [tokenslim: ${count - 1} duplicate package warnings omitted]`);
  return { output, signalLines: signals.length };
}

export function compress(text, meta = {}) {
  if (!MANAGERS.has(meta.binary) || hasFailure(text, meta)) return null;
  const input = lines(text);
  const summary = input.filter((line) => /(?:added|removed|changed|audited)\s+\d+\s+(?:packages?|dependencies)|Successfully installed|Finished\s+(?:dev|release)|Downloaded\s+\d+\s+packages?/i.test(line)).at(-1);
  if (!summary) return null;
  const retained = retainSignals(input);
  const signalLinesExcludingSummary = retained.signalLines - (SIGNAL.test(summary) ? 1 : 0);
  const omitted = input.length - 1 - signalLinesExcludingSummary;
  return result([
    `${meta.binary} ${meta.subcommand || 'command'}: ${summary}`,
    ...retained.output.filter((line) => line !== summary),
    ...(omitted > 0 ? [`... [tokenslim: ${omitted} package-manager lines omitted]`] : []),
  ].join('\n'), 'packageManagerSummary');
}
