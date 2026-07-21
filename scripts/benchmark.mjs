#!/usr/bin/env node
// Fixture-driven compression benchmark. This is intentionally dependency-free so the
// README table can be regenerated anywhere the hooks run.
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { compressBashOutput } from './lib/pipeline.mjs';
import { compressCommandOutput } from './lib/cmd-compressors/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = join(root, 'tests', 'fixtures', 'bash');

// Keep fixture commands explicit: dispatch is part of what this benchmark measures,
// rather than guessing a command from output which would hide coverage regressions.
export const FIXTURE_COMMANDS = Object.freeze({
  'cargo-build.txt': 'cargo build',
  'docker-ps.txt': 'docker ps',
  'docker-pull.txt': 'docker pull nginx:latest',
  'eslint.txt': 'eslint src',
  'git-diff.txt': 'git diff',
  'git-log.txt': 'git log --oneline',
  'git-status-porcelain.txt': 'git status --porcelain=v1 -b',
  'go-test-json.txt': 'go test -json ./...',
  'npm-install.txt': 'npm install',
  'npm-test-failing.txt': 'npm test',
  'pytest-failing.txt': 'pytest',
  'pytest-passing.txt': 'pytest',
  'stacktrace-repeat.txt': 'node script.mjs',
  'tsc.txt': 'tsc --noEmit',
  'webpack-build.txt': 'webpack',
});

function bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function reduction(bytesIn, bytesOut) {
  return bytesIn === 0 ? 0 : (1 - bytesOut / bytesIn) * 100;
}

function displayReduction(value) {
  // Avoid a surprising negative zero for fixtures that are exactly unchanged.
  return `${Math.max(0, value).toFixed(1)}%`;
}

/** Run the same command-aware dispatch then generic fallback used by Bash. */
export function dispatchFixture(text, command) {
  const specialized = compressCommandOutput(text, command);
  if (specialized) {
    return {
      text: specialized.text,
      rulesApplied: specialized.rulesApplied,
      dispatch: 'command',
    };
  }
  const generic = compressBashOutput(text);
  return {
    text: generic.text,
    rulesApplied: generic.stats.rulesApplied,
    dispatch: 'generic',
  };
}

export function benchmarkFixtures(directory = fixtureDirectory) {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.txt'))
    .sort((a, b) => a.localeCompare(b));
  return names.map((name) => {
    const input = readFileSync(join(directory, name), 'utf8');
    const command = FIXTURE_COMMANDS[name] || '';
    const output = dispatchFixture(input, command);
    const bytesIn = bytes(input);
    const bytesOut = bytes(output.text);
    return {
      fixture: name,
      command,
      bytesIn,
      bytesOut,
      reduction: reduction(bytesIn, bytesOut),
      rulesApplied: output.rulesApplied,
      dispatch: output.dispatch,
    };
  });
}

// These tools conventionally send their progress/build stream to stderr. Keeping that
// split makes this exercise the same production gate as the PostToolUse hook.
const STDERR_FIXTURES = new Set(['cargo-build.txt', 'docker-pull.txt']);

function endToEndOutput(name, input, command) {
  const response = STDERR_FIXTURES.has(name) ? { stdout: '', stderr: input } : { stdout: input, stderr: '' };
  const payload = {
    hook_event_name: 'PostToolUse', session_id: 'benchmark-e2e', tool_use_id: name,
    cwd: root, tool_name: 'Bash', tool_input: { command }, tool_response: response,
  };
  const cache = mkdtempSync(join(tmpdir(), 'tokenslim-benchmark-e2e-'));
  try {
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'compress-bash.mjs')], {
      cwd: root, input: JSON.stringify(payload), encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, XDG_CACHE_HOME: cache, TOKENSLIM_TEE_MIN: String(Number.MAX_SAFE_INTEGER) },
    });
    if (result.status !== 0 || !result.stdout) return input;
    const updated = JSON.parse(result.stdout)?.hookSpecificOutput?.updatedToolOutput;
    if (!updated || typeof updated !== 'object') return input;
    return `${updated.stdout || ''}${updated.stderr || ''}`;
  } catch {
    return input;
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

/** Run fixtures through the actual Bash hook, including thresholds and ratio floor. */
export function benchmarkEndToEndFixtures(directory = fixtureDirectory) {
  return benchmarkFixtures(directory).map((result) => {
    const input = readFileSync(join(directory, result.fixture), 'utf8');
    const output = endToEndOutput(result.fixture, input, result.command);
    const bytesIn = bytes(input);
    const bytesOut = bytes(output);
    return { ...result, bytesIn, bytesOut, reduction: reduction(bytesIn, bytesOut) };
  });
}

function markdownCell(value) {
  // Escape backslashes before pipes so an existing backslash cannot neutralize the
  // delimiter escape (CodeQL js/incomplete-sanitization).
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

export function formatMarkdown(results, endToEnd = null) {
  const e2eByFixture = new Map((endToEnd || []).map((result) => [result.fixture, result]));
  const rows = [
    '| Fixture | Pipeline reduction | E2E bytes out | E2E reduction | Rules applied |',
    '| --- | ---: | ---: | ---: | --- |',
    ...results.map((result) => {
      const e2e = e2eByFixture.get(result.fixture);
      return `| ${markdownCell(result.fixture)} | ${displayReduction(result.reduction)} | ${e2e ? e2e.bytesOut : '—'} | ${e2e ? displayReduction(e2e.reduction) : '—'} | ${markdownCell(result.rulesApplied.join(', ') || 'none')} |`;
    }),
  ];
  return rows.join('\n');
}

function pad(value, width, alignRight = false) {
  const text = String(value);
  return alignRight ? text.padStart(width) : text.padEnd(width);
}

export function formatText(results) {
  const rows = results.map((result) => [
    result.fixture,
    result.bytesIn,
    result.bytesOut,
    displayReduction(result.reduction),
    result.rulesApplied.join(', ') || 'none',
  ]);
  const headings = ['Fixture', 'Bytes in', 'Bytes out', 'Reduction', 'Rules applied'];
  const widths = headings.map((heading, column) => Math.max(heading.length, ...rows.map((row) => String(row[column]).length)));
  const render = (row) => row.map((cell, column) => pad(cell, widths[column], column > 0 && column < 4)).join('  ').trimEnd();
  return [render(headings), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(render)].join('\n');
}

function hookPayload(script, largestFixture) {
  const base = { hook_event_name: 'PostToolUse', session_id: 'benchmark', tool_use_id: 'largest-fixture', cwd: root };
  if (script === 'compress-bash.mjs') return { ...base, tool_name: 'Bash', tool_input: { command: 'npm install' }, tool_response: largestFixture };
  if (script === 'compress-read.mjs') return { ...base, tool_name: 'Read', tool_input: { file_path: join(fixtureDirectory, 'npm-install.txt') }, tool_response: largestFixture };
  if (script === 'compress-grep.mjs') return { ...base, tool_name: 'Grep', tool_input: { pattern: 'fixture' }, tool_response: { mode: 'content', content: largestFixture, numLines: largestFixture.split('\n').length } };
  if (script === 'compress-edit.mjs') return { ...base, tool_name: 'Write', tool_input: { file_path: join(fixtureDirectory, 'npm-install.txt') }, tool_response: largestFixture };
  if (script === 'compress-mcp.mjs') return { ...base, tool_name: 'mcp__benchmark', tool_input: {}, tool_response: largestFixture };
  if (script === 'rewrite-bash.mjs') return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm install', benchmark_output: largestFixture } };
  return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(fixtureDirectory, 'npm-install.txt'), benchmark_output: largestFixture } };
}

