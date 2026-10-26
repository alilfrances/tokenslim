import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const script = join(root, 'scripts', 'validate-release-version.mjs');

function validate(args = []) {
  const iso = isolatedEnv();
  try { return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env: iso.env }); } finally { iso.cleanup(); }
}

test('release version validation accepts synced manifest versions', () => {
  const result = validate();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release version validation passed: v\d+\.\d+\.\d+/);
});

test('release version validation rejects mismatched tag versions', () => {
  const result = validate(['--tag', 'v9.9.9']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tag v9\.9\.9 does not match manifest version/);
});

test('release version validation rejects explicit tags without v prefix', () => {
  const result = validate(['--tag', '0.1.2']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /release tag must start with v/);
});

test('release version validation rejects missing tag values', () => {
  const result = validate(['--tag']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--tag requires a value/);
});
