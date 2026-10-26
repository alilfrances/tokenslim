// Bash PostToolUse core, free of stdin/stdout/ledger I/O so the hook wrapper, the offline replay benchmark and
// the parity test all run the same code. The wrapper (compress-bash.mjs) owns the ledger and the JSON output.
import { compressBashOutput, headTailTruncate, stripAnsi, stripProgressNoise } from './pipeline.mjs';
import { commandMeta, compressCommandOutput } from './cmd-compressors/index.mjs';
import { compressShapeOutput } from './shape-compressors/index.mjs';
import { FAILURE_RE } from './cmd-compressors/shared.mjs';
import { appendTeePath, teeOriginalOutput, teeWouldWrite } from './tee.mjs';
import { isBoundedRead, lastSegment } from './shell-segments.mjs';

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

function compressed(text, command, config, extra, genericOptions) {
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
    const generic = compressBashOutput(shaped.text, genericOptions);
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
  return compressBashOutput(text, genericOptions);
}

function isLossy(original, result) {
  // ANSI removal and lossless shape rewrites (result.lossless) are reversible/display-only; every other
  // change may discard information and is therefore eligible for recovery.
  return result.lossless !== true && result.text !== stripAnsi(original);
}

const DIFF_RE = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+)/m;
// The cap re-shows at most this many error-like omitted lines (see headTailTruncate maxImportant).
const CAP_MAX_IMPORTANT = 30;
// Stand-in for the tee path when replay assumes the tee succeeds; only its length matters for accounting.
const ASSUMED_TEE_PATH = '/home/user/.cache/tokenslim/tee/00000000-0000-0000-0000-000000000000/toolu_0000000000000000000000.log';

function validJson(text) {
  const trimmed = text.trim();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return false;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}

// Returns the reason the cap must not apply, or null. Exemptions protect output the model needs whole: structure
// (diffs, JSON) and results the command itself already bounded.
function capExemption(original, text, command, capChars) {
  if (DIFF_RE.test(original) || DIFF_RE.test(text)) return 'diff';
  if (validJson(original)) return 'json';
  // A bounded last stage was a deliberate choice; honor it unless the result is still far past the cap.
  if (text.length <= 2 * capChars && isBoundedRead(lastSegment(command))) return 'boundedRead';
  return null;
}

/**
 * Mid-band cap for one stdout. Pure: returns { result, exempt } where result is the capped compression result or null.
 * `plain` is the normal compressed() result; the cap is computed from the same text without the generic 40000-char
 * truncation (which would otherwise pre-empt it and make the omitted counts refer to already-truncated text).
 */
function planCap(stdout, command, config, extra, plain) {
  const capChars = config.bash.capChars;
  const base = plain.stats.rulesApplied.includes('headTailTruncate')
    ? compressed(stdout, command, config, extra, { maxChars: Infinity })
    : plain;
  if (base.text.length <= capChars) return { result: null, exempt: null };
  const exempt = capExemption(stdout, base.text, command, capChars);
  if (exempt) return { result: null, exempt };
  const text = headTailTruncate(base.text, {
    maxChars: capChars,
    headLines: config.bash.capHeadLines ?? 60,
    tailLines: config.bash.capTailLines ?? 60,
    grepCounts: true,
    maxImportant: CAP_MAX_IMPORTANT,
  });
  // Few very long lines cannot be cut by line counts, and a marker can outweigh a tiny cut: no gain, no cap.
  if (text === base.text || text.length >= plain.text.length) return { result: null, exempt: 'noReduction' };
  return {
    exempt: null,
    result: {
      text,
      lossless: false,
      stats: {
        bytesIn: base.stats.bytesIn,
        bytesOut: Buffer.byteLength(text, 'utf8'),
        rulesApplied: [...new Set([...base.stats.rulesApplied, 'capMidBand'])],
      },
    },
  };
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
 * is teed for recovery. Outcomes: disabled, skippedImage, skippedPersisted, skippedBelowThreshold, skippedFailure,
 * skippedPoorRatio, compressed. bytesOut is what would be emitted (tee marker included); pass-through
 * outcomes report bytesOut === bytesIn and updatedToolOutput null. Throws on internal errors; the hook
 * wrapper fails open.
 *
 * Optional mid-band cap (config.bash.capChars > 0, off by default): runs last, truncates stdout to head+tail lines and
 * is applied ONLY when the full original was actually written to a tee file, so the model can always recover it.
 * With no tee (disabled, mode never/failures, below TOKENSLIM_TEE_MIN, write error, dryRun) the normal uncapped result
 * is used. The result's capExempt names why a cap-sized output was not capped (diff, json, boundedRead, noReduction,
 * noTee), else null; 'capMidBand' in rulesApplied means it was.
 *
 * assumeTee (offline replay only): a dryRun never writes, so the cap would always fall back. With assumeTee the tee is
 * treated as succeeding whenever the real tee gates (config, mode, TOKENSLIM_TEE_MIN) would allow it, and the size of a
 * tee marker is accounted for a capped result. Nothing is written and recoveryPath stays null. Ignored unless dryRun.
 */
