/**
 * LogTap 3.0 - Session Context Capture
 * Captures URL changes, user interactions, and network summaries
 * for richer debugging context
 */

const CONFIG = {
  // Maximum events to store
  maxEvents: 500,
  // Throttle for scroll events (ms)
  scrollThrottle: 500,
  // Throttle for resize events (ms)
  resizeThrottle: 500,
  // Network request timeout for tracking (ms)
  networkTimeout: 30000,
  // Maximum network requests to track
  maxNetworkRequests: 200
};

/**
 * Event types we capture
 */
const EVENT_TYPES = {
  NAVIGATION: 'navigation',
  CLICK: 'click',
  INPUT: 'input',
  SCROLL: 'scroll',
  RESIZE: 'resize',
  VISIBILITY: 'visibility',
  ERROR: 'error',
  NETWORK: 'network',
  CUSTOM: 'custom'
};

/**
 * Session Context class - captures user interactions and context
 */
export class SessionContext {
  constructor() {
    this.events = [];
    this.networkRequests = new Map(); // id -> request info
    this.listeners = [];
    this.isCapturing = false;
    this.sessionStart = Date.now();
    this.lastUrl = '';
    this.lastScrollTime = 0;
    this.lastResizeTime = 0;
  }

  /**
   * Start capturing context
   */
  start() {
    if (this.isCapturing) return;
    this.isCapturing = true;
    this.sessionStart = Date.now();

    // Record initial state
    this.recordNavigation(window.location.href, 'initial');

    // Set up listeners
    this.setupListeners();
  }

  /**
   * Stop capturing context
   */
  stop() {
    this.isCapturing = false;
    this.removeListeners();
  }

  /**
   * Reset captured context
   */
  reset() {
    this.events = [];
    this.networkRequests.clear();
    this.sessionStart = Date.now();
  }

  /**
   * Set up event listeners
   */
  setupListeners() {
    // Navigation
    const handlePopState = () => {
      this.recordNavigation(window.location.href, 'popstate');
    };

    // Click tracking
    const handleClick = (e) => {
      this.recordClick(e);
    };

    // Input tracking (for form interactions)
    const handleInput = (e) => {
      this.recordInput(e);
    };

    // Scroll tracking
    const handleScroll = () => {
      const now = Date.now();
      if (now - this.lastScrollTime < CONFIG.scrollThrottle) return;
      this.lastScrollTime = now;
      this.recordScroll();
    };

    // Resize tracking
    const handleResize = () => {
      const now = Date.now();
      if (now - this.lastResizeTime < CONFIG.resizeThrottle) return;
      this.lastResizeTime = now;
      this.recordResize();
    };

    // Visibility change
    const handleVisibility = () => {
      this.recordVisibility(document.visibilityState);
    };

    // Global errors
    const handleError = (e) => {
      this.recordError(e);
    };

    // Unhandled promise rejections
    const handleRejection = (e) => {
      this.recordError(e, 'unhandledrejection');
    };

    // Store listeners for cleanup
    this.listeners = [
      { target: window, type: 'popstate', handler: handlePopState },
      { target: document, type: 'click', handler: handleClick, options: { capture: true } },
      { target: document, type: 'input', handler: handleInput, options: { capture: true } },
      { target: window, type: 'scroll', handler: handleScroll, options: { passive: true } },
      { target: window, type: 'resize', handler: handleResize, options: { passive: true } },
      { target: document, type: 'visibilitychange', handler: handleVisibility },
      { target: window, type: 'error', handler: handleError },
      { target: window, type: 'unhandledrejection', handler: handleRejection }
    ];

    // Add listeners
    for (const { target, type, handler, options } of this.listeners) {
      target.addEventListener(type, handler, options);
    }

    // Intercept fetch and XHR for network tracking
    this.interceptNetwork();
  }

  /**
   * Remove event listeners
   */
  removeListeners() {
    for (const { target, type, handler, options } of this.listeners) {
      target.removeEventListener(type, handler, options);
    }
    this.listeners = [];
  }

