/**
 * LogTap 3.0 - Causality Grouper
 * Groups related logs by request/trace ID, timing proximity, or detected patterns
 */

const CONFIG = {
  // Time window for grouping logs without explicit correlation
  timeWindowMs: 100,
  // Common correlation ID field names
  correlationFields: ['requestId', 'traceId', 'correlationId', 'txId', 'transactionId', 'reqId', 'rid', 'id'],
  // Patterns that indicate request start/end
  requestStartPatterns: [
    /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+/i,
    /request\s+(started|begin|incoming)/i,
    /^\[request\]/i,
    /^-+>\s*(GET|POST|PUT|DELETE)/i
  ],
  requestEndPatterns: [
    /response\s+(sent|complete|finished)/i,
    /^\[response\]/i,
    /(responded|returned)\s+\d{3}/i,
    /^<-+\s*\d{3}/i
  ]
};

/**
 * Extract correlation ID from a log entry
 */
function extractCorrelationId(log) {
  // Check message for common patterns like [req-123] or requestId: abc
  const message = log.message || '';

  // Pattern: [req-xxx] or [trace-xxx] at start
  const bracketMatch = message.match(/^\[(?:req|trace|tx|rid)[_-]?([a-zA-Z0-9_-]+)\]/i);
  if (bracketMatch) return bracketMatch[1];

  // Pattern: requestId=xxx or traceId: xxx
  for (const field of CONFIG.correlationFields) {
    const regex = new RegExp(`${field}[=:]\\s*["']?([a-zA-Z0-9_-]+)["']?`, 'i');
    const match = message.match(regex);
    if (match) return match[1];
  }

  // Check snapshot for correlation fields
  if (log.snapshot && typeof log.snapshot === 'object') {
    for (const field of CONFIG.correlationFields) {
      if (log.snapshot[field]) return String(log.snapshot[field]);
      // Check nested data object
      if (log.snapshot.data && log.snapshot.data[field]) {
        return String(log.snapshot.data[field]);
      }
    }
  }

  return null;
}

/**
 * Detect if log is a request start
 */
function isRequestStart(log) {
  const message = log.message || '';
  return CONFIG.requestStartPatterns.some(p => p.test(message));
}

/**
 * Detect if log is a request end
 */
function isRequestEnd(log) {
  const message = log.message || '';
  return CONFIG.requestEndPatterns.some(p => p.test(message));
}

/**
 * Extract HTTP method and path if present
 */
