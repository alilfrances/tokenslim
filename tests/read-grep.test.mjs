import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync as fsReadFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const READ_SCRIPT = join(__dirname, '..', 'scripts', 'compress-read.mjs');
const GREP_SCRIPT = join(__dirname, '..', 'scripts', 'compress-grep.mjs');
const FIXTURE_SOURCE = join(__dirname, 'fixtures', 'read', 'source-with-blanks.js');
const FIXTURE_GREP = join(__dirname, 'fixtures', 'read', 'large-grep-output.txt');

function run(script, payload, extraEnv = {}) {
  const result = spawnSync('node', [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return result;
}

function parseOutput(result) {
  if (!result.stdout) return undefined;
  return JSON.parse(result.stdout);
}

function withTempCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-hook-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- Read ----------

test('Read: confirmed shape {type:"text", file:{content,...}} slims and mirrors other fields', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_SOURCE, 'utf8');
    const payload = {
      session_id: 'sess-read-1',
      tool_name: 'Read',
      tool_input: { file_path: FIXTURE_SOURCE },
      tool_response: {
        type: 'text',
        file: {
          filePath: FIXTURE_SOURCE,
          content,
          numLines: content.split('\n').length,
          startLine: 1,
          totalLines: content.split('\n').length,
        },
      },
    };
    const result = run(READ_SCRIPT, payload, {
      XDG_CACHE_HOME: cacheDir,
      TOKENSLIM_MIN_CHARS: '10',
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result);
    assert.ok(out, 'expected compression output for a heavily-whitespaced fixture');
    const updated = out.hookSpecificOutput.updatedToolOutput;
    assert.equal(updated.type, 'text');
    assert.equal(updated.file.filePath, FIXTURE_SOURCE);
    assert.equal(updated.file.startLine, 1);
    assert.equal(updated.file.totalLines, content.split('\n').length);
    // no trailing whitespace remains on any line
    for (const line of updated.file.content.split('\n')) {
      assert.equal(line, line.replace(/[ \t]+$/, ''));
    }
    // the 4-line blank run collapsed, so line count shrank
    assert.ok(updated.file.numLines < content.split('\n').length);
    assert.equal(updated.file.numLines, updated.file.content.split('\n').length);
  });
});

test('Read: second identical full-file read produces an unchanged-since stub', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_SOURCE, 'utf8');
    const makePayload = () => ({
      session_id: 'sess-read-dedup',
      tool_name: 'Read',
      tool_input: { file_path: FIXTURE_SOURCE },
      tool_response: {
        type: 'text',
        file: { filePath: FIXTURE_SOURCE, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length },
      },
    });
    const env = { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' };

    const first = run(READ_SCRIPT, makePayload(), env);
    assert.equal(first.status, 0);
    assert.ok(parseOutput(first));

    const second = run(READ_SCRIPT, makePayload(), env);
    assert.equal(second.status, 0);
    const out = parseOutput(second);
    assert.ok(out, 'expected a stub on the second identical read');
    const text = out.hookSpecificOutput.updatedToolOutput.file.content;
    assert.match(text, /unchanged since previous read in this session/);
    assert.match(text, new RegExp(FIXTURE_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(text, /sha256:[0-9a-f]{12}/);
  });
});

test('Read: offset/limit reads are never deduped even when content repeats', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_SOURCE, 'utf8');
    const makePayload = () => ({
      session_id: 'sess-read-partial',
      tool_name: 'Read',
      tool_input: { file_path: FIXTURE_SOURCE, offset: 1, limit: 5 },
      tool_response: {
        type: 'text',
        file: { filePath: FIXTURE_SOURCE, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length },
      },
    });
    const env = { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' };

    run(READ_SCRIPT, makePayload(), env);
    const second = run(READ_SCRIPT, makePayload(), env);
    const out = parseOutput(second);
    if (out) {
      assert.doesNotMatch(out.hookSpecificOutput.updatedToolOutput.file.content, /unchanged since previous read/);
    }
  });
});

test('Read: plain-string tool_response is mirrored as a string', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_SOURCE, 'utf8');
    const payload = {
      session_id: 'sess-read-string',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/whatever.js' },
      tool_response: content,
    };
    const result = run(READ_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' });
    const out = parseOutput(result);
    assert.ok(out);
    assert.equal(typeof out.hookSpecificOutput.updatedToolOutput, 'string');
  });
});

