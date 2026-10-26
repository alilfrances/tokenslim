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
import { compressShapeOutput } from './lib/shape-compressors/index.mjs';
import { loadConfig, loadConfigLayerFile, mergeConfigLayer } from './lib/config.mjs';
import { processBashPayload } from './lib/bash-hook.mjs';
import { commandFamily } from './lib/privacy.mjs';
import { scanTranscripts, transcriptFiles } from './lib/transcripts.mjs';

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

/** Run the same command-aware, shape, then generic dispatch used by Bash. */
export function dispatchFixture(text, command) {
  const specialized = compressCommandOutput(text, command);
  if (specialized) {
    return {
      text: specialized.text,
      rulesApplied: specialized.rulesApplied,
      dispatch: 'command',
    };
  }
  const shaped = compressShapeOutput(text);
  const generic = compressBashOutput(shaped ? shaped.text : text);
  return {
    text: generic.text,
    rulesApplied: [...new Set([...(shaped?.rulesApplied || []), ...generic.stats.rulesApplied])],
    dispatch: shaped ? 'shape' : 'generic',
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
      env: { ...process.env, XDG_CACHE_HOME: cache, XDG_DATA_HOME: cache, TOKENSLIM_TEE_MIN: String(Number.MAX_SAFE_INTEGER) },
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
        env: { ...process.env, XDG_CACHE_HOME: cache, XDG_DATA_HOME: cache, TOKENSLIM_TEE_MIN: String(Number.MAX_SAFE_INTEGER) },
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

const CHARS_PER_TOKEN = 4;
const SKIP_REASONS = ['image', 'persisted', 'alreadyCompressed', 'belowThreshold', 'failure', 'poorRatio', 'disabled', 'error'];
const OUTCOME_SKIP = { skippedBelowThreshold: 'belowThreshold', skippedFailure: 'failure', skippedPoorRatio: 'poorRatio', skippedImage: 'image', disabled: 'disabled' };

// Number of API calls (distinct assistant messages with usage) after line `seq`: calls are in line order.
function callsAfter(calls, seq) {
  let low = 0; let high = calls.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (calls[mid].index <= seq) low = mid + 1; else high = mid;
  }
  return calls.length - low;
}

function bump(map, key, init) {
  let item = map.get(key);
  if (!item) { item = init; map.set(key, item); }
  return item;
}

/**
 * Replay every Bash tool result in the transcripts through the production Bash hook core (dry run: no tee, no ledger).
 * The tee is ASSUMED to succeed (processBashPayload assumeTee) whenever the real tee gates would allow it, because a
 * dry run cannot write and the opt-in output cap (bash.capChars) only applies when a recovery file exists. capExempt
 * counts cap-sized results the cap left alone, by reason (diff, json, boundedRead, noReduction, noTee).
 * Limitations: transcripts merge stdout and stderr into one string and carry no exit code, so the whole text is
 * replayed as stdout and failure detection uses its regex fallback. Image, persisted and already-compressed results
 * are counted but not replayed, so the savings denominator is the chars of results actually replayed.
 */
export function replayTranscripts({ root, sinceDays, config, now = Date.now() }) {
  const files = transcriptFiles({ root, all: true });
  const sinceMs = sinceDays === undefined ? undefined : now - sinceDays * 86400000;
  const skipped = Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0]));
  const rules = new Map(); const families = new Map(); const capExempt = {};
  const total = { scanned: 0, replayed: 0, compressed: 0, charsIn: 0, charsOut: 0, apiCalls: 0, savedTokens: 0, weightedTokens: 0, callsAfterSum: 0 };
  for (const { pairs, calls } of scanTranscripts(files, { sinceMs, tools: ['Bash'] })) {
    total.apiCalls += calls.length;
    for (const pair of pairs) {
      const command = pair.input.command;
      if (typeof command !== 'string') continue;
      total.scanned += 1;
      if (pair.isImage) { skipped.image += 1; continue; }
      if (pair.isPersisted) { skipped.persisted += 1; continue; }
      if (pair.isCompressed) { skipped.alreadyCompressed += 1; continue; }
      total.replayed += 1;
      const charsIn = pair.text.length;
      total.charsIn += charsIn;
      const family = bump(families, commandFamily(command), { family: '', results: 0, compressed: 0, charsIn: 0, charsOut: 0 });
      family.family = commandFamily(command); family.results += 1; family.charsIn += charsIn;
      let result;
      try {
        result = processBashPayload({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: pair.text, stderr: '' } }, { config, dryRun: true, assumeTee: true });
      } catch { skipped.error += 1; total.charsOut += charsIn; family.charsOut += charsIn; continue; }
      if (result.capExempt) capExempt[result.capExempt] = (capExempt[result.capExempt] || 0) + 1;
      let charsOut = charsIn;
      if (result.outcome === 'compressed') {
        charsOut = result.updatedToolOutput.stdout.length + result.updatedToolOutput.stderr.length;
        total.compressed += 1; family.compressed += 1;
        const savedTokens = (charsIn - charsOut) / CHARS_PER_TOKEN;
        const after = callsAfter(calls, pair.seq);
        total.savedTokens += savedTokens; total.weightedTokens += savedTokens * after; total.callsAfterSum += after;
        for (const rule of result.rulesApplied) {
          const row = bump(rules, rule, { rule, results: 0, savedChars: 0 });
          row.results += 1; row.savedChars += charsIn - charsOut;
        }
      } else skipped[OUTCOME_SKIP[result.outcome] || 'error'] += 1;
      total.charsOut += charsOut; family.charsOut += charsOut;
    }
  }
  const savedChars = total.charsIn - total.charsOut;
  const percent = (saved, base) => (base === 0 ? 0 : (saved / base) * 100);
  const by = (a, b) => b.savedChars - a.savedChars || String(a.rule ?? a.family).localeCompare(String(b.rule ?? b.family));
  return {
    transcripts: root, files: files.length, sinceDays: sinceDays ?? null,
    pairsScanned: total.scanned, skipped, replayed: total.replayed, compressed: total.compressed,
    charsIn: total.charsIn, charsOut: total.charsOut, savedChars, savingsPct: percent(savedChars, total.charsIn),
    capExempt,
    byRule: [...rules.values()].sort(by),
    byFamily: [...families.values()].map((f) => ({ ...f, savedChars: f.charsIn - f.charsOut, savingsPct: percent(f.charsIn - f.charsOut, f.charsIn) })).sort(by),
    apiCalls: total.apiCalls,
    costWeighted: { charsPerToken: CHARS_PER_TOKEN, savedTokens: Math.round(total.savedTokens), callsAfterSum: total.callsAfterSum, weightedTokens: Math.round(total.weightedTokens) },
  };
}

