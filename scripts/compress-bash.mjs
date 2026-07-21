#!/usr/bin/env node
import { compressBashOutput, stripAnsi, stripProgressNoise } from './lib/pipeline.mjs';
import { commandMeta, compressCommandOutput } from './lib/cmd-compressors/index.mjs';
import { FAILURE_RE } from './lib/cmd-compressors/shared.mjs';
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

function observedExitFailure(response) {
  const value = response?.exitCode ?? response?.exit_code;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value) !== 0;
  return null;
}

export function failureOutput(stdout, stderr, command, response) {
  // An observed exit code is authoritative. Most Claude Bash payloads do not contain
  // one, so fall back to structured records rather than treating routine stderr as a
  // failure channel.
  const exitFailure = observedExitFailure(response);
  if (exitFailure !== null) return exitFailure;
  if (FAILURE_RE.test(stripAnsi(stderr))) return true;
  // Linter diagnostics have a purpose-built, location-preserving compressor. Their
  // stdout diagnostics are the one intentional exception; a failure on stderr still
  // passes through above. commandMeta also handles env/path/launcher forms here.
  const binary = commandMeta(command)?.binary;
  return !['eslint', 'tsc', 'ruff'].includes(binary) && FAILURE_RE.test(stripAnsi(stdout));
}

function compressStderr(text) {
  const input = String(text ?? '');
  const withoutAnsi = stripAnsi(input);
  const output = stripProgressNoise(withoutAnsi, { buildProgress: true });
  const rulesApplied = [];
  if (withoutAnsi !== input) rulesApplied.push('stripAnsi');
  if (output !== withoutAnsi) rulesApplied.push('stripProgressNoise');
  return { text: output, stats: {
    bytesIn: Buffer.byteLength(input, 'utf8'),
    bytesOut: Buffer.byteLength(output, 'utf8'),
    rulesApplied,
  } };
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
  const rules = [...new Set(rulesApplied || [])].join(', ') || 'compressed';
  // Output can legitimately contain tokenslim examples or a prior tee log. Always
  // add our marker as a fresh final line instead of trusting an arbitrary substring.
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
    if (!stringResponse && response?.isImage === true) {
      recordLedgerBestEffort(payload?.session_id, event, 'skippedImage');
      passThrough(payload);
      return;
    }
    const threshold = Number.isFinite(config.minChars) ? config.minChars : 500;
    if (stdout.length + stderr.length < threshold) {
      recordLedgerBestEffort(payload?.session_id, event, 'skippedBelowThreshold');
      passThrough(payload);
      return;
    }

    // A non-zero command's diagnostic output is more valuable than savings. Do not
    // risk changing it; successful commands still receive command-aware compression.
    const command = payload?.tool_input?.command;
    const failed = failureOutput(stdout, stderr, command, response);
    if (failed) {
      recordLedgerBestEffort(payload?.session_id, event, 'skippedFailure');
      passThrough(payload);
      return;
    }
    const compressedStdout = compressed(stdout, command, config, { stderr });
    // stderr often carries healthy build/network progress. Never run a specialized
    // or generic lossy compressor over it: remove ANSI/progress noise only.
    const compressedStderr = compressStderr(stderr);
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
      failed,
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
