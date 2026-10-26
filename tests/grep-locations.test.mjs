import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collapseRepeatedLines, compressBashOutput, headTailTruncate } from '../scripts/lib/pipeline.mjs';
import { group, grepLocations, locationMask, ungroup } from '../scripts/lib/shape-compressors/grep.mjs';
import { compressShapeOutput } from '../scripts/lib/shape-compressors/index.mjs';
import { processBashPayload } from '../scripts/lib/bash-hook.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { FIXTURE_COMMANDS, dispatchFixture } from '../scripts/benchmark.mjs';

const root = join(import.meta.dirname, '..');
const config = loadConfig(root, { ...process.env, XDG_CONFIG_HOME: join(root, 'tests', 'fixtures', 'no-such-config') });

// WP1 reproduction: 18 hits, 3 files, 6 per file, identical text, different line numbers.
const REPRO_FILES = [['tests/pipeline.test.mjs', 40], ['tests/budget.test.mjs', 90], ['tests/stats.test.mjs', 12]];
const hit = (file, n) => `${file}:${n}:    assert.equal(result.status, 0, result.stderr);`;
const reproLines = REPRO_FILES.flatMap(([file, base]) => Array.from({ length: 6 }, (_, i) => hit(file, base + i * 7)));
const REPRO = `${reproLines.join('\n')}\n`;
const reproPairs = REPRO_FILES.flatMap(([file, base]) => Array.from({ length: 6 }, (_, i) => `${file}:${base + i * 7}`));
// Raw form: the same hits among enough distinct prose lines that the shape detector (60%) declines.
const RAW_REPRO = `${REPRO_FILES.flatMap(([file, base]) => [
  ...['scanning workspace', 'skipping vendored directory', 'index warm, files queued', 'results follow'].map((line) => `${line} (${file})`),
  ...Array.from({ length: 6 }, (_, i) => hit(file, base + i * 7)),
]).join('\n')}\nsearch complete\nelapsed time is short\ndone\n`;

function hook(stdout, command = 'grep -rn assert tests', cfg = config) {
  return processBashPayload({ session_id: 's', tool_use_id: 't', tool_input: { command }, tool_response: { stdout, stderr: '' } }, { config: cfg, dryRun: true });
}

test('reproduction: all 18 grep hit locations survive the hook and collapseRepeatedLines never runs', () => {
  const result = hook(REPRO);
  assert.equal(result.outcome, 'compressed');
  assert.deepEqual(result.rulesApplied, ['groupByPath']);
  assert.equal(result.recoveryPath, null, 'lossless: nothing to tee');
  const out = result.updatedToolOutput.stdout;
  const recovered = grepLocations(out, { grouped: true });
  assert.deepEqual([...recovered].sort(), [...reproPairs].sort());
  assert.equal(recovered.size, 18);
  assert.doesNotMatch(out, /similar lines collapsed/);
  // The marker is accurate: the shape is lossless, so the model-visible original is recoverable byte for byte.
  assert.equal(ungroup(out.replace(/\n\[tokenslim: [^\]]*\]$/, '')), REPRO.replace(/\n+$/g, ''));
});

test('reproduction: raw form through the generic path keeps every location', () => {
  assert.equal(group(RAW_REPRO), null, 'the shape detector declines this one');
  assert.equal(compressShapeOutput(RAW_REPRO), null);
  const generic = compressBashOutput(RAW_REPRO);
  assert.ok(!generic.stats.rulesApplied.includes('collapseRepeatedLines'));
  assert.deepEqual([...grepLocations(generic.text)].sort(), [...reproPairs].sort());
  // Same through the hook and through bare grep hits with no prose at all.
  const viaHook = hook(RAW_REPRO);
  if (viaHook.updatedToolOutput) assert.deepEqual([...grepLocations(viaHook.updatedToolOutput.stdout)].sort(), [...reproPairs].sort());
  assert.deepEqual([...grepLocations(compressBashOutput(REPRO).text)].sort(), [...reproPairs].sort());
  assert.equal(collapseRepeatedLines(REPRO), REPRO.replace(/\n+$/g, ''));
});

