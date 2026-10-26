// Cheap regex outlines for the Read guard's deny mode. Not parsers: a missed or extra entry only costs
// the model a slightly worse map. Every pattern is anchored and matched against a length-capped line,
// and nothing nests unbounded quantifiers, so a 1MB single-line file cannot cause backtracking blowups.

import { closeSync, openSync, readSync } from 'node:fs';
import { basename, extname } from 'node:path';

export const MAX_ENTRIES = 40;
export const MAX_READ_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 400;
const MAX_SIGNATURE_CHARS = 100;

const LANGUAGES = {
  js: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'],
  py: ['.py', '.pyi'],
  c: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.cu', '.cuh', '.ino'],
  qml: ['.qml'],
  md: ['.md', '.markdown', '.mdx'],
  json: ['.json'],
  yaml: ['.yml', '.yaml'],
};
const LANGUAGE_BY_EXT = new Map(Object.entries(LANGUAGES).flatMap(([language, exts]) => exts.map((ext) => [ext, language])));

// Files the deny mode may withhold: source, config and docs only. Images, PDFs, notebooks, archives and
// other binaries (and data dumps such as csv/log) are deliberately absent so they can never be denied.
const TEXT_EXTENSIONS = new Set([
  ...LANGUAGE_BY_EXT.keys(),
  '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift', '.m', '.mm', '.cs', '.fs', '.rb', '.php', '.pl', '.pm',
  '.lua', '.r', '.jl', '.dart', '.ex', '.exs', '.erl', '.hs', '.ml', '.clj', '.vue', '.svelte', '.astro',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gql', '.proto', '.cmake', '.mk',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.xml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.gradle', '.tf', '.hcl', '.txt', '.rst', '.adoc', '.tex',
]);
const TEXT_BASENAMES = new Set([
  'makefile', 'gnumakefile', 'dockerfile', 'containerfile', 'rakefile', 'gemfile', 'procfile', 'justfile',
  'vagrantfile', 'jenkinsfile', 'license', 'readme', 'changelog', 'notice', 'authors', 'codeowners',
]);

export function languageFor(filePath) {
  return LANGUAGE_BY_EXT.get(extname(String(filePath)).toLowerCase()) || null;
}

export function isTextLikePath(filePath) {
  const name = basename(String(filePath)).toLowerCase();
  if (/\.min\.(?:js|css)$/.test(name)) return false;
  if (TEXT_BASENAMES.has(name) || name.startsWith('dockerfile.')) return true;
  return TEXT_EXTENSIONS.has(extname(name));
}

function clean(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SIGNATURE_CHARS ? `${flat.slice(0, MAX_SIGNATURE_CHARS - 1)}…` : flat;
}

const indentOf = (line) => line.length - line.trimStart().length;
const clip = (line) => (line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line);

