import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('stats report includes diagnostics when available', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'tokenslim-stats-'));
  try {
    const ledgerDir = join(cacheRoot, 'tokenslim');
    mkdirSync(ledgerDir);
    writeFileSync(join(ledgerDir, 'diag-session.json'), JSON.stringify({
      version: 1,
      savings: {
        Bash: { events: 1, bytesIn: 900, bytesOut: 300 },
      },
      diagnostics: {
        Bash: {
          PostToolUse: { attempted: 2, compressed: 1, skippedBelowThreshold: 1 },
        },
        Read: {
          PostToolUse: { attempted: 1, unsupportedShape: 1 },
        },
      },
      reads: {},
    }));

    const result = spawnSync('node', ['scripts/stats.mjs', 'diag-session'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tokenslim diagnostics \(hook activity\):/);
    assert.match(result.stdout, /Bash\s+PostToolUse\s+attempted 2, compressed 1, skippedBelowThreshold 1/);
    assert.match(result.stdout, /Read\s+PostToolUse\s+attempted 1, unsupportedShape 1/);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('stats report omits diagnostics section for old ledgers', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'tokenslim-stats-'));
  try {
    const ledgerDir = join(cacheRoot, 'tokenslim');
    mkdirSync(ledgerDir);
    writeFileSync(join(ledgerDir, 'old-session.json'), JSON.stringify({
      version: 1,
      savings: {},
      reads: {},
    }));

    const result = spawnSync('node', ['scripts/stats.mjs', 'old-session'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /tokenslim diagnostics/);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('history stats support periods, projects, graph, top, JSON, and CSV', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenslim-stats-history-'));
  const dataRoot = join(root, 'data');
  const cacheRoot = join(root, 'cache');
  const repoRoot = join(import.meta.dirname, '..');
  const day = (offset) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  const today = day(0);
  const older = day(-8);
  const history = {
    days: {
      [older]: {
        byTool: { Bash: { bytesIn: 300, bytesOut: 100, events: 1 } },
        byCommand: { 'git status': { bytesIn: 300, bytesOut: 100, events: 1 } },
        byProject: { [repoRoot]: { bytesIn: 300, bytesOut: 100, events: 1 } },
      },
      [today]: {
        byTool: { Bash: { bytesIn: 900, bytesOut: 300, events: 3 } },
        byCommand: { pytest: { bytesIn: 900, bytesOut: 300, events: 3 } },
        byProject: {
          [repoRoot]: { bytesIn: 600, bytesOut: 200, events: 2 },
          '/other': { bytesIn: 300, bytesOut: 100, events: 1 },
        },
      },
    },
  };

  const run = (...args) => spawnSync(process.execPath, ['scripts/stats.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot, XDG_DATA_HOME: dataRoot },
    encoding: 'utf8',
  });

  try {
    mkdirSync(join(dataRoot, 'tokenslim'), { recursive: true });
    mkdirSync(join(cacheRoot, 'tokenslim'), { recursive: true });
    writeFileSync(join(dataRoot, 'tokenslim', 'history.json'), JSON.stringify(history));

    for (const period of ['daily', 'weekly', 'monthly']) {
      const result = run(`--${period}`, '--format', 'json');
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.period, period);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
    }

    const project = run('--project', repoRoot, '--format', 'json');
    assert.equal(project.status, 0, project.stderr);
    assert.equal(JSON.parse(project.stdout).total.bytesSaved, 600);

    const implicitProject = run('--project', '--graph', '--top');
    assert.equal(implicitProject.status, 0, implicitProject.stderr);
    assert.match(implicitProject.stdout, new RegExp(`project: ${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(implicitProject.stdout, /last 30 days:/);
    assert.match(implicitProject.stdout, /top commands:/);

    const csv = run('--format', 'csv');
    assert.equal(csv.status, 0, csv.stderr);
    const lines = csv.stdout.trim().split('\n');
    assert.equal(lines[0], 'day,bytesIn,bytesOut,bytesSaved,events');
    assert.equal(lines.length, Object.keys(history.days).length + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
