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

// The file operands after flag handling, or null. `flag` accepts or rejects each flag token; `valueFlags` names flags
// whose next token is their value. A lone `-` (stdin) or a glob/variable/tilde operand is never a file.
function operandList(args, { flag, valueFlags = new Set() }) {
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
  return operands.every((file) => file !== '-' && !GLOB_RE.test(file)) ? operands : null;
}

// Exactly one file operand, or null.
function singleOperand(args, options) {
  const files = operandList(args, options);
  return files?.length === 1 ? files[0] : null;
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
  return dumpFromTokens(tokenizeSegment(segments[segments.length - 1]));
}

// One segment's tokens as a single-file dump `{ form, file }`, or null.
function dumpFromTokens(tokens) {
  if (!tokens?.length || tokens.some((token) => /[<>]/.test(token))) return null;
  const binary = binaryOf(tokens[0]);
  const args = tokens.slice(1);
  let file = null;
  let limit = null;
  if (binary === 'cat') file = singleOperand(args, { flag: (a) => /^-[A-Za-z]+$/.test(a) });
  else if (binary === 'nl') file = singleOperand(args, { flag: (a) => /^-[A-Za-z]/.test(a), valueFlags: NL_VALUE_FLAGS });
  else if (binary === 'sed') file = sedDump(args);
  else if (binary === 'head') ({ file = null, lines: limit = null } = headDump(args) || {});
  else if (binary === 'tail') file = tailDump(args);
  // `limit` (head only) is the N of `head -n N`, so callers can size what the dump actually prints.
  return file === null ? null : { form: binary, file, ...(limit === null ? {} : { limit }) };
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
  const file = singleOperand(rest, { flag: () => false });
  return file === null ? null : { file, lines };
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

// --- multi-file dumps: `cat a b`, and chains such as `cat a; echo ---; cat b` -----------------------------------------------
const CAT_FLAG = { flag: (a) => /^-[A-Za-z]+$/.test(a) };
const NL_FLAG = { flag: (a) => /^-[A-Za-z]/.test(a), valueFlags: NL_VALUE_FLAGS };

// True when an unquoted `|` (pipe, `||`, `|&`) or a lone `&` (background) appears: splitSegments does not say which
// operator separated two segments, and a pipe anywhere means a segment's output is not the result's output.
function hasPipeOrBackground(command) {
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "'") { if (char === "'") quote = null; continue; }
    if (char === '\\') { i += 1; continue; }
    if (quote === '"') { if (char === '"') quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '|') return true;
    if (char === '&') {
      if (command[i + 1] === '&') { i += 1; continue; }
      if (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>') continue;
      return true;
    }
  }
  return false;
}

// One chain segment: a dump of one or more files (`files`), a pure separator echo/printf (`literal`, null when it is
// not a plain line of text we could find in the output), or null for anything else.
function chainSegment(tokens) {
  if (!tokens?.length || tokens.some((token) => /[<>]/.test(token))) return null;
  const binary = binaryOf(tokens[0]);
  const args = tokens.slice(1);
  if (binary === 'echo' || binary === 'printf') {
    if (args.some((arg) => /[$`()*?\[\]{}~!;]/.test(arg))) return null;
    // A line we can look for in the output: plain `echo text` or `echo -n text`. printf and `echo -e/-E` interpret
    // escapes that tokenizeSegment has already stripped of their backslash, so their literal is unknown (null).
    const flags = binary === 'echo' ? args.filter((arg) => /^-[neE]+$/.test(arg)) : [];
    const exact = binary === 'echo' && !flags.some((arg) => /[eE]/.test(arg)) && !flags.some((arg) => /n/.test(arg));
    const literal = exact ? args.join(' ') : '';
    return { type: 'sep', literal: literal === '' ? null : literal };
  }
  let files = null;
  if (binary === 'cat') files = operandList(args, CAT_FLAG);
  else if (binary === 'nl') files = operandList(args, NL_FLAG);
  else {
    const single = dumpFromTokens(tokens);
    files = single ? [single.file] : null;
    if (single && single.limit !== undefined) return { type: 'dump', form: binary, files, limit: single.limit };
  }
  return files?.length ? { type: 'dump', form: binary, files } : null;
}

/**
 * `{ form: 'multi', files, parts }` when the command dumps several whole files in one result, else null. Either the
 * final segment is `cat`/`nl` with two or more plain file operands, or the command is a chain (`;`, `&&`, newline) where
 * every segment is a single-file dump (as fileDumpOf), a pure separator `echo <literal>` / `printf <literal>` with no
 * redirect, or a first-only `cd X`, with at least two files in all. A pipe or background `&` anywhere, any redirect,
 * glob, `$` expansion, or any other command in the chain: not a dump. `parts` lists the chain's dump and separator
 * segments in order (`{type:'dump', form, files}` / `{type:'sep', literal}`) so callers can split the output when the
 * separators allow; operands are for in-memory use only.
 */
export function multiFileDumpOf(command) {
  const segments = splitSegments(command);
  if (!segments?.length || hasPipeOrBackground(command)) return null;
  const parts = [];
  for (let i = 0; i < segments.length; i += 1) {
    const tokens = tokenizeSegment(segments[i]);
    if (i === 0 && segments.length > 1 && tokens?.length === 2 && tokens[0] === 'cd') continue;
    const part = chainSegment(tokens);
    if (!part) return null;
    parts.push(part);
  }
  const files = parts.flatMap((part) => part.files || []);
  if (files.length < 2) return null;
  return { form: 'multi', files, parts };
}

/**
 * Split a multi-file dump's output per file when that is exact: every dump segment is a single file, the dumps are
 * separated by separator segments whose literal is a plain line, and exactly as many output lines equal a separator
 * literal as there are separators (so file text cannot be mistaken for one). Returns [{ file, form, text }, ...] or null.
 */
export function splitMultiDump(multi, text) {
  const { parts } = multi;
  if (!parts.every((part) => (part.type === 'sep' ? part.literal !== null : part.files.length === 1))) return null;
  for (let i = 1; i < parts.length; i += 1) if (parts[i].type === 'dump' && parts[i - 1].type === 'dump') return null;
  const literals = new Set(parts.filter((part) => part.type === 'sep').map((part) => part.literal));
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const separators = parts.filter((part) => part.type === 'sep').length;
  if (lines.filter((line) => literals.has(line)).length !== separators) return null;
  const out = [];
  let next = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part.type === 'sep') {
      if (lines[next] !== part.literal) return null;
      next += 1;
      continue;
    }
    // A dump is followed by a separator (consecutive dumps were rejected above) or ends the chain.
    const end = parts[i + 1] ? lines.indexOf(parts[i + 1].literal, next) : lines.length;
    if (end < 0) return null;
    out.push({ file: part.files[0], form: part.form, text: lines.slice(next, end).join('\n') });
    next = end;
  }
  return next === lines.length ? out : null;
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
  const dump = fileDumpOf(command) || multiFileDumpOf(command);
  if (dump) return { bucket: 'fileDump', dump };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (omittedMatchCounts(lines, 0, lines.length) !== null) return { bucket: 'grep', dump: null };
  if (isPathList(text)) return { bucket: 'pathList', dump: null };
  if (isTestOutput(lines)) return { bucket: 'testRunner', dump: null };
  if (isJson(text)) return { bucket: 'json', dump: null };
  return { bucket: 'other', dump: null };
}
