#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressBashOutput } from './lib/pipeline.mjs';
import { postToolUseOutput } from './lib/hook-output.mjs';

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function disabled() {
  const flags = String(process.env.TOKENSLIM_DISABLE || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return flags.includes('all') || flags.includes('bash');
}

async function recordSavingsBestEffort(sessionId, bytesIn, bytesOut) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const statePath = join(here, 'lib', 'state.mjs');
    if (!existsSync(statePath)) return;
    const stateModule = await import('./lib/state.mjs');
    const state = stateModule.loadState?.(sessionId);
    stateModule.recordSavings?.(state, { tool: 'Bash', bytesIn, bytesOut });
    stateModule.saveState?.(sessionId, state);
  } catch {
    // best-effort ledger only
  }
}

async function main() {
  try {
    if (disabled()) return;
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    const response = payload?.tool_response;
    const stringResponse = typeof response === 'string';
    const stdout = stringResponse ? response : String(response?.stdout ?? '');
    const stderr = stringResponse ? '' : String(response?.stderr ?? '');
    const minChars = Number.parseInt(process.env.TOKENSLIM_MIN_CHARS || '500', 10);
    const threshold = Number.isFinite(minChars) ? minChars : 500;
    if (stdout.length + stderr.length < threshold) return;

    const compressedStdout = compressBashOutput(stdout);
    const compressedStderr = compressBashOutput(stderr);
    const bytesIn = compressedStdout.stats.bytesIn + compressedStderr.stats.bytesIn;
    const bytesOut = compressedStdout.stats.bytesOut + compressedStderr.stats.bytesOut;
    if (bytesIn === 0 || bytesOut / bytesIn > 0.9) return;

    const updatedToolOutput = stringResponse
      ? compressedStdout.text
      : {
          stdout: compressedStdout.text,
          stderr: compressedStderr.text,
          interrupted: response?.interrupted,
          isImage: response?.isImage,
        };
    const output = postToolUseOutput(payload, updatedToolOutput);
    process.stdout.write(JSON.stringify(output));
    await recordSavingsBestEffort(payload?.session_id, bytesIn, bytesOut);
  } catch {
    // fail-open: original tool output passes through
  }
}

await main();
process.exit(0);
