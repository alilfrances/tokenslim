// Shared, fail-open configuration loader. File layers are intentionally optional.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { recordDiagnostic } from './state.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  minChars: 500,
  disable: [],
  readGuardLines: 2000,
  tee: { enabled: true, mode: 'lossy', maxFiles: 20 },
  rewrite: { enabled: true, exclude: [], dockerBuild: false },
  filters: [],
});

const cache = new Map();
const diagnostics = { diagnostics: {} };

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function diagnostic(outcome) {
  // Config is loaded before a hook necessarily has a session id. Keep this in-process
  // only, while using the same diagnostic format as hook state.
  recordDiagnostic(diagnostics, { tool: 'Config', event: 'loadConfig', outcome });
}

function validFilter(value) {
  if (!plainObject(value) || typeof value.matchCommand !== 'string') return null;
  const filter = { matchCommand: value.matchCommand };
  if (typeof value.name === 'string') filter.name = value.name;
  if (typeof value.stripAnsi === 'boolean') filter.stripAnsi = value.stripAnsi;
  if (typeof value.stripLinesMatching === 'string') filter.stripLinesMatching = value.stripLinesMatching;
  if (Number.isInteger(value.maxLines) && value.maxLines >= 0) filter.maxLines = value.maxLines;
  if (['keep', 'drop', 'empty'].includes(value.onEmpty)) filter.onEmpty = value.onEmpty;
  return filter;
}

function validLayer(value) {
  if (!plainObject(value)) return null;
  const layer = {};
  if (Number.isFinite(value.minChars) && value.minChars >= 0) layer.minChars = value.minChars;
  if (Array.isArray(value.disable) && value.disable.every((item) => typeof item === 'string')) layer.disable = value.disable;
  if (Number.isFinite(value.readGuardLines) && value.readGuardLines >= 0) layer.readGuardLines = value.readGuardLines;
  if (plainObject(value.tee)) {
    const tee = {};
    if (typeof value.tee.enabled === 'boolean') tee.enabled = value.tee.enabled;
    if (['lossy', 'failures', 'never'].includes(value.tee.mode)) tee.mode = value.tee.mode;
    if (Number.isFinite(value.tee.maxFiles) && value.tee.maxFiles >= 0) tee.maxFiles = value.tee.maxFiles;
    if (Object.keys(tee).length) layer.tee = tee;
  }
  if (plainObject(value.rewrite)) {
    const rewrite = {};
    if (typeof value.rewrite.enabled === 'boolean') rewrite.enabled = value.rewrite.enabled;
    if (Array.isArray(value.rewrite.exclude) && value.rewrite.exclude.every((item) => typeof item === 'string')) rewrite.exclude = value.rewrite.exclude;
    // Deliberately opt-in: Docker's quiet output is an image id rather than build logs.
    if (typeof value.rewrite.dockerBuild === 'boolean') rewrite.dockerBuild = value.rewrite.dockerBuild;
    if (Object.keys(rewrite).length) layer.rewrite = rewrite;
  }
  if (Array.isArray(value.filters)) layer.filters = value.filters.slice(0, 50).map(validFilter).filter(Boolean);
  return layer;
}

function readLayer(path) {
  try {
    // Project-controlled config must not make every hook load an unbounded file.
    if (statSync(path).size > 256 * 1024) {
      diagnostic('oversizedConfig');
      return null;
    }
    return validLayer(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') diagnostic('malformedConfig');
    return null;
  }
}

function merge(base, layer) {
  if (!layer) return base;
  const next = { ...base, ...layer };
  for (const key of ['tee', 'rewrite']) next[key] = { ...base[key], ...(layer[key] || {}) };
  return next;
}

function envLayer(env) {
  const layer = {};
  const number = (key) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const minChars = number('TOKENSLIM_MIN_CHARS');
  const readGuardLines = number('TOKENSLIM_READ_GUARD_LINES');
  if (minChars !== undefined) layer.minChars = minChars;
  if (readGuardLines !== undefined) layer.readGuardLines = readGuardLines;
  if (typeof env.TOKENSLIM_DISABLE === 'string') {
    layer.disable = env.TOKENSLIM_DISABLE.split(',').map((part) => part.trim()).filter(Boolean);
  }
  if (typeof env.TOKENSLIM_REWRITE_ENABLED === 'string') {
    const value = env.TOKENSLIM_REWRITE_ENABLED.toLowerCase();
    if (value === 'true' || value === 'false') layer.rewrite = { ...(layer.rewrite || {}), enabled: value === 'true' };
  }
  if (typeof env.TOKENSLIM_REWRITE_EXCLUDE === 'string') {
    layer.rewrite = { ...(layer.rewrite || {}), exclude: env.TOKENSLIM_REWRITE_EXCLUDE.split(',').map((x) => x.trim()).filter(Boolean) };
  }
  if (typeof env.TOKENSLIM_REWRITE_DOCKER_BUILD === 'string') {
    const value = env.TOKENSLIM_REWRITE_DOCKER_BUILD.toLowerCase();
    if (value === 'true' || value === 'false') layer.rewrite = { ...(layer.rewrite || {}), dockerBuild: value === 'true' };
  }
  return layer;
}

export function loadConfig(cwd = process.cwd(), env = process.env) {
  const home = env.HOME || homedir();
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  const projectPath = join(resolve(cwd), '.tokenslim.json');
  const globalPath = join(configHome, 'tokenslim', 'config.json');
  const key = JSON.stringify([projectPath, globalPath, env.TOKENSLIM_MIN_CHARS, env.TOKENSLIM_READ_GUARD_LINES, env.TOKENSLIM_DISABLE, env.TOKENSLIM_REWRITE_ENABLED, env.TOKENSLIM_REWRITE_EXCLUDE, env.TOKENSLIM_REWRITE_DOCKER_BUILD]);
  if (cache.has(key)) return clone(cache.get(key));
  let config = clone(DEFAULT_CONFIG);
  config = merge(config, readLayer(globalPath));
  config = merge(config, readLayer(projectPath));
  config = merge(config, envLayer(env));
  cache.set(key, config);
  return clone(config);
}

export function configDiagnostics() {
  return clone(diagnostics.diagnostics);
}

export function clearConfigCache() {
  cache.clear();
}
