/**
 * LogTap 3.0 - Storage Manager
 * IndexedDB wrapper for persistent log storage with batch writes and auto-rotation
 */

const DB_NAME = 'LogTapDB';
const DB_VERSION = 1;
const LOGS_STORE = 'logs';
const SESSIONS_STORE = 'sessions';

const CONFIG = {
  maxLogs: 50000,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  batchSize: 50,
  batchDelay: 100, // ms
  cleanupInterval: 60 * 60 * 1000 // 1 hour
};

let db = null;
let pendingWrites = [];
let writeTimer = null;
let cleanupTimer = null;

/**
 * Initialize IndexedDB connection
 */
export async function initDB() {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      db = request.result;
      startCleanupTimer();
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      // Logs store with indexes
      if (!database.objectStoreNames.contains(LOGS_STORE)) {
        const logsStore = database.createObjectStore(LOGS_STORE, {
          keyPath: 'id',
          autoIncrement: true
        });
        logsStore.createIndex('sessionId', 'sessionId', { unique: false });
        logsStore.createIndex('timestamp', 'timestamp', { unique: false });
        logsStore.createIndex('level', 'level', { unique: false });
        logsStore.createIndex('tag', 'tag', { unique: false });
        logsStore.createIndex('session_time', ['sessionId', 'timestamp'], { unique: false });
      }

      // Sessions store
      if (!database.objectStoreNames.contains(SESSIONS_STORE)) {
        const sessionsStore = database.createObjectStore(SESSIONS_STORE, {
          keyPath: 'id'
        });
        sessionsStore.createIndex('url', 'url', { unique: false });
        sessionsStore.createIndex('created', 'created', { unique: false });
      }
    };
  });
}

/**
 * Close database connection
 */
