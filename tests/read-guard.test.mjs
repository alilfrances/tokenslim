import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_SCRIPT = join(__dirname, '..', 'scripts', 'guard-read.mjs');

function run(payload, extraEnv = {}) {
  return spawnSync('node', [GUARD_SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-guard-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function payload(filePath, input = {}) {
  return {
    session_id: 'sess-guard',
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath, ...input },
  };
}

test('Read guard emits advisory additionalContext above line threshold', () => {
  withTemp((dir) => {
    const filePath = join(dir, 'large.txt');
    writeFileSync(filePath, 'x\n'.repeat(6), 'utf8');
    const result = run(payload(filePath), { TOKENSLIM_READ_GUARD_LINES: '5' });
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`${filePath} is 7 lines`));
    assert.match(out.hookSpecificOutput.additionalContext, /Consider offset\/limit or Grep/);
  });
});

test('Read guard honors project config while environment retains priority', () => {
  withTemp((dir) => {
    const filePath = join(dir, 'large.txt');
    writeFileSync(filePath, 'x\n'.repeat(6), 'utf8');
    writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify({ readGuardLines: 5 }), 'utf8');
    const configured = run({ ...payload(filePath), cwd: dir }, { HOME: dir, XDG_CONFIG_HOME: join(dir, 'missing') });
    assert.match(JSON.parse(configured.stdout).hookSpecificOutput.additionalContext, /7 lines/);
    const overridden = run({ ...payload(filePath), cwd: dir }, { HOME: dir, XDG_CONFIG_HOME: join(dir, 'missing'), TOKENSLIM_READ_GUARD_LINES: '10' });
    assert.equal(overridden.stdout, '');
  });
});

test('Read guard stays silent below threshold and when offset or limit is present', () => {
  withTemp((dir) => {
    const filePath = join(dir, 'small.txt');
    writeFileSync(filePath, 'x\n'.repeat(4), 'utf8');
    assert.equal(run(payload(filePath), { TOKENSLIM_READ_GUARD_LINES: '10' }).stdout, '');
    assert.equal(run(payload(filePath, { offset: 1 }), { TOKENSLIM_READ_GUARD_LINES: '1' }).stdout, '');
    assert.equal(run(payload(filePath, { limit: 2 }), { TOKENSLIM_READ_GUARD_LINES: '1' }).stdout, '');
  });
});

test('Read guard caps large-file counting and reports a lower bound', () => {
  withTemp((dir) => {
    const filePath = join(dir, 'huge.txt');
    // More than the guard's 5MB inspection cap; this exercises streaming rather
    // than loading the whole artifact into the hook process.
    writeFileSync(filePath, 'x\n'.repeat(2_700_000), 'utf8');
    const out = JSON.parse(run(payload(filePath), { TOKENSLIM_READ_GUARD_LINES: '9999999' }).stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /is >\d+ lines/);
  });
});

test('Read guard fails open for malformed stdin, missing files, and disable flag', () => {
  withTemp((dir) => {
    const filePath = join(dir, 'large.txt');
    writeFileSync(filePath, 'x\n'.repeat(6), 'utf8');
    assert.equal(run('not json {{{', { TOKENSLIM_READ_GUARD_LINES: '1' }).stdout, '');
    assert.equal(run(payload(join(dir, 'missing.txt')), { TOKENSLIM_READ_GUARD_LINES: '1' }).stdout, '');
    assert.equal(run(payload(filePath), {
      TOKENSLIM_READ_GUARD_LINES: '1',
      TOKENSLIM_DISABLE: 'readguard',
    }).stdout, '');
  });
});
