---
description: Mechanically slim a CLAUDE.md / rules / memory file (dedup + noise strip, meaning preserved)
argument-hint: <file-path>
---

Slim the memory file at: $ARGUMENTS

This is a MECHANICAL compression, not a stylistic rewrite. Apply only these transforms:

1. **Dedup**: merge rules/bullets that say the same thing twice in different words. Keep the clearer phrasing.
2. **Collapse structure**: fold single-bullet sections into their parent; remove headers with no content; flatten nesting deeper than 2 levels.
3. **Strip noise**: horizontal rules, decorative formatting, "Note:", "Important:", "Please" prefixes, restated context the file itself already establishes, examples that repeat an already-stated rule without adding a constraint.
4. **Tighten prose**: drop filler words; keep every directive, path, command, threshold, URL, and code block byte-identical.

NEVER: remove a rule, change a rule's meaning, alter code blocks, paths, commands, numbers, or URLs, or convert to caveman-speak/fragments — output stays normal readable English.

Process:
1. Read the file.
2. Produce the slimmed version.
3. Show the user: original size vs slimmed size (chars and estimated tokens at ~4 chars/token) and a summary of what was removed/merged.
4. Ask for confirmation before writing.
5. On confirmation: save the original to `<file>.original.md` (only if no such backup exists yet — never overwrite an existing backup), then overwrite the file with the slimmed version.
