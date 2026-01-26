/**
 * LogTap 3.0 - Anomaly Detector
 * Baseline learning and outlier detection for log patterns
 */

const CONFIG = {
  baselineSize: 1000,        // Logs needed before anomaly detection activates
  windowSize: 100,           // Rolling window for rate calculations
  errorSpikeThreshold: 3,    // 3x normal error rate = spike
  newTagCooldown: 5 * 60 * 1000, // 5 minutes before flagging new tags again
  burstThreshold: 10,        // 10 identical messages in burst window
  burstWindow: 1000,         // 1 second burst detection window
  rateWindow: 60 * 1000      // 1 minute for rate calculations
};

/**
 * Anomaly Detector class for maintaining baseline and detecting outliers
 */
export class AnomalyDetector {
  constructor() {
    this.reset();
  }

  /**
   * Reset all baseline data
   */
  reset() {
    this.baseline = {
      totalLogs: 0,
      levelCounts: { info: 0, warn: 0, error: 0, debug: 0 },
      tagCounts: {},
      messageHashes: new Map(), // hash -> count
      hourlyRates: new Array(24).fill(0),
      isEstablished: false
    };

    this.recent = {
      timestamps: [],
      levels: [],
      tags: [],
      messageHashes: []
    };

    this.knownTags = new Set();
    this.lastNewTagAlert = 0;
    this.recentBursts = new Map(); // hash -> { count, firstSeen }
  }

  /**
   * Add a log entry and check for anomalies
   */
  analyze(log) {
    const anomalies = [];
    const now = Date.now();
    const timestamp = log.timestamp || now;

    // Update baseline
    this.updateBaseline(log, timestamp);

    // Only detect anomalies after baseline is established
    if (!this.baseline.isEstablished) {
      if (this.baseline.totalLogs >= CONFIG.baselineSize) {
        this.baseline.isEstablished = true;
      }
      return anomalies;
    }

    // Check for error spike
    const errorSpike = this.detectErrorSpike(log);
    if (errorSpike) anomalies.push(errorSpike);

    // Check for new/unusual tag
    const newTag = this.detectNewTag(log, now);
    if (newTag) anomalies.push(newTag);

    // Check for message burst (spam)
    const burst = this.detectBurst(log, timestamp);
    if (burst) anomalies.push(burst);

    // Check for unusual rate
    const rateAnomaly = this.detectRateAnomaly(timestamp);
    if (rateAnomaly) anomalies.push(rateAnomaly);

    return anomalies;
  }

  /**
   * Update baseline statistics
   */
  updateBaseline(log, timestamp) {
    this.baseline.totalLogs++;

    // Level counts
    const level = log.level || 'info';
    this.baseline.levelCounts[level] = (this.baseline.levelCounts[level] || 0) + 1;

    // Tag counts
    if (log.tag) {
      this.baseline.tagCounts[log.tag] = (this.baseline.tagCounts[log.tag] || 0) + 1;
      this.knownTags.add(log.tag);
    }

    // Message hash for pattern detection
    const hash = this.hashMessage(log.message || '');
    this.baseline.messageHashes.set(hash, (this.baseline.messageHashes.get(hash) || 0) + 1);

    // Keep messageHashes from growing unbounded
    if (this.baseline.messageHashes.size > 10000) {
      // Remove least common hashes
      const sorted = [...this.baseline.messageHashes.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < 5000; i++) {
        this.baseline.messageHashes.delete(sorted[i][0]);
      }
    }

    // Hourly distribution
    const hour = new Date(timestamp).getHours();
    this.baseline.hourlyRates[hour]++;

    // Update recent window
    this.recent.timestamps.push(timestamp);
    this.recent.levels.push(level);
    this.recent.tags.push(log.tag || '');
    this.recent.messageHashes.push(hash);

    // Trim recent window
    while (this.recent.timestamps.length > CONFIG.windowSize) {
      this.recent.timestamps.shift();
      this.recent.levels.shift();
      this.recent.tags.shift();
      this.recent.messageHashes.shift();
    }
  }

