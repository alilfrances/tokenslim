import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dirname, '..');
function run(args = [], env = {}) { return spawnSync('node', ['scripts/doctor.mjs', ...args], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' }); }

test('doctor reports this checkout healthy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-doctor-'));
  try {
    const result = run([], { XDG_CACHE_HOME: join(dir, 'cache'), XDG_DATA_HOME: join(dir, 'data') });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ok: tokenslim installation is healthy/);
    assert.match(result.stdout, /effective config:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor flags a missing script referenced by hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-doctor-root-'));
  try {
    mkdirSync(join(dir, 'hooks')); writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: 'node scripts/missing.mjs' }] }] } }));
    const result = run(['--root', dir], { XDG_CACHE_HOME: join(dir, 'cache'), XDG_DATA_HOME: join(dir, 'data') });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /missing\.mjs.*does not exist/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor flags an unusable cache root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-doctor-cache-'));
  try {
    const cacheFile = join(dir, 'cache-file'); writeFileSync(cacheFile, 'not a directory');
    const result = run([], { XDG_CACHE_HOME: cacheFile, XDG_DATA_HOME: join(dir, 'data') });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ledger directory.*not writable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
