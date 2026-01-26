/**
 * LogTap 3.0 - DevTools Panel
 * Full-featured log viewer with timeline, semantic search, and export
 */

// ============ DOM Helpers ============
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ============ State ============
let state = {
  logs: [],
  filteredLogs: [],
  tabId: null,
  capturing: true,
  settings: getDefaultSettings(),
  levels: { info: true, warn: true, error: true, debug: true },
  activeTags: new Set(),
  allTags: new Set(),
  dedupe: false,
  groupByRequest: false,
  searchQuery: '',
  timeRange: null,
  selectedLogId: null,
  refreshInterval: null,
  patterns: [],
  diffSessionA: null,
  diffSessionB: null
};

function getDefaultSettings() {
  return {
    outputFormat: 'markdown',
    showTimestamps: true,
    showFiles: false,
    showTags: true,
    showEmoji: true,
    lineNumbers: false,
    maxLines: 500,
    anonymize: false,
    editor: 'vscode',
    workspaceRoot: ''
  };
}

// ============ Initialization ============
async function init() {
  // Get tab ID
  if (chrome.devtools?.inspectedWindow) {
    state.tabId = chrome.devtools.inspectedWindow.tabId;
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tabId = tab?.id;
  }

  // Load settings
  const stored = await chrome.storage.local.get(['logtapSettings']);
  if (stored.logtapSettings) {
    state.settings = { ...state.settings, ...stored.logtapSettings };
  }

  // Set up event listeners
  setupEventListeners();

  // Initial refresh
  await refreshLogs();

  // Auto refresh every 2 seconds
  state.refreshInterval = setInterval(refreshLogs, 2000);
}

// ============ Event Listeners ============
function setupEventListeners() {
  // Header buttons
  $('#btnToggleCapture').addEventListener('click', toggleCapture);
  $('#btnClear').addEventListener('click', clearLogs);
  $('#btnCopy').addEventListener('click', copyLogs);
  $('#btnExport').addEventListener('click', exportLogs);
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', importLogs);

  // Search
  $('#searchInput').addEventListener('input', debounce(handleSearch, 300));
  $('#btnClearSearch').addEventListener('click', clearSearch);

  // Level filters
  $$('.filter-btn[data-level]').forEach(btn => {
    btn.addEventListener('click', () => toggleLevel(btn.dataset.level));
  });

  // Tags dropdown
  $('#btnTags').addEventListener('click', toggleTagsDropdown);
  $('#tagsSearch').addEventListener('input', filterTags);
  $('#tagsSelectAll').addEventListener('click', () => selectAllTags(true));
  $('#tagsSelectNone').addEventListener('click', () => selectAllTags(false));

  // Options
  $('#btnDedupe').addEventListener('click', toggleDedupe);
  $('#btnGroup').addEventListener('click', toggleGroupByRequest);
  $('#btnPatterns').addEventListener('click', showPatterns);
  $('#btnDiff').addEventListener('click', showDiff);
  $('#btnSettings').addEventListener('click', showSettings);
  $('#btnCloseSettings').addEventListener('click', hideSettings);
  $('#btnClosePatterns')?.addEventListener('click', hidePatterns);
  $('#btnCloseDiff')?.addEventListener('click', hideDiff);

  // Diff panel
  $('#btnLoadFileA')?.addEventListener('click', () => $('#diffFileA').click());
  $('#btnLoadFileB')?.addEventListener('click', () => $('#diffFileB').click());
  $('#diffFileA')?.addEventListener('change', (e) => loadDiffFile(e, 'A'));
  $('#diffFileB')?.addEventListener('change', (e) => loadDiffFile(e, 'B'));
  $('#btnRunDiff')?.addEventListener('click', runDiff);

  // Editor settings
  $('#editorSelect')?.addEventListener('change', saveSettings);
  $('#workspaceRoot')?.addEventListener('change', saveSettings);

  // Settings
  $('#outputFormat').addEventListener('change', saveSettings);
  $$('.settings-checkboxes input').forEach(el => {
    el.addEventListener('change', saveSettings);
  });
  $('#maxLines').addEventListener('change', saveSettings);

  // Detail panel
  $('#btnCloseDetail').addEventListener('click', hideDetail);

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tags-dropdown')) {
      $('#tagsDropdown').classList.remove('open');
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);

  // Timeline interaction
  $('#timelineCanvas').addEventListener('click', handleTimelineClick);

  // Log entry clicks (event delegation)
  $('#logsList').addEventListener('click', (e) => {
    const entry = e.target.closest('.log-entry');
    if (entry) {
      const index = parseInt(entry.dataset.index, 10);
      if (!isNaN(index)) {
        showLogDetail(index);
      }
    }
  });
}

