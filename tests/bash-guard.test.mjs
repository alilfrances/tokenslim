import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache, loadConfig } from '../scripts/lib/config.mjs';
import { loadHistory, updateHistory } from '../scripts/lib/history.mjs';
import { shareEntries } from '../scripts/lib/bash-guard.mjs';
import { loadState, recordBashGuard, saveState } from '../scripts/lib/state.mjs';
import { isolatedEnv } from './helpers.mjs';

const root = join(import.meta.dirname, '..');
const hookScript = join(root, 'scripts/rewrite-bash.mjs');
const statsScript = join(root, 'scripts/stats.mjs');
const SESSION = 'guard-session';

const jsSource = (count, prefix = 'fn') => Array.from({ length: count }, (_, i) => `function ${prefix}${i}(x) { return x + ${i}; }`).join('\n') + '\n';
const pySource = (count) => Array.from({ length: count }, (_, i) => `def handler${i}(x):\n    return x`).join('\n') + '\n';

// A throwaway project: files (relative path -> content) under a fresh directory with an unusual name.
function workspace(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-bg-zephyr-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function payload(command, cwd, extra = {}) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: SESSION, cwd, tool_input: { command }, ...extra };
}
function hook(iso, body) {
  return spawnSync(process.execPath, [hookScript], { input: typeof body === 'string' ? body : JSON.stringify(body), encoding: 'utf8', env: iso.env });
}
function stats(iso, args = []) {
  return spawnSync(process.execPath, [statsScript, ...args], { encoding: 'utf8', env: iso.env });
}
const cacheDir = (iso) => join(iso.env.XDG_CACHE_HOME, 'tokenslim');
const ledgerPath = (iso, session = SESSION) => join(cacheDir(iso), `${session}.json`);
const ledger = (iso, session = SESSION) => JSON.parse(readFileSync(ledgerPath(iso, session), 'utf8'));
const historyPath = (iso) => join(iso.env.XDG_DATA_HOME, 'tokenslim', 'history.json');
const history = (iso) => JSON.parse(readFileSync(historyPath(iso), 'utf8'));
const today = () => new Date().toISOString().slice(0, 10);
const deny = (result) => JSON.parse(result.stdout).hookSpecificOutput;

function withHook(env, files, fn) {
  const iso = isolatedEnv(env);
  const ws = workspace(files);
  try { return fn(iso, ws); } finally { iso.cleanup(); ws.cleanup(); }
}

// --- shadow (default) ---------------------------------------------------------------------------

test('default config is shadow: a big cat prints nothing and only counts, with no command, path or name in state', () => {
  withHook({}, { 'quasar-engine.js': jsSource(600) }, (iso, ws) => {
    const result = hook(iso, payload('cat quasar-engine.js', ws.dir));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    const size = Buffer.byteLength(jsSource(600));
    const guard = ledger(iso).bashGuard;
    assert.deepEqual(guard, { wouldDeny: 1, wouldDenyBytes: size, le800: 1 });
    assert.deepEqual(history(iso).days[today()].bashGuard, { wouldDeny: 1, wouldDenyBytes: size, le800: 1 });
    assert.equal(ledger(iso).guardDenied, undefined, 'shadow never records an escape-hatch entry');
    for (const file of [ledgerPath(iso), historyPath(iso)]) {
      const text = readFileSync(file, 'utf8');
      for (const secret of ['quasar', 'engine', 'zephyr', ws.dir, 'cat ']) assert.equal(text.includes(secret), false, `${secret} must not be persisted`);
    }
    hook(iso, payload('cat quasar-engine.js', ws.dir));
    assert.equal(ledger(iso).bashGuard.wouldDeny, 2, 'every dump is counted, shadow has no escape hatch');
  });
});

test('shadow size buckets: <=800, 801-2000 and >2000 total lines, plus byte sums', () => {
  withHook({}, { 'a.js': jsSource(500), 'b.js': jsSource(1200), 'c.js': jsSource(2600) }, (iso, ws) => {
    for (const name of ['a.js', 'b.js', 'c.js']) assert.equal(hook(iso, payload(`cat ${name}`, ws.dir)).stdout, '');
    const guard = ledger(iso).bashGuard;
    assert.deepEqual([guard.wouldDeny, guard.le800, guard.le2000, guard.gt2000], [3, 1, 1, 1]);
    assert.equal(guard.wouldDenyBytes, [500, 1200, 2600].reduce((sum, count) => sum + Buffer.byteLength(jsSource(count)), 0));
  });
});