export function closeDB() {
  if (db) {
    db.close();
    db = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Generate a unique session ID
 */
export function generateSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Create a new logging session
 */
export async function createSession(url, tabId = null) {
  await initDB();

  const session = {
    id: generateSessionId(),
    url: url || window.location?.href || 'unknown',
    tabId,
    created: Date.now(),
    logCount: 0,
    lastActivity: Date.now()
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readwrite');
    const store = tx.objectStore(SESSIONS_STORE);
    const request = store.add(session);

    request.onsuccess = () => resolve(session);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get session by ID
 */
export async function getSession(sessionId) {
  await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    const store = tx.objectStore(SESSIONS_STORE);
    const request = store.get(sessionId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Update session metadata
 */
export async function updateSession(sessionId, updates) {
  await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readwrite');
    const store = tx.objectStore(SESSIONS_STORE);
    const getRequest = store.get(sessionId);

    getRequest.onsuccess = () => {
      const session = getRequest.result;
      if (!session) {
        resolve(null);
        return;
      }

      const updated = { ...session, ...updates, lastActivity: Date.now() };
      const putRequest = store.put(updated);

      putRequest.onsuccess = () => resolve(updated);
      putRequest.onerror = () => reject(putRequest.error);
    };

    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * Get recent sessions
 */
export async function getRecentSessions(limit = 10) {
  await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    const store = tx.objectStore(SESSIONS_STORE);
    const index = store.index('created');
    const request = index.openCursor(null, 'prev');

    const sessions = [];
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor && sessions.length < limit) {
        sessions.push(cursor.value);
        cursor.continue();
      } else {
        resolve(sessions);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Add a log entry (batched)
 */
export function addLog(logEntry, sessionId) {
  const entry = {
    ...logEntry,
    sessionId,
    timestamp: logEntry.timestamp || Date.now()
  };

  pendingWrites.push(entry);

  if (pendingWrites.length >= CONFIG.batchSize) {
    flushWrites();
  } else if (!writeTimer) {
    writeTimer = setTimeout(flushWrites, CONFIG.batchDelay);
  }
}

/**
 * Add multiple logs at once
 */
export function addLogs(logs, sessionId) {
  for (const log of logs) {
    addLog(log, sessionId);
  }
}

/**
 * Flush pending writes to IndexedDB
 */
export async function flushWrites() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }

  if (pendingWrites.length === 0) return;

  const toWrite = pendingWrites.splice(0, pendingWrites.length);

  try {
    await initDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(LOGS_STORE, 'readwrite');
      const store = tx.objectStore(LOGS_STORE);

      for (const entry of toWrite) {
        store.add(entry);
      }

      tx.oncomplete = () => resolve(toWrite.length);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // Re-queue failed writes
    pendingWrites.unshift(...toWrite);
    console.debug('[LogTap] Write flush failed:', err);
    throw err;
  }
}

/**
 * Get logs for a session
 */
export async function getSessionLogs(sessionId, opts = {}) {
  await initDB();

  const { limit = 1000, offset = 0, startTime = null, endTime = null } = opts;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readonly');
    const store = tx.objectStore(LOGS_STORE);
    const index = store.index('session_time');

    const range = startTime || endTime
      ? IDBKeyRange.bound(
          [sessionId, startTime || 0],
          [sessionId, endTime || Date.now()]
        )
      : IDBKeyRange.bound([sessionId, 0], [sessionId, Date.now()]);

    const request = index.openCursor(range);
    const logs = [];
    let skipped = 0;

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (skipped < offset) {
          skipped++;
          cursor.continue();
        } else if (logs.length < limit) {
          logs.push(cursor.value);
          cursor.continue();
        } else {
          resolve(logs);
        }
      } else {
        resolve(logs);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all logs across sessions (with time range)
 */
export async function getAllLogs(opts = {}) {
  await initDB();

  const { limit = 5000, startTime = null, endTime = null } = opts;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readonly');
    const store = tx.objectStore(LOGS_STORE);
    const index = store.index('timestamp');

    const range = startTime || endTime
      ? IDBKeyRange.bound(startTime || 0, endTime || Date.now())
      : null;

    const request = index.openCursor(range, 'prev');
    const logs = [];

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor && logs.length < limit) {
        logs.push(cursor.value);
        cursor.continue();
      } else {
        resolve(logs.reverse());
      }
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Count logs for a session
 */
export async function countSessionLogs(sessionId) {
  await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readonly');
    const store = tx.objectStore(LOGS_STORE);
    const index = store.index('sessionId');
    const request = index.count(sessionId);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Count total logs in database
 */
export async function countAllLogs() {
  await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readonly');
    const store = tx.objectStore(LOGS_STORE);
    const request = store.count();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear logs for a session
 */
export async function clearSessionLogs(sessionId) {
  await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readwrite');
    const store = tx.objectStore(LOGS_STORE);
    const index = store.index('sessionId');
    const request = index.openCursor(IDBKeyRange.only(sessionId));

    let deleted = 0;
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        deleted++;
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear all logs
 */
export async function clearAllLogs() {
  await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readwrite');
    const store = tx.objectStore(LOGS_STORE);
    const request = store.clear();

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete a session and its logs
 */
export async function deleteSession(sessionId) {
  await clearSessionLogs(sessionId);
  await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readwrite');
    const store = tx.objectStore(SESSIONS_STORE);
    const request = store.delete(sessionId);

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Cleanup old logs and sessions (auto-rotation)
 */
export async function cleanup() {
  await initDB();

  const cutoff = Date.now() - CONFIG.maxAge;
  let deletedLogs = 0;
  let deletedSessions = 0;

  // Delete old logs
  await new Promise((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readwrite');
    const store = tx.objectStore(LOGS_STORE);
    const index = store.index('timestamp');
    const request = index.openCursor(IDBKeyRange.upperBound(cutoff));

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        deletedLogs++;
        cursor.continue();
      } else {
        resolve();
      }
    };

    request.onerror = () => reject(request.error);
  });

  // Delete old sessions
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readwrite');
    const store = tx.objectStore(SESSIONS_STORE);
    const index = store.index('created');
    const request = index.openCursor(IDBKeyRange.upperBound(cutoff));

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        deletedSessions++;
        cursor.continue();
      } else {
        resolve();
      }
    };

    request.onerror = () => reject(request.error);
  });

  // If still over max logs, delete oldest
  const totalLogs = await countAllLogs();
  if (totalLogs > CONFIG.maxLogs) {
    const toDelete = totalLogs - CONFIG.maxLogs;

    await new Promise((resolve, reject) => {
      const tx = db.transaction(LOGS_STORE, 'readwrite');
      const store = tx.objectStore(LOGS_STORE);
      const index = store.index('timestamp');
      const request = index.openCursor();

      let deleted = 0;
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && deleted < toDelete) {
          store.delete(cursor.primaryKey);
          deleted++;
          deletedLogs++;
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  return { deletedLogs, deletedSessions };
}

/**
 * Start automatic cleanup timer
 */
function startCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanup().catch(err => console.debug('[LogTap] Cleanup failed:', err));
  }, CONFIG.cleanupInterval);
}

/**
 * Get storage statistics
 */
export async function getStats() {
  await initDB();

  const [logCount, sessions] = await Promise.all([
    countAllLogs(),
    getRecentSessions(100)
  ]);

  // Estimate storage size
  let estimatedSize = 0;
  try {
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      estimatedSize = estimate.usage || 0;
    }
  } catch {}

  return {
    logCount,
    sessionCount: sessions.length,
    oldestSession: sessions[sessions.length - 1]?.created || null,
    newestSession: sessions[0]?.created || null,
    estimatedSize,
    maxLogs: CONFIG.maxLogs,
    maxAge: CONFIG.maxAge
  };
}

/**
 * Export all data for backup
 */
export async function exportAll() {
  await initDB();

  const [logs, sessions] = await Promise.all([
    getAllLogs({ limit: CONFIG.maxLogs }),
    getRecentSessions(1000)
  ]);

  return {
    version: 1,
    exported: Date.now(),
    sessions,
    logs
  };
}

/**
 * Import data from backup
 */
export async function importAll(data) {
  if (!data?.version || !data.sessions || !data.logs) {
    throw new Error('Invalid import data format');
  }

  await initDB();

  // Import sessions
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readwrite');
    const store = tx.objectStore(SESSIONS_STORE);

    for (const session of data.sessions) {
      store.put(session);
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Import logs
  await new Promise((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readwrite');
    const store = tx.objectStore(LOGS_STORE);

    for (const log of data.logs) {
      store.put(log);
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return {
    sessionsImported: data.sessions.length,
    logsImported: data.logs.length
  };
}

export { CONFIG };
