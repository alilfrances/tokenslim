// The text a guard shows when it holds back a big read. Pure (no filesystem, no process state) so the read guard
// and the replay benchmark build byte-identical reasons from the same inputs.

export const CHARS_PER_TOKEN = 3;
export const READ_INSTRUCTION = 'Re-read with offset/limit for the section you need. Repeating this exact Read will return the full file.';
// Wording for the Bash whole-file-dump guard (PLAN-v0.4.1 WP4).
export const BASH_DUMP_INSTRUCTION = "Read it with the Read tool using offset/limit, or `sed -n 'a,bp'` for the range you need. Repeating this exact command returns the full output.";

/**
 * Deny reason for a held-back read: a size line, the outline (when there is one) and a fixed instruction.
 * `lineInfo` is { lines, capped } from the line counter; `outline` is an outlineFile()/outlineText() result or null.
 * `subject` is the noun in "the full <subject> was held back".
 */
export function guardDenyReason({ filePath, size, lineInfo, outline, subject = 'Read', instruction = READ_INSTRUCTION }) {
  const lines = lineInfo.capped ? `>${lineInfo.lines}` : String(outline && !outline.partial ? outline.totalLines : lineInfo.lines);
  const kb = Math.max(1, Math.round(size / 1024));
  const parts = [`[tokenslim] ${filePath} is ${lines} lines, ${kb} KB (~${Math.round(size / CHARS_PER_TOKEN)} tokens); the full ${subject} was held back.`];
  if (outline && outline.entries.length) {
    parts.push('Outline:', ...outline.entries);
    if (outline.more) parts.push(`… ${outline.more} more`);
    if (outline.partial) parts.push('(outline covers the first 1MB only)');
  }
  parts.push(instruction);
  return parts.join('\n');
}
