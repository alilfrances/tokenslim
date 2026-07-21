import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandMeta, compressCommandOutput } from '../scripts/lib/cmd-compressors/index.mjs';
import { FAILURE_RE, hasFailure } from '../scripts/lib/cmd-compressors/shared.mjs';
import { compressBashOutput } from '../scripts/lib/pipeline.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bash');
const fixture = (name) => readFile(join(fixtures, name), 'utf8');

const cases = [
  ['git-status-porcelain.txt', 'git status --porcelain=v1 -b', 'main...origin/main [ahead 1] | 1M 1? 1A\n M src/app.js\n?? notes.txt\nA  docs/new.md'],
  ['git-diff.txt', 'git diff', 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,2 +1,3 @@\n-old\n+new\n+another'],
  ['go-test-json.txt', 'go test -json ./...', 'go test: ok (1 tests, 1 packages)'],
  ['docker-ps.txt', 'docker ps', 'CONTAINER ID | IMAGE | COMMAND | CREATED | STATUS | PORTS | NAMES\nabc123 | nginx:latest | "nginx -g daemon off;" | 2 hours ago | Up 2 hours | 0.0.0.0:8080->80/tcp | web'],
  ['eslint.txt', 'eslint src', '/work/src/app.js\n  2:3  warning  Unexpected console statement  no-console\n  4:1  error    Missing semicolon              semi\n/work/src/util.js\n  1:1  warning  Unexpected console statement  no-console'],
  ['tsc.txt', 'tsc --noEmit', "src/app.ts(4,2): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/app.ts(8,2): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/util.ts(1,1): error TS7006: Parameter 'x' implicitly has an 'any' type."],
];

for (const [name, command, expected] of cases) test(`${name} has an exact deterministic command compression`, async () => {
  const input = await fixture(name);
  const first = compressCommandOutput(input, command);
  const second = compressCommandOutput(input, command);
  assert.equal(first.text, expected);
  assert.deepEqual(second, first);
  // Actionable locations and upstream state may legitimately cost a few bytes.
});

test('git diff retains every changed line and patch-oriented logs pass through', () => {
  const diff = ['diff --git a/src/app.js b/src/app.js', 'index aaa..bbb 100644', '--- a/src/app.js', '+++ b/src/app.js', '@@ -1,20 +1,20 @@', ...Array.from({ length: 20 }, (_, index) => `-${index + 1}`), ...Array.from({ length: 20 }, (_, index) => `+${index + 1}`)].join('\n');
  // A diff with only changes has no safe material to remove, so it passes
  // through rather than replacing the changes with a file-count summary.
  const compressed = compressCommandOutput(diff, 'git diff');
  const visible = compressed?.text || diff;
  for (let index = 1; index <= 20; index += 1) {
    assert.match(visible, new RegExp(`^-${index}$`, 'm'));
    assert.match(visible, new RegExp(`^\\+${index}$`, 'm'));
  }
  const patch = 'commit abcdef1234567\nAuthor: A\n\n    change\n\ndiff --git a/a b/a\n+content';
  for (const command of ['git log -p', 'git log --stat=80', 'git log --graph', 'git log --name-only', 'git log -L 1,2:file.js', 'git log -Sneedle', 'git log -Gpattern']) {
    assert.equal(compressCommandOutput(patch, command), null, command);
  }
  const context = 'diff --git a/a.js b/a.js\nindex aaa..bbb 100644\nold mode 100644\nnew mode 100755\n--- a/a.js\n+++ b/a.js\n@@ -1,5 +1,5 @@\n context one\n\n context two\n context three\n context four\n context five';
  assert.match(compressCommandOutput(context, 'git diff').text, / context one\n\n context two/);
  const pull = 'Updating abc..def\nFast-forward\n\n src/app.js | 2 ++\n 1 file changed, 2 insertions(+)';
  assert.equal(compressCommandOutput(pull, 'git pull').text, `ok git pull:\n${pull}`);
  for (const command of ['git push', 'git fetch', 'git add src/app.js', 'git commit -m change']) {
    assert.equal(compressCommandOutput('remote hook summary\nfinal status', command), null, command);
  }
});

test('linter diagnostics keep locations and deduplicate only identical diagnostics', () => {
  const hits = Array.from({ length: 50 }, (_, index) => `  ${index + 1}:1  warning  Unexpected console statement  no-console`);
  const input = `/work/src/app.js\n${hits.join('\n')}`;
  const compressed = compressCommandOutput(input, 'npx eslint src');
  assert.ok(compressed);
  assert.equal(compressed.text.split('\n').filter((line) => /no-console$/.test(line)).length, 3);
  assert.match(compressed.text, /47 identical diagnostics omitted/);
  // ESLint's location-only records require their heading, but both retained
  // lines must be byte-for-byte input lines rather than a synthesized path prefix.
  const singleDiagnostic = '/work/a.js\n  1:1  error  Bad thing  rule';
  const single = compressCommandOutput(singleDiagnostic, '/work/node_modules/.bin/eslint a').text;
  assert.equal(single, singleDiagnostic);
  assert.ok(single.split('\n').every((line) => singleDiagnostic.split('\n').includes(line)));
  // Healthy stderr (such as a Node warning) is preserved separately by Bash and
  // must not disable location-preserving stdout diagnostics.
  assert.equal(compressCommandOutput(singleDiagnostic, 'eslint a', {}, { stderr: 'npm warn deprecated wrapper' }).text, singleDiagnostic);
});

test('normalizes assignments, paths, and supported launcher prefixes before dispatch', () => {
  for (const [command, binary, subcommand] of [
    ['CI=1 ./node_modules/.bin/eslint src', 'eslint', 'src'],
    ['npx --yes eslint src', 'eslint', 'src'],
    ['pnpm exec eslint src', 'eslint', 'src'],
    ['pnpm --silent exec eslint src', 'eslint', 'src'],
    ['yarn run eslint src', 'eslint', 'src'],
    ['yarn --silent run eslint src', 'eslint', 'src'],
    ['yarn --silent exec eslint src', 'eslint', 'src'],
    ['yarn test', 'yarn', 'test'],
  ]) {
    assert.deepEqual(commandMeta(command)?.binary, binary, command);
    assert.deepEqual(commandMeta(command)?.subcommand, subcommand, command);
  }
  const diagnostic = '/work/a.js\n  1:1  error  Bad thing  rule';
  for (const command of ['CI=1 ./node_modules/.bin/eslint a', 'npx --yes eslint a', 'pnpm exec eslint a', 'pnpm --silent exec eslint a', 'yarn run eslint a', 'yarn --silent run eslint a']) {
    assert.match(compressCommandOutput(diagnostic, command)?.text || '', /\/work\/a\.js\n\s+1:1/, command);
  }
});

test('structured failure detection ignores healthy summaries and incidental prose', () => {
  for (const text of ['test result: ok. 5 passed; 0 failed', '0 FAILED, all done', '0 errors, all done', 'docs describe error handling']) {
    assert.equal(FAILURE_RE.test(text), false, text);
    assert.equal(hasFailure(text), false, text);
  }
  for (const text of ['error[E0308]: mismatched types', 'Error: unable to connect', 'fatal: remote failed', 'npm ERR! code ERESOLVE', '1 failed, 2 passed', '10 FAILED, 2 passed', 'thread panicked at src/lib.rs:1', 'FAILED tests/unit']) {
    assert.equal(FAILURE_RE.test(text), true, text);
    assert.equal(hasFailure(text), true, text);
  }
  assert.equal(hasFailure('\u001b[31merror[E0308]: mismatched types'), true);
});

test('package manager summaries retain security and compatibility warnings', () => {
  const input = 'npm warn deprecated old-package@1: use new-package\nnpm warn ERESOLVE overriding peer dependency\nadded 2 packages, and audited 3 packages in 1s\n2 vulnerabilities (1 moderate, 1 high)';
  const compressed = compressCommandOutput(input, 'npm install');
  assert.ok(compressed);
  assert.match(compressed.text, /deprecated/);
  assert.match(compressed.text, /peer dependency/);
  assert.match(compressed.text, /vulnerabilities/);
  assert.equal(compressCommandOutput('added 2 packages, and audited 3 packages in 1s', 'npm install').text.split('\n').length, 1);
  const repeated = compressCommandOutput(`npm warn deprecated old-package\nnpm warn deprecated old-package\nadded 1 package`, 'npm install');
  assert.match(repeated.text, /1 duplicate package warnings omitted/);
  assert.match(compressCommandOutput('npm verbose fetch manifest\nadded 1 package', 'npm install').text, /\[tokenslim: 1 package-manager lines omitted\]/);
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
  assert.equal(compressCommandOutput('done', 'git push', {}, { stderr: 'fatal: remote failed' }), null);
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