export function processBashPayload(payload, { config, env = process.env, dryRun = false, assumeTee = false } = {}) {
  const none = (outcome, bytes = 0, capExempt = null) => ({ outcome, updatedToolOutput: null, bytesIn: bytes, bytesOut: bytes, rulesApplied: [], recoveryPath: null, capExempt });
  if (bashDisabled(config, env)) return none('disabled');
  const response = payload?.tool_response;
  const stringResponse = typeof response === 'string';
  const stdout = stringResponse ? response : String(response?.stdout ?? '');
  const stderr = stringResponse ? '' : String(response?.stderr ?? '');
  const inputBytes = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');
  if (!stringResponse && response?.isImage === true) return none('skippedImage', inputBytes);
  // Claude Code persists large results before PostToolUse runs: the hook then sees stdout cut to 30,000 chars plus
  // persistedOutputPath, and the model only sees a ~2KB preview. Compressing or teeing that cut copy helps no one.
  if (!stringResponse && (response?.persistedOutputPath || response?.persistedOutputSize)) return none('skippedPersisted', inputBytes);
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
  const build = (stdoutResult) => {
    const markedStdout = stdoutResult.text !== stdout
      ? markCompression(stdoutResult.text, stdoutResult.stats.rulesApplied)
      : stdoutResult.text;
    const markedStderr = compressedStderr.text !== stderr
      ? markCompression(compressedStderr.text, compressedStderr.stats.rulesApplied)
      : compressedStderr.text;
    const bytesIn = stdoutResult.stats.bytesIn + compressedStderr.stats.bytesIn;
    const bytesOut = Buffer.byteLength(markedStdout, 'utf8') + Buffer.byteLength(markedStderr, 'utf8');
    return { stdoutResult, markedStdout, markedStderr, bytesIn, bytesOut, ok: bytesIn > 0 && bytesOut / bytesIn <= 0.9 };
  };
  const plain = build(compressedStdout);

  const capped = config?.bash?.capChars > 0 ? planCap(stdout, command, config, { stderr }, compressedStdout) : null;
  const capBuild = capped?.result ? build(capped.result) : null;
  // The cap must also beat the uncapped result once markers are counted, or it is pointless churn.
  const capWins = capBuild !== null && capBuild.ok && capBuild.bytesOut < plain.bytesOut;
  if (capBuild && !capWins && !capped.exempt) capped.exempt = 'noReduction';
  if (!plain.ok && !capWins) return none('skippedPoorRatio', inputBytes, capped?.exempt ?? null);

  const original = stringResponse ? stdout : (stderr ? `${stdout}\nstderr:\n${stderr}` : stdout);
  const lossy = capWins || isLossy(stdout, compressedStdout) || isLossy(stderr, compressedStderr);
  const teeOptions = { sessionId: payload?.session_id, toolUseId: payload?.tool_use_id, config, env, lossy, failed };
  let recoveryPath = dryRun ? null : teeOriginalOutput(original, teeOptions);
  const assumedTee = dryRun && assumeTee && teeWouldWrite(original, teeOptions);
  const teed = Boolean(recoveryPath) || assumedTee;

  let chosen = plain;
  let capApplied = false;
  if (capWins && teed) {
    chosen = capBuild;
    capApplied = true;
  } else if (capWins) {
    // No recovery copy, no cap: truncating output nobody can get back is unsafe.
    capped.exempt = 'noTee';
    if (!plain.ok) return none('skippedPoorRatio', inputBytes, capped.exempt);
  }

  const markerPath = recoveryPath || (capApplied && assumedTee ? ASSUMED_TEE_PATH : null);
  const recoveredStdout = appendTeePath(chosen.markedStdout, markerPath);
  const recoveredStderr = markerPath && !chosen.markedStdout
    ? appendTeePath(chosen.markedStderr, markerPath)
    : chosen.markedStderr;
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
  const rulesApplied = [...new Set([...(chosen.stdoutResult.stats.rulesApplied || []), ...compressedStderr.stats.rulesApplied])];
  return {
    outcome: 'compressed', updatedToolOutput, bytesIn: chosen.bytesIn, bytesOut: emittedBytesOut, rulesApplied,
    recoveryPath: recoveryPath || null, capExempt: capApplied ? null : (capped?.exempt ?? null),
  };
}