const COST_NOTE = `cost-weighted = sum over compressed results of saved tokens x API calls after the result in the same session (tokens = chars/${CHARS_PER_TOKEN}); it is cache-read tokens avoided, so multiply by your cache-read price for dollars`;

function capExemptLine(report) {
  const entries = Object.entries(report.capExempt || {}).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? [`  output cap left alone: ${entries.map(([reason, count]) => `${reason} ${count.toLocaleString('en-US')}`).join(', ')}`] : [];
}

export function formatReplayText(report) {
  const n = (value) => value.toLocaleString('en-US');
  const skipLine = Object.entries(report.skipped).filter(([, count]) => count > 0).map(([reason, count]) => `${reason} ${n(count)}`).join(', ') || 'none';
  return [
    `tokenslim replay: ${n(report.files)} transcript file(s), ${n(report.pairsScanned)} Bash result(s) scanned${report.sinceDays === null ? '' : ` (last ${report.sinceDays} days)`}`,
    `  replayed ${n(report.replayed)}, compressed ${n(report.compressed)}; skipped: ${skipLine}`,
    `  chars in ${n(report.charsIn)}, out ${n(report.charsOut)}, saved ${n(report.savedChars)} = ${report.savingsPct.toFixed(1)}% of all replayed result chars`,
    ...capExemptLine(report),
    '',
    'by rule (a result can have several rules, so rows overlap):',
    ...(report.byRule.length ? report.byRule.map((r) => `  ${r.rule}  ${n(r.results)} result(s), ${n(r.savedChars)} chars saved`) : ['  (none)']),
    '',
    'by command family:',
    ...(report.byFamily.length ? report.byFamily.map((f) => `  ${f.family}  ${n(f.results)} result(s), ${n(f.compressed)} compressed, ${n(f.charsIn)} -> ${n(f.charsOut)} chars (${f.savingsPct.toFixed(1)}% saved)`) : ['  (none)']),
    '',
    `cost-weighted: ${n(report.costWeighted.savedTokens)} tokens saved x later API calls = ${n(report.costWeighted.weightedTokens)} token-reads (${n(report.apiCalls)} API calls seen)`,
    `  ${COST_NOTE}`,
  ].join('\n');
}

