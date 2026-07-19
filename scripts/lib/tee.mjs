// Best-effort recovery copies for output where compression drops information.
import { mkdirSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_MIN_BYTES = 4096;
const DEFAULT_MAX_FILES = 20;

function stableId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value);
  return id ? encodeURIComponent(id) : null;
}

export function teePath(sessionId, toolUseId, env = process.env) {
  const session = stableId(sessionId);
  const toolUse = stableId(toolUseId);
  if (!session || !toolUse) return null;
  const home = env.HOME || homedir();
  const cacheHome = env.XDG_CACHE_HOME || join(home, '.cache');
  return join(cacheHome, 'tokenslim', 'tee', session, `${toolUse}.log`);
}

export function teeMinBytes(env = process.env) {
  const value = Number(env.TOKENSLIM_TEE_MIN);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_BYTES;
}

function teeEnabled(config, env) {
  const disabled = String(env.TOKENSLIM_DISABLE || '').toLowerCase().split(',').map((x) => x.trim());
  if (disabled.includes('all') || disabled.includes('tee')) return false;
  const tee = config?.tee || {};
  return tee.enabled !== false && tee.mode !== 'never';
}

function prune(sessionDirectory, maxFiles) {
  const files = readdirSync(sessionDirectory)
    .filter((name) => name.endsWith('.log'))
    .map((name) => {
      const path = join(sessionDirectory, name);
      return { path, name, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  for (const file of files.slice(maxFiles)) rmSync(file.path, { force: true });
}

// Never throw: recovery is optional and must not affect compression availability.
export function teeOriginalOutput(text, {
  sessionId,
  toolUseId,
  config = {},
  env = process.env,
  lossy = false,
  failed = false,
} = {}) {
  try {
    if (!lossy || !teeEnabled(config, env)) return null;
    const mode = config?.tee?.mode || 'lossy';
    if (mode === 'failures' && !failed) return null;
    if (mode !== 'lossy' && mode !== 'failures') return null;
    if (Buffer.byteLength(String(text ?? ''), 'utf8') < teeMinBytes(env)) return null;
    const path = teePath(sessionId, toolUseId, env);
    const maxFiles = Number.isFinite(config?.tee?.maxFiles) ? config.tee.maxFiles : DEFAULT_MAX_FILES;
    if (!path || maxFiles <= 0) return null;
    const directory = join(path, '..');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, String(text ?? ''), 'utf8');
    prune(directory, Math.floor(maxFiles));
    // A concurrent/pruning writer may have removed this file; do not advertise it.
    try { statSync(path); } catch { return null; }
    return path;
  } catch {
    return null;
  }
}

// Put the recovery location in an existing compression marker. The replacement is
// deterministic for a stable session/tool-use id and deliberately does not add a
// marker to otherwise lossless output.
export function appendTeePath(text, path) {
  if (!path) return String(text ?? '');
  const output = String(text ?? '');
  if (/\[tokenslim: [^\]\n]*?\]/.test(output)) {
    return output.replace(/\[tokenslim: ([^\]\n]*?)\]/, `[tokenslim: $1 full: ${path}]`);
  }
  return `${output}${output ? '\n' : ''}[tokenslim: full: ${path}]`;
}
