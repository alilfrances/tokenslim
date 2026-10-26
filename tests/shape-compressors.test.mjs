import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compressShapeOutput } from '../scripts/lib/shape-compressors/index.mjs';
import { group, ungroup } from '../scripts/lib/shape-compressors/grep.mjs';
import { dispatchFixture } from '../scripts/benchmark.mjs';
import { processBashPayload } from '../scripts/lib/bash-hook.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { isolatedEnv } from './helpers.mjs';

const root = join(import.meta.dirname, '..');
const fixture = (name) => readFileSync(join(root, 'tests', 'fixtures', 'shape', name), 'utf8');
const POSITIVE = ['grep-rn.txt', 'grep-context.txt', 'rg-n.txt'];

// Hook payload helper; TOKENSLIM_TEE_MIN=0 so any lossy result would be teed and show up in the cache dir.
function run(stdout, command = 'grep -rn foo .', { dryRun = false } = {}) {
  const iso = isolatedEnv({ TOKENSLIM_TEE_MIN: '0' });
  try {
    const config = loadConfig(root, iso.env);
    const result = processBashPayload(
      { session_id: 's', tool_use_id: 't', tool_input: { command }, tool_response: { stdout, stderr: '' } },
      { config, env: iso.env, dryRun },
    );
    const teeDir = join(iso.env.XDG_CACHE_HOME, 'tokenslim', 'tee');
    return { result, teed: existsSync(teeDir) ? readdirSync(teeDir, { recursive: true }) : [] };
  } finally { iso.cleanup(); }
}

function passesThrough(stdout, command) {
  assert.ok(stdout.length >= 500, `control must be above the size threshold (${stdout.length})`);
  assert.equal(group(stdout), null, 'detector declines');
  assert.equal(compressShapeOutput(stdout), null);
  const { result } = run(stdout, command, { dryRun: true });
  assert.equal(result.updatedToolOutput, null);
  assert.equal(result.bytesOut, result.bytesIn);
}

const numbered = (path, from, count, text = (n) => `  const value${n} = compute(${n});`) =>
  Array.from({ length: count }, (_, i) => `${path}:${from + i * 3}:${text(from + i * 3)}`);

test('groups consecutive same-path runs and round-trips every fixture byte for byte', () => {
  for (const name of POSITIVE) {
    const input = fixture(name);
    assert.ok(input.split('\n').length >= 40, `${name} has at least 40 lines`);
    const grouped = group(input);
    assert.ok(grouped, `${name} is detected`);
    assert.ok(grouped.length < input.length, `${name} shrinks`);
    assert.equal(ungroup(grouped), input, `${name} round-trips`);
    const shaped = compressShapeOutput(input);
    assert.deepEqual(shaped.rulesApplied, ['groupByPath']);
    assert.equal(shaped.lossless, true);
    for (const line of grouped.split('\n')) {
      // Every member is indented and no header can be; that is what makes the inverse unambiguous.
      if (/^ /.test(line)) assert.match(line, /^ {2}\d+[:-]/);
    }
  }
});

test('grouped output has the documented shape: header, two-space members, context kept with -', () => {
  const grouped = group([
    'src/a.js-9-before', 'src/a.js:10:match one', 'src/a.js-11-after',
    '--',
    'src/a.js:40:match two', 'src/a.js:41:match three',
    'src/b.js:1:other one', 'src/b.js:2:other two', 'src/b.js:3:other three',
    'src/c.js:5:lonely', 'src/d.js:6:x', 'src/d.js:7:y', 'src/d.js:8:z',
  ].join('\n') + '\n');
  assert.equal(grouped, [
    'src/a.js', '  9-before', '  10:match one', '  11-after',
    '--',
    'src/a.js', '  40:match two', '  41:match three',
    'src/b.js', '  1:other one', '  2:other two', '  3:other three',
    'src/c.js:5:lonely',
    'src/d.js', '  6:x', '  7:y', '  8:z',
  ].join('\n') + '\n');
});