test('collapseRepeatedLines: location lines join a run only when byte-identical, context lines included', () => {
  const same = Array.from({ length: 6 }, () => 'src/a.js:12:    same hit text again').join('\n');
  assert.equal(collapseRepeatedLines(same), 'src/a.js:12:    same hit text again\n[tokenslim: 5 more similar lines collapsed]');
  const contextual = ['src/a.js-3-    same context text', 'src/a.js:4:    same context text', 'src/a.js-5-    same context text', 'src/a.js-6-    same context text', 'src/a.js-7-    same context text'].join('\n');
  assert.equal(collapseRepeatedLines(contextual), contextual);
  // Grouped members carry locations too (a collapse here would be just as lossy).
  const members = ['src/a.js', ...[10, 20, 30, 40, 50].map((n) => `  ${n}:    same member text`)].join('\n');
  assert.equal(collapseRepeatedLines(members), members);
  const listed = ['src/a.js', ...['1,2', '3,4', '5,6', '7,8', '9,10'].map((n) => `  ${n}:    same member text`)].join('\n');
  assert.equal(collapseRepeatedLines(listed), listed);
});

test('collapseRepeatedLines: non-grep content collapses exactly as before the location guard', () => {
  const rows = (make) => Array.from({ length: 12 }, (_, i) => make(i)).join('\n');
  const marker = (first) => `${first}\n[tokenslim: 11 more similar lines collapsed]`;
  const cases = [
    [rows((i) => `12:34:${String(i).padStart(2, '0')} request handled by worker queue`), marker('12:34:00 request handled by worker queue')],
    [rows((i) => `2026-10-26T12:34:${String(i).padStart(2, '0')}Z request handled by worker queue`), marker('2026-10-26T12:34:00Z request handled by worker queue')],
    [rows((i) => `GET http://api.internal:${8080 + i}/v1/items/list returned ok`), marker('GET http://api.internal:8080/v1/items/list returned ok')],
    [rows((i) => `-rw-r--r-- 1 user staff ${1000 + i} Oct ${10 + i} 12:34 report-final-copy.txt`), marker('-rw-r--r-- 1 user staff 1000 Oct 10 12:34 report-final-copy.txt')],
    [rows((i) => `[12:34:${String(i).padStart(2, '0')}] request handled by worker queue`), marker('[12:34:00] request handled by worker queue')],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(locationMask(input.split('\n')), Array(12).fill(false));
    assert.equal(collapseRepeatedLines(input), expected);
  }
});

test('locationMask uses the grep parse rules: file-like paths only, grouped members included', () => {
  const lines = ['src/a.js:12:x', 'src/a.js-13-ctx', 'src/a.js', '  14:member', '  15,16:listed', '  17-context member', 'host:8080:x', '12:34:56 up', 'plain line', 'src/a.js:12'];
  assert.deepEqual(locationMask(lines), [true, true, false, true, true, true, false, false, false, false]);
});

// ---- location-preservation invariant over every fixture ----
const names = (dir) => readdirSync(join(root, 'tests', 'fixtures', dir)).filter((name) => name.endsWith('.txt')).sort();
const INPUTS = [
  ...names('bash').map((name) => ({ label: `bash/${name}`, text: readFileSync(join(root, 'tests', 'fixtures', 'bash', name), 'utf8'), command: FIXTURE_COMMANDS[name] })),
  ...names('shape').map((name) => ({ label: `shape/${name}`, text: readFileSync(join(root, 'tests', 'fixtures', 'shape', name), 'utf8'), command: 'grep -rn x .' })),
  { label: 'repro', text: REPRO, command: 'grep -rn assert tests' },
  { label: 'repro-raw', text: RAW_REPRO, command: 'grep -rn assert tests | cat' },
  { label: 'repro-no-command', text: REPRO, command: undefined },
];

