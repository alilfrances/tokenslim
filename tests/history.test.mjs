import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { historyPath, loadHistory, updateHistory } from '../scripts/lib/history.mjs';

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
