#!/usr/bin/env node
// Statusline: model | context used % | tokens saved by tokenslim this session.
// Claude Code pipes session JSON on stdin (see docs /en/statusline).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}

let model = '';
let ctx = '';
let saved = '';

try {
  const j = JSON.parse(input);
  model = j.model?.display_name || '';
  const used = j.context_window?.used_percentage;
  if (typeof used === 'number') ctx = `ctx ${used}%`;

  const sessionId = (j.session_id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const ledger = join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'tokenslim',
    `${sessionId}.json`
  );
  if (sessionId && existsSync(ledger)) {
    const state = JSON.parse(readFileSync(ledger, 'utf8'));
    let bytesIn = 0;
    let bytesOut = 0;
    for (const s of Object.values(state.savings || {})) {
      bytesIn += s.bytesIn;
      bytesOut += s.bytesOut;
    }
    const tok = Math.round((bytesIn - bytesOut) / 3);
    if (tok > 0) saved = `slim -${tok >= 1000 ? `${(tok / 1000).toFixed(1)}k` : tok} tok`;
  }
} catch {
  /* render whatever we have */
}

console.log([model, ctx, saved].filter(Boolean).join(' | '));
