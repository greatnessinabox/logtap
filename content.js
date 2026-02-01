/**
 * LogTap 3.0 - Content Script
 * Bridge between page context (injected.js) and extension context
 * Handles IndexedDB persistence and cross-tab communication
 */

// Silent logger - prevents extension debug output from polluting error pages
const DEBUG = false;
const log = DEBUG ? console.debug.bind(console, '[LogTap]') : () => {};

// Inject the console interceptor
const hookSrc = chrome.runtime.getURL('injected.js');
const s = document.createElement('script');
s.src = hookSrc;
s.async = false;
(document.documentElement || document.head).appendChild(s);
s.parentNode.removeChild(s);

// ============ State ============
let buffer = [];
let captureEnabled = true;
const MAX_BUFFER = 10000;

// Session info
let currentSessionId = null;
let tabId = null;

// IndexedDB for persistence
const DB_NAME = 'LogTapDB';
const DB_VERSION = 1;
let db = null;
let writeQueue = [];
let writeTimer = null;
const BATCH_SIZE = 50;
const BATCH_DELAY = 100;

// ============ IndexedDB Setup ============
const DB_TIMEOUT = 3000;

async function initDB() {
  if (db) return db;

  const dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        log('IndexedDB not available, using memory only');
        resolve(null);
      };

      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const database = event.target.result;

        if (!database.objectStoreNames.contains('logs')) {
          const logsStore = database.createObjectStore('logs', {
            keyPath: 'id',
            autoIncrement: true
          });
          logsStore.createIndex('timestamp', 'timestamp', { unique: false });
          logsStore.createIndex('sessionId', 'sessionId', { unique: false });
          logsStore.createIndex('level', 'level', { unique: false });
          logsStore.createIndex('tag', 'tag', { unique: false });
          logsStore.createIndex('tabId', 'tabId', { unique: false });
          logsStore.createIndex('session_time', ['sessionId', 'timestamp'], { unique: false });
        }

        if (!database.objectStoreNames.contains('sessions')) {
          const sessionsStore = database.createObjectStore('sessions', { keyPath: 'id' });
          sessionsStore.createIndex('created', 'created', { unique: false });
          sessionsStore.createIndex('url', 'url', { unique: false });
        }
      };
    } catch {
      resolve(null);
    }
  });

  // Race against timeout to prevent hanging
  return Promise.race([
    dbPromise,
    new Promise((resolve) => setTimeout(() => {
      log('IndexedDB init timed out, using memory only');
      resolve(null);
    }, DB_TIMEOUT))
  ]);
}

// ============ Session Management ============
async function createSession() {
  if (!db) return null;

  currentSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const session = {
    id: currentSessionId,
    created: Date.now(),
    url: window.location.href,
    title: document.title,
    tabId: tabId,
    logCount: 0,
    lastActivity: Date.now()
  };

  return new Promise((resolve) => {
    try {
      const tx = db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      store.add(session);
      tx.oncomplete = () => resolve(session);
      tx.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function updateSessionLogCount(count) {
  if (!db || !currentSessionId) return;

  try {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const getReq = store.get(currentSessionId);

    getReq.onsuccess = () => {
      const session = getReq.result;
      if (session) {
        session.logCount = count;
        session.lastActivity = Date.now();
        store.put(session);
      }
    };
  } catch {}
}

// ============ Log Persistence ============
function queueLogForPersistence(log) {
  if (!db) return;

  writeQueue.push({
    ...log,
    sessionId: currentSessionId,
    tabId: tabId,
    timestamp: log.timestamp || Date.now()
  });

  if (writeQueue.length >= BATCH_SIZE) {
    flushLogs();
  } else if (!writeTimer) {
    writeTimer = setTimeout(flushLogs, BATCH_DELAY);
  }
}

function flushLogs() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }

  if (!db || writeQueue.length === 0) return;

  const batch = writeQueue.splice(0, BATCH_SIZE);

  try {
    const tx = db.transaction('logs', 'readwrite');
    const store = tx.objectStore('logs');

    for (const log of batch) {
      store.add(log);
    }

    tx.oncomplete = () => {
      updateSessionLogCount(buffer.length);
    };
  } catch (e) {
    log('Failed to persist logs:', e);
    // Re-queue failed writes
    writeQueue.unshift(...batch);
  }
}

// ============ Cross-Tab Communication ============
let broadcastChannel = null;

function initCrossTab() {
  try {
    broadcastChannel = new BroadcastChannel('logtap_sync');

    broadcastChannel.onmessage = (event) => {
      const { type, payload, fromTab } = event.data;

      if (fromTab === tabId) return; // Ignore own messages

      if (type === 'LOG' && captureEnabled) {
        // Add cross-tab logs to buffer with origin marker
        buffer.push({
          ...payload,
          _crossTab: true,
          _fromTab: fromTab
        });

        if (buffer.length > MAX_BUFFER) {
          buffer.splice(0, buffer.length - MAX_BUFFER);
        }
      }

      if (type === 'CLEAR') {
        buffer = [];
      }
    };
  } catch {
    // BroadcastChannel not supported
  }
}

function broadcastLog(log) {
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage({
        type: 'LOG',
        payload: log,
        fromTab: tabId
      });
    } catch {}
  }
}