// --- JS / TS ---------------------------------------------------------------------------------------
const JS_FUNCTION = /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\b\*?\s*[\w$]*/;
const JS_CLASS = /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\b\s*[\w$]*/;
const JS_TYPE = /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?(?:interface|enum|namespace|type)\s+[\w$]+/;
const JS_CONST_FN = /^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[\w$]+\s*=>)/;
const JS_EXPORTS_FN = /^(?:module\.exports|exports\.[\w$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/;
const JS_METHOD = /^\s+(?:(?:public|private|protected|static|async|override|readonly|abstract|declare|get|set)\s+)*\*?\s*(#?[\w$]+)\s*(?:<[^>(]*>)?\s*\([^)]*\)\s*(?::[^{;]*)?\{\s*$/;
const JS_NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'try']);

function jsSignature(line) {
  return clean(line.replace(/\s*\{\s*$/, '').replace(/\s*=>.*$/, ' =>'));
}

function outlineJs(lines) {
  const entries = [];
  let classIndent = -1;
  let memberIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = clip(lines[i]);
    if (!line.trim()) continue;
    if (classIndent >= 0 && indentOf(line) <= classIndent && !/^\s*[})\]/*]/.test(line)) classIndent = -1;
    if (JS_CLASS.test(line)) {
      entries.push({ line: i + 1, text: jsSignature(line) });
      classIndent = indentOf(line);
      memberIndent = -1;
    } else if (JS_FUNCTION.test(line) || JS_TYPE.test(line) || JS_CONST_FN.test(line) || JS_EXPORTS_FN.test(line)) {
      entries.push({ line: i + 1, text: jsSignature(line) });
    } else if (classIndent >= 0 && indentOf(line) > classIndent) {
      const method = JS_METHOD.exec(line);
      if (!method || JS_NOT_METHODS.has(method[1])) continue;
      const indent = indentOf(line);
      if (memberIndent < 0) memberIndent = indent;
      if (indent === memberIndent) entries.push({ line: i + 1, text: `  ${jsSignature(line.trim())}` });
    }
  }
  return entries;
}

// --- Python ----------------------------------------------------------------------------------------
const PY_DEF = /^(\s*)(?:async\s+def|def|class)\s+\w+/;

function outlinePython(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = clip(lines[i]);
    const match = PY_DEF.exec(line);
    if (!match) continue;
    const indent = match[1].replace(/\t/g, '    ').length;
    entries.push({ line: i + 1, text: `${' '.repeat(indent)}${clean(line.trim().replace(/:\s*(?:#.*)?$/, ''))}` });
  }
  return entries;
}

// --- C / C++ ---------------------------------------------------------------------------------------
const C_AGGREGATE = /^(?:template\s*<[^>]*>\s*)?(?:typedef\s+)?(?:class|struct|namespace|union|enum(?:\s+class|\s+struct)?)\b[^;(]*$/;
const C_FUNCTION_START = /^[A-Za-z_~][\w:<>~*&\s,]*\(/;
const C_NOT_FUNCTIONS = new Set(['if', 'else', 'for', 'while', 'switch', 'return', 'do', 'using', 'extern', 'case', 'goto', 'sizeof']);

// A col-0 line with `(` counts as a definition when a `{` shows up before any `;` within a few lines.
function opensBody(lines, from) {
  for (let j = from; j < Math.min(lines.length, from + 8); j += 1) {
    const text = clip(lines[j]);
    const brace = text.indexOf('{');
    const semi = text.indexOf(';');
    if (semi >= 0 && (brace < 0 || semi < brace)) return false;
    if (brace >= 0) return true;
  }
  return false;
}

function outlineC(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = clip(lines[i]);
    if (!line || /^[\s#/*})]/.test(line)) continue;
    const first = /^\w+/.exec(line);
    if (first && C_NOT_FUNCTIONS.has(first[0])) continue;
    if (C_AGGREGATE.test(line)) {
      entries.push({ line: i + 1, text: clean(line.replace(/\s*\{.*$/, '')) });
    } else if (C_FUNCTION_START.test(line) && !/;\s*$/.test(line) && opensBody(lines, i)) {
      entries.push({ line: i + 1, text: clean(line.replace(/\s*\{.*$/, '')) });
    }
  }
  return entries;
}

// --- QML -------------------------------------------------------------------------------------------
const QML_OBJECT = /^\s*([A-Z][\w.]*)\s*\{\s*$/;
const QML_ID = /^\s*id\s*:\s*([A-Za-z_]\w*)/;
const QML_FUNCTION = /^\s*(?:async\s+)?function\s+\w+\s*\(/;

// Objects are listed when they are the root or carry an `id:` in their first few property lines.
function outlineQml(lines) {
  const entries = [];
  let sawRoot = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = clip(lines[i]);
    const object = QML_OBJECT.exec(line);
    if (object) {
      let id = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 7); j += 1) {
        const next = clip(lines[j]);
        const found = QML_ID.exec(next);
        if (found) { id = found[1]; break; }
        if (/\{\s*$/.test(next)) break;
      }
      if (id || !sawRoot) entries.push({ line: i + 1, text: `${' '.repeat(Math.min(indentOf(line), 8))}${object[1]}${id ? ` { id: ${id} }` : ''}` });
      sawRoot = true;
    } else if (QML_FUNCTION.test(line)) {
      entries.push({ line: i + 1, text: `${' '.repeat(Math.min(indentOf(line), 8))}${clean(line.trim().replace(/\s*\{.*$/, ''))}` });
    }
  }
  return entries;
}

// --- Markdown --------------------------------------------------------------------------------------
function outlineMarkdown(lines) {
  const entries = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = clip(lines[i]);
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(\S.*)$/.exec(line);
    if (heading) entries.push({ line: i + 1, text: `${heading[1]} ${clean(heading[2].replace(/\s+#+\s*$/, ''))}` });
  }
  return entries;
}

// --- YAML ------------------------------------------------------------------------------------------
function outlineYaml(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = clip(lines[i]);
    const key = /^([^\s#\-?:][^:]*):(?:\s|$)/.exec(line);
    if (key) entries.push({ line: i + 1, text: `${clean(key[1])}:` });
  }
  return entries;
}

// --- JSON (character scan: string-aware, depth-tracked) ---------------------------------------------
function outlineJson(text) {
  const entries = [];
  let depth = 0;
  let line = 1;
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 10) line += 1;
    else if (ch === 123 || ch === 91) depth += 1;
    else if (ch === 125 || ch === 93) depth -= 1;
    else if (ch === 34) {
      const start = i;
      const startLine = line;
      i += 1;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 92) i += 1;
        else if (c === 34) break;
        else if (c === 10) line += 1;
        i += 1;
      }
      if (depth !== 1) continue;
      let j = i + 1;
      while (j < n && (text.charCodeAt(j) <= 32)) j += 1;
      if (text.charCodeAt(j) === 58) entries.push({ line: startLine, text: clean(text.slice(start, Math.min(i + 1, start + 80))) });
    }
  }
  return entries;
}

function collect(language, text, lines) {
  switch (language) {
    case 'js': return outlineJs(lines);
    case 'py': return outlinePython(lines);
    case 'c': return outlineC(lines);
    case 'qml': return outlineQml(lines);
    case 'md': return outlineMarkdown(lines);
    case 'yaml': return outlineYaml(lines);
    case 'json': return outlineJson(text);
    default: return null;
  }
}

/**
 * Outline `text` as `language` (a languageFor() result). Returns null for an unknown language, otherwise
 * { totalLines, entries: ['L1-L9  signature', ...], more } with ranges ending at the next entry's start - 1
 * (the last one at the final line; entries sharing a line collapse to a one-line range).
 */
export function outlineText(text, language, { maxEntries = MAX_ENTRIES } = {}) {
  if (!language) return null;
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const found = collect(language, text, lines);
  if (!found) return null;
  const rendered = found.slice(0, maxEntries).map((entry, index) => {
    const next = found[index + 1];
    const end = next ? Math.max(entry.line, next.line - 1) : lines.length;
    return `L${entry.line}-L${end}  ${entry.text}`;
  });
  return { totalLines: lines.length, entries: rendered, more: Math.max(0, found.length - rendered.length) };
}

/** Outline a file, reading at most 1MB. `partial` means the file was larger and only its head was outlined. */
export function outlineFile(filePath, size) {
  const language = languageFor(filePath);
  if (!language) return null;
  const length = Math.min(size, MAX_READ_BYTES);
  const buffer = Buffer.alloc(length);
  let fd;
  let filled = 0;
  try {
    fd = openSync(filePath, 'r');
    while (filled < length) {
      const read = readSync(fd, buffer, filled, length - filled, filled);
      if (!read) break;
      filled += read;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const outline = outlineText(buffer.toString('utf8', 0, filled), language);
  return outline && { ...outline, language, partial: size > MAX_READ_BYTES };
}
