/**
 * LogTap 3.0 - Background Service Worker
 * Handles context menu, tab management, and cross-tab coordination
 */

// ============ Filter Core (inline subset) ============
function toRegex(s) {
  if (!s || !String(s).trim()) return null;
  const str = String(s).trim();
  try {
    if (str.startsWith('/') && str.endsWith('/') && str.length > 2) {
      return new RegExp(str.slice(1, -1), 'i');
    }
    if (str.startsWith('^') || str.endsWith('$')) {
      return new RegExp(str, 'i');
    }
    return new RegExp(str, 'i');
  } catch {
    return new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

function dedupeConsecutive(items, opts = {}) {
  if (!items || items.length === 0) return [];
  const out = [];
  let prev = null;
  let prevKey = '';
  let repeatCount = 1;

  for (const it of items) {
    const parts = [];
    if (!opts.removeTimestamps && it.time) parts.push(it.time);
    if (!opts.removeFileReferences && it.file) {
      parts.push(it.file + (it.line ? ':' + it.line : ''));
    }
    if (opts.preserveBrackets && it.tag) {
      parts.push('[' + it.tag + '] ' + it.message);
    } else {
      parts.push(it.message || '');
    }
    const key = parts.join(' ');

    if (key === prevKey && prev) {
      repeatCount++;
      prev._repeatCount = repeatCount;
    } else {
      if (prev) out.push(prev);
      prev = { ...it, _repeatCount: 1 };
      prevKey = key;
      repeatCount = 1;
    }
  }
  if (prev) out.push(prev);
  return out;
}

function buildSearchableText(it) {
  const parts = [it.message || '', it.raw || '', it.tag || '', it.file || ''];
  if (it.structured && typeof it.structured === 'object') {
    try {
      parts.push(JSON.stringify(it.structured));
    } catch {}
  }
  return parts.join(' ');
}

function applyFilters(items, opts = {}) {
  if (!items || items.length === 0) return [];

  const inc = toRegex(opts.include);
  const exc = toRegex(opts.exclude);

  const levels = new Set();
  if (opts.lvlInfo !== false) levels.add('info');
  if (opts.lvlWarn !== false) levels.add('warn');
  if (opts.lvlError !== false) levels.add('error');
  if (opts.lvlDebug !== false) levels.add('debug');

  const tagSet = opts.activeTags && opts.activeTags.length > 0
    ? new Set(opts.activeTags)
    : null;

  let out = items.filter(it => {
    if (opts.removeEmptyLines !== false && !String(it.message || '').trim()) {
      return false;
    }

    const searchText = buildSearchableText(it);

    if (inc && !inc.test(searchText)) return false;
    if (exc && exc.test(searchText)) return false;

    if (tagSet && tagSet.size > 0) {
      let matchesTag = false;
      if (it.tag && tagSet.has(it.tag)) matchesTag = true;
      if (!matchesTag && it.structured) {
        if (it.structured.event) {
          const eventTag = String(it.structured.event).replace(/_/g, '-').toLowerCase();
          if (tagSet.has(eventTag)) matchesTag = true;
        }
      }
      if (!matchesTag) return false;
    }

    if (it.level && !levels.has(it.level)) return false;

    return true;
  });

  const limit = Number(opts.limitLines) || 0;
  if (limit > 0 && out.length > limit) {
    out = out.slice(-limit);
  }

  if (opts.dedupe) {
    out = dedupeConsecutive(out, opts);
  }

  return out;
}

// ============ Format Functions ============
const LEVEL_EMOJI = {
  error: '\u274C',
  warn: '\u26A0\uFE0F',
  info: '\u2139\uFE0F',
  debug: '\uD83D\uDC1B'
};

function formatPlain(items, opts = {}) {
  const rows = items.map((it, i) => {
    const parts = [];

    if (!opts.removeTimestamps && opts.showEmoji !== false) {
      parts.push(LEVEL_EMOJI[it.level] || '');
    }

    if (!opts.removeTimestamps && it.time) {
      parts.push(`[${it.time}]`);
    }

    if (!opts.removeFileReferences && it.file) {
      const ref = it.file + (it.line ? ':' + it.line : '');
      parts.push(ref);
    }

    let msg = it.message || '';
    if (opts.preserveBrackets && it.tag) {
      msg = `[${it.tag}] ${msg}`;
    }

    if (it._repeatCount && it._repeatCount > 1) {
      msg += ` [x${it._repeatCount}]`;
    }

    parts.push(msg);

    let line = parts.filter(Boolean).join(' ');

    if (opts.addLineNumbers) {
      line = String(i + 1).padStart(4, ' ') + ' \u2502 ' + line;
    }

    return line;
  });

  return rows.join('\n');
}

function formatMarkdown(items, opts = {}) {
  const plain = formatPlain(items, opts);
  return '```\n' + plain + '\n```';
}

function formatCSV(items, opts = {}) {
  const escape = (s) => '"' + String(s || '').replace(/"/g, '""').replace(/\n/g, ' ') + '"';
  const header = 'time,file,tag,level,message,repeat_count';
  const rows = items.map(it => {
    const time = opts.removeTimestamps ? '' : (it.time || '');
    const file = opts.removeFileReferences ? '' : (it.file ? it.file + (it.line ? ':' + it.line : '') : '');
    return [
      escape(time),
      escape(file),
      escape(it.tag || ''),
      escape(it.level || 'info'),
      escape(it.message || ''),
      it._repeatCount || 1
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

function formatJSON(items) {
  return JSON.stringify(items, null, 2);
}

function formatOutput(items, opts = {}) {
  const format = opts.outputFormat || 'markdown';
  switch (format) {
    case 'csv': return formatCSV(items, opts);
    case 'json': return formatJSON(items);
    case 'plain': return formatPlain(items, opts);
    case 'markdown':
    default: return formatMarkdown(items, opts);
  }
}

// ============ Default Settings ============
function getDefaultSettings() {
  return {
    removeTimestamps: false,
    removeFileReferences: true,
    preserveBrackets: true,
    removeEmptyLines: true,
    addLineNumbers: false,
    dedupe: false,
    smartDedupe: false,
    include: '',
    exclude: '',
    limitLines: '500',
    outputFormat: 'markdown',
    lvlInfo: true,
    lvlWarn: true,
    lvlError: true,
    lvlDebug: true,
    activeTags: null,
    showEmoji: true
  };
}

// ============ Tab Management ============
async function getActiveTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? tab.id : null;
  } catch {
    return null;
  }
}

async function getTabById(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function copyTextToClipboard(tabId, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (t) => navigator.clipboard.writeText(t),
      args: [text]
    });
    return true;
  } catch (e) {
    console.debug('[LogTap] Clipboard copy failed:', e);
    return false;
  }
}

// ============ Message Handlers ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === 'getTabId') {
    sendResponse({ tabId: sender.tab?.id || null });
    return true;
  }

  if (msg.cmd === 'copyToClipboard') {
    getActiveTabId().then(async (tabId) => {
      if (!tabId) {
        sendResponse({ ok: false, error: 'No active tab' });
        return;
      }
      const success = await copyTextToClipboard(tabId, msg.text);
      sendResponse({ ok: success });
    });
    return true;
  }

  if (msg.cmd === 'formatAndCopy') {
    (async () => {
      const tabId = msg.tabId || await getActiveTabId();
      if (!tabId) {
        sendResponse({ ok: false, error: 'No active tab' });
        return;
      }

      const { settings } = await chrome.storage.local.get({ settings: getDefaultSettings() });
      const mergedSettings = { ...settings, ...(msg.settings || {}) };

      const res = await chrome.tabs.sendMessage(tabId, { cmd: 'getBuffer' }).catch(() => null);

      if (!res || !res.buffer) {
        sendResponse({ ok: false, error: 'No logs available' });
        return;
      }

      const filtered = applyFilters(res.buffer, mergedSettings);
      const text = formatOutput(filtered, mergedSettings);

      const success = await copyTextToClipboard(tabId, text);
      sendResponse({ ok: success, count: filtered.length, text: msg.returnText ? text : undefined });
    })();
    return true;
  }

  if (msg.cmd === 'getBuffer') {
    (async () => {
      const tabId = msg.tabId || await getActiveTabId();
      if (!tabId) {
        sendResponse({ buffer: [], error: 'No active tab' });
        return;
      }

      const res = await chrome.tabs.sendMessage(tabId, { cmd: 'getBuffer' }).catch(() => null);
      sendResponse(res || { buffer: [] });
    })();
    return true;
  }

  if (msg.cmd === 'clearBuffer') {
    (async () => {
      const tabId = msg.tabId || await getActiveTabId();
      if (!tabId) {
        sendResponse({ ok: false, error: 'No active tab' });
        return;
      }

      await chrome.tabs.sendMessage(tabId, { cmd: 'clearBuffer' }).catch(() => null);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.cmd === 'toggleCapture') {
    (async () => {
      const tabId = msg.tabId || await getActiveTabId();
      if (!tabId) {
        sendResponse({ ok: false, error: 'No active tab' });
        return;
      }

      const res = await chrome.tabs.sendMessage(tabId, {
        cmd: 'toggleCapture',
        enabled: msg.enabled
      }).catch(() => null);

      sendResponse(res || { ok: false });
    })();
    return true;
  }

  if (msg.cmd === 'getStats') {
    (async () => {
      const tabId = msg.tabId || await getActiveTabId();
      if (!tabId) {
        sendResponse({ stats: null });
        return;
      }

      const res = await chrome.tabs.sendMessage(tabId, { cmd: 'getStats' }).catch(() => null);
      sendResponse(res || { stats: null });
    })();
    return true;
  }

  if (msg.cmd === 'getSessions') {
    (async () => {
      const tabId = msg.tabId || await getActiveTabId();
      if (!tabId) {
        sendResponse({ sessions: [] });
        return;
      }

      const res = await chrome.tabs.sendMessage(tabId, { cmd: 'getSessions' }).catch(() => null);
      sendResponse(res || { sessions: [] });
    })();
    return true;
  }

  if (msg.cmd === 'searchLogs') {
    (async () => {
      const tabId = msg.tabId || await getActiveTabId();
      if (!tabId) {
        sendResponse({ logs: [] });
        return;
      }

      const res = await chrome.tabs.sendMessage(tabId, {
        cmd: 'searchLogs',
        query: msg.query,
        limit: msg.limit
      }).catch(() => null);

      sendResponse(res || { logs: [] });
    })();
    return true;
  }

  if (msg.cmd === 'getSettings') {
    chrome.storage.local.get({ settings: getDefaultSettings() }).then(({ settings }) => {
      sendResponse({ settings });
    });
    return true;
  }

  if (msg.cmd === 'saveSettings') {
    chrome.storage.local.set({ settings: msg.settings }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.cmd === 'exportLogs') {
    (async () => {
      const tabId = msg.tabId || await getActiveTabId();
      if (!tabId) {
        sendResponse({ data: null, error: 'No active tab' });
        return;
      }

      const res = await chrome.tabs.sendMessage(tabId, {
        cmd: 'exportLogs',
        limit: msg.limit
      }).catch(() => null);

      sendResponse(res || { data: null });
    })();
    return true;
  }

  if (msg.cmd === 'importLogs') {
    (async () => {
      const tabId = msg.tabId || await getActiveTabId();
      if (!tabId) {
        sendResponse({ ok: false, error: 'No active tab' });
        return;
      }

      const res = await chrome.tabs.sendMessage(tabId, {
        cmd: 'importLogs',
        logs: msg.logs
      }).catch(() => null);

      sendResponse(res || { ok: false });
    })();
    return true;
  }
});

// ============ Context Menu ============
chrome.runtime.onInstalled.addListener(() => {
  // Remove existing menus first
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'logtap_copy_recent',
      title: 'Copy recent console logs',
      contexts: ['page', 'action']
    });

    chrome.contextMenus.create({
      id: 'logtap_copy_errors',
      title: 'Copy errors and warnings only',
      contexts: ['page', 'action']
    });

    chrome.contextMenus.create({
      id: 'logtap_separator_1',
      type: 'separator',
      contexts: ['page', 'action']
    });

    chrome.contextMenus.create({
      id: 'logtap_clear_logs',
      title: 'Clear captured logs',
      contexts: ['page', 'action']
    });

    chrome.contextMenus.create({
      id: 'logtap_open_panel',
      title: 'Open LogTap panel',
      contexts: ['page', 'action']
    });
  });

  console.debug('[LogTap] Extension installed/updated');
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  if (info.menuItemId === 'logtap_copy_recent') {
    const { settings } = await chrome.storage.local.get({ settings: getDefaultSettings() });
    const res = await chrome.tabs.sendMessage(tabId, { cmd: 'getBuffer' }).catch(() => null);

    if (!res || !res.buffer) return;

    const filtered = applyFilters(res.buffer, settings);
    const text = formatOutput(filtered, settings);

    await copyTextToClipboard(tabId, text);
  }

  if (info.menuItemId === 'logtap_copy_errors') {
    const { settings } = await chrome.storage.local.get({ settings: getDefaultSettings() });
    const res = await chrome.tabs.sendMessage(tabId, { cmd: 'getBuffer' }).catch(() => null);

    if (!res || !res.buffer) return;

    const errorSettings = {
      ...settings,
      lvlInfo: false,
      lvlWarn: true,
      lvlError: true,
      lvlDebug: false
    };

    const filtered = applyFilters(res.buffer, errorSettings);
    const text = formatOutput(filtered, errorSettings);

    await copyTextToClipboard(tabId, text);
  }

  if (info.menuItemId === 'logtap_clear_logs') {
    await chrome.tabs.sendMessage(tabId, { cmd: 'clearBuffer' }).catch(() => null);
  }

  if (info.menuItemId === 'logtap_open_panel') {
    // Open DevTools with LogTap panel
    // Note: There's no direct API to open DevTools, but we can try to focus the tab
    await chrome.tabs.update(tabId, { active: true });
  }
});

