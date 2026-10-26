import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_COMMANDS,
  benchmarkFixtures,
  benchmarkEndToEndFixtures,
  dispatchFixture,
  formatMarkdown,
  formatText,
} from '../scripts/benchmark.mjs';
import { processBashPayload } from '../scripts/lib/bash-hook.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { isolatedEnv } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = join(root, 'tests', 'fixtures', 'bash');

test('benchmark covers every bash fixture with byte metrics and rules', () => {
  const fixtureNames = readdirSync(fixtureDirectory).filter((name) => name.endsWith('.txt')).sort();
  const results = benchmarkFixtures();
  assert.deepEqual(results.map((result) => result.fixture), fixtureNames);
  assert.deepEqual(Object.keys(FIXTURE_COMMANDS).sort(), fixtureNames);
  for (const result of results) {
    assert.ok(result.bytesIn > 0, `${result.fixture} has input bytes`);
    assert.ok(result.bytesOut >= 0, `${result.fixture} has output bytes`);
    assert.ok(Number.isFinite(result.reduction), `${result.fixture} has a reduction`);
    assert.ok(Array.isArray(result.rulesApplied), `${result.fixture} reports rules`);
  }
});

test('benchmark formats README-ready markdown and readable text tables', () => {
  const results = benchmarkFixtures();
  const markdown = formatMarkdown(results);
  assert.match(markdown, /^\| Fixture \| Pipeline reduction \| E2E bytes out \| E2E reduction \| Rules applied \|$/m);
  assert.match(markdown, /^\| --- \| ---: \| ---: \| ---: \| --- \|$/m);
  for (const { fixture } of results) assert.match(markdown, new RegExp(`\\| ${fixture.replace('.', '\\.') } \\|`));
  assert.match(formatText(results), /^Fixture\s+Bytes in\s+Bytes out\s+Reduction\s+Rules applied/m);
});

test('benchmark markdown escapes existing backslashes before table delimiters', () => {
  const markdown = formatMarkdown([{
    fixture: 'a\\|b\nc',
    bytesIn: 1,
    bytesOut: 1,
    reduction: 0,
    rulesApplied: ['rule\\|name'],
  }]);
  const row = markdown.split('\n')[2];
  assert.equal(row.slice(2, row.indexOf(' |', 2)), String.raw`a\\\|b<br>c`);
  assert.match(row, /rule\\\\\\\|name/);
});

test('README savings table is synchronized with the generated benchmark', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const start = readme.indexOf('| Fixture | Pipeline reduction | E2E bytes out | E2E reduction | Rules applied |');
  const end = readme.indexOf('\n\nRe-read stubs', start);
  assert.ok(start >= 0 && end > start, 'README fixture table boundaries exist');
  assert.equal(readme.slice(start, end), formatMarkdown(benchmarkFixtures(), benchmarkEndToEndFixtures()));
});

test('end-to-end benchmark applies production Bash gates', () => {
  const pipeline = benchmarkFixtures();
  const e2e = benchmarkEndToEndFixtures();
  const byFixture = new Map(pipeline.map((result) => [result.fixture, result]));
  assert.equal(e2e.length, pipeline.length);
  // stderr-carried cargo output must still compress through the real hook (WP6).
  assert.ok(e2e.find((result) => result.fixture === 'cargo-build.txt').reduction > 0);
  // A stdout-only fixture should stay broadly comparable after marker overhead.
  const npm = e2e.find((result) => result.fixture === 'npm-install.txt');
  assert.ok(Math.abs(npm.reduction - byFixture.get('npm-install.txt').reduction) < 10);
});

test('dispatch uses command compression when available and generic fallback otherwise', () => {
  assert.equal(dispatchFixture('{"Action":"pass","Test":"one","Package":"example"}', 'go test -json ./...').dispatch, 'command');
  assert.equal(dispatchFixture('repeat 1\nrepeat 2\nrepeat 3', 'unknown command').dispatch, 'generic');
});

// --- WP1: offline transcript replay and hook-core parity ---
const replayDirectory = join(root, 'tests', 'fixtures', 'replay');
function benchmark(args, extraEnv = {}) {
  const iso = isolatedEnv(extraEnv);
  try { return spawnSync(process.execPath, [join(root, 'scripts', 'benchmark.mjs'), ...args], { cwd: root, env: iso.env, encoding: 'utf8' }); } finally { iso.cleanup(); }
}