function broadcastClear() {
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage({
        type: 'CLEAR',
        fromTab: tabId
      });
    } catch {}
  }
}

// ============ Message Handlers ============
window.addEventListener('message', e => {
  if (e.source !== window) return;
  const msg = e.data || {};

  // New message type from updated injected.js
  if (msg.type === 'LOGTAP_LOG' && captureEnabled) {
    const log = msg.payload;

    // Add to memory buffer
    buffer.push(log);
    if (buffer.length > MAX_BUFFER) {
      buffer.splice(0, buffer.length - MAX_BUFFER);
    }

    // Persist to IndexedDB
    queueLogForPersistence(log);

    // Broadcast to other tabs
    broadcastLog(log);
  }

  // Legacy message type support
  if (msg.type === 'logtap:push' && captureEnabled) {
    const log = msg.payload;
    buffer.push(log);
    if (buffer.length > MAX_BUFFER) {
      buffer.splice(0, buffer.length - MAX_BUFFER);
    }
    queueLogForPersistence(log);
    broadcastLog(log);
  }

  if (msg.type === 'LOGTAP_STATUS' || msg.type === 'logtap:status') {
    // Status update from injected script
  }

  if (msg.type === 'LOGTAP_READY') {
    log('Injected script ready:', msg.payload);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === 'getBuffer') {
    sendResponse({
      buffer,
      sessionId: currentSessionId,
      tabId: tabId,
      captureEnabled,
      bufferSize: buffer.length
    });
    return true;
  }

  if (msg.cmd === 'clearBuffer') {
    buffer = [];

    // Clear persisted logs for current session
    if (db && currentSessionId) {
      try {
        const tx = db.transaction('logs', 'readwrite');
        const store = tx.objectStore('logs');
        const index = store.index('sessionId');
        const request = index.openCursor(IDBKeyRange.only(currentSessionId));

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      } catch {}
    }

    // Notify other tabs
    broadcastClear();

    sendResponse({ ok: true });
    return true;
  }

  if (msg.cmd === 'toggleCapture') {
    captureEnabled = !!msg.enabled;

    // Notify injected script
    window.postMessage({
      type: 'LOGTAP_CONTROL',
      command: captureEnabled ? 'resume' : 'pause'
    }, '*');

    // Legacy support
    window.postMessage({ type: 'logtap:toggle', enabled: captureEnabled }, '*');

    sendResponse({ enabled: captureEnabled });
    return true;
  }

  if (msg.cmd === 'getSessionLogs') {
    if (!db) {
      sendResponse({ logs: buffer });
      return true;
    }

    const sessionId = msg.sessionId || currentSessionId;
    const logs = [];

    try {
      const tx = db.transaction('logs', 'readonly');
      const store = tx.objectStore('logs');
      const index = store.index('sessionId');
      const request = index.openCursor(IDBKeyRange.only(sessionId), 'prev');

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && logs.length < (msg.limit || 10000)) {
          logs.push(cursor.value);
          cursor.continue();
        } else {
          sendResponse({ logs: logs.reverse() });
        }
      };

      request.onerror = () => sendResponse({ logs: buffer });
    } catch {
      sendResponse({ logs: buffer });
    }

    return true;
  }

  if (msg.cmd === 'getAllLogs') {
    if (!db) {
      sendResponse({ logs: buffer });
      return true;
    }

    const logs = [];
    const limit = msg.limit || 10000;
    const startTime = msg.startTime || 0;
    const endTime = msg.endTime || Date.now();

    try {
      const tx = db.transaction('logs', 'readonly');
      const store = tx.objectStore('logs');
      const index = store.index('timestamp');
      const range = IDBKeyRange.bound(startTime, endTime);
      const request = index.openCursor(range, 'prev');

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && logs.length < limit) {
          logs.push(cursor.value);
          cursor.continue();
        } else {
          sendResponse({ logs: logs.reverse() });
        }
      };

      request.onerror = () => sendResponse({ logs: buffer });
    } catch {
      sendResponse({ logs: buffer });
    }

    return true;
  }

  if (msg.cmd === 'getSessions') {
    if (!db) {
      sendResponse({ sessions: [] });
      return true;
    }

    const sessions = [];

    try {
      const tx = db.transaction('sessions', 'readonly');
      const store = tx.objectStore('sessions');
      const index = store.index('created');
      const request = index.openCursor(null, 'prev');

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && sessions.length < 100) {
          sessions.push(cursor.value);
          cursor.continue();
        } else {
          sendResponse({ sessions });
        }
      };

      request.onerror = () => sendResponse({ sessions: [] });
    } catch {
      sendResponse({ sessions: [] });
    }

    return true;
  }

  if (msg.cmd === 'searchLogs') {
    const query = msg.query || '';
    let regex;

    try {
      regex = new RegExp(query, 'i');
    } catch {
      regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    if (!db) {
      const results = buffer.filter(log =>
        regex.test(log.message || '') ||
        regex.test(log.raw || '') ||
        regex.test(log.tag || '')
      );
      sendResponse({ logs: results });
      return true;
    }

    const results = [];
    const limit = msg.limit || 1000;

    try {
      const tx = db.transaction('logs', 'readonly');
      const store = tx.objectStore('logs');
      const request = store.openCursor(null, 'prev');

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && results.length < limit) {
          const log = cursor.value;
          if (regex.test(log.message || '') ||
              regex.test(log.raw || '') ||
              regex.test(log.tag || '')) {
            results.push(log);
          }
          cursor.continue();
        } else {
          sendResponse({ logs: results });
        }
      };

      request.onerror = () => sendResponse({ logs: [] });
    } catch {
      sendResponse({ logs: [] });
    }

    return true;
  }

  if (msg.cmd === 'getStats') {
    const stats = {
      bufferSize: buffer.length,
      captureEnabled,
      sessionId: currentSessionId,
      tabId,
      hasIndexedDB: !!db,
      url: window.location.href
    };

    // Count unique tags
    const tags = new Set();
    const levels = { info: 0, warn: 0, error: 0, debug: 0 };

    for (const log of buffer) {
      if (log.tag) tags.add(log.tag);
      if (log.level && levels[log.level] !== undefined) {
        levels[log.level]++;
      }
    }

    stats.uniqueTags = tags.size;
    stats.tagList = [...tags].slice(0, 50);
    stats.levelCounts = levels;

    if (db) {
      try {
        const tx = db.transaction('logs', 'readonly');
        const store = tx.objectStore('logs');
        const countRequest = store.count();

        countRequest.onsuccess = () => {
          stats.totalPersistedLogs = countRequest.result;
          sendResponse({ stats });
        };

        countRequest.onerror = () => sendResponse({ stats });
      } catch {
        sendResponse({ stats });
      }
    } else {
      sendResponse({ stats });
    }

    return true;
  }

  if (msg.cmd === 'exportLogs') {
    const exportData = {
      version: '3.0',
      exported: Date.now(),
      sessionId: currentSessionId,
      url: window.location.href,
      logs: buffer.slice(-(msg.limit || 10000))
    };

    sendResponse({ data: exportData });
    return true;
  }

  if (msg.cmd === 'importLogs') {
    if (msg.logs && Array.isArray(msg.logs)) {
      for (const log of msg.logs) {
        buffer.push({
          ...log,
          _imported: true,
          _importedAt: Date.now()
        });
      }

      if (buffer.length > MAX_BUFFER) {
        buffer.splice(0, buffer.length - MAX_BUFFER);
      }
    }

    sendResponse({ ok: true, count: msg.logs?.length || 0 });
    return true;
  }

  if (msg.cmd === 'setTabId') {
    tabId = msg.tabId;
    sendResponse({ ok: true });
    return true;
  }
});

