import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  collapseRepeatedLines,
  compressBashOutput,
  dedupStackTraces,
  headTailTruncate,
  stripAnsi,
  stripProgressNoise,
  summarizeTestRunners,
} from '../scripts/lib/pipeline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const fixtureDir = join(__dirname, 'fixtures', 'bash');

async function fixture(name) {
  return readFile(join(fixtureDir, name), 'utf8');
}

function percentSaved(input, output) {
  return Math.round((1 - output.length / input.length) * 1000) / 10;
}

test('stripAnsi removes color and cursor escape codes', () => {
  assert.equal(stripAnsi('\u001b[31mERR\u001b[0m \u001b[2Kline'), 'ERR line');
});

test('stripProgressNoise keeps final carriage-return state and drops spinner/progress spam', () => {
  const input = 'start\nDownloading 10%\rDownloading 60%\rDownloading 100%\n| building\n/ building\nfinal\n';
  assert.equal(stripProgressNoise(input), 'start\nDownloading 100%\nfinal');
});

test('collapseRepeatedLines collapses exact and near duplicate runs with verbatim first line', () => {
  const input = [
    '2026-07-05T10:00:00Z worker 123 id=af09 processed 1 items',
    '2026-07-05T10:00:01Z worker 124 id=bf19 processed 2 items',
    'other',
    '2026-07-05T10:00:02Z worker 125 id=cf29 processed 3 items',
    '2026-07-05T10:00:03Z worker 126 id=df39 processed 4 items',
    'done',
  ].join('\n');
  const output = collapseRepeatedLines(input);
  assert.match(output, /2026-07-05T10:00:00Z worker 123 id=af09 processed 1 items/);
  assert.match(output, /\[tokenslim: 4 similar lines collapsed\]/);
});

test('summarizeTestRunners keeps pytest failures verbatim and drops passing spam', () => {
  const input = [
    'tests/test_alpha.py::test_ok PASSED',
    'tests/test_math.py::test_addition FAILED',
    '=================================== FAILURES ===================================',
    '_______________________________ test_addition _______________________________',
    'E       AssertionError: expected total 42 but got 41',
    'tests/test_math.py:18: AssertionError',
    '==================== 1 failed, 49 passed in 1.20s ====================',
  ].join('\n');
  const output = summarizeTestRunners(input);
  assert.match(output, /tests\/test_math.py::test_addition FAILED/);
  assert.match(output, /E       AssertionError: expected total 42 but got 41/);
  assert.doesNotMatch(output, /test_ok PASSED/);
  assert.match(output, /1 failed, 49 passed/);
});

test('dedupStackTraces collapses repeated traces and repeated frame runs', () => {
  const trace = [
    'Traceback (most recent call last):',
    '  File "/app/a.py", line 1, in <module>',
    '    main()',
    '  File "/app/b.py", line 2, in main',
    '    main()',
    '  File "/app/b.py", line 2, in main',
    '    main()',
    'ValueError: broken 123',
  ].join('\n');
  const output = dedupStackTraces(`${trace}\nnoise\n${trace}`);
  assert.match(output, /ValueError: broken 123/);
  assert.match(output, /\[tokenslim: 2 repeated frames\]/);
  assert.match(output, /\[tokenslim: stack trace repeated 2 times\]/);
});

test('headTailTruncate preserves head, tail, and important omitted lines', () => {
  const lines = Array.from({ length: 410 }, (_, i) => `line ${i}`);
  lines[200] = 'WARNING: middle line 200';
  const output = headTailTruncate(lines.join('\n'), { maxChars: 1000, headLines: 5, tailLines: 5 });
  assert.match(output, /^line 0/);
  assert.match(output, /\[tokenslim: 400 lines omitted\]/);
  assert.match(output, /\[tokenslim: important omitted lines\]/);
  assert.match(output, /WARNING: middle line 200/);
  assert.match(output, /line 409$/);
});

test('compressBashOutput is deterministic', async () => {
  const input = await fixture('npm-install.txt');
  assert.equal(compressBashOutput(input).text, compressBashOutput(input).text);
});

test('fixture compression floors are met', async () => {
  const floors = new Map([
    ['npm-install.txt', 60],
    ['pytest-passing.txt', 70],
    ['docker-pull.txt', 70],
    ['stacktrace-repeat.txt', 60],
  ]);
  for (const [name, floor] of floors) {
    const input = await fixture(name);
    const { text } = compressBashOutput(input);
    assert.ok(percentSaved(input, text) >= floor, `${name} saved ${percentSaved(input, text)}%, expected >= ${floor}%`);
  }
});

