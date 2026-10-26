import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers.mjs';
import { preToolUseDenyOutput } from '../scripts/lib/hook-output.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_SCRIPT = join(__dirname, '..', 'scripts', 'guard-read.mjs');

function run(payload, extraEnv = {}) {
  const iso = isolatedEnv(extraEnv);
  try {
    return spawnSync('node', [GUARD_SCRIPT], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      env: iso.env,
    });
  } finally { iso.cleanup(); }
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

// --- readGuard modes -------------------------------------------------------------------------------

// A shared isolated env so the deny escape hatch can be observed across consecutive hook runs.
function session(fn) {
  const iso = isolatedEnv();
  const run = (input, extraEnv = {}) => spawnSync('node', [GUARD_SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...iso.env, ...extraEnv },
  });
  try {
    return fn(run, iso);
  } finally { iso.cleanup(); }
}

const DENY = { TOKENSLIM_READ_GUARD_MODE: 'deny' };

function bigJs(path, functions = 100, bodyLines = 28) {
  const parts = [];
  for (let i = 0; i < functions; i += 1) {
    parts.push(`function f${i}() {`);
    for (let j = 0; j < bodyLines; j += 1) parts.push(`  const v${j} = ${i};`);
    parts.push('}');
  }
  writeFileSync(path, `${parts.join('\n')}\n`, 'utf8');
}

test('advise at the default config is byte-identical and does no state I/O', () => {
  withTemp((dir) => session((run, iso) => {
    const filePath = join(dir, 'large.txt');
    writeFileSync(filePath, 'x\n'.repeat(6), 'utf8');
    const result = run(payload(filePath), { TOKENSLIM_READ_GUARD_LINES: '5' });
    assert.equal(result.stdout, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `[tokenslim] ${filePath} is 7 lines (~4 tokens). Consider offset/limit or Grep.`,
      },
    }));
    const big = join(dir, 'big.js');
    bigJs(big);
    const advised = JSON.parse(run(payload(big)).stdout);
    assert.equal(advised.hookSpecificOutput.permissionDecision, undefined);
    assert.match(advised.hookSpecificOutput.additionalContext, /big\.js is 3001 lines/);
    assert.equal(existsSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim')), false);
  }));
});

test('deny mode refuses a big unbounded .js Read with size, outline and the escape instruction', () => {
  withTemp((dir) => session((run) => {
    const filePath = join(dir, 'big.js');
    bigJs(filePath);
    const result = run(payload(filePath), DENY);
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, new RegExp(`${filePath} is 3000 lines, \\d+ KB \\(~\\d+ tokens\\)`));
    const entries = reason.split('\n').filter((line) => /^L\d+-L\d+  /.test(line));
    assert.equal(entries.length, 40);
    assert.equal(entries[0], 'L1-L30  function f0()');
    assert.equal(entries[1], 'L31-L60  function f1()');
    assert.equal(entries[39], 'L1171-L1200  function f39()');
    assert.match(reason, /\n… 60 more\n/);
    assert.match(reason, /Re-read with offset\/limit for the section you need\. Repeating this exact Read will return the full file\.$/);
  }));
});

test('deny escape hatch: the repeat is allowed silently, then a new cycle starts', () => {
  withTemp((dir) => session((run) => {
    const filePath = join(dir, 'big.js');
    bigJs(filePath);
    const denied = (result) => JSON.parse(result.stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny';
    assert.equal(denied(run(payload(filePath), DENY)), true);
    const second = run(payload(filePath), DENY);
    assert.equal(second.stdout, '');
    assert.equal(second.status, 0);
    // The entry was consumed by the allow, so a later unbounded Read is a fresh first Read.
    assert.equal(denied(run(payload(filePath), DENY)), true);
    assert.equal(run(payload(filePath), DENY).stdout, '');
    // A different path or session has its own cycle.
    const other = join(dir, 'other.js');
    bigJs(other);
    assert.equal(denied(run(payload(other), DENY)), true);
    assert.equal(denied(run({ ...payload(filePath), session_id: 'sess-other' }, DENY)), true);
  }));
});

test('deny state holds only a sha256 of the path, never the path itself', () => {
  withTemp((dir) => session((run, iso) => {
    const filePath = join(dir, 'secret-project-name.js');
    bigJs(filePath);
    run(payload(filePath), DENY);
    const cache = join(iso.env.XDG_CACHE_HOME, 'tokenslim');
    const files = readdirSync(cache).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 1);
    const text = readFileSync(join(cache, files[0]), 'utf8');
    const state = JSON.parse(text);
    const keys = Object.keys(state.guardDenied);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^[0-9a-f]{64}$/);
    assert.equal(text.includes('secret-project-name'), false);
    assert.equal(text.includes(dir), false);
  }));
});

