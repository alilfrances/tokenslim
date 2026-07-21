import { tokenizeCommand } from './rewrite-rules.mjs';

// Only these tools have stable, non-sensitive second-token subcommands. Arguments,
// paths, URLs, package names, headers, and environment assignments are never persisted.
const SUBCOMMAND_TOOLS = new Set([
  'cargo', 'composer', 'docker', 'gh', 'git', 'go', 'gradle', 'helm', 'kubectl',
  'mvn', 'npm', 'pip', 'pip3', 'pnpm', 'terraform', 'yarn',
]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function skipLeadingEnvAssignments(tokens = []) {
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[index])) index += 1;
  return index;
}

function unquote(token) {
  const text = String(token || '');
  if (text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function safeName(token) {
  const name = unquote(token).split(/[\\/]/).pop();
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name || '') ? name : null;
}

/**
 * Return a privacy-safe command family for local analytics and discovery reports.
 * Full command lines can contain credentials, URLs, paths, and inline environment
 * variables, so they must never be written to tokenslim ledgers/history.
 */
export function commandFamily(command) {
  const tokens = tokenizeCommand(command);
  if (!tokens?.length) return '(unknown)';

  const index = skipLeadingEnvAssignments(tokens);
  const binary = safeName(tokens[index]);
  if (!binary) return '(other)';

  if (!SUBCOMMAND_TOOLS.has(binary)) return binary;
  const subcommand = safeName(tokens[index + 1]);
  return subcommand && !subcommand.startsWith('-') ? `${binary} ${subcommand}` : binary;
}
