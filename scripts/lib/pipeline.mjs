const DEFAULT_MAX_CHARS = 40000;
const DEFAULT_HEAD_LINES = 150;
const DEFAULT_TAIL_LINES = 250;
const MARKER_PREFIX = '[tokenslim:';

export function stripAnsi(text) {
  return String(text ?? '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\\u001b\[[0-?]*[ -/]*[@-~]/gi, '');
}

function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}

function isProgressNoise(line, { buildProgress = false } = {}) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/100%/.test(trimmed)) return false;
  // A leading dash is also Markdown/YAML/CLI syntax. Only treat it as a
  // spinner when it is bare or followed by a counter/progress bar, never prose.
  if (/^[|/\\-]$/.test(trimmed)) return true;
  if (/^[|/\\-]\s+(?=[\d\[]|(?:downloading|extracting|pulling|waiting|verifying)(?:\s|$))/i.test(trimmed)) return true;
  if (/\[[=>#.\-\s]{8,}\]\s*\d{1,3}%?/.test(trimmed)) return true;
  if (/\b(?:Downloading|Extracting|Pulling fs layer|Waiting|Verifying Checksum)\b.*\[[=>#.\-\s]{8,}\]/i.test(trimmed)) return true;
  // Cargo prints ordinary successful build progress on stderr, one crate per line.
  // Do not apply this broad rule to generic stdout: source/prose may begin with
  // the same verbs. Warnings remain verbatim in either channel.
  if (buildProgress && /^(?:Compiling|Checking|Building)\s+\S+/i.test(trimmed)) return true;
  if (/\b(?:npm|pip|cargo|docker|yarn|pnpm)\b.*\b\d{1,3}%\b/i.test(trimmed)) return true;
  if (/^(?:progress|download(?:ing)?|reify|fetch)\b.*\b\d{1,3}%/i.test(trimmed)) return true;
  return false;
}

export function stripProgressNoise(text, options = {}) {
  const lines = normalizeNewlines(text).split('\n');
  const kept = [];
  let omitted = 0;
  for (const line of lines) {
    const parts = line.split(/\r|\\r/g);
    const final = parts[parts.length - 1];
    if (isProgressNoise(final, options)) {
      omitted += 1;
      continue;
    }
    kept.push(final);
  }
  // The final split element is only the input's trailing newline; do not turn it
  // into an extra blank line before the elision marker.
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  if (omitted > 0) kept.push(`${MARKER_PREFIX} ${omitted} progress lines omitted]`);
  return kept.join('\n').replace(/\n+$/g, '');
}

function fingerprintLine(line) {
  return line
    .replace(/reify:[^:\s]+: timing reifyNode:node_modules\/\S+/g, 'reify:<pkg>: timing reifyNode:node_modules/<pkg>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<hex>')
    .replace(/\b(?:id|sha|hash)=[0-9a-f]{3,64}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<timestamp>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|kB|MB|MiB|KiB|B)\b/gi, '<num><unit>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<num>')
    .trim();
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function hasStrongRawSimilarity(left, right) {
  if (commonPrefixLength(left, right) >= 16) return true;
  const leftTokens = left.match(/[\p{L}\p{N}_]+/gu) || [];
  const rightTokens = right.match(/[\p{L}\p{N}_]+/gu) || [];
  if (!leftTokens.length || !rightTokens.length) return false;
  const rightSet = new Set(rightTokens);
  const shared = leftTokens.filter((token) => rightSet.has(token)).length;
  return shared / Math.max(leftTokens.length, rightTokens.length) >= 0.6;
}

function flushRepeat(buffer, output) {
  if (buffer.length >= 4) {
    output.push(buffer[0], `${MARKER_PREFIX} ${buffer.length - 1} more similar lines collapsed]`);
  } else {
    output.push(...buffer);
  }
}

export function collapseRepeatedLines(text) {
  const lines = normalizeNewlines(text).split('\n');
  const output = [];
  let buffer = [];
  let fp = '';

  for (const line of lines) {
    const current = fingerprintLine(line);
    if (!current) {
      flushRepeat(buffer, output);
      buffer = [];
      fp = '';
      output.push(line);
      continue;
    }

    if (buffer.length === 0) {
      buffer = [line];
      fp = current;
      continue;
    }

    // Do not bridge a run across a different line: that line may be a unique
    // warning. Fingerprints alone are also insufficient for numbered listings.
    if (current === fp && hasStrongRawSimilarity(buffer[0], line)) {
      buffer.push(line);
      continue;
    }

    flushRepeat(buffer, output);
    buffer = [line];
    fp = current;
  }

  flushRepeat(buffer, output);
  return output.join('\n').replace(/\n+$/g, '');
}

const SUMMARY_RE = /(?:\b\d+\s+(?:failed|passed|skipped|error|errors|failures?|tests?|test files?)\b|Test Files|Tests|Duration|test result:|^ok\s+|^FAIL\b|^PASS\b|compiled with|Finished\b)/i;
const FAIL_LINE_RE = /\b(?:FAILED|FAIL|failed|panicked|panic|AssertionError|Error:|Exception:)\b/;
const TEST_SIGNAL_RE = /^(?:PASS|FAIL)\s+\S+|^ok\s+\d|^not ok\s|^\d+ passing\b|^Test Suites:|^Test Files\s|^test result:|^=+ .* (?:passed|failed).* =+$|^(?:PASSED|FAILED|ERROR)\s*:|^.*::\S+\s+(?:PASSED|FAILED|ERROR|SKIPPED)\s*$/;
const TEST_SUMMARY_RE = /^(?:Test Suites:|Test Files\s|Tests\s+|Duration\b|test result:|=+ .* (?:passed|failed).* =+$|\d+\s+(?:passed|failed|skipped|error|errors|failures?)\b)/;

function isPassingTestLine(line) {
  return /\b(?:PASSED|PASS|ok)\b/.test(line) && !FAIL_LINE_RE.test(line);
}

function isTestOutput(lines) {
  // Repeated copies of the same line are not independent evidence that this is
  // runner output (logs and source snippets can contain them too).
  const signals = [...new Set(lines.filter((line) => TEST_SIGNAL_RE.test(line)))];
  return signals.length >= 2 || (signals.length === 1 && lines.some((line) => TEST_SUMMARY_RE.test(line)));
}

export function summarizeTestRunners(text) {
  const lines = normalizeNewlines(text).split('\n');
  if (!isTestOutput(lines)) return text;

  const hasFailure = lines.some((line) => FAIL_LINE_RE.test(line));
  if (!hasFailure) {
    const kept = lines.filter((line) => SUMMARY_RE.test(line) && !isPassingTestLine(line));
    // Two runner signals alone are not enough to replace output: retain the
    // original unless a non-passing summary line remains actionable.
    if (kept.length === 0) return text;
    const omitted = lines.length - kept.length;
    const output = [...kept, ...(omitted > 0 ? [`${MARKER_PREFIX} ${omitted} passing test lines omitted]`] : [])]
      .join('\n').replace(/\n+$/g, '');
    return output || text;
  }

  const kept = [];
  let inFailureBlock = false;
  let inIndentedFailure = false;
  for (const line of lines) {
    if (/^=+\s*(?:FAILURES|short test summary info)\s*=+$/i.test(line)) {
      inFailureBlock = true;
      kept.push(line);
      continue;
    }
    if (/^=+.*(?:failed|passed|skipped|error).*=+$/i.test(line)) {
      inFailureBlock = false;
      kept.push(line);
      continue;
    }
    if (/^\s*(?:\\u001b\[[0-9;]*m)?(?:FAIL|FAILED)\b/.test(line) || /\bFAILED$/.test(line) || /^\s*FAILED\s+/.test(line)) {
      inIndentedFailure = true;
      kept.push(line);
      continue;
    }
    if (inIndentedFailure && (/^\s/.test(line) || line.trim() === '')) {
      kept.push(line);
      if (line.trim() === '') inIndentedFailure = false;
      continue;
    }
    inIndentedFailure = false;
    if (inFailureBlock) {
      kept.push(line);
      continue;
    }
    if (SUMMARY_RE.test(line) && !isPassingTestLine(line)) kept.push(line);
  }

  const omitted = lines.length - kept.length;
  const output = [...kept, ...(omitted > 0 ? [`${MARKER_PREFIX} ${omitted} test runner lines omitted]`] : [])]
    .join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/g, '');
  return output || text;
}

function isTraceStart(line) {
  return /^Traceback \(most recent call last\):/.test(line) || /^\s*(?:at\s+\S|File ".*", line \d+)/.test(line);
}

function isTraceEnd(line) {
  return /(?:Error|Exception|AssertionError|RuntimeError|ValueError|TypeError|ReferenceError|SyntaxError|panic|fatal):/.test(line);
}

function compressFrames(traceLines) {
  const out = [];
  let previousFrame = null;
  let repeat = 0;
  const flush = () => {
    if (repeat > 0) out.push(`${MARKER_PREFIX} ${repeat + 1} repeated frames]`);
    repeat = 0;
  };

  for (let i = 0; i < traceLines.length; i += 1) {
    const line = traceLines[i];
    if (/^\s*(?:File "|at\s+)/.test(line)) {
      const frame = [line];
      if (i + 1 < traceLines.length && /^\s{4}\S/.test(traceLines[i + 1])) {
        frame.push(traceLines[i + 1]);
        i += 1;
      }
      const key = frame.join('\n');
      if (key === previousFrame) {
        repeat += 1;
        continue;
      }
      flush();
      out.push(...frame);
      previousFrame = key;
      continue;
    }
    flush();
    out.push(line);
    previousFrame = null;
  }
  flush();
  return out;
}

function traceKey(lines) {
  return lines.join('\n');
}

export function dedupStackTraces(text) {
  const lines = normalizeNewlines(text).split('\n');
  const parsed = [];
  const counts = new Map();
  const firstIndex = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!isTraceStart(line)) {
      parsed.push({ type: 'line', lines: [line] });
      continue;
    }

    const trace = [line];
    i += 1;
    while (i < lines.length) {
      trace.push(lines[i]);
      if (isTraceEnd(lines[i])) break;
      i += 1;
    }
    const key = traceKey(trace);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!firstIndex.has(key)) {
      firstIndex.set(key, parsed.length);
      parsed.push({ type: 'trace', key, lines: trace });
    }
  }

  const output = [];
  for (const item of parsed) {
    if (item.type === 'line') {
      output.push(...item.lines);
      continue;
    }
    output.push(...compressFrames(item.lines));
    const count = counts.get(item.key) || 1;
    if (count > 1) output.push(`${MARKER_PREFIX} stack trace repeated ${count} times]`);
  }

  return output.join('\n').replace(/\n+$/g, '');
}

export function headTailTruncate(text, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (String(text ?? '').length <= maxChars) return String(text ?? '');

  const headLines = opts.headLines ?? DEFAULT_HEAD_LINES;
  const tailLines = opts.tailLines ?? DEFAULT_TAIL_LINES;
  const lines = normalizeNewlines(text).split('\n');
  if (lines.length <= headLines + tailLines) return String(text ?? '');

  const omittedStart = headLines;
  const omittedEnd = Math.max(omittedStart, lines.length - tailLines);
  const omitted = lines.slice(omittedStart, omittedEnd);
  const important = omitted.filter((line) => /error|fail|exception|warning|fatal|panic/i.test(line));
  const output = [
    ...lines.slice(0, headLines),
    `${MARKER_PREFIX} ${omitted.length} lines omitted]`,
  ];
  if (important.length > 0) {
    output.push(`${MARKER_PREFIX} important omitted lines]`, ...important);
  }
  output.push(...lines.slice(omittedEnd));
  return output.join('\n').replace(/\n+$/g, '');
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

export function compressBashOutput(text, opts = {}) {
  const input = String(text ?? '');
  const bytesIn = byteLength(input);
  const rulesApplied = [];
  let output = input;

  for (const [name, fn] of [
    ['stripAnsi', stripAnsi],
    ['stripProgressNoise', stripProgressNoise],
    ['collapseRepeatedLines', collapseRepeatedLines],
    ['summarizeTestRunners', summarizeTestRunners],
    ['dedupStackTraces', dedupStackTraces],
  ]) {
    const next = fn(output);
    if (next !== output) {
      // Test summaries discard earlier repetitive runner lines (and their marker),
      // so do not report a collapse that is absent from the final replacement.
      if (name === 'summarizeTestRunners') {
        const collapseIndex = rulesApplied.lastIndexOf('collapseRepeatedLines');
        if (collapseIndex >= 0 && !/more similar lines collapsed\]/.test(next)) rulesApplied.splice(collapseIndex, 1);
      }
      rulesApplied.push(name);
    }
    output = next;
  }

  const truncated = headTailTruncate(output, opts);
  if (truncated !== output) rulesApplied.push('headTailTruncate');
  output = truncated;

  // Never replace ordinary output with an empty or near-empty summary. Test
  // runner summaries are explicitly allowed to be compact; all other output
  // must retain at least 10% of its original bytes.
  if ((input && !output) || (input && !isTestOutput(normalizeNewlines(input).split('\n')) && byteLength(output) / bytesIn < 0.1)) {
    output = input;
    rulesApplied.length = 0;
  }

  return { text: output, stats: { bytesIn, bytesOut: byteLength(output), rulesApplied } };
}
