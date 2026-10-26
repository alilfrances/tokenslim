import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const script = join(root, 'scripts/statusline.mjs');

function runStatusline(input, extraEnv) {
  const iso = isolatedEnv(extraEnv);
  try { return spawnSync('node', [script], { cwd: '/tmp', env: iso.env, input, encoding: 'utf8' }); } finally { iso.cleanup(); }
}

test('statusline renders Claude context and measured tokenslim savings', (t) => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'tokenslim-statusline-'));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  const ledgerDir = join(cacheRoot, 'tokenslim');
  mkdirSync(ledgerDir);
  writeFileSync(join(ledgerDir, 'session_123.json'), JSON.stringify({
    savings: {
      Bash: { events: 2, bytesIn: 9000, bytesOut: 3000 },
      Read: { events: 1, bytesIn: 1200, bytesOut: 600 },
    },
  }));

  const result = runStatusline(JSON.stringify({
    model: { display_name: 'Claude Sonnet' },
    context_window: { used_percentage: 42 },
    session_id: 'session_123',
  }), { XDG_CACHE_HOME: cacheRoot });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Claude Sonnet | ctx 42% | slim -2.2k tok');
});

test('statusline fails open on invalid stdin', () => {
  const result = runStatusline('not json');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '\n');
});
