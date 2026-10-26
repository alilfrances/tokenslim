#!/usr/bin/env node
// Read-only Claude transcript miner. Transcript shapes vary by Claude version, so this
// accepts both the documented content-block form and its common wrapper variants.
import { resolve } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { commandFamily } from './lib/privacy.mjs';
import { rewriteCommand } from './lib/rewrite-rules.mjs';
import { toolPairs, transcriptFiles, transcriptRoot } from './lib/transcripts.mjs';

const CHARS_PER_TOKEN = 3;
// Slash-command arguments can arrive as one string ("--since 7 --all"); flags never contain spaces.
const args = process.argv.slice(2).flatMap((a) => a.split(/\s+/)).filter(Boolean);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1] ?? fallback; };
const format = value('--format', 'text');
const limit = Math.max(1, Number.parseInt(value('--limit', '15'), 10) || 15);
const since = Math.max(0, Number.parseInt(value('--since', '30'), 10) || 30);
const allProjects = args.includes('--all');
const cwd = resolve(value('--project', process.cwd()));

function add(map, key, bytes, extra = {}) {
  const item = map.get(key) || { command: key, bytes: 0, tokens: 0, occurrences: 0, ...extra };
  item.bytes += bytes; item.tokens = Math.round(item.bytes / CHARS_PER_TOKEN); item.occurrences += 1; map.set(key, item);
}
function discover() {
  const sinks = new Map(); const opportunities = new Map(); const families = new Map(); let pairs = 0;
  const config = loadConfig(cwd, process.env);
  const files = transcriptFiles({ root: transcriptRoot(process.env), cwd, all: allProjects || Boolean(process.env.TOKENSLIM_TRANSCRIPTS_DIR) });
  for (const pair of toolPairs(files, { sinceMs: Date.now() - since * 86400000, tools: ['Bash'] })) {
    const command = pair.input.command;
    if (typeof command !== 'string') continue;
    const bytes = Buffer.byteLength(pair.text, 'utf8');
    const safeCommand = commandFamily(command);
    pairs += 1; add(families, safeCommand, bytes);
    if (!pair.isCompressed) add(sinks, safeCommand, bytes);
    if (!pair.isCompressed && rewriteCommand(command, config)) add(opportunities, safeCommand, bytes);
  }
  const scannedFiles = files.length;
  const sort = (map) => [...map.values()].sort((a, b) => b.tokens - a.tokens || a.command.localeCompare(b.command)).slice(0, limit);
  return { scannedFiles, pairs, sinceDays: since, limit, sinks: sort(sinks), rewriteOpportunities: sort(opportunities), commandFamilies: sort(families) };
}
function render(report) {
  if (!report.scannedFiles) return 'tokenslim discover: no transcripts found.';
  const section = (title, rows) => [title, ...(rows.length ? rows.map((r) => `  ${r.command}  ~${r.tokens.toLocaleString()} tokens (${r.occurrences} runs)`) : ['  (none)'])];
  return ['tokenslim transcript discovery:', `  scanned ${report.scannedFiles} transcript(s), ${report.pairs} Bash result(s)`, ...section('top uncompressed sinks:', report.sinks), ...section('missed rewrite opportunities:', report.rewriteOpportunities), ...section('top command families:', report.commandFamilies)].join('\n');
}
try { const report = discover(); console.log(format === 'json' ? JSON.stringify(report) : render(report)); } catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(format === 'json' ? JSON.stringify({ sinks: [], rewriteOpportunities: [], commandFamilies: [], error: message }) : `tokenslim discover: error: ${message}`);
}