test('Read: {content} fallback shape is recognized', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_SOURCE, 'utf8');
    const payload = {
      session_id: 'sess-read-content-shape',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/whatever2.js' },
      tool_response: { content, extra: 'keep-me' },
    };
    const result = run(READ_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' });
    const out = parseOutput(result);
    assert.ok(out);
    assert.equal(out.hookSpecificOutput.updatedToolOutput.extra, 'keep-me');
  });
});

test('Read: text-block-array shape only rewrites the text block, leaves siblings untouched', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_SOURCE, 'utf8');
    const imageBlock = { type: 'image', source: { data: 'unchanged-base64' } };
    const payload = {
      session_id: 'sess-read-blocks',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/whatever3.js' },
      tool_response: [imageBlock, { type: 'text', text: content }],
    };
    const result = run(READ_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' });
    const out = parseOutput(result);
    assert.ok(out);
    const updated = out.hookSpecificOutput.updatedToolOutput;
    assert.deepEqual(updated[0], imageBlock);
    assert.notEqual(updated[1].text, content);
  });
});

test('Read: unrecognized shape passes through silently', () => {
  withTempCache((cacheDir) => {
    const payload = {
      session_id: 'sess-read-unknown',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/whatever4.js' },
      tool_response: { foo: 'bar', nested: { baz: 1 } },
    };
    const result = run(READ_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });
});

test('Read: garbage stdin fails open', () => {
  withTempCache((cacheDir) => {
    const result = run(READ_SCRIPT, undefined, { XDG_CACHE_HOME: cacheDir });
    const raw = spawnSync('node', [READ_SCRIPT], {
      input: 'not json at all {{{',
      encoding: 'utf8',
      env: { ...process.env, XDG_CACHE_HOME: cacheDir },
    });
    assert.equal(raw.status, 0);
    assert.equal(raw.stdout, '');
  });
});

test('Read: TOKENSLIM_DISABLE=read suppresses output entirely', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_SOURCE, 'utf8');
    const payload = {
      session_id: 'sess-read-disabled',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/whatever5.js' },
      tool_response: { type: 'text', file: { filePath: '/tmp/whatever5.js', content, numLines: 1, startLine: 1, totalLines: 1 } },
    };
    const result = run(READ_SCRIPT, payload, {
      XDG_CACHE_HOME: cacheDir,
      TOKENSLIM_MIN_CHARS: '10',
      TOKENSLIM_DISABLE: 'read',
    });
    assert.equal(result.stdout, '');
  });
});

// ---------- Grep / Glob ----------

test('Grep: confirmed content-mode shape dedups exact lines and collapses repeated matches', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_GREP, 'utf8');
    const payload = {
      session_id: 'sess-grep-1',
      tool_name: 'Grep',
      tool_input: {},
      tool_response: { mode: 'content', numFiles: 3, filenames: ['a', 'b', 'c'], content, numLines: content.split('\n').length },
    };
    const result = run(GREP_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir });
    assert.equal(result.status, 0);
    const out = parseOutput(result);
    assert.ok(out, 'expected compression for the fixture with duplicates + repeated matches');
    const updated = out.hookSpecificOutput.updatedToolOutput;
    assert.equal(updated.mode, 'content');
    assert.deepEqual(updated.filenames, ['a', 'b', 'c']);
    assert.equal(updated.numFiles, 3);

    const lines = updated.content.split('\n');
    // exact duplicate collapsed to one occurrence
    const dupCount = lines.filter((l) => l === 'src/other-file.ts:1:  import { thing } from "./thing";').length;
    assert.equal(dupCount, 1);
    // 8 big-file.ts matches -> first 3 kept + one summary line for the remaining 5
    assert.ok(lines.some((l) => l === '... [tokenslim: 5 more matches in src/big-file.ts]'));
    assert.equal(updated.numLines, lines.length);
  });
});

test('Grep: non-content mode passes through untouched', () => {
  withTempCache((cacheDir) => {
    const payload = {
      session_id: 'sess-grep-2',
      tool_name: 'Grep',
      tool_input: {},
      tool_response: { mode: 'files_with_matches', numFiles: 2, filenames: ['x.ts', 'y.ts'] },
    };
    const result = run(GREP_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir });
    assert.equal(result.stdout, '');
  });
});

