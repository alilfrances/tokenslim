// Lossless grouping of grep/rg -n output. Consecutive lines sharing a path become one header line plus
// two-space-indented members:
//   src/a.js:12:foo      ->  src/a.js
//   src/a.js:30:bar      ->    12:foo
//   src/a.js-31-ctx      ->    30:bar
//                        ->    31-ctx
// Members keep the original separator (`:` match, `-` context), so ungroup() restores every byte.
// Consecutive MATCH members whose text is byte-identical share one line, `  12,30,48:foo`: the line numbers come
// first and the separator is the first character that is not a digit or comma, so the text (even one starting with
// digits) never affects parsing. Context members and non-adjacent members are never listed.
//
// Parsing decisions (the grouping is only ever applied to lines parsed this way):
// - A match line is `path:N:text`; the path ends at the FIRST colon and has no whitespace. A context line is
//   `path-N-text` where `path` equals the path of the adjacent parsed line: a path may itself contain `-12-`,
//   so context lines are never split on their own text. `path:N-text` (colon then dash) is not grep output and
//   is left verbatim. `path:N` with nothing after (grep -c) and bare paths (grep -l) never match.
// - The path must look like a file: contain `/` or end in `.ext`, with a letter in its last segment, and not
//   start with `-`. That rejects `12:34:56` clocks, `2026-10-26T12:34:56Z` stamps, `[12:34:56]`, IPs and
//   `host:8080` pairs, whose "path" part would otherwise repeat on consecutive lines.
// - A header is a non-indented line directly followed by an indented member. Every other line passes through
//   verbatim, so if any verbatim line itself looks like a member (`  12:...` or `  12,30:...`) we decline rather
//   than let ungroup() misread it.
const MATCH_RE = /^([^\s:][^\s:]*):(\d{1,7}):([^\n]*)$/;
const CONTEXT_REST_RE = /^(\d{1,7})-([^\n]*)$/;
const MEMBER_RE = /^ {2}(\d{1,7}(?:,\d{1,7})*)([:-])([^\n]*)$/;
const MIN_LINES = 8;
const MIN_SHARE = 0.6;

function plausiblePath(path) {
  if (path.startsWith('-')) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (!/[A-Za-z]/.test(base)) return false;
  return path.includes('/') || /\.[A-Za-z0-9_]+$/.test(path);
}

function parseMatch(line) {
  const found = MATCH_RE.exec(line);
  return found && plausiblePath(found[1]) ? { path: found[1], n: found[2], sep: ':', text: found[3] } : null;
}

function parseContext(line, path) {
  if (!path || !line.startsWith(`${path}-`)) return null;
  const found = CONTEXT_REST_RE.exec(line.slice(path.length + 1));
  return found ? { path, n: found[1], sep: '-', text: found[2] } : null;
}

function parseLines(lines) {
  const parsed = lines.map(parseMatch);
  // Context follows its match (trailing) or precedes it (leading), so resolve forwards then backwards.
  for (const step of [1, -1]) {
    let path = null;
    for (let i = step > 0 ? 0 : lines.length - 1; i >= 0 && i < lines.length; i += step) {
      if (!parsed[i]) parsed[i] = parseContext(lines[i], path);
      path = parsed[i] ? parsed[i].path : null;
    }
  }
  return parsed;
}

// Each member drops `path:` for two spaces (saves path-1 chars); the header costs path+1 with its newline.
function shrinks(run) {
  const pathLength = run[0].path.length;
  return run.length * (pathLength - 1) - (pathLength + 1) > 0;
}

// Member lines for one run. A stretch of two or more consecutive match entries with byte-identical text becomes one
// line listing their line numbers. Text starting with a digit or comma is never list-merged: it would read as part
// of the number list to a human even though the parse is unambiguous.
function memberLines(run) {
  const lines = [];
  for (let i = 0; i < run.length;) {
    const entry = run[i];
    let end = i + 1;
    if (entry.sep === ':' && !/^[\d,]/.test(entry.text)) {
      while (end < run.length && run[end].sep === ':' && run[end].text === entry.text) end += 1;
    }
    lines.push(`  ${run.slice(i, end).map((member) => member.n).join(',')}${entry.sep}${entry.text}`);
    i = end;
  }
  return lines;
}