/** Informational only: a slow machine must not turn benchmark reporting into a failure. */
export function benchmarkHookLatency(largestFixture) {
  const scripts = ['compress-bash.mjs', 'compress-read.mjs', 'compress-edit.mjs', 'compress-mcp.mjs', 'compress-grep.mjs', 'rewrite-bash.mjs', 'guard-read.mjs'];
  const cache = mkdtempSync(join(tmpdir(), 'tokenslim-benchmark-'));
  try {
    return scripts.map((script) => {
      const started = performance.now();
      const result = spawnSync(process.execPath, [join(root, 'scripts', script)], {
        cwd: root,
        input: JSON.stringify(hookPayload(script, largestFixture)),
        encoding: 'utf8',
        env: { ...process.env, XDG_CACHE_HOME: cache, TOKENSLIM_TEE_MIN: String(Number.MAX_SAFE_INTEGER) },
        timeout: 5_000,
      });
      const milliseconds = performance.now() - started;
      return { script, milliseconds, underTarget: milliseconds < 50, status: result.error ? 'error' : (result.status === 0 ? 'ok' : `exit ${result.status}`) };
    });
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

export function formatLatencyMarkdown(latencies) {
  return [
    '## Hook latency (informational; target <50ms on the largest fixture)',
    '',
    '| Hook | Latency | Target | Status |',
    '| --- | ---: | --- | --- |',
    ...latencies.map(({ script, milliseconds, underTarget, status }) => `| ${script} | ${milliseconds.toFixed(1)}ms | ${underTarget ? 'pass' : 'over'} | ${status} |`),
  ].join('\n');
}

export function formatLatencyText(latencies) {
  const headings = ['Hook', 'Latency', 'Target', 'Status'];
  const rows = latencies.map(({ script, milliseconds, underTarget, status }) => [script, `${milliseconds.toFixed(1)}ms`, underTarget ? 'pass' : 'over', status]);
  const widths = headings.map((heading, column) => Math.max(heading.length, ...rows.map((row) => row[column].length)));
  const render = (row) => row.map((cell, column) => pad(cell, widths[column], column === 1)).join('  ').trimEnd();
  return ['Hook latency (informational; target <50ms on the largest fixture)', render(headings), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(render)].join('\n');
}

function usage() {
  return 'Usage: node scripts/benchmark.mjs [--format text|md]';
}

function main(args) {
  let format = 'text';
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.length === 2 && args[0] === '--format' && ['text', 'md'].includes(args[1])) format = args[1];
  else if (args.length > 0) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const results = benchmarkFixtures();
  const endToEnd = benchmarkEndToEndFixtures();
  const largest = results.reduce((current, result) => result.bytesIn > current.bytesIn ? result : current, results[0]);
  const table = format === 'md' ? formatMarkdown(results, endToEnd) : formatText(results);
  const latency = benchmarkHookLatency(readFileSync(join(fixtureDirectory, largest.fixture), 'utf8'));
  const latencyTable = format === 'md' ? formatLatencyMarkdown(latency) : formatLatencyText(latency);
  process.stdout.write(`${table}\n\n${latencyTable}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
