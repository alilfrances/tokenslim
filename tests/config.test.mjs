import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache, loadConfig } from '../scripts/lib/config.mjs';

function temp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-config-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); clearConfigCache(); }
}

test('config merges global, project, then environment layers', () => temp((dir) => {
  const xdg = join(dir, 'xdg');
  mkdirSync(join(xdg, 'tokenslim'), { recursive: true });
  writeFileSync(join(xdg, 'tokenslim', 'config.json'), JSON.stringify({ minChars: 100, rewrite: { enabled: false, exclude: ['git status'] } }));
  writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify({ minChars: 200, readGuardLines: 7, rewrite: { enabled: true } }));
  const config = loadConfig(dir, { HOME: dir, XDG_CONFIG_HOME: xdg, TOKENSLIM_MIN_CHARS: '300', TOKENSLIM_DISABLE: 'bash,rewrite' });
  assert.equal(config.minChars, 300);
  assert.equal(config.readGuardLines, 7);
  assert.equal(config.rewrite.enabled, true);
  assert.deepEqual(config.rewrite.exclude, ['git status']);
  assert.deepEqual(config.disable, ['bash', 'rewrite']);
}));

test('config ignores malformed files and missing files', () => temp((dir) => {
  const xdg = join(dir, 'xdg');
  mkdirSync(join(xdg, 'tokenslim'), { recursive: true });
  writeFileSync(join(xdg, 'tokenslim', 'config.json'), '{ nope');
  writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify({ rewrite: { exclude: ['npm ci'] } }));
  const config = loadConfig(dir, { HOME: dir, XDG_CONFIG_HOME: xdg });
  assert.equal(config.minChars, 500);
  assert.deepEqual(config.rewrite.exclude, ['npm ci']);
  clearConfigCache();
  assert.equal(loadConfig(join(dir, 'missing'), { HOME: dir, XDG_CONFIG_HOME: join(dir, 'absent') }).readGuardLines, 2000);
}));
