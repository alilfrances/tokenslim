import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { processBashPayload } from '../scripts/lib/bash-hook.mjs';
import { clearConfigCache, loadConfig, mergeConfigLayer } from '../scripts/lib/config.mjs';
import { headTailTruncate } from '../scripts/lib/pipeline.mjs';
import { omittedMatchCounts, group } from '../scripts/lib/shape-compressors/grep.mjs';
import { isBoundedRead, lastSegment, splitSegments, tokenizeSegment } from '../scripts/lib/shell-segments.mjs';
import { isolatedEnv } from './helpers.mjs';

const root = join(import.meta.dirname, '..');
const CAP = 8000;

// Varied lines so no generic rule (repeat collapse, progress) touches them: the cap is the only change.
const unique = (count, from = 0) => Array.from({ length: count }, (_, i) => {
  const n = from + i;
  return `entry ${n} ${(n * 2654435761 % 4294967296).toString(36)} ${'abcdefghij'.slice(0, n % 10)}-${(n * 40503 % 65521).toString(36)} payload ${'klmnopqrstuvwxyz'.slice(n % 16)}`;
});

function run(stdout, { command = 'cat big.log', stderr = '', cap = CAP, tee = {}, env: extraEnv = {}, ...options } = {}) {
  const iso = isolatedEnv({ TOKENSLIM_TEE_MIN: '0', ...extraEnv });
  try {
    clearConfigCache();
    const config = mergeConfigLayer(loadConfig(root, iso.env), { bash: { capChars: cap }, ...(Object.keys(tee).length ? { tee } : {}) });
    const result = processBashPayload(
      { session_id: 'cap', tool_use_id: 'toolu_1', tool_input: { command }, tool_response: { stdout, stderr } },
      { config, env: iso.env, ...options },
    );
    const teeDir = join(iso.env.XDG_CACHE_HOME, 'tokenslim', 'tee');
    const teed = existsSync(teeDir) ? readdirSync(teeDir, { recursive: true }).filter((f) => f.endsWith('.log')) : [];
    const recovered = result.recoveryPath && existsSync(result.recoveryPath) ? readFileSync(result.recoveryPath, 'utf8') : null;
    return { result, teed, recovered };
  } finally { iso.cleanup(); }
}

const capped = (result) => result.rulesApplied.includes('capMidBand');

test('cap on: head and tail kept, accurate omitted count, important lines kept, tee equals original, marker points at it', () => {
  const lines = unique(500);
  lines[250] = 'ERROR: middle failure that must stay visible';
  const input = lines.join('\n');
  assert.ok(input.length > 20000 && input.length < 40000, `mid-band input (${input.length})`);
  const { result, teed, recovered } = run(input);
  assert.equal(result.outcome, 'compressed');
  assert.deepEqual(result.rulesApplied, ['capMidBand']);
  assert.equal(result.capExempt, null);
  const out = result.updatedToolOutput.stdout;
  const outLines = out.split('\n');
  assert.deepEqual(outLines.slice(0, 60), lines.slice(0, 60));
  assert.equal(outLines.includes(`[tokenslim: ${500 - 120} lines omitted]`), true);
  assert.match(out, /\[tokenslim: important omitted lines\]\nERROR: middle failure that must stay visible\n/);
  assert.deepEqual(outLines.slice(outLines.indexOf(lines[440]) - 0).slice(0, 60), lines.slice(440));
  assert.match(out, /\n\[tokenslim: capMidBand\]\n\[tokenslim: full: [^\]]+\]$/);
  assert.ok(result.recoveryPath && out.endsWith(`[tokenslim: full: ${result.recoveryPath}]`));
  assert.equal(recovered, input, 'tee file holds the original output');
  assert.equal(teed.length, 1);
  assert.ok(result.bytesOut < result.bytesIn / 2);
});

test('cap on: tee holds stdout plus the existing stderr framing, and stderr is not capped', () => {
  const input = unique(500).join('\n');
  const { result, recovered } = run(input, { stderr: 'warn: something harmless' });
  assert.ok(capped(result));
  assert.equal(recovered, `${input}\nstderr:\nwarn: something harmless`);
  assert.equal(result.updatedToolOutput.stderr, 'warn: something harmless');
});

