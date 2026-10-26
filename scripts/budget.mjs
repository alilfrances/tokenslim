#!/usr/bin/env node
// Read-only context budget auditor: reports always-on context by source and prints (never writes) a settings snippet.
import { resolve } from 'node:path';
import { analyze, buildReport, emitSettings, loadProjectConfig, renderReport, renderSettings } from './lib/budget.mjs';
import { transcriptFiles, transcriptRoot } from './lib/transcripts.mjs';

// Slash-command arguments can arrive as one string ("--since 7 --all"); flags never contain spaces.
const args = process.argv.slice(2).flatMap((a) => a.split(/\s+/)).filter(Boolean);
const flagValue = (flag) => { const i = args.indexOf(flag); const next = i < 0 ? undefined : args[i + 1]; return next && !next.startsWith('--') ? next : undefined; };
const format = flagValue('--format') === 'json' ? 'json' : 'text';
const since = Math.max(0, Number.parseInt(flagValue('--since') ?? '30', 10) || 30);
const minTokens = Math.max(0, Number.parseInt(flagValue('--min-tokens') ?? '500', 10) || 0);
const limit = Math.max(1, Number.parseInt(flagValue('--limit') ?? '25', 10) || 25);
const cwd = resolve(flagValue('--project') ?? process.cwd());
const allProjects = args.includes('--all');

try {
  const files = transcriptFiles({ root: transcriptRoot(process.env), cwd, all: allProjects || Boolean(process.env.TOKENSLIM_TRANSCRIPTS_DIR) });
  const analysis = analyze(files, { sinceMs: Date.now() - since * 86400000 });
  const config = loadProjectConfig({ cwd, env: process.env });
  const report = Object.assign(buildReport(analysis, { config, minTokens, limit }), { sinceDays: since, scannedFiles: files.length });
  if (args.includes('--emit-settings')) {
    const result = emitSettings(report, config);
    console.log(format === 'json' ? JSON.stringify(result) : files.length ? renderSettings(result, minTokens) : 'tokenslim budget: no transcripts found.');
  } else console.log(format === 'json' ? JSON.stringify(report) : renderReport(report));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(format === 'json' ? JSON.stringify({ error: message }) : `tokenslim budget: error: ${message}`);
}
