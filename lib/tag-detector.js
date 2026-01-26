/**
 * LogTap 3.0 - Tag Detector
 * Universal tag extraction from log messages
 */

/**
 * Detect tag from console.log arguments
 */
export function detectTag(args) {
  if (!args?.length) return '';

  const firstArg = args[0];

  // Structured object fields (highest priority)
  if (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)) {
    if (firstArg.event) return String(firstArg.event).replace(/_/g, '-').toLowerCase();
    if (firstArg.action) return String(firstArg.action).toLowerCase();
    if (firstArg.tag) return String(firstArg.tag);
    if (firstArg.type && typeof firstArg.type === 'string') return String(firstArg.type).toLowerCase();
    if (firstArg.category) return String(firstArg.category).toLowerCase();
    if (firstArg.component) return String(firstArg.component).toLowerCase();
    if (firstArg.module) return String(firstArg.module).toLowerCase();
  }

  const firstStr = String(firstArg || '');

  // Try JSON parsing
  if (firstStr.startsWith('{')) {
    try {
      const parsed = JSON.parse(firstStr);
      if (parsed?.event) return String(parsed.event).replace(/_/g, '-').toLowerCase();
      if (parsed?.action) return String(parsed.action).toLowerCase();
      if (parsed?.tag) return String(parsed.tag);
      if (parsed?.type) return String(parsed.type).toLowerCase();
    } catch {}
  }

  // Bracket prefix: [Tag] message
  const bracketMatch = firstStr.match(/^\[([^\]]+)\]\s*/);
  if (bracketMatch) return bracketMatch[1];

  // Colon prefix: Tag: message
  const colonMatch = firstStr.match(/^([A-Za-z][\w-]{1,20}):\s/);
  if (colonMatch) return colonMatch[1];

  // Arrow prefix: Tag → message
  const arrowMatch = firstStr.match(/^([A-Za-z][\w-]{1,20})\s*[→>]\s/);
  if (arrowMatch) return arrowMatch[1];

  return '';
}

/**
 * Detect log level from method and content
 */
export function detectLevel(method, message, tag, args) {
  // Method-based (highest priority)
  if (method === 'error') return 'error';
  if (method === 'warn') return 'warn';
  if (method === 'debug') return 'debug';

  const firstArg = args?.[0];

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

/**
 * Get timestamp string
 */
export function getTimestamp() {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