test('cap on: error-like omitted lines are limited so a grep for error cannot defeat the cap', () => {
  const lines = unique(500).map((line, i) => (i >= 60 && i < 440 ? `error ${line}` : line));
  const { result } = run(lines.join('\n'));
  assert.ok(capped(result));
  const out = result.updatedToolOutput.stdout;
  assert.match(out, /\[tokenslim: 350 more important lines omitted\]/);
  assert.ok(out.length < 8000, `capped output is small (${out.length})`);
});

test('cap off (default) leaves a mid-band output uncapped', () => {
  const iso = isolatedEnv({ TOKENSLIM_TEE_MIN: '0' });
  try {
    const config = loadConfig(root, iso.env);
    assert.equal(config.bash.capChars, 0);
    const result = processBashPayload({ session_id: 's', tool_use_id: 't', tool_input: { command: 'cat big.log' }, tool_response: { stdout: unique(500).join('\n'), stderr: '' } }, { config, env: iso.env, dryRun: true });
    assert.equal(result.outcome, 'skippedPoorRatio');
    assert.equal(result.capExempt, null);
  } finally { iso.cleanup(); }
});

test('bounded last stage is exempt up to 2x capChars and capped beyond it (exact boundary)', () => {
  // Exactly 2*cap chars: exempt. One char more: capped. 200 lines so the head/tail cut is real.
  const cap = 2000;
  const sized = (length) => {
    const lines = unique(200).map((line) => line.slice(0, 18));
    const body = lines.join('\n');
    return body.length > length ? null : `${body}${'z'.repeat(length - body.length)}`;
  };
  const exact = sized(2 * cap);
  const over = sized(2 * cap + 1);
  assert.equal(exact.length, 4000);
  assert.equal(over.length, 4001);
  const atBoundary = run(exact, { cap, command: 'cat big.log | head -n 400' });
  assert.equal(atBoundary.result.capExempt, 'boundedRead');
  assert.ok(!capped(atBoundary.result));
  assert.deepEqual(atBoundary.teed, []);
  const past = run(over, { cap, command: 'cat big.log | head -n 400' });
  assert.ok(capped(past.result));
  assert.equal(past.result.capExempt, null);
  // The same size without a bounded stage is capped.
  assert.ok(capped(run(exact, { cap, command: 'cat big.log' }).result));
});

test('bounded reads: head/tail/sed/awk are exempt, unbounded forms are not', () => {
  const input = unique(300).join('\n');
  for (const command of ['cat f | head -n 400', 'tail -50 f', 'head -20 f', "sed -n '10,300p' f", "awk 'NR>=10 && NR<=300' f", 'git log --oneline --max-count=500 | tail --lines=400']) {
    // Past 2x the cap even a bounded stage is capped, so use a smaller cap to put the same text under the exemption.
    assert.equal(run(input, { command, cap: Math.ceil(input.length / 2) }).result.capExempt, 'boundedRead', command);
  }
  for (const command of ['cat f', 'tail -n +5 f', 'head -n -5 f', 'cat f | head -c 100', 'sed -n "5,$p" f', "sed 's/a/b/' f", 'cat f | wc -l | head', 'echo "unterminated | head -n 5']) {
    assert.equal(run(input, { command, cap: Math.ceil(input.length / 2) }).result.capExempt, null, command);
  }
});

