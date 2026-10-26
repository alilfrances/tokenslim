import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isTextLikePath, languageFor, outlineFile, outlineText } from '../scripts/lib/outline.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'outline');

function outline(name) {
  const path = join(FIXTURES, name);
  return outlineFile(path, statSync(path).size);
}

// Exact expectations: ranges end at the next entry's start - 1, and the last one at the file's last line.
const EXPECTED = {
  'sample.js': {
    totalLines: 46,
    entries: [
      'L4-L7  export function load(path)',
      'L8-L11  async function* walk(root)',
      'L12-L15  export const parse = (text, options = {}) =>',
      'L16-L19  const render = async function (items)',
      'L20-L20  export default class Store extends Base',
      'L21-L28    constructor(name)',
      'L29-L32    static create(name)',
      'L33-L38    async save(data)',
      'L39-L43    get size()',
      'L44-L46  function tail()',
    ],
  },
  'sample.ts': {
    totalLines: 24,
    entries: [
      'L1-L4  export interface Options',
      'L5-L6  export type Handler = (opts: Options) =>',
      'L7-L11  export enum Mode',
      'L12-L15  export const run = (opts: Options): void =>',
      'L16-L18  export abstract class Runner',
      'L19-L24    public start(opts: Options): void',
    ],
  },
  'sample.py': {
    totalLines: 22,
    entries: [
      'L5-L8  def top(a, b)',
      'L9-L11  class Widget(Base)',
      'L12-L14      def __init__(self, name)',
      'L15-L15      async def refresh(self)',
      'L16-L20          def inner()',
      'L21-L22  async def main()',
    ],
  },
  'sample.c': {
    totalLines: 26,
    entries: [
      'L4-L8  typedef struct point',
      'L9-L13  static int add(int a, int b)',
      'L14-L20  int main(int argc, char **argv)',
      'L21-L21  namespace util',
      'L22-L26  void helper(int a,',
    ],
  },
  'sample.cpp': {
    totalLines: 18,
    entries: [
      'L3-L4  namespace app',
      'L5-L9  class Engine',
      'L10-L13  void Engine::run()',
      'L14-L18  struct Config',
    ],
  },
  'sample.qml': {
    totalLines: 19,
    entries: [
      'L3-L6  Item { id: root }',
      'L7-L15      Rectangle { id: box }',
      'L16-L19      function reset()',
    ],
  },
  'sample.md': {
    totalLines: 16,
    entries: [
      'L1-L4  # Title',
      'L5-L11  ## Install',
      'L12-L13  ## Usage',
      'L14-L16  ### Flags',
    ],
  },
  'sample.json': {
    totalLines: 12,
    entries: [
      'L2-L2  "name"',
      'L3-L3  "version"',
      'L4-L7  "scripts"',
      'L8-L12  "files"',
    ],
  },
  'sample.yaml': {
    totalLines: 11,
    entries: [
      'L2-L2  name:',
      'L3-L5  on:',
      'L6-L10  jobs:',
      'L11-L11  env:',
    ],
  },
};

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`outline fixture ${name} matches exactly`, () => {
    const result = outline(name);
    assert.equal(result.totalLines, expected.totalLines);
    assert.deepEqual(result.entries, expected.entries);
    assert.equal(result.more, 0);
    assert.equal(result.partial, false);
  });
}

test('outline caps at 40 entries, reports the rest, and ranges still use the true next start', () => {
  const text = Array.from({ length: 100 }, (_, i) => `## Section ${i}\nbody\nbody`).join('\n');
  const result = outlineText(text, 'md');
  assert.equal(result.entries.length, 40);
  assert.equal(result.more, 60);
  assert.equal(result.entries[0], 'L1-L3  ## Section 0');
  assert.equal(result.entries[39], 'L118-L120  ## Section 39');
  assert.equal(result.totalLines, 300);
});

test('a file larger than 1MB is outlined from its first 1MB and flagged partial', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-outline-'));
  try {
    const path = join(dir, 'huge.md');
    const block = '# Heading\n' + 'x'.repeat(98) + '\n';
    writeFileSync(path, block.repeat(12_000), 'utf8'); // ~1.2MB
    const size = statSync(path).size;
    assert.ok(size > 1024 * 1024);
    const result = outlineFile(path, size);
    assert.equal(result.partial, true);
    assert.equal(result.entries.length, 40);
    // Entries come only from the first 1MB; the last read line is bounded by it, not by the file size.
    assert.ok(result.totalLines <= 2 * Math.ceil((1024 * 1024) / 109) + 2);
    assert.ok(result.totalLines < 24_000);
    assert.ok(result.more > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown languages and empty results yield no outline', () => {
  assert.equal(outlineText('whatever', null), null);
  assert.equal(outlineText('whatever', languageFor('main.go')), null);
  assert.equal(outlineFile('/nonexistent/main.go', 10), null);
  assert.deepEqual(outlineText('const a = 1;\n', 'js'), { totalLines: 1, entries: [], more: 0 });
});

test('entries that share a line collapse to a one-line range', () => {
  const result = outlineText('{"a":1,"b":2,"c":{"d":3}}', 'json');
  assert.deepEqual(result.entries, ['L1-L1  "a"', 'L1-L1  "b"', 'L1-L1  "c"']);
});

test('outline regexes stay linear on a pathological 1MB single line', () => {
  const size = 1024 * 1024;
  const inputs = [
    '('.repeat(size),
    ' '.repeat(size),
    'a '.repeat(size / 2),
    `export const x = ${'('.repeat(size - 17)}`,
    `def ${'a'.repeat(size - 4)}`,
    `${'function '.repeat(size / 9)}`,
    `{${'"k":'.repeat(size / 4)}`,
    `${'['.repeat(size / 2)}${'"'.repeat(size / 2)}`,
    `${'x:'.repeat(size / 2)}`,
    `${'A{'.repeat(size / 2)}`,
  ];
  const started = Date.now();
  for (const text of inputs) {
    for (const language of ['js', 'py', 'c', 'qml', 'md', 'json', 'yaml']) outlineText(text, language);
  }
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
});

test('isTextLikePath allows source, config, docs and build files; never binaries or notebooks', () => {
  for (const name of ['a.js', 'a.TS', 'a.py', 'a.cpp', 'a.qml', 'a.md', 'a.json', 'a.yaml', 'a.toml', 'a.go', 'Makefile', 'Dockerfile', 'Dockerfile.dev', 'LICENSE']) {
    assert.equal(isTextLikePath(`/p/${name}`), true, name);
  }
  for (const name of ['a.png', 'a.jpg', 'a.pdf', 'a.ipynb', 'a.zip', 'a.tar.gz', 'a.bin', 'a.so', 'a.exe', 'a.min.js', 'a.min.css', 'a.csv', 'a.lock', 'noextension']) {
    assert.equal(isTextLikePath(`/p/${name}`), false, name);
  }
});
