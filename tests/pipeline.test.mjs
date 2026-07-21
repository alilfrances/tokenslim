import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
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

test('stripProgressNoise keeps final carriage-return state and marks omitted progress spam', () => {
  const input = 'start\nDownloading 10%\rDownloading 60%\rDownloading 100%\n| downloading\n/ 12%\nfinal\n';
  assert.equal(stripProgressNoise(input), 'start\nDownloading 100%\nfinal\n[tokenslim: 2 progress lines omitted]');
});

test('stripProgressNoise never treats Markdown, YAML, or CLI bullets as spinners', () => {
  const input = '- first item\n- second item\n- name: value\n- option: enable verbose output\n';
  assert.equal(stripProgressNoise(input), input.trimEnd());
  assert.equal(stripProgressNoise('Building a durable API\nChecking a documentation example'), 'Building a durable API\nChecking a documentation example');
  assert.equal(stripProgressNoise('| downloading\n- 3.2MB/s\n/ 12%'), '[tokenslim: 3 progress lines omitted]');
});

test('collapseRepeatedLines collapses only strong contiguous runs and reports omitted count exactly', () => {
  const input = Array.from({ length: 4 }, (_, index) =>
    `2026-07-05T10:00:0${index}Z worker ${123 + index} id=${String.fromCharCode(97 + index)}f09 processed ${index + 1} items`,
  ).join('\n');
  const output = collapseRepeatedLines(input);
  assert.match(output, /2026-07-05T10:00:00Z worker 123 id=af09 processed 1 items/);
  assert.match(output, /\[tokenslim: 3 more similar lines collapsed\]/);
});

