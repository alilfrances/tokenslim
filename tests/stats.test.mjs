import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedEnv } from './helpers.mjs';

function runStats(args, extraEnv) {
  const iso = isolatedEnv(extraEnv);
  try { return spawnSync(process.execPath, ['scripts/stats.mjs', ...args], { cwd: join(import.meta.dirname, '..'), env: iso.env, encoding: 'utf8' }); } finally { iso.cleanup(); }
}

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

    const result = runStats(['diag-session'], { XDG_CACHE_HOME: cacheRoot });

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

    const result = runStats(['old-session'], { XDG_CACHE_HOME: cacheRoot });

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

  const run = (...args) => runStats(args, { XDG_CACHE_HOME: cacheRoot, XDG_DATA_HOME: dataRoot });

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

// --- read guard ----------------------------------------------------------------------------------

function withStatsData(day, fn) {
  const iso = isolatedEnv();
  try {
    mkdirSync(join(iso.env.XDG_DATA_HOME, 'tokenslim'), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(iso.env.XDG_DATA_HOME, 'tokenslim', 'history.json'), JSON.stringify({ days: { [today]: day } }));
    const stats = (args = []) => spawnSync(process.execPath, ['scripts/stats.mjs', ...args], { cwd: join(import.meta.dirname, '..'), env: iso.env, encoding: 'utf8' });
    return fn(stats, iso, today);
  } finally { iso.cleanup(); }
}

test('stats: read guard advise line with the share of attempted Read bytes and the hint (text, json, csv)', () => {
  const day = {
    byTool: { Read: { bytesIn: 4000, bytesOut: 2000, events: 2, bytesAttempted: 400000 } }, byCommand: {}, byProject: {},
    readGuard: { wouldDeny: 5, wouldDenyBytes: 51200 },
  };
  withStatsData(day, (stats, iso, today) => {
    const out = stats().stdout;
    assert.match(out, /^read guard \(advise\): 5 large Read\(s\) would be outlined, 50\.0KB of returned text; ≈12\.8% of attempted Read bytes$/m);
    assert.match(out, /^ {2}set readGuard\.mode to "deny" to try it; watch the repeat rate$/m);
    assert.doesNotMatch(out, /read guard: denied/);
    assert.doesNotMatch(out, /bash dump guard/);
    const json = JSON.parse(stats(['--format', 'json']).stdout);
    assert.deepEqual(json.readGuard, {
      wouldDeny: 5, wouldDenyBytes: 51200, denied: 0, repeated: 0, skippedRuntime: 0,
      pctOfAttemptedRead: 12.8, repeatRate: null, repeatWarn: false,
    });
    assert.deepEqual(json.days[0].readGuard, json.readGuard);
    assert.equal('bashGuard' in json, false);
    const csv = stats(['--format', 'csv']).stdout.trim().split('\n');
    assert.equal(csv[0], 'day,bytesIn,bytesOut,bytesSaved,events,bytesAttempted,capped,teeRead,teeCat,rerun,rg_wouldDeny,rg_wouldDenyBytes,rg_denied,rg_repeated,rg_skippedRuntime');
    assert.equal(csv[1], `${today},4000,2000,2000,2,400000,0,0,0,0,5,51200,0,0,0`);
  });
});

test('stats: bash and read guard columns coexist without renaming the bash ones', () => {
  const day = { byTool: {}, byCommand: {}, byProject: {}, bashGuard: { wouldDeny: 1 }, readGuard: { denied: 2 } };
  withStatsData(day, (stats, iso, today) => {
    const csv = stats(['--format', 'csv']).stdout.trim().split('\n');
    assert.equal(csv[0], 'day,bytesIn,bytesOut,bytesSaved,events,bytesAttempted,capped,teeRead,teeCat,rerun,wouldDeny,wouldDenyBytes,denied,repeated,skippedRuntime,rg_wouldDeny,rg_wouldDenyBytes,rg_denied,rg_repeated,rg_skippedRuntime');
    assert.equal(csv[1], `${today},0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,2,0,0`);
  });
});

