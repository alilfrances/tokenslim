import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_COMMANDS,
  benchmarkFixtures,
  benchmarkEndToEndFixtures,
  dispatchFixture,
  formatMarkdown,
  formatText,
} from '../scripts/benchmark.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = join(root, 'tests', 'fixtures', 'bash');

test('benchmark covers every bash fixture with byte metrics and rules', () => {
  const fixtureNames = readdirSync(fixtureDirectory).filter((name) => name.endsWith('.txt')).sort();
  const results = benchmarkFixtures();
  assert.deepEqual(results.map((result) => result.fixture), fixtureNames);
  assert.deepEqual(Object.keys(FIXTURE_COMMANDS).sort(), fixtureNames);
  for (const result of results) {
    assert.ok(result.bytesIn > 0, `${result.fixture} has input bytes`);
    assert.ok(result.bytesOut >= 0, `${result.fixture} has output bytes`);
    assert.ok(Number.isFinite(result.reduction), `${result.fixture} has a reduction`);
    assert.ok(Array.isArray(result.rulesApplied), `${result.fixture} reports rules`);
  }
});

test('benchmark formats README-ready markdown and readable text tables', () => {
  const results = benchmarkFixtures();
  const markdown = formatMarkdown(results);
  assert.match(markdown, /^\| Fixture \| Pipeline reduction \| E2E bytes out \| E2E reduction \| Rules applied \|$/m);
  assert.match(markdown, /^\| --- \| ---: \| ---: \| ---: \| --- \|$/m);
  for (const { fixture } of results) assert.match(markdown, new RegExp(`\\| ${fixture.replace('.', '\\.') } \\|`));
  assert.match(formatText(results), /^Fixture\s+Bytes in\s+Bytes out\s+Reduction\s+Rules applied/m);
});

test('benchmark markdown escapes existing backslashes before table delimiters', () => {
  const markdown = formatMarkdown([{
    fixture: 'a\\|b\nc',
    bytesIn: 1,
    bytesOut: 1,
    reduction: 0,
    rulesApplied: ['rule\\|name'],
  }]);
  const row = markdown.split('\n')[2];
  assert.equal(row.slice(2, row.indexOf(' |', 2)), String.raw`a\\\|b<br>c`);
  assert.match(row, /rule\\\\\\\|name/);
});

test('README savings table is synchronized with the generated benchmark', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const start = readme.indexOf('| Fixture | Pipeline reduction | E2E bytes out | E2E reduction | Rules applied |');
  const end = readme.indexOf('\n\nRe-read stubs', start);
  assert.ok(start >= 0 && end > start, 'README fixture table boundaries exist');
  assert.equal(readme.slice(start, end), formatMarkdown(benchmarkFixtures(), benchmarkEndToEndFixtures()));
});

test('end-to-end benchmark applies production Bash gates', () => {
  const pipeline = benchmarkFixtures();
  const e2e = benchmarkEndToEndFixtures();
  const byFixture = new Map(pipeline.map((result) => [result.fixture, result]));
  assert.equal(e2e.length, pipeline.length);
  // stderr-carried cargo output must still compress through the real hook (WP6).
  assert.ok(e2e.find((result) => result.fixture === 'cargo-build.txt').reduction > 0);
  // A stdout-only fixture should stay broadly comparable after marker overhead.
  const npm = e2e.find((result) => result.fixture === 'npm-install.txt');
  assert.ok(Math.abs(npm.reduction - byFixture.get('npm-install.txt').reduction) < 10);
});

test('dispatch uses command compression when available and generic fallback otherwise', () => {
  assert.equal(dispatchFixture('{"Action":"pass","Test":"one","Package":"example"}', 'go test -json ./...').dispatch, 'command');
  assert.equal(dispatchFixture('repeat 1\nrepeat 2\nrepeat 3', 'unknown command').dispatch, 'generic');
});
