// Outline-first guard for Bash whole-file dumps (`cat f`, `nl f`, `sed -n p f`, `head -n N f`, `cat a b`), hosted by the
// existing PreToolUse Bash hook (rewrite-bash.mjs) so no extra process starts. Three modes (config bashGuard.mode):
//   off     does nothing;
//   shadow  (default) never outputs and never changes behavior, it only counts what deny would have withheld;
//   deny    refuses the first such dump with an outline; repeating the identical command is allowed (escape hatch).
// The trigger is classify.mjs's command-only detection. File operands are resolved in memory only; state and history
// hold counts and byte sums, never a command, a path or a file name. Every failure is silent (fail-open).
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { detectRuntime, preToolUseDenyOutput } from './hook-output.mjs';
import { consumeGuardDeny, loadState, recordBashGuard, saveState } from './state.mjs';

export const BASH_GUARD_MODES = Object.freeze(['off', 'shadow', 'deny']);
// Shadow size buckets by total dump lines. The edges are absolute (not relative to the configured threshold): le800 also
// holds anything a bytes-only threshold caught below 800 lines.
export const SIZE_BUCKET_EDGES = Object.freeze([800, 2000]);
const MAX_COMMAND_CHARS = 8192;
const MAX_OUTLINE_ENTRIES = 40;
// A dump needs one of these as a command word; checked before anything else so the common non-dump command costs
// one regex test and no I/O. Pipes never form a dump, so a `|` ends the check early too.
const DUMP_WORD_RE = /(?:^|[\s;&(/])(?:cat|nl|sed|head|tail)(?=\s)/;
const UNRESOLVABLE_RE = /[$`~*?[\]{}!()]/;

function isDisabled(config, env) {
  const flags = new Set([
    ...(Array.isArray(config?.disable) ? config.disable : []),
    ...String(env?.TOKENSLIM_DISABLE || '').split(','),
  ].map((flag) => String(flag).trim().toLowerCase()).filter(Boolean));
  return flags.has('all') || flags.has('bashguard');
}

export function bucketKey(lines) {
  return lines <= SIZE_BUCKET_EDGES[0] ? 'le800' : lines <= SIZE_BUCKET_EDGES[1] ? 'le2000' : 'gt2000';
}

// The directory a leading `cd X` moves to, `undefined` when there is none, `null` when X cannot be resolved statically.
function cdTarget(command, splitSegments, tokenizeSegment) {
  const segments = splitSegments(command);
  if (!segments || segments.length < 2) return undefined;
  const tokens = tokenizeSegment(segments[0]);
  if (tokens?.length !== 2 || tokens[0] !== 'cd') return undefined;
  return UNRESOLVABLE_RE.test(tokens[1]) || tokens[1].startsWith('-') ? null : tokens[1];
}

const kb = (bytes) => Math.max(1, Math.round(bytes / 1024));

// How many outline entries each file may show when `needs` (entries per file) must share `budget` in all: a file that needs
// less than an even share keeps only what it has and its unused share goes to the others.
export function shareEntries(needs, budget = MAX_OUTLINE_ENTRIES) {
  const take = needs.map(() => 0);
  let open = needs.map((need, index) => (need > 0 ? index : -1)).filter((index) => index >= 0);
  let remaining = budget;
  while (open.length && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    const small = share > 0 ? open.filter((index) => needs[index] <= share) : [];
    if (!small.length) {
      // Everyone left needs more than an even share: split what remains, the first files taking the odd entries.
      open.forEach((index, rank) => { take[index] = Math.min(needs[index], share + (rank < remaining - share * open.length ? 1 : 0)); });
      break;
    }
    for (const index of small) { take[index] = needs[index]; remaining -= needs[index]; }
    open = open.filter((index) => !small.includes(index));
  }
  return take;
}

// Per-file outline sections for a multi-file dump, at most MAX_OUTLINE_ENTRIES outline entries in all.
// Headers carry the basename only.
function multiOutline(files, outlineFile) {
  const outlines = files.map((file) => {
    try { return outlineFile(file.path, file.size); } catch { return null; } // unreadable now: header only
  });
  const take = shareEntries(outlines.map((outline) => outline?.entries.length || 0));
  const entries = [];
  files.forEach((file, index) => {
    entries.push(`== ${basename(file.operand)}: ${file.info.lines} lines, ${kb(file.size)} KB ==`);
    const outline = outlines[index];
    if (!outline?.entries.length) return;
    entries.push(...outline.entries.slice(0, take[index]));
    const more = outline.entries.length - take[index] + outline.more;
    if (more > 0) entries.push(`… ${more} more`);
    if (outline.partial) entries.push('(outline covers the first 1MB only)');
  });
  return entries;
}

/**
 * Runs the guard for one PreToolUse Bash payload. Returns true only when it wrote a deny output (the caller must then stop);
 * shadow, off, no-trigger and every error return false with nothing written to stdout.
 */
export async function bashGuard(payload, config, env = process.env) {
  try {
    return await guard(payload, config, env);
  } catch {
    return false;
  }
}

async function guard(payload, config, env) {
  const mode = config?.bashGuard?.mode ?? 'shadow';
  if (!BASH_GUARD_MODES.includes(mode) || mode === 'off' || isDisabled(config, env)) return false;
  const command = payload?.tool_input?.command;
  if (payload?.tool_name !== undefined && payload.tool_name !== 'Bash') return false;
  if (typeof command !== 'string' || command.length > MAX_COMMAND_CHARS || command.includes('|') || !DUMP_WORD_RE.test(command)) return false;

  // Past the cheap pre-check: load the detectors lazily so a plain command never pays for classify's imports.
  const [{ fileDumpOf, multiFileDumpOf }, { splitSegments, tokenizeSegment }, outline, { countLinesCapped }, guardReason] = await Promise.all([
    import('./classify.mjs'), import('./shell-segments.mjs'), import('./outline.mjs'), import('./line-count.mjs'), import('./guard-reason.mjs'),
  ]);
  const single = fileDumpOf(command);
  const multi = single ? null : multiFileDumpOf(command);
  if (!single && !multi) return false;
  const operands = single
    ? [{ operand: single.file, limit: single.limit }]
    : multi.parts.filter((part) => part.type === 'dump').flatMap((part) => part.files.map((operand) => ({ operand, limit: part.limit })));

  const cwd = resolve(typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());
  const cd = cdTarget(command, splitSegments, tokenizeSegment);
  if (cd === null) return false;
  const base = cd === undefined ? cwd : resolve(cwd, cd);

  // Every operand must be an existing regular text file before any file is read.
  const files = [];
  for (const { operand, limit } of operands) {
    const path = resolve(base, operand);
    if (!outline.isTextLikePath(path)) return false;
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    files.push({ operand, path, size: stats.size, limit });
  }
  let totalLines = 0;
  let totalBytes = 0;
  let totalRawLines = 0;
  let capped = false;
  for (const file of files) {
    const counted = countLinesCapped(file.path, file.size);
    // Drop the empty piece after a final newline so 400 lines is 400, not 401.
    file.info = { lines: counted.endsWithNewline && !counted.capped ? Math.max(1, counted.lines - 1) : counted.lines, capped: counted.capped };
    // `head -n N` prints at most N lines. A capped count is a lower bound, so an unbounded capped file always trips the guard.
    totalLines += file.limit === undefined ? file.info.lines : Math.min(file.limit, file.info.lines);
    totalRawLines += file.info.lines;
    totalBytes += file.size;
    capped ||= file.info.capped && file.limit === undefined;
  }
  const lineLimit = Number.isInteger(config?.bashGuard?.lines) ? config.bashGuard.lines : 400;
  const byteLimit = Number.isInteger(config?.bashGuard?.bytes) ? config.bashGuard.bytes : 0;
  if (!capped && totalLines <= lineLimit && !(byteLimit > 0 && totalBytes > byteLimit)) return false;

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const count = (deltas) => {
    const state = loadState(sessionId);
    recordBashGuard(state, deltas);
    saveState(sessionId, state);
  };
  if (mode === 'shadow') {
    count({ wouldDeny: 1, wouldDenyBytes: totalBytes, [bucketKey(totalLines)]: 1 });
    return false;
  }
  // deny: Claude only, and only with a session id to key the escape hatch on; elsewhere it is shadow-silent.
  if (detectRuntime(payload, env) === 'codex' || !sessionId) {
    count({ skippedRuntime: 1 });
    return false;
  }
  const key = createHash('sha256').update(`${cwd}\0${command}`).digest('hex');
  const verdict = consumeGuardDeny(sessionId, key, (state, outcome) => recordBashGuard(state, outcome === 'deny' ? { denied: 1 } : { repeated: 1 }));
  if (verdict !== 'deny') return false;

  let reason;
  if (files.length === 1) {
    const [file] = files;
    let fileOutline = null;
    try { fileOutline = outline.outlineFile(file.path, file.size); } catch { /* unreadable now: size line only */ }
    reason = guardReason.guardDenyReason({
      filePath: file.operand, size: file.size, lineInfo: file.info, outline: fileOutline,
      subject: 'output', instruction: guardReason.BASH_DUMP_INSTRUCTION,
    });
  } else {
    reason = guardReason.guardDenyReason({
      filePath: `combined output of ${files.length} files`, size: totalBytes,
      lineInfo: { lines: totalRawLines, capped: files.some((file) => file.info.capped) },
      outline: { totalLines: totalRawLines, entries: multiOutline(files, outline.outlineFile), more: 0, partial: false },
      subject: 'output', instruction: guardReason.BASH_DUMP_INSTRUCTION,
    });
  }
  process.stdout.write(JSON.stringify(preToolUseDenyOutput(payload, reason)));
  return true;
}
