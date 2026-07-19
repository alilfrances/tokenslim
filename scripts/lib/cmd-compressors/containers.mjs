import { hasFailure, lines, result } from './shared.mjs';

function compactTable(text) {
  const input = lines(text);
  if (input.length < 2) return null;
  return input.map((line) => line.trim().split(/\s{2,}/).join(' | ')).join('\n');
}

export function compress(text, meta = {}) {
  if (hasFailure(text, meta)) return null;
  const isDocker = meta.binary === 'docker' && ['ps', 'images'].includes(meta.subcommand);
  const isKubectl = meta.binary === 'kubectl' && meta.subcommand === 'get';
  if (!isDocker && !isKubectl) return null;
  const compact = compactTable(text);
  return compact ? result(compact, isDocker ? 'dockerTable' : 'kubectlTable') : null;
}