  /**
   * Detect error rate spikes
   */
  detectErrorSpike(log) {
    if (log.level !== 'error') return null;

    // Calculate baseline error rate
    const totalBaseline = this.baseline.totalLogs;
    const errorBaseline = this.baseline.levelCounts.error || 0;
    const baselineErrorRate = errorBaseline / totalBaseline;

    // Calculate recent error rate
    const recentErrors = this.recent.levels.filter(l => l === 'error').length;
    const recentRate = recentErrors / this.recent.levels.length;

    // Check if current rate is significantly higher
    if (recentRate > baselineErrorRate * CONFIG.errorSpikeThreshold && recentErrors >= 3) {
      return {
        type: 'error_spike',
        severity: 'high',
        message: `Error spike detected (${recentErrors} errors in ${this.recent.levels.length} logs)`,
        details: {
          recentErrors,
          recentRate: (recentRate * 100).toFixed(1) + '%',
          baselineRate: (baselineErrorRate * 100).toFixed(1) + '%',
          multiplier: (recentRate / baselineErrorRate).toFixed(1) + 'x'
        }
      };
    }

    return null;
  }

  /**
   * Detect new or unusual tags
   */
  detectNewTag(log, now) {
    if (!log.tag) return null;

    // Check cooldown
    if (now - this.lastNewTagAlert < CONFIG.newTagCooldown) return null;

    // Check if tag is new
    if (!this.knownTags.has(log.tag)) {
      this.lastNewTagAlert = now;
      return {
        type: 'new_tag',
        severity: 'low',
        message: `New tag appeared: "${log.tag}"`,
        details: {
          tag: log.tag,
          knownTags: this.knownTags.size
        }
      };
    }

    // Check if tag is unusually rare
    const tagCount = this.baseline.tagCounts[log.tag] || 0;
    const avgTagCount = this.baseline.totalLogs / Math.max(this.knownTags.size, 1);

    if (tagCount < avgTagCount * 0.01 && this.baseline.totalLogs > 1000) {
      // Tag appears in less than 1% of logs
      return {
        type: 'rare_tag',
        severity: 'low',
        message: `Unusual tag: "${log.tag}" (rarely seen)`,
        details: {
          tag: log.tag,
          occurrences: tagCount,
          percentage: ((tagCount / this.baseline.totalLogs) * 100).toFixed(2) + '%'
        }
      };
    }

    return null;
  }

  /**
   * Detect message bursts (same message repeated rapidly)
   */
  detectBurst(log, timestamp) {
    const hash = this.hashMessage(log.message || '');

    // Get or create burst tracker
    let burst = this.recentBursts.get(hash);
    if (!burst || timestamp - burst.firstSeen > CONFIG.burstWindow) {
      burst = { count: 0, firstSeen: timestamp };
    }

    burst.count++;
    this.recentBursts.set(hash, burst);

    // Clean old bursts
    for (const [h, b] of this.recentBursts) {
      if (timestamp - b.firstSeen > CONFIG.burstWindow * 2) {
        this.recentBursts.delete(h);
      }
    }

    // Check threshold
    if (burst.count === CONFIG.burstThreshold) {
      return {
        type: 'burst',
        severity: 'medium',
        message: `Log spam detected: ${burst.count} identical messages in ${CONFIG.burstWindow}ms`,
        details: {
          count: burst.count,
          window: CONFIG.burstWindow + 'ms',
          messagePreview: (log.message || '').slice(0, 50)
        }
      };
    }

    return null;
  }