test('deny mode leaves bounded Reads, small files and non-text files alone', () => {
  withTemp((dir) => session((run, iso) => {
    const filePath = join(dir, 'big.js');
    bigJs(filePath);
    assert.equal(run(payload(filePath, { offset: 10 }), DENY).stdout, '');
    assert.equal(run(payload(filePath, { limit: 50 }), DENY).stdout, '');
    const small = join(dir, 'small.js');
    writeFileSync(small, 'x\n'.repeat(10), 'utf8');
    assert.equal(run(payload(small), DENY).stdout, '');
    assert.equal(existsSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim')), false, 'none of these should touch state');

    // Over the threshold but never denied: images, PDFs, notebooks, archives, binaries, minified bundles.
    for (const name of ['shot.png', 'doc.pdf', 'nb.ipynb', 'bundle.zip', 'tool.bin', 'app.min.js', 'data.csv', 'noext']) {
      const path = join(dir, name);
      writeFileSync(path, 'x\n'.repeat(2500), 'utf8');
      const out = JSON.parse(run(payload(path), DENY).stdout);
      assert.equal(out.hookSpecificOutput.permissionDecision, undefined, name);
      assert.match(out.hookSpecificOutput.additionalContext, /Consider offset\/limit or Grep/, name);
    }
  }));
});

test('deny mode covers extensionless build files and gives a size line only for languages without an outline', () => {
  withTemp((dir) => session((run) => {
    for (const name of ['Makefile', 'Dockerfile', 'main.go']) {
      const path = join(dir, name);
      writeFileSync(path, 'all: x\n'.repeat(2500), 'utf8');
      const reason = JSON.parse(run(payload(path), DENY).stdout).hookSpecificOutput.permissionDecisionReason;
      assert.match(reason, /lines, \d+ KB/, name);
      assert.doesNotMatch(reason, /Outline:/, name);
      assert.match(reason, /Re-read with offset\/limit/, name);
    }
  }));
});

test('deny mode falls back to the advise output on Codex and without a session id', () => {
  withTemp((dir) => session((run, iso) => {
    const filePath = join(dir, 'big.js');
    bigJs(filePath);
    const viaEnv = JSON.parse(run(payload(filePath), { ...DENY, TOKENSLIM_HOOK_RUNTIME: 'codex' }).stdout);
    assert.equal(viaEnv.hookSpecificOutput.permissionDecision, undefined);
    assert.match(viaEnv.hookSpecificOutput.additionalContext, /Consider offset\/limit or Grep/);
    const viaTurn = JSON.parse(run({ ...payload(filePath), turn_id: 't1' }, DENY).stdout);
    assert.equal(viaTurn.hookSpecificOutput.permissionDecision, undefined);
    assert.match(viaTurn.hookSpecificOutput.additionalContext, /big\.js is 3001 lines/);
    const { session_id, ...anonymous } = payload(filePath);
    assert.match(JSON.parse(run(anonymous, DENY).stdout).hookSpecificOutput.additionalContext, /Consider offset/);
    assert.equal(existsSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim')), false);
  }));
});

test('bytes threshold triggers on size even when the line count is low', () => {
  withTemp((dir) => session((run) => {
    const filePath = join(dir, 'wide.txt');
    writeFileSync(filePath, `${'y'.repeat(4000)}\n`.repeat(3), 'utf8');
    assert.equal(run({ ...payload(filePath), cwd: dir }).stdout, '', 'bytes 0 means unused');
    writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify({ readGuard: { bytes: 10000 } }), 'utf8');
    const hit = JSON.parse(run({ ...payload(filePath), cwd: dir }).stdout);
    assert.match(hit.hookSpecificOutput.additionalContext, /wide\.txt is 4 lines/);
    writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify({ readGuard: { bytes: 20000 } }), 'utf8');
    assert.equal(run({ ...payload(filePath), cwd: dir }).stdout, '', 'under the byte threshold and the line threshold');
    // Either threshold alone is enough: lines exceeded while bytes are not.
    writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify({ readGuard: { bytes: 20000, lines: 2 } }), 'utf8');
    assert.match(JSON.parse(run({ ...payload(filePath), cwd: dir }).stdout).hookSpecificOutput.additionalContext, /wide\.txt/);
  }));
});

