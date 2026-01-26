/**
 * LogTap 3.0 - Export Engine
 * .logtap format export/import with compression and anonymization
 */

const LOGTAP_VERSION = '3.0';
const LOGTAP_MAGIC = 'LOGTAP';

// Patterns for anonymization
const ANONYMIZE_PATTERNS = {
  // URLs and paths
  url: /https?:\/\/[^\s"'<>]+/gi,
  path: /(?:\/[\w.-]+){2,}/g,

  // IP addresses
  ipv4: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  ipv6: /([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}/g,

  // Email addresses
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,

  // Phone numbers
  phone: /(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,

  // UUIDs
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,

  // Auth tokens (Bearer, JWT patterns)
  bearerToken: /Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi,
  jwt: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,

  // API keys (common patterns)
  apiKey: /(?:api[_-]?key|apikey|api_secret|access_token|secret_key)["\s:=]+["']?[A-Za-z0-9_-]{16,}["']?/gi,

  // Credit card numbers (basic pattern)
  creditCard: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,

  // Social security numbers (US)
  ssn: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g
};

// Replacement strings
const ANONYMIZE_REPLACEMENTS = {
  url: '[REDACTED_URL]',
  path: '[REDACTED_PATH]',
  ipv4: '[REDACTED_IP]',
  ipv6: '[REDACTED_IP]',
  email: '[REDACTED_EMAIL]',
  phone: '[REDACTED_PHONE]',
  uuid: '[REDACTED_UUID]',
  bearerToken: 'Bearer [REDACTED_TOKEN]',
  jwt: '[REDACTED_JWT]',
  apiKey: '[REDACTED_API_KEY]',
  creditCard: '[REDACTED_CARD]',
  ssn: '[REDACTED_SSN]'
};

/**
 * Anonymize a string by removing sensitive data
 */
export function anonymizeString(str) {
  if (!str || typeof str !== 'string') return str;

  let result = str;
  for (const [type, pattern] of Object.entries(ANONYMIZE_PATTERNS)) {
    result = result.replace(pattern, ANONYMIZE_REPLACEMENTS[type]);
  }
  return result;
}

/**
 * Deep anonymize an object
 */
export function anonymizeObject(obj, seen = new WeakSet()) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return anonymizeString(obj);
  if (typeof obj !== 'object') return obj;

  // Handle circular references
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map(item => anonymizeObject(item, seen));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // Also anonymize key names that might be sensitive
    const anonKey = anonymizeString(key);
    result[anonKey] = anonymizeObject(value, seen);
  }
  return result;
}

/**
 * Anonymize log entries
 */
export function anonymizeLogs(logs) {
  return logs.map(log => ({
    ...log,
    message: anonymizeString(log.message),
    raw: log.raw ? anonymizeString(log.raw) : undefined,
    file: log.file ? '[FILE]' : undefined,
    fullPath: undefined, // Remove full paths entirely
    snapshot: log.snapshot ? anonymizeObject(log.snapshot) : undefined,
    // Keep these for analysis
    tag: log.tag,
    level: log.level,
    timestamp: log.timestamp,
    time: log.time
  }));
}

/**
 * Compress data using gzip (browser)
 */
async function compress(data) {
  const jsonStr = JSON.stringify(data);
  const encoder = new TextEncoder();
  const inputBytes = encoder.encode(jsonStr);

  // Check if CompressionStream is available (Chrome 80+)
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(inputBytes);
    writer.close();

    const reader = cs.readable.getReader();
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  // Fallback: return uncompressed with marker
  return { uncompressed: true, data: jsonStr };
}

/**
 * Decompress gzip data
 */
async function decompress(compressed) {
  // Handle uncompressed fallback
  if (compressed.uncompressed) {
    return JSON.parse(compressed.data);
  }

  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();

    const reader = ds.readable.getReader();
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(result));
  }

  throw new Error('Decompression not supported in this browser');
}

/**
 * Export logs to .logtap format
 */
export async function exportLogs(options = {}) {
  const {
    logs = [],
    sessions = [],
    settings = {},
    anomalyBaseline = null,
    anonymize = false,
    metadata = {}
  } = options;

  // Prepare logs
  const processedLogs = anonymize ? anonymizeLogs(logs) : logs;

  // Build export package
  const exportData = {
    magic: LOGTAP_MAGIC,
    version: LOGTAP_VERSION,
    exported: Date.now(),
    exportedBy: 'LogTap',
    metadata: {
      ...metadata,
      logCount: logs.length,
      sessionCount: sessions.length,
      anonymized: anonymize,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
    },
    sessions: anonymize
      ? sessions.map(s => ({ ...s, url: '[REDACTED_URL]' }))
      : sessions,
    logs: processedLogs,
    settings,
    anomalyBaseline
  };

  // Compress
  const compressed = await compress(exportData);

  return compressed;
}

/**
 * Create a downloadable .logtap file
 */
export async function createExportFile(options = {}) {
  const compressed = await exportLogs(options);

  // Convert to Blob
  let blob;
  if (compressed.uncompressed) {
    blob = new Blob([compressed.data], { type: 'application/json' });
  } else {
    blob = new Blob([compressed], { type: 'application/gzip' });
  }

  // Generate filename
  const date = new Date().toISOString().split('T')[0];
  const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
  const filename = `logtap-export-${date}-${time}.logtap`;

  return { blob, filename };
}

