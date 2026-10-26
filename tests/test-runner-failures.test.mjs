// WP2 (v0.4.1): a failing test run keeps its names and assertion detail verbatim, whatever the escape spelling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compressBashOutput, detectionText, stripAnsi, summarizeTestRunners } from '../scripts/lib/pipeline.mjs';
import { FAILURE_RE, hasFailure } from '../scripts/lib/cmd-compressors/shared.mjs';
import { failureOutput, processBashPayload } from '../scripts/lib/bash-hook.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { FIXTURE_COMMANDS } from '../scripts/benchmark.mjs';
import { isolatedEnv } from './helpers.mjs';

const root = join(import.meta.dirname, '..');
const fixture = (name) => readFileSync(join(root, 'tests', 'fixtures', 'bash', name), 'utf8');
const LITERAL = '\\u001b';
const REAL = '\x1b';
const config = loadConfig(root, { ...process.env, XDG_CONFIG_HOME: join(root, 'tests', 'fixtures', 'no-such-config') });

function jestInput(esc) {
  return [
    `${esc}[32mPASS${esc}[39m src/a.test.js`,
    `${esc}[32mPASS${esc}[39m src/b.test.js`,
    `${esc}[31mFAIL${esc}[39m src/sum.test.js`,
    '  ● sum › adds numbers',
    '',
    '    expect(received).toBe(expected)',
    '',
    '    Expected: 4',
    '    Received: 5',
    '',
    'Test Suites: 1 failed, 2 passed, 3 total',
    'Tests:       1 failed, 9 passed, 10 total',
    ...Array.from({ length: 30 }, (_, i) => `  ✓ case ${i} (${i} ms)`),
  ].join('\n') + '\n';
}

function hook(stdout, command = 'npx jest') {
  return processBashPayload({ session_id: 's', tool_use_id: 't', tool_input: { command }, tool_response: { stdout, stderr: '' } }, { config, dryRun: true });
}

test('detectionText strips real ESC sequences and every literal CSI spelling, and nothing else', () => {
  for (const esc of [LITERAL, '\\x1b', '\\x1B', '\\033', '\\e', '\\u001B', '\\u{1b}', REAL]) {
    assert.equal(detectionText(`${esc}[31mFAIL${esc}[39m src/a.test.js`), 'FAIL src/a.test.js', esc);
    assert.equal(detectionText(`${esc}[1;38;5;196mx${esc}[0m`), 'x', esc);
    assert.equal(detectionText(`${esc}[2K${esc}[0Gdone`), 'done', esc);
  }
  // Plain text, an unterminated CSI and an unrelated backslash sequence are data.
  for (const text of ['plain \\n text', 'x \\u001b[', 'path\\element', 'a \\u0041 b']) assert.equal(detectionText(text), text);
});

test('stripAnsi still leaves literal escape text alone (kept lines stay verbatim)', () => {
  const line = `${LITERAL}[31mFAIL${LITERAL}[39m src/sum.test.js`;
  assert.equal(stripAnsi(line), line);
  assert.equal(stripAnsi(`${REAL}[31mFAIL${REAL}[39m x`), 'FAIL x');
});

test('FAILURE_RE gates see through literal escapes (hasFailure, failureOutput)', () => {
  for (const esc of [LITERAL, '\\x1b', '\\033', '\\e', REAL]) {
    const text = `${esc}[31mFAIL${esc}[39m src/sum.test.js\n`;
    assert.equal(hasFailure(text), true, esc);
    assert.equal(failureOutput(text, '', 'npx jest', {}), true, esc);
    assert.equal(failureOutput('', `${esc}[31merror${esc}[39m: boom`, 'make', {}), true, esc);
  }
  assert.equal(hasFailure(`${LITERAL}[32mPASS${LITERAL}[39m src/a.test.js\n0 failed`), false);
  assert.equal(FAILURE_RE.test('FAIL x'), true);
});

