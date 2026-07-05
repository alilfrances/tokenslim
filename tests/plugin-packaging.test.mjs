import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

test('Codex plugin manifest declares required metadata without unsupported hook fields', () => {
  const manifest = readJson('.codex-plugin/plugin.json');

  assert.equal(manifest.name, 'tokenslim');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.ok(manifest.description.includes('Codex'));
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.interface.displayName, 'tokenslim');
  assert.equal(manifest.interface.category, 'Developer Tools');
  assert.ok(manifest.interface.capabilities.includes('Read'));
  assert.ok(manifest.interface.capabilities.includes('Interactive'));
});

test('Codex marketplace points at the plugin root', () => {
  const marketplace = readJson('.agents/plugins/marketplace.json');
  const entry = marketplace.plugins.find((plugin) => plugin.name === 'tokenslim');

  assert.equal(marketplace.name, 'tokenslim');
  assert.ok(entry);
  assert.deepEqual(entry.source, { source: 'local', path: './' });
  assert.equal(entry.policy.installation, 'AVAILABLE');
  assert.equal(entry.policy.authentication, 'ON_INSTALL');
  assert.equal(entry.category, 'Developer Tools');
});

test('hook commands prefer Claude root, then Codex root, then local root', () => {
  const hooks = readJson('hooks/hooks.json');
  const groups = hooks.hooks.PostToolUse.flatMap((group) => group.hooks);
  const env = { ...process.env };
  delete env.PLUGIN_ROOT;
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CODEX_PLUGIN_ROOT;

  for (const hook of groups) {
    assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT:-\$\{PLUGIN_ROOT:-\.\}\}/);
    assert.doesNotMatch(hook.command, /CODEX_PLUGIN_ROOT/);
    const localResult = spawnSync(hook.command, {
      cwd: root,
      env,
      input: 'not json',
      shell: true,
      encoding: 'utf8',
    });
    assert.equal(localResult.status, 0, `${hook.command}\nstderr:\n${localResult.stderr}`);

    const claudeResult = spawnSync(hook.command, {
      cwd: '/tmp',
      env: { ...env, CLAUDE_PLUGIN_ROOT: root, PLUGIN_ROOT: '/tmp/not-tokenslim' },
      input: 'not json',
      shell: true,
      encoding: 'utf8',
    });
    assert.equal(claudeResult.status, 0, `${hook.command}\nstderr:\n${claudeResult.stderr}`);

    const codexResult = spawnSync(hook.command, {
      cwd: '/tmp',
      env: { ...env, PLUGIN_ROOT: root },
      input: 'not json',
      shell: true,
      encoding: 'utf8',
    });
    assert.equal(codexResult.status, 0, `${hook.command}\nstderr:\n${codexResult.stderr}`);
  }
});

test('tokenstats command is Claude/local only, not a Codex slash command', () => {
  const command = readFileSync(join(root, 'commands', 'tokenstats.md'), 'utf8');
  assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT:-\.\}/);
  assert.doesNotMatch(command, /CODEX_PLUGIN_ROOT/);
});
