import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINAL_MARKER_RE } from '../scripts/lib/transcripts.mjs';

test('FINAL_MARKER_RE matches only a marker on the final line', () => {
  for (const text of [
    'out\n[tokenslim: collapseRepeatedLines]',
    'out\n[tokenslim: 5 more similar lines collapsed]\n',
    'out\n[tokenslim: full: /home/u/.cache/tokenslim/tee/s/t.txt]\n  \n',
    '[tokenslim: only]',
  ]) assert.ok(FINAL_MARKER_RE.test(text), text);
  for (const text of [
    'plain output',
    'const m = "[tokenslim: x]";\nmore after',
    '[tokenslim: first]\nbody continues',
    'ends with prose [tokenslim: inline] and more',
    'line ends with a quoted [tokenslim: inline]',
    'out\n[tokenslim: full: /p]\nthen trailing text',
  ]) assert.ok(!FINAL_MARKER_RE.test(text), text);
});