test('literal-escape jest output keeps the FAIL line, test name and Expected/Received; the hook passes it through', () => {
  for (const esc of [LITERAL, REAL]) {
    const input = jestInput(esc);
    const lines = input.split('\n');
    const output = summarizeTestRunners(input);
    const out = output.split('\n');
    // Every emitted line except the marker is a byte-identical input line.
    const marker = out.pop();
    assert.match(marker, /^\[tokenslim: \d+ test runner lines omitted\]$/);
    for (const line of out) assert.ok(lines.includes(line), `not verbatim: ${JSON.stringify(line)}`);
    for (const want of [`${esc}[31mFAIL${esc}[39m src/sum.test.js`, '  ● sum › adds numbers', '    Expected: 4', '    Received: 5', 'Tests:       1 failed, 9 passed, 10 total']) {
      assert.ok(out.includes(want), `${esc} lost ${want}`);
    }
    assert.ok(!output.includes('✓ case'));
    assert.ok(!output.includes('PASS'));
    assert.equal(hook(input).outcome, 'skippedFailure');
    for (const line of ['  ● sum › adds numbers', '    Expected: 4', '    Received: 5']) assert.ok(compressBashOutput(input).text.includes(line));
  }
});

test('output cut before the summary (| head) still keeps the failing test and its detail', () => {
  const full = jestInput(LITERAL).split('\n');
  const cut = full.slice(0, full.indexOf('Test Suites: 1 failed, 2 passed, 3 total')).join('\n') + '\n';
  const output = summarizeTestRunners(cut);
  for (const want of [`${LITERAL}[31mFAIL${LITERAL}[39m src/sum.test.js`, '  ● sum › adds numbers', '    Expected: 4', '    Received: 5']) assert.ok(output.includes(want), want);
  // Same shape, large enough to reach the compression gates.
  assert.equal(hook(fixture('jest-failing-truncated.txt'), 'npx jest 2>&1 | head -80').outcome, 'skippedFailure');
});

test('a jest failure block survives blank lines and ends at the next header or summary', () => {
  const input = [
    'PASS src/a.test.js',
    'FAIL src/one.test.js',
    '  ● one › first',
    '',
    '    expect(received).toBe(expected)',
    '',
    '    Expected: 1',
    '    Received: 2',
    '',
    '      at Object.<anonymous> (src/one.test.js:3:3)',
    '',
    'PASS src/b.test.js',
    'FAIL src/two.test.js',
    '  ● two › second',
    '',
    '    Expected: "a"',
    '    Received: "b"',
    '',
    'Test Suites: 2 failed, 2 passed, 4 total',
    'Tests:       2 failed, 4 passed, 6 total',
  ].join('\n');
  const out = summarizeTestRunners(input).split('\n');
  for (const want of ['FAIL src/one.test.js', '  ● one › first', '    Expected: 1', '    Received: 2', 'FAIL src/two.test.js', '  ● two › second', '    Expected: "a"', '    Received: "b"']) assert.ok(out.includes(want), want);
  assert.ok(!out.includes('PASS src/a.test.js') && !out.includes('PASS src/b.test.js'), 'a PASS header ends the block and is dropped');
  assert.match(out.at(-1), /^\[tokenslim: 2 test runner lines omitted\]$/);
  // Blank runs collapse only as before.
  assert.doesNotMatch(summarizeTestRunners(input), /\n{3,}/);
});

test('mocha numbered failures keep names, messages and the expected/actual diff', () => {
  const input = [
    '  Suite A',
    ...Array.from({ length: 20 }, (_, i) => `    ✓ works ${i} (${i}ms)`),
    '    1) fails on sum',
    '    2) fails on text',
    '',
    '  20 passing (30ms)',
    '  2 failing',
    '',
    '  1) Suite A',
    '       fails on sum:',
    '',
    '      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '',
    '      5 !== 4',
    '',
    '      + expected - actual',
    '',
    '      -5',
    '      +4',
    '',
    '      at Context.<anonymous> (test/a.test.js:12:10)',
    '',
    '  2) Suite A',
    '       fails on text:',
    "     AssertionError: expected 'a' to equal 'b'",
    '      + expected - actual',
    '',
    '      -a',
    '      +b',
  ].join('\n');
  const out = summarizeTestRunners(input).split('\n');
  for (const line of input.split('\n').filter((l) => /^\s*\d\) |expected|Expected|failing|^\s+(?:fails|[-+]\w|5 !==)/.test(l) && !/✓|passing/.test(l))) assert.ok(out.includes(line), `lost ${JSON.stringify(line)}`);
  assert.ok(!out.some((l) => l.includes('✓')));
  assert.ok(out.at(-1).startsWith('[tokenslim: '));
  // A TypeError-style failure has no AssertionError/failed word; the failing count alone selects failure handling.
  const typeError = ['  3 passing (10ms)', '  1 failing', '', '  1) Suite', '       breaks:', '', '     TypeError: x is not a function', '      at run (a.js:1:1)', '', '  ✓ ok', 'ok 1 - extra', 'ok 2 - extra'].join('\n');
  assert.ok(summarizeTestRunners(typeError).includes('  1) Suite'));
});