test('diff-shaped output is not capped (git diff and git show)', () => {
  const hunk = (file) => [`diff --git a/${file} b/${file}`, `index 111..222 100644`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,200 +1,200 @@', ...unique(400).map((l, i) => (i % 2 ? `+${l}` : `-${l}`))].join('\n');
  const diff = hunk('src/a.js');
  assert.ok(diff.length > CAP * 2);
  for (const command of ['git diff', 'git diff main...HEAD -- src', 'git show HEAD']) {
    const body = command === 'git show HEAD' ? `commit abcdef0\nAuthor: A <a@b.c>\n\n    message\n\n${diff}` : diff;
    const { result, teed } = run(body, { command });
    assert.ok(!capped(result), command);
    assert.equal(result.capExempt, 'diff', command);
    assert.deepEqual(teed, []);
  }
  // A bare hunk (no diff --git header), e.g. `git diff --no-prefix` fragments or `diff -u`, is also diff-shaped.
  assert.equal(run(diff.split('\n').slice(4).join('\n'), { command: 'diff -u a b' }).result.capExempt, 'diff');
});

test('whole-output JSON is not capped; JSON followed by text is', () => {
  const pretty = JSON.stringify(unique(400).map((line, i) => ({ id: i, text: line })), null, 2);
  assert.ok(pretty.length > CAP * 2);
  for (const command of ['jq . data.json', 'curl -s https://x.test/api | jq .', 'gh api repos/o/r/issues']) {
    const { result, teed } = run(pretty, { command });
    assert.ok(!capped(result), command);
    assert.equal(result.capExempt, 'json', command);
    assert.deepEqual(teed, []);
  }
  const withTrailer = run(`${pretty}\nDone in 2.3s`, { command: 'node dump.mjs' });
  assert.ok(capped(withTrailer.result), 'not valid JSON as a whole');
  assert.equal(withTrailer.result.capExempt, null);
  // Not JSON-looking at all: a bracketed log line must not trigger a parse exemption.
  assert.ok(capped(run(`[info] ${unique(400).join('\n')}`).result));
});

test('no recovery path, no cap: tee disabled, mode never/failures, below TOKENSLIM_TEE_MIN, dryRun', () => {
  const input = unique(500).join('\n');
  const cases = [
    ['tee.enabled false', { tee: { enabled: false } }],
    ['mode never', { tee: { mode: 'never' } }],
    ['mode failures', { tee: { mode: 'failures' } }],
    ['TOKENSLIM_DISABLE=tee', { env: { TOKENSLIM_DISABLE: 'tee' } }],
    ['maxFiles 0', { tee: { maxFiles: 0 } }],
    ['below TOKENSLIM_TEE_MIN', { env: { TOKENSLIM_TEE_MIN: '1000000' } }],
    ['dryRun', { dryRun: true }],
  ];
  for (const [label, options] of cases) {
    const { result, teed } = run(input, options);
    assert.ok(!capped(result), label);
    assert.equal(result.updatedToolOutput, null, label);
    assert.equal(result.capExempt, 'noTee', label);
    assert.deepEqual(teed, [], label);
  }
  // A tee that cannot be written (no session id) also means no cap.
  const iso = isolatedEnv({ TOKENSLIM_TEE_MIN: '0' });
  try {
    const config = mergeConfigLayer(loadConfig(root, iso.env), { bash: { capChars: CAP } });
    const noIds = processBashPayload({ tool_input: { command: 'cat x' }, tool_response: { stdout: input, stderr: '' } }, { config, env: iso.env });
    assert.ok(!capped(noIds));
    assert.equal(noIds.capExempt, 'noTee');
  } finally { iso.cleanup(); }
});

test('without a tee the cap falls back to exactly the uncapped result', () => {
  // Plain compression is worthwhile on its own here (progress noise), so the fallback still compresses.
  const noisy = `${Array.from({ length: 300 }, (_, i) => `Downloading ${i}%\rDownloading ${i + 1}%`).join('\n')}\n${unique(400).join('\n')}`;
  const without = run(noisy, { tee: { enabled: false } });
  const capOff = run(noisy, { tee: { enabled: false }, cap: 0 });
  assert.ok(without.result.rulesApplied.length > 0 && !capped(without.result));
  assert.equal(without.result.capExempt, 'noTee');
  assert.deepEqual(without.result.updatedToolOutput, capOff.result.updatedToolOutput);
  assert.equal(without.result.bytesOut, capOff.result.bytesOut);
  assert.ok(capped(run(noisy).result), 'with a tee the same output is capped');
});

test('assumeTee (replay only): the cap is accounted for a dryRun without writing anything', () => {
  const input = unique(500).join('\n');
  const assumed = run(input, { dryRun: true, assumeTee: true });
  assert.ok(capped(assumed.result));
  assert.equal(assumed.result.recoveryPath, null);
  assert.deepEqual(assumed.teed, []);
  assert.match(assumed.result.updatedToolOutput.stdout, /\n\[tokenslim: full: [^\]]+\]$/, 'marker bytes are accounted for');
  const real = run(input);
  assert.ok(Math.abs(assumed.result.bytesOut - real.result.bytesOut) < 120, 'placeholder path is close to a real path length');
  // The real tee gates still apply in replay.
  const gated = run(input, { dryRun: true, assumeTee: true, tee: { mode: 'never' } });
  assert.ok(!capped(gated.result));
  assert.equal(gated.result.capExempt, 'noTee');
  const small = run(input, { dryRun: true, assumeTee: true, env: { TOKENSLIM_TEE_MIN: '1000000' } });
  assert.ok(!capped(small.result));
  // assumeTee is ignored outside a dryRun: it must never make a real hook cap without a file.
  const live = run(input, { assumeTee: true, tee: { enabled: false } });
  assert.ok(!capped(live.result));
});

