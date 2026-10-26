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
const RECOVERY_KEYS = ['capped', 'teeRead', 'teeCat', 'rerun'];
const RECOVERY_WARN_RATE = 0.15;
function emptyRow() { return { bytesIn: 0, bytesOut: 0, events: 0, bytesAttempted: 0, savedCovered: 0 }; }
// savedCovered counts savings only where attempted bytes were also recorded, so history that mixes versions
// from before and after bytesAttempted existed cannot inflate "% of attempted".
function addRow(target, item) {
  add(target, item);
  const attempted = n(item.bytesAttempted);
  target.bytesAttempted = n(target.bytesAttempted) + attempted;
  if (attempted > 0) target.savedCovered = n(target.savedCovered) + saved(item);
}
function recoveryFrom(counters) {
  const c = Object.fromEntries(RECOVERY_KEYS.map((key) => [key, n(counters?.[key])]));
  const recovered = c.teeRead + c.teeCat + c.rerun;
  return { ...c, rate: c.capped > 0 ? recovered / c.capped : null, warn: c.capped > 0 && recovered / c.capped > RECOVERY_WARN_RATE };
}
function historyReport(history) {
  const rows = {};
  const commands = {};
  const days = [];
  const recovery = {};
  let totalCovered = 0;
  for (const [day, record] of Object.entries(history.days || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!dayAllowed(day)) continue;
    const bucket = project ? record.byProject?.[project] ? { [project]: record.byProject[project] } : {} : record.byTool || {};
    const dayTotal = emptyRow();
    for (const [name, item] of Object.entries(bucket)) { addRow(rows[name] ||= emptyRow(), item); addRow(dayTotal, item); }
    for (const [name, item] of Object.entries(record.byCommand || {})) add(commands[name] ||= { bytesIn: 0, bytesOut: 0, events: 0 }, item);
    for (const key of RECOVERY_KEYS) recovery[key] = n(recovery[key]) + n(record.recovery?.[key]);
    if (dayTotal.bytesAttempted > 0) totalCovered += saved(dayTotal);
    days.push({ day, bytesIn: dayTotal.bytesIn, bytesOut: dayTotal.bytesOut, events: dayTotal.events, bytesSaved: saved(dayTotal), bytesAttempted: dayTotal.bytesAttempted, recovery: project ? null : recoveryFrom(record.recovery) });
  }
  // Recovery counters are daily and global; they cannot be attributed to a project.
  return reportObject(rows, commands, days, 'history', totalCovered, project ? null : recoveryFrom(recovery));
}
function ledgerReport() {
  const path = positional ? join(cacheDir, `${positional.replace(/[^A-Za-z0-9_-]/g, '')}.json`) : latestLedger();
  if (!path) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    const rows = {};
    for (const [tool, item] of Object.entries(state.savings || {})) rows[tool] = { ...emptyRow(), ...item };
    let covered = 0;
    for (const [tool, item] of Object.entries(state.attempted || {})) {
      const attempted = n(item?.bytes);
      if (!(attempted > 0)) continue;
      rows[tool] = { ...(rows[tool] || emptyRow()), bytesAttempted: attempted };
    }
    // Ledger tool buckets are per version of the hooks, so a tool without attempted bytes has no percentage.
    for (const item of Object.values(rows)) if (n(item.bytesAttempted) > 0) covered += saved(item);
    // Edit savings (Read dedup after an Edit) are part of Read's attempted bytes.
    if (rows.Edit && !n(rows.Edit.bytesAttempted) && n(rows.Read?.bytesAttempted) > 0) covered += saved(rows.Edit);
    const base = reportObject(Object.fromEntries(Object.entries(rows).map(([t, i]) => [t, { ...i, savedCovered: n(i.bytesAttempted) > 0 ? saved(i) : 0 }])), {}, [], 'ledger', covered, recoveryFrom(state.diagnostics?.Bash?.recovery));
    return { ...base, diagnostics: state.diagnostics || {} };
  } catch { return null; }
}
function pct(covered, attempted) { return n(attempted) > 0 ? Math.round(n(covered) / n(attempted) * 1000) / 10 : null; }
function reportObject(rows, commands, days, source, totalCovered = 0, recovery = null) {
  const total = { bytesIn: 0, bytesOut: 0, events: 0 };
  let attempted = 0;
  for (const item of Object.values(rows)) { add(total, item); attempted += n(item.bytesAttempted); }
  const decorate = (obj) => Object.fromEntries(Object.entries(obj).map(([name, { savedCovered, ...item }]) => [name, { ...item, bytesSaved: saved(item) }]));
  const byTool = decorate(rows);
  for (const [name, item] of Object.entries(byTool)) item.pctOfAttempted = pct(rows[name].savedCovered, item.bytesAttempted);
  return {
    source, period, project,
    total: { ...total, bytesSaved: saved(total), estTokensSaved: Math.max(0, Math.round(saved(total) / 3)), bytesAttempted: attempted, pctOfAttempted: pct(totalCovered, attempted) },
    byTool, byCommand: decorate(commands), days, recovery,
  };
}
function fmt(b) { return b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : b >= 1024 ? `${(b / 1024).toFixed(1)}KB` : `${b}B`; }
function text(report) {
  const title = report.source === 'history' ? `tokenslim savings (${period}${project ? `, project: ${project}` : ''}):` : 'tokenslim savings (this session):';
  const out = [title];
  const of = (item) => n(item.bytesAttempted) > 0 && item.pctOfAttempted !== null && item.pctOfAttempted !== undefined ? `  ${item.pctOfAttempted}% of ${fmt(item.bytesAttempted)} attempted` : '';
  const tools = Object.entries(report.byTool).sort(([, a], [, b]) => b.bytesSaved - a.bytesSaved);
  out.push(...(tools.length ? tools.map(([name, x]) => `  ${name.padEnd(12)} ${String(x.events).padStart(4)} calls  ${fmt(x.bytesIn)} -> ${fmt(x.bytesOut)}  (${x.bytesIn ? Math.round(x.bytesSaved / x.bytesIn * 100) : 0}% smaller)${of(x)}`) : ['  (no compression events yet)']));
  out.push(`  total  ${fmt(report.total.bytesIn)} -> ${fmt(report.total.bytesOut)} | ~${report.total.estTokensSaved.toLocaleString('en-US')} tokens saved${of(report.total)}`);
  if (report.recovery?.capped > 0) {
    const r = report.recovery;
    const recovered = r.teeRead + r.teeCat + r.rerun;
    out.push(`bash cap recovery rate: ${Math.round(r.rate * 100)}% (${recovered} of ${r.capped} capped; teeRead ${r.teeRead}, teeCat ${r.teeCat}, rerun ${r.rerun})${r.warn ? ` ⚠ above ${Math.round(RECOVERY_WARN_RATE * 100)}%: the cap may be hiding output the model needs` : ''}`);
  }
  out.push('note: "% of attempted" counts every Bash/Read/Grep/MCP result that reached its size check (images excluded); cost-weighted savings come from `node scripts/benchmark.mjs --transcripts <dir>`.');
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
  // Columns are only appended when there is attempted/recovery data, so older data keeps the original header.
  const extra = report.days.some((d) => n(d.bytesAttempted) > 0 || (d.recovery && RECOVERY_KEYS.some((key) => n(d.recovery[key]) > 0)));
  const lines = [`day,bytesIn,bytesOut,bytesSaved,events${extra ? `,bytesAttempted,${RECOVERY_KEYS.join(',')}` : ''}`];
  for (const d of report.days) lines.push(`${d.day},${d.bytesIn},${d.bytesOut},${d.bytesSaved},${d.events}${extra ? `,${n(d.bytesAttempted)},${RECOVERY_KEYS.map((key) => n(d.recovery?.[key])).join(',')}` : ''}`);
  return lines.join('\n');
}

const historyExists = existsSync(historyPath());
// An explicit session id always requests that ledger; otherwise history is preferred.
const report = !positional && historyExists ? historyReport(loadHistory()) : ledgerReport();
if (!report) console.log('tokenslim: no savings recorded yet this session.');
else if (format === 'json') console.log(JSON.stringify(report));
else if (format === 'csv') console.log(csv(report));
else console.log(text(report));