test('deny honors the bytes threshold and project-level mode config', () => {
  withTemp((dir) => session((run) => {
    const filePath = join(dir, 'dense.md');
    writeFileSync(filePath, `# One\n${'text '.repeat(3000)}\n## Two\nmore\n`, 'utf8');
    writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify({ readGuard: { mode: 'deny', bytes: 8000 } }), 'utf8');
    const out = JSON.parse(run({ ...payload(filePath), cwd: dir }).stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /L1-L2  # One\nL3-L4  ## Two\n/);
  }));
});

test('readGuard mode off, readguard disable flag and the legacy lines alias all behave', () => {
  withTemp((dir) => session((run) => {
    const filePath = join(dir, 'big.js');
    bigJs(filePath);
    assert.equal(run(payload(filePath), { TOKENSLIM_READ_GUARD_MODE: 'off' }).stdout, '');
    assert.equal(run(payload(filePath), { ...DENY, TOKENSLIM_DISABLE: 'readguard' }).stdout, '');
    assert.equal(run(payload(filePath), { TOKENSLIM_READ_GUARD_MODE: 'bogus' }).stdout.includes('additionalContext'), true, 'invalid mode is ignored');
    // Legacy alias raises the threshold above the file length: silent in deny mode too.
    assert.equal(run(payload(filePath), { ...DENY, TOKENSLIM_READ_GUARD_LINES: '5000' }).stdout, '');
    const lowered = JSON.parse(run(payload(filePath), { ...DENY, TOKENSLIM_READ_GUARD_LINES: '100' }).stdout);
    assert.equal(lowered.hookSpecificOutput.permissionDecision, 'deny');
  }));
});

test('deny fails open: unreadable paths, unwritable state and malformed input produce no output', () => {
  withTemp((dir) => session((run) => {
    // A directory with a text extension: stat works, reading throws.
    const asDir = join(dir, 'weird.js');
    mkdirSync(asDir);
    assert.equal(run(payload(asDir), { ...DENY, TOKENSLIM_READ_GUARD_LINES: '0' }).stdout, '');
    const locked = join(dir, 'locked.js');
    bigJs(locked);
    chmodSync(locked, 0o000);
    try {
      // root ignores file modes, so only assert where the permission is actually enforced
      if (process.getuid?.() !== 0) assert.equal(run(payload(locked), DENY).stdout, '');
    } finally { chmodSync(locked, 0o644); }
    assert.equal(run('{{not json', DENY).stdout, '');

    // If the escape-hatch entry cannot be recorded, denying would block the Read for good: stay silent.
    const filePath = join(dir, 'big.js');
    bigJs(filePath);
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'file', 'utf8');
    const result = run(payload(filePath), { ...DENY, XDG_CACHE_HOME: blocker });
    assert.equal(result.stdout, '');
    assert.equal(result.status, 0);
  }));
});

test('preToolUseDenyOutput uses the documented PreToolUse deny shape', () => {
  assert.deepEqual(preToolUseDenyOutput({}, 'because'), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'because' },
  });
});
