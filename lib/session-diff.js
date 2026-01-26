/**
 * LogTap 3.0 - Session Diff
 * Compare two debugging sessions to find differences
 */

/**
 * Create a normalized signature for a log entry (for comparison)
 */
function normalizeLog(log) {
  let message = log.message || '';

  // Remove dynamic values
  message = message
    // Timestamps
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, '<TIMESTAMP>')
    .replace(/\d{2}:\d{2}:\d{2}[.\d]*/g, '<TIME>')
    // UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    // Hex IDs
    .replace(/\b[0-9a-f]{24,}\b/gi, '<ID>')
    // Large numbers (keep small ones like status codes)
    .replace(/\b\d{5,}\b/g, '<NUM>')
    // URLs
    .replace(/https?:\/\/[^\s"']+/gi, '<URL>')
    // IPs
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();

  return {
    level: log.level || 'info',
    tag: log.tag || '',
    message,
    file: log.file || ''
  };
}

/**
 * Create a hash key for a normalized log
 */
function hashLog(normalized) {
  return `${normalized.level}|${normalized.tag}|${normalized.message}`;
}

/**
 * Compare two sessions and find differences
 *
 * Returns:
 * - onlyInA: logs that appear in session A but not B
 * - onlyInB: logs that appear in session B but not A
 * - inBoth: logs that appear in both sessions
 * - frequencyChanges: logs with significantly different frequencies
 * - newErrors: error logs that are only in session B
 * - resolvedErrors: error logs that were in A but not in B
 */
export function diffSessions(sessionA, sessionB, options = {}) {
  const {
    // Minimum frequency change ratio to report (e.g., 2 = 2x more frequent)
    frequencyThreshold = 2,
    // Include sequence differences (expensive)
    analyzeSequences = false,
    // Maximum logs to compare (for performance)
    maxLogs = 10000
  } = options;

  // Limit logs if necessary
  const logsA = sessionA.logs?.slice(-maxLogs) || sessionA.slice?.(-maxLogs) || [];
  const logsB = sessionB.logs?.slice(-maxLogs) || sessionB.slice?.(-maxLogs) || [];

  // Build frequency maps
  const freqA = new Map(); // hash -> { count, samples }
  const freqB = new Map();

  for (const log of logsA) {
    const normalized = normalizeLog(log);
    const hash = hashLog(normalized);
    if (!freqA.has(hash)) {
      freqA.set(hash, { count: 0, normalized, samples: [] });
    }
    const entry = freqA.get(hash);
    entry.count++;
    if (entry.samples.length < 3) entry.samples.push(log);
  }

  for (const log of logsB) {
    const normalized = normalizeLog(log);
    const hash = hashLog(normalized);
    if (!freqB.has(hash)) {
      freqB.set(hash, { count: 0, normalized, samples: [] });
    }
    const entry = freqB.get(hash);
    entry.count++;
    if (entry.samples.length < 3) entry.samples.push(log);
  }

  // Find differences
  const onlyInA = [];
  const onlyInB = [];
  const inBoth = [];
  const frequencyChanges = [];
  const newErrors = [];
  const resolvedErrors = [];

  // Check logs in A
  for (const [hash, entryA] of freqA) {
    const entryB = freqB.get(hash);

    if (!entryB) {
      onlyInA.push({
        hash,
        ...entryA.normalized,
        count: entryA.count,
        samples: entryA.samples
      });

      // Track resolved errors
      if (entryA.normalized.level === 'error') {
        resolvedErrors.push({
          hash,
          ...entryA.normalized,
          count: entryA.count,
          samples: entryA.samples
        });
      }
    } else {
      // In both - check frequency change
      const ratio = entryB.count / entryA.count;

      if (ratio >= frequencyThreshold || ratio <= 1 / frequencyThreshold) {
        frequencyChanges.push({
          hash,
          ...entryA.normalized,
          countA: entryA.count,
          countB: entryB.count,
          ratio: ratio.toFixed(2),
          direction: ratio > 1 ? 'increased' : 'decreased',
          samplesA: entryA.samples,
          samplesB: entryB.samples
        });
      }

      inBoth.push({
        hash,
        ...entryA.normalized,
        countA: entryA.count,
        countB: entryB.count
      });
    }
  }

  // Check logs only in B
  for (const [hash, entryB] of freqB) {
    if (!freqA.has(hash)) {
      onlyInB.push({
        hash,
        ...entryB.normalized,
        count: entryB.count,
        samples: entryB.samples
      });

      // Track new errors
      if (entryB.normalized.level === 'error') {
        newErrors.push({
          hash,
          ...entryB.normalized,
          count: entryB.count,
          samples: entryB.samples
        });
      }
    }
  }

  // Optional: Analyze sequence differences
  let sequenceChanges = null;
  if (analyzeSequences) {
    sequenceChanges = analyzeSequenceDiff(logsA, logsB);
  }

  // Calculate summary stats
  const summary = {
    sessionA: {
      totalLogs: logsA.length,
      uniquePatterns: freqA.size,
      errorCount: logsA.filter(l => l.level === 'error').length
    },
    sessionB: {
      totalLogs: logsB.length,
      uniquePatterns: freqB.size,
      errorCount: logsB.filter(l => l.level === 'error').length
    },
    diff: {
      onlyInA: onlyInA.length,
      onlyInB: onlyInB.length,
      inBoth: inBoth.length,
      frequencyChanges: frequencyChanges.length,
      newErrors: newErrors.length,
      resolvedErrors: resolvedErrors.length
    }
  };

  return {
    summary,
    onlyInA,
    onlyInB,
    inBoth,
    frequencyChanges,
    newErrors,
    resolvedErrors,
    sequenceChanges
  };
}

/**
 * Analyze sequence differences between sessions
 */
function analyzeSequenceDiff(logsA, logsB) {
  // Extract common sequences (simplified LCS-like approach)
  const seqLength = 3;
  const seqA = new Set();
  const seqB = new Set();

  // Build sequences from A
  for (let i = 0; i <= logsA.length - seqLength; i++) {
    const seq = logsA.slice(i, i + seqLength)
      .map(l => normalizeLog(l))
      .map(n => hashLog(n))
      .join('→');
    seqA.add(seq);
  }

  // Build sequences from B
  for (let i = 0; i <= logsB.length - seqLength; i++) {
    const seq = logsB.slice(i, i + seqLength)
      .map(l => normalizeLog(l))
      .map(n => hashLog(n))
      .join('→');
    seqB.add(seq);
  }

  // Find unique sequences
  const onlyInA = [...seqA].filter(s => !seqB.has(s));
  const onlyInB = [...seqB].filter(s => !seqA.has(s));

  return {
    sequencesOnlyInA: onlyInA.slice(0, 10),
    sequencesOnlyInB: onlyInB.slice(0, 10),
    commonSequences: [...seqA].filter(s => seqB.has(s)).length
  };
}

/**
 * Generate a human-readable diff report
 */
export function generateDiffReport(diff) {
  const lines = [];

  lines.push('# Session Comparison Report');
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Session A | Session B |');
  lines.push('|--------|-----------|-----------|');
  lines.push(`| Total Logs | ${diff.summary.sessionA.totalLogs} | ${diff.summary.sessionB.totalLogs} |`);
  lines.push(`| Unique Patterns | ${diff.summary.sessionA.uniquePatterns} | ${diff.summary.sessionB.uniquePatterns} |`);
  lines.push(`| Error Count | ${diff.summary.sessionA.errorCount} | ${diff.summary.sessionB.errorCount} |`);
  lines.push('');

  // New errors (most important)
  if (diff.newErrors.length > 0) {
    lines.push('## 🔴 New Errors (only in Session B)');
    lines.push('');
    for (const error of diff.newErrors.slice(0, 10)) {
      lines.push(`- **[${error.tag || 'no tag'}]** ${error.message.slice(0, 100)}${error.message.length > 100 ? '...' : ''} (${error.count}x)`);
    }
    lines.push('');
  }

  // Resolved errors
  if (diff.resolvedErrors.length > 0) {
    lines.push('## 🟢 Resolved Errors (only in Session A)');
    lines.push('');
    for (const error of diff.resolvedErrors.slice(0, 10)) {
      lines.push(`- **[${error.tag || 'no tag'}]** ${error.message.slice(0, 100)}${error.message.length > 100 ? '...' : ''} (was ${error.count}x)`);
    }
    lines.push('');
  }

  // Frequency changes
  if (diff.frequencyChanges.length > 0) {
    lines.push('## 📊 Frequency Changes');
    lines.push('');
    const sorted = [...diff.frequencyChanges].sort((a, b) =>
      Math.abs(parseFloat(b.ratio) - 1) - Math.abs(parseFloat(a.ratio) - 1)
    );
    for (const change of sorted.slice(0, 10)) {
      const arrow = change.direction === 'increased' ? '📈' : '📉';
      lines.push(`- ${arrow} **[${change.tag || 'no tag'}]** ${change.message.slice(0, 60)}... (${change.countA} → ${change.countB}, ${change.ratio}x)`);
    }
    lines.push('');
  }

  // Only in B (new logs)
  if (diff.onlyInB.length > 0) {
    lines.push('## 🆕 New Log Patterns (only in Session B)');
    lines.push('');
    for (const log of diff.onlyInB.slice(0, 10)) {
      lines.push(`- **[${log.level}]** [${log.tag || 'no tag'}] ${log.message.slice(0, 80)}... (${log.count}x)`);
    }
    if (diff.onlyInB.length > 10) {
      lines.push(`- ... and ${diff.onlyInB.length - 10} more`);
    }
    lines.push('');
  }

  // Only in A (missing logs)
  if (diff.onlyInA.length > 0) {
    lines.push('## ❌ Missing Log Patterns (only in Session A)');
    lines.push('');
    for (const log of diff.onlyInA.slice(0, 10)) {
      lines.push(`- **[${log.level}]** [${log.tag || 'no tag'}] ${log.message.slice(0, 80)}... (was ${log.count}x)`);
    }
    if (diff.onlyInA.length > 10) {
      lines.push(`- ... and ${diff.onlyInA.length - 10} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Quick comparison - just return key differences
 */
export function quickDiff(sessionA, sessionB) {
  const full = diffSessions(sessionA, sessionB);

  return {
    hasNewErrors: full.newErrors.length > 0,
    hasResolvedErrors: full.resolvedErrors.length > 0,
    newErrorCount: full.newErrors.length,
    resolvedErrorCount: full.resolvedErrors.length,
    significantChanges: full.frequencyChanges.length,
    newPatterns: full.onlyInB.length,
    missingPatterns: full.onlyInA.length,
    // Most important findings
    topNewErrors: full.newErrors.slice(0, 3),
    topResolvedErrors: full.resolvedErrors.slice(0, 3),
    topFrequencyChanges: full.frequencyChanges
      .sort((a, b) => Math.abs(parseFloat(b.ratio) - 1) - Math.abs(parseFloat(a.ratio) - 1))
      .slice(0, 3)
  };
}

export { normalizeLog, hashLog };
