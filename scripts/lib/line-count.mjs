// Capped line counting shared by the Read guard and the Bash dump guard.
import { openSync, readSync, closeSync } from 'node:fs';

export const COUNT_BYTE_CAP = 5 * 1024 * 1024;

// Count incrementally so a PreToolUse hook never materializes a giant artifact.
// `capped` means this is a lower bound, not an exact line count.
export function countLinesCapped(filePath, size) {
  const limit = Math.min(size, COUNT_BYTE_CAP);
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, limit)));
  let position = 0;
  let newlines = 0;
  let last = 0;
  let fd;
  try {
    fd = openSync(filePath, 'r');
    while (position < limit) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, limit - position), position);
      if (!read) break;
      for (let i = 0; i < read; i += 1) if (buffer[i] === 10) newlines += 1;
      last = buffer[read - 1];
      position += read;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  // `lines` counts the empty piece after a final newline (as before); `endsWithNewline` lets a caller drop it.
  return { lines: newlines + 1, capped: size > position, endsWithNewline: last === 10 };
}
