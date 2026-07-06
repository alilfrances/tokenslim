import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const script = join(root, 'scripts/statusline.mjs');

test('statusline renders Claude context and measured tokenslim savings', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'tokenslim-statusline-'));
  const ledgerDir = join(cacheRoot, 'tokenslim');
  mkdirSync(ledgerDir);
  writeFileSync(join(ledgerDir, 'session_123.json'), JSON.stringify({
    savings: {
      Bash: { events: 2, bytesIn: 9000, bytesOut: 3000 },
      Read: { events: 1, bytesIn: 1200, bytesOut: 600 },
    },
  }));

  const result = spawnSync('node', [script], {
    cwd: '/tmp',
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
    input: JSON.stringify({
      model: { display_name: 'Claude Sonnet' },
      context_window: { used_percentage: 42 },
      session_id: 'session_123',
    }),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Claude Sonnet | ctx 42% | slim -2.2k tok');
});

test('statusline fails open on invalid stdin', () => {
  const result = spawnSync('node', [script], {
    cwd: '/tmp',
    input: 'not json',
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '\n');
});