test('round-trips tricky text: colons, dashes in paths, empty text, CRLF, tabs, no trailing newline', () => {
  const cases = {
    'path containing -digits-': [
      'src/v-12-x/a.js-3-ctx', 'src/v-12-x/a.js:4:hit', 'src/v-12-x/a.js-5-ctx', '--',
      'src/v-12-x/a.js-9-ctx', 'src/v-12-x/a.js:10:hit', 'src/v-12-x/a.js:11:hit', 'src/b-2-c.js:1:z', 'src/b-2-c.js:2:z', 'src/b-2-c.js-3-z',
    ].join('\n'),
    'text with colons, empty text, tabs': [
      'lib/x.ts:1:const a = {b: 1};', 'lib/x.ts:2:', 'lib/x.ts:3:\tindented: 5', 'lib/x.ts:4:12:34:56 time', 'lib/x.ts:5:lib/x.ts:6:nested',
      'lib/y.ts:1:', 'lib/y.ts:2:  ', 'lib/y.ts:3:ok',
    ].join('\n'),
    'CRLF and trailing blank lines': `${numbered('a/b.c', 1, 9).join('\r\n')}\r\n\n\n`,
    'binary notice and a plain line in the middle': [
      ...numbered('a/one.js', 1, 5), 'Binary file a/img.png matches', ...numbered('a/two.js', 1, 5), '',
    ].join('\n'),
    'dash-looking text and numbers': [
      'a/f.md:1:- item', 'a/f.md:2:-5-x', 'a/f.md-3-- 4 -', 'a/f.md:4:2026-10-26', 'a/f.md:5:  7:foo', 'a/f.md:6:x', 'a/f.md:7:y', 'a/f.md:8:z',
    ].join('\n'),
  };
  for (const [label, input] of Object.entries(cases)) {
    const grouped = group(input);
    assert.ok(grouped, label);
    assert.equal(ungroup(grouped), input, label);
  }
});

test('context lines are only attached to an adjacent path, never split from their own text', () => {
  // `a.js-3-b.js-9-x` is a context line of a.js whose TEXT is `b.js-9-x`; it must not become path b.js.
  const input = [
    'a.js-3-b.js-9-x', 'a.js:4:hit', 'a.js-5-y', 'a.js:6:hit', 'a.js:7:hit', 'a.js:8:hit', 'a.js:9:hit', 'a.js:10:hit',
  ].join('\n');
  const grouped = group(input);
  assert.equal(grouped.split('\n')[0], 'a.js');
  assert.equal(grouped.split('\n')[1], '  3-b.js-9-x');
  assert.equal(ungroup(grouped), input);
  // Without a neighbouring match line a dashed line is not a context line at all.
  assert.equal(group(Array.from({ length: 12 }, (_, i) => `docs/guide-${i}-draft.md-${i + 1}-text`).join('\n')), null);
});

test('declines when a verbatim line looks like a grouped member (ungroup would misread it)', () => {
  const lines = [...numbered('src/a.js', 1, 8), '  12:text that looks like a member', ...numbered('src/b.js', 1, 8)];
  assert.equal(group(lines.join('\n')), null);
  // Same shape without the lookalike groups fine.
  assert.ok(group([...numbered('src/a.js', 1, 8), '  indented but not numbered', ...numbered('src/b.js', 1, 8)].join('\n')));
});

test('detector thresholds: 8 lines, 60% share, and a consecutive same-path pair', () => {
  assert.equal(group(numbered('src/a.js', 1, 7).join('\n')), null, '7 lines is below the minimum');
  assert.ok(group(numbered('src/a.js', 1, 8).join('\n')), '8 lines groups');
  const noise = (count) => Array.from({ length: count }, (_, i) => `plain line number ${i}`);
  assert.ok(group([...numbered('src/a.js', 1, 12), ...noise(8)].join('\n')), '12 of 20 = 60% groups');
  assert.equal(group([...numbered('src/a.js', 1, 11), ...noise(8)].join('\n')), null, '11 of 19 < 60% declines');
  // Blank lines do not count against the share.
  assert.ok(group([...numbered('src/a.js', 1, 12), ...noise(8), '', '', '', ''].join('\n')));
  // Alternating paths never repeat consecutively, so grouping would not help.
  const alternating = Array.from({ length: 12 }, (_, i) => `src/${i % 2 ? 'a' : 'b'}.js:${i + 1}:hit`);
  assert.equal(group(alternating.join('\n')), null);
});

test('does not group a run that would not shrink', () => {
  // A pair under a 3-char path breaks exactly even (2 members save 2 each, the header costs 4): not grouped.
  const tiny = ['a.b', 'c.d', 'e.f', 'g.h'].flatMap((path) => [`${path}:1:x`, `${path}:2:y`]);
  assert.equal(group(tiny.join('\n')), null);
  assert.ok(group(['a.b', 'c.d'].flatMap((path) => [`${path}:1:x`, `${path}:2:y`, `${path}:3:z`, `${path}:4:w`]).join('\n')));
});

