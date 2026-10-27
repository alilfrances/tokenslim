import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { READ_GUARD_KEYS, historyPath, loadHistory, updateHistory } from '../scripts/lib/history.mjs';

function withData(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-history-'));
  const old = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  try { fn(dir); } finally { if (old === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = old; rmSync(dir, { recursive: true, force: true }); }
}

test('daily history aggregates event deltas and atomically writes JSON', () => withData(() => {
  const date = new Date('2026-07-19T12:00:00Z');
  assert.equal(updateHistory([{ tool: 'Bash', command: 'git status', cwd: '/repo', bytesIn: 100, bytesOut: 25 }, { tool: 'Bash', command: 'git status', cwd: '/repo', bytesIn: 50, bytesOut: 20 }], date), true);
  const day = loadHistory().days['2026-07-19'];
  assert.deepEqual(day.byTool.Bash, { bytesIn: 150, bytesOut: 45, events: 2 });
  assert.deepEqual(day.byCommand['git status'], { bytesIn: 150, bytesOut: 45, events: 2 });
  assert.deepEqual(day.byProject['/repo'], { bytesIn: 150, bytesOut: 45, events: 2 });
  assert.ok(existsSync(historyPath()));
  assert.doesNotThrow(() => JSON.parse(readFileSync(historyPath(), 'utf8')));
  assert.equal(statSync(historyPath()).mode & 0o777, 0o600);
}));

test('history stores privacy-safe command families instead of command arguments', () => withData(() => {
  const command = 'curl -H "Authorization: Bearer super-secret" https://example.invalid/?token=secret';
  assert.equal(updateHistory([{ tool: 'Bash', command, cwd: '/repo', bytesIn: 100, bytesOut: 10 }], new Date('2026-07-19T12:00:00Z')), true);
  const serialized = readFileSync(historyPath(), 'utf8');
  assert.doesNotMatch(serialized, /super-secret|example\.invalid|token=secret/);
  assert.deepEqual(loadHistory().days['2026-07-19'].byCommand.curl, { bytesIn: 100, bytesOut: 10, events: 1 });

  // Older history created before command-family redaction is sanitized on read and
  // rewritten without arguments on the next aggregate update.
  writeFileSync(historyPath(), JSON.stringify({ days: { '2026-07-19': {
    byTool: { Bash: { bytesIn: 10, bytesOut: 1, events: 1 } },
    byCommand: { 'git clone ssh://example.invalid/private.git --config authValue=old-secret': { bytesIn: 10, bytesOut: 1, events: 1 } },
    byProject: { '/repo': { bytesIn: 10, bytesOut: 1, events: 1 } },
  } } }));
  assert.deepEqual(Object.keys(loadHistory().days['2026-07-19'].byCommand), ['git clone']);
  updateHistory([{ tool: 'Bash', command: 'git status', cwd: '/repo', bytesIn: 5, bytesOut: 1 }], new Date('2026-07-19T13:00:00Z'));
  assert.doesNotMatch(readFileSync(historyPath(), 'utf8'), /old-secret|example\.invalid|private\.git/);
}));

test('corrupt history recovers and retention removes records older than 90 days', () => withData(() => {
  mkdirSync(join(process.env.XDG_DATA_HOME, 'tokenslim'), { recursive: true });
  writeFileSync(historyPath(), '{broken');
  assert.equal(updateHistory([{ tool: 'Read', bytesIn: 9, bytesOut: 3 }], new Date('2026-07-19T00:00:00Z')), true);
  assert.deepEqual(Object.keys(loadHistory().days), ['2026-07-19']);
  const history = loadHistory(); history.days['2026-04-01'] = { byTool: {}, byCommand: {}, byProject: {} }; writeFileSync(historyPath(), JSON.stringify(history));
  updateHistory([{ tool: 'Read', bytesIn: 9, bytesOut: 3 }], new Date('2026-07-20T00:00:00Z'));
  assert.equal(loadHistory().days['2026-04-01'], undefined);
}));

test('readGuard events aggregate per day into record.readGuard, apart from savings and bashGuard', () => withData(() => {
  assert.deepEqual([...READ_GUARD_KEYS], ['wouldDeny', 'wouldDenyBytes', 'denied', 'repeated', 'skippedRuntime']);
  const date = new Date('2026-07-19T12:00:00Z');
  assert.equal(updateHistory([
    { kind: 'readGuard', wouldDeny: 1, wouldDenyBytes: 4000 },
    { kind: 'readGuard', wouldDeny: 1, wouldDenyBytes: 500, bogus: 7, le800: 3 },
    { kind: 'readGuard', denied: 2, repeated: 1, skippedRuntime: 'x' },
    { kind: 'bashGuard', denied: 5 },
  ], date), true);
  assert.equal(updateHistory([{ kind: 'readGuard', denied: 1, wouldDeny: -4 }], date), true);
  const day = loadHistory().days['2026-07-19'];
  assert.deepEqual(day.readGuard, { wouldDeny: 2, wouldDenyBytes: 4500, denied: 3, repeated: 1 });
  assert.deepEqual(day.bashGuard, { denied: 5 });
  assert.deepEqual(day.byTool, {}, 'guard events never count as savings events');
  assert.deepEqual(day.byCommand, {});
}));
