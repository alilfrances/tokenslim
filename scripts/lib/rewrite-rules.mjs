// Conservative PreToolUse Bash rewrite registry. It never replaces a command binary.

const UNSAFE_SHELL = /<<|\$\(|`|;|&&|\|\||\||>|&/;

// Minimal shell tokenizer for inspection only. It deliberately declines malformed quotes;
// the original command is always preserved and flags are appended verbatim.
export function tokenizeCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; token += char; continue; }
    if (quote) {
      token += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; token += char; continue; }
    if (/\s/.test(char)) {
      if (token) { tokens.push(token); token = ''; }
      continue;
    }
    token += char;
  }
  if (quote || escaped) return null;
  if (token) tokens.push(token);
  return tokens;
}

function hasVerboseFlag(tokens) {
  return tokens.some((token) => /^(?:-v+|--verbose(?:=|$)|--debug(?:=|$)|--loglevel(?:=|$))/.test(token));
}

function hasAny(tokens, flags) {
  return tokens.some((token) => flags.includes(token) || flags.some((flag) => token.startsWith(`${flag}=`)));
}

function excluded(tokens, config) {
  const exclusions = config?.rewrite?.exclude;
  if (!Array.isArray(exclusions)) return false;
  return exclusions.some((entry) => {
    const parts = tokenizeCommand(entry);
    return parts?.length && parts.every((part, index) => tokens[index] === part);
  });
}

function append(command, tokens, flags, rule) {
  const missing = flags.filter((flag) => !hasAny(tokens, [flag]));
  return missing.length ? { command: `${command.trim()} ${missing.join(' ')}`, rules: [rule] } : null;
}

export function rewriteCommand(command, config = {}) {
  if (typeof command !== 'string' || UNSAFE_SHELL.test(command)) return null;
  const tokens = tokenizeCommand(command);
  if (!tokens || !tokens.length || config?.rewrite?.enabled === false || excluded(tokens, config)) return null;
  if (hasVerboseFlag(tokens)) return null;

  const binary = tokens[0];
  const subcommand = tokens[1];
  if ((binary === 'npm') && (subcommand === 'install' || subcommand === 'ci')) {
    return append(command, tokens, ['--loglevel=error', '--no-fund', '--no-audit'], 'npm-quiet');
  }
  if (binary === 'pip' && subcommand === 'install') {
    return hasAny(tokens, ['-q', '--quiet']) ? null : append(command, tokens, ['-q'], 'pip-quiet');
  }
  if (binary === 'cargo' && ['build', 'check', 'test'].includes(subcommand)) {
    return hasAny(tokens, ['-q', '--quiet']) ? null : append(command, tokens, ['--quiet'], 'cargo-quiet');
  }
  if (binary === 'pytest') {
    // -qq is intentionally not added, but an explicit stronger quiet request is respected.
    return tokens.some((token) => /^-q+$/.test(token) || token === '--quiet') ? null : append(command, tokens, ['-q'], 'pytest-quiet');
  }
  if (binary === 'git' && subcommand === 'status') {
    return append(command, tokens, ['--porcelain=v1', '-b'], 'git-status-porcelain');
  }
  if (binary === 'docker' && subcommand === 'build' && config?.rewrite?.dockerBuild === true) {
    return hasAny(tokens, ['-q', '--quiet']) ? null : append(command, tokens, ['--quiet'], 'docker-build-quiet');
  }
  if (binary === 'mvn' || binary === 'gradle') {
    return hasAny(tokens, ['-q', '--quiet']) ? null : append(command, tokens, ['-q'], `${binary}-quiet`);
  }
  return null;
}
