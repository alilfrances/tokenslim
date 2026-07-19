import { hasFailure, lines, result } from './shared.mjs';

const BINARIES = new Set(['go', 'jest', 'vitest', 'rspec', 'pytest', 'cargo', 'npm', 'pnpm', 'yarn']);

function goJson(text) {
  let passed = 0;
  let packages = new Set();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.Package) packages.add(event.Package);
      if (event.Action === 'pass' && event.Test) passed += 1;
      if (event.Action === 'fail') return null;
    } catch { return null; }
  }
  return result(`go test: ok (${passed} tests, ${packages.size} packages)`, 'goTestJson');
}

export function compress(text, meta = {}) {
  if (!BINARIES.has(meta.binary) || hasFailure(text, meta)) return null;
  if (meta.binary === 'go' && meta.subcommand === 'test') {
    if (meta.tokens?.includes('-json')) return goJson(text);
    const ok = lines(text).filter((line) => /^ok\s+\S+/.test(line));
    return ok.length ? result(`go test: ${ok.join('\n')}`, 'goTest') : null;
  }
  const input = lines(text);
  const summary = input.filter((line) => /(?:Test Files|Tests\s+\d+|\d+ examples?, \d+ failures?|\d+ passed|test result: ok|^PASS\s*$)/i.test(line));
  return summary.length ? result(summary.join('\n'), 'testRunnerSummary') : null;
}
