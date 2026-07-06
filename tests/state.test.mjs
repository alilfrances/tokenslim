import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadState,
  saveState,
  recordSavings,
  recordDiagnostic,
  readCache,
  summarize,
} from '../scripts/lib/state.mjs';

function withTempCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-state-'));
  const prev = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadState returns fresh state when nothing saved yet', () => {
  withTempCache(() => {
    const state = loadState('session-abc');
    assert.deepEqual(state, { version: 1, savings: {}, reads: {}, diagnostics: {} });
  });
});

test('saveState + loadState roundtrip', () => {
  withTempCache(() => {
    const state = loadState('session-roundtrip');
    recordSavings(state, { tool: 'Read', bytesIn: 1000, bytesOut: 400 });
    readCache(state).set('/a/b.js', { hash: 'deadbeef', headerLine: 42 });
    saveState('session-roundtrip', state);

    const reloaded = loadState('session-roundtrip');
    assert.equal(reloaded.savings.Read.events, 1);
    assert.equal(reloaded.savings.Read.bytesIn, 1000);
    assert.equal(reloaded.savings.Read.bytesOut, 400);
    assert.deepEqual(reloaded.reads['/a/b.js'], { hash: 'deadbeef', headerLine: 42 });
  });
});

test('corrupt state file recovers to fresh state without throwing', () => {
  withTempCache((dir) => {
    const cacheDir = join(dir, 'tokenslim');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'broken.json'), '{ not valid json ][', 'utf8');

    const state = loadState('broken');
    assert.deepEqual(state, { version: 1, savings: {}, reads: {}, diagnostics: {} });
  });
});

test('missing/unwritable directory never throws on save', () => {
  withTempCache(() => {
    // Point XDG_CACHE_HOME at a file (not a directory) so mkdir/write must fail.
    process.env.XDG_CACHE_HOME = join(tmpdir(), `tokenslim-not-a-dir-${process.pid}`);
    writeFileSync(process.env.XDG_CACHE_HOME, 'not a directory', 'utf8');
    const state = loadState('whatever');
    assert.doesNotThrow(() => saveState('whatever', state));
    rmSync(process.env.XDG_CACHE_HOME, { force: true });
  });
});

test('sessionId is sanitized against path traversal', () => {
  withTempCache((dir) => {
    const state = loadState('../../etc/passwd');
    recordSavings(state, { tool: 'Read', bytesIn: 10, bytesOut: 5 });
    saveState('../../etc/passwd', state);

    // Nothing should have been written outside the tokenslim cache dir.
    assert.equal(existsSync(join(dir, '..', 'etc')), false);
    const cacheDir = join(dir, 'tokenslim');
    assert.ok(existsSync(cacheDir));
  });
});

test('recordSavings accumulates across multiple calls for the same tool', () => {
  const state = { version: 1, savings: {}, reads: {} };
  recordSavings(state, { tool: 'Read', bytesIn: 100, bytesOut: 50 });
  recordSavings(state, { tool: 'Read', bytesIn: 200, bytesOut: 80 });
  assert.deepEqual(state.savings.Read, { events: 2, bytesIn: 300, bytesOut: 130 });
});

test('recordDiagnostic accumulates per tool, event, and outcome', () => {
  const state = { version: 1, savings: {}, reads: {} };
  recordDiagnostic(state, { tool: 'Bash', event: 'PostToolUse', outcome: 'attempted' });
  recordDiagnostic(state, { tool: 'Bash', event: 'PostToolUse', outcome: 'attempted' });
  recordDiagnostic(state, { tool: 'Bash', event: 'PostToolUse', outcome: 'compressed' });
  recordDiagnostic(state, { tool: 'Bash', event: 'PostToolUseFailure', outcome: 'attempted' });

  assert.deepEqual(state.diagnostics.Bash.PostToolUse, { attempted: 2, compressed: 1 });
  assert.deepEqual(state.diagnostics.Bash.PostToolUseFailure, { attempted: 1 });
});

test('summarize computes totals, per-tool breakdown, tokens, and cost', () => {
  const state = { version: 1, savings: {}, reads: {} };
  recordSavings(state, { tool: 'Read', bytesIn: 3000, bytesOut: 1000 });
  recordSavings(state, { tool: 'Grep', bytesIn: 900, bytesOut: 300 });

  const summary = summarize(state);
  assert.equal(summary.totalBytesIn, 3900);
  assert.equal(summary.totalBytesOut, 1300);
  // bytesSaved = 2600; ~3 chars/token -> ~867 tokens
  assert.equal(summary.estTokensSaved, Math.round(2600 / 3));
  assert.ok(summary.estCostSavedUsd > 0);
  assert.equal(summary.perTool.Read.bytesSaved, 2000);
  assert.equal(summary.perTool.Grep.bytesSaved, 600);
  assert.deepEqual(summary.diagnostics, {});
});

test('summarize on empty state returns zeros', () => {
  const summary = summarize({ version: 1, savings: {}, reads: {} });
  assert.deepEqual(summary, {
    totalBytesIn: 0,
    totalBytesOut: 0,
    estTokensSaved: 0,
    estCostSavedUsd: 0,
    perTool: {},
    diagnostics: {},
  });
});
