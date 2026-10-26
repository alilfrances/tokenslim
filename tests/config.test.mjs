import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache, loadConfig, loadConfigLayerFile, mergeConfigLayer } from '../scripts/lib/config.mjs';

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

test('config filters discard unknown fields and cap repository-controlled input', () => temp((dir) => {
  const filters = Array.from({ length: 60 }, (_, index) => ({
    name: `filter-${index}`,
    matchCommand: '^git status$',
    maxLines: 5,
    secret: 'must-not-survive-validation',
  }));
  writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify({ filters }));
  const config = loadConfig(dir, { HOME: dir, XDG_CONFIG_HOME: join(dir, 'absent') });
  assert.equal(config.filters.length, 50);
  assert.equal(config.filters[0].secret, undefined);
  assert.deepEqual(config.filters[0], { name: 'filter-0', matchCommand: '^git status$', maxLines: 5 });

  clearConfigCache();
  writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify({ padding: 'x'.repeat(300_000), minChars: 1 }));
  assert.equal(loadConfig(dir, { HOME: dir, XDG_CONFIG_HOME: join(dir, 'absent') }).minChars, 500);
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

test('loadConfigLayerFile validates like a file layer but throws on unreadable or non-object files', () => temp((dir) => {
  writeFileSync(join(dir, 'layer.json'), JSON.stringify({ minChars: 10, tee: { mode: 'bogus', maxFiles: 3 }, unknown: 1 }));
  const layer = loadConfigLayerFile(join(dir, 'layer.json'));
  assert.deepEqual(layer, { minChars: 10, tee: { maxFiles: 3 } });
  const merged = mergeConfigLayer(loadConfig(dir, {}), layer);
  assert.equal(merged.minChars, 10);
  assert.equal(merged.tee.maxFiles, 3);
  assert.equal(merged.tee.mode, 'lossy');
  writeFileSync(join(dir, 'bad.json'), '[1]');
  assert.throws(() => loadConfigLayerFile(join(dir, 'bad.json')));
  assert.throws(() => loadConfigLayerFile(join(dir, 'missing.json')));
}));

// --- readGuard ---------------------------------------------------------------------------------------

function guardConfig(dir, { global, project, env = {} } = {}) {
  const xdg = join(dir, 'xdg');
  if (global) {
    mkdirSync(join(xdg, 'tokenslim'), { recursive: true });
    writeFileSync(join(xdg, 'tokenslim', 'config.json'), JSON.stringify(global));
  }
  if (project) writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify(project));
  clearConfigCache();
  return loadConfig(dir, { HOME: dir, XDG_CONFIG_HOME: xdg, ...env });
}

test('readGuard defaults and validation', () => temp((dir) => {
  const config = guardConfig(dir);
  assert.deepEqual(config.readGuard, { mode: 'advise', lines: 2000, bytes: 0 });
  assert.equal(config.readGuardLines, 2000);

  const invalid = guardConfig(dir, { project: { readGuard: { mode: 'block', lines: -1, bytes: 'big' } } });
  assert.deepEqual(invalid.readGuard, { mode: 'advise', lines: 2000, bytes: 0 });
  const valid = guardConfig(dir, { project: { readGuard: { mode: 'deny', lines: 300, bytes: 50000, extra: 1 } } });
  assert.deepEqual(valid.readGuard, { mode: 'deny', lines: 300, bytes: 50000 });
  assert.deepEqual(guardConfig(dir, { project: { readGuard: 'deny' } }).readGuard, { mode: 'advise', lines: 2000, bytes: 0 });
}));

test('readGuard nested-merges across layers rather than replacing the object', () => temp((dir) => {
  const config = guardConfig(dir, { global: { readGuard: { mode: 'deny', lines: 900 } }, project: { readGuard: { bytes: 5000 } } });
  assert.deepEqual(config.readGuard, { mode: 'deny', lines: 900, bytes: 5000 });
}));

