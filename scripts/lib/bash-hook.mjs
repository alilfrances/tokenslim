// Bash PostToolUse core, free of stdin/stdout/ledger I/O so the hook wrapper, the offline replay benchmark and
// the parity test all run the same code. The wrapper (compress-bash.mjs) owns the ledger and the JSON output.
import { compressBashOutput, stripAnsi, stripProgressNoise } from './pipeline.mjs';
import { commandMeta, compressCommandOutput } from './cmd-compressors/index.mjs';
import { compressShapeOutput } from './shape-compressors/index.mjs';
import { FAILURE_RE } from './cmd-compressors/shared.mjs';
import { appendTeePath, teeOriginalOutput } from './tee.mjs';

export function bashDisabled(config, env = process.env) {
  const flags = Array.isArray(config?.disable) ? config.disable : String(env.TOKENSLIM_DISABLE || '')
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
  // Shape dispatch reads only the output, so it applies even when the command is unsafe or unknown.
  const shaped = compressShapeOutput(text);
  if (shaped) {
    const generic = compressBashOutput(shaped.text);
    // The generic pass also trims trailing newlines and normalizes CRLF, which is display-only like ANSI.
    const displayOnly = stripAnsi(shaped.text).replace(/\r\n/g, '\n').replace(/\n+$/g, '');
    return {
      text: generic.text,
      lossless: shaped.lossless === true && generic.text === displayOnly,
      stats: {
        bytesIn: Buffer.byteLength(text, 'utf8'),
        bytesOut: generic.stats.bytesOut,
        rulesApplied: [...new Set([...shaped.rulesApplied, ...generic.stats.rulesApplied])],
      },
    };
  }
  return compressBashOutput(text);
}

function isLossy(original, result) {
  // ANSI removal and lossless shape rewrites (result.lossless) are reversible/display-only; every other
  // change may discard information and is therefore eligible for recovery.
  return result.lossless !== true && result.text !== stripAnsi(original);
}

function markCompression(text, rulesApplied) {
  const output = String(text ?? '');
  const rules = [...new Set(rulesApplied || [])].join(', ') || 'compressed';
  // Output can legitimately contain tokenslim examples or a prior tee log. Always
  // add our marker as a fresh final line instead of trusting an arbitrary substring.
  return `${output}${output ? '\n' : ''}[tokenslim: ${rules}]`;
}

/**
 * Decide and build the replacement for one Bash tool response. Pure unless !dryRun, when the lossy original
 * is teed for recovery. Outcomes: disabled, skippedImage, skippedBelowThreshold, skippedFailure,
 * skippedPoorRatio, compressed. bytesOut is what would be emitted (tee marker included); pass-through
 * outcomes report bytesOut === bytesIn and updatedToolOutput null. Throws on internal errors; the hook
 * wrapper fails open.
 */
export function processBashPayload(payload, { config, env = process.env, dryRun = false } = {}) {
  const none = (outcome, bytes = 0) => ({ outcome, updatedToolOutput: null, bytesIn: bytes, bytesOut: bytes, rulesApplied: [], recoveryPath: null });
  if (bashDisabled(config, env)) return none('disabled');
  const response = payload?.tool_response;
  const stringResponse = typeof response === 'string';
  const stdout = stringResponse ? response : String(response?.stdout ?? '');
  const stderr = stringResponse ? '' : String(response?.stderr ?? '');
  const inputBytes = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');
  if (!stringResponse && response?.isImage === true) return none('skippedImage', inputBytes);
  const threshold = Number.isFinite(config?.minChars) ? config.minChars : 500;
  if (stdout.length + stderr.length < threshold) return none('skippedBelowThreshold', inputBytes);

  // A non-zero command's diagnostic output is more valuable than savings. Do not
  // risk changing it; successful commands still receive command-aware compression.
  const command = payload?.tool_input?.command;
  const failed = failureOutput(stdout, stderr, command, response);
  if (failed) return none('skippedFailure', inputBytes);
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
  if (bytesIn === 0 || bytesOut / bytesIn > 0.9) return none('skippedPoorRatio', inputBytes);

  const original = stringResponse ? stdout : (stderr ? `${stdout}\nstderr:\n${stderr}` : stdout);
  const recoveryPath = dryRun ? null : teeOriginalOutput(original, {
    sessionId: payload?.session_id,
    toolUseId: payload?.tool_use_id,
    config,
    env,
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
  const emittedBytesOut = stringResponse
    ? Buffer.byteLength(recoveredStdout, 'utf8')
    : Buffer.byteLength(recoveredStdout, 'utf8') + Buffer.byteLength(recoveredStderr, 'utf8');
  const rulesApplied = [...new Set([...(compressedStdout.stats.rulesApplied || []), ...compressedStderr.stats.rulesApplied])];
  return { outcome: 'compressed', updatedToolOutput, bytesIn, bytesOut: emittedBytesOut, rulesApplied, recoveryPath: recoveryPath || null };
}
