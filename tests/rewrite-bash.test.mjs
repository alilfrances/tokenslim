import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteCommand } from '../scripts/lib/rewrite-rules.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/rewrite-bash.mjs');
function run(payload, env = {}) {
  return spawnSync('node', [script], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
}
function payload(command, extra = {}) { return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'install' }, ...extra }; }

test('Claude rewrite uses updatedInput and preserves existing input', () => {
  const output = JSON.parse(run(payload('npm ci'), { TOKENSLIM_HOOK_RUNTIME: 'claude' }).stdout);
  assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'tokenslim quiet-rewrite: npm-quiet', updatedInput: { command: 'npm ci --loglevel=error --no-fund --no-audit', description: 'install' } } });
});

test('Codex receives an advisory unless explicitly enabled', () => {
  const codex = payload('pytest tests', { turn_id: 'turn' });
  const advisory = JSON.parse(run(codex).stdout);
  assert.equal(advisory.hookSpecificOutput.additionalContext, '[tokenslim] Suggested quieter Bash command: pytest tests -q');
  const forced = JSON.parse(run(codex, { TOKENSLIM_REWRITE_CODEX: '1' }).stdout);
  assert.equal(forced.hookSpecificOutput.updatedInput.command, 'pytest tests -q');
});

test('version flags and Maven test summaries are not rewritten', () => {
  assert.match(rewriteCommand('npm install -version')?.command, /--loglevel=error/, '-version is not mistaken for verbose');
  assert.equal(rewriteCommand('mvn test'), null, 'Maven summary remains visible');
  assert.equal(rewriteCommand('gradle test')?.command, 'gradle test -q');
});

test('disable, no-op, and malformed input are silent and fail open', () => {
  assert.equal(run(payload('npm ci'), { TOKENSLIM_DISABLE: 'rewrite' }).stdout, '');
  assert.equal(run(payload('echo hello')).stdout, '');
  const malformed = run('not json');
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, '');
});
