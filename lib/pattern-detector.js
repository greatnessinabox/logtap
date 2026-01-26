/**
 * LogTap 3.0 - Pattern Detector
 * Detects recurring sequences of logs that may indicate systemic issues
 */

const CONFIG = {
  // Minimum times a pattern must occur to be reported
  minOccurrences: 3,
  // Maximum logs in a pattern sequence
  maxPatternLength: 5,
  // Time window for pattern matching (logs must occur within this window)
  patternWindowMs: 5000,
  // How many recent patterns to track
  maxTrackedPatterns: 100,
  // Similarity threshold for fuzzy matching (0-1)
  similarityThreshold: 0.8
};

/**
 * Create a signature for a log (for pattern matching)
 */
function createLogSignature(log) {
  const level = log.level || 'info';
  const tag = log.tag || '';

  // Normalize message by removing dynamic parts
  let message = log.message || '';

  // Remove timestamps
  message = message.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, '<TIME>');
  message = message.replace(/\d{2}:\d{2}:\d{2}[.\d]*/g, '<TIME>');

  // Remove UUIDs
  message = message.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');

  // Remove hex IDs
  message = message.replace(/\b[0-9a-f]{24,}\b/gi, '<ID>');

  // Remove numbers (but keep status codes)
  message = message.replace(/(?<!\d)\d{4,}(?!\d)/g, '<NUM>');

  // Remove URLs
  message = message.replace(/https?:\/\/[^\s]+/g, '<URL>');

  // Remove IP addresses
  message = message.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>');

  // Remove email addresses
  message = message.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '<EMAIL>');

  // Collapse whitespace
  message = message.replace(/\s+/g, ' ').trim();

  // Truncate for comparison
  message = message.slice(0, 100);

  return `${level}:${tag}:${message}`;
}

/**
 * Calculate similarity between two strings (Jaccard similarity on words)
 */