// ============ Cleanup old logs ============
async function cleanupOldLogs() {
  if (!db) return;

  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  const cutoff = Date.now() - maxAge;

  try {
    const tx = db.transaction(['logs', 'sessions'], 'readwrite');

    // Clean old logs
    const logsStore = tx.objectStore('logs');
    const logsIndex = logsStore.index('timestamp');
    const logsRequest = logsIndex.openCursor(IDBKeyRange.upperBound(cutoff));

    logsRequest.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    // Clean old sessions
    const sessionsStore = tx.objectStore('sessions');
    const sessionsIndex = sessionsStore.index('created');
    const sessionsRequest = sessionsIndex.openCursor(IDBKeyRange.upperBound(cutoff));

    sessionsRequest.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  } catch (e) {
    log('Cleanup failed:', e);
  }
}

// ============ Initialization ============
async function init() {
  // Get tab ID from background
  try {
    const response = await chrome.runtime.sendMessage({ cmd: 'getTabId' });
    if (response?.tabId) {
      tabId = response.tabId;
    }
  } catch {}

  // Initialize IndexedDB
  await initDB();

  // Start new session
  if (db) {
    await createSession();

    // Run cleanup on startup
    cleanupOldLogs();
  }

  // Initialize cross-tab communication
  initCrossTab();

  // Flush logs on page unload
  window.addEventListener('beforeunload', () => {
    flushLogs();
  });

  // Periodic cleanup (every hour)
  setInterval(cleanupOldLogs, 60 * 60 * 1000);
}

init();