// ============ Tab Events ============
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, { cmd: 'setTabId', tabId }).catch(() => {});
  }
});

// ============ Keyboard Shortcuts ============
chrome.commands?.onCommand?.addListener(async (command) => {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  if (command === 'copy-logs') {
    const { settings } = await chrome.storage.local.get({ settings: getDefaultSettings() });
    const res = await chrome.tabs.sendMessage(tabId, { cmd: 'getBuffer' }).catch(() => null);

    if (!res || !res.buffer) return;

    const filtered = applyFilters(res.buffer, settings);
    const text = formatOutput(filtered, settings);

    await copyTextToClipboard(tabId, text);
  }

  if (command === 'clear-logs') {
    await chrome.tabs.sendMessage(tabId, { cmd: 'clearBuffer' }).catch(() => null);
  }

  if (command === 'toggle-capture') {
    const res = await chrome.tabs.sendMessage(tabId, { cmd: 'getStats' }).catch(() => null);
    if (res?.stats) {
      await chrome.tabs.sendMessage(tabId, {
        cmd: 'toggleCapture',
        enabled: !res.stats.captureEnabled
      }).catch(() => null);
    }
  }
});

// ============ Badge Updates ============
async function updateBadge(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { cmd: 'getStats' }).catch(() => null);
    if (res?.stats) {
      const count = res.stats.bufferSize || 0;
      const text = count > 999 ? '999+' : (count > 0 ? String(count) : '');

      await chrome.action.setBadgeText({ text, tabId });
      await chrome.action.setBadgeBackgroundColor({
        color: res.stats.levelCounts?.error > 0 ? '#ef4444' : '#6b7280',
        tabId
      });
    }
  } catch {}
}

// Update badge periodically for active tab
setInterval(async () => {
  const tabId = await getActiveTabId();
  if (tabId) {
    updateBadge(tabId);
  }
}, 5000);

console.debug('[LogTap] Background service worker initialized (v3.0)');