test('exactly the threshold is not over it; a bytes threshold triggers on its own; head -n sizes what it prints', () => {
  withHook({}, { 'f.js': jsSource(400), 'g.js': jsSource(450), 'big.js': jsSource(1000) }, (iso, ws) => {
    hook(iso, payload('cat f.js', ws.dir));
    assert.equal(existsSync(cacheDir(iso)), false, '400 lines of 400 is at the threshold, not over');
    hook(iso, payload('head -n 500 g.js', ws.dir));
    assert.equal(ledger(iso).bashGuard.wouldDeny, 1, 'min(500, 450) = 450 lines is over');
    hook(iso, payload('head -n 400 big.js', ws.dir));
    assert.equal(ledger(iso).bashGuard.wouldDeny, 1, 'head -n 400 of a 1000-line file prints 400 lines');
    hook(iso, payload('head -n 600 big.js', ws.dir));
    assert.equal(ledger(iso).bashGuard.wouldDeny, 2, 'head -n 600 prints 600 lines');
  });
  withHook({}, { 'f.js': jsSource(30) }, (iso, ws) => {
    writeFileSync(join(ws.dir, '.tokenslim.json'), JSON.stringify({ bashGuard: { lines: 100000, bytes: 1000 } }));
    hook(iso, payload('cat f.js', ws.dir));
    assert.equal(ledger(iso).bashGuard.wouldDeny, 1, `${Buffer.byteLength(jsSource(30))} bytes is over a 1000-byte threshold`);
  });
  withHook({}, { 'f.js': jsSource(30) }, (iso, ws) => {
    writeFileSync(join(ws.dir, '.tokenslim.json'), JSON.stringify({ bashGuard: { lines: 10 } }));
    hook(iso, payload('cat f.js', ws.dir));
    assert.equal(ledger(iso).bashGuard.wouldDeny, 1, 'a lower lines threshold from config');
  });
});

// --- deny ---------------------------------------------------------------------------------------

const DENY = { TOKENSLIM_BASH_GUARD_MODE: 'deny' };

test('deny: first dump is refused with an outline, the identical repeat is allowed, the third starts a new cycle', () => {
  withHook(DENY, { 'engine.js': jsSource(600) }, (iso, ws) => {
    const command = payload('cat engine.js', ws.dir);
    const first = hook(iso, command);
    assert.equal(first.status, 0);
    const output = deny(first);
    assert.equal(output.hookEventName, 'PreToolUse');
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /^\[tokenslim\] engine\.js is 600 lines, \d+ KB \(~\d+ tokens\); the full output was held back\.\nOutline:\nL1-L1  function fn0/);
    assert.match(output.permissionDecisionReason, /Repeating this exact command returns the full output\.$/);
    assert.equal(hook(iso, command).stdout, '', 'the repeat is allowed silently');
    assert.equal(deny(hook(iso, command)).permissionDecision, 'deny', 'a third attempt is a new cycle');
    assert.deepEqual(ledger(iso).bashGuard, { denied: 2, repeated: 1 });
    assert.deepEqual(history(iso).days[today()].bashGuard, { denied: 2, repeated: 1 });
    // The escape hatch is keyed per command: another command is its own first time.
    assert.equal(deny(hook(iso, payload('nl engine.js', ws.dir))).permissionDecision, 'deny');
  });
});

test('deny works with rewrites off (the default) and persists no command, path or file name', () => {
  withHook(DENY, { 'orbit-solver.js': jsSource(600) }, (iso, ws) => {
    assert.equal(deny(hook(iso, payload('cat orbit-solver.js', ws.dir))).permissionDecision, 'deny');
    hook(iso, payload('cat orbit-solver.js', ws.dir));
    for (const file of [ledgerPath(iso), historyPath(iso)]) {
      const text = readFileSync(file, 'utf8');
      for (const secret of ['orbit', 'solver', 'zephyr', ws.dir, 'cat ']) assert.equal(text.includes(secret), false, `${secret} must not be persisted`);
    }
  });
});

