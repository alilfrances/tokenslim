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