test('stats: read guard without Read attempted bytes omits the percentage; project view omits it', () => {
  const day = { byTool: {}, byCommand: {}, byProject: { '/p': { bytesIn: 1, bytesOut: 1, events: 1 } }, readGuard: { wouldDeny: 1, wouldDenyBytes: 2048 } };
  withStatsData(day, (stats) => {
    assert.match(stats().stdout, /^read guard \(advise\): 1 large Read\(s\) would be outlined, 2\.0KB of returned text$/m);
    assert.equal(JSON.parse(stats(['--format', 'json']).stdout).readGuard.pctOfAttemptedRead, null);
    assert.doesNotMatch(stats(['--project', '/p']).stdout, /read guard/);
  });
});

test('stats: read guard deny line with the repeat rate and a warning above 30%', () => {
  withStatsData({ byTool: {}, byCommand: {}, byProject: {}, readGuard: { denied: 10, repeated: 3 } }, (stats) => {
    assert.match(stats().stdout, /^read guard: denied 10, repeated 3 \(30%\)$/m, 'exactly 30% is not above it');
  });
  withStatsData({ byTool: {}, byCommand: {}, byProject: {}, readGuard: { denied: 10, repeated: 4, skippedRuntime: 2 } }, (stats) => {
    const out = stats().stdout;
    assert.match(out, /^read guard: denied 10, repeated 4 \(40%\) ⚠ above 30%: the outline was often not enough, skipped 2 \(no Claude session\)$/m);
    assert.doesNotMatch(out, /\(advise\)/);
    const json = JSON.parse(stats(['--format', 'json']).stdout);
    assert.deepEqual([json.readGuard.repeatRate, json.readGuard.repeatWarn], [0.4, true]);
  });
});

test('stats: history and ledger without read guard data render unchanged', () => {
  withStatsData({ byTool: { Read: { bytesIn: 4000, bytesOut: 2000, events: 2, bytesAttempted: 8000 } }, byCommand: {}, byProject: {}, recovery: { capped: 4, rerun: 1 } }, (stats, iso) => {
    assert.doesNotMatch(stats().stdout, /read guard/);
    const json = JSON.parse(stats(['--format', 'json']).stdout);
    assert.equal('readGuard' in json, false);
    assert.equal('readGuard' in json.days[0], false);
    assert.equal(stats(['--format', 'csv']).stdout.trim().split('\n')[0], 'day,bytesIn,bytesOut,bytesSaved,events,bytesAttempted,capped,teeRead,teeCat,rerun');
    mkdirSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim'), { recursive: true });
    writeFileSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim', 'old.json'), JSON.stringify({ version: 1, savings: {}, reads: {}, diagnostics: {} }));
    assert.equal('readGuard' in JSON.parse(stats(['old', '--format', 'json']).stdout), false);
  });
});

test('stats: the session ledger reports read guard counters and the share of attempted Read bytes', () => {
  const iso = isolatedEnv();
  try {
    mkdirSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim'), { recursive: true });
    writeFileSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim', 'rg.json'), JSON.stringify({
      version: 1, savings: {}, reads: {}, attempted: { Read: { events: 4, bytes: 200000 } },
      readGuard: { wouldDeny: 2, wouldDenyBytes: 40000, denied: 1, repeated: 1 },
    }));
    const run = (args) => spawnSync(process.execPath, ['scripts/stats.mjs', 'rg', ...args], { cwd: join(import.meta.dirname, '..'), env: iso.env, encoding: 'utf8' });
    const out = run([]).stdout;
    assert.match(out, /^read guard \(advise\): 2 large Read\(s\) would be outlined, 39\.1KB of returned text; ≈20% of attempted Read bytes$/m);
    assert.match(out, /^read guard: denied 1, repeated 1 \(100%\) ⚠ above 30%/m);
    assert.equal(JSON.parse(run(['--format', 'json']).stdout).readGuard.pctOfAttemptedRead, 20);
  } finally { iso.cleanup(); }
});