test('deny: a multi-file dump gets one outline section per file (basename headers) and at most 40 entries in all', () => {
  withHook(DENY, { 'a.js': jsSource(300), 'lib/b.py': pySource(300), 'c.js': jsSource(5, 'tiny') }, (iso, ws) => {
    const reason = deny(hook(iso, payload('cat a.js lib/b.py c.js', ws.dir))).permissionDecisionReason;
    assert.match(reason, /^\[tokenslim\] combined output of 3 files is \d+ lines, \d+ KB .*the full output was held back\./);
    const headers = reason.split('\n').filter((line) => line.startsWith('== '));
    assert.deepEqual(headers.map((line) => line.split(':')[0]), ['== a.js', '== b.py', '== c.js'], 'basenames only, in command order');
    assert.equal(reason.includes('lib/'), false);
    const entries = reason.split('\n').filter((line) => /^L\d+-L\d+ {2}/.test(line));
    assert.equal(entries.length, 40, 'the budget is used in full when the files have enough entries');
    assert.ok(entries.some((line) => line.includes('handler0')) && entries.some((line) => line.includes('fn0')) && entries.some((line) => line.includes('tiny0')), 'every file is represented');
    assert.match(reason, /… \d+ more/);
    assert.equal(hook(iso, payload('cat a.js lib/b.py c.js', ws.dir)).stdout, '', 'repeat is allowed');
    assert.deepEqual(ledger(iso).bashGuard, { denied: 1, repeated: 1 });
  });
});

test('deny: chains with echo separators and head are multi-file dumps; unknown languages still get a header', () => {
  withHook(DENY, { 'a.js': jsSource(250), 'notes.txt': 'line\n'.repeat(300) }, (iso, ws) => {
    const reason = deny(hook(iso, payload('cat a.js; echo ---; head -n 500 notes.txt', ws.dir))).permissionDecisionReason;
    assert.match(reason, /== a\.js: 250 lines/);
    assert.match(reason, /== notes\.txt: 300 lines/);
  });
});

test('deny: `cd X && cat f` resolves f against cwd/X, also for multi-file dumps', () => {
  withHook(DENY, { 'sub/f.js': jsSource(600), 'sub/g.js': jsSource(600, 'other') }, (iso, ws) => {
    assert.equal(deny(hook(iso, payload('cd sub && cat f.js', ws.dir))).permissionDecision, 'deny');
    assert.equal(hook(iso, payload('cat f.js', ws.dir)).stdout, '', 'not a dump of anything from the top directory');
    assert.equal(deny(hook(iso, payload('cd sub && cat f.js g.js', ws.dir))).permissionDecision, 'deny');
    assert.equal(deny(hook(iso, payload('cd "sub" ; cat f.js', ws.dir))).permissionDecision, 'deny');
    assert.equal(hook(iso, payload('cd nope && cat f.js', ws.dir)).stdout, '');
    assert.equal(hook(iso, payload('cd $HOME && cat f.js', ws.dir)).stdout, '');
  });
});

test('deny: an absolute path works from any cwd and the escape hatch is per cwd', () => {
  withHook(DENY, { 'f.js': jsSource(600) }, (iso, ws) => {
    const abs = join(ws.dir, 'f.js');
    assert.equal(deny(hook(iso, payload(`cat ${abs}`, tmpdir()))).permissionDecision, 'deny');
    assert.equal(deny(hook(iso, payload(`cat ${abs}`, ws.dir))).permissionDecision, 'deny', 'a different cwd is a different key');
    assert.equal(hook(iso, payload(`cat ${abs}`, ws.dir)).stdout, '');
  });
});

test('deny + rewrites: the guard wins over a rewrite opt-in; shadow leaves rewrites exactly as before', () => {
  withHook({ ...DENY, TOKENSLIM_REWRITE_ENABLED: 'true' }, { 'f.js': jsSource(600) }, (iso, ws) => {
    assert.equal(deny(hook(iso, payload('cat f.js', ws.dir))).permissionDecision, 'deny');
    const rewritten = deny(hook(iso, payload('npm install', ws.dir)));
    assert.equal(rewritten.permissionDecision, 'allow', 'non-dump commands still get the opt-in rewrite');
    assert.match(rewritten.updatedInput.command, /^npm install --loglevel=error/);
  });
  withHook({ TOKENSLIM_REWRITE_ENABLED: 'true' }, { 'f.js': jsSource(600) }, (iso, ws) => {
    const rewritten = deny(hook(iso, payload('npm ci', ws.dir, { tool_input: { command: 'npm ci', description: 'install' } })));
    assert.deepEqual(rewritten, { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'tokenslim quiet-rewrite: npm-quiet', updatedInput: { command: 'npm ci --loglevel=error --no-fund --no-audit', description: 'install' } });
    assert.equal(hook(iso, payload('cat f.js', ws.dir)).stdout, '', 'shadow: a dump prints nothing even with rewrites on');
    assert.equal(ledger(iso).bashGuard.wouldDeny, 1);
    assert.equal(existsSync(ledgerPath(iso)) && ledger(iso).guardDenied !== undefined, false);
  });
});

