import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FINAL_MARKER_RE, apiCalls, isCompressedOutput, readLines, toolPairs, transcriptFiles, transcriptRoot } from '../scripts/lib/transcripts.mjs';

test('FINAL_MARKER_RE matches only a marker on the final line', () => {
  for (const text of [
    'out\n[tokenslim: collapseRepeatedLines]',
    'out\n[tokenslim: 5 more similar lines collapsed]\n',
    'out\n[tokenslim: full: /home/u/.cache/tokenslim/tee/s/t.txt]\n  \n',
    '[tokenslim: only]',
  ]) assert.ok(FINAL_MARKER_RE.test(text), text);
  for (const text of [
    'plain output',
    'const m = "[tokenslim: x]";\nmore after',
    '[tokenslim: first]\nbody continues',
    'ends with prose [tokenslim: inline] and more',
    'line ends with a quoted [tokenslim: inline]',
    'out\n[tokenslim: full: /p]\nthen trailing text',
  ]) assert.ok(!FINAL_MARKER_RE.test(text), text);
});

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-tx-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const use = (id, command, name = 'Bash') => ({ type: 'tool_use', id, name, input: { command } });
const result = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
const write = (path, lines) => writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));

test('isCompressedOutput also recognises compressed stdout followed by merged stderr and whole-line tee markers', () => {
  for (const text of [
    'out\n[tokenslim: collapseRepeatedLines]',
    'out\n[tokenslim: collapseRepeatedLines]\nstderr:\nwarning: x',
    'out\n[tokenslim: stripProgressNoise]\r\nstderr:\r\nwarning: x',
    'out\n[tokenslim: full: /home/u/.cache/tokenslim/tee/s/t.log]\nstderr text follows',
    '[tokenslim: full: /p]\nmore',
  ]) assert.ok(isCompressedOutput(text), text);
  for (const text of [
    'plain',
    'const m = "[tokenslim: x]";\nmore',
    'out\n[tokenslim: collapse]\nstdout continues here\nstderr:\nx',
    'see [tokenslim: full: /p] in the docs\nmore',
    '[tokenslim: collapse] inline\nstderr:\n',
  ]) assert.ok(!isCompressedOutput(text), text);
});

test('readLines skips malformed and blank lines, keeps lines without timestamps and honours sinceMs', () => withDir((dir) => {
  const file = join(dir, 'a.jsonl');
  write(file, [
    { n: 1, timestamp: '2020-01-01T00:00:00Z' },
    '{not json', '', '"just a string"',
    { n: 2, timestamp: '2026-01-01T00:00:00Z' },
    { n: 3 },
    { n: 4, timestamp: 'garbage' },
    { n: 5, message: { timestamp: '2019-01-01T00:00:00Z' } },
  ]);
  assert.deepEqual([...readLines(file)].map((l) => l.n), [1, 2, 3, 4, 5]);
  assert.deepEqual([...readLines(file, { sinceMs: Date.parse('2025-01-01') })].map((l) => l.n), [2, 3, 4]);
  assert.deepEqual([...readLines(join(dir, 'missing.jsonl'))], []);
}));

test('readLines handles multibyte characters split across read chunks and a missing trailing newline', () => withDir((dir) => {
  const file = join(dir, 'big.jsonl');
  const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ i, text: 'é€😀'.repeat(8000) }));
  writeFileSync(file, lines.join('\n'));
  const read = [...readLines(file)];
  assert.equal(read.length, 40);
  assert.ok(read.every((l, i) => l.i === i && l.text === 'é€😀'.repeat(8000)));
}));

