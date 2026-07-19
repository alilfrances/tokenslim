import { hasFailure, lines, result } from './shared.mjs';

function status(text) {
  const input = lines(text);
  const branch = input.find((line) => line.startsWith('## '))?.slice(3).replace(/\.\.\..*$/, '') || 'detached';
  const files = input.filter((line) => /^[ MADRCU?!]{2}\s/.test(line));
  if (!files.length) return result(`${branch} | clean`, 'gitStatus');
  const counts = new Map();
  for (const line of files) {
    for (const code of new Set(line.slice(0, 2))) if (code !== ' ') counts.set(code, (counts.get(code) || 0) + 1);
  }
  const summary = [...counts].map(([code, count]) => `${count}${code}`).join(' ');
  return result(`${branch} | ${summary}\n${files.join('\n')}`, 'gitStatus');
}

function log(text) {
  const input = lines(text);
  // Already one-line logs need no special handling. For normal logs retain the
  // hash and subject, while dropping author/date boilerplate deterministically.
  if (input.some((line) => /^[0-9a-f]{7,40}\s+\S/.test(line))) return null;
  const output = [];
  for (let index = 0; index < input.length; index += 1) {
    const match = /^commit\s+([0-9a-f]{7,40})\b/i.exec(input[index]);
    if (!match) continue;
    const subject = input.slice(index + 1).find((line) => !/^(?:Author|Date):/.test(line));
    output.push(`${match[1]}${subject ? ` ${subject.trim()}` : ''}`);
  }
  return output.length ? result(output.join('\n'), 'gitLog') : null;
}

function diff(text) {
  const input = lines(text);
  const files = [];
  let current = null;
  for (const line of input) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) { current = { path: match[2], plus: 0, minus: 0, hunks: [], activeHunk: null }; files.push(current); continue; }
    if (!current) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) current.plus += 1;
    else if (line.startsWith('-')) current.minus += 1;
    if (line.startsWith('@@')) { current.activeHunk = [line]; current.hunks.push(current.activeHunk); }
    else if (current.activeHunk) current.activeHunk.push(line);
  }
  if (!files.length) return null;
  return result(files.map((file) => `${file.path} (+${file.plus}/-${file.minus})${file.plus + file.minus <= 12 && file.hunks.length ? `\n${file.hunks.flat().join('\n')}` : ''}`).join('\n'), 'gitDiff');
}

export function compress(text, meta = {}) {
  if (meta.binary !== 'git' || hasFailure(text, meta)) return null;
  if (meta.subcommand === 'status' && /^(?:## |[ MADRCU?!]{2}\s)/m.test(String(text))) return status(text);
  if (meta.subcommand === 'log') return log(text);
  if (meta.subcommand === 'diff') return diff(text);
  if (['push', 'pull', 'fetch', 'add', 'commit'].includes(meta.subcommand)) {
    const last = lines(text).at(-1);
    return last ? result(`ok git ${meta.subcommand}: ${last}`, 'gitOperation') : null;
  }
  return null;
}