test('readGuardLines alias: legacy key and env keep working and stay in sync with readGuard.lines', () => temp((dir) => {
  const legacy = guardConfig(dir, { project: { readGuardLines: 7 } });
  assert.equal(legacy.readGuard.lines, 7);
  assert.equal(legacy.readGuardLines, 7);
  const fromEnv = guardConfig(dir, { env: { TOKENSLIM_READ_GUARD_LINES: '11' } });
  assert.equal(fromEnv.readGuard.lines, 11);
  assert.equal(fromEnv.readGuardLines, 11);
  assert.equal(guardConfig(dir, { project: { readGuardLines: -3 } }).readGuard.lines, 2000);
}));

test('readGuard alias precedence: explicit readGuard.lines wins within a layer, later layers win across layers, env wins last', () => temp((dir) => {
  // Same layer: readGuard.lines beats readGuardLines whichever key order the file uses.
  assert.equal(guardConfig(dir, { project: { readGuardLines: 7, readGuard: { lines: 300 } } }).readGuard.lines, 300);
  assert.equal(guardConfig(dir, { project: { readGuard: { lines: 300 }, readGuardLines: 7 } }).readGuard.lines, 300);
  // A same-layer readGuard without lines leaves the alias in force.
  assert.equal(guardConfig(dir, { project: { readGuardLines: 7, readGuard: { mode: 'deny' } } }).readGuard.lines, 7);
  // Across layers the project layer overrides the global one, whichever spelling each used.
  assert.equal(guardConfig(dir, { global: { readGuard: { lines: 100 } }, project: { readGuardLines: 7 } }).readGuard.lines, 7);
  assert.equal(guardConfig(dir, { global: { readGuardLines: 7 }, project: { readGuard: { lines: 100 } } }).readGuard.lines, 100);
  assert.equal(guardConfig(dir, { global: { readGuardLines: 7 }, project: { readGuard: { mode: 'deny' } } }).readGuard.lines, 7);
  // The env alias applies at the env layer, above both files.
  const env = { TOKENSLIM_READ_GUARD_LINES: '42' };
  assert.equal(guardConfig(dir, { project: { readGuard: { lines: 300 }, readGuardLines: 7 }, env }).readGuard.lines, 42);
  assert.equal(guardConfig(dir, { project: { readGuard: { lines: 300 }, readGuardLines: 7 }, env }).readGuardLines, 42);
}));

test('TOKENSLIM_READ_GUARD_MODE overrides files, ignores invalid values, and is part of the cache key', () => temp((dir) => {
  const project = { readGuard: { mode: 'advise' } };
  assert.equal(guardConfig(dir, { project, env: { TOKENSLIM_READ_GUARD_MODE: 'DENY' } }).readGuard.mode, 'deny');
  assert.equal(guardConfig(dir, { project, env: { TOKENSLIM_READ_GUARD_MODE: 'nonsense' } }).readGuard.mode, 'advise');
  // Without clearing the cache between calls, differing env values must not share an entry.
  clearConfigCache();
  const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg') };
  assert.equal(loadConfig(dir, { ...env, TOKENSLIM_READ_GUARD_MODE: 'off' }).readGuard.mode, 'off');
  assert.equal(loadConfig(dir, { ...env, TOKENSLIM_READ_GUARD_MODE: 'deny' }).readGuard.mode, 'deny');
  assert.equal(loadConfig(dir, env).readGuard.mode, 'advise');
  // Combined with the lines alias in one env layer.
  const both = guardConfig(dir, { env: { TOKENSLIM_READ_GUARD_MODE: 'deny', TOKENSLIM_READ_GUARD_LINES: '9' } });
  assert.deepEqual(both.readGuard, { mode: 'deny', lines: 9, bytes: 0 });
}));

test('mergeConfigLayer keeps readGuardLines and readGuard.lines aligned', () => temp((dir) => {
  writeFileSync(join(dir, 'layer.json'), JSON.stringify({ readGuardLines: 12, readGuard: { mode: 'deny' } }));
  const merged = mergeConfigLayer(loadConfig(dir, {}), loadConfigLayerFile(join(dir, 'layer.json')));
  assert.equal(merged.readGuard.lines, 12);
  assert.equal(merged.readGuardLines, 12);
  assert.equal(merged.readGuard.mode, 'deny');
}));