test('Grep: below-threshold savings pass through with no output', () => {
  withTempCache((cacheDir) => {
    // All-unique lines, nothing to dedup or collapse -> compression ratio ~0%.
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(`src/file${i}.ts:1:  export const v${i} = ${i};`);
    const content = lines.join('\n');
    const payload = {
      session_id: 'sess-grep-3',
      tool_name: 'Grep',
      tool_input: {},
      tool_response: { mode: 'content', numFiles: 40, filenames: [], content, numLines: lines.length },
    };
    const result = run(GREP_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir });
    assert.equal(result.stdout, '');
  });
});

test('Grep: garbage stdin fails open', () => {
  withTempCache((cacheDir) => {
    const raw = spawnSync('node', [GREP_SCRIPT], {
      input: '{{{ not json',
      encoding: 'utf8',
      env: { ...process.env, XDG_CACHE_HOME: cacheDir },
    });
    assert.equal(raw.status, 0);
    assert.equal(raw.stdout, '');
  });
});

test('Grep: TOKENSLIM_DISABLE=grep suppresses output entirely', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_GREP, 'utf8');
    const payload = {
      session_id: 'sess-grep-disabled',
      tool_name: 'Grep',
      tool_input: {},
      tool_response: { mode: 'content', numFiles: 3, filenames: [], content, numLines: content.split('\n').length },
    };
    const result = run(GREP_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir, TOKENSLIM_DISABLE: 'grep' });
    assert.equal(result.stdout, '');
  });
});

test('Glob: >100 paths grouped by directory, metadata preserved verbatim', () => {
  withTempCache((cacheDir) => {
    const filenames = [];
    for (let i = 0; i < 150; i++) {
      const dir = i % 3 === 0 ? 'src/a' : i % 3 === 1 ? 'src/b' : 'src/c';
      filenames.push(`${dir}/file${i}.ts`);
    }
    const payload = {
      session_id: 'sess-glob-1',
      tool_name: 'Glob',
      tool_input: {},
      tool_response: {
        filenames,
        durationMs: 12345,
        numFiles: 150,
        truncated: false,
        totalMatches: 150,
        countIsComplete: true,
      },
    };
    const result = run(GREP_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir });
    const out = parseOutput(result);
    assert.ok(out, 'expected grouped output for a 150-path glob result');
    const updated = out.hookSpecificOutput.updatedToolOutput;
    assert.equal(updated.durationMs, 12345);
    assert.equal(updated.numFiles, 150);
    assert.equal(updated.totalMatches, 150);
    assert.equal(updated.truncated, false);
    assert.equal(updated.countIsComplete, true);
    assert.ok(updated.filenames.length < filenames.length);
    assert.ok(updated.filenames.every((s) => typeof s === 'string'));
    assert.ok(updated.filenames.some((s) => s.startsWith('src/a/')));
  });
});

test('Glob: <=100 paths pass through with no output', () => {
  withTempCache((cacheDir) => {
    const filenames = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
    const payload = {
      session_id: 'sess-glob-2',
      tool_name: 'Glob',
      tool_input: {},
      tool_response: { filenames, durationMs: 5, numFiles: 50, truncated: false, totalMatches: 50, countIsComplete: true },
    };
    const result = run(GREP_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir });
    assert.equal(result.stdout, '');
  });
});

test('savings ledger accumulates under the Grep bucket for both Grep and Glob', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_GREP, 'utf8');
    const grepPayload = {
      session_id: 'sess-ledger',
      tool_name: 'Grep',
      tool_input: {},
      tool_response: { mode: 'content', numFiles: 3, filenames: [], content, numLines: content.split('\n').length },
    };
    run(GREP_SCRIPT, grepPayload, { XDG_CACHE_HOME: cacheDir });

    const filenames = [];
    for (let i = 0; i < 150; i++) filenames.push(`src/dir${i % 4}/file${i}.ts`);
    const globPayload = {
      session_id: 'sess-ledger',
      tool_name: 'Glob',
      tool_input: {},
      tool_response: { filenames, durationMs: 1, numFiles: 150, truncated: false, totalMatches: 150, countIsComplete: true },
    };
    run(GREP_SCRIPT, globPayload, { XDG_CACHE_HOME: cacheDir });

    const statePath = join(cacheDir, 'tokenslim', 'sess-ledger.json');
    const state = JSON.parse(fsReadFileSync(statePath, 'utf8'));
    assert.equal(state.savings.Grep.events, 2);
    assert.ok(state.savings.Grep.bytesIn > 0);
  });
});
