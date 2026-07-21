import { tokenizeCommand } from '../rewrite-rules.mjs';
import { skipLeadingEnvAssignments } from '../privacy.mjs';
import * as git from './git.mjs';
import * as packages from './package-managers.mjs';
import * as tests from './test-runners.mjs';
import * as linters from './linters.mjs';
import * as containers from './containers.mjs';

const UNSAFE_SHELL = /\$\(|`|[\r\n<>;|&]/;
const COMPRESSORS = [git, packages, tests, linters, containers];
const KNOWN_EXECUTABLES = new Set([
  'cargo', 'docker', 'eslint', 'git', 'go', 'jest', 'kubectl', 'npm', 'pip', 'pip3',
  'pnpm', 'pytest', 'rspec', 'ruff', 'tsc', 'vitest', 'yarn',
]);
const LAUNCHER_VALUE_FLAGS = new Set(['-c', '--call', '-p', '--package']);

function basename(token) {
  return String(token ?? '').replace(/^["']|["']$/g, '').split(/[\\/]/).at(-1);
}

function nextExecutable(tokens, start) {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') return index + 1 < tokens.length ? index + 1 : -1;
    if (LAUNCHER_VALUE_FLAGS.has(token)) { index += 1; continue; }
    if (token.startsWith('--package=') || token.startsWith('--call=')) continue;
    if (!token.startsWith('-')) return index;
  }
  return -1;
}

// Return the effective binary position without interpreting shell syntax. This shares
// privacy.mjs's conservative leading-assignment walk, then unwraps only documented
// package launchers so a command's output reaches the matching compressor.
function executableIndex(tokens) {
  const index = skipLeadingEnvAssignments(tokens);
  if (index >= tokens.length) return -1;

  const binary = basename(tokens[index]);
  if (binary === 'npx') return nextExecutable(tokens, index + 1);
  // Both pnpm and Yarn allow launcher flags before `exec`/`run` (for example,
  // `pnpm --silent exec eslint`), so locate that subcommand with the same
  // option-aware walk used to find npx's executable.
  const candidateIndex = nextExecutable(tokens, index + 1);
  const candidate = basename(tokens[candidateIndex]);
  if (binary === 'pnpm' && candidate === 'exec') return nextExecutable(tokens, candidateIndex + 1);
  if (binary === 'yarn') {
    if (candidate === 'run' || candidate === 'exec') return nextExecutable(tokens, candidateIndex + 1);
    // `yarn eslint` launches eslint, but preserve yarn's own install/test commands.
    if (KNOWN_EXECUTABLES.has(candidate)) return candidateIndex;
  }
  return index;
}

export function commandMeta(command, extra = {}) {
  if (typeof command !== 'string' || UNSAFE_SHELL.test(command)) return null;
  const tokens = tokenizeCommand(command);
  if (!tokens?.length) return null;
  const binaryIndex = executableIndex(tokens);
  if (binaryIndex < 0 || binaryIndex >= tokens.length) return null;
  const binary = basename(tokens[binaryIndex]);
  if (!binary) return null;
  return { ...extra, command, tokens, binary, subcommand: basename(tokens[binaryIndex + 1]) };
}

function compileUserPattern(source) {
  if (typeof source !== 'string' || source.length === 0 || source.length > 256) return null;
  // Project config is repository-controlled. Reject common catastrophic-backtracking
  // forms and backreferences before evaluating a regex inside a hook process.
  if (/\\[1-9]/.test(source)) return null;
  if (/\([^)]*(?:[+*]|\{\d+,?\d*\})[^)]*\)(?:[+*]|\{\d+,?\d*\})/.test(source)) return null;
  if (/\([^)]*\|[^)]*\)(?:[+*]|\{\d+,?\d*\})/.test(source)) return null;
  try { return new RegExp(source); } catch { return null; }
}

function filterLabel(filter) {
  return typeof filter.name === 'string' && /^[A-Za-z0-9._-]{1,48}$/.test(filter.name)
    ? filter.name
    : 'filter';
}

function customFilter(text, meta, filters = []) {
  for (const filter of filters) {
    if (!filter || typeof filter.matchCommand !== 'string') continue;
    const commandPattern = compileUserPattern(filter.matchCommand);
    if (!commandPattern || !commandPattern.test(meta.command)) continue;
    let output = String(text ?? '');
    const rulesApplied = [`custom:${filterLabel(filter)}`];
    if (filter.stripAnsi === true) output = output.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
    if (typeof filter.stripLinesMatching === 'string') {
      const linePattern = compileUserPattern(filter.stripLinesMatching);
      if (linePattern) output = output.split('\n').filter((line) => !linePattern.test(line)).join('\n');
    }
    if (Number.isInteger(filter.maxLines) && filter.maxLines >= 0) output = output.split('\n').slice(0, filter.maxLines).join('\n');
    output = output.replace(/\n+$/g, '');
    if (!output) {
      // Empty filters are unsafe by default. An explicit `drop`/`empty` opts in;
      // `keep` is useful for filters which only remove noise when other text remains.
      if (filter.onEmpty === 'keep') return { text: String(text ?? ''), rulesApplied };
      if (filter.onEmpty !== 'drop' && filter.onEmpty !== 'empty') return null;
    }
    return { text: output, rulesApplied };
  }
  return null;
}

export function compressCommandOutput(text, command, config = {}, extra = {}) {
  const meta = commandMeta(command, extra);
  if (!meta) return null;
  const filtered = customFilter(text, meta, config.filters);
  if (filtered) return filtered;
  for (const compressor of COMPRESSORS) {
    const compressed = compressor.compress(text, meta);
    if (compressed) return compressed;
  }
  return null;
}
