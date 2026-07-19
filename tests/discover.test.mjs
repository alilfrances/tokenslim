import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dirname, '..');
const fixtureRoot = join(root, 'tests', 'fixtures', 'transcripts');
function run(args = [], env = {}) { return spawnSync('node', ['scripts/discover.mjs', ...args], { cwd: root, env: { ...process.env, TOKENSLIM_TRANSCRIPTS_DIR: fixtureRoot, ...env }, encoding: 'utf8' }); }

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