// ============ Data Loading ============
async function refreshLogs() {
  if (!state.tabId) return;

  try {
    const response = await chrome.tabs.sendMessage(state.tabId, { cmd: 'getBuffer' });
    if (response?.buffer) {
      state.logs = response.buffer;
      state.capturing = response.captureEnabled !== false;
      updateCaptureStatus();
      updateTags();
      applyFilters();
    }
  } catch (e) {
    // Tab might not be ready yet
  }
}

async function clearLogs() {
  if (!state.tabId) return;

  try {
    await chrome.tabs.sendMessage(state.tabId, { cmd: 'clearBuffer' });
    state.logs = [];
    state.filteredLogs = [];
    renderLogs();
    renderTimeline();
    updateStats();
    showToast('Logs cleared', 'success');
  } catch (e) {
    showToast('Failed to clear logs', 'error');
  }
}

async function toggleCapture() {
  if (!state.tabId) return;

  state.capturing = !state.capturing;

  try {
    await chrome.tabs.sendMessage(state.tabId, {
      cmd: 'toggleCapture',
      enabled: state.capturing
    });
    updateCaptureStatus();
    showToast(state.capturing ? 'Capture resumed' : 'Capture paused', 'success');
  } catch (e) {
    showToast('Failed to toggle capture', 'error');
  }
}

function updateCaptureStatus() {
  const badge = $('#statusBadge');
  const btn = $('#btnToggleCapture');

  if (state.capturing) {
    badge.textContent = 'Capturing';
    badge.className = 'status-badge status-active';
    btn.querySelector('.icon').innerHTML = '&#x23F8;';
    btn.title = 'Pause capture';
  } else {
    badge.textContent = 'Paused';
    badge.className = 'status-badge status-paused';
    btn.querySelector('.icon').innerHTML = '&#x25B6;';
    btn.title = 'Resume capture';
  }
}

// ============ Filtering ============
function applyFilters() {
  let logs = [...state.logs];

  // Search query
  if (state.searchQuery) {
    logs = applySearchFilter(logs, state.searchQuery);
  }

  // Time range
  if (state.timeRange) {
    logs = logs.filter(log => {
      const ts = log.timestamp || 0;
      return ts >= state.timeRange.start && ts <= state.timeRange.end;
    });
  }

  // Level filter
  logs = logs.filter(log => {
    const level = log.level || 'info';
    return state.levels[level];
  });

  // Tag filter
  if (state.activeTags.size > 0 && state.activeTags.size < state.allTags.size) {
    logs = logs.filter(log => {
      return !log.tag || state.activeTags.has(log.tag);
    });
  }

  // Dedupe
  if (state.dedupe) {
    logs = deduplicateLogs(logs);
  }

  state.filteredLogs = logs;
  renderLogs();
  renderTimeline();
  updateStats();
  updateLevelCounts();
}

