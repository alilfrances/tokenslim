#!/usr/bin/env node
// Prints the tokenslim savings report for a session ledger.
// Usage: node stats.mjs [sessionId]  (defaults to most recently modified ledger)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const cacheDir = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'tokenslim'
);

function latestLedger() {
  const files = readdirSync(cacheDir)
    .filter((f) => f.endsWith('.json') && f !== 'debug.log')
    .map((f) => ({ f, mtime: statSync(join(cacheDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] ? join(cacheDir, files[0].f) : null;
}

try {
  const arg = process.argv[2];
  const path = arg ? join(cacheDir, `${arg.replace(/[^A-Za-z0-9_-]/g, '')}.json`) : latestLedger();
  if (!path) {
    console.log('tokenslim: no savings recorded yet this session.');
    process.exit(0);
  }
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const perTool = state.savings || {};
  let bytesIn = 0;
  let bytesOut = 0;
  const rows = [];
  for (const [tool, s] of Object.entries(perTool)) {
    bytesIn += s.bytesIn;
    bytesOut += s.bytesOut;
    const pct = s.bytesIn ? Math.round((1 - s.bytesOut / s.bytesIn) * 100) : 0;
    rows.push(`  ${tool.padEnd(6)} ${String(s.events).padStart(4)} calls  ${fmt(s.bytesIn)} -> ${fmt(s.bytesOut)}  (${pct}% smaller)`);
  }
  // ~3 chars/token for code-like content; $3/MTok input price assumption.
  const tokensSaved = Math.round((bytesIn - bytesOut) / 3);
  const costSaved = (tokensSaved / 1_000_000) * 3;
  console.log('tokenslim savings (this session):');
  console.log(rows.join('\n') || '  (no compression events yet)');
  console.log(`  total  ${fmt(bytesIn)} -> ${fmt(bytesOut)} | ~${tokensSaved.toLocaleString('en-US')} tokens | ~$${costSaved.toFixed(4)} saved`);
  const diagnosticRows = diagnosticsRows(state.diagnostics);
  if (diagnosticRows.length > 0) {
    console.log('tokenslim diagnostics (hook activity):');
    console.log(diagnosticRows.join('\n'));
  }
  console.log('  note: input tokens also recur every subsequent turn, so real savings compound.');
} catch {
  console.log('tokenslim: no savings recorded yet this session.');
}

function diagnosticsRows(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return [];
  const rows = [];
  for (const [tool, events] of Object.entries(diagnostics).sort(([a], [b]) => a.localeCompare(b))) {
    if (!events || typeof events !== 'object') continue;
    for (const [event, counters] of Object.entries(events).sort(([a], [b]) => a.localeCompare(b))) {
      if (!counters || typeof counters !== 'object') continue;
      const parts = Object.entries(counters)
        .filter(([, value]) => Number(value) > 0)
        .map(([name, value]) => `${name} ${Number(value)}`);
      if (parts.length > 0) rows.push(`  ${tool.padEnd(6)} ${event.padEnd(18)} ${parts.join(', ')}`);
    }
  }
  return rows;
}

function fmt(b) {
  return b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)}MB` : b >= 1024 ? `${(b / 1024).toFixed(1)}KB` : `${b}B`;
}