test('replay counts every skip reason and compressed result in the fixture transcript exactly', () => {
  const run = benchmark(['--transcripts', replayDirectory, '--since', '3650', '--format', 'json']);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.files, 1);
  // 8 distinct Bash tool_use ids; the duplicated t-dup id is counted once.
  assert.equal(report.pairsScanned, 8);
  assert.deepEqual(report.skipped, { image: 1, persisted: 1, alreadyCompressed: 2, belowThreshold: 0, failure: 0, poorRatio: 1, disabled: 0, error: 0 });
  assert.equal(report.replayed, 4);
  assert.equal(report.compressed, 3);
  assert.ok(report.charsOut < report.charsIn);
  assert.equal(report.savedChars, report.charsIn - report.charsOut);
  assert.ok(Math.abs(report.savingsPct - (report.savedChars / report.charsIn) * 100) < 1e-9);
  // msg_1 (split over two lines) .. msg_4 (streamed twice) are 4 calls; the usage-less line is not one.
  assert.equal(report.apiCalls, 4);
  // t-comp is followed by msg_2..msg_4 (3 calls), t-dup by msg_3, msg_4 (2), t-mid by msg_4 (1).
  assert.equal(report.costWeighted.callsAfterSum, 6);
  assert.equal(report.costWeighted.charsPerToken, 4);
  assert.ok(report.costWeighted.weightedTokens > report.costWeighted.savedTokens);
  assert.ok(report.costWeighted.weightedTokens <= 3 * report.costWeighted.savedTokens);
  assert.deepEqual(report.byFamily.map((f) => [f.family, f.results, f.compressed]).sort(), [['cat', 2, 1], ['make', 2, 2]]);
  assert.ok(report.byRule.some((r) => r.rule === 'collapseRepeatedLines' && r.results === 3));
  assert.ok(report.byRule.every((r) => r.savedChars <= report.savedChars));
});

test('replay text and markdown output state the denominator, breakdowns and the cost-weighting ratio', () => {
  const text = benchmark(['--transcripts', replayDirectory]).stdout;
  assert.match(text, /8 Bash result\(s\) scanned/);
  assert.match(text, /skipped: image 1, persisted 1, alreadyCompressed 2, poorRatio 1/);
  assert.match(text, /% of all replayed result chars/);
  assert.match(text, /by rule/);
  assert.match(text, /by command family:\n  make /);
  assert.match(text, /cost-weighted:.*API calls after the result.*chars\/4/s);
  const md = benchmark(['--transcripts', replayDirectory, '--format', 'md']).stdout;
  assert.match(md, /^\| Skipped \| Count \|$/m);
  assert.match(md, /^\| Command family \| Results /m);
});

