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

function isProgressNoise(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/100%/.test(trimmed)) return false;
  if (/^[|/\\-]\s+/.test(trimmed)) return true;
  if (/\[[=>#.\-\s]{8,}\]\s*\d{1,3}%?/.test(trimmed)) return true;
  if (/\b(?:Downloading|Extracting|Pulling fs layer|Waiting|Verifying Checksum)\b.*\[[=>#.\-\s]{8,}\]/i.test(trimmed)) return true;
  if (/\b(?:npm|pip|cargo|docker|yarn|pnpm)\b.*\b\d{1,3}%\b/i.test(trimmed)) return true;
  if (/^(?:progress|download(?:ing)?|reify|fetch)\b.*\b\d{1,3}%/i.test(trimmed)) return true;
  return false;
}

export function stripProgressNoise(text) {
  const lines = normalizeNewlines(text).split('\n');
  const kept = [];
  for (const line of lines) {
    const parts = line.split(/\r|\\r/g);
    const final = parts[parts.length - 1];
    if (isProgressNoise(final)) continue;
    kept.push(final);
  }
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

function flushRepeat(buffer, output) {
  if (buffer.length >= 3) {
    output.push(buffer[0], `${MARKER_PREFIX} ${buffer.length} similar lines collapsed]`);
  } else {
    output.push(...buffer);
  }
}

export function collapseRepeatedLines(text) {
  const lines = normalizeNewlines(text).split('\n');
  const output = [];
  let buffer = [];
  let fp = '';
  let gap = [];

  for (const line of lines) {
    const current = fingerprintLine(line);
    if (!current) {
      flushRepeat(buffer, output);
      buffer = [];
      fp = '';
      output.push(line);
      gap = [];
      continue;
    }

    if (buffer.length === 0) {
      buffer = [line];
      fp = current;
      gap = [];
      continue;
    }

    if (current === fp) {
      buffer.push(line);
      gap = [];
      continue;
    }

    if (gap.length === 0 && line.trim().length < 120) {
      gap = [line];
      continue;
    }

    flushRepeat(buffer, output);
    output.push(...gap);
    buffer = [line];
    fp = current;
    gap = [];
  }

  flushRepeat(buffer, output);
  output.push(...gap);
  return output.join('\n').replace(/\n+$/g, '');
}

const SUMMARY_RE = /(?:\b\d+\s+(?:failed|passed|skipped|error|errors|failures?|tests?|test files?)\b|Test Files|Tests|Duration|test result:|^ok\s+|^FAIL\b|^PASS\b|compiled with|Finished\b)/i;
const FAIL_LINE_RE = /\b(?:FAILED|FAIL|failed|panicked|panic|AssertionError|Error:|Exception:)\b/;

function isPassingTestLine(line) {
  return /\b(?:PASSED|PASS|ok)\b/.test(line) && !FAIL_LINE_RE.test(line);
}

function isTestOutput(lines) {
  return lines.some((line) => /(?:^|\s)(?:FAIL|PASS)\s+\S+|cargo test|go test|test result:|={5,}.*(?:passed|failed)|::.*(?:PASSED|FAILED)|Test Files|Tests\s+\d+/i.test(line));
}

export function summarizeTestRunners(text) {
  const lines = normalizeNewlines(text).split('\n');
  if (!isTestOutput(lines)) return text;

  const hasFailure = lines.some((line) => FAIL_LINE_RE.test(line));
  if (!hasFailure) {
    return lines.filter((line) => SUMMARY_RE.test(line) && !isPassingTestLine(line)).join('\n').replace(/\n+$/g, '');
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

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/g, '');
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
    if (next !== output) rulesApplied.push(name);
    output = next;
  }

  const truncated = headTailTruncate(output, opts);
  if (truncated !== output) rulesApplied.push('headTailTruncate');
  output = truncated;

  return { text: output, stats: { bytesIn, bytesOut: byteLength(output), rulesApplied } };
}
