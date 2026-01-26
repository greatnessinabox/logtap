/**
 * LogTap 3.0 - Editor Deep Links
 * Generate clickable links to open files in VS Code, Cursor, WebStorm, etc.
 */

const EDITORS = {
  vscode: {
    name: 'VS Code',
    scheme: 'vscode://file',
    format: (path, line, col) => `vscode://file/${path}${line ? `:${line}` : ''}${col ? `:${col}` : ''}`
  },
  cursor: {
    name: 'Cursor',
    scheme: 'cursor://file',
    format: (path, line, col) => `cursor://file/${path}${line ? `:${line}` : ''}${col ? `:${col}` : ''}`
  },
  webstorm: {
    name: 'WebStorm',
    scheme: 'webstorm://open',
    format: (path, line, col) => `webstorm://open?file=${encodeURIComponent(path)}${line ? `&line=${line}` : ''}${col ? `&column=${col}` : ''}`
  },
  idea: {
    name: 'IntelliJ IDEA',
    scheme: 'idea://open',
    format: (path, line, col) => `idea://open?file=${encodeURIComponent(path)}${line ? `&line=${line}` : ''}${col ? `&column=${col}` : ''}`
  },
  sublime: {
    name: 'Sublime Text',
    scheme: 'subl://open',
    format: (path, line, col) => `subl://open?url=file://${path}${line ? `&line=${line}` : ''}${col ? `&column=${col}` : ''}`
  },
  atom: {
    name: 'Atom',
    scheme: 'atom://core/open/file',
    format: (path, line, col) => `atom://core/open/file?filename=${encodeURIComponent(path)}${line ? `&line=${line}` : ''}${col ? `&column=${col}` : ''}`
  }
};

// Default editor
let currentEditor = 'vscode';

// Workspace root for resolving relative paths
let workspaceRoot = '';

/**
 * Set the preferred editor
 */
export function setEditor(editor) {
  if (EDITORS[editor]) {
    currentEditor = editor;
  }
}

/**
 * Get current editor
 */
export function getEditor() {
  return currentEditor;
}

/**
 * Get all available editors
 */
export function getAvailableEditors() {
  return Object.entries(EDITORS).map(([id, config]) => ({
    id,
    name: config.name
  }));
}

/**
 * Set workspace root for path resolution
 */
export function setWorkspaceRoot(root) {
  workspaceRoot = root;
}

/**
 * Parse a file reference from stack trace or log
 * Returns { file, line, column } or null
 */
export function parseFileReference(text) {
  if (!text) return null;

  // Pattern 1: file.js:123:45 (Chrome/Node style)
  const chromeMatch = text.match(/([^\s(]+\.[jt]sx?):(\d+)(?::(\d+))?/);
  if (chromeMatch) {
    return {
      file: chromeMatch[1],
      line: parseInt(chromeMatch[2], 10),
      column: chromeMatch[3] ? parseInt(chromeMatch[3], 10) : undefined
    };
  }

  // Pattern 2: at functionName (file.js:123:45)
  const atMatch = text.match(/at\s+(?:[\w.<>]+\s+)?\(?([^\s()]+):(\d+):(\d+)\)?/);
  if (atMatch) {
    return {
      file: atMatch[1],
      line: parseInt(atMatch[2], 10),
      column: parseInt(atMatch[3], 10)
    };
  }

  // Pattern 3: file.js line 123
  const lineMatch = text.match(/([^\s]+\.[jt]sx?)\s+line\s+(\d+)/i);
  if (lineMatch) {
    return {
      file: lineMatch[1],
      line: parseInt(lineMatch[2], 10)
    };
  }

  // Pattern 4: [file.js:123]
  const bracketMatch = text.match(/\[([^\]]+\.[jt]sx?):(\d+)\]/);
  if (bracketMatch) {
    return {
      file: bracketMatch[1],
      line: parseInt(bracketMatch[2], 10)
    };
  }

  return null;
}

/**
 * Resolve a file path to an absolute path
 */
