/**
 * LogTap 3.0 - Semantic Search
 * Natural language query parsing with keyword expansion, time parsing,
 * and advanced intent detection
 */

// Intent patterns for advanced queries
const INTENT_PATTERNS = [
  // Performance queries
  {
    pattern: /(?:show|find|what(?:'s| is| are)?)\s*(?:the\s+)?(?:slowest|slow|longest|performance)/i,
    intent: 'performance',
    handler: (logs) => logs
      .filter(l => l.message?.match(/\d+\s*ms|\d+\s*seconds?|took|duration|latency|slow|timeout/i))
      .sort((a, b) => {
        const extractMs = (msg) => {
          const match = msg?.match(/(\d+(?:\.\d+)?)\s*(?:ms|milliseconds?)/i);
          return match ? parseFloat(match[1]) : 0;
        };
        return extractMs(b.message) - extractMs(a.message);
      })
  },
  // "What happened before/after X"
  {
    pattern: /what\s+(?:happened|occurred)\s+(?:right\s+)?before\s+(?:the\s+)?(.+)/i,
    intent: 'context_before',
    handler: (logs, match) => {
      const searchTerm = match[1].toLowerCase();
      const targetIndex = logs.findIndex(l =>
        l.message?.toLowerCase().includes(searchTerm) ||
        l.level === searchTerm
      );
      if (targetIndex > 0) {
        return logs.slice(Math.max(0, targetIndex - 10), targetIndex);
      }
      return [];
    }
  },
  {
    pattern: /what\s+(?:happened|occurred)\s+(?:right\s+)?after\s+(?:the\s+)?(.+)/i,
    intent: 'context_after',
    handler: (logs, match) => {
      const searchTerm = match[1].toLowerCase();
      const targetIndex = logs.findIndex(l =>
        l.message?.toLowerCase().includes(searchTerm) ||
        l.level === searchTerm
      );
      if (targetIndex >= 0) {
        return logs.slice(targetIndex + 1, targetIndex + 11);
      }
      return [];
    }
  },
  // First/last occurrence
  {
    pattern: /(?:first|earliest)\s+(?:occurrence\s+of\s+)?(.+)/i,
    intent: 'first',
    handler: (logs, match) => {
      const searchTerm = match[1].toLowerCase();
      const first = logs.find(l =>
        l.message?.toLowerCase().includes(searchTerm) ||
        l.tag?.toLowerCase() === searchTerm
      );
      return first ? [first] : [];
    }
  },
  {
    pattern: /(?:last|latest|most\s+recent)\s+(?:occurrence\s+of\s+)?(.+)/i,
    intent: 'last',
    handler: (logs, match) => {
      const searchTerm = match[1].toLowerCase();
      const matches = logs.filter(l =>
        l.message?.toLowerCase().includes(searchTerm) ||
        l.tag?.toLowerCase() === searchTerm
      );
      return matches.length > 0 ? [matches[matches.length - 1]] : [];
    }
  },
  // Count queries
  {
    pattern: /how\s+many\s+(.+)/i,
    intent: 'count',
    handler: (logs, match) => {
      const searchTerm = match[1].toLowerCase()
        .replace(/\s*(errors?|warnings?|logs?)\s*/g, '')
        .trim();

      let filtered = logs;
      if (match[1].match(/errors?/i)) {
        filtered = logs.filter(l => l.level === 'error');
      } else if (match[1].match(/warnings?/i)) {
        filtered = logs.filter(l => l.level === 'warn');
      } else if (searchTerm) {
        filtered = logs.filter(l =>
          l.message?.toLowerCase().includes(searchTerm) ||
          l.tag?.toLowerCase().includes(searchTerm)
        );
      }

      // Return special count result
      return {
        _isCount: true,
        count: filtered.length,
        query: match[0],
        logs: filtered.slice(0, 5) // Sample
      };
    }
  },
  // Unique/distinct queries
  {
    pattern: /(?:unique|distinct|different)\s+(tags?|messages?|errors?)/i,
    intent: 'unique',
    handler: (logs, match) => {
      const type = match[1].toLowerCase();
      if (type.startsWith('tag')) {
        const tags = [...new Set(logs.map(l => l.tag).filter(Boolean))];
        return { _isUnique: true, type: 'tags', items: tags, count: tags.length };
      }
      if (type.startsWith('error')) {
        const errors = [...new Set(logs.filter(l => l.level === 'error').map(l => l.message))];
        return { _isUnique: true, type: 'errors', items: errors, count: errors.length };
      }
      const messages = [...new Set(logs.map(l => l.message))];
      return { _isUnique: true, type: 'messages', items: messages.slice(0, 50), count: messages.length };
    }
  },
  // Grouped/by tag queries
  {
    pattern: /(?:group|grouped|by)\s+(tag|level|file)/i,
    intent: 'group',
    handler: (logs, match) => {
      const groupBy = match[1].toLowerCase();
      const groups = {};
      for (const log of logs) {
        const key = log[groupBy] || 'unknown';
        if (!groups[key]) groups[key] = [];
        groups[key].push(log);
      }
      return { _isGrouped: true, groupBy, groups };
    }
  },
  // Summary queries
  {
    pattern: /(?:summarize|summary|overview|stats|statistics)/i,
    intent: 'summary',
    handler: (logs) => {
      const levels = { error: 0, warn: 0, info: 0, debug: 0 };
      const tags = {};
      let earliest = Infinity, latest = 0;

      for (const log of logs) {
        levels[log.level || 'info']++;
        if (log.tag) tags[log.tag] = (tags[log.tag] || 0) + 1;
        if (log.timestamp) {
          earliest = Math.min(earliest, log.timestamp);
          latest = Math.max(latest, log.timestamp);
        }
      }

      const topTags = Object.entries(tags)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      return {
        _isSummary: true,
        total: logs.length,
        levels,
        topTags,
        timeSpan: latest > earliest ? latest - earliest : 0,
        earliest: earliest !== Infinity ? new Date(earliest).toISOString() : null,
        latest: latest > 0 ? new Date(latest).toISOString() : null
      };
    }
  }
];

// Keyword synonyms for semantic expansion
const KEYWORD_EXPANSIONS = {
  // Network related
  network: ['fetch', 'xhr', 'http', 'api', 'request', 'response', 'ajax', 'socket', 'websocket'],
  api: ['fetch', 'xhr', 'http', 'endpoint', 'request', 'response', 'rest', 'graphql'],
  request: ['fetch', 'xhr', 'http', 'api', 'get', 'post', 'put', 'delete', 'patch'],

  // Auth related
  auth: ['login', 'logout', 'session', 'token', 'jwt', 'oauth', 'authenticate', 'authorization', 'user'],
  login: ['auth', 'signin', 'sign-in', 'authentication', 'session', 'credential'],
  user: ['auth', 'login', 'session', 'account', 'profile', 'member'],

  // Error related
  error: ['exception', 'failed', 'failure', 'crash', 'bug', 'issue', 'problem', 'err'],
  crash: ['error', 'exception', 'fatal', 'unhandled', 'uncaught'],
  bug: ['error', 'issue', 'problem', 'defect', 'glitch'],

  // Performance related
  performance: ['slow', 'latency', 'timing', 'speed', 'perf', 'lag', 'delay'],
  slow: ['performance', 'latency', 'timeout', 'delay', 'lag'],

  // State related
  state: ['store', 'redux', 'context', 'data', 'model', 'mutation'],
  render: ['component', 'update', 'dom', 'paint', 'draw', 'display', 'view'],

  // Navigation
  navigation: ['route', 'router', 'navigate', 'page', 'url', 'history', 'link'],
  route: ['navigation', 'router', 'path', 'url', 'page'],

  // Storage
  storage: ['cache', 'localstorage', 'indexeddb', 'cookie', 'persist', 'save', 'store'],
  cache: ['storage', 'memory', 'persist', 'store', 'cached'],

  // Events
  event: ['click', 'input', 'change', 'submit', 'handler', 'listener', 'dispatch'],
  click: ['event', 'tap', 'press', 'interaction', 'button'],

  // Debug
  debug: ['trace', 'verbose', 'log', 'info', 'diagnostic'],
  warning: ['warn', 'caution', 'alert', 'notice', 'deprecated']
};

// Time expressions
const TIME_PATTERNS = [
  // Relative: "last X minutes/hours/days"
  { regex: /(?:last|past)\s+(\d+)\s*(min(?:ute)?s?|hours?|h|days?|d|seconds?|s|weeks?|w)/i, handler: parseRelativeTime },
  // Relative: "X minutes/hours ago"
  { regex: /(\d+)\s*(min(?:ute)?s?|hours?|h|days?|d|seconds?|s|weeks?|w)\s+ago/i, handler: parseRelativeTime },
  // Named: "today", "yesterday", "this week"
  { regex: /\b(today|yesterday|this\s+week|this\s+hour|recent(?:ly)?)\b/i, handler: parseNamedTime },
  // Range: "from X to Y" or "between X and Y"
  { regex: /(?:from|between)\s+(\d{1,2}):(\d{2})\s*(?:to|and)\s*(\d{1,2}):(\d{2})/i, handler: parseTimeRange },
  // Specific time: "after 2pm", "before 5:30"
  { regex: /\b(after|before|since)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i, handler: parseSpecificTime }
];

// Level keywords
const LEVEL_KEYWORDS = {
  error: ['error', 'errors', 'err', 'exception', 'exceptions', 'failed', 'failure', 'fatal', 'critical'],
  warn: ['warn', 'warning', 'warnings', 'caution', 'alert', 'deprecated'],
  info: ['info', 'information', 'log', 'logs'],
  debug: ['debug', 'debugging', 'trace', 'verbose', 'detail', 'detailed']
};

/**
 * Parse a natural language search query
 */
export function parseQuery(query) {
  if (!query || typeof query !== 'string') {
    return { original: '', filters: {}, keywords: [], timeRange: null, levels: null };
  }

  const original = query.trim();
  let remaining = original.toLowerCase();
  const filters = {};
  let timeRange = null;
  let levels = null;

  // Check for regex pattern first
  const regexMatch = original.match(/^\/(.*?)\/([gimsu]*)$/);
  if (regexMatch) {
    return {
      original,
      filters: { regex: regexMatch[1], flags: regexMatch[2] || 'i' },
      keywords: [],
      timeRange: null,
      levels: null,
      isRegex: true
    };
  }

  // Extract time expressions
  for (const { regex, handler } of TIME_PATTERNS) {
    const match = remaining.match(regex);
    if (match) {
      timeRange = handler(match);
      remaining = remaining.replace(match[0], ' ').trim();
      break;
    }
  }

  // Extract level filters
  const extractedLevels = new Set();
  for (const [level, keywords] of Object.entries(LEVEL_KEYWORDS)) {
    for (const kw of keywords) {
      const levelRegex = new RegExp(`\\b${kw}(?:s)?\\s*(?:only)?\\b`, 'i');
      if (levelRegex.test(remaining)) {
        extractedLevels.add(level);
        remaining = remaining.replace(levelRegex, ' ').trim();
      }
    }
  }
  if (extractedLevels.size > 0) {
    levels = Array.from(extractedLevels);
  }

  // Extract "show" / "find" / "search for" prefixes
  remaining = remaining.replace(/^(?:show|find|search\s+for|get|list|display)\s+(?:me\s+)?(?:all\s+)?/i, '');

  // Extract "from <source>" patterns
  const fromMatch = remaining.match(/\bfrom\s+([a-z0-9_.-]+)/i);
  if (fromMatch) {
    filters.source = fromMatch[1];
    remaining = remaining.replace(fromMatch[0], ' ').trim();
  }

  // Extract "in <file>" patterns
  const inMatch = remaining.match(/\bin\s+([a-z0-9_.-]+\.(?:js|ts|jsx|tsx|vue|svelte))/i);
  if (inMatch) {
    filters.file = inMatch[1];
    remaining = remaining.replace(inMatch[0], ' ').trim();
  }

  // Extract "with <tag>" patterns
  const withMatch = remaining.match(/\bwith\s+(?:tag\s+)?["']?([a-z0-9_-]+)["']?/i);
  if (withMatch) {
    filters.tag = withMatch[1];
    remaining = remaining.replace(withMatch[0], ' ').trim();
  }

  // Extract tag: prefix syntax
  const tagPrefixMatch = remaining.match(/\btag:["']?([a-z0-9_-]+)["']?/i);
  if (tagPrefixMatch) {
    filters.tag = tagPrefixMatch[1];
    remaining = remaining.replace(tagPrefixMatch[0], ' ').trim();
  }

  // Extract level: prefix syntax
  const levelPrefixMatch = remaining.match(/\blevel:["']?([a-z]+)["']?/i);
  if (levelPrefixMatch) {
    const lvl = levelPrefixMatch[1].toLowerCase();
    if (['error', 'warn', 'info', 'debug'].includes(lvl)) {
      levels = levels || [];
      if (!levels.includes(lvl)) levels.push(lvl);
    }
    remaining = remaining.replace(levelPrefixMatch[0], ' ').trim();
  }

  // Clean up remaining text
  remaining = remaining
    .replace(/\b(?:the|a|an|and|or|with|that|which|for|about)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract keywords from remaining text
  const words = remaining.split(/\s+/).filter(w => w.length > 1);
  const keywords = expandKeywords(words);

  return {
    original,
    filters,
    keywords,
    timeRange,
    levels,
    isRegex: false
  };
}

/**
 * Expand keywords with synonyms
 */
export function expandKeywords(words) {
  const expanded = new Set();

  for (const word of words) {
    expanded.add(word);

    // Check for expansions
    const lowerWord = word.toLowerCase();
    if (KEYWORD_EXPANSIONS[lowerWord]) {
      for (const synonym of KEYWORD_EXPANSIONS[lowerWord]) {
        expanded.add(synonym);
      }
    }
  }

  return Array.from(expanded);
}

/**
 * Build a regex pattern from parsed query
 */
export function buildPattern(parsed) {
  if (parsed.isRegex) {
    return new RegExp(parsed.filters.regex, parsed.filters.flags);
  }

  if (parsed.keywords.length === 0) {
    return null;
  }

  // Escape special regex chars and join with OR
  const escaped = parsed.keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'i');
}

/**
 * Parse relative time expressions
 */
function parseRelativeTime(match) {
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  let ms = 0;
  if (unit.startsWith('s')) ms = amount * 1000;
  else if (unit.startsWith('min') || unit === 'm') ms = amount * 60 * 1000;
  else if (unit.startsWith('h')) ms = amount * 60 * 60 * 1000;
  else if (unit.startsWith('d')) ms = amount * 24 * 60 * 60 * 1000;
  else if (unit.startsWith('w')) ms = amount * 7 * 24 * 60 * 60 * 1000;

  const now = Date.now();
  return { start: now - ms, end: now };
}

/**
 * Parse named time expressions
 */
function parseNamedTime(match) {
  const term = match[1].toLowerCase().replace(/\s+/g, '');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (term) {
    case 'today':
      return { start: today.getTime(), end: Date.now() };

    case 'yesterday': {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return { start: yesterday.getTime(), end: today.getTime() };
    }

    case 'thisweek': {
      const weekStart = new Date(today);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      return { start: weekStart.getTime(), end: Date.now() };
    }

    case 'thishour': {
      const hourStart = new Date(now);
      hourStart.setMinutes(0, 0, 0);
      return { start: hourStart.getTime(), end: Date.now() };
    }

    case 'recent':
    case 'recently':
      // Last 15 minutes
      return { start: Date.now() - 15 * 60 * 1000, end: Date.now() };

    default:
      return null;
  }
}

/**
 * Parse time range expressions
 */
function parseTimeRange(match) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const startHour = parseInt(match[1], 10);
  const startMin = parseInt(match[2], 10);
  const endHour = parseInt(match[3], 10);
  const endMin = parseInt(match[4], 10);

  const start = new Date(today);
  start.setHours(startHour, startMin, 0, 0);

  const end = new Date(today);
  end.setHours(endHour, endMin, 59, 999);

  return { start: start.getTime(), end: end.getTime() };
}

/**
 * Parse specific time expressions
 */
function parseSpecificTime(match) {
  const direction = match[1].toLowerCase();
  let hour = parseInt(match[2], 10);
  const minute = match[3] ? parseInt(match[3], 10) : 0;
  const ampm = match[4]?.toLowerCase();

  // Convert to 24-hour
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetTime = new Date(today);
  targetTime.setHours(hour, minute, 0, 0);

  if (direction === 'after' || direction === 'since') {
    return { start: targetTime.getTime(), end: Date.now() };
  } else {
    return { start: today.getTime(), end: targetTime.getTime() };
  }
}

/**
 * Check for advanced intent patterns
 */
export function detectIntent(query, logs) {
  if (!query || typeof query !== 'string') return null;

  for (const { pattern, intent, handler } of INTENT_PATTERNS) {
    const match = query.match(pattern);
    if (match) {
      return {
        intent,
        match,
        handler,
        result: handler(logs, match)
      };
    }
  }

  return null;
}

/**
 * Apply parsed query to filter logs
 */
export function applySemanticSearch(logs, query) {
  if (!logs || logs.length === 0) return [];
  if (!query || typeof query !== 'string' || !query.trim()) return logs;

  // Check for advanced intent patterns first
  const intent = detectIntent(query, logs);
  if (intent) {
    // Return the result directly - UI should handle special result types
    const result = intent.result;
    if (result && (result._isCount || result._isUnique || result._isGrouped || result._isSummary)) {
      return result;
    }
    if (Array.isArray(result)) {
      return result;
    }
  }

  const parsed = parseQuery(query);
  const pattern = buildPattern(parsed);

  return logs.filter(log => {
    // Time range filter
    if (parsed.timeRange) {
      const logTime = log.timestamp || log.time;
      if (logTime) {
        const ts = typeof logTime === 'number' ? logTime : new Date(logTime).getTime();
        if (ts < parsed.timeRange.start || ts > parsed.timeRange.end) {
          return false;
        }
      }
    }

    // Level filter
    if (parsed.levels && parsed.levels.length > 0) {
      if (!parsed.levels.includes(log.level)) {
        return false;
      }
    }

    // Tag filter
    if (parsed.filters.tag) {
      if (log.tag?.toLowerCase() !== parsed.filters.tag.toLowerCase()) {
        return false;
      }
    }

    // File filter
    if (parsed.filters.file) {
      if (!log.file?.toLowerCase().includes(parsed.filters.file.toLowerCase())) {
        return false;
      }
    }

    // Keyword/pattern search
    if (pattern) {
      const searchText = buildSearchText(log);
      if (!pattern.test(searchText)) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Build searchable text from a log entry
 */
function buildSearchText(log) {
  const parts = [
    log.message || '',
    log.raw || '',
    log.tag || '',
    log.file || ''
  ];

  if (log.snapshot && typeof log.snapshot === 'object') {
    try {
      parts.push(JSON.stringify(log.snapshot));
    } catch {}
  }

  return parts.join(' ');
}

/**
 * Get search suggestions based on partial query
 */
export function getSuggestions(partial) {
  if (!partial || partial.length < 2) return [];

  const lower = partial.toLowerCase();
  const suggestions = [];

  // Suggest keyword expansions
  for (const [keyword, synonyms] of Object.entries(KEYWORD_EXPANSIONS)) {
    if (keyword.startsWith(lower)) {
      suggestions.push({
        text: keyword,
        type: 'keyword',
        description: `Search for ${keyword} (includes: ${synonyms.slice(0, 3).join(', ')}...)`
      });
    }
  }

  // Suggest time expressions
  if ('last'.startsWith(lower) || lower.startsWith('last')) {
    suggestions.push(
      { text: 'last 5 minutes', type: 'time', description: 'Logs from last 5 minutes' },
      { text: 'last hour', type: 'time', description: 'Logs from last hour' },
      { text: 'last 24 hours', type: 'time', description: 'Logs from last 24 hours' }
    );
  }

  if ('today'.startsWith(lower)) {
    suggestions.push({ text: 'today', type: 'time', description: "Today's logs" });
  }

  if ('recent'.startsWith(lower)) {
    suggestions.push({ text: 'recent', type: 'time', description: 'Recent logs (last 15 min)' });
  }

  // Suggest level filters
  for (const level of ['error', 'warn', 'info', 'debug']) {
    if (level.startsWith(lower) || `${level}s`.startsWith(lower)) {
      suggestions.push({
        text: `${level}s only`,
        type: 'level',
        description: `Show only ${level} level logs`
      });
    }
  }

  return suggestions.slice(0, 8);
}

/**
 * Format parsed query for display
 */
export function formatParsedQuery(parsed) {
  const parts = [];

  if (parsed.keywords.length > 0) {
    const displayed = parsed.keywords.slice(0, 5);
    if (parsed.keywords.length > 5) {
      parts.push(`Keywords: ${displayed.join('|')}... (+${parsed.keywords.length - 5} more)`);
    } else {
      parts.push(`Keywords: ${displayed.join('|')}`);
    }
  }

  if (parsed.levels) {
    parts.push(`Levels: ${parsed.levels.join(', ')}`);
  }

  if (parsed.timeRange) {
    const start = new Date(parsed.timeRange.start).toLocaleTimeString();
    const end = new Date(parsed.timeRange.end).toLocaleTimeString();
    parts.push(`Time: ${start} → ${end}`);
  }

  if (parsed.filters.tag) {
    parts.push(`Tag: ${parsed.filters.tag}`);
  }

  if (parsed.filters.file) {
    parts.push(`File: ${parsed.filters.file}`);
  }

  return parts.join(' | ');
}

export { KEYWORD_EXPANSIONS, LEVEL_KEYWORDS, INTENT_PATTERNS, detectIntent };
