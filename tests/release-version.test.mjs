import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const script = join(root, 'scripts', 'validate-release-version.mjs');

test('release version validation accepts synced manifest versions', () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release version validation passed: v\d+\.\d+\.\d+/);
});

test('release version validation rejects mismatched tag versions', () => {
  const result = spawnSync(process.execPath, [script, '--tag', 'v9.9.9'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tag v9\.9\.9 does not match manifest version/);
});

test('release version validation rejects explicit tags without v prefix', () => {
  const result = spawnSync(process.execPath, [script, '--tag', '0.1.2'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /release tag must start with v/);
});

test('release version validation rejects missing tag values', () => {
  const result = spawnSync(process.execPath, [script, '--tag'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--tag requires a value/);
});
