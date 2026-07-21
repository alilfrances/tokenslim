// Best-effort recovery copies for output where compression drops information.
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_MIN_BYTES = 4096;
const DEFAULT_MAX_FILES = 20;

function stableId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value);
  // encodeURIComponent leaves dots untouched; encode them explicitly so `.` and `..`
  // can never become path components.
  return id ? encodeURIComponent(id).replace(/\./g, '%2E') : null;
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
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) return null;
    try { chmodSync(directory, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
    let descriptor;
    try {
      const noFollow = constants.O_NOFOLLOW || 0;
      descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow, 0o600);
      try { fchmodSync(descriptor, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
      writeFileSync(descriptor, String(text ?? ''), 'utf8');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    prune(directory, Math.floor(maxFiles));
    // A concurrent/pruning writer may have removed this file; do not advertise it.
    try { statSync(path); } catch { return null; }
    return path;
  } catch {
    return null;
  }
}

// Never attach a recovery path to a marker found in tool output: the command may
// have printed a tokenslim example, or be reading a previous tee log. Our recovery
// reference is always a new final marker owned by this invocation.
export function appendTeePath(text, path) {
  if (!path) return String(text ?? '');
  const output = String(text ?? '');
  return `${output}${output ? '\n' : ''}[tokenslim: full: ${path}]`;
}
