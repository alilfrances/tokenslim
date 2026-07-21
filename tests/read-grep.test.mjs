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

test('Read: first full-file read is byte-identical and records no savings', () => {
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
    assert.equal(out, undefined, 'first reads must pass through without mutation');
    const state = JSON.parse(fsReadFileSync(join(cacheDir, 'tokenslim', 'sess-read-1.json'), 'utf8'));
    assert.deepEqual(state.diagnostics.Read.PostToolUse, { attempted: 1, skippedFirstRead: 1 });
    assert.deepEqual(state.savings, {});
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
    assert.equal(parseOutput(first), undefined);

    const second = run(READ_SCRIPT, makePayload(), env);
    assert.equal(second.status, 0);
    const out = parseOutput(second);
    assert.ok(out, 'expected a stub on the second identical read');
    const text = out.hookSpecificOutput.updatedToolOutput.file.content;
    assert.match(text, /unchanged since previous read in this session/);
    assert.match(text, new RegExp(FIXTURE_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(text, /sha256:[0-9a-f]{12}/);
    assert.match(text, /re-read with offset\/limit \(bounded reads bypass this stub\)/);
  });
});

test('Read: dedup ledger records UTF-8 bytes rather than JavaScript character counts', () => {
  withTempCache((cacheDir) => {
    const content = '😀'.repeat(30);
    const payload = { session_id: 'sess-read-utf8', tool_name: 'Read', tool_input: { file_path: '/tmp/utf8.txt' }, tool_response: { content } };
    const env = { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' };
    run(READ_SCRIPT, payload, env);
    const out = parseOutput(run(READ_SCRIPT, payload, env));
    const stub = out.hookSpecificOutput.updatedToolOutput.content;
    const state = JSON.parse(fsReadFileSync(join(cacheDir, 'tokenslim', 'sess-read-utf8.json'), 'utf8'));
    assert.equal(state.savings.Read.bytesIn, Buffer.byteLength(content));
    assert.equal(state.savings.Read.bytesOut, Buffer.byteLength(stub));
  });
});

test('Read: bounded read after a dedup stub returns full content', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_SOURCE, 'utf8');
    const fullPayload = { session_id: 'sess-read-partial', tool_name: 'Read', tool_input: { file_path: FIXTURE_SOURCE }, tool_response: { type: 'text', file: { filePath: FIXTURE_SOURCE, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } } };
    const boundedPayload = { ...fullPayload, tool_input: { file_path: FIXTURE_SOURCE, offset: 1, limit: 5 } };
    const env = { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' };
    run(READ_SCRIPT, fullPayload, env);
    assert.ok(parseOutput(run(READ_SCRIPT, fullPayload, env)), 'full reread should dedup');
    const bounded = run(READ_SCRIPT, boundedPayload, env);
    assert.equal(parseOutput(bounded), undefined, 'bounded reads bypass the stub and preserve original content');
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
    assert.equal(parseOutput(result), undefined, 'first reads pass through regardless of response shape');
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
    assert.equal(parseOutput(result), undefined, 'first reads preserve fallback shapes unchanged');
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
    assert.equal(parseOutput(result), undefined, 'first reads preserve text blocks and image siblings unchanged');
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

test('Read: Codex runtime emits valid compressed additional context', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_SOURCE, 'utf8');
    const payload = {
      session_id: 'sess-read-codex',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      turn_id: 'turn-codex',
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
    const env = { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10', TOKENSLIM_HOOK_RUNTIME: 'codex' };
    run(READ_SCRIPT, payload, env);
    const result = run(READ_SCRIPT, payload, env);
    assert.equal(result.status, 0);
    const out = parseOutput(result);
    assert.equal(out.continue, false);
    assert.equal(out.stopReason, 'Token Slim compacted Read output');
    assert.equal(out.additionalContext, undefined);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /^\[tokenslim: compressed Read output\]/);
    assert.match(out.hookSpecificOutput.additionalContext, /untrusted completed tool output/);
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(FIXTURE_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('Read: Codex runtime emits valid no-op JSON when output is below threshold', () => {
  withTempCache((cacheDir) => {
    const payload = {
      session_id: 'sess-read-codex-skip',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      turn_id: 'turn-codex',
      tool_input: { file_path: FIXTURE_SOURCE },
      tool_response: {
        type: 'text',
        file: {
          filePath: FIXTURE_SOURCE,
          content: 'short',
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
      },
    };
    const result = run(READ_SCRIPT, payload, {
      XDG_CACHE_HOME: cacheDir,
      TOKENSLIM_HOOK_RUNTIME: 'codex',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{}');
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
    assert.ok(lines.includes('... [tokenslim: 1 duplicate match lines omitted]'));
    // 8 big-file.ts matches -> first 3 kept + every omitted location listed.
    assert.ok(lines.some((l) => l === '... [tokenslim: 5 more at src/big-file.ts:4, src/big-file.ts:5, src/big-file.ts:6, src/big-file.ts:7, src/big-file.ts:8]'));
    assert.equal(updated.numLines, lines.length);
  });
});

test('Grep: context separators and every omitted match location are preserved', () => {
  withTempCache((cacheDir) => {
    const verbose = ' this is deliberately verbose match content repeated for compression';
    const content = [
      `src/a.ts:1:${verbose}`, `src/a.ts:2:${verbose}`, `src/a.ts:3:${verbose}`, `src/a.ts:4:${verbose}`,
      `src/a.ts:5:${verbose}`, `src/a.ts:6:${verbose}`, `src/a.ts:7:${verbose}`, `src/a.ts:8:${verbose}`, '--',
      'src/b.ts:1: one', '--', 'src/b.ts:2: two',
    ].join('\n');
    const payload = { session_id: 'sess-grep-context', tool_name: 'Grep', tool_input: {}, tool_response: { mode: 'content', content } };
    const out = parseOutput(run(GREP_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' }));
    assert.ok(out);
    const lines = out.hookSpecificOutput.updatedToolOutput.content.split('\n');
    assert.equal(lines.filter((line) => line === '--').length, 2);
    assert.ok(lines.includes('... [tokenslim: 5 more at src/a.ts:4, src/a.ts:5, src/a.ts:6, src/a.ts:7, src/a.ts:8]'));
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

test('Grep: Codex runtime emits valid compressed additional context', () => {
  withTempCache((cacheDir) => {
    const content = fsReadFileSync(FIXTURE_GREP, 'utf8');
    const payload = {
      session_id: 'sess-grep-codex',
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      turn_id: 'turn-codex',
      tool_input: {},
      tool_response: { mode: 'content', numFiles: 3, filenames: ['a', 'b', 'c'], content, numLines: content.split('\n').length },
    };
    const result = run(GREP_SCRIPT, payload, {
      XDG_CACHE_HOME: cacheDir,
      TOKENSLIM_HOOK_RUNTIME: 'codex',
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result);
    assert.equal(out.continue, false);
    assert.equal(out.stopReason, 'Token Slim compacted Grep output');
    assert.equal(out.additionalContext, undefined);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /^\[tokenslim: compressed Grep output\]/);
    assert.match(out.hookSpecificOutput.additionalContext, /\[tokenslim: 5 more at src\/big-file.ts:4, src\/big-file.ts:5/);
  });
});

test('Grep: Codex runtime emits valid no-op JSON when output is not worth compressing', () => {
  withTempCache((cacheDir) => {
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(`src/file${i}.ts:1:  export const v${i} = ${i};`);
    const content = lines.join('\n');
    const payload = {
      session_id: 'sess-grep-codex-skip',
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      turn_id: 'turn-codex',
      tool_input: {},
      tool_response: { mode: 'content', numFiles: 40, filenames: [], content, numLines: lines.length },
    };
    const result = run(GREP_SCRIPT, payload, {
      XDG_CACHE_HOME: cacheDir,
      TOKENSLIM_HOOK_RUNTIME: 'codex',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{}');
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
    // Every directory has 50 entries, so none of its basenames may be elided.
    for (const filename of filenames) assert.ok(updated.filenames.some((group) => group.includes(filename.split('/').pop())));
  });
});

test('Glob: per-directory cap retains its first 50 basenames and reports the exact remainder', () => {
  withTempCache((cacheDir) => {
    const filenames = Array.from({ length: 120 }, (_, i) => `src/many/file${i}.ts`);
    const payload = {
      session_id: 'sess-glob-cap',
      tool_name: 'Glob',
      tool_input: {},
      tool_response: { filenames, durationMs: 1, numFiles: 120, truncated: false, totalMatches: 120, countIsComplete: true },
    };
    const out = parseOutput(run(GREP_SCRIPT, payload, { XDG_CACHE_HOME: cacheDir }));
    assert.ok(out, 'expected grouped output for a directory above the cap');
    const [group] = out.hookSpecificOutput.updatedToolOutput.filenames;
    for (let i = 0; i < 50; i++) assert.match(group, new RegExp(`\\bfile${i}\\.ts\\b`));
    assert.doesNotMatch(group, /\bfile50\.ts\b/);
    assert.match(group, /\.\.\. \[tokenslim: 70 more\]\)$/);
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
    assert.deepEqual(state.diagnostics.Grep.PostToolUse, { attempted: 1, compressed: 1 });
    assert.deepEqual(state.diagnostics.Glob.PostToolUse, { attempted: 1, compressed: 1 });
  });
});