  /**
   * Intercept network requests
   */
  interceptNetwork() {
    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const id = this.generateId();
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const method = args[1]?.method || 'GET';
      const startTime = Date.now();

      this.recordNetworkStart(id, method, url);

      try {
        const response = await originalFetch(...args);
        this.recordNetworkEnd(id, response.status, Date.now() - startTime);
        return response;
      } catch (error) {
        this.recordNetworkEnd(id, 0, Date.now() - startTime, error.message);
        throw error;
      }
    };

    // Intercept XHR
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const self = this;

    XMLHttpRequest.prototype.open = function (method, url) {
      this._logtap = {
        id: self.generateId(),
        method,
        url: url.toString(),
        startTime: 0
      };
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      if (this._logtap) {
        this._logtap.startTime = Date.now();
        self.recordNetworkStart(this._logtap.id, this._logtap.method, this._logtap.url);

        this.addEventListener('loadend', () => {
          const duration = Date.now() - this._logtap.startTime;
          self.recordNetworkEnd(this._logtap.id, this.status, duration);
        });

        this.addEventListener('error', () => {
          const duration = Date.now() - this._logtap.startTime;
          self.recordNetworkEnd(this._logtap.id, 0, duration, 'Network error');
        });
      }
      return originalSend.apply(this, arguments);
    };
  }

  /**
   * Generate unique ID
   */
  generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Add an event to the timeline
   */
  addEvent(type, data) {
    if (!this.isCapturing) return;

    const event = {
      id: this.generateId(),
      type,
      timestamp: Date.now(),
      relativeTime: Date.now() - this.sessionStart,
      ...data
    };

    this.events.push(event);

    // Trim if too many events
    while (this.events.length > CONFIG.maxEvents) {
      this.events.shift();
    }

    return event;
  }

  /**
   * Record navigation event
   */
  recordNavigation(url, trigger = 'unknown') {
    if (url === this.lastUrl) return;
    this.lastUrl = url;

    this.addEvent(EVENT_TYPES.NAVIGATION, {
      url,
      trigger,
      title: document.title
    });
  }

  /**
   * Record click event
   */
  recordClick(e) {
    const target = e.target;
    if (!target) return;

    // Get selector for the clicked element
    const selector = this.getSelector(target);
    const text = this.getElementText(target);

    this.addEvent(EVENT_TYPES.CLICK, {
      selector,
      text,
      tagName: target.tagName?.toLowerCase(),
      id: target.id || undefined,
      className: target.className || undefined,
      x: e.clientX,
      y: e.clientY
    });
  }

  /**
   * Record input event
   */
  recordInput(e) {
    const target = e.target;
    if (!target) return;

    // Don't record actual input values (privacy)
    const selector = this.getSelector(target);
    const inputType = target.type || 'text';

    // Skip password fields entirely
    if (inputType === 'password') return;

    this.addEvent(EVENT_TYPES.INPUT, {
      selector,
      tagName: target.tagName?.toLowerCase(),
      inputType,
      name: target.name || undefined,
      // Record length, not value
      valueLength: target.value?.length || 0
    });
  }

  /**
   * Record scroll event
   */
  recordScroll() {
    this.addEvent(EVENT_TYPES.SCROLL, {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      maxScrollY: document.documentElement.scrollHeight - window.innerHeight
    });
  }

  /**
   * Record resize event
   */
  recordResize() {
    this.addEvent(EVENT_TYPES.RESIZE, {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio
    });
  }

  /**
   * Record visibility change
   */
  recordVisibility(state) {
    this.addEvent(EVENT_TYPES.VISIBILITY, {
      state
    });
  }

  /**
   * Record error event
   */
  recordError(e, type = 'error') {
    this.addEvent(EVENT_TYPES.ERROR, {
      errorType: type,
      message: e.message || e.reason?.message || 'Unknown error',
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno
    });
  }

  /**
   * Record network request start
   */
  recordNetworkStart(id, method, url) {
    this.networkRequests.set(id, {
      id,
      method,
      url,
      startTime: Date.now(),
      status: 'pending'
    });

    // Cleanup old pending requests
    if (this.networkRequests.size > CONFIG.maxNetworkRequests) {
      const oldest = [...this.networkRequests.entries()]
        .sort((a, b) => a[1].startTime - b[1].startTime)[0];
      if (oldest) this.networkRequests.delete(oldest[0]);
    }
  }

  /**
   * Record network request end
   */
  recordNetworkEnd(id, status, duration, error = null) {
    const request = this.networkRequests.get(id);
    if (!request) return;

    request.status = error ? 'error' : 'complete';
    request.httpStatus = status;
    request.duration = duration;
    request.error = error;

    this.addEvent(EVENT_TYPES.NETWORK, {
      method: request.method,
      url: request.url,
      httpStatus: status,
      duration,
      error
    });

    // Clean up
    this.networkRequests.delete(id);
  }

  /**
   * Get a CSS selector for an element
   */
  getSelector(element) {
    if (!element) return '';

    // Try ID first
    if (element.id) {
      return `#${element.id}`;
    }

    // Try unique class
    if (element.className && typeof element.className === 'string') {
      const classes = element.className.trim().split(/\s+/).slice(0, 2);
      if (classes.length > 0) {
        const selector = `${element.tagName.toLowerCase()}.${classes.join('.')}`;
        // Check if unique
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }
    }

    // Build path
    const path = [];
    let current = element;
    while (current && current !== document.body && path.length < 4) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector = `#${current.id}`;
        path.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const firstClass = current.className.trim().split(/\s+/)[0];
        if (firstClass) {
          selector += `.${firstClass}`;
        }
      }
      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(' > ');
  }

  /**
   * Get text content from an element (truncated)
   */
  getElementText(element) {
    if (!element) return '';

    // Try common text sources
    const text = element.textContent ||
                 element.innerText ||
                 element.value ||
                 element.getAttribute('aria-label') ||
                 element.getAttribute('title') ||
                 '';

    return text.trim().slice(0, 50);
  }

  /**
   * Get events within a time range
   */
  getEvents(startTime = 0, endTime = Infinity) {
    return this.events.filter(e =>
      e.timestamp >= startTime && e.timestamp <= endTime
    );
  }

  /**
   * Get events near a specific log timestamp
   */
  getContextForLog(logTimestamp, windowMs = 5000) {
    const start = logTimestamp - windowMs;
    const end = logTimestamp + 1000; // Include 1s after

    return {
      before: this.events.filter(e => e.timestamp >= start && e.timestamp < logTimestamp),
      after: this.events.filter(e => e.timestamp >= logTimestamp && e.timestamp <= end)
    };
  }

  /**
   * Get summary statistics
   */
  getStats() {
    const typeCount = {};
    for (const event of this.events) {
      typeCount[event.type] = (typeCount[event.type] || 0) + 1;
    }

    const networkEvents = this.events.filter(e => e.type === EVENT_TYPES.NETWORK);
    const errorResponses = networkEvents.filter(e => e.httpStatus >= 400 || e.error);

    return {
      totalEvents: this.events.length,
      eventsByType: typeCount,
      sessionDuration: Date.now() - this.sessionStart,
      networkRequests: networkEvents.length,
      failedRequests: errorResponses.length,
      pendingRequests: this.networkRequests.size
    };
  }

  /**
   * Export session context
   */
  export() {
    return {
      version: 1,
      sessionStart: this.sessionStart,
      sessionDuration: Date.now() - this.sessionStart,
      events: this.events,
      stats: this.getStats()
    };
  }

  /**
   * Import session context
   */
  import(data) {
    if (!data?.version || !data.events) return false;

    this.events = data.events;
    this.sessionStart = data.sessionStart || Date.now();
    return true;
  }
}

// Singleton instance
let context = null;

export function getSessionContext() {
  if (!context) {
    context = new SessionContext();
  }
  return context;
}

export function startContextCapture() {
  getSessionContext().start();
}

export function stopContextCapture() {
  getSessionContext().stop();
}

export function getContextForLog(logTimestamp) {
  return getSessionContext().getContextForLog(logTimestamp);
}

export { CONFIG, EVENT_TYPES };
