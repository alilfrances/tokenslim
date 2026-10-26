// Context budget audit: which always-on context (skill/agent/MCP listings, hook output, memory files) a session carried
// and how often it was used. Reads only names and sizes from transcripts, never the text itself.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanSessions } from './transcripts.mjs';

const CHARS_PER_TOKEN = 4;
// Attachment types that are not model-visible context and so never count as overhead:
//   prompt_snapshot       internal copy of the system prompt (counting it would double count everything)
//   deferred_tools_record bookkeeping of tool-input copies, never rendered to the model
//   credential_org        account metadata with no rendered text
// Every other unknown type is counted under "other" (its rendered text when Claude recorded it, else its JSON size).
export const EXCLUDED_ATTACHMENT_TYPES = new Set(['prompt_snapshot', 'deferred_tools_record', 'credential_org']);

const strings = (value) => (Array.isArray(value) ? value : []).map((item) => (typeof item === 'string' ? item : ''));
const str = (value) => (typeof value === 'string' ? value : '');
// Claude normalises MCP server names the same way in tool names (mcp__<server>__<tool>) and in listings.
export const normalizeServer = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');

function textLength(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + textLength(item), 0);
  if (value && typeof value === 'object') return textLength(value.text) || textLength(value.content);
  return 0;
}

function jsonLength(value) {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
}

// Calls are sorted by line index, so "calls strictly after the attachment and before its removal" is two bisections.
function firstAtOrAfter(sorted, x) { let lo = 0; let hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; } return lo; }
function callsBetween(sorted, start, end) {
  const from = firstAtOrAfter(sorted, start + 1);
  const to = end === null ? sorted.length : firstAtOrAfter(sorted, end);
  return Math.max(0, to - from);
}

// Per-skill sizes from the listing text: entries start at "- <name>:" (or "- <name> (") and run to the next entry.
// Names that match no entry share what is left of the listing evenly.
export function skillSizes(content, names) {
  const entries = [];
  for (const line of content.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('- ')) entries.push(line + '\n');
    else if (entries.length) entries[entries.length - 1] += line + '\n';
  }
  const sizes = new Map();
  let matched = 0;
  for (const name of names) {
    if (sizes.has(name)) continue;
    const entry = entries.find((e) => e.startsWith(`- ${name}:`) || e.startsWith(`- ${name} (`));
    if (entry) { sizes.set(name, entry.length); matched += entry.length; }
  }
  const unmatched = names.filter((n, i) => !sizes.has(n) && names.indexOf(n) === i);
  for (const name of unmatched) sizes.set(name, Math.max(0, content.length - matched) / unmatched.length);
  return sizes;
}