test('failing fixtures preserve failing names and messages verbatim', async () => {
  for (const name of ['npm-test-failing.txt', 'pytest-failing.txt']) {
    const input = await fixture(name);
    const { text } = compressBashOutput(input);
    for (const expected of [
      'src/math.test.js > add() > returns the full invoice total',
      'Expected: 42',
      'Received: 41',
      'tests/test_orders.py::test_refunds_preserve_original_invoice_id FAILED',
      'E       AssertionError: expected invoice id inv_20260705_000123 but got inv_20260705_000124',
    ]) {
      if (input.includes(expected)) assert.ok(text.includes(expected), `${name} missing ${expected}`);
    }
  }
});

test('entrypoint fails open on garbage stdin', () => {
  const result = spawnSync(process.execPath, ['scripts/compress-bash.mjs'], {
    cwd: root,
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('entrypoint passes through small output and disabled bash output', () => {
  const payload = JSON.stringify({ session_id: 's1', tool_response: { stdout: 'short', stderr: '', interrupted: false, isImage: false } });
  const small = spawnSync(process.execPath, ['scripts/compress-bash.mjs'], { cwd: root, input: payload, encoding: 'utf8' });
  assert.equal(small.status, 0);
  assert.equal(small.stdout, '');

  const disabled = spawnSync(process.execPath, ['scripts/compress-bash.mjs'], {
    cwd: root,
    input: JSON.stringify({ session_id: 's1', tool_response: { stdout: 'x'.repeat(1000), stderr: '', interrupted: false, isImage: false } }),
    encoding: 'utf8',
    env: { ...process.env, TOKENSLIM_DISABLE: 'bash' },
  });
  assert.equal(disabled.status, 0);
  assert.equal(disabled.stdout, '');
});

test('Bash entrypoint treats Claude transcript payloads as non-blocking replacements', () => {
  const stdout = Array.from({ length: 6 }, (_, i) => `build worker ${i} processed ${i} files`).join('\n');
  const payload = JSON.stringify({
    session_id: 's-claude-bash',
    transcript_path: '/tmp/claude-transcript.jsonl',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
  });
  const result = spawnSync(process.execPath, ['scripts/compress-bash.mjs'], {
    cwd: root,
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, TOKENSLIM_MIN_CHARS: '10' },
  });

  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.continue, undefined);
  assert.equal(out.stopReason, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.updatedToolOutput.stdout, /\[tokenslim: 6 similar lines collapsed\]/);
});

test('Bash entrypoint emits short Codex stop text and compressed additional context', () => {
  const stdout = Array.from({ length: 6 }, (_, i) => `build worker ${i} processed ${i} files`).join('\n');
  const payload = JSON.stringify({
    session_id: 's-codex-bash',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    turn_id: 'turn-codex',
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
  });
  const result = spawnSync(process.execPath, ['scripts/compress-bash.mjs'], {
    cwd: root,
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, TOKENSLIM_MIN_CHARS: '10', TOKENSLIM_HOOK_RUNTIME: 'codex' },
  });

  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.continue, false);
  assert.equal(out.stopReason, 'Token Slim compacted Bash output');
  assert.doesNotMatch(out.stopReason, /similar lines collapsed/);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /^\[tokenslim: compressed Bash output\]/);
  assert.match(out.hookSpecificOutput.additionalContext, /\[tokenslim: 6 similar lines collapsed\]/);
});

test('Bash entrypoint compresses Codex string tool_response payloads', () => {
  const stdout = Array.from({ length: 120 }, (_, i) => `worker ${i + 1} processed ${i + 1} files`).join('\n');
  const payload = JSON.stringify({
    session_id: 's-codex-bash-string',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    turn_id: 'turn-codex',
    tool_response: stdout,
  });
  const result = spawnSync(process.execPath, ['scripts/compress-bash.mjs'], {
    cwd: root,
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, TOKENSLIM_HOOK_RUNTIME: 'codex' },
  });

  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.continue, false);
  assert.equal(out.stopReason, 'Token Slim compacted Bash output');
  assert.doesNotMatch(out.stopReason, /similar lines collapsed/);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /^\[tokenslim: compressed Bash output\]/);
  assert.match(out.hookSpecificOutput.additionalContext, /\[tokenslim: 120 similar lines collapsed\]/);
});
