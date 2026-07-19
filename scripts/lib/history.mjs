// Cross-session daily savings history. All operations are deliberately best-effort.
import { chmodSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { commandFamily } from './privacy.mjs';

export const RETENTION_DAYS = 90;
export function dataDir() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'tokenslim');
}
export function historyPath() { return join(dataDir(), 'history.json'); }
export function freshHistory() { return { days: {} }; }

function sanitizeCommandKeys(history) {
  for (const record of Object.values(history.days || {})) {
    const safe = {};
    for (const [command, item] of Object.entries(record?.byCommand || {})) {
      add(safe[commandFamily(command)] ||= {}, item);
    }
    if (record && typeof record === 'object') record.byCommand = safe;
  }
  return history;
}

export function loadHistory() {
  try {
    const parsed = JSON.parse(readFileSync(historyPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object'
      ? sanitizeCommandKeys(parsed) : freshHistory();
  } catch { return freshHistory(); }
}

function number(value) { return Number(value) || 0; }
function add(bucket, item) {
  bucket.bytesIn = number(bucket.bytesIn) + number(item.bytesIn);
  bucket.bytesOut = number(bucket.bytesOut) + number(item.bytesOut);
  bucket.events = number(bucket.events) + number(item.events || 1);
}
function dayKey(date) { return date.toISOString().slice(0, 10); }
function prune(history, today) {
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - (RETENTION_DAYS - 1));
  const minimum = dayKey(cutoff);
  for (const day of Object.keys(history.days)) if (day < minimum) delete history.days[day];
}

// Records event deltas, not cumulative ledgers, avoiding double-counting on every save.
export function updateHistory(events, now = new Date()) {
  if (!Array.isArray(events) || events.length === 0) return false;
  try {
    const history = loadHistory();
    const day = dayKey(now);
    const record = history.days[day] ||= { byTool: {}, byCommand: {}, byProject: {} };
    for (const event of events) {
      const item = { bytesIn: number(event.bytesIn), bytesOut: number(event.bytesOut), events: number(event.events) || 1 };
      const tool = String(event.tool || 'unknown');
      const command = commandFamily(event.command || tool);
      const project = String(event.cwd || process.cwd());
      add(record.byTool[tool] ||= {}, item);
      add(record.byCommand[command] ||= {}, item);
      add(record.byProject[project] ||= {}, item);
    }
    prune(history, now);
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    try { chmodSync(dataDir(), 0o700); } catch { /* best effort on non-POSIX filesystems */ }
    const target = historyPath();
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, JSON.stringify(history), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, target);
    try { chmodSync(target, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    return true;
  } catch { return false; }
}