test('invariant: grep hit locations in the input are all recoverable from every compressed output', () => {
  let located = 0;
  for (const { label, text, command } of INPUTS) {
    const before = grepLocations(text);
    located += before.size;
    const result = hook(text, command);
    const grouped = result.rulesApplied.includes('groupByPath');
    assert.ok(!(grouped && result.rulesApplied.includes('collapseRepeatedLines')), `${label}: groupByPath with collapseRepeatedLines`);
    if (result.updatedToolOutput) {
      const after = grepLocations(result.updatedToolOutput.stdout, { grouped });
      assert.deepEqual([...before].filter((entry) => !after.has(entry)), [], `${label}: hook dropped locations`);
    }
    // The pipeline stages the hook builds on, run directly.
    const generic = compressBashOutput(text);
    assert.deepEqual([...before].filter((entry) => !grepLocations(generic.text).has(entry)), [], `${label}: generic pipeline`);
    const dispatched = dispatchFixture(text, command ?? '');
    const dispatchedGrouped = dispatched.rulesApplied.includes('groupByPath');
    assert.deepEqual([...before].filter((entry) => !grepLocations(dispatched.text, { grouped: dispatchedGrouped }).has(entry)), [], `${label}: benchmark dispatch`);
    assert.ok(!(dispatchedGrouped && dispatched.rulesApplied.includes('collapseRepeatedLines')), `${label}: dispatch rules`);
    // Grouping is lossless, byte for byte, whatever it lists.
    const shaped = group(text);
    if (shaped !== null) assert.equal(ungroup(shaped), text, `${label}: group round trip`);
  }
  assert.ok(located > 150, `the invariant must not be vacuous (${located} locations)`);
});

test('shape path applies display-only cleanup: ANSI and CRLF are normalized, nothing lossy runs', () => {
  const crlf = REPRO.replace(/\n/g, '\r\n');
  const result = hook(crlf);
  assert.equal(result.outcome, 'compressed');
  assert.deepEqual(result.rulesApplied, ['groupByPath']);
  assert.doesNotMatch(result.updatedToolOutput.stdout, /\r/);
  assert.equal(result.recoveryPath, null);
  const spinner = [...reproLines.slice(0, 9), '|', ...reproLines.slice(9)].join('\n');
  const kept = hook(`${spinner}\n`);
  assert.ok(!kept.rulesApplied.includes('stripProgressNoise'));
  assert.ok(kept.updatedToolOutput.stdout.split('\n').includes('|'), 'a spinner-looking line stays verbatim: no generic lossy rule runs after a shape');
});

// ---- optional identical-text line lists ----
const FIXTURE_SHAPES = names('shape').map((name) => [name, readFileSync(join(root, 'tests', 'fixtures', 'shape', name), 'utf8')]);

test('identical consecutive match text is listed once: format and exact round trip', () => {
  const grouped = group(REPRO);
  assert.equal(grouped, [
    'tests/pipeline.test.mjs', '  40,47,54,61,68,75:    assert.equal(result.status, 0, result.stderr);',
    'tests/budget.test.mjs', '  90,97,104,111,118,125:    assert.equal(result.status, 0, result.stderr);',
    'tests/stats.test.mjs', '  12,19,26,33,40,47:    assert.equal(result.status, 0, result.stderr);',
  ].join('\n') + '\n');
  assert.equal(ungroup(grouped), REPRO);
  for (const [name, input] of FIXTURE_SHAPES) assert.equal(ungroup(group(input)), input, name);
});

