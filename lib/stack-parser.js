/**
 * LogTap 3.0 - Stack Parser
 * Multi-browser stack trace parsing with minification detection
 */

const STACK_PATTERNS = [
  // Chrome/V8: "    at functionName (file.js:10:20)"
  { regex: /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/, fn: 1, file: 2, line: 3, col: 4 },
  // Chrome/V8 anonymous: "    at file.js:10:20"
  { regex: /^\s*at\s+(.+?):(\d+):(\d+)$/, file: 1, line: 2, col: 3 },
  // Chrome/V8 eval
  { regex: /^\s*at\s+eval\s+\(eval\s+at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/, fn: 1, file: 2, line: 3, col: 4 },
  // Firefox: "functionName@file.js:10:20"
  { regex: /^(.*)@(.+?):(\d+):(\d+)$/, fn: 1, file: 2, line: 3, col: 4 },
  // Safari: "functionName@file.js:10"
  { regex: /^(.*)@(.+?):(\d+)$/, fn: 1, file: 2, line: 3 }
];

const SKIP_PATTERNS = [
  /logtap/i,
  /chrome-extension:\/\//,
  /moz-extension:\/\//,
  /extensions\//i,
  /<anonymous>/,
  /^\[native code\]$/
];

const MINIFIED_PATTERNS = [
  /\.min\.js/,
  /\.bundle\.js/,
  /\/dist\//,
  /\/build\//,
  /webpack:\/\//,
  /\/node_modules\//
];

/**
 * Parse a single stack frame line
 */
export function parseStackFrame(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;

  for (const p of STACK_PATTERNS) {
    const match = trimmed.match(p.regex);
    if (match) {
      const file = p.file ? match[p.file] : '';
      return {
        raw: trimmed,
        function: p.fn ? (match[p.fn] || '').trim() : '',
        file,
        line: p.line ? parseInt(match[p.line], 10) : null,
        column: p.col ? parseInt(match[p.col], 10) : null,
        isMinified: MINIFIED_PATTERNS.some(pat => pat.test(file)),
        parsed: true
      };
    }
  }

  return { raw: trimmed, parsed: false };
}

/**
 * Check if frame should be skipped
 */
export function shouldSkipFrame(frame) {
  if (!frame?.raw) return true;
  return SKIP_PATTERNS.some(p => p.test(frame.raw) || (frame.file && p.test(frame.file)));
}

/**
 * Extract short filename from full path
 */
export function extractShortFile(file) {
  if (!file) return '';
  try {
    const url = new URL(file);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || file;
  } catch {
    const parts = file.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || file;
  }
}

/**
 * Get caller info from current stack
 */
export function getCaller(skipFrames = 3) {
  try {
    const lines = (new Error().stack || '').split('\n').slice(skipFrames);

    for (const line of lines) {
      const frame = parseStackFrame(line);
      if (!frame?.parsed || shouldSkipFrame(frame)) continue;

      return {
        file: extractShortFile(frame.file),
        fullPath: frame.file,
        line: frame.line ? String(frame.line) : '',
        column: frame.column ? String(frame.column) : '',
        function: frame.function,
        isMinified: frame.isMinified
      };
    }
  } catch {}

  return { file: '', fullPath: '', line: '', column: '', function: '', isMinified: false };
}

/**
 * Parse entire stack trace
 */
export function parseStack(stackOrError) {
  const stack = stackOrError instanceof Error ? stackOrError.stack : String(stackOrError);
  if (!stack) return [];

  return stack.split('\n')
    .map(parseStackFrame)
    .filter(f => f?.parsed)
    .map(f => ({ ...f, shortFile: extractShortFile(f.file) }));
}

/**
 * Format parsed stack for display
 */
export function formatStack(frames, opts = {}) {
  const { maxFrames = 10, showColumn = false, showMinified = true } = opts;

  return frames
    .slice(0, maxFrames)
    .map(f => {
      const fn = f.function ? `${f.function} ` : '';
      const loc = f.shortFile || f.file || 'unknown';
      const line = f.line ? `:${f.line}` : '';
      const col = showColumn && f.column ? `:${f.column}` : '';
      const minified = showMinified && f.isMinified ? ' [minified]' : '';
      return `  at ${fn}(${loc}${line}${col})${minified}`;
    })
    .join('\n');
}