test('go and TAP failure names plus vitest column-0 assertion detail survive', () => {
  const go = [
    '=== RUN   TestAdd', '--- PASS: TestAdd (0.00s)', '=== RUN   TestSum', '    sum_test.go:12: expected 4, got 5', '--- FAIL: TestSum (0.00s)',
    '=== RUN   TestSub', '--- PASS: TestSub (0.00s)', 'FAIL', 'FAIL\texample.com/a\t0.004s', 'FAIL\texample.com/b\t0.100s',
  ].join('\n');
  const goOut = summarizeTestRunners(go).split('\n');
  for (const want of ['--- FAIL: TestSum (0.00s)', '    sum_test.go:12: expected 4, got 5']) assert.ok(goOut.includes(want), want);

  const tap = ['ok 1 - a', 'not ok 2 - sum', '  ---', '  error: |-', '    Expected values to be strictly equal:', '', '    4 !== 5', '  ...', 'ok 3 - b', 'ok 4 - c', '# tests 4', '# fail 1'].join('\n');
  const tapOut = summarizeTestRunners(tap).split('\n');
  for (const want of ['not ok 2 - sum', '    Expected values to be strictly equal:', '    4 !== 5']) assert.ok(tapOut.includes(want), want);
  assert.ok(!tapOut.includes('ok 3 - b'));

  const vitest = [' ✓ src/a.test.ts (3 tests) 4ms', ' FAIL  src/b.test.ts > adds', 'AssertionError: expected 5 to be 4', '', '- Expected', '+ Received', '', '- 4', '+ 5', '', ' ❯ src/b.test.ts:4:17', '', ' Test Files  1 failed | 1 passed (2)', '      Tests  1 failed | 3 passed (4)'].join('\n');
  const vitestOut = summarizeTestRunners(vitest).split('\n');
  for (const want of [' FAIL  src/b.test.ts > adds', 'AssertionError: expected 5 to be 4', '- Expected', '+ Received']) assert.ok(vitestOut.includes(want), want);
});

test('consecutive failing-test names that differ only in digits are never collapsed', () => {
  const input = [
    ...Array.from({ length: 12 }, (_, i) => `tests/test_case_${i}.py::test_ok PASSED`),
    '=================================== FAILURES ===================================',
    '_____________________________________ test_x ___________________________________',
    'E       AssertionError: expected 1 but got 2',
    '=========================== short test summary info ============================',
    ...Array.from({ length: 6 }, (_, i) => `FAILED tests/test_case_${i}.py::test_value_${i} - AssertionError: expected ${i}`),
    '======================== 6 failed, 12 passed in 1.00s ========================',
  ].join('\n');
  for (const text of [summarizeTestRunners(input), compressBashOutput(input).text]) {
    for (let i = 0; i < 6; i += 1) assert.ok(text.includes(`FAILED tests/test_case_${i}.py::test_value_${i} - AssertionError: expected ${i}`), `case ${i}`);
  }
});

// Lines whose loss would make a failing run undebuggable: names, then assertion detail.
const NAME_LINE_RE = /^\s*(?:FAIL|FAILED)\b|\bFAILED$|^\s*--- FAIL\b|^\s*●\s|^not ok\b/;
const DETAIL_LINE_RE = /\b(?:Expected|Received|expected|actual)\b/;
function mustKeep(input) {
  const mocha = /^\s*\d+ failing\b/m.test(input);
  return input.split('\n').filter((line) => {
    const d = detectionText(line);
    if (/\b(?:PASSED|PASS)\b/.test(d) || /^\s*[✓✔√]\s/.test(d)) return false;
    return NAME_LINE_RE.test(d) || (mocha && /^\s*\d+\)\s+\S/.test(d)) || DETAIL_LINE_RE.test(d);
  });
}