  /**
   * Detect unusual logging rate
   */
  detectRateAnomaly(timestamp) {
    // Need enough data
    if (this.recent.timestamps.length < 10) return null;

    // Calculate logs per minute in recent window
    const oldestRecent = this.recent.timestamps[0];
    const windowMs = timestamp - oldestRecent;
    if (windowMs < 1000) return null;

    const recentRate = (this.recent.timestamps.length / windowMs) * 60 * 1000; // per minute

    // Calculate baseline rate
    const hour = new Date(timestamp).getHours();
    const hourlyTotal = this.baseline.hourlyRates[hour];
    // Estimate baseline rate (very rough)
    const avgLogsPerHour = this.baseline.totalLogs / 24;
    const baselineRate = avgLogsPerHour / 60; // per minute

    // High rate anomaly (5x baseline)
    if (recentRate > baselineRate * 5 && recentRate > 100) {
      return {
        type: 'high_rate',
        severity: 'medium',
        message: `Unusual logging rate: ${recentRate.toFixed(0)} logs/min (normally ~${baselineRate.toFixed(0)})`,
        details: {
          currentRate: recentRate.toFixed(0) + '/min',
          baselineRate: baselineRate.toFixed(0) + '/min',
          multiplier: (recentRate / baselineRate).toFixed(1) + 'x'
        }
      };
    }

    return null;
  }

  /**
   * Simple hash function for message deduplication
   */
  hashMessage(message) {
    if (!message) return 0;
    let hash = 0;
    for (let i = 0; i < message.length && i < 200; i++) {
      const char = message.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }

  /**
   * Get baseline statistics
   */
  getStats() {
    const total = this.baseline.totalLogs;
    if (total === 0) {
      return {
        isEstablished: false,
        totalLogs: 0,
        levelDistribution: {},
        topTags: [],
        uniqueMessages: 0
      };
    }

    // Level distribution as percentages
    const levelDistribution = {};
    for (const [level, count] of Object.entries(this.baseline.levelCounts)) {
      levelDistribution[level] = {
        count,
        percentage: ((count / total) * 100).toFixed(1) + '%'
      };
    }

    // Top tags
    const topTags = Object.entries(this.baseline.tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({
        tag,
        count,
        percentage: ((count / total) * 100).toFixed(1) + '%'
      }));

    return {
      isEstablished: this.baseline.isEstablished,
      totalLogs: total,
      levelDistribution,
      topTags,
      uniqueMessages: this.baseline.messageHashes.size,
      knownTags: this.knownTags.size
    };
  }

  /**
   * Export baseline for persistence
   */
  exportBaseline() {
    return {
      version: 1,
      exported: Date.now(),
      baseline: {
        totalLogs: this.baseline.totalLogs,
        levelCounts: { ...this.baseline.levelCounts },
        tagCounts: { ...this.baseline.tagCounts },
        hourlyRates: [...this.baseline.hourlyRates],
        isEstablished: this.baseline.isEstablished
      },
      knownTags: [...this.knownTags]
    };
  }

  /**
   * Import baseline from persistence
   */
  importBaseline(data) {
    if (!data?.version || !data.baseline) {
      throw new Error('Invalid baseline data');
    }

    this.baseline = {
      totalLogs: data.baseline.totalLogs || 0,
      levelCounts: data.baseline.levelCounts || { info: 0, warn: 0, error: 0, debug: 0 },
      tagCounts: data.baseline.tagCounts || {},
      hourlyRates: data.baseline.hourlyRates || new Array(24).fill(0),
      messageHashes: new Map(),
      isEstablished: data.baseline.isEstablished || false
    };

    this.knownTags = new Set(data.knownTags || []);
  }
}

/**
 * Singleton instance for shared use
 */
let detector = null;

export function getDetector() {
  if (!detector) {
    detector = new AnomalyDetector();
  }
  return detector;
}

export function resetDetector() {
  if (detector) {
    detector.reset();
  }
}

/**
 * Convenience function to analyze a single log
 */
export function analyzeLog(log) {
  return getDetector().analyze(log);
}

/**
 * Convenience function to get stats
 */
export function getAnomalyStats() {
  return getDetector().getStats();
}

export { CONFIG };