test('collapseRepeatedLines preserves interleaved unique lines and meaningful numbered listings', () => {
  const interleaved = [
    'fetch package 1 completed successfully',
    'fetch package 2 completed successfully',
    'IMPORTANT: unique warning',
    'fetch package 3 completed successfully',
    'fetch package 4 completed successfully',
  ].join('\n');
  assert.equal(collapseRepeatedLines(interleaved), interleaved);

  const ports = Array.from({ length: 30 }, (_, index) => `port ${3000 + index} -> instance ${index}`).join('\n');
  assert.equal(collapseRepeatedLines(ports), ports);
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

test('summarizeTestRunners has strict runner detection and preserves non-test prose/source verbatim', () => {
  const fixtures = [
    'This should pass the token to the next stage and fail gracefully.',
    [
      'enum class Status { PREPARE_FAILED, UPLOAD_PASSED };',
      'auto status = Status::PREPARE_FAILED;',
      '// pass ownership to the caller',
    ].join('\n'),
    'let state = crate::state::TEST_PASSED;\n// should pass\n// fail gracefully',
    'status::prepare_failed is a lowercase scoped value',
  ];
  for (const input of fixtures) {
    assert.equal(summarizeTestRunners(input), input);
    assert.equal(compressBashOutput(input).text, input);
  }
});

test('summarizeTestRunners recognizes real pytest output but never emits an empty replacement', () => {
  const pytest = [
    'tests/test_x.py::test_y PASSED',
    'tests/test_x.py::test_z PASSED',
    '============================== 2 passed in 0.10s ==============================',
  ].join('\n');
  const summarized = summarizeTestRunners(pytest);
  assert.match(summarized, /2 passed/);
  assert.match(summarized, /\[tokenslim: 2 passing test lines omitted\]/);

  // Two valid TAP signal lines without a summary must remain available.
  const noSummary = 'ok 1 - setup\nok 2 - teardown';
  assert.equal(summarizeTestRunners(noSummary), noSummary);
  // Repeating one test-looking record is not two distinct runner signals.
  const duplicatedSignal = 'PASS src/example.test.js\nPASS src/example.test.js';
  assert.equal(summarizeTestRunners(duplicatedSignal), duplicatedSignal);
});

test('pipeline safety guard does not replace ordinary output with near-empty output', () => {
  const input = Array.from({ length: 100 }, (_, index) => `build worker ${index} processed ${index} files`).join('\n');
  const result = compressBashOutput(input);
  assert.equal(result.text, input);
  assert.deepEqual(result.stats.rulesApplied, []);
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

test('Bash entrypoint preserves large non-test prose and scoped-enum source verbatim', () => {
  const prose = [
    'This guide explains how to pass the ownership token safely to the caller.',
    'When an operation can fail gracefully, retain the original context for review.',
    'enum class Status { PREPARE_FAILED, UPLOAD_PASSED };',
    'auto status = Status::PREPARE_FAILED;',
    'Rust uses crate::state::TEST_PASSED for an unrelated state value.',
  ];
  const stdout = Array.from({ length: 20 }, (_, index) => `${prose[index % prose.length]} Detail ${String.fromCharCode(65 + index)} is deliberately unique.`).join('\n');
  const result = spawnSync(process.execPath, ['scripts/compress-bash.mjs'], {
    cwd: root,
    input: JSON.stringify({
      session_id: 'non-test-e2e',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'cat guide.txt' },
      tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
    }),
    encoding: 'utf8',
    env: { ...process.env, TOKENSLIM_HOOK_RUNTIME: 'claude', TOKENSLIM_MIN_CHARS: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  // Claude emits no hook payload for unchanged output, so the original is retained.
  assert.equal(result.stdout, '');
});

test('Bash entrypoint handles healthy stderr conservatively while preserving real failures', async () => {
  const cacheRoot = mkdtempSync(pathJoin(tmpdir(), 'tokenslim-bash-stderr-'));
  const run = (command, stdout = '', stderr = '', isImage = false) => spawnSync(process.execPath, ['scripts/compress-bash.mjs'], {
    cwd: root,
    input: JSON.stringify({
      session_id: 'stderr-e2e',
      tool_use_id: `tool-${command.replace(/\W+/g, '-')}`,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout, stderr, interrupted: false, isImage },
    }),
    encoding: 'utf8',
    env: { ...process.env, TOKENSLIM_HOOK_RUNTIME: 'claude', TOKENSLIM_MIN_CHARS: '1', TOKENSLIM_TEE_MIN: String(Number.MAX_SAFE_INTEGER), XDG_CACHE_HOME: cacheRoot },
  });
  const updated = (result) => JSON.parse(result.stdout).hookSpecificOutput.updatedToolOutput;

  try {
    const cargo = run('cargo build', '', await fixture('cargo-build.txt'));
    assert.equal(cargo.status, 0, cargo.stderr);
    const cargoOutput = updated(cargo);
    assert.equal(cargoOutput.stdout, '');
    assert.match(cargoOutput.stderr, /warning: function `legacy_parser` is never used/);
    assert.match(cargoOutput.stderr, /progress lines omitted/);
    assert.doesNotMatch(cargoOutput.stderr, /Compiling serde/);

    const npm = run('npm install', await fixture('npm-install.txt'), 'npm warn deprecated old-package@1: use new-package');
    assert.equal(npm.status, 0, npm.stderr);
    const npmOutput = updated(npm);
    assert.match(npmOutput.stdout, /added 412 packages/);
    assert.match(npmOutput.stdout, /\[tokenslim: packageManagerSummary\]/);
    assert.equal(npmOutput.stderr, 'npm warn deprecated old-package@1: use new-package');

    const cargoTest = run('cargo test', Array.from({ length: 40 }, (_, index) => `test crate::case_${index} ... ok`).join('\n') + '\ntest result: ok. 40 passed; 0 failed; 0 ignored');
    assert.equal(cargoTest.status, 0, cargoTest.stderr);
    assert.match(updated(cargoTest).stdout, /test result: ok\. 40 passed; 0 failed/);

    const linter = run('CI=1 npx --yes eslint src', `/work/src/app.js\n${Array.from({ length: 20 }, (_, index) => `  ${index + 1}:1  error  Unexpected console statement  no-console`).join('\n')}`);
    assert.equal(linter.status, 0, linter.stderr);
    assert.match(updated(linter).stdout, /17 identical diagnostics omitted/);

    const rustFailure = run('cargo build', '', Array.from({ length: 20 }, () => 'error[E0308]: mismatched types').join('\n'));
    assert.equal(rustFailure.status, 0, rustFailure.stderr);
    assert.equal(rustFailure.stdout, '');

    const collision = run('echo log', `[tokenslim: example from tool]\n${Array.from({ length: 12 }, (_, index) => `worker ${index} completed the same operation`).join('\n')}`);
    assert.equal(collision.status, 0, collision.stderr);
    assert.match(updated(collision).stdout, /\[tokenslim: example from tool\]/);
    assert.match(updated(collision).stdout, /\[tokenslim: collapseRepeatedLines\]$/);

    const image = run('echo artifact', 'x\n'.repeat(100), '', true);
    assert.equal(image.status, 0, image.stderr);
    assert.equal(image.stdout, '');
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('Bash entrypoint emits valid Codex no-op JSON for pass-through output', () => {
  const payload = JSON.stringify({
    session_id: 's-codex-bash-skip',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    turn_id: 'turn-codex',
    tool_response: { stdout: 'short', stderr: '', interrupted: false, isImage: false },
  });
  const result = spawnSync(process.execPath, ['scripts/compress-bash.mjs'], {
    cwd: root,
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, TOKENSLIM_HOOK_RUNTIME: 'codex' },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{}');
});

test('Bash entrypoint records diagnostics for skipped and compressed outputs', () => {
  const cacheRoot = mkdtempSync(pathJoin(tmpdir(), 'tokenslim-bash-diag-'));
  try {
    const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
    const smallPayload = JSON.stringify({
      session_id: 'diag-bash',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { stdout: 'short', stderr: '', interrupted: false, isImage: false },
    });
    const small = spawnSync(process.execPath, ['scripts/compress-bash.mjs'], {
      cwd: root,
      input: smallPayload,
      encoding: 'utf8',
      env,
    });
    assert.equal(small.status, 0);
    assert.equal(small.stdout, '');

    const stdout = Array.from({ length: 6 }, (_, i) => `build worker ${i} processed ${i} files`).join('\n');
    const largePayload = JSON.stringify({
      session_id: 'diag-bash',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
    });
    const large = spawnSync(process.execPath, ['scripts/compress-bash.mjs'], {
      cwd: root,
      input: largePayload,
      encoding: 'utf8',
      env: { ...env, TOKENSLIM_MIN_CHARS: '10' },
    });
    assert.equal(large.status, 0);

    const state = JSON.parse(readFileSync(pathJoin(cacheRoot, 'tokenslim', 'diag-bash.json'), 'utf8'));
    assert.deepEqual(state.diagnostics.Bash.PostToolUse, {
      attempted: 2,
      skippedBelowThreshold: 1,
      compressed: 1,
    });
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
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
  assert.match(out.hookSpecificOutput.updatedToolOutput.stdout, /\[tokenslim: 5 more similar lines collapsed\]/);
});

test('Bash entrypoint treats model-only payloads as safe-default Claude without turn id', () => {
  const stdout = Array.from({ length: 6 }, (_, i) => `build worker ${i} processed ${i} files`).join('\n');
  const payload = JSON.stringify({
    session_id: 's-codex-no-turn',
    cwd: '/tmp/project',
    transcript_path: null,
    hook_event_name: 'PostToolUse',
    model: 'gpt-5.4',
    tool_name: 'Bash',
    tool_input: {},
    tool_use_id: 'call-1',
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
  assert.match(out.hookSpecificOutput.updatedToolOutput.stdout, /\[tokenslim: 5 more similar lines collapsed\]/);
});

test('Bash entrypoint emits valid Codex compressed additional context', () => {
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
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(out.additionalContext, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /^\[tokenslim: compressed Bash output\]/);
  assert.match(out.hookSpecificOutput.additionalContext, /\[tokenslim: 5 more similar lines collapsed\]/);
});

test('Bash entrypoint compresses Codex string tool_response payloads', () => {
  const stdout = Array.from({ length: 20 }, (_, i) => `worker ${i + 1} processed ${i + 1} files`).join('\n');
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
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(out.additionalContext, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /^\[tokenslim: compressed Bash output\]/);
  assert.match(out.hookSpecificOutput.additionalContext, /\[tokenslim: 19 more similar lines collapsed\]/);
});