test('deny on Codex or without a session id: silent, counted as skippedRuntime only', () => {
  withHook(DENY, { 'f.js': jsSource(600) }, (iso, ws) => {
    const codex = hook(iso, payload('cat f.js', ws.dir, { turn_id: 'turn-1' }));
    assert.equal(codex.status, 0);
    assert.equal(codex.stdout, '');
    assert.deepEqual(ledger(iso).bashGuard, { skippedRuntime: 1 });
    const bare = payload('cat f.js', ws.dir);
    delete bare.session_id;
    assert.equal(hook(iso, bare).stdout, '');
    assert.deepEqual(ledger(iso, 'unknown').bashGuard, { skippedRuntime: 1 });
    assert.deepEqual(history(iso).days[today()].bashGuard, { skippedRuntime: 2 });
    assert.equal(hook(iso, payload('cat f.js', ws.dir, { turn_id: 'turn-2' })).stdout, '', 'never denied, so never needs an escape hatch');
  });
  // The same payload from Claude is denied.
  withHook(DENY, { 'f.js': jsSource(600) }, (iso, ws) => {
    assert.equal(deny(hook(iso, payload('cat f.js', ws.dir))).permissionDecision, 'deny');
  });
  // Codex in shadow mode records like any shadow hit.
  withHook({}, { 'f.js': jsSource(600) }, (iso, ws) => {
    assert.equal(hook(iso, payload('cat f.js', ws.dir, { turn_id: 'turn-1' })).stdout, '');
    assert.equal(ledger(iso).bashGuard.wouldDeny, 1);
  });
});

// --- non-triggers ---------------------------------------------------------------------------------

test('non-dumps and non-triggers print nothing and perform no state I/O, in shadow and in deny', () => {
  const files = { 'f.js': jsSource(600), 'small.js': jsSource(20), 'a.png': 'x\n'.repeat(900), 'data.log': 'x\n'.repeat(900), 'dir/keep.js': '' };
  const commands = [
    'ls', 'ls -la', 'git status', 'echo hello', 'npm test', 'git log | head -n 500', 'cat small.js', 'cat f.js | grep x', 'cat a.png', 'cat data.log', 'cat missing.js',
    'cat dir/', 'cat dir', "sed -n '10,20p' f.js", 'head -n 50 f.js', 'tail -n 5 f.js', 'cat f.js > copy.js', 'cat *.js', 'cat $FILE', 'cat f.js small.js missing.js',
    'cat f.js a.png', 'cat f.js dir', 'cat f.js; ls', 'grep -n fn f.js', 'sed -n 1,5p f.js', 'cat -', 'cat', '',
  ];
  for (const env of [{}, DENY]) {
    withHook(env, files, (iso, ws) => {
      for (const command of commands) {
        const result = hook(iso, payload(command, ws.dir));
        assert.equal(result.status, 0, command);
        assert.equal(result.stdout, '', command);
        assert.equal(result.stderr, '', command);
      }
      assert.equal(existsSync(cacheDir(iso)), false, 'no cache dir: no state was loaded or saved');
      assert.equal(existsSync(iso.env.XDG_DATA_HOME), false, 'no history written');
    });
  }
});

test('a non-dump command does no state I/O even with a populated cache dir (state file untouched)', () => {
  withHook({}, { 'f.js': jsSource(600) }, (iso, ws) => {
    hook(iso, payload('cat f.js', ws.dir));
    const before = readFileSync(ledgerPath(iso), 'utf8');
    const mtime = (path) => readFileSync(path, 'utf8');
    for (const command of ['ls', 'git diff', 'cat small-missing.js']) hook(iso, payload(command, ws.dir));
    assert.equal(mtime(ledgerPath(iso)), before);
    assert.deepEqual(readdirSync(cacheDir(iso)), [`${SESSION}.json`]);
  });
});

