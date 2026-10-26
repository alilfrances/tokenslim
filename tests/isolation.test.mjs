import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedEnv } from './helpers.mjs';

const root = join(import.meta.dirname, '..');
const FIXTURE_SOURCE = join(root, 'tests', 'fixtures', 'read', 'source-with-blanks.js');
const FIXTURE_GREP = readFileSync(join(root, 'tests', 'fixtures', 'read', 'large-grep-output.txt'), 'utf8');

test('isolatedEnv gives each call private XDG dirs that win over the inherited env and can be cleaned up', () => {
  const a = isolatedEnv({ TOKENSLIM_MIN_CHARS: '10' });
  const b = isolatedEnv({ XDG_DATA_HOME: '/pinned' });
  try {
    assert.notEqual(a.env.XDG_CACHE_HOME, b.env.XDG_CACHE_HOME);
    assert.equal(a.env.TOKENSLIM_MIN_CHARS, '10');
    assert.equal(b.env.XDG_DATA_HOME, '/pinned');
    for (const key of ['XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME']) assert.ok(a.env[key].startsWith(tmpdir()), key);
  } finally { a.cleanup(); b.cleanup(); }
  assert.ok(!existsSync(a.env.XDG_CACHE_HOME));
});

test('hook spawns write only under the isolated XDG dirs, never under HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'tokenslim-guard-home-'));
  const iso = isolatedEnv({ HOME: home, TOKENSLIM_MIN_CHARS: '10', TOKENSLIM_HOOK_RUNTIME: 'claude' });
  const hook = (script, payload) => {
    const result = spawnSync(process.execPath, [join(root, 'scripts', script)], { cwd: root, input: JSON.stringify(payload), encoding: 'utf8', env: iso.env });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    return result;
  };
  try {
    const bashOut = Array.from({ length: 12 }, (_, i) => `build worker ${i} processed ${i} files`).join('\n');
    const compressedBash = hook('compress-bash.mjs', { session_id: 'guard-bash', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 't1', tool_response: { stdout: bashOut, stderr: '', interrupted: false, isImage: false } });
    assert.ok(compressedBash.stdout, 'bash output should be compressed so the savings paths run');

    const read = { session_id: 'guard-read', tool_name: 'Read', tool_input: { file_path: FIXTURE_SOURCE }, tool_response: { type: 'text', file: { filePath: FIXTURE_SOURCE, content: readFileSync(FIXTURE_SOURCE, 'utf8'), numLines: 5, startLine: 1, totalLines: 5 } } };
    hook('compress-read.mjs', read);
    assert.ok(hook('compress-read.mjs', read).stdout, 'second identical read should produce a stub');

    const compressedGrep = hook('compress-grep.mjs', { session_id: 'guard-grep', tool_name: 'Grep', tool_input: {}, tool_response: { mode: 'content', numFiles: 3, filenames: ['a', 'b', 'c'], content: FIXTURE_GREP, numLines: FIXTURE_GREP.split('\n').length } });
    assert.ok(compressedGrep.stdout);

    const json = JSON.stringify({ items: Array.from({ length: 25 }, (_, i) => ({ id: i, name: `item-${i}` })) }, null, 2);
    const compressedMcp = hook('compress-mcp.mjs', { session_id: 'guard-mcp', tool_name: 'mcp__demo__tool', tool_response: { content: json } });
    assert.ok(compressedMcp.stdout);

    // The hooks did run and persist state, but only into the isolated dirs.
    assert.ok(readdirSync(join(iso.env.XDG_CACHE_HOME, 'tokenslim')).length >= 4);
    assert.deepEqual(readdirSync(home), []);
  } finally { iso.cleanup(); rmSync(home, { recursive: true, force: true }); }
});

// Static guard: a new test that spawns a script with the inherited env would write to the real ~/.cache
// again. Heuristic by design (no AST): each spawn call must pass an explicit env, never spread process.env,
// and its file must import isolatedEnv.
test('every spawn in tests/*.test.mjs goes through isolatedEnv', () => {
  const offenders = [];
  for (const name of readdirSync(join(root, 'tests')).filter((n) => n.endsWith('.test.mjs') && n !== 'isolation.test.mjs')) {
    const source = readFileSync(join(root, 'tests', name), 'utf8');
    const re = /\b(spawnSync|execFileSync|execSync|spawn|execFile)\(/g;
    for (let m; (m = re.exec(source));) {
      if (source.slice(Math.max(0, m.index - 20), m.index).includes('import')) continue;
      let depth = 0; let end = m.index + m[0].length - 1;
      for (; end < source.length; end += 1) {
        if (source[end] === '(') depth += 1;
        else if (source[end] === ')' && --depth === 0) break;
      }
      const call = source.slice(m.index, end + 1);
      const line = source.slice(0, m.index).split('\n').length;
      const explicitEnv = /\benv\b\s*[:,}]/.test(call) && !/\.\.\.process\.env/.test(call);
      if (!/\bisolatedEnv\(/.test(source) || !explicitEnv) offenders.push(`${name}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], 'spawn calls must use env from isolatedEnv() (tests/helpers.mjs)');
});
