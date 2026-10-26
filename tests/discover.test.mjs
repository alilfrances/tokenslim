import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedEnv } from './helpers.mjs';

const root = join(import.meta.dirname, '..');
const fixtureRoot = join(root, 'tests', 'fixtures', 'transcripts');
function run(args = [], env = {}) {
  const iso = isolatedEnv({ TOKENSLIM_TRANSCRIPTS_DIR: fixtureRoot, ...env });
  try { return spawnSync('node', ['scripts/discover.mjs', ...args], { cwd: root, env: iso.env, encoding: 'utf8' }); } finally { iso.cleanup(); }
}

test('discover ranks uncompressed sinks and reports missed rewrite opportunities', () => {
  const result = run(['--format', 'json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scannedFiles, 1);
  assert.equal(report.sinks[0].command, 'npm install');
  assert.ok(report.rewriteOpportunities.some((row) => row.command === 'npm install'));
  assert.ok(report.rewriteOpportunities.some((row) => row.command === 'git status'));
  assert.ok(report.commandFamilies.some((row) => row.command === 'npm install'));
});

test('discover reports command families without transcript credentials or arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-private-transcripts-'));
  try {
    writeFileSync(join(dir, 'session.jsonl'), [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'private', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer super-secret" https://example.invalid/?token=secret' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'private', content: 'large uncompressed output' }] } }),
    ].join('\n'));
    const result = run(['--format', 'json'], { TOKENSLIM_TRANSCRIPTS_DIR: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).sinks[0].command, 'curl');
    assert.doesNotMatch(result.stdout, /super-secret|example\.invalid|token=secret/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('discover handles an absent transcript directory gracefully', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-empty-transcripts-'));
  try {
    const result = run([], { TOKENSLIM_TRANSCRIPTS_DIR: join(dir, 'missing') });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no transcripts found/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function transcriptDir(results) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-marker-transcripts-'));
  const uses = results.map(([id, command]) => ({ type: 'tool_use', id, name: 'Bash', input: { command } }));
  writeFileSync(join(dir, 'session.jsonl'), [
    JSON.stringify({ type: 'assistant', message: { content: uses } }),
    JSON.stringify({ type: 'user', message: { content: results.map(([id, , output]) => ({ type: 'tool_result', tool_use_id: id, content: output })) } }),
  ].join('\n'));
  return dir;
}

test('discover splits a single whitespace-joined argument as slash commands pass it', () => {
  const result = run(['--since 3650 --all --format json --limit 1']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scannedFiles, 1);
  assert.equal(report.sinceDays, 3650);
  assert.equal(report.limit, 1);
  assert.equal(report.sinks.length, 1);
});

test('discover counts output that quotes the marker mid-text as an uncompressed sink', () => {
  const dir = transcriptDir([
    ['quoted', 'cat src.mjs', 'const m = "[tokenslim: collapseRepeatedLines]";\nmore source after the quote\n'],
    ['done', 'npm install', 'added 4 packages\n[tokenslim: packageManagerSummary]'],
    ['teed', 'pytest', 'dots\n[tokenslim: full: /home/u/.cache/tokenslim/tee/x.txt]\n'],
  ]);
  try {
    const report = JSON.parse(run(['--format', 'json'], { TOKENSLIM_TRANSCRIPTS_DIR: dir }).stdout);
    assert.equal(report.pairs, 3);
    assert.deepEqual(report.sinks.map((row) => row.command), ['cat']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('discover reports real failures as errors, not as missing transcripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-broken-transcripts-'));
  try {
    // Nesting deep enough to overflow the block walker; JSON.parse itself accepts it.
    writeFileSync(join(dir, 'deep.jsonl'), `${'['.repeat(200000)}${']'.repeat(200000)}\n`);
    const text = run([], { TOKENSLIM_TRANSCRIPTS_DIR: dir });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^tokenslim discover: error: \S/);
    assert.doesNotMatch(text.stdout, /no transcripts found/);
    const json = run(['--format', 'json'], { TOKENSLIM_TRANSCRIPTS_DIR: dir });
    assert.equal(json.status, 0, json.stderr);
    assert.ok(JSON.parse(json.stdout).error);
    assert.notEqual(JSON.parse(json.stdout).error, 'no transcripts found');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