function applySearchFilter(logs, query) {
  // Check for regex pattern
  const regexMatch = query.match(/^\/(.*?)\/([gimsu]*)$/);
  if (regexMatch) {
    try {
      const regex = new RegExp(regexMatch[1], regexMatch[2] || 'i');
      return logs.filter(log => {
        return regex.test(log.message || '') ||
               regex.test(log.raw || '') ||
               regex.test(log.tag || '');
      });
    } catch {
      return logs;
    }
  }

  // Simple text search
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return logs.filter(log => {
    const text = `${log.message || ''} ${log.raw || ''} ${log.tag || ''} ${log.file || ''}`.toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

function deduplicateLogs(logs) {
  const result = [];
  let prevKey = '';
  let prevLog = null;
  let repeatCount = 1;

  for (const log of logs) {
    const key = `${log.level}:${log.tag || ''}:${log.message || ''}`;

    if (key === prevKey && prevLog) {
      repeatCount++;
      prevLog._repeatCount = repeatCount;
    } else {
      if (prevLog) {
        result.push(prevLog);
      }
      prevLog = { ...log, _repeatCount: 1 };
      prevKey = key;
      repeatCount = 1;
    }
  }

  if (prevLog) {
    result.push(prevLog);
  }

  return result;
}

// ============ Search ============
function handleSearch(e) {
  state.searchQuery = e.target.value.trim();
  applyFilters();

  // Update hint
  const hint = $('#searchHint');
  if (state.searchQuery) {
    hint.textContent = `Showing ${state.filteredLogs.length} results`;
  } else {
    hint.textContent = '';
  }
}

function clearSearch() {
  $('#searchInput').value = '';
  state.searchQuery = '';
  applyFilters();
  $('#searchHint').textContent = '';
}

// ============ Level Filters ============
function toggleLevel(level) {
  state.levels[level] = !state.levels[level];

  const btn = $(`#lvl${level.charAt(0).toUpperCase() + level.slice(1)}`);
  btn.classList.toggle('active', state.levels[level]);

  applyFilters();
}

function updateLevelCounts() {
  const counts = { info: 0, warn: 0, error: 0, debug: 0 };

  for (const log of state.logs) {
    const level = log.level || 'info';
    if (counts[level] !== undefined) {
      counts[level]++;
    }
  }

  $('#countInfo').textContent = counts.info;
  $('#countWarn').textContent = counts.warn;
  $('#countError').textContent = counts.error;
  $('#countDebug').textContent = counts.debug;
}

// ============ Tags ============
function updateTags() {
  state.allTags.clear();
  for (const log of state.logs) {
    if (log.tag) {
      state.allTags.add(log.tag);
    }
  }

  // Auto-select all new tags
  for (const tag of state.allTags) {
    state.activeTags.add(tag);
  }

  renderTagsList();
  updateTagsCount();
}

function renderTagsList() {
  const container = $('#tagsList');
  container.innerHTML = '';

  const sorted = [...state.allTags].sort();

  for (const tag of sorted) {
    const count = state.logs.filter(l => l.tag === tag).length;
    const checked = state.activeTags.has(tag);

    const item = document.createElement('label');
    item.className = 'tag-item';
    item.innerHTML = `
      <input type="checkbox" ${checked ? 'checked' : ''} data-tag="${tag}">
      <span class="tag-name">${escapeHtml(tag)}</span>
      <span class="tag-count">${count}</span>
    `;

    item.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) {
        state.activeTags.add(tag);
      } else {
        state.activeTags.delete(tag);
      }
      applyFilters();
      updateTagsCount();
    });

    container.appendChild(item);
  }
}

function toggleTagsDropdown() {
  $('#tagsDropdown').classList.toggle('open');
}

function filterTags() {
  const query = $('#tagsSearch').value.toLowerCase();
  $$('.tag-item').forEach(item => {
    const name = item.querySelector('.tag-name').textContent.toLowerCase();
    item.style.display = name.includes(query) ? '' : 'none';
  });
}

function selectAllTags(select) {
  if (select) {
    state.activeTags = new Set(state.allTags);
  } else {
    state.activeTags.clear();
  }

  $$('.tag-item input').forEach(input => {
    input.checked = select;
  });

  applyFilters();
  updateTagsCount();
}

function updateTagsCount() {
  const count = $('#countTags');
  if (state.activeTags.size === 0) {
    count.textContent = 'None';
  } else if (state.activeTags.size === state.allTags.size) {
    count.textContent = 'All';
  } else {
    count.textContent = state.activeTags.size;
  }
}

// ============ Dedupe ============
function toggleDedupe() {
  state.dedupe = !state.dedupe;
  $('#btnDedupe').classList.toggle('active', state.dedupe);
  applyFilters();
}

// ============ Group by Request ============
function toggleGroupByRequest() {
  state.groupByRequest = !state.groupByRequest;
  $('#btnGroup').classList.toggle('active', state.groupByRequest);
  applyFilters();
}

// ============ Rendering ============
function renderLogs() {
  const container = $('#logsList');

  if (state.filteredLogs.length === 0) {
    container.innerHTML = `
      <div class="logs-empty">
        <div class="empty-icon">&#x1F4DD;</div>
        <div class="empty-title">No logs to display</div>
        <div class="empty-subtitle">${state.logs.length > 0 ? 'Try adjusting your filters' : 'Console output will appear here as you browse'}</div>
      </div>
    `;
    return;
  }

  // Limit for performance
  const maxRender = 1000;
  const logs = state.filteredLogs.slice(-maxRender);

  container.innerHTML = logs.map((log, i) => renderLogEntry(log, i)).join('');

  // Scroll to bottom if near bottom
  if (container.scrollHeight - container.scrollTop < container.clientHeight + 100) {
    container.scrollTop = container.scrollHeight;
  }
}

