/**
 * LogTap 3.0 - Injected Console Interceptor
 * Runs in page context to capture console output with proper snapshots
 */
(function() {
  'use strict';

  // Prevent double injection
  if (window.__LOGTAP_INJECTED__) return;
  window.__LOGTAP_INJECTED__ = true;

  let capturing = true;
  const originals = new Map();
  let isProcessing = false;
  let logId = 0;

  // ============ Snapshot Engine (inline) ============
  const TYPE_MARKERS = {
    DATE: '__$date',
    REGEXP: '__$regexp',
    ERROR: '__$error',
    MAP: '__$map',
    SET: '__$set',
    SYMBOL: '__$symbol',
    FUNCTION: '__$function',
    UNDEFINED: '__$undefined',
    BIGINT: '__$bigint',
    CIRCULAR: '__$circular',
    MAX_DEPTH: '__$maxDepth',
    DOM_ELEMENT: '__$element',
    TYPED_ARRAY: '__$typedArray'
  };

  const CONFIG = {
    maxDepth: 10,
    maxStringLength: 5000,
    maxArrayLength: 500,
    maxObjectKeys: 50,
    maxTotalSize: 512 * 1024
  };

  function isPlainObject(obj) {
    if (typeof obj !== 'object' || obj === null) return false;
    const proto = Object.getPrototypeOf(obj);
    return proto === null || proto === Object.prototype;
  }

  function isDOMElement(val) {
    return typeof Element !== 'undefined' && val instanceof Element;
  }

  function isTypedArray(val) {
    return ArrayBuffer.isView(val) && !(val instanceof DataView);
  }

  function deepSnapshot(value, maxDepth = CONFIG.maxDepth, seen = new WeakMap(), path = 'root') {
    // Primitives
    if (value === null) return null;
    if (value === undefined) return { [TYPE_MARKERS.UNDEFINED]: true };

    if (typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        return { [TYPE_MARKERS.UNDEFINED]: Number.isNaN(value) ? 'NaN' : (value > 0 ? 'Infinity' : '-Infinity') };
      }
      return value;
    }

    if (typeof value === 'bigint') return { [TYPE_MARKERS.BIGINT]: value.toString() };
    if (typeof value === 'symbol') return { [TYPE_MARKERS.SYMBOL]: value.toString() };

    if (typeof value === 'string') {
      return value.length > CONFIG.maxStringLength
        ? value.slice(0, CONFIG.maxStringLength) + `... [${value.length - CONFIG.maxStringLength} more]`
        : value;
    }

    if (typeof value === 'function') {
      return { [TYPE_MARKERS.FUNCTION]: value.name || 'anonymous' };
    }

    // Depth limit
    if (maxDepth <= 0) return { [TYPE_MARKERS.MAX_DEPTH]: true };

    // DOM Elements
    if (isDOMElement(value)) {
      return {
        [TYPE_MARKERS.DOM_ELEMENT]: value.tagName.toLowerCase(),
        id: value.id || undefined,
        className: value.className || undefined
      };
    }

    // Circular reference check
    if (typeof value === 'object' && seen.has(value)) {
      return { [TYPE_MARKERS.CIRCULAR]: seen.get(value) };
    }
    if (typeof value === 'object') {
      seen.set(value, path);
    }

    // Special types
    if (value instanceof Date) {
      return { [TYPE_MARKERS.DATE]: value.toISOString() };
    }

    if (value instanceof RegExp) {
      return { [TYPE_MARKERS.REGEXP]: value.toString() };
    }

    if (value instanceof Error) {
      return {
        [TYPE_MARKERS.ERROR]: value.name,
        message: value.message,
        stack: value.stack
      };
    }

    if (value instanceof Map) {
      const entries = [];
      let i = 0;
      for (const [k, v] of value) {
        if (i >= CONFIG.maxArrayLength) break;
        entries.push([
          deepSnapshot(k, maxDepth - 1, seen, `${path}.key${i}`),
          deepSnapshot(v, maxDepth - 1, seen, `${path}.val${i}`)
        ]);
        i++;
      }
      return { [TYPE_MARKERS.MAP]: entries, size: value.size };
    }

    if (value instanceof Set) {
      const values = [];
      let i = 0;
      for (const v of value) {
        if (i >= CONFIG.maxArrayLength) break;
        values.push(deepSnapshot(v, maxDepth - 1, seen, `${path}[${i}]`));
        i++;
      }
      return { [TYPE_MARKERS.SET]: values, size: value.size };
    }

    if (isTypedArray(value)) {
      return {
        [TYPE_MARKERS.TYPED_ARRAY]: value.constructor.name,
        data: Array.from(value.slice(0, CONFIG.maxArrayLength)),
        length: value.length
      };
    }

    // Arrays
    if (Array.isArray(value)) {
      const arr = [];
      const len = Math.min(value.length, CONFIG.maxArrayLength);
      for (let i = 0; i < len; i++) {
        arr.push(deepSnapshot(value[i], maxDepth - 1, seen, `${path}[${i}]`));
      }
      if (value.length > len) {
        arr.push(`... ${value.length - len} more items`);
      }
      return arr;
    }

    // Objects
    if (typeof value === 'object') {
      const obj = {};
      const keys = Object.keys(value);
      const len = Math.min(keys.length, CONFIG.maxObjectKeys);

      for (let i = 0; i < len; i++) {
        const key = keys[i];
        try {
          obj[key] = deepSnapshot(value[key], maxDepth - 1, seen, `${path}.${key}`);
        } catch {
          obj[key] = '[Error accessing property]';
        }
      }

      if (keys.length > len) {
        obj['...'] = `${keys.length - len} more properties`;
      }

      if (!isPlainObject(value) && value.constructor?.name) {
        obj.__$type = value.constructor.name;
      }

      return obj;
    }

    return String(value);
  }

  function serializeArgs(args) {
    if (!args || args.length === 0) return { message: '', snapshot: null, raw: '' };

    const snapshots = args.map(arg => {
      try {
        return deepSnapshot(arg);
      } catch {
        return '[Snapshot Error]';
      }
    });

    const messageParts = args.map((arg, i) => {
      if (arg === null) return 'null';
      if (arg === undefined) return 'undefined';
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
      if (arg instanceof Error) return arg.message || String(arg);
      if (isDOMElement(arg)) return `<${arg.tagName.toLowerCase()}>`;
      try {
        const str = JSON.stringify(snapshots[i]);
        return str.length > 200 ? JSON.stringify(snapshots[i], null, 2) : str;
      } catch {
        return Object.prototype.toString.call(arg);
      }
    });

    // Keep raw format for filtering
    const rawParts = args.map(arg => {
      try {
        if (typeof arg === 'string') return arg;
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    });

    return {
      message: messageParts.join(' '),
      snapshot: snapshots.length === 1 ? snapshots[0] : snapshots,
      raw: rawParts.join(' ')
    };
  }

  // ============ Stack Parser (inline) ============
  const STACK_PATTERNS = [
    { regex: /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/, fn: 1, file: 2, line: 3, col: 4 },
    { regex: /^\s*at\s+(.+?):(\d+):(\d+)$/, file: 1, line: 2, col: 3 },
    { regex: /^\s*at\s+eval\s+\(eval\s+at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/, fn: 1, file: 2, line: 3, col: 4 },
    { regex: /^(.*)@(.+?):(\d+):(\d+)$/, fn: 1, file: 2, line: 3, col: 4 },
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

  const MINIFIED_PATTERNS = [/\.min\.js/, /\.bundle\.js/, /\/dist\//, /\/build\//, /webpack:\/\//, /node_modules/];

  function getCaller(skipFrames = 4) {
    try {
      const lines = (new Error().stack || '').split('\n').slice(skipFrames);

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check if should skip
        let shouldSkip = false;
        for (const pattern of SKIP_PATTERNS) {
          if (pattern.test(trimmed)) { shouldSkip = true; break; }
        }
        if (shouldSkip) continue;

        // Try each pattern
        for (const p of STACK_PATTERNS) {
          const match = trimmed.match(p.regex);
          if (match) {
            const file = p.file ? match[p.file] : '';

            // Extract short filename
            let shortFile = file;
            try {
              const url = new URL(file);
              const parts = url.pathname.split('/').filter(Boolean);
              shortFile = parts[parts.length - 1] || file;
            } catch {
              const parts = file.split(/[/\\]/).filter(Boolean);
              shortFile = parts[parts.length - 1] || file;
            }

            let isMinified = false;
            for (const mp of MINIFIED_PATTERNS) {
              if (mp.test(file)) { isMinified = true; break; }
            }

            return {
              file: shortFile,
              fullPath: file,
              line: p.line ? match[p.line] : '',
              column: p.col ? match[p.col] : '',
              function: p.fn ? (match[p.fn] || '').trim() : '',
              isMinified
            };
          }
        }
      }
    } catch {}

    return { file: '', fullPath: '', line: '', column: '', function: '', isMinified: false };
  }

  // ============ Tag & Level Detection (inline) ============
  function detectTag(args) {
    if (!args || args.length === 0) return '';

    const firstArg = args[0];

    // Structured object fields
    if (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)) {
      if (firstArg.event) return String(firstArg.event).replace(/_/g, '-').toLowerCase();
      if (firstArg.action) return String(firstArg.action).toLowerCase();
      if (firstArg.tag) return String(firstArg.tag);
      if (firstArg.type && typeof firstArg.type === 'string') return String(firstArg.type).toLowerCase();
      if (firstArg.category) return String(firstArg.category).toLowerCase();
      if (firstArg.component) return String(firstArg.component).toLowerCase();
      if (firstArg.module) return String(firstArg.module).toLowerCase();
    }

    // Try JSON string
    const firstStr = String(firstArg || '');
    if (firstStr.startsWith('{')) {
      try {
        const parsed = JSON.parse(firstStr);
        if (parsed && typeof parsed === 'object') {
          if (parsed.event) return String(parsed.event).replace(/_/g, '-').toLowerCase();
          if (parsed.action) return String(parsed.action).toLowerCase();
          if (parsed.tag) return String(parsed.tag);
          if (parsed.type) return String(parsed.type).toLowerCase();
        }
      } catch {}
    }

    // Bracket prefix [Tag]
    const bracketMatch = firstStr.match(/^\[([^\]]+)\]\s*/);
    if (bracketMatch) return bracketMatch[1];

    // Colon prefix Tag:
    const colonMatch = firstStr.match(/^([A-Za-z][\w-]{1,20}):\s/);
    if (colonMatch) return colonMatch[1];

    // Arrow prefix Tag →
    const arrowMatch = firstStr.match(/^([A-Za-z][\w-]{1,20})\s*[→>]\s/);
    if (arrowMatch) return arrowMatch[1];

    return '';
  }

  function detectLevel(method, message, tag, args) {
    // Method-based (highest priority)
    if (method === 'error') return 'error';
    if (method === 'warn') return 'warn';
    if (method === 'debug') return 'debug';

    const firstArg = args && args[0];

    // Structured level field
    if (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)) {
      if (firstArg.level !== undefined) {
        const levelNum = Number(firstArg.level);
        if (!isNaN(levelNum)) {
          // Pino-style: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal
          if (levelNum >= 50) return 'error';
          if (levelNum >= 40) return 'warn';
          if (levelNum >= 30) return 'info';
          return 'debug';
        }
        const levelStr = String(firstArg.level).toLowerCase();
        if (/error|fatal|critical/.test(levelStr)) return 'error';
        if (/warn/.test(levelStr)) return 'warn';
        if (/debug|trace|verbose/.test(levelStr)) return 'debug';
      }
      if (firstArg.severity) {
        const sev = String(firstArg.severity).toLowerCase();
        if (/error|fatal|critical/.test(sev)) return 'error';
        if (/warn/.test(sev)) return 'warn';
        if (/debug|verbose/.test(sev)) return 'debug';
      }
    }

    // Content-based (lowest priority)
    const content = `${tag || ''} ${message || ''}`;
    if (/error|exception|failed|fatal|crash/i.test(content)) return 'error';
    if (/warn(ing)?|timeout|deprecated/i.test(content)) return 'warn';
    if (/debug|trace|verbose/i.test(content)) return 'debug';

    return 'info';
  }

  // ============ Utilities ============
  function pad(n, l) { return String(n).padStart(l, '0'); }

  function getTimestamp() {
    const d = new Date();
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3);
  }

  function safePost(data) {
    try {
      if (typeof window.postMessage === 'function') {
        window.postMessage(data, '*');
      }
    } catch {}
  }

  // ============ Console Hooking ============
  function hook(level) {
    try {
      const current = console[level];
      if (typeof current !== 'function') return;

      if (!originals.has(level)) {
        originals.set(level, current);
      }

      console[level] = function(...args) {
        // Prevent recursion
        if (isProcessing) {
          return originals.get(level).apply(console, args);
        }

        try {
          isProcessing = true;

          if (capturing) {
            const time = getTimestamp();
            const caller = getCaller();
            const tag = detectTag(args);
            const { message, snapshot, raw } = serializeArgs(args);
            const logLevel = detectLevel(level, message, tag, args);
            const timestamp = Date.now();

            // Extract structured data if first arg is object
            let structured = null;
            const firstArg = args[0];
            if (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg) && !(firstArg instanceof Error)) {
              structured = snapshot;
            }

            safePost({
              type: 'LOGTAP_LOG',
              payload: {
                id: ++logId,
                method: level,
                level: logLevel,
                tag,
                message,
                raw,
                snapshot,
                structured,
                file: caller.file,
                fullPath: caller.fullPath,
                line: caller.line,
                column: caller.column,
                function: caller.function,
                isMinified: caller.isMinified,
                time,
                timestamp,
                url: window.location.href
              }
            });
          }
        } catch {} finally {
          isProcessing = false;
        }

        // Always call original
        try {
          return originals.get(level).apply(console, args);
        } catch {
          try {
            return console[level].__proto__.apply(console, args);
          } catch {}
        }
      };
    } catch {}
  }

  // Hook all console methods
  ['log', 'info', 'warn', 'error', 'debug', 'trace'].forEach(hook);

  // ============ Message Handler ============
  window.addEventListener('message', function(e) {
    if (e.source !== window) return;

    try {
      const msg = e.data || {};

      if (msg.type === 'LOGTAP_CONTROL') {
        if (msg.command === 'pause') {
          capturing = false;
        } else if (msg.command === 'resume') {
          capturing = true;
        } else if (msg.command === 'getStatus') {
          safePost({
            type: 'LOGTAP_STATUS',
            payload: {
              capturing,
              logCount: logId,
              injected: true
            }
          });
        }
      }

      // Legacy support
      if (msg.type === 'logtap:toggle') {
        capturing = !!msg.enabled;
        safePost({ type: 'logtap:status', enabled: capturing });
      }
    } catch {}
  });

  // ============ Announce Ready ============
  safePost({
    type: 'LOGTAP_READY',
    payload: { version: '3.0', logCount: logId }
  });

  // Silent in production - no debug output to avoid polluting extension error pages

})();
