// Inspection-only view of a shell command line. Nothing here executes, expands or resolves anything: it exists so the
// output cap can tell that the LAST pipeline stage already bounds its output (`... | head -n 50`). A wrong guess
// only costs a missed cap or a missed exemption, never a changed command. Not a shell parser: `$(...)`, backticks,
// heredocs and parentheses are not understood (a `|` inside `$( )` splits like any other).
// Handles unquoted `|`, `||`, `|&`, `&&`, `&`, `;` and newline as separators (not the `&` of `2>&1`), '...' and "..." quoting, and backslash
// escapes (a backslash-newline is a line continuation, not a separator). Malformed quoting returns null.

/** Splits into trimmed, non-empty segments of raw text, or null on an unterminated quote or trailing backslash. */
export function splitSegments(command) {
  if (typeof command !== 'string') return null;
  const segments = [];
  let current = '';
  let quote = null;
  const flush = () => {
    const text = current.trim();
    if (text) segments.push(text);
    current = '';
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      if (i + 1 >= command.length) return null;
      const next = command[i + 1];
      i += 1;
      if (next === '\n') continue;
      current += char + next;
      continue;
    }
    if (quote === '"') {
      current += char;
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    // `2>&1`, `>&2` and `&>file` are redirections, not control operators.
    if (char === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')) { current += char; continue; }
    if (char === '|' || char === '&' || char === ';' || char === '\n') {
      // `||`, `&&` and `|&` are two characters; consuming the second keeps it from reading as an empty segment.
      if ((char === '|' || char === '&') && (command[i + 1] === char || (char === '|' && command[i + 1] === '&'))) i += 1;
      flush();
      continue;
    }
    current += char;
  }
  if (quote) return null;
  flush();
  return segments;
}

/** Splits one segment into words with quotes and escapes removed (single-quoted text is literal), or null if malformed. */
export function tokenizeSegment(segment) {
  if (typeof segment !== 'string') return null;
  const tokens = [];
  let token = '';
  let started = false;
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (quote === "'") {
      if (char === "'") quote = null; else token += char;
      continue;
    }
    if (char === '\\') {
      if (i + 1 >= segment.length) return null;
      i += 1;
      token += segment[i];
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null; else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { tokens.push(token); token = ''; started = false; }
      continue;
    }
    token += char;
    started = true;
  }
  if (quote) return null;
  if (started) tokens.push(token);
  return tokens;
}

/** Tokens of the final pipeline stage, or null when the command is empty or malformed. */
export function lastSegment(command) {
  const segments = splitSegments(command);
  if (!segments?.length) return null;
  const tokens = tokenizeSegment(segments[segments.length - 1]);
  return tokens?.length ? tokens : null;
}

function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * True when the stage limits its own output to a line range: `head`/`tail` with `-n N`, `-nN`, `-N` or `--lines=N`
 * (plain digits: `tail -n +5` and `head -n -5` are unbounded), `sed -n '<a>,<b>p'`, or an awk program that mentions
 * NR. `awk 'NR>10'` is unbounded but is accepted as the plan specifies; the caller also bounds the output length.
 */
export function isBoundedRead(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return false;
  let at = 0;
  while (at < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[at])) at += 1;
  if (at >= tokens.length) return false;
  const binary = basename(tokens[at]);
  const args = tokens.slice(at + 1);
  if (binary === 'head' || binary === 'tail') {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-n' || arg === '--lines') {
        // The value belongs to the flag: `head -n -5` must not read as the `-N` form.
        if (/^\d+$/.test(args[index + 1] ?? '')) return true;
        index += 1;
        continue;
      }
      if (/^-\d+$/.test(arg) || /^-n\d+$/.test(arg) || /^--lines=\d+$/.test(arg)) return true;
    }
    return false;
  }
  if (binary === 'sed') {
    const quiet = args.some((arg) => /^-[A-Za-z]*n[A-Za-z]*$/.test(arg) || arg === '--quiet' || arg === '--silent');
    return quiet && args.some((arg) => /^\d+(?:,\d+)?p$/.test(arg));
  }
  if (binary === 'awk' || binary === 'gawk' || binary === 'mawk') {
    return args.some((arg) => /\bNR\b/.test(arg));
  }
  return false;
}
