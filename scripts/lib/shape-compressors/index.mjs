import * as grep from './grep.mjs';

// Shape compressors recognize output by its text alone, never by the command that produced it, so pipes,
// `&&` chains and redirects do not matter. Each returns { text, rulesApplied, lossless } or null.
const COMPRESSORS = [grep];

export function compressShapeOutput(text) {
  for (const compressor of COMPRESSORS) {
    const compressed = compressor.compress(text);
    if (compressed) return compressed;
  }
  return null;
}
