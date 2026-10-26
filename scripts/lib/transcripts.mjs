// Shared Claude transcript helpers for discover, the replay benchmark and later reports. Transcript shapes vary by
// Claude version, so the block walker accepts both the documented content-block form and its wrapper variants.
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A compressed result ends with our marker on its own line (or a tee `full:` marker). Matching only the final line keeps
// tool output that merely quotes "[tokenslim:" mid-text (e.g. reading this repo's source) counted as uncompressed.
export const FINAL_MARKER_RE = /(?:^|\n)\[tokenslim: [^\]\n]*\]\s*$/;
// Known limitation: a Bash tool_result in the transcript merges stdout and stderr, so compressed stdout followed by
// stderr text leaves our marker mid-text. Two whole-line signatures recover those cases. Neither appears in normal
// source as a whole line: a marker line directly followed by a `stderr:` line, and the tee `[tokenslim: full: <path>]` line.
const MARKER_THEN_STDERR_RE = /(?:^|\n)\[tokenslim: [^\]\n]*\]\r?\n[ \t]*stderr:[ \t]*(?:\r?\n|$)/;
const TEE_LINE_RE = /(?:^|\n)\[tokenslim: full: [^\]\n]*\][ \t]*(?:\r?\n|$)/;

export function isCompressedOutput(text) {
  const value = String(text ?? '');
  return FINAL_MARKER_RE.test(value) || MARKER_THEN_STDERR_RE.test(value) || TEE_LINE_RE.test(value);
}

export function transcriptRoot(env = process.env) {
  return env.TOKENSLIM_TRANSCRIPTS_DIR || join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), 'projects');
}

function projectSlug(path) { return path.replace(/[^A-Za-z0-9]/g, '-'); }

// Recursive, so subagent transcripts nested under a project directory are included.
function filesUnder(dir) {
  try {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...filesUnder(path));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path);
    }
    return out;
  } catch { return []; }
}

export function transcriptFiles({ root = transcriptRoot(), cwd = process.cwd(), all = false } = {}) {
  if (!existsSync(root)) return [];
  if (all) return filesUnder(root).sort();
  const exact = join(root, projectSlug(cwd));
  if (existsSync(exact)) return filesUnder(exact).sort();
  // Claude's slug format has changed; scan only matching project directories as fallback.
  const needle = projectSlug(cwd).toLowerCase();
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.toLowerCase().includes(needle))
      .flatMap((e) => filesUnder(join(root, e.name))).sort();
  } catch { return []; }
}

function recent(line, sinceMs) {
  if (sinceMs === undefined || sinceMs === null) return true;
  const stamp = line.timestamp || line.created_at || line.message?.timestamp;
  if (!stamp) return true; // Fixtures and older transcripts need no timestamp to remain discoverable.
  const time = new Date(stamp).getTime();
  return Number.isNaN(time) || time >= sinceMs;
}

/** Yield parsed JSON lines, reading in chunks so a multi-hundred-MB transcript never becomes one string. */
export function* readLines(file, { sinceMs } = {}) {
  let fd;
  try { fd = openSync(file, 'r'); } catch { return; }
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(1 << 20);
    let rest = '';
    for (let done = false; !done;) {
      let n;
      try { n = readSync(fd, buffer, 0, buffer.length, null); } catch { return; }
      done = n === 0;
      const chunk = rest + (done ? decoder.end() : decoder.write(buffer.subarray(0, n)));
      const parts = chunk.split('\n');
      rest = done ? '' : parts.pop();
      if (done && parts.length && parts.at(-1) === '') parts.pop();
      for (const raw of parts) {
        if (!raw.trim()) continue;
        let line; try { line = JSON.parse(raw); } catch { continue; }
        if (line && typeof line === 'object' && recent(line, sinceMs)) yield line;
      }
    }
  } finally { closeSync(fd); }
}

function text(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object') return typeof value.text === 'string' ? value.text : typeof value.content === 'string' ? value.content : '';
  return '';
}

function hasImage(value) {
  if (Array.isArray(value)) return value.some(hasImage);
  return Boolean(value && typeof value === 'object' && (value.type === 'image' || hasImage(value.content)));
}

function blocks(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { for (const item of node) blocks(item, found); return found; }
  if (node.type === 'tool_use') {
    const name = node.name || node.tool_name;
    const input = node.input && typeof node.input === 'object' ? node.input : {};
    found.push({ kind: 'use', id: node.id || node.tool_use_id, name, input: node.command !== undefined && input.command === undefined ? { ...input, command: node.command } : input });
  }
  if (node.type === 'tool_result') {
    const content = node.content ?? node.output;
    found.push({ kind: 'result', id: node.tool_use_id || node.id, text: text(content), isImage: hasImage(content) });
  }
  // A content block is terminal; descending would duplicate it through wrappers.
  if (node.type === 'tool_use' || node.type === 'tool_result') return found;
  for (const child of Object.values(node)) blocks(child, found);
  return found;
}