const failingInputs = () => [
  ...['npm-test-failing.txt', 'npm-test-failing-literal-escapes.txt', 'pytest-failing.txt', 'jest-failing-blank-lines.txt', 'jest-failing-truncated.txt']
    .map((name) => ({ label: name, input: fixture(name), command: FIXTURE_COMMANDS[name] })),
  { label: 'jest literal', input: jestInput(LITERAL), command: 'npx jest' },
  { label: 'jest real', input: jestInput(REAL), command: 'npx jest' },
];

test('invariant: every failing test name and assertion line in a failing fixture survives each stage', () => {
  const iso = isolatedEnv();
  try {
    const cases = failingInputs();
    // The generic suites above also cover mocha/go/TAP/vitest shapes; include them here so all stages are checked.
    cases.push({ label: 'mocha', command: 'npx mocha', input: ['  Suite', ...Array.from({ length: 30 }, (_, i) => `    ✓ case ${i}`), '    1) breaks', '', '  30 passing (9ms)', '  1 failing', '', '  1) Suite', '       breaks:', '', '     AssertionError: expected 1 to equal 2', '     + expected - actual', '', '     -1', '     +2', ''].join('\n') });
    for (const { label, input, command } of cases) {
      const wanted = mustKeep(input);
      assert.ok(wanted.length >= 3, `${label} has names and detail to keep`);
      const summarized = summarizeTestRunners(input).split('\n');
      const compressed = compressBashOutput(input).text.split('\n');
      for (const line of wanted) {
        assert.ok(summarized.includes(line), `summarizeTestRunners lost ${JSON.stringify(line)} in ${label}`);
        // compressBashOutput strips real ESC bytes (display-only); literal escapes are data and stay as they were.
        assert.ok(compressed.includes(stripAnsi(line)), `compressBashOutput lost ${JSON.stringify(line)} in ${label}`);
      }
      const result = processBashPayload({ session_id: 's', tool_use_id: 't', tool_input: { command }, tool_response: { stdout: input, stderr: '' } }, { config, env: iso.env, dryRun: true });
      if (result.outcome === 'skippedFailure') continue;
      assert.equal(result.outcome, 'compressed', label);
      const emitted = result.updatedToolOutput.split('\n');
      for (const line of wanted) assert.ok(emitted.includes(stripAnsi(line)), `hook lost ${JSON.stringify(line)} in ${label}`);
    }
  } finally { iso.cleanup(); }
});

test('the new failing fixtures are worth compressing and the hook never touches them', () => {
  for (const name of ['jest-failing-blank-lines.txt', 'jest-failing-truncated.txt', 'npm-test-failing-literal-escapes.txt']) {
    const input = fixture(name);
    assert.ok(summarizeTestRunners(input).length < input.length * 0.6, name);
    assert.equal(hook(input, FIXTURE_COMMANDS[name]).outcome, 'skippedFailure', name);
  }
  assert.ok(fixture('jest-failing-blank-lines.txt').split('\n').filter((l) => /PASS/.test(l)).length >= 40);
  assert.ok(!/Test Suites:/.test(fixture('jest-failing-truncated.txt')));
  // The literal-escape variants really are literal text, and the real-byte variants really are bytes.
  assert.ok(fixture('npm-test-failing-literal-escapes.txt').includes('\\u001b[31mFAIL'));
  assert.ok(fixture('cargo-build-literal-escapes.txt').includes('\\u001b[32mCompiling'));
  assert.ok(fixture('npm-test-failing.txt').includes('\x1b[31mFAIL'));
});

test('passing-only runner output is unchanged versus the pre-WP2 behavior', () => {
  const snapshot = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'parity', 'test-runner-passing.json'), 'utf8'));
  assert.ok(Object.keys(snapshot).length >= 6);
  for (const [id, { input, summarize, compress }] of Object.entries(snapshot)) {
    assert.equal(summarizeTestRunners(input), summarize, `summarizeTestRunners ${id}`);
    assert.equal(compressBashOutput(input).text, compress, `compressBashOutput ${id}`);
  }
});
