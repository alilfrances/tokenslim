import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const DEFAULT_READ_LINE_LIMIT = 2000;

export function locateText(toolResponse) {
  if (typeof toolResponse === 'string') {
    return { get: () => toolResponse, set: (t) => t };
  }
  if (Array.isArray(toolResponse)) {
    const textBlocks = toolResponse
      .map((block, i) => ({ block, i }))
      .filter(({ block }) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string');
    if (textBlocks.length !== 1) return null;
    const { i } = textBlocks[0];
    return {
      get: () => toolResponse[i].text,
      set: (t) => {
        const copy = toolResponse.slice();
        copy[i] = { ...toolResponse[i], text: t };
        return copy;
      },
    };
  }
  if (toolResponse && typeof toolResponse === 'object') {
    if (toolResponse.file && typeof toolResponse.file === 'object' && typeof toolResponse.file.content === 'string') {
      return {
        get: () => toolResponse.file.content,
        set: (t) => ({
          ...toolResponse,
          file: { ...toolResponse.file, content: t, numLines: t.split('\n').length },
        }),
      };
    }
    if (typeof toolResponse.content === 'string') {
      return { get: () => toolResponse.content, set: (t) => ({ ...toolResponse, content: t }) };
    }
    if (typeof toolResponse.output === 'string') {
      return { get: () => toolResponse.output, set: (t) => ({ ...toolResponse, output: t }) };
    }
    if (typeof toolResponse.text === 'string') {
      return { get: () => toolResponse.text, set: (t) => ({ ...toolResponse, text: t }) };
    }
  }
  return null;
}

// Image and PDF results are binary payloads, not text tokens: they never count toward attempted bytes.
export function isMediaResponse(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return false;
  if (Array.isArray(toolResponse)) return toolResponse.some((block) => isMediaResponse(block));
  const kind = String(toolResponse.type || '');
  if (toolResponse.isImage === true || kind === 'image' || kind === 'pdf') return true;
  const file = toolResponse.file;
  if (file && typeof file === 'object') {
    const mime = String(file.type || file.mediaType || file.media_type || '');
    if (/^image\//.test(mime) || mime === 'application/pdf' || typeof file.base64 === 'string') return true;
  }
  return false;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Read's file.content is the raw file text (docs/SHAPES.md) — hash parity with
// compress-read requires hashing the raw on-disk content, no line-number formatting.
export function readFileRaw(filePath) {
  return readFileSync(filePath, 'utf8');
}

export function hasBoundedRead(toolInput) {
  return Boolean(toolInput && (toolInput.offset != null || toolInput.limit != null));
}
