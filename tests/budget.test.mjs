import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedEnv } from './helpers.mjs';
import { skillSizes } from '../scripts/lib/budget.mjs';

const root = join(import.meta.dirname, '..');
const fixtureDir = join(root, 'tests', 'fixtures', 'budget');

// Temp HOME + project so the audit never sees the real ~/.claude, with a snapshot to prove nothing is written.
function sandbox(t, { userSettings, projectSettings, localSettings, mcpJson } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'tokenslim-budget-'));
  const home = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(project, '.claude'), { recursive: true });
  const put = (path, value) => value !== undefined && writeFileSync(path, JSON.stringify(value));
  put(join(home, '.claude', 'settings.json'), userSettings);
  put(join(project, '.claude', 'settings.json'), projectSettings);
  put(join(project, '.claude', 'settings.local.json'), localSettings);
  put(join(project, '.mcp.json'), mcpJson);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, home, project };
}

function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { out[path + '/'] = true; walk(path); } else out[path] = [statSync(path).mtimeMs, createHash('sha256').update(readFileSync(path)).digest('hex')];
    }
  };
  walk(dir);
  return out;
}

function run(t, box, args, { transcripts = fixtureDir, env = {} } = {}) {
  const iso = isolatedEnv({ HOME: box.home, TOKENSLIM_TRANSCRIPTS_DIR: transcripts, ...env });
  t.after(iso.cleanup);
  return spawnSync(process.execPath, [join(root, 'scripts', 'budget.mjs'), '--project', box.project, ...args], { cwd: root, env: iso.env, encoding: 'utf8' });
}

const json = (result) => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
const row = (report, kind, name) => report.rows.find((r) => r.kind === kind && r.name === name);

test('budget weights each item by the deduplicated API calls that carried it', (t) => {
  const box = sandbox(t);
  const report = json(run(t, box, ['--since', '3650', '--min-tokens', '100', '--format', 'json']));

  // The fixture has 5 distinct message ids (m1 and m4 stream over two lines) and each call reads 1000 input tokens.
  assert.equal(report.scannedFiles, 1);
  assert.equal(report.apiCalls, 5);
  assert.equal(report.totalInputTokens, 5000);

  const weights = Object.fromEntries(report.rows.map((r) => [`${r.kind}:${r.name}`, r.weightedTokens]));
  const mystery = JSON.stringify({ type: 'mystery_thing', foo: 'SECRET-MYSTERY'.repeat(3) }).length;
  assert.deepEqual(weights, {
    // 10/20/30-token skill entries (40/80/120 chars) x 5 calls; the plugin adds a 25-token agent x 5.
    'skill:alpha': 50, 'skill:beta': 100, 'plugin:acme': 150 + 125,
    // alpha_srv: 100-token instructions + 10-token tool line, all 5 calls. beta_srv: (200 + 20) tokens, removed before the 3rd call.
    'mcp:alpha_srv': 550, 'mcp:beta_srv': 440,
    'builtin:built-in tools (not prunable)': 25, 'builtin:built-in agents (not prunable)': 75,
    'agent:mine': 50,
    // Attachments after the 1st / 3rd / 4th call reach 4 / 3 / 2 calls.
    'hook:SessionStart:acme': 200, 'memory:/proj/CLAUDE.md': 120, 'hook:PostToolUse:other': 50,
    // Unknown type by JSON size, plus the date attachment by its 40 rendered chars; prompt_snapshot is excluded entirely.
    'other:other attachments (not prunable)': Math.round(((mystery + 40) * 5) / 4),
  });
  assert.deepEqual(report.otherTypes, { date: 1, mystery_thing: 1 });

  assert.equal(row(report, 'mcp', 'beta_srv').tokensPerSession, 220);
  assert.equal(row(report, 'mcp', 'beta_srv').pctInput, 8.8);
  assert.equal(row(report, 'plugin', 'acme').tokensPerSession, 55);
  assert.equal(row(report, 'mcp', 'alpha_srv').uses, 1);
  assert.equal(row(report, 'skill', 'alpha').uses, 1);
  assert.equal(row(report, 'skill', 'beta').uses, 0);
  assert.equal(row(report, 'plugin', 'acme').uses, 0);
  assert.equal(row(report, 'hook', 'SessionStart:acme').uses, null);
  assert.equal(report.rowCount, 12);
});