export function analyze(files, { sinceMs } = {}) {
  const rows = new Map();
  const otherTypes = new Map();
  const uses = { skill: new Map(), plugin: new Map(), mcp: new Map(), agent: new Map() };
  const known = { skill: new Set(), pluginSkill: new Map(), pluginAgent: new Map() };
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  let sessions = 0; let apiCalls = 0; let totalInput = 0;

  for (const scan of scanSessions(files, { sinceMs, skipAttachmentTypes: EXCLUDED_ATTACHMENT_TYPES })) {
    sessions += 1;
    const callIndexes = scan.calls.map((call) => call.index);
    apiCalls += callIndexes.length;
    for (const call of scan.calls) totalInput += call.inputTokens || 0;

    const live = new Map(); // family:name -> open entry, so a removal delta can close it
    const closed = [];
    const open = (family, name, kind, owner, chars, start) => {
      if (!(chars > 0)) return;
      const key = `${family}:${name}`;
      if (live.has(key)) return;
      const entry = { kind, owner, chars, start, end: null };
      live.set(key, entry); closed.push(entry);
    };
    const close = (family, name, at) => {
      const entry = live.get(`${family}:${name}`);
      if (entry) { entry.end = at; live.delete(`${family}:${name}`); }
    };
    const other = (type, chars, at) => {
      if (!(chars > 0)) return;
      bump(otherTypes, type);
      closed.push({ kind: 'other', owner: 'other attachments (not prunable)', chars, start: at, end: null });
    };

    for (const { index: at, attachment: a, renderedChars } of scan.attachments) {
      const type = str(a.type) || '(untyped)';
      if (type === 'skill_listing') {
        const names = strings(a.names).filter(Boolean);
        const content = str(a.content);
        if (!names.length) { other(type, renderedChars ?? (content.length || jsonLength(a)), at); continue; }
        const sizes = content ? skillSizes(content, names) : new Map(names.map((n) => [n, (renderedChars ?? 0) / names.length]));
        for (const name of names) {
          const colon = name.indexOf(':');
          if (colon > 0) {
            const plugin = name.slice(0, colon);
            open('skill', name, 'plugin', plugin, sizes.get(name), at);
            if (!known.pluginSkill.has(name.slice(colon + 1))) known.pluginSkill.set(name.slice(colon + 1), new Set());
            known.pluginSkill.get(name.slice(colon + 1)).add(plugin);
          } else { open('skill', name, 'skill', name, sizes.get(name), at); known.skill.add(name); }
        }
      } else if (type === 'mcp_instructions_delta') {
        for (const name of strings(a.removedNames)) close('mcpi', normalizeServer(name), at);
        const added = strings(a.addedNames);
        const blocks = strings(a.addedBlocks);
        added.forEach((name, i) => {
          const block = blocks[i] || blocks.find((b) => b.startsWith(`## ${name}\n`)) || '';
          const server = normalizeServer(name);
          open('mcpi', server, 'mcp', server, block.length, at);
        });
      } else if (type === 'deferred_tools_delta') {
        for (const name of strings(a.removedNames)) close('tool', name, at);
        const lines = strings(a.addedLines);
        strings(a.addedNames).forEach((name, i) => {
          if (!name) return;
          const line = lines[i] ?? lines.find((l) => l.startsWith(name)) ?? name;
          const parts = name.split('__');
          const isMcp = parts[0] === 'mcp' && parts.length >= 3 && parts[1];
          open('tool', name, isMcp ? 'mcp' : 'builtin', isMcp ? normalizeServer(parts[1]) : 'built-in tools (not prunable)', line.length + 1, at);
        });
      } else if (type === 'agent_listing_delta') {
        for (const name of strings(a.removedTypes)) close('agent', name, at);
        const builtIn = new Set([...strings(a.builtInTypes), ...strings(a.builtInPluginTypes)]);
        const lines = strings(a.addedLines);
        strings(a.addedTypes).forEach((name, i) => {
          if (!name) return;
          const line = lines[i] ?? lines.find((l) => l.startsWith(`- ${name}:`)) ?? '';
          const colon = name.indexOf(':');
          if (builtIn.has(name)) open('agent', name, 'builtin', 'built-in agents (not prunable)', line.length + 1, at);
          else if (colon > 0) {
            open('agent', name, 'plugin', name.slice(0, colon), line.length + 1, at);
            if (!known.pluginAgent.has(name.slice(colon + 1))) known.pluginAgent.set(name.slice(colon + 1), new Set());
            known.pluginAgent.get(name.slice(colon + 1)).add(name.slice(0, colon));
          } else open('agent', name, 'agent', name, line.length + 1, at);
        });
      } else if (type.startsWith('hook_')) {
        const name = str(a.hookName) || str(a.hook_name) || str(a.name) || str(a.hookEvent) || type;
        // content, additionalContext and stdout echo each other in the hook attachments; counting one avoids doubling.
        const chars = textLength(a.content) || textLength(a.additionalContext) || textLength(a.stdout) || textLength(a.text) || (renderedChars ?? 0);
        open(`hook${at}`, name, 'hook', name, chars, at);
      } else if (type === 'nested_memory') {
        const inner = a.content && typeof a.content === 'object' && !Array.isArray(a.content) ? a.content : {};
        const path = str(a.path) || str(a.displayPath) || str(a.filename) || str(inner.path) || '(unknown file)';
        const chars = textLength(a.content) || textLength(a.text) || (renderedChars ?? jsonLength(a));
        open(`memory${at}`, path, 'memory', path, chars, at);
      } else other(type, renderedChars ?? jsonLength(a), at);
    }

    for (const entry of closed) {
      const key = `${entry.kind}\0${entry.owner}`;
      if (!rows.has(key)) rows.set(key, { kind: entry.kind, name: entry.owner, chars: 0, weightedChars: 0, files: new Set() });
      const row = rows.get(key);
      row.chars += entry.chars;
      row.weightedChars += entry.chars * callsBetween(callIndexes, entry.start, entry.end);
      row.files.add(scan.file);
    }

    for (const use of scan.toolUses) {
      const input = use.input && typeof use.input === 'object' ? use.input : {};
      const name = str(use.name);
      if (name === 'Skill') {
        const skill = str(input.skill) || str(input.command) || str(input.name);
        if (!skill) continue;
        const colon = skill.indexOf(':');
        if (colon > 0) bump(uses.plugin, skill.slice(0, colon)); else bump(uses.skill, skill);
      } else if (name.startsWith('mcp__')) {
        const server = name.split('__')[1];
        if (server) bump(uses.mcp, normalizeServer(server));
      } else if (name === 'Agent' || name === 'Task') {
        const type = str(input.subagent_type);
        if (!type) continue;
        const colon = type.indexOf(':');
        if (colon > 0) bump(uses.plugin, type.slice(0, colon)); else bump(uses.agent, type);
      }
    }
  }
  return { sessions, apiCalls, totalInput, rows: [...rows.values()], otherTypes: Object.fromEntries([...otherTypes].sort()), uses, known };
}

