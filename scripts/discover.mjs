#!/usr/bin/env node
// Read-only Claude transcript miner. Transcript shapes vary by Claude version, so this
// accepts both the documented content-block form and its common wrapper variants.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './lib/config.mjs';
import { rewriteCommand } from './lib/rewrite-rules.mjs';

const CHARS_PER_TOKEN = 3;
const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1] ?? fallback; };
const format = value('--format', 'text');
const limit = Math.max(1, Number.parseInt(value('--limit', '15'), 10) || 15);
const since = Math.max(0, Number.parseInt(value('--since', '30'), 10) || 30);
const allProjects = args.includes('--all');
const cwd = resolve(value('--project', process.cwd()));
const transcriptRoot = process.env.TOKENSLIM_TRANSCRIPTS_DIR || join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), '.claude'), 'projects');

function projectSlug(path) { return path.replace(/[^A-Za-z0-9]/g, '-'); }
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
function transcriptFiles() {
  if (!existsSync(transcriptRoot)) return [];
  if (allProjects || process.env.TOKENSLIM_TRANSCRIPTS_DIR) return filesUnder(transcriptRoot);
  const exact = join(transcriptRoot, projectSlug(cwd));
  if (existsSync(exact)) return filesUnder(exact);
  // Claude's slug format has changed; scan only matching project directories as fallback.
  const needle = projectSlug(cwd).toLowerCase();
  try { return readdirSync(transcriptRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.toLowerCase().includes(needle)).flatMap((e) => filesUnder(join(transcriptRoot, e.name))); } catch { return []; }
}
function text(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object') return typeof value.text === 'string' ? value.text : typeof value.content === 'string' ? value.content : '';
  return '';
}
function blocks(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { for (const item of node) blocks(item, found); return found; }
  if (node.type === 'tool_use' && (node.name === 'Bash' || node.tool_name === 'Bash')) found.push({ kind: 'use', id: node.id || node.tool_use_id, command: node.input?.command || node.command });
  if (node.type === 'tool_result') found.push({ kind: 'result', id: node.tool_use_id || node.id, output: text(node.content ?? node.output) });
  // A content block is terminal; descending would duplicate it through wrappers.
  if (node.type === 'tool_use' || node.type === 'tool_result') return found;
  for (const child of Object.values(node)) blocks(child, found);
  return found;
}
function family(command) {
  const parts = String(command || '').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, Math.min(parts.length, 2)).join(' ') || '(unknown)';
}
function add(map, key, bytes, extra = {}) {
  const item = map.get(key) || { command: key, bytes: 0, tokens: 0, occurrences: 0, ...extra };
  item.bytes += bytes; item.tokens = Math.round(item.bytes / CHARS_PER_TOKEN); item.occurrences += 1; map.set(key, item);
}
function recent(line, file) {
  const stamp = line.timestamp || line.created_at || line.message?.timestamp;
  if (!stamp) return true; // Fixtures and older transcripts need no timestamp to remain discoverable.
  const date = new Date(stamp); return Number.isNaN(date.getTime()) || date >= new Date(Date.now() - since * 86400000);
}
function discover() {
  const sinks = new Map(); const opportunities = new Map(); const families = new Map(); let scannedFiles = 0; let pairs = 0;
  const config = loadConfig(cwd, process.env);
  for (const file of transcriptFiles()) {
    scannedFiles += 1;
    const uses = new Map();
    let lines;
    try { lines = readFileSync(file, 'utf8').split(/\r?\n/); } catch { continue; }
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let line; try { line = JSON.parse(raw); } catch { continue; }
      if (!recent(line, file)) continue;
      for (const block of blocks(line)) {
        if (block.kind === 'use' && block.id && typeof block.command === 'string') uses.set(block.id, block.command);
        if (block.kind !== 'result' || !block.id || !uses.has(block.id)) continue;
        const command = uses.get(block.id); const output = block.output; const bytes = Buffer.byteLength(output, 'utf8');
        pairs += 1; add(families, family(command), bytes);
        if (!output.includes('[tokenslim:')) add(sinks, command, bytes);
        if (!output.includes('[tokenslim:') && rewriteCommand(command, config)) add(opportunities, command, bytes);
      }
    }
  }
  const sort = (map) => [...map.values()].sort((a, b) => b.tokens - a.tokens || a.command.localeCompare(b.command)).slice(0, limit);
  return { transcriptRoot, scannedFiles, pairs, sinceDays: since, limit, sinks: sort(sinks), rewriteOpportunities: sort(opportunities), commandFamilies: sort(families) };
}
function render(report) {
  if (!report.scannedFiles) return 'tokenslim discover: no transcripts found.';
  const section = (title, rows) => [title, ...(rows.length ? rows.map((r) => `  ${r.command}  ~${r.tokens.toLocaleString()} tokens (${r.occurrences} runs)`) : ['  (none)'])];
  return ['tokenslim transcript discovery:', `  scanned ${report.scannedFiles} transcript(s), ${report.pairs} Bash result(s)`, ...section('top uncompressed sinks:', report.sinks), ...section('missed rewrite opportunities:', report.rewriteOpportunities), ...section('top command families:', report.commandFamilies)].join('\n');
}
try { const report = discover(); console.log(format === 'json' ? JSON.stringify(report) : render(report)); } catch { console.log(format === 'json' ? JSON.stringify({ sinks: [], rewriteOpportunities: [], commandFamilies: [], error: 'no transcripts found' }) : 'tokenslim discover: no transcripts found.'); }
