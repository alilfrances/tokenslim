import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const READ_SCRIPT = join(__dirname, '..', 'scripts', 'compress-read.mjs');
const EDIT_SCRIPT = join(__dirname, '..', 'scripts', 'compress-edit.mjs');

function run(script, payload, extraEnv = {}) {
  return spawnSync('node', [script], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

function parseOutput(result) {
  if (!result.stdout) return undefined;
  return JSON.parse(result.stdout);
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-edit-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// file.content is the raw file text, no line-number prefixes (docs/SHAPES.md)
function readPayload(sessionId, filePath, content) {
  return {
    session_id: sessionId,
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    tool_response: {
      type: 'text',
      file: {
        filePath,
        content,
        numLines: content.split('\n').length,
        startLine: 1,
        totalLines: content.split('\n').length,
      },
    },
  };
}

function editPayload(sessionId, toolName, filePath) {
  return {
    session_id: sessionId,
    tool_name: toolName,
    tool_input: { file_path: filePath },
    tool_response: { ok: true },
  };
}

test('Edit with prior Read updates cache and later Read dedups under Edit ledger', () => {
  withTemp((dir) => {
    const cacheDir = join(dir, 'cache');
    const filePath = join(dir, 'subject.txt');
    writeFileSync(filePath, 'alpha\nbeta\n', 'utf8');

    const env = { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' };
    assert.equal(run(READ_SCRIPT, readPayload('sess-edit-prior', filePath, 'alpha\nbeta\n'), env).status, 0);

    writeFileSync(filePath, 'alpha\nBETA\n', 'utf8');
    assert.equal(run(EDIT_SCRIPT, editPayload('sess-edit-prior', 'Edit', filePath), env).status, 0);

    const second = run(READ_SCRIPT, readPayload('sess-edit-prior', filePath, 'alpha\nBETA\n'), env);
    const out = parseOutput(second);
    assert.match(out.hookSpecificOutput.updatedToolOutput.file.content, /unchanged since your last Edit\/Write/);

    const state = JSON.parse(readFileSync(join(cacheDir, 'tokenslim', 'sess-edit-prior.json'), 'utf8'));
    assert.equal(state.savings.Edit.events, 1);
    assert.equal(state.savings.Read, undefined);
  });
});

test('Edit without prior Read does not seed cache', () => {
  withTemp((dir) => {
    const cacheDir = join(dir, 'cache');
    const filePath = join(dir, 'subject.txt');
    writeFileSync(filePath, 'alpha\nbeta\n', 'utf8');

    const env = { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' };
    run(EDIT_SCRIPT, editPayload('sess-edit-none', 'Edit', filePath), env);
    const read = run(READ_SCRIPT, readPayload('sess-edit-none', filePath, 'alpha\nbeta\n'), env);
    const out = parseOutput(read);
    if (out) assert.doesNotMatch(out.hookSpecificOutput.updatedToolOutput.file.content, /last Edit\/Write/);
  });
});

test('Write seeds cache without prior Read', () => {
  withTemp((dir) => {
    const cacheDir = join(dir, 'cache');
    const filePath = join(dir, 'subject.txt');
    writeFileSync(filePath, 'new file\nbody\n', 'utf8');

    const env = { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' };
    run(EDIT_SCRIPT, editPayload('sess-write', 'Write', filePath), env);
    const read = run(READ_SCRIPT, readPayload('sess-write', filePath, 'new file\nbody\n'), env);
    const out = parseOutput(read);
    assert.match(out.hookSpecificOutput.updatedToolOutput.file.content, /unchanged since your last Edit\/Write/);
  });
});

test('Edit uses layered readDefaultLines config', () => {
  withTemp((dir) => {
    const cacheDir = join(dir, 'cache');
    const filePath = join(dir, 'subject.txt');
    writeFileSync(filePath, 'a\nb\nc\n', 'utf8');
    writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify({ readDefaultLines: 1 }), 'utf8');
    const event = { ...editPayload('sess-config-limit', 'Write', filePath), cwd: dir };
    run(EDIT_SCRIPT, event, { XDG_CACHE_HOME: cacheDir, XDG_CONFIG_HOME: join(dir, 'none') });
    const state = JSON.parse(readFileSync(join(cacheDir, 'tokenslim', 'sess-config-limit.json'), 'utf8'));
    assert.equal(state.reads[filePath], undefined);
  });
});

test('Edit skips oversized files and malformed stdin fails open', () => {
  withTemp((dir) => {
    const cacheDir = join(dir, 'cache');
    const filePath = join(dir, 'subject.txt');
    writeFileSync(filePath, 'a\nb\nc\n', 'utf8');

    const env = { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '1', TOKENSLIM_READ_DEFAULT_LINES: '1' };
    run(READ_SCRIPT, readPayload('sess-oversized', filePath, 'a\nb\nc\n'), env);
    run(EDIT_SCRIPT, editPayload('sess-oversized', 'Edit', filePath), env);
    const read = run(READ_SCRIPT, readPayload('sess-oversized', filePath, 'a\nb\nc\n'), env);
    const out = parseOutput(read);
    if (out) assert.doesNotMatch(out.hookSpecificOutput.updatedToolOutput.file.content, /last Edit\/Write/);

    const bad = run(EDIT_SCRIPT, 'not json {{{', env);
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, '');
  });
});