test('a symlink to a big text file is a regular file and counts; a symlinked directory does not', () => {
  withHook({}, { 'real.js': jsSource(600), 'd/x.js': 'x\n' }, (iso, ws) => {
    symlinkSync(join(ws.dir, 'real.js'), join(ws.dir, 'link.js'));
    symlinkSync(join(ws.dir, 'd'), join(ws.dir, 'dlink'));
    hook(iso, payload('cat link.js', ws.dir));
    assert.equal(ledger(iso).bashGuard.wouldDeny, 1);
    hook(iso, payload('cat dlink', ws.dir));
    assert.equal(ledger(iso).bashGuard.wouldDeny, 1);
  });
});

// --- off / disable ------------------------------------------------------------------------------

test('off, disable:["bashguard"] and disable:["all"] record nothing, in every mode', () => {
  const cases = [
    [{ TOKENSLIM_BASH_GUARD_MODE: 'off' }, null],
    [{ TOKENSLIM_DISABLE: 'bashguard' }, null],
    [{ TOKENSLIM_DISABLE: 'all' }, null],
    [{ TOKENSLIM_DISABLE: 'BashGuard', ...DENY }, null],
    [{ ...DENY }, { disable: ['bashguard'] }],
    [{ ...DENY }, { disable: ['all'] }],
    [{}, { bashGuard: { mode: 'off' } }],
  ];
  for (const [env, config] of cases) {
    withHook(env, { 'f.js': jsSource(600) }, (iso, ws) => {
      if (config) writeFileSync(join(ws.dir, '.tokenslim.json'), JSON.stringify(config));
      const result = hook(iso, payload('cat f.js', ws.dir));
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '', JSON.stringify([env, config]));
      assert.equal(existsSync(cacheDir(iso)), false, JSON.stringify([env, config]));
    });
  }
});

test('disabling the guard does not disable rewrites, and disabling rewrites does not disable the guard', () => {
  withHook({ TOKENSLIM_REWRITE_ENABLED: 'true', TOKENSLIM_DISABLE: 'bashguard' }, {}, (iso, ws) => {
    assert.equal(deny(hook(iso, payload('npm ci', ws.dir))).permissionDecision, 'allow');
  });
  withHook({ ...DENY, TOKENSLIM_DISABLE: 'rewrite' }, { 'f.js': jsSource(600) }, (iso, ws) => {
    assert.equal(deny(hook(iso, payload('cat f.js', ws.dir))).permissionDecision, 'deny');
  });
});

// --- fail-open ----------------------------------------------------------------------------------

test('fail-open: bad payloads, a directory operand and unreadable or unwritable state never print or fail', () => {
  withHook(DENY, { 'f.js': jsSource(600), 'dir.js/x': 'x' }, (iso, ws) => {
    for (const body of ['not json', '{}', JSON.stringify({ tool_input: {} }), JSON.stringify({ tool_input: { command: 42 } }), JSON.stringify({ tool_name: 'Read', cwd: ws.dir, tool_input: { command: 'cat f.js' } })]) {
      const result = hook(iso, body);
      assert.equal(result.status, 0, body);
      assert.equal(result.stdout, '', body);
      assert.equal(result.stderr, '', body);
    }
    for (const command of ['cat dir.js', 'cat dir.js/', 'cat f.js dir.js']) {
      const result = hook(iso, payload(command, ws.dir));
      assert.deepEqual([result.status, result.stdout], [0, ''], command);
    }
    assert.equal(existsSync(cacheDir(iso)), false);
    // No cwd in the payload: resolves against the hook's own cwd, and a missing file is no trigger.
    assert.equal(hook(iso, { tool_input: { command: 'cat f.js' }, session_id: SESSION }).stdout, '');
  });
});

test('fail-open: an unreadable file is a silent no-trigger', { skip: process.getuid?.() === 0 ? 'root can read anything' : false }, () => {
  withHook(DENY, { 'locked.js': jsSource(600) }, (iso, ws) => {
    chmodSync(join(ws.dir, 'locked.js'), 0o000);
    const result = hook(iso, payload('cat locked.js', ws.dir));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(cacheDir(iso)), false);
  });
});