function extractHttpInfo(log) {
  const message = log.message || '';
  const match = message.match(/(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([^\s]+)/i);
  if (match) {
    return { method: match[1].toUpperCase(), path: match[2] };
  }
  return null;
}

/**
 * Extract response status if present
 */
function extractStatusCode(log) {
  const message = log.message || '';
  // Match patterns like "200 OK", "→ 404", "status: 500"
  const match = message.match(/(?:^|[\s→←:])(\d{3})(?:\s|$)/);
  if (match) {
    const code = parseInt(match[1], 10);
    if (code >= 100 && code < 600) return code;
  }
  return null;
}

/**
 * Group logs by causality
 * Returns array of groups, where each group has:
 * - id: unique group identifier
 * - type: 'request' | 'trace' | 'time' | 'single'
 * - logs: array of logs in the group
 * - metadata: { method, path, status, duration, correlationId }
 */
export function groupLogsByCausality(logs) {
  if (!logs || logs.length === 0) return [];

  const groups = [];
  const correlationGroups = new Map(); // correlationId -> group
  const pendingRequests = new Map(); // correlationId -> group (for open requests)

  // First pass: group by correlation ID
  for (const log of logs) {
    const correlationId = extractCorrelationId(log);

    if (correlationId) {
      if (!correlationGroups.has(correlationId)) {
        correlationGroups.set(correlationId, {
          id: `trace-${correlationId}`,
          type: 'trace',
          correlationId,
          logs: [],
          metadata: {}
        });
      }
      correlationGroups.get(correlationId).logs.push(log);
      continue;
    }

    // Check for request start/end patterns
    const httpInfo = extractHttpInfo(log);
    const statusCode = extractStatusCode(log);

    if (isRequestStart(log) && httpInfo) {
      // Start a new request group
      const group = {
        id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'request',
        logs: [log],
        metadata: {
          method: httpInfo.method,
          path: httpInfo.path,
          startTime: log.timestamp
        }
      };
      groups.push(group);
      // Track for potential completion
      pendingRequests.set(`${httpInfo.method}:${httpInfo.path}`, group);
    } else if (isRequestEnd(log) && statusCode) {
      // Try to find matching pending request
      let matched = false;
      for (const [key, group] of pendingRequests) {
        // Match by similar timing or path mention
        const timeDiff = (log.timestamp || 0) - (group.metadata.startTime || 0);
        if (timeDiff >= 0 && timeDiff < 30000) { // Within 30 seconds
          group.logs.push(log);
          group.metadata.status = statusCode;
          group.metadata.endTime = log.timestamp;
          group.metadata.duration = timeDiff;
          pendingRequests.delete(key);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Standalone response log
        groups.push({
          id: `single-${log.id || Date.now()}`,
          type: 'single',
          logs: [log],
          metadata: { status: statusCode }
        });
      }
    } else {
      // Try to attach to a recent pending request by timing
      let attached = false;
      for (const [key, group] of pendingRequests) {
        const timeDiff = (log.timestamp || 0) - (group.logs[group.logs.length - 1]?.timestamp || 0);
        if (timeDiff >= 0 && timeDiff < CONFIG.timeWindowMs) {
          group.logs.push(log);
          attached = true;
          break;
        }
      }

      if (!attached) {
        // Standalone log
        groups.push({
          id: `single-${log.id || Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'single',
          logs: [log],
          metadata: {}
        });
      }
    }
  }

  // Add correlation groups
  for (const group of correlationGroups.values()) {
    // Sort logs by timestamp
    group.logs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Extract metadata from first/last logs
    const firstLog = group.logs[0];
    const lastLog = group.logs[group.logs.length - 1];

    const httpInfo = extractHttpInfo(firstLog);
    if (httpInfo) {
      group.metadata.method = httpInfo.method;
      group.metadata.path = httpInfo.path;
    }

    const status = extractStatusCode(lastLog);
    if (status) group.metadata.status = status;

    if (firstLog.timestamp && lastLog.timestamp) {
      group.metadata.duration = lastLog.timestamp - firstLog.timestamp;
    }

    groups.push(group);
  }

  // Sort groups by first log timestamp
  groups.sort((a, b) => {
    const aTime = a.logs[0]?.timestamp || 0;
    const bTime = b.logs[0]?.timestamp || 0;
    return aTime - bTime;
  });

  return groups;
}

/**
 * Merge adjacent single-log groups if they're within time window
 */
export function mergeAdjacentGroups(groups, timeWindowMs = CONFIG.timeWindowMs) {
  if (groups.length < 2) return groups;

  const merged = [];
  let current = null;

  for (const group of groups) {
    if (group.type !== 'single') {
      if (current) {
        merged.push(current);
        current = null;
      }
      merged.push(group);
      continue;
    }

    if (!current) {
      current = { ...group, type: 'time', logs: [...group.logs] };
      continue;
    }

    const lastTime = current.logs[current.logs.length - 1]?.timestamp || 0;
    const thisTime = group.logs[0]?.timestamp || 0;

    if (thisTime - lastTime <= timeWindowMs) {
      current.logs.push(...group.logs);
    } else {
      merged.push(current);
      current = { ...group, type: 'time', logs: [...group.logs] };
    }
  }

  if (current) merged.push(current);

  // Convert single-log time groups back to single
  return merged.map(g => {
    if (g.type === 'time' && g.logs.length === 1) {
      return { ...g, type: 'single' };
    }
    return g;
  });
}

/**
 * Format group for display
 */
export function formatGroupHeader(group) {
  const { type, metadata, logs } = group;

  if (type === 'request' || (type === 'trace' && metadata.method)) {
    const method = metadata.method || '???';
    const path = metadata.path || '/???';
    const status = metadata.status || '...';
    const duration = metadata.duration !== undefined ? `${metadata.duration}ms` : '';
    const statusClass = metadata.status >= 400 ? 'error' : metadata.status >= 300 ? 'warn' : 'success';

    return {
      title: `${method} ${path}`,
      subtitle: `${status} ${duration}`.trim(),
      statusClass,
      icon: '↔',
      count: logs.length
    };
  }

  if (type === 'trace') {
    return {
      title: `Trace: ${group.correlationId}`,
      subtitle: metadata.duration ? `${metadata.duration}ms` : '',
      statusClass: 'info',
      icon: '⟿',
      count: logs.length
    };
  }

  if (type === 'time' && logs.length > 1) {
    const span = (logs[logs.length - 1]?.timestamp || 0) - (logs[0]?.timestamp || 0);
    return {
      title: `${logs.length} logs`,
      subtitle: span > 0 ? `${span}ms span` : 'simultaneous',
      statusClass: 'info',
      icon: '⋮',
      count: logs.length
    };
  }

  // Single log - no header needed
  return null;
}

export { CONFIG, extractCorrelationId, extractHttpInfo, extractStatusCode };
