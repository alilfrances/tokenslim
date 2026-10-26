import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers.mjs';
import { fileDumpOf, classifyOutput, isPathList, lineCount, sizeBucket } from '../scripts/lib/classify.mjs';
import { guardDenyReason, BASH_DUMP_INSTRUCTION } from '../scripts/lib/guard-reason.mjs';
import { languageFor, outlineText } from '../scripts/lib/outline.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// tests/fixtures/classify/session.jsonl: one session of 24 Bash results (+1 image, +1 Read that must be ignored).
// Not under tests/fixtures/transcripts/, which other tests count.
const classifyDirectory = join(root, 'tests', 'fixtures', 'classify');

function benchmark(args) {
  const iso = isolatedEnv();
  try { return spawnSync(process.execPath, [join(root, 'scripts', 'benchmark.mjs'), ...args], { cwd: root, env: iso.env, encoding: 'utf8' }); } finally { iso.cleanup(); }
}
const classify = (...extra) => {
  const run = benchmark(['--transcripts', classifyDirectory, '--classify', '--format', 'json', ...extra]);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

test('fileDumpOf accepts every whole-file dump form and nothing else', () => {
  const dumps = {
    'cat src/a.js': 'cat', 'cat -n src/a.js': 'cat', 'cd work && cat src/a.js': 'cat', 'cd work; cat src/a.js': 'cat', 'cat "my file.js"': 'cat',
    'nl src/a.js': 'nl', 'nl -ba src/a.js': 'nl', 'nl -w 3 -s: src/a.js': 'nl',
    "sed -n '1,$p' src/a.js": 'sed', 'sed -n "1,\\$p" src/a.js': 'sed',
    'head -n 400 src/a.js': 'head', 'head -n 2000 src/a.js': 'head', 'head -n500 src/a.js': 'head', 'head -500 src/a.js': 'head', 'head --lines=500 src/a.js': 'head',
    'tail -n +1 src/a.js': 'tail', 'tail -n+1 src/a.js': 'tail',
  };
  for (const [command, form] of Object.entries(dumps)) assert.equal(fileDumpOf(command)?.form, form, command);
  assert.equal(fileDumpOf('cat src/a.js').file, 'src/a.js');
  assert.equal(fileDumpOf('cat "my file.js"').file, 'my file.js');
  const notDumps = [
    'cat src/a.js | grep x', 'cat src/a.js | head -n 500', 'cat a b', 'cat > f <<EOF', "cat <<'EOF'\nbody\nEOF", 'cat src/a.js > copy.js', 'cat < src/a.js', 'cat src/a.js 2>&1',
    'cat src/*.js', 'cat $FILE', 'cat', 'cat -', 'echo x | cat src/a.js', 'ls && cat src/a.js', 'cd a && cd b && cat src/a.js', 'cat src/a.js && echo done',
    'head -n 20 src/a.js', 'head -n 399 src/a.js', 'head -20 src/a.js', 'head -n -5 src/a.js', 'head src/a.js', 'head -n 500 a b',
    "sed -n '10,20p' src/a.js", "sed -n '1,100p' src/a.js", "sed 's/a/b/' src/a.js", "sed '1,$p' src/a.js",
    'tail -n 5 src/a.js', 'tail -n +10 src/a.js', 'tail -f src/a.js', 'nl a b', 'grep -n x src/a.js', '', 'cat "unterminated',
  ];
  for (const command of notDumps) assert.equal(fileDumpOf(command), null, JSON.stringify(command));
  assert.equal(fileDumpOf(undefined), null);
});

test('classifyOutput applies the buckets in order and the size sub-buckets break at 400/401 and 2000/2001', () => {
  const grep = Array.from({ length: 10 }, (_, i) => `src/a.js:${i + 1}:x`).join('\n');
  assert.equal(classifyOutput(grep, 'rg -n x').bucket, 'grep');
  assert.equal(classifyOutput(grep, 'cat src/a.js').bucket, 'fileDump', 'fileDump wins over the output-shape buckets');
  assert.equal(classifyOutput(Array.from({ length: 10 }, (_, i) => `./src/f${i}.js`).join('\n'), 'find .').bucket, 'pathList');
  assert.equal(classifyOutput('{"a":1}', 'x').bucket, 'json');
  assert.equal(classifyOutput('[1,2', 'x').bucket, 'other');
  assert.equal(classifyOutput('', 'x').bucket, 'other');
  // path-list rule: >= 8 non-empty lines, >= 80% path-like (no whitespace, a letter, `/` or a .ext, not a URL)
  const eight = (line) => Array.from({ length: 8 }, (_, i) => line(i)).join('\n');
  assert.equal(isPathList(eight((i) => `dir/file${i}`)), true);
  assert.equal(isPathList(eight((i) => `file${i}.txt`)), true);
  assert.equal(isPathList(eight((i) => `https://example.com/${i}`)), false);
  assert.equal(isPathList(eight((i) => `two words${i}.txt`)), false);
  assert.equal(isPathList(eight((i) => `${i}.5`)), false);
  assert.equal(isPathList(Array.from({ length: 7 }, (_, i) => `a/b${i}`).join('\n')), false, 'fewer than 8 lines');
  assert.equal(isPathList(`${Array.from({ length: 8 }, (_, i) => `a/b${i}`).join('\n')}\nsome prose line\n`), true, '8 of 9 lines is >= 80%');
  assert.equal(isPathList(`${Array.from({ length: 8 }, (_, i) => `a/b${i}`).join('\n')}\nprose one\nprose two\nprose three`), false, '8 of 11 is under 80%');
  assert.deepEqual([400, 401, 2000, 2001].map(sizeBucket), ['<=400', '401-2000', '401-2000', '>2000']);
  assert.deepEqual([lineCount(''), lineCount('a'), lineCount('a\n'), lineCount('a\nb')], [0, 1, 1, 2]);
});

test('--classify buckets the fixture session exactly: counts, chars and cost-weighted chars', () => {
  const report = classify();
  assert.equal(report.files, 1);
  assert.equal(report.results, 24, 'every non-image Bash result; the Read result is not Bash');
  assert.equal(report.imagesSkipped, 1);
  assert.equal(report.apiCalls, 27);
  assert.equal(report.chars, 143562);
  const by = Object.fromEntries(report.buckets.map((b) => [b.bucket, b]));
  assert.deepEqual(report.buckets.map((b) => b.bucket), ['fileDump', 'grep', 'pathList', 'testRunner', 'json', 'other', 'persisted']);
  const expected = {
    fileDump: [10, 116101, 2652916, 0], grep: [1, 482, 4338, 0], pathList: [1, 229, 1832, 0], testRunner: [2, 4145, 18555, 1],
    json: [1, 847, 5082, 0], other: [8, 21654, 260351, 0], persisted: [1, 104, 312, 0],
  };
  for (const [bucket, [count, chars, weightedChars, compressed]] of Object.entries(expected)) {
    assert.deepEqual([by[bucket].count, by[bucket].chars, by[bucket].weightedChars, by[bucket].compressed], [count, chars, weightedChars, compressed], bucket);
    assert.ok(Math.abs(by[bucket].pctChars - (chars / 143562) * 100) < 1e-9, `${bucket} % chars`);
    assert.ok(Math.abs(by[bucket].pctWeighted - (weightedChars / 2943386) * 100) < 1e-9, `${bucket} % weighted`);
  }
  assert.equal(report.buckets.reduce((sum, b) => sum + b.count, 0), report.results, 'buckets are exclusive and exhaustive');
  assert.equal(report.buckets.reduce((sum, b) => sum + b.chars, 0), report.chars);
  assert.equal(report.weightedChars, 2943386);

  // Independent recomputation of the cost weighting straight from the transcript: chars x assistant API calls after it.
  const lines = readFileSync(join(classifyDirectory, 'session.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  let weighted = 0;
  lines.forEach((line, index) => {
    const result = line.message?.content?.[0];
    if (result?.type !== 'tool_result' || result.tool_use_id === 'tread' || typeof result.content !== 'string') return;
    weighted += result.content.length * lines.slice(index + 1).filter((later) => later.type === 'assistant').length;
  });
  assert.equal(weighted, report.weightedChars);
});

test('fileDump: every form is detected, look-alikes are not, sub-buckets break at 400/401 and 2000/2001', () => {
  const { fileDump } = classify();
  assert.deepEqual(fileDump.byForm.map((f) => [f.form, f.count]), [['cat', 4], ['head', 2], ['nl', 1], ['sed', 2], ['tail', 1]]);
  assert.equal(fileDump.byForm.reduce((sum, f) => sum + f.count, 0), 10, 'pipe, two operands, both heredocs, head -n 20 and sed ranges are not dumps');
  assert.deepEqual(fileDump.bySize.map((s) => [s.lines, s.count, s.chars]), [['<=400', 2, 10496], ['401-2000', 7, 68211], ['>2000', 1, 37394]]);
  // 400 lines (nl) and 30 lines (small cat) sit at or below 400; 401 lines and exactly 2000 are in the middle; 2001 is above 2000.
  assert.deepEqual(fileDump.overThreshold && [fileDump.threshold, fileDump.overThreshold.count, fileDump.overThreshold.chars], [400, 8, 105605]);
});

test('outline-first upper bound is output chars minus the guard deny reason, over allowlisted dumps above the threshold', () => {
  const { fileDump } = classify();
  const bound = fileDump.outlineUpperBound;
  assert.deepEqual([bound.dumps, bound.outlineChars, bound.savedChars], [7, 6658, 95008]);
  assert.deepEqual([bound.notTextFile, bound.notTextChars], [1, 3939], 'the .dat dump is over the threshold but not a file the guard may withhold');
  // saved = dump chars over the threshold (105,605) - the non-allowlisted dump (3,939) - the deny reasons (6,658)
  assert.equal(fileDump.overThreshold.chars - bound.notTextChars - bound.outlineChars, bound.savedChars);
  assert.ok(Math.abs(bound.pctOfBashChars - (95008 / 143562) * 100) < 1e-9);

  // Recompute straight from the transcript with the guard's own reason builder.
  const lines = readFileSync(join(classifyDirectory, 'session.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const outputs = new Map();
  const commands = new Map();
  for (const line of lines) for (const block of line.message?.content ?? []) {
    if (block.type === 'tool_use') commands.set(block.id, block.input.command);
    if (block.type === 'tool_result' && typeof block.content === 'string') outputs.set(commands.get(block.tool_use_id), block.content);
  }
  const eligible = [
    ['cat src/zephyr-cat.js', 'src/zephyr-cat.js', 'cat'], ["sed -n '1,$p' src/zephyr-sed.js", 'src/zephyr-sed.js', 'sed'],
    ['sed -n "1,\\$p" src/zephyr-sed2.js', 'src/zephyr-sed2.js', 'sed'], ['head -n 500 docs/zephyr-head.md', 'docs/zephyr-head.md', 'head'],
    ['head -500 docs/zephyr-head2.md', 'docs/zephyr-head2.md', 'head'], ['tail -n +1 docs/zephyr-tail.md', 'docs/zephyr-tail.md', 'tail'],
    ['cd work && cat src/zephyr-cd.py', 'src/zephyr-cd.py', 'cat'],
  ];
  let saved = 0; let reasons = 0;
  for (const [command, file] of eligible) {
    const text = outputs.get(command);
    const outline = outlineText(text, languageFor(file));
    assert.ok(outline && outline.entries.length > 0, `${file} has an outline`);
    const reason = guardDenyReason({ filePath: file, size: Buffer.byteLength(text), lineInfo: { lines: lineCount(text), capped: false }, outline, subject: 'output', instruction: BASH_DUMP_INSTRUCTION });
    assert.ok(reason.includes('Outline:') && reason.endsWith(BASH_DUMP_INSTRUCTION));
    saved += text.length - reason.length; reasons += reason.length;
  }
  assert.deepEqual([saved, reasons], [bound.savedChars, bound.outlineChars]);
  // The nl dump is below the threshold, so it is not in the bound; its gutter would be stripped before outlining.
  assert.ok(outputs.get('nl -ba src/zephyr-nl.js').startsWith('     1\t'));
});

test('go/no-go line flips with --classify-lines', () => {
  const go = benchmark(['--transcripts', classifyDirectory, '--classify']);
  assert.equal(go.status, 0, go.stderr);
  assert.match(go.stdout, /^WP4 go\/no-go: fileDump over 400 lines = 73\.6% of Bash chars \(threshold 8%\) → GO$/m);
  assert.match(go.stdout, /^outline-first savings, upper bound \(assumes no follow-up read\): 95,008 chars = 66\.2% of all Bash chars/m);
  const none = benchmark(['--transcripts', classifyDirectory, '--classify', '--classify-lines', '2000']);
  assert.match(none.stdout, /^WP4 go\/no-go: fileDump over 2000 lines = 26\.0% of Bash chars \(threshold 8%\) → GO$/m, 'only the 2001-line dump is over 2000');
  const flipped = benchmark(['--transcripts', classifyDirectory, '--classify', '--classify-lines=2001']);
  assert.match(flipped.stdout, /^WP4 go\/no-go: fileDump over 2001 lines = 0\.0% of Bash chars \(threshold 8%\) → NO-GO$/m);
  assert.match(flipped.stdout, /upper bound \(assumes no follow-up read\): 0 chars = 0\.0% of all Bash chars/);
  const json = classify('--classify-lines', '2001');
  assert.deepEqual(json.goNoGo, { lines: 2001, pct: 0, thresholdPct: 8, go: false });
  assert.equal(json.fileDump.outlineUpperBound.savedChars, 0);
  const everything = classify('--classify-lines', '0');
  assert.equal(everything.fileDump.overThreshold.count, 10, 'a threshold of 0 lines counts every dump');
});

test('--classify output carries no command text and no paths, in text or json', () => {
  const sentinels = [/zephyr/, /src\//, /docs\//, /assets\//, /work/, /\.js\b/, /\.py\b/, /\.md\b/, /\.dat\b/, /EOF/, /heredoc/, /grep fn/, /sed -n/, /head -n/, /tail -n/, /\/tmp/, /\/home/];
  for (const args of [['--classify'], ['--classify', '--format', 'json'], ['--classify', '--classify-lines', '10']]) {
    const run = benchmark(['--transcripts', classifyDirectory, ...args]);
    assert.equal(run.status, 0, run.stderr);
    for (const pattern of sentinels) {
      // The only path-like text allowed is the transcripts directory the caller passed in the json report.
      const out = run.stdout.split(classifyDirectory).join('');
      assert.doesNotMatch(out, pattern, `${args.join(' ')} leaked ${pattern}`);
    }
  }
  const text = benchmark(['--transcripts', classifyDirectory, '--classify']).stdout;
  assert.ok(!text.includes(classifyDirectory), 'the text report does not echo the transcripts path');
});

test('--classify argument validation', () => {
  for (const args of [
    ['--classify'], ['--classify-lines', '5'], ['--transcripts', classifyDirectory, '--classify-lines', '5'],
    ['--transcripts', classifyDirectory, '--classify', '--classify-lines', 'x'], ['--transcripts', classifyDirectory, '--classify', '--classify-lines', '-1'],
    ['--transcripts', classifyDirectory, '--classify', '--classify'], ['--transcripts', classifyDirectory, '--classify', '--format', 'md'],
    ['--transcripts', classifyDirectory, '--classify', '--audit'], ['--transcripts', classifyDirectory, '--classify=1'],
  ]) assert.equal(benchmark(args).status, 2, args.join(' '));
  assert.equal(benchmark(['--transcripts', join(classifyDirectory, 'missing'), '--classify', '--format', 'json']).status, 0, 'a missing directory reports zeros');
  const empty = JSON.parse(benchmark(['--transcripts', join(classifyDirectory, 'missing'), '--classify', '--format', 'json']).stdout);
  assert.deepEqual([empty.results, empty.chars, empty.goNoGo.pct, empty.goNoGo.go], [0, 0, 0, false]);
});