test('transcriptRoot and transcriptFiles resolve roots, slugs and nested subagent files', () => withDir((dir) => {
  assert.equal(transcriptRoot({ TOKENSLIM_TRANSCRIPTS_DIR: '/x' }), '/x');
  assert.equal(transcriptRoot({ CLAUDE_CONFIG_DIR: '/c' }), join('/c', 'projects'));
  assert.equal(transcriptRoot({ HOME: '/h' }), join('/h', '.claude', 'projects'));
  mkdirSync(join(dir, '-work-app', 'session', 'subagents'), { recursive: true });
  mkdirSync(join(dir, '-work-other'), { recursive: true });
  writeFileSync(join(dir, '-work-app', 'main.jsonl'), '');
  writeFileSync(join(dir, '-work-app', 'session', 'subagents', 'agent.jsonl'), '');
  writeFileSync(join(dir, '-work-app', 'notes.txt'), '');
  writeFileSync(join(dir, '-work-other', 'o.jsonl'), '');
  assert.equal(transcriptFiles({ root: dir, all: true }).length, 3);
  assert.equal(transcriptFiles({ root: dir, cwd: '/work/app' }).length, 2);
  assert.equal(transcriptFiles({ root: dir, cwd: '/nowhere' }).length, 0);
  assert.deepEqual(transcriptFiles({ root: join(dir, 'missing'), all: true }), []);
}));

test('toolPairs dedupes by tool_use_id (first result wins) and flags image, persisted and compressed results', () => withDir((dir) => {
  const file = join(dir, 's.jsonl');
  write(file, [
    { type: 'assistant', message: { content: [use('a', 'ls'), use('b', 'shot'), use('c', 'cat big'), use('d', 'make'), use('e', 'make 2'), use('r', 'Read', 'Read')] } },
    { type: 'user', message: { content: [
      result('a', [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]),
      result('b', [{ type: 'image', source: {} }]),
      result('c', 'x\n<persisted-output>\nmoved\n</persisted-output>'),
      result('d', 'ok\n[tokenslim: collapseRepeatedLines]'),
      result('e', 'quotes [tokenslim: mid] text'),
      result('orphan', 'no matching tool_use'),
    ] } },
    { type: 'user', message: { content: [result('a', 'second result is ignored')] } },
    { type: 'assistant', message: { content: [use('a', 'ls')] } },
    { toolUseResult: {}, message: { content: [result('r', 'file body')] } },
  ]);
  const pairs = [...toolPairs([file])];
  assert.deepEqual(pairs.map((p) => p.id), ['a', 'b', 'c', 'd', 'e', 'r']);
  assert.equal(pairs[0].text, 'onetwo');
  assert.deepEqual(pairs.map((p) => [p.isImage, p.isPersisted, p.isCompressed]), [
    [false, false, false], [true, false, false], [false, true, false], [false, false, true], [false, false, false], [false, false, false],
  ]);
  assert.deepEqual([...toolPairs([file], { tools: ['Bash'] })].map((p) => p.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(pairs[0].input.command, 'ls');
}));

test('toolPairs dedupes across files so a resumed session does not double count', () => withDir((dir) => {
  const lines = [{ type: 'assistant', message: { content: [use('a', 'ls')] } }, { type: 'user', message: { content: [result('a', 'out')] } }];
  write(join(dir, '1.jsonl'), lines); write(join(dir, '2.jsonl'), lines);
  assert.equal([...toolPairs([join(dir, '1.jsonl'), join(dir, '2.jsonl')])].length, 1);
}));

test('apiCalls counts each assistant message.id with usage once, at its first line', () => {
  const usage = { input_tokens: 1 };
  const lines = [
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'text', text: 'a' }] }, timestamp: 't1' },
    { type: 'assistant', message: { id: 'm1', usage, content: [use('x', 'ls')] }, timestamp: 't1b' },
    { type: 'assistant', message: { id: 'nousage', content: [] } },
    { type: 'user', message: { content: [result('x', 'out')], usage } },
    { type: 'assistant', message: { id: 'm2', usage } },
    { type: 'assistant', message: { usage } },
    { type: 'assistant', message: { id: 'm2', usage } },
  ];
  assert.deepEqual(apiCalls(lines), [
    { id: 'm1', index: 1, timestamp: 't1' },
    { id: 'm2', index: 5, timestamp: null },
    { id: null, index: 6, timestamp: null },
  ]);
});