function resolveFilePath(file) {
  if (!file) return file;

  // Already absolute
  if (file.startsWith('/') || /^[A-Z]:/i.test(file)) {
    return file;
  }

  // URL-style path
  if (file.startsWith('http://') || file.startsWith('https://')) {
    // Extract path from URL, try to guess local path
    try {
      const url = new URL(file);
      const pathname = url.pathname;

      // Common patterns: /src/..., /app/..., /lib/...
      const srcMatch = pathname.match(/\/(src|app|lib|components|pages|modules)\/.+$/);
      if (srcMatch && workspaceRoot) {
        return workspaceRoot + srcMatch[0];
      }

      // Just use the pathname as-is relative to workspace
      if (workspaceRoot) {
        return workspaceRoot + pathname;
      }

      return pathname;
    } catch {
      return file;
    }
  }

  // Relative path - combine with workspace root
  if (workspaceRoot) {
    return `${workspaceRoot}/${file}`;
  }

  return file;
}

/**
 * Generate an editor deep link URL
 */
export function generateEditorLink(file, line, column, editor = currentEditor) {
  const editorConfig = EDITORS[editor];
  if (!editorConfig) return null;

  const resolvedPath = resolveFilePath(file);
  if (!resolvedPath) return null;

  return editorConfig.format(resolvedPath, line, column);
}

/**
 * Generate a clickable link element (returns HTML string)
 */
export function generateLinkHTML(file, line, column, editor = currentEditor) {
  const url = generateEditorLink(file, line, column, editor);
  if (!url) return null;

  const displayText = line ? `${file}:${line}${column ? ':' + column : ''}` : file;
  const editorName = EDITORS[editor]?.name || editor;

  return `<a href="${url}" class="editor-link" title="Open in ${editorName}" data-file="${file}" data-line="${line || ''}" data-col="${column || ''}">${displayText}</a>`;
}

/**
 * Parse a stack trace and return array of parsed frames
 */
export function parseStackTrace(stack) {
  if (!stack) return [];

  const lines = stack.split('\n');
  const frames = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip "Error: message" line
    if (/^(Error|TypeError|ReferenceError|SyntaxError|RangeError):/.test(trimmed)) {
      continue;
    }

    const ref = parseFileReference(trimmed);
    if (ref) {
      // Extract function name
      const funcMatch = trimmed.match(/at\s+([\w.<>\[\]]+)\s+\(/);
      const funcName = funcMatch ? funcMatch[1] : 'anonymous';

      frames.push({
        function: funcName,
        file: ref.file,
        line: ref.line,
        column: ref.column,
        raw: trimmed
      });
    }
  }

  return frames;
}

/**
 * Generate HTML for a full stack trace with clickable links
 */
export function generateStackHTML(stack, editor = currentEditor) {
  const frames = parseStackTrace(stack);
  if (frames.length === 0) return null;

  const lines = frames.map(frame => {
    const link = generateEditorLink(frame.file, frame.line, frame.column, editor);
    const fileDisplay = frame.line
      ? `${frame.file}:${frame.line}${frame.column ? ':' + frame.column : ''}`
      : frame.file;

    if (link) {
      return `<div class="stack-frame">at ${frame.function} (<a href="${link}" class="editor-link">${fileDisplay}</a>)</div>`;
    }
    return `<div class="stack-frame">${frame.raw}</div>`;
  });

  return `<div class="stack-trace">${lines.join('')}</div>`;
}

/**
 * Try to open a file in the editor
 * Returns true if the link was created (actual opening depends on OS/browser handling)
 */
export function openInEditor(file, line, column, editor = currentEditor) {
  const url = generateEditorLink(file, line, column, editor);
  if (!url) return false;

  // Create and click a temporary link
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  return true;
}

/**
 * Detect workspace root from page URL or common patterns
 */
export function detectWorkspaceRoot() {
  // Try to detect from page URL (common dev server patterns)
  const url = window.location?.href || '';

  // localhost:3000, localhost:8080, etc.
  if (/localhost:\d+/.test(url) || /127\.0\.0\.1:\d+/.test(url)) {
    // Can't reliably determine workspace root from URL alone
    // User should configure this
    return '';
  }

  return '';
}

export { EDITORS };
