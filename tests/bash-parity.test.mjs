// WP4 safety net: with the default config (capChars 0) the Bash hook must stay byte-identical to the behavior
// recorded before the mid-band cap existed. Snapshot = sha256 + length of every outcome, per fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_COMMANDS } from '../scripts/benchmark.mjs';
import { processBashPayload } from '../scripts/lib/bash-hook.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { isolatedEnv } from './helpers.mjs';

const root = join(import.meta.dirname, '..');
const snapshotPath = join(root, 'tests', 'fixtures', 'parity', 'bash-default.json');
const read = (...parts) => readFileSync(join(root, 'tests', 'fixtures', ...parts), 'utf8');

function cases() {
  const out = [];
  for (const name of readdirSync(join(root, 'tests', 'fixtures', 'bash')).filter((n) => n.endsWith('.txt')).sort()) {
    out.push({ id: `bash/${name}`, command: FIXTURE_COMMANDS[name], stdout: read('bash', name), stderr: '' });
  }
  for (const name of readdirSync(join(root, 'tests', 'fixtures', 'shape')).filter((n) => n.endsWith('.txt')).sort()) {
    out.push({ id: `shape/${name}`, command: 'grep -rn foo .', stdout: read('shape', name), stderr: '' });
  }
  // Mid-band (below the generic 40000 cap) and above it, so the untouched generic truncation path is covered.
  const unique = (count) => Array.from({ length: count }, (_, i) => `line ${i} payload ${(i * 2654435761 % 1e9).toString(36)} ${'x'.repeat(i % 17)}`).join('\n');
  out.push({ id: 'synthetic/mid-band-20k', command: 'cat big.txt', stdout: unique(500), stderr: '' });
  out.push({ id: 'synthetic/above-40k', command: 'cat huge.txt', stdout: unique(2500), stderr: '' });
  out.push({ id: 'synthetic/head-pipe', command: 'cat big.txt | head -n 400', stdout: unique(500), stderr: '' });
  out.push({ id: 'synthetic/stderr', command: 'make', stdout: unique(300), stderr: `warn\n${unique(80)}` });
  return out;
}

// dryRun and a real run (tee written, TOKENSLIM_TEE_MIN=0 so every lossy result is teed). The real run's tee path
// differs per temp dir, so it is normalized to <tee>.
function snapshot() {
  const result = {};
  for (const c of cases()) {
    for (const dryRun of [true, false]) {
      const iso = isolatedEnv(dryRun ? {} : { TOKENSLIM_TEE_MIN: '0' });
      try {
        const config = loadConfig(root, iso.env);
        const r = processBashPayload(
          { session_id: 's', tool_use_id: 't', tool_input: { command: c.command }, tool_response: { stdout: c.stdout, stderr: c.stderr } },
          { config, env: iso.env, dryRun },
        );
        const normalize = (text) => (r.recoveryPath ? text.split(r.recoveryPath).join('<tee>') : text);
        const body = normalize(JSON.stringify(r.updatedToolOutput));
        result[`${c.id}${dryRun ? '' : ' (tee)'}`] = {
          outcome: r.outcome, rulesApplied: r.rulesApplied, bytesIn: r.bytesIn,
          bytesOut: r.bytesOut - (r.recoveryPath ? Buffer.byteLength(r.recoveryPath) - '<tee>'.length : 0),
          recoveryPath: r.recoveryPath ? '<tee>' : null,
          sha256: createHash('sha256').update(body).digest('hex'),
        };
      } finally { iso.cleanup(); }
    }
  }
  return result;
}

test('capChars 0 (default) is byte-identical to the pre-WP4 hook on every fixture', () => {
  const actual = snapshot();
  if (process.env.TOKENSLIM_UPDATE_PARITY === '1') writeFileSync(snapshotPath, `${JSON.stringify(actual, null, 2)}\n`);
  const expected = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const id of Object.keys(expected)) assert.deepEqual(actual[id], expected[id], id);
});
