import { hasFailure, lines, result } from './shared.mjs';

function status(text) {
  const input = lines(text);
  // The porcelain branch record includes useful upstream state such as ahead,
  // behind, and gone; it is not merely a branch name.
  const branch = input.find((line) => line.startsWith('## '))?.slice(3) || 'detached';
  const files = input.filter((line) => /^[ MADRCU?!]{2}\s/.test(line));
  if (!files.length) return result(`${branch} | clean`, 'gitStatus');
  const counts = new Map();
  for (const line of files) {
    for (const code of new Set(line.slice(0, 2))) if (code !== ' ') counts.set(code, (counts.get(code) || 0) + 1);
  }
  const summary = [...counts].map(([code, count]) => `${count}${code}`).join(' ');
  return result(`${branch} | ${summary}\n${files.join('\n')}`, 'gitStatus');
}

function log(text, meta) {
  // These modes make the log output itself the requested deliverable.
  if (meta.tokens?.some((token) => /^(?:-p|-u|--patch(?:=|$)|--stat(?:=|$)|--graph(?:=|$)|--name-status(?:=|$)|--name-only(?:=|$)|--line-range(?:=|$)|-(?:L|S|G))/.test(token))) return null;
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
  // Unlike other command summaries, diff context is requested source content.
  // Preserve blank context lines rather than using lines(), which removes them.
  const source = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n+$/g, '');
  const input = source ? source.split('\n') : [];
  if (!input.some((line) => line.startsWith('diff --git '))) return null;
  const output = [];
  for (let index = 0; index < input.length;) {
    const line = input[index];
    // Metadata is reproducible from the paths and is not useful while reviewing.
    if (/^(?:index |old mode |new mode |new file mode |deleted file mode )/.test(line)) {
      index += 1;
      continue;
    }
    // Only collapse long runs of unchanged hunk context. Added and removed lines
    // are always retained, regardless of diff size.
    if (!line.startsWith('diff --git ') && !line.startsWith('@@') && !line.startsWith('+') && !line.startsWith('-')) {
      let end = index;
      while (end < input.length && !input[end].startsWith('diff --git ') && !input[end].startsWith('@@')
        && !input[end].startsWith('+') && !input[end].startsWith('-')) end += 1;
      const run = input.slice(index, end);
      if (run.length > 6) output.push(...run.slice(0, 3), `... [tokenslim: ${run.length - 6} unchanged context lines omitted]`, ...run.slice(-3));
      else output.push(...run);
      index = end;
      continue;
    }
    output.push(line);
    index += 1;
  }
  const candidate = output.join('\n');
  // Avoid paying a marker/rewriting cost when metadata removal was insignificant.
  return candidate.length < source.length * 0.9 ? result(candidate, 'gitDiff') : null;
}

export function compress(text, meta = {}) {
  if (meta.binary !== 'git' || hasFailure(text, meta)) return null;
  if (meta.subcommand === 'status' && /^(?:## |[ MADRCU?!]{2}\s)/m.test(String(text))) return status(text);
  if (meta.subcommand === 'log') return log(text, meta);
  if (meta.subcommand === 'diff') return diff(text);
  // These commands can emit hook, merge, or remote summaries. Generic compression
  // is safer than selecting an arbitrary final line from requested command output.
  if (['push', 'fetch', 'add', 'commit'].includes(meta.subcommand)) return null;
  if (meta.subcommand === 'pull') {
    const output = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n+$/g, '');
    return output ? result(`ok git pull:\n${output}`, 'gitOperation') : null;
  }
  return null;
}
