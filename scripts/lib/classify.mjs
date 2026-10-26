// Output-kind classification for the replay benchmark (`benchmark.mjs --transcripts <dir> --classify`). Inspection only:
// nothing here runs, expands or resolves a command, and the file operand a dump detector returns is for in-memory use
// (picking an outline language); callers must never print or persist it.
import { splitSegments, tokenizeSegment } from './shell-segments.mjs';
import { omittedMatchCounts } from './shape-compressors/grep.mjs';
import { isTestOutput } from './pipeline.mjs';

export const BUCKETS = Object.freeze(['fileDump', 'grep', 'pathList', 'testRunner', 'json', 'other']);
// `head -n N` with N at or above this counts as a whole-file dump; a smaller head is a bounded read.
export const HEAD_DUMP_MIN = 400;
// Output line-count sub-buckets for fileDump: <= 400, 401..2000, > 2000.
export const SIZE_BOUNDS = Object.freeze([400, 2000]);
export const SIZE_LABELS = Object.freeze(['<=400', '401-2000', '>2000']);

const CD_PREFIX_RE = /^\s*cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|'"]+)\s*(?:&&|;)/;
const GLOB_RE = /[*?[\]{}~$`!()]/;
const NL_VALUE_FLAGS = new Set(['-b', '-n', '-w', '-s', '-v', '-i', '-l', '-d', '-f', '-h']);
const binaryOf = (token) => token.slice(token.lastIndexOf('/') + 1);

// The single file operand after flag handling, or null. `flags` receives each flag token; `valueFlags` names flags
// whose next token is their value. A lone `-` (stdin) or a glob/variable/tilde operand is never a file.
function singleOperand(args, { flag, valueFlags = new Set() }) {
  const operands = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { operands.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('-') && arg !== '-') {
      if (!flag(arg)) return null;
      if (valueFlags.has(arg)) i += 1;
      continue;
    }
    operands.push(arg);
  }
  if (operands.length !== 1) return null;
  const file = operands[0];
  return file === '-' || GLOB_RE.test(file) ? null : file;
}

/**
 * `{ form, file }` when the command's final segment is a whole-file dump of exactly one file, else null. Forms:
 * `cat [-flags] F`, `nl [flags] F`, `sed -n '1,$p' F` (or `sed -n p F`), `head -n N F` / `head -nN F` / `head -N F` /
 * `head --lines=N F` with N >= HEAD_DUMP_MIN, and `tail -n +1 F`. An optional leading `cd X &&` (or `;`) is allowed.
 * Not dumps: any other earlier segment or a pipe/`||`/`&` into the dump, any redirect or heredoc, globs, `$`/backtick
 * expansion, `-` (stdin), and zero or several file operands.
 */
export function fileDumpOf(command) {
  const segments = splitSegments(command);
  if (!segments?.length || segments.length > 2) return null;
  if (segments.length === 2) {
    const head = tokenizeSegment(segments[0]);
    if (head?.length !== 2 || head[0] !== 'cd' || !CD_PREFIX_RE.test(command)) return null;
  }
  const tokens = tokenizeSegment(segments[segments.length - 1]);
  if (!tokens?.length || tokens.some((token) => /[<>]/.test(token))) return null;
  const binary = binaryOf(tokens[0]);
  const args = tokens.slice(1);
  let file = null;
  if (binary === 'cat') file = singleOperand(args, { flag: (a) => /^-[A-Za-z]+$/.test(a) });
  else if (binary === 'nl') file = singleOperand(args, { flag: (a) => /^-[A-Za-z]/.test(a), valueFlags: NL_VALUE_FLAGS });
  else if (binary === 'sed') file = sedDump(args);
  else if (binary === 'head') file = headDump(args);
  else if (binary === 'tail') file = tailDump(args);
  return file === null ? null : { form: binary, file };
}

function sedDump(args) {
  let quiet = false;
  let script = false;
  const file = singleOperand(args.filter((arg) => {
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') { quiet = true; return false; }
    if (/^(?:1,\$)?p$/.test(arg) && !script) { script = true; return false; }
    return true;
  }), { flag: () => false });
  return quiet && script ? file : null;
}

function headDump(args) {
  let lines = null;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    let match;
    if (arg === '-n' || arg === '--lines') { lines = /^\d+$/.test(args[i + 1] ?? '') ? Number(args[i + 1]) : NaN; i += 1; }
    else if ((match = /^-n(\d+)$/.exec(arg) || /^--lines=(\d+)$/.exec(arg) || /^-(\d+)$/.exec(arg))) lines = Number(match[1]);
    else rest.push(arg);
  }
  if (lines === null || !(lines >= HEAD_DUMP_MIN)) return null;
  return singleOperand(rest, { flag: () => false });
}

function tailDump(args) {
  let from = false;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-n' || arg === '--lines') { from = args[i + 1] === '+1'; i += 1; }
    else if (arg === '-n+1' || arg === '--lines=+1') from = true;
    else rest.push(arg);
  }
  return from ? singleOperand(rest, { flag: () => false }) : null;
}

/** Number of lines in `text`, not counting the empty piece after a trailing newline. */
export function lineCount(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

export function sizeBucket(lines) {
  return lines <= SIZE_BOUNDS[0] ? SIZE_LABELS[0] : lines <= SIZE_BOUNDS[1] ? SIZE_LABELS[1] : SIZE_LABELS[2];
}

const PATH_EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
/**
 * Path list: at least 8 non-empty lines and at least 80% of them look like a path. A line looks like a path when,
 * trimmed, it has no whitespace, contains a letter, is not a URL (`://`), and either contains `/` or ends in a
 * `.ext` (a dot, a letter, then up to 7 letters/digits). Covers `find`, `ls -1`, `git ls-files`, `grep -l`.
 */
export function isPathList(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 8) return false;
  const paths = lines.filter((line) => !/\s/.test(line) && /[A-Za-z]/.test(line) && !line.includes('://') && (line.includes('/') || PATH_EXT_RE.test(line))).length;
  return paths >= lines.length * 0.8;
}

function isJson(text) {
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[') return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

/** The first matching bucket of BUCKETS for one Bash result, in that order; `dump` is the fileDump detection. */
export function classifyOutput(text, command) {
  const dump = fileDumpOf(command);
  if (dump) return { bucket: 'fileDump', dump };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (omittedMatchCounts(lines, 0, lines.length) !== null) return { bucket: 'grep', dump: null };
  if (isPathList(text)) return { bucket: 'pathList', dump: null };
  if (isTestOutput(lines)) return { bucket: 'testRunner', dump: null };
  if (isJson(text)) return { bucket: 'json', dump: null };
  return { bucket: 'other', dump: null };
}
