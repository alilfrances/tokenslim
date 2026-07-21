import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = join(__dirname, '..', 'scripts', 'compress-mcp.mjs');

function run(payload, extraEnv = {}) {
  return spawnSync('node', [MCP_SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

function parseOutput(result) {
  if (!result.stdout) return undefined;
  return JSON.parse(result.stdout);
}

function withTempCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenslim-mcp-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function payload(sessionId, text) {
  return {
    session_id: sessionId,
    tool_name: 'mcp__demo__tool',
    tool_response: { content: text, extra: 'keep' },
  };
}

test('MCP minifies pretty JSON and records savings', () => {
  withTempCache((cacheDir) => {
    const pretty = JSON.stringify({ items: Array.from({ length: 25 }, (_, i) => ({ id: i, name: `item-${i}` })) }, null, 2);
    const result = run(payload('sess-mcp-json', pretty), { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' });
    const out = parseOutput(result);
    assert.equal(out.hookSpecificOutput.updatedToolOutput.extra, 'keep');
    assert.equal(out.hookSpecificOutput.updatedToolOutput.content, JSON.stringify(JSON.parse(pretty)));

    const state = JSON.parse(readFileSync(join(cacheDir, 'tokenslim', 'sess-mcp-json.json'), 'utf8'));
    assert.equal(state.savings.MCP.events, 1);
  });
});

test('MCP truncates explicit base64 but preserves base64-like identifiers and hex', () => {
  withTempCache((cacheDir) => {
    const data = `data:application/octet-stream;base64,${'A'.repeat(320)}`;
    const result = run(payload('sess-mcp-b64', `prefix ${data} suffix`), {
      XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10',
    });
    const text = parseOutput(result).hookSpecificOutput.updatedToolOutput.content;
    assert.match(text, /^prefix data:application\/octet-stream;base64,A{27}\[tokenslim: 293 base64 chars omitted\] suffix$/);

    const raw = 'a'.repeat(512);
    const untouched = run(payload('sess-mcp-hex', `prefix ${raw} suffix`), {
      XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10',
    });
    assert.equal(untouched.stdout, '', 'unprefixed hex/base64-like text is not truncated');
  });
});

test('MCP collapses homogeneous top-level arrays only behind env flag', () => {
  withTempCache((cacheDir) => {
    const arr = Array.from({ length: 55 }, (_, i) => ({ id: i, value: `v-${i}` }));
    const text = JSON.stringify(arr, null, 2);
    const off = run(payload('sess-mcp-array-off', text), { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' });
    assert.doesNotMatch(parseOutput(off).hookSpecificOutput.updatedToolOutput.content, /more items, same keys/);

    const on = run(payload('sess-mcp-array-on', text), {
      XDG_CACHE_HOME: cacheDir,
      TOKENSLIM_MIN_CHARS: '10',
      TOKENSLIM_MCP_ARRAYS: '1',
    });
    const collapsed = parseOutput(on).hookSpecificOutput.updatedToolOutput.content;
    assert.match(collapsed, /\[tokenslim: 45 more items, same keys: id,value\]/);
    assert.equal(JSON.parse(collapsed).length, 11);
  });
});

test('MCP obeys ratio floor, is deterministic, and malformed stdin fails open', () => {
  withTempCache((cacheDir) => {
    const poorRatio = 'plain text with no compressible structure '.repeat(20);
    const skipped = run(payload('sess-mcp-poor', poorRatio), { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' });
    assert.equal(skipped.stdout, '');

    const pretty = JSON.stringify({ a: Array.from({ length: 10 }, (_, i) => ({ i, value: 'x'.repeat(20) })) }, null, 2);
    const env = { XDG_CACHE_HOME: cacheDir, TOKENSLIM_MIN_CHARS: '10' };
    const first = run(payload('sess-mcp-deterministic-a', pretty), env).stdout;
    const second = run(payload('sess-mcp-deterministic-b', pretty), env).stdout;
    assert.equal(
      parseOutput({ stdout: first }).hookSpecificOutput.updatedToolOutput.content,
      parseOutput({ stdout: second }).hookSpecificOutput.updatedToolOutput.content
    );

    const bad = run('not json {{{', env);
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, '');
  });
});