/** Returns the grouped text, or null when the text is not grep-shaped, nothing would shrink, or it is ambiguous. */
export function group(text) {
  const lines = String(text ?? '').split('\n');
  const parsed = parseLines(lines);
  const nonEmpty = lines.filter((line) => line.trim() !== '').length;
  const matching = parsed.filter(Boolean).length;
  if (matching < MIN_LINES || matching < nonEmpty * MIN_SHARE) return null;

  const output = [];
  let grouped = false;
  for (let i = 0; i < lines.length;) {
    const first = parsed[i];
    let end = i + 1;
    if (first) while (end < lines.length && parsed[end]?.path === first.path) end += 1;
    const run = first ? parsed.slice(i, end) : [];
    if (run.length >= 2 && shrinks(run)) {
      output.push(first.path, ...memberLines(run));
      grouped = true;
    } else {
      for (let j = i; j < end; j += 1) {
        // A verbatim line shaped like a member would be re-expanded by ungroup().
        if (MEMBER_RE.test(lines[j])) return null;
        output.push(lines[j]);
      }
    }
    i = end;
  }
  return grouped ? output.join('\n') : null;
}

/**
 * Per-file match counts for lines[start, end), for the output cap's "omitted matches" summary. Works on raw grep
 * lines and on text already grouped by group(): paths are resolved over the WHOLE text, because a cut can fall
 * inside a group and the omitted members' header sits in the kept head. Context lines are not matches and are not
 * counted. Returns [[path, count], ...] in first-appearance order, or null when the region is not grep-shaped
 * (same thresholds as the detector).
 */
export function omittedMatchCounts(lines, start, end) {
  const raw = parseLines(lines);
  const info = new Array(lines.length).fill(null);
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const member = MEMBER_RE.exec(lines[i]);
    if (raw[i]) {
      info[i] = { path: raw[i].path, match: raw[i].sep === ':', weight: 1 };
      current = null;
    } else if (member && current) {
      // A listed member line stands for one hit per number.
      info[i] = { path: current, match: member[2] === ':', weight: member[1].split(',').length };
    } else if (!member && MEMBER_RE.test(lines[i + 1] ?? '')) {
      // A group header (see group()): the path for the members that follow.
      current = lines[i];
      info[i] = { path: current, match: false, weight: 1 };
    } else {
      current = null;
    }
  }
  let nonEmpty = 0;
  let parsed = 0;
  let matches = 0;
  const counts = new Map();
  for (let i = start; i < end; i += 1) {
    const weight = info[i]?.weight ?? 1;
    if (lines[i].trim() !== '') nonEmpty += weight;
    if (!info[i]) continue;
    parsed += weight;
    if (!info[i].match) continue;
    matches += weight;
    counts.set(info[i].path, (counts.get(info[i].path) || 0) + weight);
  }
  if (matches < MIN_LINES || parsed < nonEmpty * MIN_SHARE) return null;
  return [...counts];
}

/** Inverse of group(); used by tests to prove the transform is lossless. */
export function ungroup(text) {
  const lines = String(text ?? '').split('\n');
  const output = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!MEMBER_RE.test(lines[i + 1] ?? '')) { output.push(lines[i]); continue; }
    const path = lines[i];
    for (let member = MEMBER_RE.exec(lines[i + 1] ?? ''); member; member = MEMBER_RE.exec(lines[i + 1] ?? '')) {
      for (const n of member[1].split(',')) output.push(`${path}${member[2]}${n}${member[2]}${member[3]}`);
      i += 1;
    }
  }
  return output.join('\n');
}

/**
 * Which lines carry a grep hit location, for pipeline rules that must never merge two different locations: raw
 * `path:N:text` and `path-N-text` lines (same parse rules and file-looking path check as group()) and grouped
 * `  N:text` / `  N,M:text` members. Returns one boolean per input line.
 */
export function locationMask(lines) {
  const parsed = parseLines(lines);
  return lines.map((line, i) => Boolean(parsed[i]) || MEMBER_RE.test(line));
}

/**
 * The set of hit locations in `text` as `path:line` strings (matches and context lines). Pass grouped: true for
 * text produced by group(), which is expanded by ungroup() first; raw text must NOT be ungrouped because a
 * verbatim line shaped like a member would be misread.
 */
export function grepLocations(text, { grouped = false } = {}) {
  const raw = grouped ? ungroup(text) : String(text ?? '');
  const lines = raw.split('\n');
  const found = new Set();
  parseLines(lines).forEach((entry) => { if (entry) found.add(`${entry.path}:${Number(entry.n)}`); });
  return found;
}

export function compress(text) {
  const grouped = group(text);
  return grouped === null ? null : { text: grouped, rulesApplied: ['groupByPath'], lossless: true };
}