test('plan-listed shapes that must not match: grep -c, grep -l, path:N without text', () => {
  const counts = Array.from({ length: 20 }, (_, i) => `src/module-${i}/index.js:${i + 12}`).join('\n');
  const names = Array.from({ length: 20 }, (_, i) => `src/module-${i}/index.js`).join('\n');
  assert.equal(group(counts), null);
  assert.equal(group(names), null);
  // `path:12` count lines mixed into real matches stay verbatim while the matches group.
  const mixed = [...numbered('src/a.js', 1, 9), 'src/a.js:12', ...numbered('src/b.js', 1, 9)].join('\n');
  const grouped = group(mixed);
  assert.ok(grouped.split('\n').includes('src/a.js:12'));
  assert.equal(ungroup(grouped), mixed);
});

test('negative controls pass through the full hook path byte-identical', () => {
  const names = ['alpha-config.json', 'bravo.mjs', 'charlie-notes.md', 'delta', 'echo-server.mjs', 'foxtrot.test.mjs', 'golf-course.txt', 'hotel', 'india-ink.svg', 'juliet.lock'];
  const ls = [
    'total 120',
    ...names.map((name, i) => `-rw-r--r-- 1 user staff ${1000 + i * 937} Oct ${10 + i} 12:${34 + i} ${name}`),
  ].join('\n') + '\n';
  const sourceFile = [
    ...Array.from({ length: 24 }, (_, i) => `function handler${i}(request) { return respond(request, ${i}); }`),
    'const lookup = { foo:12: bar };',
    'export default handler0;',
  ].join('\n') + '\n';
  // Distinct names keep the generic collapse rule (not under test here) from rewriting these.
  const modules = ['auth', 'billing', 'cache', 'dashboard', 'editor', 'feed', 'gateway', 'health', 'import', 'jobs', 'kernel', 'locale'];
  const counts = modules.map((name, i) => `packages/${name}/src/components/${name}Controller.tsx:${i * 3 + 1}`).join('\n') + '\n';
  const files = modules.map((name) => `packages/${name}/src/components/${name}Controller.tsx`).join('\n') + '\n';
  const words = ['starting', 'listening', 'accepted', 'closing', 'retrying', 'flushed', 'resolved', 'drained'];
  const clocks = Array.from({ length: 24 }, (_, i) => `12:34:${String(i).padStart(2, '0')} ${words[i % 8]} worker${i} queue${(i * 7) % 11}`).join('\n') + '\n';
  const stamps = Array.from({ length: 24 }, (_, i) => `2026-10-26T12:34:${String(i).padStart(2, '0')}Z ${words[i % 8]} worker${i} queue${(i * 7) % 11}`).join('\n') + '\n';
  const bracketed = Array.from({ length: 24 }, (_, i) => `[12:34:${String(i).padStart(2, '0')}] ${words[i % 8]} worker${i} queue${(i * 7) % 11}`).join('\n') + '\n';
  const urls = modules.map((name, i) => `http://${name}.internal:${8080 + i}/api/${words[i % 8]}/${name}`).join('\n')
    + '\n' + modules.map((name, i) => `https://${name}.example.com:${8443 + i}/docs/${words[(i + 3) % 8]}/index.html`).join('\n') + '\n';
  const hostPorts = modules.map((name, i) => `${name}.internal:${8000 + i}:${words[i % 8]} ${name} worker ${i * 13}`).join('\n') + '\n';
  for (const [stdout, command] of [
    [ls, 'ls -l src'], [sourceFile, 'cat src/handlers.js'], [counts, 'grep -rc foo src'], [files, 'grep -rl foo src'],
    [clocks, 'tail -n 24 app.log'], [stamps, 'journalctl -n 24'], [bracketed, 'tail app.log'], [urls, 'cat urls.txt'], [hostPorts, 'cat ports.txt'],
  ]) passesThrough(stdout, command);
});

test('mixed output groups only the grep region and leaves the rest byte-identical', () => {
  const sed = Array.from({ length: 5 }, (_, i) => `// header comment line ${i}: explains the module in plain prose`);
  const trailer = 'done: 2 files scanned';
  const grep = [...numbered('src/lib/a.mjs', 4, 12), ...numbered('src/lib/b.mjs', 10, 12)];
  const input = `${[...sed, ...grep, trailer].join('\n')}\n`;
  const grouped = group(input);
  const lines = grouped.split('\n');
  assert.deepEqual(lines.slice(0, 5), sed);
  assert.equal(lines.at(-2), trailer);
  assert.equal(lines[5], 'src/lib/a.mjs');
  assert.equal(ungroup(grouped), input);
  // Mostly prose with a few grep lines is not grep-shaped at all.
  assert.equal(group([...Array.from({ length: 40 }, (_, i) => `prose line ${i}`), ...grep].join('\n')), null);
});