test('budget lists unused candidates above the threshold and nothing used or hook-like', (t) => {
  const box = sandbox(t);
  const high = json(run(t, box, ['--since', '3650', '--min-tokens', '100', '--format', 'json']));
  assert.deepEqual(high.candidates.map((r) => `${r.kind}:${r.name}`), ['mcp:beta_srv', 'plugin:acme', 'skill:beta']);
  const low = json(run(t, box, ['--since', '3650', '--min-tokens', '50', '--format', 'json']));
  assert.deepEqual(low.candidates.map((r) => `${r.kind}:${r.name}`), ['mcp:beta_srv', 'plugin:acme', 'skill:beta', 'agent:mine']);
  const text = run(t, box, ['--since', '3650', '--min-tokens', '100']);
  assert.match(text.stdout, /unused candidates \(0 uses, >= 100 weighted tokens\):/);
  assert.match(text.stdout, /mcp beta_srv {2}~440 weighted tokens/);
  // Unprefixed skills may be built into Claude Code, so the report must not tell the user to remove a SKILL.md outright.
  assert.match(text.stdout, /skill \(user\/built-in\) +beta .*manual: SKILL\.md\*/);
  assert.match(text.stdout, /\* a skill without a plugin prefix is user\/project-defined or built into Claude Code.*built-in skills cannot be removed/);
  assert.doesNotMatch(text.stdout, /manual: remove SKILL\.md/);
  assert.match(text.stdout, /skill \(user\/built-in\) beta {2}~100 weighted tokens, manual: SKILL\.md\*/);
});

test('budget output carries names and sizes only, never prompt or attachment text', (t) => {
  const box = sandbox(t);
  for (const args of [[], ['--format', 'json'], ['--emit-settings'], ['--emit-settings', '--format', 'json']]) {
    const result = run(t, box, ['--since', '3650', '--min-tokens', '100', ...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /SECRET|hhhhhh|zzzz/, args.join(' '));
  }
});

test('budget accepts flags that arrive as one whitespace-joined argument', (t) => {
  const box = sandbox(t);
  const result = run(t, box, ['--since 3650 --min-tokens 100 --format json']);
  assert.equal(json(result).minTokens, 100);
});

test('--emit-settings prints a snippet resolved against .mcp.json and settings, and writes nothing', (t) => {
  const box = sandbox(t, {
    userSettings: { enabledPlugins: { 'acme@market': true, 'other@market': true } },
    projectSettings: { enabledPlugins: { 'unrelated@market': true } },
    mcpJson: { mcpServers: { beta_srv: { command: 'x' }, alpha_srv: { command: 'y' } } },
  });
  const before = snapshot(box.base);
  const result = run(t, box, ['--since', '3650', '--min-tokens', '100', '--emit-settings', '--format', 'json']);
  const emitted = json(result);
  assert.equal(emitted.written, false);
  assert.equal(emitted.file, join(box.project, '.claude', 'settings.local.json'));
  assert.deepEqual(emitted.settings, { enabledPlugins: { 'acme@market': false }, disabledMcpjsonServers: ['beta_srv'] });
  assert.deepEqual(emitted.manual.map((m) => [m.kind, m.name]), [['skill', 'beta']]);
  assert.match(emitted.manual[0].reason, /user\/project or built-in skill/);
  assert.match(emitted.manual[0].reason, /built-in skills .*cannot be removed/);

  const text = run(t, box, ['--since', '3650', '--min-tokens', '100', '--emit-settings']);
  assert.match(text.stdout, /printed only, nothing was written/);
  assert.match(text.stdout, /"acme@market": false/);
  assert.deepEqual(snapshot(box.base), before, 'no file in HOME or the project may be created or modified');
  assert.ok(!Object.keys(snapshot(box.base)).some((p) => p.endsWith('settings.local.json')));
});

test('--emit-settings sends servers outside .mcp.json and unresolvable plugins to the manual list', (t) => {
  // beta_srv is not in .mcp.json; acme matches two marketplaces. Neither may land in the snippet.
  const box = sandbox(t, {
    userSettings: { enabledPlugins: { 'acme@one': true, 'acme@two': true } },
    mcpJson: { mcpServers: { somethingelse: {} } },
  });
  const before = snapshot(box.base);
  const emitted = json(run(t, box, ['--since', '3650', '--min-tokens', '100', '--emit-settings', '--format', 'json']));
  assert.deepEqual(emitted.settings, {});
  const reasons = Object.fromEntries(emitted.manual.map((m) => [`${m.kind}:${m.name}`, m.reason]));
  assert.match(reasons['mcp:beta_srv'], /user-scope server.*\/mcp/);
  assert.match(reasons['plugin:acme'], /ambiguous.*acme@one.*acme@two/);
  assert.match(reasons['skill:beta'], /SKILL\.md/);
  const text = run(t, box, ['--since', '3650', '--min-tokens', '100', '--emit-settings']);
  assert.match(text.stdout, /\(no prunable candidates at >= 100 weighted tokens\)/);
  assert.deepEqual(snapshot(box.base), before);
});

test('plugin keys come from CLAUDE_CONFIG_DIR when set; already-disabled items are not suggested again', (t) => {
  const box = sandbox(t, {
    userSettings: { enabledPlugins: { 'acme@wrong-home': true } },
    localSettings: { disabledMcpjsonServers: ['beta_srv'] },
    mcpJson: { mcpServers: { beta_srv: {} } },
  });
  const configDir = join(box.base, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'acme@right': true } }));
  const before = snapshot(box.base);
  const report = json(run(t, box, ['--since', '3650', '--min-tokens', '100', '--emit-settings', '--format', 'json'], { env: { CLAUDE_CONFIG_DIR: configDir } }));
  assert.deepEqual(report.settings, { enabledPlugins: { 'acme@right': false } });
  assert.ok(!report.manual.some((m) => m.name === 'beta_srv'));
  assert.deepEqual(snapshot(box.base), before);
});

