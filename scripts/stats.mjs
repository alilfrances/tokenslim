#!/usr/bin/env node
// Cross-session savings report. Session ledgers remain a backwards-compatible fallback.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { historyPath, loadHistory } from './lib/history.mjs';

const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'tokenslim');
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
};
const format = valueAfter('--format') || 'text';
const project = args.includes('--project') ? valueAfter('--project') || process.cwd() : null;
const graph = args.includes('--graph');
const top = args.includes('--top') || (!args.some((a) => a.startsWith('--')) && args.length === 0);
const period = args.includes('--daily') ? 'daily' : args.includes('--weekly') ? 'weekly' : args.includes('--monthly') ? 'monthly' : 'all';
const positional = args.find((a, i) => !a.startsWith('--') && !['--format', '--project'].includes(args[i - 1]));

function latestLedger() {
  try {
    const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json') && f !== 'debug.log')
      .map((f) => ({ f, mtime: statSync(join(cacheDir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    return files[0] ? join(cacheDir, files[0].f) : null;
  } catch { return null; }
}
function n(x) { return Number(x) || 0; }
function add(target, item) { target.bytesIn = n(target.bytesIn) + n(item.bytesIn); target.bytesOut = n(target.bytesOut) + n(item.bytesOut); target.events = n(target.events) + n(item.events); }
function saved(item) { return n(item.bytesIn) - n(item.bytesOut); }
function dayAllowed(day) {
  const today = new Date().toISOString().slice(0, 10);
  if (period === 'daily') return day === today;
  if (period === 'monthly') return day.slice(0, 7) === today.slice(0, 7);
  if (period === 'weekly') { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 6); return day >= d.toISOString().slice(0, 10); }
  return true;
}
function historyReport(history) {
  const rows = {};
  const commands = {};
  const days = [];
  for (const [day, record] of Object.entries(history.days || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!dayAllowed(day)) continue;
    const bucket = project ? record.byProject?.[project] ? { [project]: record.byProject[project] } : {} : record.byTool || {};
    const dayTotal = { bytesIn: 0, bytesOut: 0, events: 0 };
    for (const [name, item] of Object.entries(bucket)) { add(rows[name] ||= { bytesIn: 0, bytesOut: 0, events: 0 }, item); add(dayTotal, item); }
    for (const [name, item] of Object.entries(record.byCommand || {})) add(commands[name] ||= { bytesIn: 0, bytesOut: 0, events: 0 }, item);
    days.push({ day, ...dayTotal, bytesSaved: saved(dayTotal) });
  }
  return reportObject(rows, commands, days, 'history');
}
function ledgerReport() {
  const path = positional ? join(cacheDir, `${positional.replace(/[^A-Za-z0-9_-]/g, '')}.json`) : latestLedger();
  if (!path) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return { ...reportObject(state.savings || {}, {}, [], 'ledger'), diagnostics: state.diagnostics || {} };
  } catch { return null; }
}
function reportObject(rows, commands, days, source) {
  const total = { bytesIn: 0, bytesOut: 0, events: 0 };
  for (const item of Object.values(rows)) add(total, item);
  const decorate = (obj) => Object.fromEntries(Object.entries(obj).map(([name, item]) => [name, { ...item, bytesSaved: saved(item) }]));
  return { source, period, project, total: { ...total, bytesSaved: saved(total), estTokensSaved: Math.max(0, Math.round(saved(total) / 3)) }, byTool: decorate(rows), byCommand: decorate(commands), days };
}
function fmt(b) { return b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : b >= 1024 ? `${(b / 1024).toFixed(1)}KB` : `${b}B`; }
function text(report) {
  const title = report.source === 'history' ? `tokenslim savings (${period}${project ? `, project: ${project}` : ''}):` : 'tokenslim savings (this session):';
  const out = [title];
  const tools = Object.entries(report.byTool).sort(([, a], [, b]) => b.bytesSaved - a.bytesSaved);
  out.push(...(tools.length ? tools.map(([name, x]) => `  ${name.padEnd(12)} ${String(x.events).padStart(4)} calls  ${fmt(x.bytesIn)} -> ${fmt(x.bytesOut)}  (${x.bytesIn ? Math.round(x.bytesSaved / x.bytesIn * 100) : 0}% smaller)`) : ['  (no compression events yet)']));
  out.push(`  total  ${fmt(report.total.bytesIn)} -> ${fmt(report.total.bytesOut)} | ~${report.total.estTokensSaved.toLocaleString('en-US')} tokens saved`);
  if (top) {
    const entries = Object.entries(report.byCommand).sort(([, a], [, b]) => b.bytesSaved - a.bytesSaved).slice(0, 10);
    if (entries.length) { out.push('top commands:'); out.push(...entries.map(([name, x]) => `  ${name}  ${fmt(x.bytesSaved)} saved (${x.events} events)`)); }
  }
  if (report.diagnostics && Object.keys(report.diagnostics).length) {
    const diagnostics = [];
    for (const [tool, events] of Object.entries(report.diagnostics).sort(([a], [b]) => a.localeCompare(b))) for (const [event, counters] of Object.entries(events || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const values = Object.entries(counters || {}).filter(([, value]) => n(value) > 0).map(([name, value]) => `${name} ${n(value)}`);
      if (values.length) diagnostics.push(`  ${tool.padEnd(6)} ${event.padEnd(18)} ${values.join(', ')}`);
    }
    if (diagnostics.length) out.push('tokenslim diagnostics (hook activity):', ...diagnostics);
  }
  if (graph) {
    out.push('last 30 days:');
    const recent = report.days.slice(-30); const max = Math.max(1, ...recent.map((d) => d.bytesSaved));
    out.push(...recent.map((d) => `  ${d.day} ${'█'.repeat(Math.round(d.bytesSaved / max * 20))} ${fmt(d.bytesSaved)}`));
  }
  return out.join('\n');
}
function csv(report) {
  const lines = ['day,bytesIn,bytesOut,bytesSaved,events'];
  for (const d of report.days) lines.push(`${d.day},${d.bytesIn},${d.bytesOut},${d.bytesSaved},${d.events}`);
  return lines.join('\n');
}

const historyExists = existsSync(historyPath());
// An explicit session id always requests that ledger; otherwise history is preferred.
const report = !positional && historyExists ? historyReport(loadHistory()) : ledgerReport();
if (!report) console.log('tokenslim: no savings recorded yet this session.');
else if (format === 'json') console.log(JSON.stringify(report));
else if (format === 'csv') console.log(csv(report));
else console.log(text(report));
