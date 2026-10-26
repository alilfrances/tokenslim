// Shared transcript helpers (WP1 extends this module).
// A compressed result ends with our marker on its own line (or a tee `full:` marker). Matching only the final line keeps
// tool output that merely quotes "[tokenslim:" mid-text (e.g. reading this repo's source) counted as uncompressed.
export const FINAL_MARKER_RE = /(?:^|\n)\[tokenslim: [^\]\n]*\]\s*$/;
