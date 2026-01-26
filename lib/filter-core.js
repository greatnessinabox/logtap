/**
 * LogTap 3.0 - Filter Core
 * Unified filtering, formatting, and deduplication logic
 */

// ============ Regex Helpers ============

/**
 * Convert user filter string to RegExp
 * Supports: /regex/, ^start, end$, or plain text
 */
export function toRegex(s) {
  if (!s || !String(s).trim()) return null;
  const str = String(s).trim();
  try {
    if (str.startsWith('/') && str.endsWith('/') && str.length > 2) {
      return new RegExp(str.slice(1, -1), 'i');
    }
    if (str.startsWith('^') || str.endsWith('$')) {
      return new RegExp(str, 'i');
    }
    return new RegExp(str, 'i');
  } catch {
    return new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

// ============ Deduplication ============

/**
 * Smart deduplication with collapse detection
 * Groups consecutive identical logs and detects loop spam
 */
export function smartDedupe(items, opts = {}) {
  if (!items?.length) return [];

  const timeWindow = opts.timeWindow || 100; // ms for loop detection
  const out = [];
  let group = [];
  let groupKey = '';

  const getKey = (it) => `${it.level}:${it.message}`;

  const parseTime = (timeStr) => {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    if (parts.length < 3) return 0;
    const [h, m, rest] = parts;
    const [s, ms] = (rest || '0.0').split('.');
    return (parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s)) * 1000 + parseInt(ms || 0);
  };

  const flushGroup = () => {
    if (!group.length) return;
    if (group.length === 1) {
      out.push(group[0]);
    } else {
      const first = { ...group[0] };
      first._repeatCount = group.length;
      first._collapsed = true;
      first._collapsedItems = group;
      out.push(first);
    }
    group = [];
  };

  for (const it of items) {
    const key = getKey(it);

    if (key !== groupKey) {
      flushGroup();
      groupKey = key;
    }

    if (group.length > 0) {
      const lastTime = parseTime(group[group.length - 1].time);
      const thisTime = parseTime(it.time);
      if (thisTime - lastTime > timeWindow) {
        flushGroup();
        groupKey = key;
      }
    }

    group.push(it);
  }

  flushGroup();
  return out;
}

// ============ Searchable Text ============

/**
 * Build searchable text from a log item
 */
export function buildSearchableText(it) {
  const parts = [it.message || '', it.raw || '', it.tag || '', it.file || ''];

  if (it.structured && typeof it.structured === 'object') {
    try {
      parts.push(JSON.stringify(it.structured));
      ['event', 'action', 'msg', 'message', 'error', 'reason'].forEach(key => {
        if (it.structured[key]) parts.push(String(it.structured[key]));
      });
    } catch {}
  }

  return parts.join(' ');
}

// ============ Filtering ============

/**
 * Apply all filters to log items
 */
export function applyFilters(items, opts = {}) {
  if (!items?.length) return [];

  const inc = toRegex(opts.include);
  const exc = toRegex(opts.exclude);

  const levels = new Set();
  if (opts.lvlInfo !== false) levels.add('info');
  if (opts.lvlWarn !== false) levels.add('warn');
  if (opts.lvlError !== false) levels.add('error');
  if (opts.lvlDebug !== false) levels.add('debug');

  const tagSet = opts.activeTags?.length ? new Set(opts.activeTags) : null;
  const now = Date.now();

  let out = items.filter(it => {
    // Empty lines
    if (opts.removeEmptyLines !== false && !String(it.message || '').trim()) {
      return false;
    }

    // Time range
    if (opts.timeRangeMs && it.timestamp) {
      const logTime = typeof it.timestamp === 'number' ? it.timestamp : new Date(it.timestamp).getTime();
      if (now - logTime > opts.timeRangeMs) return false;
    }

    // Text search
    const searchText = buildSearchableText(it);
    if (inc && !inc.test(searchText)) return false;
    if (exc && exc.test(searchText)) return false;

    // Tag filter
    if (tagSet?.size) {
      let matchesTag = it.tag && tagSet.has(it.tag);
      if (!matchesTag && it.structured?.event) {
        matchesTag = tagSet.has(String(it.structured.event).replace(/_/g, '-').toLowerCase());
      }
      if (!matchesTag) return false;
    }

    // Level filter
    if (it.level && !levels.has(it.level)) return false;

    return true;
  });

  // Limit
  const limit = Number(opts.limitLines) || 0;
  if (limit > 0 && out.length > limit) {
    out = out.slice(-limit);
  }

  // Dedupe
  if (opts.dedupe || opts.smartDedupe) {
    out = smartDedupe(out, opts);
  }

  return out;
}

// ============ Formatting ============

const LEVEL_EMOJI = {
  error: '\u274C',
  warn: '\u26A0\uFE0F',
  info: '\u2139\uFE0F',
  debug: '\uD83D\uDC1B'
};

/**
 * Format as plain text
 */
export function formatPlain(items, opts = {}) {
  return items.map((it, i) => {
    const parts = [];

    if (!opts.removeTimestamps) {
      if (opts.showEmoji !== false) parts.push(LEVEL_EMOJI[it.level] || '');
      if (it.time) parts.push(`[${it.time}]`);
    }

    if (!opts.removeFileReferences && it.file) {
      parts.push(it.file + (it.line ? `:${it.line}` : ''));
    }

    let msg = it.message || '';
    if (opts.preserveBrackets && it.tag) {
      msg = `[${it.tag}] ${msg}`;
    }
    if (it._repeatCount > 1) {
      msg += ` [x${it._repeatCount}]`;
    }
    parts.push(msg);

    let line = parts.filter(Boolean).join(' ');
    if (opts.addLineNumbers) {
      line = String(i + 1).padStart(4, ' ') + ' \u2502 ' + line;
    }

    return line;
  }).join('\n');
}

/**
 * Format as Markdown
 */
export function formatMarkdown(items, opts = {}) {
  return '```\n' + formatPlain(items, opts) + '\n```';
}

/**
 * Format as CSV
 */
export function formatCSV(items, opts = {}) {
  const escape = (s) => '"' + String(s || '').replace(/"/g, '""').replace(/\n/g, ' ') + '"';
  const header = 'time,file,tag,level,message,repeat_count';
  const rows = items.map(it => [
    escape(opts.removeTimestamps ? '' : it.time),
    escape(opts.removeFileReferences ? '' : (it.file || '')),
    escape(it.tag || ''),
    escape(it.level || 'info'),
    escape(it.message || ''),
    it._repeatCount || 1
  ].join(','));
  return [header, ...rows].join('\n');
}

/**
 * Format as JSON
 */
export function formatJSON(items, opts = {}) {
  const cleaned = items.map(it => {
    const obj = { level: it.level || 'info', message: it.message };
    if (!opts.removeTimestamps && it.time) obj.time = it.time;
    if (!opts.removeFileReferences && it.file) obj.file = it.file;
    if (it.tag) obj.tag = it.tag;
    if (it.structured) obj.structured = it.structured;
    if (it._repeatCount > 1) obj.repeatCount = it._repeatCount;
    return obj;
  });
  return JSON.stringify(cleaned, null, 2);
}

/**
 * Format based on output format option
 */
export function formatOutput(items, opts = {}) {
  switch (opts.outputFormat) {
    case 'csv': return formatCSV(items, opts);
    case 'json': return formatJSON(items, opts);
    case 'plain': return formatPlain(items, opts);
    case 'markdown':
    default: return formatMarkdown(items, opts);
  }
}

// ============ Tag Extraction ============

/**
 * Extract unique tags from log items with counts
 */
export function extractTags(items) {
  const m = new Map();
  for (const it of items) {
    if (it.tag) m.set(it.tag, (m.get(it.tag) || 0) + 1);
    if (it.structured?.event) {
      const tag = String(it.structured.event).replace(/_/g, '-').toLowerCase();
      if (tag !== it.tag) m.set(tag, (m.get(tag) || 0) + 1);
    }
  }
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

// ============ Default Settings ============

export function getDefaultSettings() {
  return {
    removeTimestamps: false,
    removeFileReferences: true,
    preserveBrackets: true,
    removeEmptyLines: true,
    addLineNumbers: false,
    dedupe: true,
    smartDedupe: true,
    include: '',
    exclude: '',
    limitLines: '500',
    outputFormat: 'markdown',
    lvlInfo: true,
    lvlWarn: true,
    lvlError: true,
    lvlDebug: true,
    activeTags: null,
    showEmoji: true
  };
}
