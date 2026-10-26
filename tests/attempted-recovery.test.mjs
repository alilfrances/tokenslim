import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHistory, updateHistory } from '../scripts/lib/history.mjs';
import { loadState, noteBashCommand, recordAttempted, recordRecovery, recordSavings, saveState } from '../scripts/lib/state.mjs';
import { isTeePath, teeRoot } from '../scripts/lib/tee.mjs';
import { isolatedEnv } from './helpers.mjs';

const root = join(import.meta.dirname, '..');
const script = (name) => join(root, 'scripts', name);

// Varied lines so no generic rule touches them: the cap is the only change.
const unique = (count) => Array.from({ length: count }, (_, i) =>
  `entry ${i} ${(i * 2654435761 % 4294967296).toString(36)} ${'abcdefghij'.slice(0, i % 10)}-${(i * 40503 % 65521).toString(36)} payload ${'klmnopqrstuvwxyz'.slice(i % 16)}`);

function hook(name, payload, env) {
  return spawnSync(process.execPath, [script(name)], { input: JSON.stringify(payload), encoding: 'utf8', env });
}
const ledger = (iso, session) => JSON.parse(readFileSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim', `${session}.json`), 'utf8'));
const history = (iso) => JSON.parse(readFileSync(join(iso.env.XDG_DATA_HOME, 'tokenslim', 'history.json'), 'utf8'));
const today = () => new Date().toISOString().slice(0, 10);

function withProcessEnv(iso, fn) {
  const saved = { cache: process.env.XDG_CACHE_HOME, data: process.env.XDG_DATA_HOME };
  process.env.XDG_CACHE_HOME = iso.env.XDG_CACHE_HOME;
  process.env.XDG_DATA_HOME = iso.env.XDG_DATA_HOME;
  try { return fn(); } finally {
    for (const [key, value] of [['XDG_CACHE_HOME', saved.cache], ['XDG_DATA_HOME', saved.data]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    iso.cleanup();
  }
}

// --- state / history round-trips ---

test('state: attempted bytes and recovery counters round-trip into ledger and daily history', () => {
  const iso = isolatedEnv();
  withProcessEnv(iso, () => {
    const state = loadState('rt');
    recordAttempted(state, { tool: 'Bash', bytes: 1000, cwd: '/repo' });
    recordAttempted(state, { tool: 'Bash', bytes: 500, cwd: '/repo' });
    recordAttempted(state, { tool: 'Read', bytes: 200, cwd: '/repo' });
    recordSavings(state, { tool: 'Bash', bytesIn: 1000, bytesOut: 100, command: 'npm test', cwd: '/repo' });
    recordRecovery(state, 'capped');
    recordRecovery(state, 'rerun');
    saveState('rt', state);

    const reloaded = loadState('rt');
    assert.deepEqual(reloaded.attempted, { Bash: { events: 2, bytes: 1500 }, Read: { events: 1, bytes: 200 } });
    assert.deepEqual(reloaded.diagnostics.Bash.recovery, { capped: 1, rerun: 1 });
    assert.equal(reloaded.historyEvents, undefined, 'history deltas are consumed once saved');

    const day = loadHistory().days[today()];
    assert.deepEqual(day.byTool.Bash, { bytesAttempted: 1500, bytesIn: 1000, bytesOut: 100, events: 1 });
    assert.deepEqual(day.byTool.Read, { bytesAttempted: 200 });
    assert.equal(day.byProject['/repo'].bytesAttempted, 1700);
    assert.equal(day.byProject['/repo'].events, 1, 'attempted bytes never inflate savings events');
    assert.deepEqual(day.byCommand, { 'npm test': { bytesIn: 1000, bytesOut: 100, events: 1 } });
    assert.deepEqual(day.recovery, { capped: 1, rerun: 1 });

    // A second save adds only new deltas.
    const again = loadState('rt');
    recordAttempted(again, { tool: 'Bash', bytes: 50, cwd: '/repo' });
    saveState('rt', again);
    assert.equal(loadHistory().days[today()].byTool.Bash.bytesAttempted, 1550);
  });
});

test('state: an old ledger and old history without the new fields still load and aggregate', () => {
  const iso = isolatedEnv();
  withProcessEnv(iso, () => {
    mkdirSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim'), { recursive: true });
    mkdirSync(join(iso.env.XDG_DATA_HOME, 'tokenslim'), { recursive: true });
    writeFileSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim', 'old.json'), JSON.stringify({ version: 1, savings: { Bash: { events: 1, bytesIn: 10, bytesOut: 5 } }, reads: {}, diagnostics: {} }));
    writeFileSync(join(iso.env.XDG_DATA_HOME, 'tokenslim', 'history.json'), JSON.stringify({ days: { [today()]: { byTool: { Bash: { bytesIn: 10, bytesOut: 5, events: 1 } }, byCommand: {}, byProject: {} } } }));
    const state = loadState('old');
    assert.equal(state.attempted, undefined);
    recordAttempted(state, { tool: 'Bash', bytes: 40 });
    saveState('old', state);
    assert.equal(loadState('old').attempted.Bash.bytes, 40);
    assert.deepEqual(loadHistory().days[today()].byTool.Bash, { bytesIn: 10, bytesOut: 5, events: 1, bytesAttempted: 40 });
  });
});

test('history ignores unknown recovery outcomes', () => {
  const iso = isolatedEnv();
  withProcessEnv(iso, () => {
    updateHistory([{ kind: 'recovery', outcome: 'capped' }, { kind: 'recovery', outcome: 'bogus' }], new Date('2026-07-19T12:00:00Z'));
    assert.deepEqual(loadHistory().days['2026-07-19'].recovery, { capped: 1 });
  });
});

test('recent-bash ring keeps the last three hashes, flags reruns of capped commands only, and holds no command text', () => {
  const state = { version: 1, savings: {}, reads: {} };
  const secret = 'curl -H "Authorization: Bearer super-secret-token" https://internal.example/data';
  assert.equal(noteBashCommand(state, secret, true), false);
  assert.equal(noteBashCommand(state, 'ls', false), false);
  assert.equal(noteBashCommand(state, 'ls', false), false, 'an uncapped repeat is not a rerun');
  assert.equal(noteBashCommand(state, secret, true), true, 'repeat of a capped command is a rerun');
  assert.equal(state.recentBash.length, 3);
  for (const entry of state.recentBash) {
    assert.deepEqual(Object.keys(entry).sort(), ['capped', 'h']);
    assert.match(entry.h, /^[0-9a-f]{16}$/);
  }
  assert.doesNotMatch(JSON.stringify(state), /super-secret|internal\.example|curl/);
  // Aged out of the ring: no longer detected.
  noteBashCommand(state, 'a', false);
  noteBashCommand(state, 'b', false);
  noteBashCommand(state, 'c', false);
  assert.equal(noteBashCommand(state, secret, true), false);
  assert.equal(noteBashCommand(state, '', false), false);
});

test('tee root helpers resolve from the env and match only paths inside it', () => {
  const env = { XDG_CACHE_HOME: '/cache' };
  assert.equal(teeRoot(env), '/cache/tokenslim/tee');
  assert.equal(isTeePath('/cache/tokenslim/tee/s/t.log', env), true);
  assert.equal(isTeePath('/cache/tokenslim/tee/../state.json', env), false);
  assert.equal(isTeePath('/cache/tokenslim/teeother/x', env), false);
  assert.equal(isTeePath('/repo/src/a.js', env), false);
  assert.equal(isTeePath(undefined, env), false);
});

// --- spawned hooks ---

test('hooks: cap, teeRead, teeCat and rerun each increment; attempted bytes flow to ledger and history; no command text persists', () => {
  const iso = isolatedEnv({ TOKENSLIM_BASH_CAP_CHARS: '8000', TOKENSLIM_TEE_MIN: '0', TOKENSLIM_HOOK_RUNTIME: 'claude' });
  try {
    const session = 'rec-flow';
    const stdout = unique(500).join('\n');
    const bash = (command, response, id) => hook('compress-bash.mjs', {
      session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, cwd: root,
      tool_input: { command }, tool_response: response,
    }, iso.env);
    const secretCommand = 'cat /srv/secret-project/big.log';

    const first = bash(secretCommand, { stdout, stderr: '', interrupted: false, isImage: false }, 'toolu_a');
    assert.equal(first.status, 0, first.stderr);
    const out = JSON.parse(first.stdout).hookSpecificOutput.updatedToolOutput.stdout;
    const teeFile = /\[tokenslim: full: (.+)\]$/.exec(out)[1];
    let state = ledger(iso, session);
    assert.equal(state.diagnostics.Bash.recovery.capped, 1);
    assert.equal(state.attempted.Bash.bytes, Buffer.byteLength(stdout));
    assert.equal(state.attempted.Bash.events, 1);
    assert.deepEqual(state.diagnostics.Bash.PostToolUse, { attempted: 1, compressed: 1 });

    // Read of the tee file: Read attempted bytes plus a teeRead event under Bash.
    const read = hook('compress-read.mjs', {
      session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: root,
      tool_input: { file_path: teeFile },
      tool_response: { type: 'text', file: { filePath: teeFile, content: stdout, numLines: 500, startLine: 1, totalLines: 500 } },
    }, iso.env);
    assert.equal(read.status, 0, read.stderr);
    state = ledger(iso, session);
    assert.equal(state.diagnostics.Bash.recovery.teeRead, 1);
    assert.equal(state.attempted.Read.bytes, Buffer.byteLength(stdout));
    assert.deepEqual(state.diagnostics.Read.PostToolUse, { attempted: 1, skippedFirstRead: 1 });

    // cat of the tee path (short output, below the size threshold): still a teeCat, and still attempted bytes.
    const cat = bash(`cat ${teeFile}`, { stdout: 'tiny', stderr: '', interrupted: false, isImage: false }, 'toolu_b');
    assert.equal(cat.status, 0, cat.stderr);
    state = ledger(iso, session);
    assert.equal(state.diagnostics.Bash.recovery.teeCat, 1);
    assert.equal(state.attempted.Bash.events, 2);
    assert.equal(state.diagnostics.Bash.recovery.rerun, undefined);

    // Same capped command again: a rerun, and it is capped again.
    const rerun = bash(secretCommand, { stdout, stderr: '', interrupted: false, isImage: false }, 'toolu_c');
    assert.equal(rerun.status, 0, rerun.stderr);
    state = ledger(iso, session);
    assert.deepEqual(state.diagnostics.Bash.recovery, { capped: 2, teeRead: 1, teeCat: 1, rerun: 1 });

    // A failure, an image and a below-threshold result: failures and small results are attempted, images are not.
    bash('make', { stdout: 'x'.repeat(2000), stderr: '', exitCode: 2 }, 'toolu_d');
    bash('screenshot', { stdout: 'x'.repeat(2000), stderr: '', isImage: true }, 'toolu_e');
    state = ledger(iso, session);
    assert.equal(state.attempted.Bash.events, 4);
    assert.equal(state.attempted.Bash.bytes, 2 * Buffer.byteLength(stdout) + 'tiny'.length + 2000);

    // Privacy: neither the ledger nor history may hold command text or the tee path.
    const raw = readFileSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim', `${session}.json`), 'utf8');
    assert.doesNotMatch(raw, /secret-project|big\.log|cat /);
    assert.equal(state.recentBash.length, 3);
    assert.doesNotMatch(readFileSync(join(iso.env.XDG_DATA_HOME, 'tokenslim', 'history.json'), 'utf8'), /secret-project|big\.log/);

    const day = history(iso).days[today()];
    assert.deepEqual(day.recovery, { capped: 2, teeRead: 1, teeCat: 1, rerun: 1 });
    assert.equal(day.byTool.Bash.bytesAttempted, state.attempted.Bash.bytes);
    assert.equal(day.byTool.Read.bytesAttempted, Buffer.byteLength(stdout));

    // stats reads the same data back and flags the recovery rate.
    const stats = spawnSync(process.execPath, [script('stats.mjs')], { encoding: 'utf8', env: iso.env });
    assert.equal(stats.status, 0, stats.stderr);
    assert.match(stats.stdout, /bash cap recovery rate: 150% \(3 of 2 capped; teeRead 1, teeCat 1, rerun 1\) ⚠/);
  } finally { iso.cleanup(); }
});

test('hooks: cap off records attempted bytes and no recovery data', () => {
  const iso = isolatedEnv({ TOKENSLIM_HOOK_RUNTIME: 'claude' });
  try {
    const stdout = unique(500).join('\n');
    const result = hook('compress-bash.mjs', { session_id: 'nocap', hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: root, tool_input: { command: 'cat a' }, tool_response: { stdout, stderr: '' } }, iso.env);
    assert.equal(result.status, 0, result.stderr);
    const state = ledger(iso, 'nocap');
    assert.equal(state.attempted.Bash.bytes, Buffer.byteLength(stdout));
    assert.equal(state.diagnostics.Bash.recovery, undefined);
  } finally { iso.cleanup(); }
});

test('hooks: Read counts below-threshold results and never counts image or pdf responses; Grep and Glob share one bucket; MCP counts text', () => {
  const iso = isolatedEnv({ TOKENSLIM_HOOK_RUNTIME: 'claude' });
  try {
    const session = 'tools';
    const read = (response, extra = {}) => hook('compress-read.mjs', { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: root, tool_input: { file_path: '/repo/a.txt' }, tool_response: response, ...extra }, iso.env);
    read({ type: 'text', file: { filePath: '/repo/a.txt', content: 'short', numLines: 1 } });
    read({ type: 'image', file: { type: 'image/png', base64: 'A'.repeat(5000), originalSize: 3000 } });
    read({ type: 'pdf', file: { filePath: '/repo/a.pdf', base64: 'B'.repeat(5000) } });
    let state = ledger(iso, session);
    assert.deepEqual(state.attempted.Read, { events: 1, bytes: 5 });

    const grepText = Array.from({ length: 30 }, (_, i) => `src/a.js:${i + 1}:const value${i} = compute(${i});`).join('\n');
    hook('compress-grep.mjs', { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Grep', cwd: root, tool_input: { pattern: 'x' }, tool_response: { mode: 'content', numFiles: 1, filenames: ['src/a.js'], content: grepText, numLines: 30 } }, iso.env);
    hook('compress-grep.mjs', { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Glob', cwd: root, tool_input: { pattern: '*' }, tool_response: { filenames: ['a.js', 'b.js'], numFiles: 2, durationMs: 1, truncated: false } }, iso.env);
    state = ledger(iso, session);
    assert.equal(state.attempted.Grep.events, 2);
    assert.equal(state.attempted.Grep.bytes, grepText.length + JSON.stringify(['a.js', 'b.js']).length);
    assert.equal(state.attempted.Glob, undefined);

    const mcpText = JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `row ${i}` })) });
    hook('compress-mcp.mjs', { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'mcp__srv__query', cwd: root, tool_input: {}, tool_response: mcpText }, iso.env);
    state = ledger(iso, session);
    assert.deepEqual(state.attempted.MCP, { events: 1, bytes: Buffer.byteLength(mcpText) });
    assert.deepEqual(state.diagnostics.MCP.PostToolUse.attempted, 1);
  } finally { iso.cleanup(); }
});

// --- stats ---

function stats(iso, args = []) {
  const result = spawnSync(process.execPath, [script('stats.mjs'), ...args], { encoding: 'utf8', env: iso.env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function writeHistory(iso, days) {
  mkdirSync(join(iso.env.XDG_DATA_HOME, 'tokenslim'), { recursive: true });
  writeFileSync(join(iso.env.XDG_DATA_HOME, 'tokenslim', 'history.json'), JSON.stringify({ days }));
}
function writeLedger(iso, session, state) {
  mkdirSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim'), { recursive: true });
  writeFileSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim', `${session}.json`), JSON.stringify({ version: 1, reads: {}, ...state }));
}
const newDay = (recovery) => ({
  byTool: {
    Bash: { bytesIn: 9000, bytesOut: 3000, events: 3, bytesAttempted: 20000 },
    Read: { bytesIn: 1000, bytesOut: 100, events: 1, bytesAttempted: 10000 },
  },
  byCommand: { pytest: { bytesIn: 9000, bytesOut: 3000, events: 3 } },
  byProject: { '/repo': { bytesIn: 10000, bytesOut: 3100, events: 4, bytesAttempted: 30000 } },
  ...(recovery ? { recovery } : {}),
});

test('stats text: % of attempted per tool and total, recovery rate with warning above 15%, cost note, images excluded', () => {
  const iso = isolatedEnv();
  try {
    writeHistory(iso, { [today()]: newDay({ capped: 10, teeRead: 1, teeCat: 1, rerun: 0 }) });
    const out = stats(iso);
    assert.match(out, /Bash\s+3 calls\s+8\.8KB -> 2\.9KB\s+\(67% smaller\)\s+30% of 19\.5KB attempted/);
    assert.match(out, /Read\s+1 calls\s+.*\s+9% of 9\.8KB attempted/);
    assert.match(out, /total .*tokens saved\s+23% of 29\.3KB attempted/);
    assert.match(out, /bash cap recovery rate: 20% \(2 of 10 capped; teeRead 1, teeCat 1, rerun 0\) ⚠ above 15%/);
    assert.match(out, /benchmark\.mjs --transcripts <dir>/);
    assert.match(out, /images excluded/);
  } finally { iso.cleanup(); }
});

test('stats recovery rate: no warning at or below 15%, no line when nothing was capped', () => {
  const iso = isolatedEnv();
  try {
    writeHistory(iso, { [today()]: newDay({ capped: 20, teeRead: 2, teeCat: 1, rerun: 0 }) });
    const exactly = stats(iso);
    assert.match(exactly, /bash cap recovery rate: 15% \(3 of 20 capped/);
    assert.doesNotMatch(exactly, /⚠/);
    writeHistory(iso, { [today()]: newDay({ capped: 0, teeRead: 4, teeCat: 0, rerun: 0 }) });
    assert.doesNotMatch(stats(iso), /recovery rate/);
    writeHistory(iso, { [today()]: newDay() });
    assert.doesNotMatch(stats(iso), /recovery rate/);
  } finally { iso.cleanup(); }
});

test('stats json: new fields are appended, existing keys keep their order, recovery is structured', () => {
  const iso = isolatedEnv();
  try {
    writeHistory(iso, { [today()]: newDay({ capped: 10, teeRead: 1, teeCat: 1, rerun: 1 }) });
    const parsed = JSON.parse(stats(iso, ['--format', 'json']));
    assert.deepEqual(Object.keys(parsed).slice(0, 7), ['source', 'period', 'project', 'total', 'byTool', 'byCommand', 'days']);
    assert.deepEqual(Object.keys(parsed.total).slice(0, 5), ['bytesIn', 'bytesOut', 'events', 'bytesSaved', 'estTokensSaved']);
    assert.equal(parsed.total.bytesAttempted, 30000);
    assert.equal(parsed.total.pctOfAttempted, 23);
    assert.equal(parsed.byTool.Bash.bytesAttempted, 20000);
    assert.equal(parsed.byTool.Bash.pctOfAttempted, 30);
    assert.equal('savedCovered' in parsed.byTool.Bash, false);
    assert.deepEqual(parsed.recovery, { capped: 10, teeRead: 1, teeCat: 1, rerun: 1, rate: 0.3, warn: true });
    assert.deepEqual(Object.keys(parsed.days[0]).slice(0, 5), ['day', 'bytesIn', 'bytesOut', 'events', 'bytesSaved']);
    assert.equal(parsed.days[0].bytesAttempted, 30000);
    assert.equal(JSON.parse(stats(iso, ['--project', '/repo', '--format', 'json'])).recovery, null);
    assert.equal(JSON.parse(stats(iso, ['--project', '/repo', '--format', 'json'])).total.pctOfAttempted, 23);
  } finally { iso.cleanup(); }
});

test('stats csv: appends columns only when attempted or recovery data exists', () => {
  const iso = isolatedEnv();
  try {
    writeHistory(iso, { [today()]: newDay({ capped: 10, teeRead: 1, teeCat: 1, rerun: 1 }) });
    const lines = stats(iso, ['--format', 'csv']).trim().split('\n');
    assert.equal(lines[0], 'day,bytesIn,bytesOut,bytesSaved,events,bytesAttempted,capped,teeRead,teeCat,rerun');
    assert.equal(lines[1], `${today()},10000,3100,6900,4,30000,10,1,1,1`);
    writeHistory(iso, { [today()]: { byTool: { Bash: { bytesIn: 300, bytesOut: 100, events: 1 } }, byCommand: {}, byProject: {} } });
    assert.equal(stats(iso, ['--format', 'csv']).trim().split('\n')[0], 'day,bytesIn,bytesOut,bytesSaved,events');
  } finally { iso.cleanup(); }
});

test('stats: old-format history renders without percentages; mixed history only divides covered savings', () => {
  const iso = isolatedEnv();
  try {
    const old = { byTool: { Bash: { bytesIn: 900, bytesOut: 300, events: 3 } }, byCommand: {}, byProject: {} };
    writeHistory(iso, { [today()]: old });
    const out = stats(iso);
    assert.match(out, /Bash\s+3 calls\s+900B -> 300B\s+\(67% smaller\)$/m);
    assert.doesNotMatch(out, /^ {2}\S.*% of/m);
    assert.doesNotMatch(out, /recovery rate/);
    const parsed = JSON.parse(stats(iso, ['--format', 'json']));
    assert.equal(parsed.total.pctOfAttempted, null);
    assert.equal(parsed.byTool.Bash.pctOfAttempted, null);
    assert.deepEqual(parsed.recovery, { capped: 0, teeRead: 0, teeCat: 0, rerun: 0, rate: null, warn: false });

    // An old day (200 B saved, no attempted bytes) must not inflate the new day's 600/2000.
    const older = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    writeHistory(iso, {
      [older]: { byTool: { Bash: { bytesIn: 300, bytesOut: 100, events: 1 } }, byCommand: {}, byProject: {} },
      [today()]: { byTool: { Bash: { bytesIn: 900, bytesOut: 300, events: 3, bytesAttempted: 2000 } }, byCommand: {}, byProject: {} },
    });
    assert.equal(JSON.parse(stats(iso, ['--format', 'json'])).byTool.Bash.pctOfAttempted, 30);
  } finally { iso.cleanup(); }
});

test('stats ledger mode: attempted bytes, recovery diagnostics and old ledgers', () => {
  const iso = isolatedEnv();
  try {
    writeLedger(iso, 'new', {
      savings: { Bash: { events: 2, bytesIn: 4000, bytesOut: 1000 }, Edit: { events: 1, bytesIn: 500, bytesOut: 50 } },
      attempted: { Bash: { events: 5, bytes: 12000 }, Read: { events: 3, bytes: 6000 } },
      diagnostics: { Bash: { recovery: { capped: 4, teeRead: 1, teeCat: 0, rerun: 0 } } },
    });
    const out = stats(iso, ['new']);
    assert.match(out, /Bash\s+2 calls\s+3\.9KB -> 1000B\s+\(75% smaller\)\s+25% of 11\.7KB attempted/);
    assert.match(out, /Read\s+0 calls\s+0B -> 0B\s+\(0% smaller\)\s+0% of 5\.9KB attempted/);
    assert.match(out, /total .*\s+19\.2% of 17\.6KB attempted/);
    assert.match(out, /bash cap recovery rate: 25% \(1 of 4 capped; teeRead 1, teeCat 0, rerun 0\) ⚠/);
    assert.match(out, /Bash\s+recovery\s+capped 4, teeRead 1/);

    writeLedger(iso, 'legacy', { savings: { Bash: { events: 1, bytesIn: 900, bytesOut: 300 } } });
    const legacy = stats(iso, ['legacy']);
    assert.match(legacy, /Bash\s+1 calls\s+900B -> 300B\s+\(67% smaller\)$/m);
    assert.doesNotMatch(legacy, /^ {2}\S.*% of|recovery rate/m);
    const json = JSON.parse(stats(iso, ['legacy', '--format', 'json']));
    assert.equal(json.total.pctOfAttempted, null);
    assert.equal(json.recovery.rate, null);
  } finally { iso.cleanup(); }
});

test('hooks: a result Claude Code already persisted passes through untouched, uncounted and untee\'d', () => {
  // Verified on Claude Code 2.1.310: above ~30KB the hook gets stdout cut to 30,000 chars plus persistedOutputPath.
  const iso = isolatedEnv({ TOKENSLIM_HOOK_RUNTIME: 'claude', TOKENSLIM_BASH_CAP_CHARS: '8000' });
  try {
    const stdout = unique(400).join('\n').slice(0, 30000);
    const tool_response = { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false, persistedOutputPath: '/root/.claude/projects/p/s/tool-results/b1.txt', persistedOutputSize: 60001 };
    const result = hook('compress-bash.mjs', { session_id: 'persisted', hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: root, tool_input: { command: 'cat huge.log' }, tool_use_id: 'toolu_p', tool_response }, iso.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    const state = ledger(iso, 'persisted');
    assert.equal(state.diagnostics.Bash.PostToolUse.skippedPersisted, 1);
    assert.equal(state.attempted?.Bash, undefined);
    assert.equal(state.diagnostics.Bash.recovery, undefined);
    assert.throws(() => readFileSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim', 'tee', 'persisted', 'toolu_p.log')));
  } finally { iso.cleanup(); }
});