// --- grep-shaped omitted region ---

const FILES = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js'];
const grepLines = (perFile) => FILES.flatMap((file) => Array.from({ length: perFile }, (_, i) => `${file}:${i + 1}:  const value${i} = compute(${i * 7919});`));

test('omittedMatchCounts: raw grep lines count per file', () => {
  const lines = grepLines(100);
  // Head 60 lines = all of a (100) minus nothing: cut at [60, 440): a keeps 60, e keeps its last 60.
  const counts = omittedMatchCounts(lines, 60, 440);
  assert.deepEqual(counts, [['src/a.js', 40], ['src/b.js', 100], ['src/c.js', 100], ['src/d.js', 100], ['src/e.js', 40]]);
});

test('omittedMatchCounts: grouped text resolves headers kept in the head, and context lines are not matches', () => {
  const grouped = group(grepLines(100).join('\n')).split('\n');
  assert.equal(grouped.length, 505);
  const counts = omittedMatchCounts(grouped, 60, 505 - 60);
  assert.deepEqual(counts, [['src/a.js', 41], ['src/b.js', 100], ['src/c.js', 100], ['src/d.js', 100], ['src/e.js', 40]]);
  const withContext = [];
  for (let i = 0; i < 30; i += 1) withContext.push(`src/a.js:${i * 2 + 1}:match`, `src/a.js-${i * 2 + 2}-context`);
  assert.deepEqual(omittedMatchCounts(withContext, 0, 60), [['src/a.js', 30]]);
});

test('omittedMatchCounts: declines non grep-shaped or too-small regions', () => {
  assert.equal(omittedMatchCounts(unique(100), 10, 90), null);
  assert.equal(omittedMatchCounts(grepLines(100).slice(0, 7), 0, 7), null, 'fewer than 8 matches');
  const mixed = [...grepLines(5), ...unique(60)];
  assert.equal(omittedMatchCounts(mixed, 0, mixed.length), null, 'under 60% grep-shaped');
});

test('headTailTruncate grepCounts appends per-file counts after the omitted marker; off by default', () => {
  const lines = grepLines(100);
  const text = lines.join('\n');
  const plain = headTailTruncate(text, { maxChars: 100, headLines: 60, tailLines: 60 });
  assert.doesNotMatch(plain, /omitted matches by file/);
  const withCounts = headTailTruncate(text, { maxChars: 100, headLines: 60, tailLines: 60, grepCounts: true });
  assert.match(withCounts, /\[tokenslim: 380 lines omitted\]\n\[tokenslim: omitted matches by file\]\nsrc\/a\.js: 40\nsrc\/b\.js: 100\nsrc\/c\.js: 100\nsrc\/d\.js: 100\nsrc\/e\.js: 40\n/);
  // Non grep text never gets the section.
  assert.doesNotMatch(headTailTruncate(unique(300).join('\n'), { maxChars: 100, headLines: 60, tailLines: 60, grepCounts: true }), /omitted matches/);
  const many = Array.from({ length: 300 }, (_, i) => `src/f${i}.js:1:  const x = 1;`).join('\n');
  const limited = headTailTruncate(many, { maxChars: 100, headLines: 10, tailLines: 10, grepCounts: true });
  assert.match(limited, /\[tokenslim: 240 more files, 240 matches\]/);
});

test('hook end to end: grouped grep output is capped and the omitted counts add up to the original', () => {
  const lines = grepLines(100);
  const input = lines.join('\n');
  const { result, recovered } = run(input, { command: 'grep -rn value .' });
  assert.ok(capped(result));
  assert.ok(result.rulesApplied.includes('groupByPath'));
  assert.equal(recovered, input);
  const out = result.updatedToolOutput.stdout;
  const section = /\[tokenslim: omitted matches by file\]\n((?:src\/\w\.js: \d+\n)+)/.exec(out);
  assert.ok(section, out);
  const omittedTotal = section[1].trim().split('\n').reduce((sum, row) => sum + Number(row.split(': ')[1]), 0);
  // Visible matches: member lines in the kept head and tail (the grouped text keeps `  N:text` members).
  const visible = out.split('\n').filter((line) => /^ {2}\d+:/.test(line)).length;
  assert.equal(omittedTotal + visible, 500);
});