/**
 * Trigger download of export file
 */
export async function downloadExport(options = {}) {
  const { blob, filename } = await createExportFile(options);

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { filename, size: blob.size };
}

/**
 * Import from .logtap file
 */
export async function importLogs(fileOrData) {
  let data;

  if (fileOrData instanceof File || fileOrData instanceof Blob) {
    // Read file
    const buffer = await fileOrData.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Try to decompress
    try {
      data = await decompress(bytes);
    } catch {
      // Maybe it's uncompressed JSON
      const text = new TextDecoder().decode(bytes);
      data = JSON.parse(text);
    }
  } else if (typeof fileOrData === 'string') {
    // JSON string
    data = JSON.parse(fileOrData);
  } else if (fileOrData instanceof Uint8Array) {
    // Raw bytes
    data = await decompress(fileOrData);
  } else {
    // Already parsed object
    data = fileOrData;
  }

  // Validate
  if (!data.magic || data.magic !== LOGTAP_MAGIC) {
    throw new Error('Invalid .logtap file: missing magic header');
  }

  if (!data.version) {
    throw new Error('Invalid .logtap file: missing version');
  }

  // Check version compatibility
  const majorVersion = parseInt(data.version.split('.')[0], 10);
  const currentMajor = parseInt(LOGTAP_VERSION.split('.')[0], 10);

  if (majorVersion > currentMajor) {
    throw new Error(`Unsupported .logtap version: ${data.version}. Please update LogTap.`);
  }

  return {
    logs: data.logs || [],
    sessions: data.sessions || [],
    settings: data.settings || {},
    anomalyBaseline: data.anomalyBaseline,
    metadata: {
      ...data.metadata,
      version: data.version,
      exported: data.exported,
      importedAt: Date.now()
    }
  };
}

/**
 * Read a .logtap file from file input
 */
export function readImportFile(inputElement) {
  return new Promise((resolve, reject) => {
    if (!inputElement.files || inputElement.files.length === 0) {
      reject(new Error('No file selected'));
      return;
    }

    const file = inputElement.files[0];

    // Validate extension
    if (!file.name.endsWith('.logtap')) {
      reject(new Error('Invalid file type. Please select a .logtap file.'));
      return;
    }

    importLogs(file)
      .then(resolve)
      .catch(reject);
  });
}

/**
 * Create shareable link (base64 encoded, for small exports)
 */
export async function createShareableLink(logs, options = {}) {
  // Limit for URL sharing
  const maxLogs = 100;
  const limitedLogs = logs.slice(-maxLogs);

  const exportData = {
    magic: LOGTAP_MAGIC,
    version: LOGTAP_VERSION,
    exported: Date.now(),
    logs: options.anonymize ? anonymizeLogs(limitedLogs) : limitedLogs,
    metadata: {
      logCount: limitedLogs.length,
      truncated: logs.length > maxLogs,
      originalCount: logs.length
    }
  };

  const json = JSON.stringify(exportData);
  const encoded = btoa(unescape(encodeURIComponent(json)));

  // Check size (URLs have practical limits)
  if (encoded.length > 8000) {
    throw new Error('Export too large for shareable link. Use file export instead.');
  }

  return `logtap://import?data=${encoded}`;
}

/**
 * Parse shareable link
 */
export function parseShareableLink(link) {
  const match = link.match(/logtap:\/\/import\?data=(.+)/);
  if (!match) {
    throw new Error('Invalid LogTap share link');
  }

  const decoded = decodeURIComponent(escape(atob(match[1])));
  const data = JSON.parse(decoded);

  if (data.magic !== LOGTAP_MAGIC) {
    throw new Error('Invalid LogTap share data');
  }

  return {
    logs: data.logs || [],
    metadata: data.metadata
  };
}

/**
 * Get export size estimate
 */
export function estimateExportSize(logs) {
  // Rough estimate: 500 bytes per log on average
  const estimate = logs.length * 500;

  // Compression typically achieves 5-10x
  const compressed = Math.round(estimate / 7);

  return {
    uncompressed: estimate,
    compressed,
    readable: formatBytes(compressed)
  };
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Validate logs before import
 */
export function validateImportedLogs(logs) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(logs)) {
    errors.push('Logs must be an array');
    return { valid: false, errors, warnings };
  }

  let validCount = 0;
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];

    if (!log || typeof log !== 'object') {
      warnings.push(`Log ${i}: Invalid log entry (not an object)`);
      continue;
    }

    // Must have at least a message or raw content
    if (!log.message && !log.raw) {
      warnings.push(`Log ${i}: Missing message content`);
    }

    // Validate timestamp if present
    if (log.timestamp && typeof log.timestamp !== 'number') {
      warnings.push(`Log ${i}: Invalid timestamp`);
    }

    validCount++;
  }

  if (validCount === 0) {
    errors.push('No valid logs found in import');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    validCount,
    totalCount: logs.length
  };
}

export { LOGTAP_VERSION, ANONYMIZE_PATTERNS };
