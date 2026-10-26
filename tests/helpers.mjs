import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Hooks write ledgers, tee files and history under XDG dirs (falling back to the real $HOME), so every
// spawned script gets private ones. `extra` wins, letting a test pin a dir it wants to inspect afterwards.
export function isolatedEnv(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tokenslim-iso-'));
  return {
    env: {
      ...process.env,
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CONFIG_HOME: join(root, 'config'),
      ...extra,
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}
