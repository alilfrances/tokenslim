import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressCommandOutput } from '../scripts/lib/cmd-compressors/index.mjs';
import { compressBashOutput } from '../scripts/lib/pipeline.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bash');
const fixture = (name) => readFile(join(fixtures, name), 'utf8');

const cases = [
  ['git-status-porcelain.txt', 'git status --porcelain=v1 -b', 'main | 1M 1? 1A\n M src/app.js\n?? notes.txt\nA  docs/new.md'],
  ['git-diff.txt', 'git diff', 'src/app.js (+2/-1)\n@@ -1,2 +1,3 @@\n-old\n+new\n+another'], 
  ['go-test-json.txt', 'go test -json ./...', 'go test: ok (1 tests, 1 packages)'],
  ['docker-ps.txt', 'docker ps', 'CONTAINER ID | IMAGE | COMMAND | CREATED | STATUS | PORTS | NAMES\nabc123 | nginx:latest | "nginx -g daemon off;" | 2 hours ago | Up 2 hours | 0.0.0.0:8080->80/tcp | web'],
  ['eslint.txt', 'eslint src', '/work/src/app.js | no-console: 1\n/work/src/app.js | semi: 1\n/work/src/util.js | no-console: 1'],
  ['tsc.txt', 'tsc --noEmit', 'src/app.ts | TS2322: 2\nsrc/util.ts | TS7006: 1'],
];

for (const [name, command, expected] of cases) test(`${name} has an exact deterministic command compression`, async () => {
  const input = await fixture(name);
  const first = compressCommandOutput(input, command);
  const second = compressCommandOutput(input, command);
  assert.equal(first.text, expected);
  assert.deepEqual(second, first);
  assert.ok(first.text.length < input.length);
});

test('custom filters precede built-ins and reject unsafe or malformed patterns', () => {
  const config = { filters: [{ name: 'clean', matchCommand: '^git status$', stripLinesMatching: '^noise$', maxLines: 1 }] };
  assert.deepEqual(compressCommandOutput('noise\nkeep\nother', 'git status', config), { text: 'keep', rulesApplied: ['custom:clean'] });
  assert.equal(compressCommandOutput('data', 'git status', { filters: [{ matchCommand: '[', maxLines: 1 }] }), null);
  assert.equal(compressCommandOutput('data', 'unknown command', { filters: [{ matchCommand: '(a+)+$', maxLines: 1 }] }), null);
  assert.deepEqual(
    compressCommandOutput('one\ntwo', 'unknown command', { filters: [{ name: 'unsafe\n[injection]', matchCommand: '^unknown', maxLines: 1 }] }),
    { text: 'one', rulesApplied: ['custom:filter'] },
  );
});

test('shell syntax and unknown commands defer to generic compression', () => {
  assert.equal(compressCommandOutput('x\nx', 'echo x | cat'), null);
  assert.equal(compressCommandOutput('x\nx', 'git status\nprintf unsafe'), null);
  const input = Array.from({ length: 6 }, (_, i) => `worker ${i} completed`).join('\n');
  assert.equal(compressCommandOutput(input, 'unknown command'), null);
  assert.notEqual(compressBashOutput(input).text, input);
});

test('failure output is never command-compressed', () => {
  const failing = 'FAIL src/example.test.js\nAssertionError: expected 2';
  assert.equal(compressCommandOutput(failing, 'vitest run'), null);
  assert.equal(compressCommandOutput('done', 'git push', {}, { stderr: 'remote: error' }), null);
});

test('Bash entrypoint marks specialized compression and applies the ratio floor after marking', async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'tokenslim-cmd-entry-'));
  const run = (command, toolResponse) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'compress-bash.mjs')], {
    cwd: join(import.meta.dirname, '..'),
    input: JSON.stringify({
      session_id: 'cmd-entry',
      cwd: join(import.meta.dirname, '..'),
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: toolResponse,
      tool_use_id: 'cmd-entry-tool',
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      XDG_CACHE_HOME: cacheRoot,
      TOKENSLIM_HOOK_RUNTIME: 'claude',
      TOKENSLIM_MIN_CHARS: '1',
      TOKENSLIM_TEE_MIN: String(Number.MAX_SAFE_INTEGER),
    },
  });

  try {
    const pytest = run('pytest', await fixture('pytest-passing.txt'));
    assert.equal(pytest.status, 0, pytest.stderr);
    const updated = JSON.parse(pytest.stdout).hookSpecificOutput.updatedToolOutput;
    assert.match(updated, /\[tokenslim: testRunnerSummary\]/);

    const tooSmallAfterMarker = run('git status --porcelain=v1 -b', await fixture('git-status-porcelain.txt'));
    assert.equal(tooSmallAfterMarker.status, 0, tooSmallAfterMarker.stderr);
    assert.equal(tooSmallAfterMarker.stdout, '');
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