function calculateSimilarity(str1, str2) {
  if (str1 === str2) return 1;
  if (!str1 || !str2) return 0;

  const words1 = new Set(str1.toLowerCase().split(/\W+/).filter(Boolean));
  const words2 = new Set(str2.toLowerCase().split(/\W+/).filter(Boolean));

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * Pattern Detector class
 */
export class PatternDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.signatures = []; // Recent log signatures with timestamps
    this.patterns = new Map(); // signature sequence -> { count, lastSeen, logs }
    this.reportedPatterns = new Set(); // Patterns we've already reported
  }

  /**
   * Add a log and check for patterns
   * Returns detected pattern if found, null otherwise
   */
  analyze(log) {
    const signature = createLogSignature(log);
    const timestamp = log.timestamp || Date.now();

    // Add to recent signatures
    this.signatures.push({ signature, timestamp, log });

    // Trim old signatures
    const cutoff = timestamp - CONFIG.patternWindowMs * 10;
    while (this.signatures.length > 0 && this.signatures[0].timestamp < cutoff) {
      this.signatures.shift();
    }

    // Look for patterns ending with this log
    const detectedPatterns = this.detectPatterns(signature, timestamp);

    // Return most significant pattern
    if (detectedPatterns.length > 0) {
      // Sort by occurrence count * pattern length (longer, more frequent = more significant)
      detectedPatterns.sort((a, b) => {
        const scoreA = a.count * a.sequence.length;
        const scoreB = b.count * b.sequence.length;
        return scoreB - scoreA;
      });
      return detectedPatterns[0];
    }

    return null;
  }

  /**
   * Detect patterns ending with the given signature
   */
  detectPatterns(currentSig, currentTime) {
    const detected = [];

    // Try different pattern lengths
    for (let len = 2; len <= CONFIG.maxPatternLength; len++) {
      // Get the last `len` signatures
      const recent = this.signatures.slice(-len);
      if (recent.length < len) continue;

      // Check if they're within the time window
      const timeSpan = recent[recent.length - 1].timestamp - recent[0].timestamp;
      if (timeSpan > CONFIG.patternWindowMs) continue;

      // Create pattern key
      const sequence = recent.map(s => s.signature);
      const patternKey = sequence.join('|||');

      // Update pattern tracking
      if (!this.patterns.has(patternKey)) {
        this.patterns.set(patternKey, {
          sequence,
          count: 0,
          occurrences: [],
          firstSeen: currentTime
        });
      }

      const pattern = this.patterns.get(patternKey);
      pattern.count++;
      pattern.lastSeen = currentTime;
      pattern.occurrences.push({
        timestamp: currentTime,
        logs: recent.map(s => s.log)
      });

      // Trim old occurrences
      while (pattern.occurrences.length > 20) {
        pattern.occurrences.shift();
      }

      // Check if pattern meets threshold and hasn't been reported recently
      const reportKey = `${patternKey}:${Math.floor(currentTime / 60000)}`; // Report at most once per minute
      if (pattern.count >= CONFIG.minOccurrences && !this.reportedPatterns.has(reportKey)) {
        this.reportedPatterns.add(reportKey);

        detected.push({
          type: 'recurring_pattern',
          severity: this.getPatternSeverity(pattern),
          sequence: pattern.sequence,
          count: pattern.count,
          message: this.formatPatternMessage(pattern),
          details: {
            patternLength: sequence.length,
            totalOccurrences: pattern.count,
            timeSpan: `${Math.round((currentTime - pattern.firstSeen) / 1000)}s`,
            sampleLogs: pattern.occurrences[pattern.occurrences.length - 1]?.logs || []
          }
        });
      }
    }

    // Limit tracked patterns
    if (this.patterns.size > CONFIG.maxTrackedPatterns) {
      // Remove oldest patterns
      const sorted = [...this.patterns.entries()]
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen);

      for (let i = 0; i < sorted.length - CONFIG.maxTrackedPatterns; i++) {
        this.patterns.delete(sorted[i][0]);
      }
    }

    return detected;
  }

  /**
   * Determine pattern severity based on contents
   */
  getPatternSeverity(pattern) {
    const hasError = pattern.sequence.some(s => s.startsWith('error:'));
    const hasWarn = pattern.sequence.some(s => s.startsWith('warn:'));
    const highFrequency = pattern.count >= 10;

    if (hasError && highFrequency) return 'high';
    if (hasError || (hasWarn && highFrequency)) return 'medium';
    return 'low';
  }

  /**
   * Format a human-readable pattern message
   */
  formatPatternMessage(pattern) {
    const len = pattern.sequence.length;
    const count = pattern.count;

    // Extract meaningful parts from signatures
    const steps = pattern.sequence.map(sig => {
      const parts = sig.split(':');
      const level = parts[0];
      const tag = parts[1] || '';
      const msg = parts.slice(2).join(':').slice(0, 30);
      return tag ? `[${tag}] ${msg}` : msg;
    });

    return `Recurring ${len}-step pattern detected (${count}x): ${steps[0]} → ... → ${steps[steps.length - 1]}`;
  }

  /**
   * Get all known patterns sorted by significance
   */
  getPatterns() {
    return [...this.patterns.values()]
      .filter(p => p.count >= CONFIG.minOccurrences)
      .map(p => ({
        sequence: p.sequence,
        count: p.count,
        severity: this.getPatternSeverity(p),
        message: this.formatPatternMessage(p),
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen
      }))
      .sort((a, b) => (b.count * b.sequence.length) - (a.count * a.sequence.length));
  }

  /**
   * Get statistics
   */
  getStats() {
    const patterns = this.getPatterns();
    return {
      trackedSignatures: this.signatures.length,
      uniquePatterns: this.patterns.size,
      significantPatterns: patterns.length,
      topPatterns: patterns.slice(0, 5)
    };
  }

  /**
   * Export state for persistence
   */
  export() {
    return {
      version: 1,
      patterns: [...this.patterns.entries()].map(([key, value]) => ({
        key,
        ...value,
        occurrences: value.occurrences.slice(-5) // Only keep recent occurrences
      }))
    };
  }

  /**
   * Import state from persistence
   */
  import(data) {
    if (!data?.version || !data.patterns) return;

    this.patterns.clear();
    for (const p of data.patterns) {
      this.patterns.set(p.key, {
        sequence: p.sequence,
        count: p.count,
        occurrences: p.occurrences || [],
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen
      });
    }
  }
}

// Singleton instance
let detector = null;

export function getPatternDetector() {
  if (!detector) {
    detector = new PatternDetector();
  }
  return detector;
}

export function resetPatternDetector() {
  if (detector) {
    detector.reset();
  }
}

export function analyzeForPatterns(log) {
  return getPatternDetector().analyze(log);
}

export { CONFIG, createLogSignature, calculateSimilarity };