// --- shell-segments ---

test('splitSegments splits on unquoted separators only', () => {
  assert.deepEqual(splitSegments('a | b && c || d; e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(splitSegments('echo "a | b" && echo \'c; d\''), ['echo "a | b"', "echo 'c; d'"]);
  assert.deepEqual(splitSegments('echo a\\|b | head -n 3'), ['echo a\\|b', 'head -n 3']);
  assert.deepEqual(splitSegments('echo "say \\"hi | there\\"" | wc'), ['echo "say \\"hi | there\\""', 'wc']);
  assert.deepEqual(splitSegments('make 2>&1 | tail -n 5'), ['make 2>&1', 'tail -n 5']);
  assert.deepEqual(splitSegments('a |& b'), ['a', 'b']);
  assert.deepEqual(splitSegments('a \\\n  b | c'), ['a   b', 'c']);
  assert.deepEqual(splitSegments('  ;; | '), []);
  assert.deepEqual(splitSegments(''), []);
});

test('splitSegments returns null on malformed input and never throws', () => {
  for (const bad of ['echo "open', "echo 'open | head", 'echo trailing\\', 'a | "b', null, undefined, 42]) {
    assert.equal(splitSegments(bad), null, String(bad));
  }
  assert.equal(lastSegment('echo "open'), null);
  assert.equal(lastSegment(''), null);
  assert.equal(lastSegment(' ; '), null);
});

test('tokenizeSegment and lastSegment strip quotes and escapes; single quotes are literal', () => {
  assert.deepEqual(tokenizeSegment(`sed -n '5,20p' "my file"`), ['sed', '-n', '5,20p', 'my file']);
  assert.deepEqual(tokenizeSegment('echo a\\ b \'c\\d\' ""'), ['echo', 'a b', 'c\\d', '']);
  assert.equal(tokenizeSegment('x "y'), null);
  assert.deepEqual(lastSegment('cat f | grep "a|b" | head -n 20'), ['head', '-n', '20']);
  assert.deepEqual(lastSegment('make && echo done'), ['echo', 'done']);
});

test('isBoundedRead recognizes only plain-number line bounds', () => {
  const bounded = (command) => isBoundedRead(lastSegment(command));
  for (const command of ['head -n 5', 'head -n5', 'head -5', 'tail -n 100', 'tail -100', 'head --lines=20', 'tail --lines 20', '/usr/bin/head -n 3', 'LC_ALL=C head -n 3', "sed -n '1,40p'", "sed -n 10p", "sed -n -e '1,3p'", "awk 'NR<=20'", "gawk 'NR==5{print}'"]) {
    assert.equal(bounded(command), true, command);
  }
  for (const command of ['head', 'tail -f log', 'tail -n +5', 'head -n -5', 'head -c 100', "sed 's/a/b/'", "sed -n '5,$p'", "awk '{print $1}'", 'cat', 'grep -n x', 'jq .']) {
    assert.equal(bounded(command), false, command);
  }
  assert.equal(isBoundedRead(null), false);
  assert.equal(isBoundedRead([]), false);
});

// --- config ---

function withEnv(extra, fn) {
  const iso = isolatedEnv(extra);
  try { clearConfigCache(); return fn(iso.env); } finally { iso.cleanup(); clearConfigCache(); }
}

test('config: bash cap defaults, tee.maxFiles default, validation and env override', () => {
  withEnv({}, (env) => {
    const config = loadConfig(root, env);
    assert.deepEqual(config.bash, { capChars: 0, capHeadLines: 60, capTailLines: 60 });
    assert.equal(config.tee.maxFiles, 100);
  });
  const layer = (bash) => mergeConfigLayer(loadConfig(root, {}), { bash }).bash;
  assert.equal(layer({ capChars: 8000 }).capChars, 8000);
  assert.equal(layer({ capChars: 2000 }).capChars, 2000);
  assert.equal(layer({ capChars: 0 }).capChars, 0);
  assert.equal(layer({ capHeadLines: 10, capTailLines: 0 }).capTailLines, 0);
  assert.equal(layer({ capHeadLines: 10 }).capChars, 0, 'nested merge keeps the other bash keys');
});

