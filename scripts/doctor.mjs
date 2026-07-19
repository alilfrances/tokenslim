#!/usr/bin/env node
// Installation health check. Unlike hooks, doctor deliberately reports failures but
// never throws, making it safe to use as a support diagnostic.
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { loadConfig } from './lib/config.mjs';
import { dataDir } from './lib/history.mjs';
import { detectRuntime } from './lib/hook-output.mjs';

const args = process.argv.slice(2);
const root = resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : process.env.TOKENSLIM_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'));
const problems = []; const checks = [];
function ok(label, detail = '') { checks.push({ label, detail }); }
function bad(label, detail) { problems.push({ label, detail }); }
function writable(path, label) {
  try {
    mkdirSync(path, { recursive: true }); accessSync(path, constants.W_OK);
    const probe = join(path, `.tokenslim-doctor-${process.pid}`); writeFileSync(probe, 'ok'); rmSync(probe, { force: true }); ok(label, path);
  } catch { bad(label, `${path} is not writable; set the matching XDG directory to a writable location.`); }
}
function hookScripts() {
  const hooksPath = join(root, 'hooks', 'hooks.json');
  let hooks;
  try { hooks = JSON.parse(readFileSync(hooksPath, 'utf8')); ok('hooks JSON', hooksPath); } catch { bad('hooks JSON', `${hooksPath} is missing or invalid JSON.`); return; }
  const entries = Object.values(hooks.hooks || {}).flat().flatMap((group) => group.hooks || []);
  for (const hook of entries) {
    const match = String(hook.command || '').match(/scripts\/([A-Za-z0-9_-]+\.mjs)/);
    if (!match) { bad('hook script', `Cannot find a scripts/*.mjs reference in ${hook.command || '(empty command)'}.`); continue; }
    const script = join(root, 'scripts', match[1]);
    if (!existsSync(script)) { bad('hook script', `${match[1]} is referenced by hooks/hooks.json but does not exist.`); continue; }
    const checked = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
    if (checked.status === 0) ok(`hook script ${match[1]}`); else bad(`hook script ${match[1]}`, `${match[1]} failed node --check: ${(checked.stderr || '').trim()}`);
  }
}
function configLayers() {
  const home = process.env.HOME || homedir(); const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const paths = [join(configHome, 'tokenslim', 'config.json'), join(process.cwd(), '.tokenslim.json')];
  return paths.map((path) => ({ path, active: existsSync(path) }));
}
function run() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 18) ok('Node version', process.versions.node); else bad('Node version', `Node ${process.versions.node} is unsupported; install Node 18 or newer.`);
  if (existsSync(root)) ok('plugin root', root); else bad('plugin root', `${root} does not exist. Reinstall the tokenslim plugin or set TOKENSLIM_PLUGIN_ROOT.`);
  hookScripts();
  const cache = join(process.env.XDG_CACHE_HOME || join(process.env.HOME || homedir(), '.cache'), 'tokenslim');
  writable(cache, 'ledger directory'); writable(dataDir(), 'history directory'); writable(join(cache, 'tee'), 'tee directory');
  const layers = configLayers(); const config = loadConfig(process.cwd(), process.env);
  const disabled = [...new Set([...(config.disable || []), ...String(process.env.TOKENSLIM_DISABLE || '').split(',').map((x) => x.trim()).filter(Boolean)])];
  return { root, checks, problems, node: process.versions.node, runtime: detectRuntime(null, process.env), configLayers: layers, config, disabled };
}
function render(report) {
  const lines = ['tokenslim doctor:'];
  lines.push(...report.checks.map((c) => `  ok  ${c.label}${c.detail ? `: ${c.detail}` : ''}`));
  lines.push(`  runtime: ${report.runtime}`);
  lines.push(`  config layers: ${report.configLayers.map((x) => `${x.active ? 'active' : 'absent'} ${x.path}`).join('; ')}`);
  lines.push(`  effective config: ${JSON.stringify(report.config)}`);
  lines.push(`  disabled: ${report.disabled.length ? report.disabled.join(', ') : '(none)'}`);
  if (report.problems.length) lines.push('problems:', ...report.problems.map((p) => `  ! ${p.label}: ${p.detail}`));
  else lines.push('ok: tokenslim installation is healthy.');
  return lines.join('\n');
}
const report = run();
if (args.includes('--format') && args[args.indexOf('--format') + 1] === 'json') console.log(JSON.stringify(report));
else console.log(render(report));
process.exitCode = report.problems.length ? 1 : 0;
