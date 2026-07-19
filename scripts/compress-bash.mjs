#!/usr/bin/env node
import { compressBashOutput, stripAnsi } from './lib/pipeline.mjs';
import { compressCommandOutput } from './lib/cmd-compressors/index.mjs';
import { loadConfig } from './lib/config.mjs';
import { appendTeePath, teeOriginalOutput } from './lib/tee.mjs';
import { postToolUseNoopOutput, postToolUseOutput } from './lib/hook-output.mjs';
import { loadState, recordDiagnostic, recordSavings, saveState } from './lib/state.mjs';

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function disabled(config) {
  const flags = Array.isArray(config?.disable) ? config.disable : String(process.env.TOKENSLIM_DISABLE || '')
    .split(',').map((part) => part.trim()).filter(Boolean);
  const normalized = flags.map((part) => part.toLowerCase());
  return normalized.includes('all') || normalized.includes('bash');
}

function failureOutput(stdout, stderr, command) {
  if (stderr.trim()) return true;
  // Linter diagnostics are intentionally summarized by their dedicated compressor;
  // for all other commands error-like output is preserved byte-for-byte.
  const binary = String(command || '').trim().split(/\s+/, 1)[0];
  if (['eslint', 'tsc', 'ruff'].includes(binary)) return false;
  return /\b(?:FAIL(?:ED|URE)?|ERROR|Error:|AssertionError|Exception|panic(?:ked)?|fatal:)\b/i.test(stdout);
}

function compressed(text, command, config, extra) {
  const specialized = compressCommandOutput(text, command, config, extra);
  if (specialized) {
    return { text: specialized.text, stats: {
      bytesIn: Buffer.byteLength(text, 'utf8'),
      bytesOut: Buffer.byteLength(specialized.text, 'utf8'),
      rulesApplied: specialized.rulesApplied,
    } };
  }
  return compressBashOutput(text);
}

function isLossy(original, result) {
  // ANSI removal is explicitly reversible/display-only; every other change may
  // discard information and is therefore eligible for recovery.
  return result.text !== stripAnsi(original);
}

function markCompression(text, rulesApplied) {
  const output = String(text ?? '');
  if (output.includes('[tokenslim:')) return output;
  const rules = [...new Set(rulesApplied || [])].join(', ') || 'compressed';
  return `${output}${output ? '\n' : ''}[tokenslim: ${rules}]`;
}

function recordLedgerBestEffort(sessionId, event, outcome, bytesIn = 0, bytesOut = 0, command, cwd) {
  try {
    const state = loadState(sessionId);
    recordDiagnostic(state, { tool: 'Bash', event, outcome });
    if (outcome === 'compressed') recordSavings(state, { tool: 'Bash', bytesIn, bytesOut, command, cwd });
    saveState(sessionId, state);
  } catch {
    // best-effort ledger only
  }
}

function passThrough(payload) {
  const output = postToolUseNoopOutput(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    const event = payload?.hook_event_name || 'PostToolUse';
    const config = loadConfig(payload?.cwd || process.cwd(), process.env);
    if (disabled(config)) {
      recordLedgerBestEffort(payload?.session_id, event, 'disabled');
      passThrough(payload);
      return;
    }
    recordLedgerBestEffort(payload?.session_id, event, 'attempted');
    const response = payload?.tool_response;
    const stringResponse = typeof response === 'string';
    const stdout = stringResponse ? response : String(response?.stdout ?? '');
    const stderr = stringResponse ? '' : String(response?.stderr ?? '');
    const threshold = Number.isFinite(config.minChars) ? config.minChars : 500;
    if (stdout.length + stderr.length < threshold) {
      recordLedgerBestEffort(payload?.session_id, event, 'skippedBelowThreshold');
      passThrough(payload);
      return;
    }

    // A non-zero command's diagnostic output is more valuable than savings. Do not
    // risk changing it; successful commands still receive command-aware compression.
    if (failureOutput(stdout, stderr, payload?.tool_input?.command)) {
      recordLedgerBestEffort(payload?.session_id, event, 'skippedFailure');
      passThrough(payload);
      return;
    }
    const command = payload?.tool_input?.command;
    const compressedStdout = compressed(stdout, command, config, { stderr });
    const compressedStderr = compressed(stderr, command, config, { stderr });
    const markedStdout = compressedStdout.text !== stdout
      ? markCompression(compressedStdout.text, compressedStdout.stats.rulesApplied)
      : compressedStdout.text;
    const markedStderr = compressedStderr.text !== stderr
      ? markCompression(compressedStderr.text, compressedStderr.stats.rulesApplied)
      : compressedStderr.text;
    const bytesIn = compressedStdout.stats.bytesIn + compressedStderr.stats.bytesIn;
    const bytesOut = Buffer.byteLength(markedStdout, 'utf8') + Buffer.byteLength(markedStderr, 'utf8');
    if (bytesIn === 0 || bytesOut / bytesIn > 0.9) {
      recordLedgerBestEffort(payload?.session_id, event, 'skippedPoorRatio');
      passThrough(payload);
      return;
    }

    const original = stringResponse ? stdout : (stderr ? `${stdout}\nstderr:\n${stderr}` : stdout);
    const recoveryPath = teeOriginalOutput(original, {
      sessionId: payload?.session_id,
      toolUseId: payload?.tool_use_id,
      config,
      env: process.env,
      lossy: isLossy(stdout, compressedStdout) || isLossy(stderr, compressedStderr),
      failed: Boolean(stderr.trim() || response?.exitCode || response?.exit_code),
    });
    const recoveredStdout = appendTeePath(markedStdout, recoveryPath);
    const recoveredStderr = recoveryPath && !markedStdout
      ? appendTeePath(markedStderr, recoveryPath)
      : markedStderr;
    const updatedToolOutput = stringResponse
      ? recoveredStdout
      : {
          stdout: recoveredStdout,
          stderr: recoveredStderr,
          interrupted: response?.interrupted,
          isImage: response?.isImage,
        };
    const output = postToolUseOutput(payload, updatedToolOutput);
    process.stdout.write(JSON.stringify(output));
    const emittedBytesOut = stringResponse
      ? Buffer.byteLength(recoveredStdout, 'utf8')
      : Buffer.byteLength(recoveredStdout, 'utf8') + Buffer.byteLength(recoveredStderr, 'utf8');
    recordLedgerBestEffort(payload?.session_id, event, 'compressed', bytesIn, emittedBytesOut, command, payload?.cwd);
  } catch {
    // fail-open: original tool output passes through
  }
}

await main();
process.exit(0);
