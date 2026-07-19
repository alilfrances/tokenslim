import { tokenizeCommand } from '../rewrite-rules.mjs';
import * as git from './git.mjs';
import * as packages from './package-managers.mjs';
import * as tests from './test-runners.mjs';
import * as linters from './linters.mjs';
import * as containers from './containers.mjs';

const UNSAFE_SHELL = /\$\(|`|[\r\n<>;|&]/;
const COMPRESSORS = [git, packages, tests, linters, containers];

export function commandMeta(command, extra = {}) {
  if (typeof command !== 'string' || UNSAFE_SHELL.test(command)) return null;
  const tokens = tokenizeCommand(command);
  if (!tokens?.length) return null;
  return { ...extra, command, tokens, binary: tokens[0], subcommand: tokens[1] };
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