export function formatReplayMarkdown(report) {
  const n = (value) => value.toLocaleString('en-US');
  return [
    `## Transcript replay (${n(report.files)} files, ${n(report.pairsScanned)} Bash results scanned)`,
    '',
    `Replayed ${n(report.replayed)}, compressed ${n(report.compressed)}. Chars in ${n(report.charsIn)}, out ${n(report.charsOut)}: **${report.savingsPct.toFixed(1)}%** of all replayed result chars.`,
    '',
    ...capExemptLine(report).flatMap((line) => [`${line.trim()}.`, '']),
    '| Skipped | Count |', '| --- | ---: |',
    ...Object.entries(report.skipped).map(([reason, count]) => `| ${reason} | ${n(count)} |`),
    '',
    '| Rule | Results | Chars saved |', '| --- | ---: | ---: |',
    ...report.byRule.map((r) => `| ${markdownCell(r.rule)} | ${n(r.results)} | ${n(r.savedChars)} |`),
    '',
    '| Command family | Results | Compressed | Chars in | Chars out | Saved |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.byFamily.map((f) => `| ${markdownCell(f.family)} | ${n(f.results)} | ${n(f.compressed)} | ${n(f.charsIn)} | ${n(f.charsOut)} | ${f.savingsPct.toFixed(1)}% |`),
    '',
    `Cost-weighted: ${n(report.costWeighted.savedTokens)} tokens saved x later API calls = **${n(report.costWeighted.weightedTokens)}** token-reads (${n(report.apiCalls)} API calls seen). ${COST_NOTE}.`,
  ].join('\n');
}

function usage() {
  return [
    'Usage: node scripts/benchmark.mjs [--format text|md]',
    '       node scripts/benchmark.mjs --transcripts <dir> [--since <days>] [--format text|json|md] [--config <path>]',
  ].join('\n');
}

// Accepts `--flag value` and `--flag=value`; returns null on any unknown, repeated or incomplete argument.
function parseArgs(args) {
  const options = { format: 'text', transcripts: null, since: undefined, config: null, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = args[i].startsWith('--') && args[i].includes('=') ? [args[i].slice(0, args[i].indexOf('=')), args[i].slice(args[i].indexOf('=') + 1)] : [args[i], undefined];
    if (flag === '--help' && inline === undefined) { options.help = true; continue; }
    if (!['--format', '--transcripts', '--since', '--config'].includes(flag) || seen.has(flag)) return null;
    seen.add(flag);
    const value = inline ?? args[++i];
    if (value === undefined || value === '') return null;
    if (flag === '--format') { if (!['text', 'json', 'md'].includes(value)) return null; options.format = value; }
    else if (flag === '--since') { if (!/^\d+$/.test(value)) return null; options.since = Number(value); }
    else options[flag.slice(2)] = value;
  }
  if (options.help) return args.length === 1 ? options : null;
  if (!options.transcripts && (options.format === 'json' || seen.has('--since') || seen.has('--config'))) return null;
  return options;
}

function main(args) {
  const options = parseArgs(args);
  if (!options) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.transcripts) {
    let config;
    try {
      config = loadConfig(process.cwd(), process.env);
      if (options.config) config = mergeConfigLayer(config, loadConfigLayerFile(resolve(options.config)));
    } catch (error) {
      process.stderr.write(`benchmark: cannot load --config: ${error instanceof Error ? error.message : error}\n`);
      return 2;
    }
    const report = replayTranscripts({ root: resolve(options.transcripts), sinceDays: options.since, config });
    process.stdout.write(`${options.format === 'json' ? JSON.stringify(report) : options.format === 'md' ? formatReplayMarkdown(report) : formatReplayText(report)}\n`);
    return 0;
  }
  const format = options.format;

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
