import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCommand } from '../scripts/lib/rewrite-rules.mjs';

const config = { rewrite: { enabled: true, exclude: [] } };
const cases = [
  ['npm install', 'npm install --loglevel=error --no-fund --no-audit'],
  ['npm ci', 'npm ci --loglevel=error --no-fund --no-audit'],
  ['pip install requests', 'pip install requests -q'],
  ['cargo build', 'cargo build --quiet'],
  ['cargo check', 'cargo check --quiet'],
  ['cargo test', 'cargo test --quiet'],
  ['pytest tests', 'pytest tests -q'],
  ['git status', 'git status --porcelain=v1 -b'],
  ['mvn test', 'mvn test -q'],
  ['gradle test', 'gradle test -q'],
];
for (const [input, output] of cases) test(`rewrites ${input}`, () => assert.equal(rewriteCommand(input, config)?.command, output));

test('docker build is opt-in', () => {
  assert.equal(rewriteCommand('docker build .', config), null);
  assert.equal(rewriteCommand('docker build .', { rewrite: { dockerBuild: true } })?.command, 'docker build . --quiet');
});

test('guards unsafe syntax, explicit verbosity, exclusions, and disabled rewrite', () => {
  for (const input of ['npm install && echo ok', 'npm install; echo ok', 'npm install | tee x', 'npm install >x', 'npm install &', 'npm install <<EOF', 'npm install $(echo x)', 'npm install --verbose', 'npm install -vv', 'npm install --loglevel=warn']) assert.equal(rewriteCommand(input, config), null, input);
  assert.equal(rewriteCommand('npm ci', { rewrite: { exclude: ['npm ci'] } }), null);
  assert.equal(rewriteCommand('npm ci', { rewrite: { enabled: false } }), null);
});

test('is idempotent and never changes the binary token', () => {
  for (const [input] of cases) {
    const once = rewriteCommand(input, config);
    assert.ok(once);
    assert.equal(rewriteCommand(once.command, config), null);
    assert.equal(once.command.split(/\s+/)[0], input.split(/\s+/)[0]);
  }
  assert.equal(rewriteCommand('pytest -qq', config), null);
});