function renderLogEntry(log, index) {
  const level = log.level || 'info';
  const time = log.time || '';
  const tag = log.tag ? `<span class="log-tag">[${escapeHtml(log.tag)}]</span>` : '';
  const message = escapeHtml(log.message || '');
  const file = log.file ? `<span class="log-file">${escapeHtml(log.file)}${log.line ? ':' + log.line : ''}</span>` : '';
  const repeat = log._repeatCount > 1 ? `<span class="log-repeat">x${log._repeatCount}</span>` : '';

  return `
    <div class="log-entry level-${level}" data-id="${log.id || index}" data-index="${index}">
      <div class="log-level-indicator"></div>
      <span class="log-time">${time}</span>
      ${tag}
      <span class="log-message">${message}</span>
      ${file}
      ${repeat}
    </div>
  `;
}

// ============ Timeline ============
function renderTimeline() {
  const canvas = $('#timelineCanvas');
  const ctx = canvas.getContext('2d');

  // Set canvas size
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.logs.length === 0) {
    $('#timelineStart').textContent = '--:--';
    $('#timelineEnd').textContent = '--:--';
    return;
  }

  // Get time range
  const times = state.logs.map(l => l.timestamp || 0).filter(t => t > 0);
  if (times.length === 0) return;

  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const range = maxTime - minTime || 1;

  // Update labels
  $('#timelineStart').textContent = formatTime(minTime);
  $('#timelineEnd').textContent = formatTime(maxTime);

  // Draw density bars
  const buckets = 100;
  const bucketSize = range / buckets;
  const density = new Array(buckets).fill(0);
  const errors = new Array(buckets).fill(0);
  const warns = new Array(buckets).fill(0);

  for (const log of state.logs) {
    const ts = log.timestamp || 0;
    if (ts === 0) continue;

    const bucketIndex = Math.min(Math.floor((ts - minTime) / bucketSize), buckets - 1);
    density[bucketIndex]++;

    if (log.level === 'error') errors[bucketIndex]++;
    if (log.level === 'warn') warns[bucketIndex]++;
  }

  const maxDensity = Math.max(...density) || 1;
  const barWidth = canvas.width / buckets;

  for (let i = 0; i < buckets; i++) {
    const height = (density[i] / maxDensity) * canvas.height;
    const x = i * barWidth;

    // Base color
    ctx.fillStyle = 'rgba(100, 100, 100, 0.5)';
    ctx.fillRect(x, canvas.height - height, barWidth - 1, height);

    // Errors (red dots on top)
    if (errors[i] > 0) {
      ctx.fillStyle = 'rgba(241, 76, 76, 0.8)';
      ctx.beginPath();
      ctx.arc(x + barWidth / 2, 4, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Warnings (yellow dots)
    if (warns[i] > 0 && errors[i] === 0) {
      ctx.fillStyle = 'rgba(204, 167, 0, 0.8)';
      ctx.beginPath();
      ctx.arc(x + barWidth / 2, 4, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function handleTimelineClick(e) {
  const canvas = $('#timelineCanvas');
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const percentage = x / rect.width;

  // Get time range
  const times = state.logs.map(l => l.timestamp || 0).filter(t => t > 0);
  if (times.length === 0) return;

  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const clickTime = minTime + (maxTime - minTime) * percentage;

  // Find closest log
  let closest = null;
  let closestDiff = Infinity;

  for (let i = 0; i < state.filteredLogs.length; i++) {
    const diff = Math.abs((state.filteredLogs[i].timestamp || 0) - clickTime);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = i;
    }
  }

  if (closest !== null) {
    showLogDetail(closest);

    // Scroll to log
    const container = $('#logsList');
    const entry = container.children[closest];
    if (entry) {
      entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

// ============ Stats ============
function updateStats() {
  $('#statTotal .stat-value').textContent = state.logs.length;
  $('#statFiltered .stat-value').textContent = state.filteredLogs.length;

  // Session info
  const now = new Date();
  $('#statSession .stat-value').textContent = formatTime(now.getTime());
}

// ============ Log Detail ============
function showLogDetail(index) {
  const log = state.filteredLogs[index];
  if (!log) return;

  state.selectedLogId = log.id || index;

  // Highlight selected
  $$('.log-entry').forEach(el => el.classList.remove('selected'));
  const entry = $(`.log-entry[data-id="${state.selectedLogId}"]`);
  if (entry) entry.classList.add('selected');

  // Fill detail panel
  $('#detailTime').textContent = log.time || '';
  $('#detailLevel').textContent = log.level || 'info';
  $('#detailLevel').className = `detail-level ${log.level || 'info'}`;

  // File with editor link
  const fileEl = $('#detailFile');
  if (log.file) {
    fileEl.textContent = `${log.file}${log.line ? ':' + log.line : ''}`;
    fileEl.classList.add('clickable');
    fileEl.onclick = () => openInEditor(log.file, log.line, log.column);
  } else {
    fileEl.textContent = '';
    fileEl.classList.remove('clickable');
    fileEl.onclick = null;
  }

  $('#detailMessage').textContent = log.message || '';

  // Snapshot
  const snapshotEl = $('#detailSnapshot');
  if (log.snapshot) {
    snapshotEl.textContent = JSON.stringify(log.snapshot, null, 2);
    snapshotEl.style.display = '';
  } else {
    snapshotEl.style.display = 'none';
  }

  // Stack trace with editor links
  const stackEl = $('#detailStack');
  if (stackEl && log.stack) {
    stackEl.innerHTML = formatStackTrace(log.stack);
    stackEl.style.display = '';
  } else if (stackEl) {
    stackEl.style.display = 'none';
  }

  // Context (events around this log)
  const contextEl = $('#detailContext');
  const eventsEl = $('#contextEvents');
  if (contextEl && eventsEl && log.timestamp) {
    const context = getContextForLog(log.timestamp);
    if (context.length > 0) {
      eventsEl.innerHTML = context.map(e => `
        <div class="context-event ${e.type}">
          <span class="context-event-time">${formatTime(e.timestamp)}</span>
          <span class="context-event-type">${e.type}</span>
          <span class="context-event-detail">${escapeHtml(formatContextEvent(e))}</span>
        </div>
      `).join('');
      contextEl.style.display = '';
    } else {
      contextEl.style.display = 'none';
    }
  } else if (contextEl) {
    contextEl.style.display = 'none';
  }

  $('#detailPanel').style.display = '';
}

function formatStackTrace(stack) {
  if (!stack) return '';

  const lines = stack.split('\n');
  return lines.map(line => {
    // Parse stack trace line
    const match = line.match(/at\s+(?:([\w.<>]+)\s+)?\(?([^:]+):(\d+):(\d+)\)?/);
    if (match) {
      const [, func, file, lineNum, col] = match;
      const link = generateEditorLink(file, lineNum, col);
      const funcName = func || 'anonymous';
      return `<div class="stack-frame">at ${escapeHtml(funcName)} (<a href="${link}" class="editor-link">${escapeHtml(file)}:${lineNum}:${col}</a>)</div>`;
    }
    return `<div class="stack-frame">${escapeHtml(line)}</div>`;
  }).join('');
}

function getContextForLog(timestamp) {
  // Get logs within 5 seconds before this log
  const windowMs = 5000;
  const start = timestamp - windowMs;

  return state.logs
    .filter(l => l.timestamp >= start && l.timestamp < timestamp)
    .slice(-10)
    .map(l => ({
      type: l.level || 'info',
      timestamp: l.timestamp,
      message: l.message
    }));
}

function formatContextEvent(event) {
  return (event.message || '').slice(0, 50);
}

function hideDetail() {
  $('#detailPanel').style.display = 'none';
  state.selectedLogId = null;
  $$('.log-entry').forEach(el => el.classList.remove('selected'));
}

// ============ Settings ============
function showSettings() {
  // Populate current values
  $('#outputFormat').value = state.settings.outputFormat;
  $('#optShowTimestamps').checked = state.settings.showTimestamps;
  $('#optShowFiles').checked = state.settings.showFiles;
  $('#optShowTags').checked = state.settings.showTags;
  $('#optShowEmoji').checked = state.settings.showEmoji;
  $('#optLineNumbers').checked = state.settings.lineNumbers;
  $('#maxLines').value = state.settings.maxLines;
  $('#optAnonymize').checked = state.settings.anonymize;

  // Editor settings
  const editorSelect = $('#editorSelect');
  const workspaceRoot = $('#workspaceRoot');
  if (editorSelect) editorSelect.value = state.settings.editor || 'vscode';
  if (workspaceRoot) workspaceRoot.value = state.settings.workspaceRoot || '';

  $('#settingsPanel').style.display = '';
}

function hideSettings() {
  $('#settingsPanel').style.display = 'none';
}

async function saveSettings() {
  state.settings = {
    outputFormat: $('#outputFormat').value,
    showTimestamps: $('#optShowTimestamps').checked,
    showFiles: $('#optShowFiles').checked,
    showTags: $('#optShowTags').checked,
    showEmoji: $('#optShowEmoji').checked,
    lineNumbers: $('#optLineNumbers').checked,
    maxLines: parseInt($('#maxLines').value) || 500,
    anonymize: $('#optAnonymize').checked,
    editor: $('#editorSelect')?.value || 'vscode',
    workspaceRoot: $('#workspaceRoot')?.value || ''
  };

  await chrome.storage.local.set({ logtapSettings: state.settings });
}

// ============ Copy ============
function copyLogs() {
  const text = formatLogsForCopy();
  const logCount = Array.isArray(state.filteredLogs) ? state.filteredLogs.length : 0;

  // Use execCommand as primary method in DevTools context
  // (navigator.clipboard is blocked by permissions policy)
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();

  try {
    const success = document.execCommand('copy');
    if (success) {
      showToast(`Copied ${logCount} logs`, 'success');
    } else {
      showToast('Copy failed - try selecting and copying manually', 'error');
    }
  } catch (err) {
    showToast('Copy failed: ' + err.message, 'error');
  } finally {
    document.body.removeChild(ta);
  }
}

function formatLogsForCopy() {
  const s = state.settings;
  let logs = state.filteredLogs;

  // Apply limit
  if (s.maxLines > 0 && logs.length > s.maxLines) {
    logs = logs.slice(-s.maxLines);
  }

  const EMOJI = { error: '\u274C', warn: '\u26A0\uFE0F', info: '\u2139\uFE0F', debug: '\uD83D\uDC1B' };

  switch (s.outputFormat) {
    case 'json':
      return JSON.stringify(logs, null, 2);

    case 'csv':
      const header = 'time,file,tag,level,message';
      const rows = logs.map(l => {
        const escape = str => '"' + (str || '').replace(/"/g, '""').replace(/\n/g, ' ') + '"';
        return [
          escape(s.showTimestamps ? l.time : ''),
          escape(s.showFiles && l.file ? l.file + (l.line ? ':' + l.line : '') : ''),
          escape(s.showTags ? l.tag : ''),
          escape(l.level || 'info'),
          escape(l.message || '')
        ].join(',');
      });
      return [header, ...rows].join('\n');

    case 'plain':
      return formatPlainText(logs, s, EMOJI);

    case 'markdown':
    default:
      return '```\n' + formatPlainText(logs, s, EMOJI) + '\n```';
  }
}

function formatPlainText(logs, settings, EMOJI) {
  return logs.map((l, i) => {
    const parts = [];

    if (settings.showEmoji) {
      parts.push(EMOJI[l.level] || '');
    }

    if (settings.showTimestamps && l.time) {
      parts.push(`[${l.time}]`);
    }

    if (settings.showFiles && l.file) {
      parts.push(l.file + (l.line ? ':' + l.line : ''));
    }

    let msg = l.message || '';
    if (settings.showTags && l.tag) {
      msg = `[${l.tag}] ${msg}`;
    }

    if (l._repeatCount > 1) {
      msg += ` [x${l._repeatCount}]`;
    }

    parts.push(msg);

    let line = parts.filter(Boolean).join(' ');

    if (settings.lineNumbers) {
      line = String(i + 1).padStart(4, ' ') + ' | ' + line;
    }

    return line;
  }).join('\n');
}

// ============ Export/Import ============
async function exportLogs() {
  const data = {
    magic: 'LOGTAP',
    version: '3.0',
    exported: Date.now(),
    logs: state.settings.anonymize ? anonymizeLogs(state.filteredLogs) : state.filteredLogs,
    metadata: {
      count: state.filteredLogs.length,
      anonymized: state.settings.anonymize
    }
  };

  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });

  const date = new Date().toISOString().split('T')[0];
  const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
  const filename = `logtap-${date}-${time}.logtap`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`Exported ${state.filteredLogs.length} logs`, 'success');
}

async function importLogs(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (data.magic !== 'LOGTAP') {
      throw new Error('Invalid file format');
    }

    if (data.logs && Array.isArray(data.logs)) {
      // Send to content script
      await chrome.tabs.sendMessage(state.tabId, {
        cmd: 'importLogs',
        logs: data.logs
      });

      await refreshLogs();
      showToast(`Imported ${data.logs.length} logs`, 'success');
    }
  } catch (err) {
    showToast('Failed to import: ' + err.message, 'error');
  }

  e.target.value = '';
}

function anonymizeLogs(logs) {
  const patterns = {
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    ip: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    url: /https?:\/\/[^\s"'<>]+/gi,
    jwt: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
  };

  return logs.map(log => {
    const anonymized = { ...log };

    if (anonymized.message) {
      anonymized.message = anonymized.message
        .replace(patterns.email, '[EMAIL]')
        .replace(patterns.ip, '[IP]')
        .replace(patterns.url, '[URL]')
        .replace(patterns.jwt, '[TOKEN]');
    }

    anonymized.file = undefined;
    anonymized.fullPath = undefined;

    return anonymized;
  });
}

// ============ Patterns Panel ============
function showPatterns() {
  const panel = $('#patternsPanel');
  const list = $('#patternsList');

  // Get patterns from state or calculate
  if (state.patterns.length === 0) {
    list.innerHTML = `
      <div class="patterns-empty">
        No patterns detected yet. Patterns are learned from your log history.
        <br><br>
        Patterns appear when the same sequence of logs occurs multiple times.
      </div>
    `;
  } else {
    list.innerHTML = state.patterns.map(p => `
      <div class="pattern-item ${p.severity}">
        <div class="pattern-header">
          <span class="pattern-message">${escapeHtml(p.message)}</span>
          <span class="pattern-count">${p.count}x</span>
        </div>
        <div class="pattern-sequence">
          ${p.sequence.map(s => escapeHtml(s.split(':').slice(2).join(':').slice(0, 40))).join(' → ')}
        </div>
      </div>
    `).join('');
  }

  panel.style.display = '';
}

function hidePatterns() {
  $('#patternsPanel').style.display = 'none';
}

// ============ Diff Panel ============
function showDiff() {
  const panel = $('#diffPanel');
  // Reset results
  $('#diffResults').innerHTML = '';
  state.diffSessionA = null;
  state.diffSessionB = null;
  panel.style.display = '';
}

function hideDiff() {
  $('#diffPanel').style.display = 'none';
}

async function loadDiffFile(e, session) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (data.magic !== 'LOGTAP') {
      throw new Error('Invalid file format');
    }

    if (session === 'A') {
      state.diffSessionA = data.logs;
      showToast(`Loaded ${data.logs.length} logs for Session A`, 'success');
    } else {
      state.diffSessionB = data.logs;
      showToast(`Loaded ${data.logs.length} logs for Session B`, 'success');
    }
  } catch (err) {
    showToast('Failed to load file: ' + err.message, 'error');
  }

  e.target.value = '';
}

function runDiff() {
  const sessionA = state.diffSessionA || state.logs;
  const sessionB = state.diffSessionB || state.logs;

  if (sessionA === sessionB) {
    showToast('Please load different sessions to compare', 'error');
    return;
  }

  // Simple diff implementation
  const diff = diffSessions(sessionA, sessionB);
  renderDiffResults(diff);
}

function diffSessions(logsA, logsB) {
  // Normalize logs for comparison
  const normalize = (log) => {
    let msg = (log.message || '').slice(0, 100);
    // Remove dynamic values
    msg = msg.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, '<TIME>');
    msg = msg.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
    msg = msg.replace(/\b\d{5,}\b/g, '<NUM>');
    return `${log.level || 'info'}:${log.tag || ''}:${msg}`;
  };

  const freqA = new Map();
  const freqB = new Map();

  for (const log of logsA) {
    const key = normalize(log);
    freqA.set(key, (freqA.get(key) || 0) + 1);
  }

  for (const log of logsB) {
    const key = normalize(log);
    freqB.set(key, (freqB.get(key) || 0) + 1);
  }

  const onlyInA = [];
  const onlyInB = [];
  const frequencyChanges = [];

  for (const [key, count] of freqA) {
    if (!freqB.has(key)) {
      onlyInA.push({ key, count });
    } else {
      const countB = freqB.get(key);
      if (countB >= count * 2 || countB <= count / 2) {
        frequencyChanges.push({ key, countA: count, countB });
      }
    }
  }

  for (const [key, count] of freqB) {
    if (!freqA.has(key)) {
      onlyInB.push({ key, count });
    }
  }

  const newErrors = onlyInB.filter(x => x.key.startsWith('error:'));
  const resolvedErrors = onlyInA.filter(x => x.key.startsWith('error:'));

  return {
    summary: {
      totalA: logsA.length,
      totalB: logsB.length,
      errorsA: logsA.filter(l => l.level === 'error').length,
      errorsB: logsB.filter(l => l.level === 'error').length
    },
    onlyInA,
    onlyInB,
    frequencyChanges,
    newErrors,
    resolvedErrors
  };
}

function renderDiffResults(diff) {
  const container = $('#diffResults');

  let html = `
    <div class="diff-section">
      <div class="diff-section-title">Summary</div>
      <div class="diff-item">Session A: ${diff.summary.totalA} logs (${diff.summary.errorsA} errors)</div>
      <div class="diff-item">Session B: ${diff.summary.totalB} logs (${diff.summary.errorsB} errors)</div>
    </div>
  `;

  if (diff.newErrors.length > 0) {
    html += `
      <div class="diff-section">
        <div class="diff-section-title new-errors">🔴 New Errors (${diff.newErrors.length})</div>
        ${diff.newErrors.slice(0, 5).map(e => `
          <div class="diff-item">${escapeHtml(e.key.split(':').slice(2).join(':').slice(0, 60))} (${e.count}x)</div>
        `).join('')}
      </div>
    `;
  }

  if (diff.resolvedErrors.length > 0) {
    html += `
      <div class="diff-section">
        <div class="diff-section-title resolved">🟢 Resolved Errors (${diff.resolvedErrors.length})</div>
        ${diff.resolvedErrors.slice(0, 5).map(e => `
          <div class="diff-item">${escapeHtml(e.key.split(':').slice(2).join(':').slice(0, 60))} (was ${e.count}x)</div>
        `).join('')}
      </div>
    `;
  }

  if (diff.onlyInB.length > 0) {
    html += `
      <div class="diff-section">
        <div class="diff-section-title changes">🆕 New in Session B (${diff.onlyInB.length})</div>
        ${diff.onlyInB.slice(0, 5).map(e => `
          <div class="diff-item">${escapeHtml(e.key.split(':').slice(2).join(':').slice(0, 60))} (${e.count}x)</div>
        `).join('')}
      </div>
    `;
  }

  container.innerHTML = html;
}

// ============ Editor Links ============
function generateEditorLink(file, line, column) {
  const editor = state.settings.editor || 'vscode';
  const root = state.settings.workspaceRoot || '';

  // Resolve path
  let path = file;
  if (root && !file.startsWith('/') && !file.match(/^[A-Z]:/i)) {
    path = `${root}/${file}`;
  }

  switch (editor) {
    case 'vscode':
      return `vscode://file/${path}${line ? ':' + line : ''}${column ? ':' + column : ''}`;
    case 'cursor':
      return `cursor://file/${path}${line ? ':' + line : ''}${column ? ':' + column : ''}`;
    case 'webstorm':
      return `webstorm://open?file=${encodeURIComponent(path)}${line ? '&line=' + line : ''}`;
    case 'idea':
      return `idea://open?file=${encodeURIComponent(path)}${line ? '&line=' + line : ''}`;
    case 'sublime':
      return `subl://open?url=file://${path}${line ? '&line=' + line : ''}`;
    default:
      return `vscode://file/${path}${line ? ':' + line : ''}`;
  }
}

function openInEditor(file, line, column) {
  const url = generateEditorLink(file, line, column);
  if (url) {
    const a = document.createElement('a');
    a.href = url;
    a.click();
  }
}

// ============ Keyboard ============
function handleKeyboard(e) {
  // Escape to close panels
  if (e.key === 'Escape') {
    hideDetail();
    hideSettings();
    hidePatterns();
    hideDiff();
    $('#tagsDropdown').classList.remove('open');
  }

  // Ctrl/Cmd + K to focus search
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    $('#searchInput').focus();
  }

  // Ctrl/Cmd + Shift + C to copy
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
    e.preventDefault();
    copyLogs();
  }
}

// ============ Utilities ============
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(timestamp) {
  if (!timestamp) return '--:--';
  const d = new Date(timestamp);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function showToast(message, type = 'success') {
  const toast = $('#toast');
  const icon = $('#toastIcon');
  const msg = $('#toastMessage');

  toast.className = `toast ${type}`;
  icon.innerHTML = type === 'success' ? '&#x2714;' : '&#x2718;';
  msg.textContent = message;
  toast.style.display = '';

  setTimeout(() => {
    toast.style.display = 'none';
  }, 3000);
}

// ============ Start ============
init();
