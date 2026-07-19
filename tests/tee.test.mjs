import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { appendTeePath, teeOriginalOutput, teePath } from '../scripts/lib/tee.mjs';

function withCache(fn) {
  const cache = mkdtempSync(join(tmpdir(), 'tokenslim-tee-'));
  try { fn(cache); } finally { rmSync(cache, { recursive: true, force: true }); }
}

const config = { tee: { enabled: true, mode: 'lossy', maxFiles: 20 } };

test('tees lossy output at a stable path and inserts that path into a marker', () => withCache((cache) => {
  const env = { XDG_CACHE_HOME: cache, TOKENSLIM_TEE_MIN: '1' };
  const path = teeOriginalOutput('raw output', { sessionId: 'session', toolUseId: 'tool', config, env, lossy: true });
  assert.equal(path, teePath('session', 'tool', env));
  assert.equal(readFileSync(path, 'utf8'), 'raw output');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(appendTeePath('[tokenslim: 9 lines omitted]', path), `[tokenslim: 9 lines omitted full: ${path}]`);
  assert.equal(appendTeePath('[tokenslim: 9 lines omitted]', path), appendTeePath('[tokenslim: 9 lines omitted]', path));
}));

test('tee ids cannot traverse out of the recovery directory', () => withCache((cache) => {
  const env = { XDG_CACHE_HOME: cache, TOKENSLIM_TEE_MIN: '1' };
  const path = teeOriginalOutput('raw', { sessionId: '..', toolUseId: '..', config, env, lossy: true });
  const root = join(cache, 'tokenslim', 'tee');
  assert.ok(path);
  assert.doesNotMatch(relative(root, path), /^\.\.(?:\/|\\|$)/);
  assert.match(path, /%2E%2E/);
}));

test('rotates tee files per session and respects never mode', () => withCache((cache) => {
  const env = { XDG_CACHE_HOME: cache, TOKENSLIM_TEE_MIN: '1' };
  const rotating = { tee: { enabled: true, mode: 'lossy', maxFiles: 2 } };
  for (const id of ['one', 'two', 'three']) {
    teeOriginalOutput(id, { sessionId: 'session', toolUseId: id, config: rotating, env, lossy: true });
  }
  assert.equal(existsSync(teePath('session', 'one', env)), false);
  assert.equal(existsSync(teePath('session', 'two', env)), true);
  assert.equal(existsSync(teePath('session', 'three', env)), true);
  assert.equal(teeOriginalOutput('raw', { sessionId: 'session', toolUseId: 'never', config: { tee: { enabled: true, mode: 'never' } }, env, lossy: true }), null);
}));

test('lossless transformations and failed tee writes never block compression', () => withCache((cache) => {
  const env = { XDG_CACHE_HOME: cache, TOKENSLIM_TEE_MIN: '1' };
  assert.equal(teeOriginalOutput('raw', { sessionId: 'session', toolUseId: 'lossless', config, env, lossy: false }), null);
  const fileCache = join(cache, 'not-a-directory');
  writeFileSync(fileCache, 'x');
  assert.equal(teeOriginalOutput('raw', { sessionId: 'session', toolUseId: 'write-failure', config, env: { XDG_CACHE_HOME: fileCache, TOKENSLIM_TEE_MIN: '1' }, lossy: true }), null);
}));