test('config: invalid bash values are dropped by the layer validator', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { loadConfigLayerFile } = await import('../scripts/lib/config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-cap-config-'));
  try {
    const layerFor = (bash) => {
      writeFileSync(join(dir, 'l.json'), JSON.stringify({ bash }));
      return loadConfigLayerFile(join(dir, 'l.json'));
    };
    assert.deepEqual(layerFor({ capChars: 1999 }), {});
    assert.deepEqual(layerFor({ capChars: -1 }), {});
    assert.deepEqual(layerFor({ capChars: 2500.5 }), {});
    assert.deepEqual(layerFor({ capChars: '8000' }), {});
    assert.deepEqual(layerFor({ capHeadLines: -1, capTailLines: 1.5 }), {});
    assert.deepEqual(layerFor({ capChars: 8000, capHeadLines: 5, capTailLines: 7, junk: 1 }), { bash: { capChars: 8000, capHeadLines: 5, capTailLines: 7 } });
    assert.deepEqual(layerFor('nope'), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config: TOKENSLIM_BASH_CAP_CHARS overrides files, is validated, and is part of the cache key', () => {
  const iso = isolatedEnv();
  try {
    clearConfigCache();
    const base = { ...iso.env };
    assert.equal(loadConfig(root, base).bash.capChars, 0);
    assert.equal(loadConfig(root, { ...base, TOKENSLIM_BASH_CAP_CHARS: '12000' }).bash.capChars, 12000);
    // Same cwd and files, different env: a stale cache entry would still say 12000 or 0.
    assert.equal(loadConfig(root, base).bash.capChars, 0);
    assert.equal(loadConfig(root, { ...base, TOKENSLIM_BASH_CAP_CHARS: '0' }).bash.capChars, 0);
    for (const bad of ['1999', '-5', 'abc', '', '8000.5', '1e3']) {
      assert.equal(loadConfig(root, { ...base, TOKENSLIM_BASH_CAP_CHARS: bad }).bash.capChars, 0, `invalid ${JSON.stringify(bad)} ignored`);
    }
    // Head/tail keep their defaults when only capChars is overridden (nested merge).
    assert.deepEqual(loadConfig(root, { ...base, TOKENSLIM_BASH_CAP_CHARS: '8000' }).bash, { capChars: 8000, capHeadLines: 60, capTailLines: 60 });
  } finally { iso.cleanup(); clearConfigCache(); }
});

// --- spawned hook ---

test('spawned hook honors TOKENSLIM_BASH_CAP_CHARS and writes a tee that equals the original', () => {
  const iso = isolatedEnv({ TOKENSLIM_BASH_CAP_CHARS: '8000', TOKENSLIM_TEE_MIN: '0', TOKENSLIM_HOOK_RUNTIME: 'claude' });
  try {
    const input = unique(500).join('\n');
    const payload = { session_id: 'cap-spawn', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_spawn', cwd: iso.env.XDG_CONFIG_HOME, tool_input: { command: 'cat big.log' }, tool_response: { stdout: input, stderr: '', interrupted: false, isImage: false } };
    const spawned = spawnSync(process.execPath, [join(root, 'scripts', 'compress-bash.mjs')], { input: JSON.stringify(payload), encoding: 'utf8', env: iso.env });
    assert.equal(spawned.status, 0, spawned.stderr);
    const out = JSON.parse(spawned.stdout).hookSpecificOutput.updatedToolOutput.stdout;
    assert.match(out, /\[tokenslim: capMidBand\]\n\[tokenslim: full: (.+)\]$/);
    const path = /\[tokenslim: full: (.+)\]$/.exec(out)[1];
    assert.equal(readFileSync(path, 'utf8'), input);
    // Without the env var the same payload is left alone.
    const off = spawnSync(process.execPath, [join(root, 'scripts', 'compress-bash.mjs')], { input: JSON.stringify({ ...payload, tool_use_id: 'toolu_off' }), encoding: 'utf8', env: { ...iso.env, TOKENSLIM_BASH_CAP_CHARS: '0' } });
    assert.equal(off.status, 0);
    assert.doesNotMatch(off.stdout, /capMidBand/);
  } finally { iso.cleanup(); }
});