// Streaming writes one assistant message as several lines (same message.id), so count each id once, at its first line.
function callCounter() {
  const seen = new Set();
  const calls = [];
  return {
    calls,
    add(line, index) {
      const message = line?.message;
      if (!message || typeof message !== 'object' || !message.usage || typeof message.usage !== 'object') return;
      if (line.type !== undefined && line.type !== 'assistant' && message.role !== 'assistant') return;
      if (message.id !== undefined && message.id !== null) {
        if (seen.has(message.id)) return;
        seen.add(message.id);
      }
      calls.push({ id: message.id ?? null, index, timestamp: line.timestamp ?? null });
    },
  };
}

/** API calls in order, one per distinct assistant message.id carrying message.usage; `index` is the line's position in `lines`. */
export function apiCalls(lines) {
  const counter = callCounter();
  let index = 0;
  for (const line of lines) counter.add(line, index++);
  return counter.calls;
}

/**
 * One pass per file, yielding `{ file, pairs, calls }`. Pairs carry `seq`, the result's line position in the file, on
 * the same scale as `calls[].index`, so callers can count API calls after a result. Pairs are deduplicated by
 * tool_use_id across all files (first result wins): resumed and branched sessions copy earlier lines.
 */
export function* scanTranscripts(files, { sinceMs, tools } = {}) {
  const wanted = tools ? new Set(tools) : null;
  const uses = new Map();
  const done = new Set();
  for (const file of files) {
    const counter = callCounter();
    const pairs = [];
    let index = 0;
    for (const line of readLines(file, { sinceMs })) {
      counter.add(line, index);
      for (const block of blocks(line)) {
        if (block.kind === 'use') {
          if (block.id && (!wanted || wanted.has(block.name))) uses.set(block.id, { name: block.name, input: block.input });
          continue;
        }
        if (!block.id || done.has(block.id) || !uses.has(block.id)) continue;
        done.add(block.id);
        const use = uses.get(block.id);
        pairs.push({
          id: block.id, name: use.name, input: use.input, text: block.text, file, seq: index,
          isImage: block.isImage,
          isPersisted: block.text.includes('<persisted-output>'),
          isCompressed: isCompressedOutput(block.text),
        });
      }
      index += 1;
    }
    yield { file, pairs, calls: counter.calls };
  }
}

/** Deduplicated tool_use/tool_result pairs across `files`, optionally limited to tool names. */
export function* toolPairs(files, options = {}) {
  for (const scan of scanTranscripts(files, options)) yield* scan.pairs;
}

// Characters of model-visible text Claude recorded for an attachment line (`rendered: [{ content }]`), or null when
// the line has none (internal bookkeeping attachments carry no rendered text).
function renderedChars(rendered) {
  if (!Array.isArray(rendered)) return null;
  let total = 0;
  for (const part of rendered) if (part && typeof part.content === 'string') total += part.content.length;
  return total;
}

const callInputTokens = (usage) => ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
  .reduce((sum, key) => sum + (Number.isFinite(usage?.[key]) ? usage[key] : 0), 0);

/**
 * One pass per file, yielding `{ file, attachments, toolUses, calls }` for session-level audits. `attachments` are the
 * `type:"attachment"` lines (`{ index, timestamp, attachment, renderedChars }`, minus `skipAttachmentTypes`); `index`
 * is on the same scale as `calls[].index`, and each call also carries `inputTokens` (fresh + cache input of that API call).
 * `toolUses` are assistant tool_use blocks, deduplicated by id across files like scanTranscripts pairs.
 */
export function* scanSessions(files, { sinceMs, skipAttachmentTypes } = {}) {
  const seenUses = new Set();
  for (const file of files) {
    const counter = callCounter();
    const attachments = [];
    const toolUses = [];
    let index = 0;
    for (const line of readLines(file, { sinceMs })) {
      const before = counter.calls.length;
      counter.add(line, index);
      if (counter.calls.length > before) counter.calls.at(-1).inputTokens = callInputTokens(line.message.usage);
      if (line.type === 'attachment') {
        const attachment = line.attachment;
        if (attachment && typeof attachment === 'object' && !skipAttachmentTypes?.has(attachment.type)) {
          attachments.push({ index, timestamp: line.timestamp ?? null, attachment, renderedChars: renderedChars(line.rendered) });
        }
      } else if (line.message?.role === 'assistant' || line.type === 'assistant') {
        for (const block of blocks(line)) {
          if (block.kind !== 'use') continue;
          if (block.id) { if (seenUses.has(block.id)) continue; seenUses.add(block.id); }
          toolUses.push({ index, name: block.name, input: block.input });
        }
      }
      index += 1;
    }
    yield { file, attachments, toolUses, calls: counter.calls };
  }
}