test('replay --config layers an explicit config over the defaults and validates it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-replay-config-'));
  try {
    writeFileSync(join(dir, 'high-threshold.json'), JSON.stringify({ minChars: 100000 }));
    const report = JSON.parse(benchmark(['--transcripts', replayDirectory, '--config', join(dir, 'high-threshold.json'), '--format', 'json']).stdout);
    assert.equal(report.compressed, 0);
    assert.equal(report.skipped.belowThreshold, 4);
    writeFileSync(join(dir, 'bad.json'), '{nope');
    for (const path of [join(dir, 'bad.json'), join(dir, 'missing.json')]) {
      const run = benchmark(['--transcripts', replayDirectory, '--config', path]);
      assert.equal(run.status, 2);
      assert.match(run.stderr, /cannot load --config/);
      assert.equal(run.stdout, '');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('benchmark rejects unknown, repeated and incomplete arguments with usage on stderr and exit 2', () => {
  for (const args of [['--bogus'], ['--transcripts'], ['--transcripts', replayDirectory, '--since', 'x'], ['--transcripts', replayDirectory, '--format', 'xml'],
    ['--format', 'json'], ['--since', '3'], ['--config', 'x.json'], ['--format', 'md', '--format', 'text'], ['stray']]) {
    const run = benchmark(args);
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /^Usage: node scripts\/benchmark\.mjs/);
    assert.equal(run.stdout, '', args.join(' '));
  }
  assert.equal(benchmark(['--help']).status, 0);
  assert.equal(benchmark([`--transcripts=${replayDirectory}`, '--format=json']).status, 0);
});

test('replay of an empty or missing transcript directory reports zeros', () => {
  const report = JSON.parse(benchmark(['--transcripts', join(tmpdir(), 'tokenslim-no-such-dir'), '--format', 'json']).stdout);
  assert.equal(report.pairsScanned, 0);
  assert.equal(report.savingsPct, 0);
});

test('processBashPayload matches the spawned hook for every bash fixture', () => {
  const iso = isolatedEnv({ TOKENSLIM_TEE_MIN: String(Number.MAX_SAFE_INTEGER) });
  const stderrFixtures = new Set(['cargo-build.txt', 'docker-pull.txt']);
  const config = loadConfig(root, iso.env);
  let compressedCount = 0;
  try {
    for (const [name, command] of Object.entries(FIXTURE_COMMANDS)) {
      const input = readFileSync(join(fixtureDirectory, name), 'utf8');
      for (const response of [{ stdout: input, stderr: '' }, ...(stderrFixtures.has(name) ? [{ stdout: '', stderr: input }] : [])]) {
        const payload = { hook_event_name: 'PostToolUse', session_id: 'parity', tool_use_id: name, cwd: root, tool_name: 'Bash', tool_input: { command }, tool_response: response };
        const spawned = spawnSync(process.execPath, [join(root, 'scripts', 'compress-bash.mjs')], { cwd: root, input: JSON.stringify(payload), encoding: 'utf8', env: iso.env });
        assert.equal(spawned.status, 0, spawned.stderr);
        const hookOutput = spawned.stdout ? JSON.parse(spawned.stdout)?.hookSpecificOutput?.updatedToolOutput ?? null : null;
        const core = processBashPayload(payload, { config, env: iso.env, dryRun: true });
        assert.deepEqual(core.updatedToolOutput === null ? null : JSON.parse(JSON.stringify(core.updatedToolOutput)), hookOutput, name);
        assert.equal(core.recoveryPath, null);
        if (core.outcome === 'compressed') compressedCount += 1;
        else assert.equal(core.bytesOut, core.bytesIn);
      }
    }
    assert.ok(compressedCount >= 8, `expected most fixtures to compress, got ${compressedCount}`);
  } finally { iso.cleanup(); }
});

test('processBashPayload dryRun never tees; a real run does, and each outcome is reported', () => {
  const iso = isolatedEnv({ TOKENSLIM_TEE_MIN: '0' });
  try {
    const config = loadConfig(root, iso.env);
    const body = Array.from({ length: 12 }, (_, i) => `distinct line number ${i} about ${'xyz'.repeat(i + 1)}`).join('\n') + '\n'
      + Array.from({ length: 80 }, (_, i) => `step ${i}: compiling module and linking objects`).join('\n');
    const payload = (response, command = 'make', extra = {}) => ({ session_id: 'dry', tool_use_id: 'tu', tool_input: { command }, tool_response: response, ...extra });
    const dry = processBashPayload(payload({ stdout: body, stderr: '' }), { config, env: iso.env, dryRun: true });
    assert.equal(dry.outcome, 'compressed');
    assert.equal(dry.recoveryPath, null);
    assert.deepEqual(listDirSafe(iso.env.XDG_CACHE_HOME), []);
    const real = processBashPayload(payload({ stdout: body, stderr: '' }), { config, env: iso.env });
    assert.ok(real.recoveryPath && real.recoveryPath.startsWith(iso.env.XDG_CACHE_HOME));
    assert.match(real.updatedToolOutput.stdout, /\[tokenslim: full: .*\]$/);
    assert.ok(real.bytesOut < real.bytesIn);
    assert.ok(real.rulesApplied.includes('collapseRepeatedLines'));
    assert.equal(processBashPayload(payload(body), { config, env: iso.env, dryRun: true }).updatedToolOutput.includes('[tokenslim:'), true);
    const outcome = (response, cfg = config, command) => processBashPayload(payload(response, command), { config: cfg, env: iso.env, dryRun: true }).outcome;
    assert.equal(outcome({ stdout: 'tiny', stderr: '' }), 'skippedBelowThreshold');
    assert.equal(outcome({ stdout: body, stderr: '', isImage: true }), 'skippedImage');
    assert.equal(outcome({ stdout: body, stderr: '', persistedOutputPath: '/x/tool-results/a.txt', persistedOutputSize: 60001 }), 'skippedPersisted');
    assert.equal(outcome({ stdout: body, stderr: '', exitCode: 1 }), 'skippedFailure');
    assert.equal(outcome({ stdout: body, stderr: '' }, { ...config, disable: ['bash'] }), 'disabled');
    const unique = Array.from({ length: 24 }, (_, i) => `entry ${i}: ${(i * 2654435761 >>> 0).toString(16)}-${(i * 40503 + 7).toString(36)} unique payload row ${i * 17}`).join('\n');
    assert.equal(outcome({ stdout: unique, stderr: '' }), 'skippedPoorRatio');
  } finally { iso.cleanup(); }
});

function listDirSafe(path) {
  try { return readdirSync(path); } catch { return []; }
}

test('replay handles 10k Bash pairs in under 30 seconds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-replay-10k-'));
  try {
    mkdirSync(join(dir, 'proj'));
    // Distinct lines keep the output above the pipeline's 10% retention floor, so the long run still compresses.
    const noisy = [...Array.from({ length: 12 }, (_, i) => `stage ${'abcdefghijkl'[i].repeat(5)} finished without warnings`), ...Array.from({ length: 40 }, (_, i) => `step ${i}: compiling module and linking objects`)].join('\n');
    const lines = [];
    for (let i = 0; i < 10000; i += 1) {
      lines.push(JSON.stringify({ type: 'assistant', message: { id: `m${i}`, usage: {}, content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: i % 2 ? 'make' : 'npm test' } }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: i % 3 ? `${noisy}\nrun ${i}` : `short ${i}` }] } }));
    }
    writeFileSync(join(dir, 'proj', 'big.jsonl'), lines.join('\n'));
    const started = Date.now();
    const run = benchmark(['--transcripts', dir, '--format', 'json']);
    const seconds = (Date.now() - started) / 1000;
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.pairsScanned, 10000);
    assert.equal(report.apiCalls, 10000);
    assert.ok(report.compressed > 6000);
    assert.ok(seconds < 30, `replay took ${seconds}s`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