// Project-scoped configuration, read-only: where overhead can be pruned from and which plugin keys exist.
export function loadProjectConfig({ cwd, env = process.env }) {
  const userDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  const readJson = (path) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; } };
  const settings = [join(userDir, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')].map(readJson);
  const plugins = new Map();
  for (const file of settings) {
    const enabled = file?.enabledPlugins;
    if (enabled && typeof enabled === 'object' && !Array.isArray(enabled)) for (const [key, value] of Object.entries(enabled)) plugins.set(key, value);
  }
  const disabledMcp = new Set();
  for (const file of settings) for (const name of strings(file?.disabledMcpjsonServers)) disabledMcp.add(name);
  const mcpFile = readJson(join(cwd, '.mcp.json'));
  const servers = mcpFile?.mcpServers && typeof mcpFile.mcpServers === 'object' ? Object.keys(mcpFile.mcpServers) : [];
  return {
    cwd,
    pluginKeys(name) { return [...plugins].filter(([key]) => (key.lastIndexOf('@') > 0 ? key.slice(0, key.lastIndexOf('@')) : key) === name); },
    projectMcpKey(server) { return servers.find((key) => normalizeServer(key) === server) ?? null; },
    disabledMcp,
  };
}

// [short label for the report table, full reason for the manual list]
function manualReason(row, config) {
  if (row.kind === 'mcp') {
    if (row.name.startsWith('claude_ai_')) return ['manual: claude.ai connectors', 'claude.ai connector: disable it in the claude.ai connector settings'];
    if (row.name.startsWith('plugin_')) return ['manual: disable the plugin', 'MCP server provided by a plugin: disable that plugin or use /mcp'];
    return ['manual: /mcp', `not defined in ${join(config.cwd, '.mcp.json')} (user-scope server): disable it with /mcp`];
  }
  if (row.kind === 'plugin') {
    const keys = config.pluginKeys(row.name);
    return keys.length > 1
      ? ['manual: /plugin', `ambiguous: several enabledPlugins keys match (${keys.map(([k]) => k).join(', ')}); disable the right one with /plugin`]
      : ['manual: /plugin', 'no enabledPlugins key found in user or project settings; disable it with /plugin'];
  }
  if (row.kind === 'skill') return ['manual: SKILL.md*', 'user/project or built-in skill: remove its SKILL.md if it is user/project-defined; built-in skills (e.g. loop, init, simplify) cannot be removed'];
  if (row.kind === 'agent') return ['manual: remove agent file', 'user/project agent: remove or move its agent file (built-in agents cannot be pruned)'];
  return [row.kind === 'builtin' ? 'built-in' : 'not prunable', 'not prunable'];
}

/** Where a row could be pruned: `{ prunable, how, key }`. `key` is the settings value to write when prunable. */
function pruneTarget(row, config) {
  if (row.kind === 'plugin') {
    const keys = config.pluginKeys(row.name);
    if (keys.length === 1) return keys[0][1] === false
      ? { prunable: false, how: 'already disabled in settings', key: null, done: true }
      : { prunable: true, how: 'enabledPlugins', key: keys[0][0] };
  } else if (row.kind === 'mcp') {
    const key = config.projectMcpKey(row.name);
    if (key) return config.disabledMcp.has(key)
      ? { prunable: false, how: 'already disabled in settings', key: null, done: true }
      : { prunable: true, how: 'disabledMcpjsonServers', key };
  }
  return { prunable: false, how: manualReason(row, config)[0], key: null };
}

export function buildReport(analysis, { config, minTokens = 500, limit = 25 } = {}) {
  const { uses, known } = analysis;
  // A bare Skill/Agent name that is not a user skill but is a plugin's skill/agent counts toward that plugin when unambiguous.
  const bare = new Map(uses.plugin);
  const credit = (names, byName, owned) => {
    for (const [name, count] of names) {
      if (owned?.has(name)) continue;
      const owners = byName.get(name);
      if (owners?.size === 1) { const plugin = [...owners][0]; bare.set(plugin, (bare.get(plugin) || 0) + count); }
    }
  };
  credit(uses.skill, known.pluginSkill, known.skill);
  credit(uses.agent, known.pluginAgent, null);

  const pct = (tokens) => (analysis.totalInput > 0 ? Math.round((tokens / analysis.totalInput) * 1000) / 10 : null);
  const rows = analysis.rows.map((r) => {
    const uses_ = r.kind === 'plugin' ? bare.get(r.name) || 0
      : r.kind === 'mcp' ? uses.mcp.get(r.name) || 0
        : r.kind === 'skill' ? uses.skill.get(r.name) || 0
          : r.kind === 'agent' ? uses.agent.get(r.name) || 0 : null;
    const weightedTokens = Math.round(r.weightedChars / CHARS_PER_TOKEN);
    const target = pruneTarget(r, config);
    return {
      kind: r.kind, name: r.name, sessions: r.files.size,
      tokensPerSession: Math.round(r.chars / CHARS_PER_TOKEN / r.files.size),
      weightedTokens, pctInput: pct(weightedTokens), uses: uses_,
      prunable: target.prunable, how: target.how,
      _key: target.key, _done: Boolean(target.done),
    };
  }).sort((a, b) => b.weightedTokens - a.weightedTokens || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  const candidates = rows.filter((r) => r.uses === 0 && r.weightedTokens >= minTokens && !r._done);
  const sum = (list) => list.reduce((total, r) => total + r.weightedTokens, 0);
  const prunableTokens = sum(rows.filter((r) => r.prunable));
  const totalTokens = sum(rows);
  const clean = ({ _key, _done, ...row }) => row;
  const report = {
    sessions: analysis.sessions, apiCalls: analysis.apiCalls, totalInputTokens: analysis.totalInput, minTokens,
    summary: {
      overheadWeightedTokens: totalTokens, overheadPct: pct(totalTokens),
      prunableWeightedTokens: prunableTokens, prunablePct: pct(prunableTokens),
      nonPrunableWeightedTokens: totalTokens - prunableTokens, nonPrunablePct: pct(totalTokens - prunableTokens),
    },
    otherTypes: analysis.otherTypes,
    rows: rows.slice(0, limit).map(clean),
    rowCount: rows.length,
    candidates: candidates.map(clean),
  };
  // Prune keys stay out of the printable report; emitSettings reads them from here.
  Object.defineProperty(report, 'pruneCandidates', { value: candidates, enumerable: false });
  return report;
}

/** The settings.local.json snippet for the candidates, plus what cannot be pruned from project settings. Never writes. */
export function emitSettings(report, config) {
  const settings = {};
  const manual = [];
  for (const row of report.pruneCandidates) {
    if (row.prunable && row.kind === 'plugin') (settings.enabledPlugins ??= {})[row._key] = false;
    else if (row.prunable && row.kind === 'mcp') (settings.disabledMcpjsonServers ??= []).push(row._key);
    else manual.push({ kind: row.kind, name: row.name, weightedTokens: row.weightedTokens, reason: manualReason(row, config)[1] });
  }
  return { file: join(config.cwd, '.claude', 'settings.local.json'), settings, manual, written: false };
}

const fmt = (n) => n.toLocaleString('en-US');
const pctText = (value) => (value === null ? '-' : `${value}%`);

// A skill without a `plugin:` prefix is user/project-defined or built into Claude Code; the listing cannot tell which.
const kindLabel = (kind) => (kind === 'skill' ? 'skill (user/built-in)' : kind);

export function renderReport(report) {
  if (!report.sessions) return 'tokenslim budget: no transcripts found.';
  const s = report.summary;
  const lines = [
    `tokenslim budget: scanned ${report.sessions} transcript(s), ${fmt(report.apiCalls)} API call(s)`,
    `  input across those calls: ~${fmt(report.totalInputTokens)} tokens`,
    `  identified overhead: ~${fmt(s.overheadWeightedTokens)} weighted tokens (${pctText(s.overheadPct)} of input; an upper bound, much of it cannot be removed)`,
    `    prunable from project settings: ~${fmt(s.prunableWeightedTokens)} (${pctText(s.prunablePct)})`,
    `    not prunable (manual or built-in): ~${fmt(s.nonPrunableWeightedTokens)} (${pctText(s.nonPrunablePct)})`,
    '  weighted tokens = size in tokens (chars/4) x API calls that carried it',
  ];
  if (report.rows.length) {
    const cell = (r) => [kindLabel(r.kind), r.name, fmt(r.tokensPerSession), fmt(r.weightedTokens), pctText(r.pctInput), r.uses === null ? '-' : String(r.uses), r.prunable ? `via ${r.how}` : r.how];
    const table = report.rows.map(cell);
    const head = ['kind', 'name', 'tok/session', 'weighted', '%input', 'uses', 'prune'];
    const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
    const line = (row) => '  ' + row.map((c, i) => (i >= 2 && i <= 5 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();
    lines.push(`overhead by source (top ${report.rows.length} of ${report.rowCount}):`, line(head), ...table.map(line));
    if (report.rows.some((r) => r.kind === 'skill')) lines.push('  * a skill without a plugin prefix is user/project-defined or built into Claude Code: remove its SKILL.md only if you defined it; built-in skills cannot be removed.');
  }
  const other = Object.entries(report.otherTypes);
  if (other.length) lines.push(`other attachment types counted: ${other.map(([t, n]) => `${t} x${n}`).join(', ')}`);
  lines.push(`unused candidates (0 uses, >= ${fmt(report.minTokens)} weighted tokens):`);
  lines.push(...(report.candidates.length
    ? report.candidates.map((r) => `  ${kindLabel(r.kind)} ${r.name}  ~${fmt(r.weightedTokens)} weighted tokens, ${r.prunable ? `prune via ${r.how}` : r.how}`)
    : ['  (none)']));
  if (report.candidates.length) lines.push('run with --emit-settings to print a settings.local.json snippet (it never writes any file).');
  return lines.join('\n');
}

export function renderSettings(result, minTokens) {
  const lines = [`tokenslim budget: suggested settings for ${result.file} (printed only, nothing was written):`];
  lines.push(Object.keys(result.settings).length ? JSON.stringify(result.settings, null, 2) : `  (no prunable candidates at >= ${fmt(minTokens)} weighted tokens)`);
  if (result.manual.length) {
    lines.push('manual (cannot be pruned from project settings):');
    for (const m of result.manual) lines.push(`  - ${m.kind} ${m.name} (~${fmt(m.weightedTokens)} weighted tokens): ${m.reason}`);
  }
  return lines.join('\n');
}
