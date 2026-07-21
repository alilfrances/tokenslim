import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRuntime } from '../scripts/lib/hook-output.mjs';

const claudePayload = {
  permission_mode: 'default',
  tool_use_id: 'toolu_claude',
  model: 'claude-sonnet',
  cwd: '/workspace',
};

const matrix = [
  {
    name: 'explicit Codex override wins over a Claude-compatible payload',
    payload: claudePayload,
    env: { TOKENSLIM_HOOK_RUNTIME: 'codex' },
    expected: 'codex',
  },
  {
    name: 'explicit Claude override wins over a Codex turn marker',
    payload: { turn_id: 'turn-codex' },
    env: { TOKENSLIM_HOOK_RUNTIME: 'claude' },
    expected: 'claude',
  },
  {
    name: 'Claude permission_mode, tool_use_id, model, and cwd are not Codex markers',
    payload: claudePayload,
    env: {},
    expected: 'claude',
  },
  {
    name: 'Codex turn_id outranks the Claude compatibility root',
    payload: { turn_id: 'turn-codex' },
    env: { CLAUDE_PLUGIN_ROOT: '/plugins/tokenslim' },
    expected: 'codex',
  },
  {
    name: 'CODEX_PLUGIN_ROOT detects Codex without a Claude root',
    payload: {},
    env: { CODEX_PLUGIN_ROOT: '/plugins/tokenslim' },
    expected: 'codex',
  },
  {
    name: 'PLUGIN_DATA detects Codex without a Claude root',
    payload: {},
    env: { PLUGIN_DATA: '/data/tokenslim' },
    expected: 'codex',
  },
  {
    name: 'Claude root prevents Codex environment fallback',
    payload: {},
    env: { CLAUDE_PLUGIN_ROOT: '/plugins/tokenslim', CODEX_PLUGIN_ROOT: '/plugins/tokenslim', PLUGIN_DATA: '/data/tokenslim' },
    expected: 'claude',
  },
  {
    name: 'an unknown payload and legacy PLUGIN_ROOT use the safe Claude default',
    payload: null,
    env: { PLUGIN_ROOT: '/plugins/tokenslim' },
    expected: 'claude',
  },
];

test('runtime detection matrix', async (t) => {
  for (const entry of matrix) {
    await t.test(entry.name, () => {
      assert.equal(detectRuntime(entry.payload, entry.env), entry.expected);
    });
  }
});