test('fail-open: if state cannot be written, deny stays silent (no denial without a recordable escape hatch) and shadow stays silent', () => {
  for (const env of [DENY, {}]) {
    const iso = isolatedEnv(env);
    const ws = workspace({ 'f.js': jsSource(600) });
    try {
      mkdirSync(join(iso.env.XDG_CACHE_HOME, '..'), { recursive: true });
      writeFileSync(iso.env.XDG_CACHE_HOME, 'a file where the cache dir should be');
      const result = hook(iso, payload('cat f.js', ws.dir));
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    } finally { iso.cleanup(); ws.cleanup(); }
  }
});

// --- config -------------------------------------------------------------------------------------

function config(project, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-bg-config-'));
  try {
    if (project) writeFileSync(join(dir, '.tokenslim.json'), JSON.stringify(project));
    clearConfigCache();
    return loadConfig(dir, { HOME: dir, XDG_CONFIG_HOME: join(dir, 'absent'), ...env }).bashGuard;
  } finally { rmSync(dir, { recursive: true, force: true }); clearConfigCache(); }
}

test('bashGuard config: default shadow/400/0, validation, nested merge, env override (case-insensitive, invalid ignored)', () => {
  assert.deepEqual(config(), { mode: 'shadow', lines: 400, bytes: 0 });
  assert.deepEqual(config({ bashGuard: { mode: 'deny', lines: 800, bytes: 40000, extra: 1 } }), { mode: 'deny', lines: 800, bytes: 40000 });
  assert.deepEqual(config({ bashGuard: { mode: 'block', lines: -1, bytes: 'big' } }), { mode: 'shadow', lines: 400, bytes: 0 });
  assert.deepEqual(config({ bashGuard: { lines: 1.5, bytes: 2.5 } }), { mode: 'shadow', lines: 400, bytes: 0 }, 'integers only');
  assert.deepEqual(config({ bashGuard: { lines: 0 } }), { mode: 'shadow', lines: 0, bytes: 0 });
  assert.deepEqual(config({ bashGuard: 'deny' }), { mode: 'shadow', lines: 400, bytes: 0 });
  assert.deepEqual(config({ bashGuard: { lines: 900 } }), { mode: 'shadow', lines: 900, bytes: 0 }, 'a partial layer keeps the other defaults');
  assert.equal(config({ bashGuard: { mode: 'off' } }, { TOKENSLIM_BASH_GUARD_MODE: ' DeNy ' }).mode, 'deny');
  assert.equal(config({ bashGuard: { mode: 'deny' } }, { TOKENSLIM_BASH_GUARD_MODE: 'bogus' }).mode, 'deny', 'an invalid env value is ignored');
  assert.equal(config({ bashGuard: { mode: 'deny' } }, { TOKENSLIM_BASH_GUARD_MODE: 'OFF' }).mode, 'off');
  // The env value is part of the cache key: two calls with different env never share a result.
  assert.notEqual(config(null, { TOKENSLIM_BASH_GUARD_MODE: 'deny' }).mode, config(null, { TOKENSLIM_BASH_GUARD_MODE: 'off' }).mode);
});

// --- state / history ----------------------------------------------------------------------------

