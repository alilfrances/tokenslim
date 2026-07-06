#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--tag') {
      args.tag = argv[index + 1];
      index += 1;
    }
  }

  return args;
}

function fail(message) {
  console.error(`release version validation failed: ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const codexManifest = readJson('.codex-plugin/plugin.json');
const claudeManifest = readJson('.claude-plugin/plugin.json');
const codexVersion = codexManifest.version;
const claudeVersion = claudeManifest.version;

if (!SEMVER.test(codexVersion)) {
  fail(`.codex-plugin/plugin.json version must be SemVer, got ${codexVersion}`);
}

if (!SEMVER.test(claudeVersion)) {
  fail(`.claude-plugin/plugin.json version must be SemVer, got ${claudeVersion}`);
}

if (codexVersion !== claudeVersion) {
  fail(`manifest versions differ: Codex=${codexVersion}, Claude=${claudeVersion}`);
}

const explicitTag = Object.hasOwn(args, 'tag');
const tag = explicitTag ? args.tag : process.env.GITHUB_REF_NAME;

if (explicitTag && !tag) {
  fail('--tag requires a value');
}

if (tag && (explicitTag || tag.startsWith('v'))) {
  if (!tag.startsWith('v')) {
    fail(`release tag must start with v, got ${tag}`);
  }

  const tagVersion = tag.slice(1);

  if (!SEMVER.test(tagVersion)) {
    fail(`release tag must be vX.Y.Z, got ${tag}`);
  }

  if (tagVersion !== codexVersion) {
    fail(`tag ${tag} does not match manifest version ${codexVersion}`);
  }
}

console.log(`release version validation passed: v${codexVersion}`);