test('budget never throws on unknown or malformed attachment shapes', (t) => {
  const box = sandbox(t);
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-budget-odd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const odd = [
    { type: 'attachment', attachment: null },
    { type: 'attachment', attachment: 'text' },
    { type: 'attachment', attachment: { type: 'skill_listing', names: 'nope', content: 5 } },
    { type: 'attachment', attachment: { type: 'skill_listing', names: ['a', null, 7, 'b:c'] } },
    { type: 'attachment', attachment: { type: 'mcp_instructions_delta', addedNames: [null, 'srv'], addedBlocks: 'x', removedNames: {} } },
    { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__only', 'mcp__s__t'], addedLines: null } },
    { type: 'attachment', attachment: { type: 'agent_listing_delta', addedTypes: [1, 'p:q'], builtInTypes: 'x' } },
    { type: 'attachment', attachment: { type: 'hook_success' } },
    { type: 'attachment', attachment: { type: 'hook_weird', content: [{ text: 'abcd' }, null] } },
    { type: 'attachment', attachment: { type: 'nested_memory', content: 12 } },
    { type: 'attachment', attachment: {} },
    { type: 'attachment', attachment: { type: 'unheard_of', blob: { deep: [1, 2, 3] } } },
    { type: 'assistant', message: { id: 'x', role: 'assistant', usage: { input_tokens: 'many' }, content: [{ type: 'tool_use', id: 't', name: 'Skill', input: null }, { type: 'tool_use', id: 'u', name: 'Task', input: {} }] } },
  ];
  writeFileSync(join(dir, 's.jsonl'), odd.map((l) => JSON.stringify(l)).join('\n'));
  const report = json(run(t, box, ['--since', '3650', '--format', 'json'], { transcripts: dir }));
  assert.equal(report.apiCalls, 1);
  assert.ok(report.rows.length > 0);
});

test('budget reports no transcripts and fails open', (t) => {
  const box = sandbox(t);
  const empty = mkdtempSync(join(tmpdir(), 'tokenslim-budget-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const result = run(t, box, ['--since', '3650'], { transcripts: empty });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'tokenslim budget: no transcripts found.');
});

test('skillSizes splits unmatched names evenly and ignores a trailing newline', () => {
  const sizes = skillSizes('- a: one\n  continued\n- b (x): two\n', ['a', 'b', 'c', 'd']);
  assert.equal(sizes.get('a'), '- a: one\n  continued\n'.length);
  assert.equal(sizes.get('b'), '- b (x): two\n'.length);
  assert.equal(sizes.get('c'), 0);
  assert.equal(skillSizes('x'.repeat(10), ['p', 'q']).get('p'), 5);
});

test('/tokenslim:budget command wraps the script and requires confirmation before applying', () => {
  const source = readFileSync(join(root, 'commands', 'budget.md'), 'utf8');
  const discover = readFileSync(join(root, 'commands', 'discover.md'), 'utf8');
  const wrapper = (text) => text.match(/!`(node -e .*)`/)[1];
  assert.equal(wrapper(source), wrapper(discover).replace('scripts/discover.mjs', 'scripts/budget.mjs').replaceAll('scripts/discover.mjs', 'scripts/budget.mjs'));
  assert.match(source, /split\(\/\\s\+\/\)/);
  assert.match(source, /explicit confirmation/);
  assert.match(source, /settings\.local\.json/);
  assert.match(source, /Never edit `~\/\.claude\/settings\.json`/);
});
