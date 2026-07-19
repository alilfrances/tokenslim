import { tokenizeCommand } from '../rewrite-rules.mjs';
import * as git from './git.mjs';
import * as packages from './package-managers.mjs';
import * as tests from './test-runners.mjs';
import * as linters from './linters.mjs';
import * as containers from './containers.mjs';

const UNSAFE_SHELL = /<<|\$\(|`|;|&&|\|\||\||>|&/;
const COMPRESSORS = [git, packages, tests, linters, containers];

export function commandMeta(command, extra = {}) {
  if (typeof command !== 'string' || UNSAFE_SHELL.test(command)) return null;
  const tokens = tokenizeCommand(command);
  if (!tokens?.length) return null;
  return { ...extra, command, tokens, binary: tokens[0], subcommand: tokens[1] };
}

function customFilter(text, meta, filters = []) {
  for (const filter of filters) {
    if (!filter || typeof filter.matchCommand !== 'string') continue;
    let matches;
    try { matches = new RegExp(filter.matchCommand).test(meta.command); } catch { continue; }
    if (!matches) continue;
    let output = String(text ?? '');
    const rulesApplied = [`custom:${filter.name || filter.matchCommand}`];
    if (filter.stripAnsi === true) output = output.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
    if (typeof filter.stripLinesMatching === 'string') {
      try {
        const linePattern = new RegExp(filter.stripLinesMatching);
        output = output.split('\n').filter((line) => !linePattern.test(line)).join('\n');
      } catch { /* invalid optional filter setting is ignored */ }
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
