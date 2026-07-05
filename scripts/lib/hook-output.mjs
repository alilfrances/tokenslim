// Runtime-specific PostToolUse output helpers.
//
// Claude Code supports structured updatedToolOutput replacement. Current Codex
// PostToolUse supports replacing the model-visible result with stop text via
// continue:false, so Codex receives a compact textual rendering instead.

function isObject(value) {
  return value !== null && typeof value === 'object';
}

export function detectRuntime(payload, env = process.env) {
  const override = String(env.TOKENSLIM_HOOK_RUNTIME || '').trim().toLowerCase();
  if (override === 'codex' || override === 'claude') return override;

  if (env.PLUGIN_ROOT || env.PLUGIN_DATA || env.CODEX_PLUGIN_ROOT) return 'codex';
  if (
    isObject(payload) &&
    ('turn_id' in payload || 'permission_mode' in payload || 'transcript_path' in payload || 'model' in payload)
  ) {
    return 'codex';
  }
  return 'claude';
}

function stringifyFallback(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

export function codexReplacementText(toolName, updatedToolOutput) {
  const name = String(toolName || 'tool');
  const label = `[tokenslim: compressed ${name} output]`;

  if (typeof updatedToolOutput === 'string') return `${label}\n${updatedToolOutput}`;

  if (Array.isArray(updatedToolOutput)) {
    const textBlock = updatedToolOutput.find(
      (block) => isObject(block) && block.type === 'text' && typeof block.text === 'string'
    );
    if (textBlock) return `${label}\n${textBlock.text}`;
    return `${label}\n${stringifyFallback(updatedToolOutput)}`;
  }

  if (isObject(updatedToolOutput)) {
    if (typeof updatedToolOutput.stdout === 'string' || typeof updatedToolOutput.stderr === 'string') {
      const parts = [label];
      if (updatedToolOutput.stdout) parts.push(`stdout:\n${updatedToolOutput.stdout}`);
      if (updatedToolOutput.stderr) parts.push(`stderr:\n${updatedToolOutput.stderr}`);
      if (updatedToolOutput.interrupted || updatedToolOutput.isImage) {
        parts.push(`metadata: interrupted=${Boolean(updatedToolOutput.interrupted)} isImage=${Boolean(updatedToolOutput.isImage)}`);
      }
      return parts.join('\n');
    }

    if (isObject(updatedToolOutput.file) && typeof updatedToolOutput.file.content === 'string') {
      const path = updatedToolOutput.file.filePath ? `\nfile: ${updatedToolOutput.file.filePath}` : '';
      return `${label}${path}\n${updatedToolOutput.file.content}`;
    }

    if (updatedToolOutput.mode === 'content' && typeof updatedToolOutput.content === 'string') {
      return `${label}\n${updatedToolOutput.content}`;
    }

    if (Array.isArray(updatedToolOutput.filenames)) {
      return `${label}\n${updatedToolOutput.filenames.join('\n')}`;
    }

    for (const key of ['content', 'output', 'text']) {
      if (typeof updatedToolOutput[key] === 'string') return `${label}\n${updatedToolOutput[key]}`;
    }
  }

  return `${label}\n${stringifyFallback(updatedToolOutput)}`;
}

export function postToolUseOutput(payload, updatedToolOutput) {
  const runtime = detectRuntime(payload);
  if (runtime === 'codex') {
    return {
      continue: false,
      stopReason: codexReplacementText(payload?.tool_name, updatedToolOutput),
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput,
    },
  };
}