test('line lists never merge context lines, non-adjacent hits, or text that starts with a digit or comma', () => {
  const path = 'src/components/deeply/nested/widget.js';
  const input = [
    `${path}-1-same`, `${path}:2:same`, `${path}-3-same`, `${path}-4-same`,
    `${path}:5:same`, `${path}:6:same`, `${path}-7-between`, `${path}:8:same`, `${path}:9:same`,
    `${path}:10:7 starts with a digit`, `${path}:11:7 starts with a digit`,
    `${path}:12:,comma first`, `${path}:13:,comma first`,
    `${path}:14:`, `${path}:15:`, `${path}:16:`,
  ].join('\n');
  const grouped = group(input);
  assert.deepEqual(grouped.split('\n'), [
    path, '  1-same', '  2:same', '  3-same', '  4-same', '  5,6:same', '  7-between', '  8,9:same',
    '  10:7 starts with a digit', '  11:7 starts with a digit', '  12:,comma first', '  13:,comma first', '  14,15,16:',
  ]);
  assert.equal(ungroup(grouped), input);
});

test('line lists: a verbatim lookalike still makes the grouper decline; the cap counts every listed hit', () => {
  assert.equal(group([...reproLines, '  12,13:looks like a listed member', ...reproLines].join('\n')), null);
  // Omit the middle files: a listed line of 6 hits must count as 6 hits, not 1 (and not trip the 8-hit minimum wrongly).
  const many = REPRO_FILES.concat([['tests/a.test.mjs', 3], ['tests/b.test.mjs', 5]]).flatMap(([file, base]) => Array.from({ length: 6 }, (_, i) => hit(file, base + i * 7))).join('\n');
  const grouped = group(many);
  assert.equal(grouped.split('\n').length, 10);
  const counts = headTailTruncate(grouped, { maxChars: 10, headLines: 2, tailLines: 2, grepCounts: true });
  assert.match(counts, /omitted matches by file\]\ntests\/budget\.test\.mjs: 6\ntests\/stats\.test\.mjs: 6\ntests\/a\.test\.mjs: 6/);
  assert.match(counts, /\[tokenslim: 6 lines omitted\]/);
});

test('round trip holds on pseudo-random grep output with runs, context lines and awkward text', () => {
  let seed = 12345;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const texts = ['same', 'same', '', '1,2 odd', ',x', '  indented', '-dash', '12:34', 'path/x.js:5:nested', 'tab\there', 'a\r'];
  for (let round = 0; round < 200; round += 1) {
    const lines = [];
    for (let f = 0; f < 1 + rand(4); f += 1) {
      const path = ['src/a-1-b.js', 'lib/long/nested/path/file.mjs', 'x/y.ts'][rand(3)] + (f ? `.${f}` : '');
      for (let i = 0, n = 1 + rand(30); i < n; i += 1) {
        const sep = rand(4) === 0 ? '-' : ':';
        lines.push(`${path}${sep}${1 + rand(999)}${sep}${texts[rand(texts.length)]}`);
      }
      if (rand(3) === 0) lines.push('--');
    }
    const input = lines.join('\n');
    const grouped = group(input);
    if (grouped === null) continue;
    assert.equal(ungroup(grouped), input, `round ${round}`);
    assert.deepEqual([...grepLocations(grouped, { grouped: true })].sort(), [...grepLocations(input)].sort(), `round ${round} locations`);
  }
});

test('line lists shrink the shape fixtures and the reproduction versus one member per hit', () => {
  const unlisted = (grouped) => grouped.split('\n').flatMap((line) => {
    const listed = /^ {2}(\d+(?:,\d+)*):(.*)$/.exec(line);
    return listed ? listed[1].split(',').map((n) => `  ${n}:${listed[2]}`) : [line];
  }).join('\n');
  for (const [label, input] of [...FIXTURE_SHAPES, ['repro', REPRO]]) {
    const grouped = group(input);
    assert.ok(grouped.length <= unlisted(grouped).length, label);
  }
  assert.ok(group(REPRO).length < unlisted(group(REPRO)).length * 0.75);
});