test('hook: shape dispatch ignores the command, so pipes and chains still group, with no tee for the lossless result', () => {
  const input = fixture('grep-rn.txt');
  for (const command of ['grep -rn compress scripts | head -80', 'cd scripts && grep -rn compress . ; echo done', 'some-unknown-tool', undefined]) {
    const { result, teed } = run(input, command);
    assert.equal(result.outcome, 'compressed', String(command));
    assert.ok(result.rulesApplied.includes('groupByPath'));
    assert.equal(result.recoveryPath, null, 'lossless result is never teed');
    assert.deepEqual(teed, []);
    assert.match(result.updatedToolOutput.stdout, /\n\[tokenslim: groupByPath[^\]]*\]$/);
    assert.ok(result.bytesOut < result.bytesIn);
    // Dropping our marker and expanding recovers the model-visible original.
    const body = result.updatedToolOutput.stdout.replace(/\n\[tokenslim: [^\]]*\]$/, '');
    assert.equal(ungroup(body), input.replace(/\n+$/g, ''));
  }
});

test('hook: a literal \\r in source text survives grouping verbatim and is not a lossy change', () => {
  const crlf = "src/a.js:40:const crlf = s.replace(/\\r\\n/g, '\\n');";
  const lines = [...numbered('src/a.js', 1, 10), crlf, ...numbered('src/a.js', 50, 3)];
  const input = `${lines.join('\n')}\n`;
  const { result, teed } = run(input);
  assert.equal(result.outcome, 'compressed');
  assert.ok(result.rulesApplied.includes('groupByPath'));
  assert.ok(!result.rulesApplied.includes('stripProgressNoise'));
  assert.equal(result.recoveryPath, null);
  assert.deepEqual(teed, []);
  const body = result.updatedToolOutput.stdout.replace(/\n\[tokenslim: [^\]]*\]$/, '');
  assert.equal(ungroup(body), input.replace(/\n+$/g, ''));
});

test('hook: when generic rules also change the grouped text lossily the original is still teed', () => {
  // A bare spinner line between groups is dropped by the generic progress rule, which is lossy.
  const path = 'src/components/deeply/nested/widget.js';
  const lines = [...numbered(path, 1, 30), '|', ...numbered(path, 50, 30)];
  const input = `${lines.join('\n')}\n`;
  const { result, teed } = run(input);
  assert.equal(result.outcome, 'compressed');
  assert.ok(result.rulesApplied.includes('groupByPath'));
  assert.ok(result.rulesApplied.includes('stripProgressNoise'));
  assert.ok(result.recoveryPath, 'lossy generic change is teed');
  assert.equal(teed.length > 0, true);
});

test('hook: the 0.9 ratio gate still applies after grouping', () => {
  // Very short paths and long text save almost nothing: grouping may fire but the gate must reject it.
  const input = Array.from({ length: 60 }, (_, i) => `a.js:${i + 1}:${'x'.repeat(60)}`).join('\n') + '\n';
  const { result } = run(input, undefined, { dryRun: true });
  assert.equal(result.outcome, 'skippedPoorRatio');
  assert.equal(result.updatedToolOutput, null);
});

test('benchmark dispatch reports the shape stage between command and generic', () => {
  const input = fixture('rg-n.txt');
  assert.equal(dispatchFixture(input, 'rg -n tee').dispatch, 'shape');
  assert.ok(dispatchFixture(input, 'rg -n tee').rulesApplied.includes('groupByPath'));
  assert.equal(dispatchFixture(input, 'git status').dispatch, 'shape', 'unrelated command text does not change shape dispatch');
});

test('spawned hook compresses grep output with a marker and writes no recovery file', () => {
  const iso = isolatedEnv({ TOKENSLIM_TEE_MIN: '0' });
  try {
    const payload = { hook_event_name: 'PostToolUse', session_id: 'shape', tool_use_id: 'grep-1', cwd: root, tool_name: 'Bash', tool_input: { command: 'grep -rn tee . | head -100' }, tool_response: { stdout: fixture('rg-n.txt'), stderr: '' } };
    const spawned = spawnSync(process.execPath, [join(root, 'scripts', 'compress-bash.mjs')], { cwd: root, input: JSON.stringify(payload), encoding: 'utf8', env: iso.env });
    assert.equal(spawned.status, 0, spawned.stderr);
    const updated = JSON.parse(spawned.stdout).hookSpecificOutput.updatedToolOutput.stdout;
    assert.match(updated, /\[tokenslim: groupByPath[^\]]*\]$/);
    assert.doesNotMatch(updated, /\n\[tokenslim: full:/);
    assert.equal(existsSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim', 'tee')), false);
  } finally { iso.cleanup(); }
});