test('recordBashGuard keeps additive counters and old history/ledgers still load', () => {
  const iso = isolatedEnv();
  const saved = { cache: process.env.XDG_CACHE_HOME, data: process.env.XDG_DATA_HOME };
  process.env.XDG_CACHE_HOME = iso.env.XDG_CACHE_HOME;
  process.env.XDG_DATA_HOME = iso.env.XDG_DATA_HOME;
  try {
    mkdirSync(join(iso.env.XDG_DATA_HOME, 'tokenslim'), { recursive: true });
    writeFileSync(historyPath(iso), JSON.stringify({ days: { [today()]: { byTool: { Bash: { bytesIn: 10, bytesOut: 5, events: 1 } }, byCommand: {}, byProject: {}, recovery: { capped: 2 } } } }));
    const state = loadState('s');
    recordBashGuard(state, { wouldDeny: 1, wouldDenyBytes: 2048, le800: 1 });
    recordBashGuard(state, { wouldDeny: 1, wouldDenyBytes: 100, gt2000: 1, bogus: 5, denied: 0 });
    assert.deepEqual(state.bashGuard, { wouldDeny: 2, wouldDenyBytes: 2148, le800: 1, gt2000: 1 });
    saveState('s', state);
    const day = loadHistory().days[today()];
    assert.deepEqual(day.bashGuard, { wouldDeny: 2, wouldDenyBytes: 2148, le800: 1, gt2000: 1 });
    assert.deepEqual(day.recovery, { capped: 2 }, 'existing fields are untouched');
    assert.equal(day.byTool.Bash.events, 1);
    assert.equal(loadState('s').historyEvents, undefined, 'events are flushed once');
    saveState('s', loadState('s'));
    assert.equal(loadHistory().days[today()].bashGuard.wouldDeny, 2, 'a re-save does not double-count');
    assert.equal(updateHistory([{ kind: 'bashGuard', wouldDeny: 'x', denied: 3 }]), true);
    assert.deepEqual(loadHistory().days[today()].bashGuard.denied, 3);
  } finally {
    for (const [key, value] of [['XDG_CACHE_HOME', saved.cache], ['XDG_DATA_HOME', saved.data]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    iso.cleanup();
  }
});

// --- stats --------------------------------------------------------------------------------------

function seedHistory(iso, day) {
  mkdirSync(join(iso.env.XDG_DATA_HOME, 'tokenslim'), { recursive: true });
  writeFileSync(historyPath(iso), JSON.stringify({ days: { [today()]: day } }));
}

test('stats: shadow line with share of attempted Bash bytes, size buckets and the hint (text, json, csv)', () => {
  const iso = isolatedEnv();
  try {
    seedHistory(iso, {
      byTool: { Bash: { bytesIn: 4000, bytesOut: 2000, events: 2, bytesAttempted: 400000 } }, byCommand: {}, byProject: {},
      bashGuard: { wouldDeny: 5, wouldDenyBytes: 51200, le800: 3, le2000: 1, gt2000: 1 },
    });
    const out = stats(iso, []).stdout;
    assert.match(out, /^bash dump guard \(shadow\): 5 whole-file dump\(s\) would be outlined, 50\.0KB of files; ≈12\.8% of attempted Bash bytes$/m);
    assert.match(out, /^ {2}by total lines: ≤800 3, 801-2000 1, >2000 1$/m);
    assert.match(out, /^ {2}set bashGuard\.mode to "deny" to try it; watch the repeat rate$/m);
    assert.doesNotMatch(out, /bash dump guard: denied/);
    const json = JSON.parse(stats(iso, ['--format', 'json']).stdout);
    assert.deepEqual(json.bashGuard, {
      wouldDeny: 5, wouldDenyBytes: 51200, denied: 0, repeated: 0, skippedRuntime: 0, buckets: { le800: 3, le2000: 1, gt2000: 1 },
      pctOfAttemptedBash: 12.8, repeatRate: null, repeatWarn: false,
    });
    assert.deepEqual(json.days[0].bashGuard, json.bashGuard);
    assert.deepEqual(Object.keys(json).slice(0, 8), ['source', 'period', 'project', 'total', 'byTool', 'byCommand', 'days', 'recovery'], 'existing keys keep their order');
    const csv = stats(iso, ['--format', 'csv']).stdout.trim().split('\n');
    assert.equal(csv[0], 'day,bytesIn,bytesOut,bytesSaved,events,bytesAttempted,capped,teeRead,teeCat,rerun,wouldDeny,wouldDenyBytes,denied,repeated,skippedRuntime');
    assert.equal(csv[1], `${today()},4000,2000,2000,2,400000,0,0,0,0,5,51200,0,0,0`);
  } finally { iso.cleanup(); }
});

test('stats: shadow without Bash attempted bytes omits the percentage; project view omits guard data', () => {
  const iso = isolatedEnv();
  try {
    seedHistory(iso, { byTool: {}, byCommand: {}, byProject: { '/p': { bytesIn: 1, bytesOut: 1, events: 1 } }, bashGuard: { wouldDeny: 1, wouldDenyBytes: 2048, le2000: 1 } });
    const out = stats(iso, []).stdout;
    assert.match(out, /^bash dump guard \(shadow\): 1 whole-file dump\(s\) would be outlined, 2\.0KB of files$/m);
    assert.equal(JSON.parse(stats(iso, ['--format', 'json']).stdout).bashGuard.pctOfAttemptedBash, null);
    assert.doesNotMatch(stats(iso, ['--project', '/p']).stdout, /bash dump guard/);
  } finally { iso.cleanup(); }
});

test('stats: deny line with the repeat rate and a warning above 30%', () => {
  const iso = isolatedEnv();
  try {
    seedHistory(iso, { byTool: {}, byCommand: {}, byProject: {}, bashGuard: { denied: 10, repeated: 3 } });
    assert.match(stats(iso, []).stdout, /^bash dump guard: denied 10, repeated 3 \(30%\)$/m, 'exactly 30% is not above it');
    seedHistory(iso, { byTool: {}, byCommand: {}, byProject: {}, bashGuard: { denied: 10, repeated: 4, skippedRuntime: 2 } });
    const out = stats(iso, []).stdout;
    assert.match(out, /^bash dump guard: denied 10, repeated 4 \(40%\) ⚠ above 30%: the outline was often not enough, skipped 2 \(no Claude session\)$/m);
    assert.doesNotMatch(out, /\(shadow\)/);
    const json = JSON.parse(stats(iso, ['--format', 'json']).stdout);
    assert.deepEqual([json.bashGuard.repeatRate, json.bashGuard.repeatWarn], [0.4, true]);
  } finally { iso.cleanup(); }
});

test('stats: the live session ledger reports shadow and deny counts from real hook runs', () => {
  withHook(DENY, { 'f.js': jsSource(600) }, (iso, ws) => {
    hook(iso, payload('cat f.js', ws.dir));
    hook(iso, payload('cat f.js', ws.dir));
    const out = stats(iso, [SESSION]).stdout;
    assert.match(out, /^bash dump guard: denied 1, repeated 1 \(100%\) ⚠ above 30%/m);
    const shadow = isolatedEnv();
    try {
      hook(shadow, payload('cat f.js', ws.dir));
      const shadowOut = stats(shadow, [SESSION]).stdout;
      assert.match(shadowOut, /^bash dump guard \(shadow\): 1 whole-file dump\(s\) would be outlined, \d+\.\dKB of files$/m);
      assert.equal(JSON.parse(stats(shadow, [SESSION, '--format', 'json']).stdout).bashGuard.wouldDeny, 1);
    } finally { shadow.cleanup(); }
  });
});

test('stats: old ledgers and history without guard data render exactly as before', () => {
  const iso = isolatedEnv();
  try {
    seedHistory(iso, { byTool: { Bash: { bytesIn: 4000, bytesOut: 2000, events: 2, bytesAttempted: 8000 } }, byCommand: {}, byProject: {}, recovery: { capped: 4, rerun: 1 } });
    const out = stats(iso, []).stdout;
    assert.doesNotMatch(out, /bash dump guard/);
    const json = JSON.parse(stats(iso, ['--format', 'json']).stdout);
    assert.equal('bashGuard' in json, false);
    assert.equal('bashGuard' in json.days[0], false);
    assert.equal(stats(iso, ['--format', 'csv']).stdout.trim().split('\n')[0], 'day,bytesIn,bytesOut,bytesSaved,events,bytesAttempted,capped,teeRead,teeCat,rerun');
    mkdirSync(cacheDir(iso), { recursive: true });
    writeFileSync(ledgerPath(iso, 'old'), JSON.stringify({ version: 1, savings: { Bash: { events: 1, bytesIn: 900, bytesOut: 300 } }, reads: {}, diagnostics: {} }));
    const ledgerOut = stats(iso, ['old']).stdout;
    assert.doesNotMatch(ledgerOut, /bash dump guard/);
    assert.equal('bashGuard' in JSON.parse(stats(iso, ['old', '--format', 'json']).stdout), false);
  } finally { iso.cleanup(); }
});

test('shareEntries splits the 40-entry budget evenly and hands a small file\'s unused share to the others', () => {
  assert.deepEqual(shareEntries([100, 100]), [20, 20]);
  assert.deepEqual(shareEntries([100, 100, 5]), [18, 17, 5]);
  assert.deepEqual(shareEntries([3, 100]), [3, 37]);
  assert.deepEqual(shareEntries([0, 100, 0]), [0, 40, 0]);
  assert.deepEqual(shareEntries([10, 10]), [10, 10]);
  assert.deepEqual(shareEntries(Array(50).fill(5)).reduce((a, b) => a + b), 40, 'more files than entries: still 40 in all');
  for (const needs of [[1, 2, 3], [41, 1], [7, 7, 7, 7, 7, 7, 7], [100, 100, 100]]) {
    const take = shareEntries(needs);
    assert.ok(take.reduce((a, b) => a + b, 0) <= 40, JSON.stringify(needs));
    needs.forEach((need, i) => assert.ok(take[i] <= need));
  }
});
