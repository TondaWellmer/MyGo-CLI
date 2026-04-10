const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { OpenCodeChat } = require('./opencode-chat/chat');
const { SkillsPanel } = require('./skills-panel/skills-panel');
const { SettingsPanel } = require('./settings/settings-panel');
const { ModelManager } = require('./opencode-chat/model-manager');
const { Orchestrator } = require('./opencode-chat/orchestrator');
const { DigestEngine } = require('./opencode-chat/digest-engine');

// Global OpenCode Chat instance — sofort oeffnen (kein Terminal-Flicker beim Start)
const openCodeChat = new OpenCodeChat();
window._openCodeChat = openCodeChat;
openCodeChat.open();

// Global Skills Panel instance
const skillsPanel = new SkillsPanel();

// === Multi-Tab Terminal System ===
// Default terminal theme — will be overridden by per-tab color and Settings theme
const DEFAULT_THEME = {
  background: '#efefeb',
  foreground: '#2a2a30',
  cursor: '#4a6adf',
  cursorAccent: '#efefeb',
  selectionBackground: '#c8d0e8',
  selectionForeground: '#1a1a20',
  black: '#2a2a30',
  red: '#c03040',
  green: '#2a8a40',
  yellow: '#9a7020',
  blue: '#3a5ac0',
  magenta: '#7a40b0',
  cyan: '#2a8a8a',
  white: '#d0d0cc',
  brightBlack: '#5a5a68',
  brightRed: '#d04058',
  brightGreen: '#2a9a50',
  brightYellow: '#b08030',
  brightBlue: '#4a6adf',
  brightMagenta: '#9060d0',
  brightCyan: '#3aa0a0',
  brightWhite: '#f0f0ec'
};

const tabs = new Map(); // tabId -> { term, fitAddon, color, name, el }
let activeTabId = 'tab-0';

function createTermTab(tabId, color, name) {
  const termEl = document.createElement('div');
  termEl.id = 'terminal-' + tabId;
  termEl.style.width = '100%';
  termEl.style.height = '100%';
  termEl.style.display = 'none';
  document.getElementById('terminal').appendChild(termEl);

  const tabTheme = { ...DEFAULT_THEME, background: color || '#efefeb' };
  const term = new Terminal({
    theme: tabTheme,
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, monospace",
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    allowProposedApi: true
  });

  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon((_, uri) => {
    window.pangea.openUrl(uri);
  });

  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  term.open(termEl);

  // Keyboard shortcuts per tab
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.key === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (e.ctrlKey && e.key === 'a') { term.selectAll(); return false; }
    if (e.ctrlKey && e.key === 'h' && term.hasSelection()) {
      saveTextShot(term.getSelection());
      return false;
    }
    return true;
  });

  term.onSelectionChange(() => {
    const shotBtn = document.getElementById('shot-btn');
    if (shotBtn && tabId === activeTabId) {
      shotBtn.classList.toggle('visible', term.hasSelection());
    }
  });

  term.onData((data) => {
    window.pangea.sendTerminalInput({ tabId, data });
  });

  const tabData = {
    term, fitAddon, termEl,
    color: color || '#efefeb',
    name: name || '',
    userScrolledUp: false  // Smart scroll: track if user scrolled away from bottom
  };
  tabs.set(tabId, tabData);

  // Smart scroll detection: pause auto-follow when user scrolls up
  term.onScroll(() => {
    const buf = term.buffer.active;
    const isAtBottom = buf.viewportY >= buf.baseY;
    tabData.userScrolledUp = !isAtBottom;
  });
  // Mouse wheel up = user wants to read, respect that
  termEl.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) tabData.userScrolledUp = true;
    // Scrolling down past the bottom resets auto-follow
    if (e.deltaY > 0) {
      requestAnimationFrame(() => {
        const buf = term.buffer.active;
        if (buf.viewportY >= buf.baseY) tabData.userScrolledUp = false;
      });
    }
  }, { passive: true });

  // Add tab button to strip
  addTabButton(tabId, tabData.color);

  return tabData;
}

// ─── Tab Drag & Drop ───
function makeTabDraggable(tabEl) {
  tabEl.draggable = true;

  tabEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabEl.dataset.tabId);
    tabEl.classList.add('dragging');
    // Minimal drag image
    const ghost = tabEl.cloneNode(true);
    ghost.style.opacity = '0.7';
    ghost.style.position = 'absolute';
    ghost.style.top = '-9999px';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => document.body.removeChild(ghost), 0);
  });

  tabEl.addEventListener('dragend', () => {
    tabEl.classList.remove('dragging');
    // Remove all drop indicators
    document.querySelectorAll('.term-tab').forEach(t => {
      t.classList.remove('drag-over-above', 'drag-over-below');
    });
  });

  tabEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const dragging = document.querySelector('.term-tab.dragging');
    if (!dragging || dragging === tabEl) return;

    // Determine if cursor is in top or bottom half
    const rect = tabEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    tabEl.classList.remove('drag-over-above', 'drag-over-below');
    if (e.clientY < midY) {
      tabEl.classList.add('drag-over-above');
    } else {
      tabEl.classList.add('drag-over-below');
    }
  });

  tabEl.addEventListener('dragleave', () => {
    tabEl.classList.remove('drag-over-above', 'drag-over-below');
  });

  tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    tabEl.classList.remove('drag-over-above', 'drag-over-below');
    const draggedId = e.dataTransfer.getData('text/plain');
    const strip = document.getElementById('term-tabs');
    const draggedEl = strip.querySelector(`[data-tab-id="${draggedId}"]`);
    if (!draggedEl || draggedEl === tabEl) return;

    // Insert before or after based on cursor position
    const rect = tabEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      strip.insertBefore(draggedEl, tabEl);
    } else {
      strip.insertBefore(draggedEl, tabEl.nextSibling);
    }
  });
}

function addTabButton(tabId, color) {
  const strip = document.getElementById('term-tabs');
  // If tab button already exists (e.g. tab-0 from HTML), just bind click handler
  const existing = strip.querySelector(`[data-tab-id="${tabId}"]`);
  if (existing) {
    if (!existing._hasSwitchHandler) {
      existing.addEventListener('click', () => switchTab(tabId));
      existing._hasSwitchHandler = true;
      makeTabDraggable(existing);
      // Add close button to preset tabs (except tab-0)
      if (tabId !== 'tab-0' && !existing.querySelector('.term-tab-close')) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'term-tab-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTab(tabId);
        });
        existing.appendChild(closeBtn);
      }
    }
    return;
  }

  const btn = document.createElement('div');
  btn.className = 'term-tab' + (tabId === activeTabId ? ' active' : '');
  btn.dataset.tabId = tabId;
  btn.title = tabs.get(tabId)?.name || 'Tab';

  const colorEl = document.createElement('span');
  colorEl.className = 'term-tab-color';
  colorEl.style.background = color;
  btn.appendChild(colorEl);

  // Close button (not for first tab)
  if (tabId !== 'tab-0') {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'term-tab-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tabId);
    });
    btn.appendChild(closeBtn);
  }

  btn.addEventListener('click', () => switchTab(tabId));
  makeTabDraggable(btn);
  strip.appendChild(btn);
}

function switchTab(tabId) {
  if (!tabs.has(tabId)) return;
  const prevTab = tabs.get(activeTabId);
  if (prevTab) prevTab.termEl.style.display = 'none';

  activeTabId = tabId;
  const tabData = tabs.get(tabId);
  tabData.termEl.style.display = 'block';
  tabData.fitAddon.fit();
  tabData.term.focus();

  // Update active state in strip
  document.querySelectorAll('.term-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tabId === tabId);
  });

  // Update color wheel to match this tab
  const colorPicker = document.getElementById('color-picker');
  if (colorPicker) colorPicker.value = tabData.color;

  // Update instance name (show tab id placeholder if no name set)
  const nameSpan = document.getElementById('instance-name');
  if (nameSpan) nameSpan.textContent = tabData.name || 'Pangea CLI';

  // Apply tab background color
  document.documentElement.style.setProperty('--bg-base', tabData.color);

  // Notify main process
  window.pangea.setActiveTab(tabId);
  window.pangea.resizeTerminal({ tabId, cols: tabData.term.cols, rows: tabData.term.rows });

  // Update global active tab reference for titlebar
  window._activeTabId = tabId;

  // Refresh session ID for this tab (each tab has its own session)
  window.pangea.getSessionId(tabId).then(id => {
    if (id && window._showSessionBtn) {
      window._showSessionBtn(id);
    } else if (window._hideSessionBtn) {
      window._hideSessionBtn();
    }
  }).catch(() => {});

  // Expose active term for color sync
  window._xtermInstance = tabData.term;
}

async function addNewTab() {
  const tabId = await window.pangea.createTab();
  const color = '#efefeb';
  createTermTab(tabId, color, '');
  switchTab(tabId);
}

function closeTab(tabId) {
  if (tabs.size <= 1) return; // Can't close last remaining tab
  const tabData = tabs.get(tabId);
  if (!tabData) return;

  // Show confirmation dialog before closing
  showTabCloseConfirm(tabId, () => {
    // Clean up
    tabData.term.dispose();
    tabData.termEl.remove();
    tabs.delete(tabId);
    window.pangea.closeTab(tabId);

    // Remove button
    const btn = document.querySelector(`.term-tab[data-tab-id="${tabId}"]`);
    if (btn) btn.remove();

    // Switch to first tab if we closed the active one
    if (activeTabId === tabId) {
      const firstId = tabs.keys().next().value;
      switchTab(firstId);
    }
  });
}

function showTabCloseConfirm(tabId, onClose) {
  // Remove any existing dialog
  const existing = document.getElementById('tab-close-confirm');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'tab-close-confirm';
  overlay.className = 'tab-close-overlay';
  overlay.innerHTML = `
    <div class="tab-close-dialog">
      <div class="tab-close-msg">Close this terminal session?</div>
      <div class="tab-close-actions">
        <button class="tab-close-btn tab-close-btn-close">Close</button>
        <button class="tab-close-btn tab-close-btn-keep">Keep</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('.tab-close-btn-close').addEventListener('click', () => {
    overlay.remove();
    onClose();
  });
  overlay.querySelector('.tab-close-btn-keep').addEventListener('click', () => {
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  // Focus Keep button by default (safe choice)
  overlay.querySelector('.tab-close-btn-keep').focus();
}

// Default preset tabs — 4 empty tabs with distinct colors, ready to be used
const DEFAULT_TABS = [
  { id: 'tab-0', color: '#212121', name: '' },
  { id: 'tab-1', color: '#605062', name: '' },
  { id: 'tab-2', color: '#354744', name: '' },
  { id: 'tab-3', color: '#181933', name: '' },
];

for (const preset of DEFAULT_TABS) {
  const tabData = createTermTab(preset.id, preset.color, preset.name);
  if (preset.id === 'tab-0') {
    tabData.termEl.style.display = 'block';
    window._xtermInstance = tabData.term;
  }
}

// Fit terminal to container
function fitTerminal() {
  const tabData = tabs.get(activeTabId);
  if (tabData) {
    tabData.fitAddon.fit();
    window.pangea.resizeTerminal({ tabId: activeTabId, cols: tabData.term.cols, rows: tabData.term.rows });
  }
}

fitTerminal();

// Handle resize
const resizeObserver = new ResizeObserver(() => {
  requestAnimationFrame(fitTerminal);
});
resizeObserver.observe(document.getElementById('terminal-container'));

// Terminal I/O — Multi-Tab aware
// Always scroll to bottom after write to prevent "stuck scroll" bug
// where the terminal jumps up and can't be scrolled back down.
window.pangea.onTerminalData((msg) => {
  let tabData;
  if (typeof msg === 'string') {
    tabData = tabs.get(activeTabId);
    if (tabData) tabData.term.write(msg);
  } else {
    tabData = tabs.get(msg.tabId);
    if (tabData) tabData.term.write(msg.data);
  }
  // Smart auto-scroll: only follow output if user hasn't scrolled up
  if (tabData && !tabData.userScrolledUp) tabData.term.scrollToBottom();
});

window.pangea.onTerminalExit((msg) => {
  if (typeof msg === 'number') {
    const tabData = tabs.get(activeTabId);
    if (tabData) tabData.term.write(`\r\n\x1b[33m[Shell beendet — wird neu gestartet...]\x1b[0m\r\n`);
  } else {
    const tabData = tabs.get(msg.tabId);
    if (tabData) tabData.term.write(`\r\n\x1b[33m[Shell beendet — wird neu gestartet...]\x1b[0m\r\n`);
  }
});

// Handle PTY respawn after crash — tab stays alive
window.pangea.onTerminalRespawned((msg) => {
  const tabData = tabs.get(msg.tabId);
  if (tabData) {
    tabData.term.write(`\x1b[32m[Shell neu gestartet]\x1b[0m\r\n`);
    // Re-fit the terminal to send correct dimensions to new PTY
    tabData.fitAddon.fit();
    window.pangea.resizeTerminal({ tabId: msg.tabId, cols: tabData.term.cols, rows: tabData.term.rows });
  }
});

// Wire add-tab button
document.getElementById('term-tab-add').addEventListener('click', addNewTab);

// Expose for Work Session restore (used by titlebar.js)
window._termTabs = tabs;
window._createTermTab = createTermTab;
window._switchTab = switchTab;

// Expose tab color update for titlebar color wheel
window._updateActiveTabColor = (color) => {
  const tabData = tabs.get(activeTabId);
  if (!tabData) return;
  tabData.color = color;
  // Update tab button color
  const btn = document.querySelector(`.term-tab[data-tab-id="${activeTabId}"] .term-tab-color`);
  if (btn) btn.style.background = color;
  // Notify main process
  window.pangea.setTabColor(activeTabId, color);
};

// Expose tab name update for titlebar name editing
window._updateActiveTabName = (name) => {
  const tabData = tabs.get(activeTabId);
  if (!tabData) return;
  tabData.name = name;
  const btn = document.querySelector(`.term-tab[data-tab-id="${activeTabId}"]`);
  if (btn) btn.title = name;
  window.pangea.setTabName(activeTabId, name);
};

// Divider drag-to-resize — uses CSS flex-basis, never breaks layout
const divider = document.getElementById('divider');
const termContainer = document.getElementById('terminal-container');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');

// Store sidebar width in pixels — default 30% of window
let sidebarWidth = Math.round(window.innerWidth * 0.3);
const SIDEBAR_MIN = 120;
const SIDEBAR_MAX = 500;
let sidebarCollapsed = true; // Start collapsed

function applySidebarWidth(w) {
  sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
  sidebar.style.width = sidebarWidth + 'px';
  sidebar.style.flex = 'none';
  termContainer.style.flex = '1';
  termContainer.style.width = '';
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  if (sidebarCollapsed) {
    sidebar.classList.add('collapsed');
    divider.classList.add('hidden');
  } else {
    sidebar.classList.remove('collapsed');
    divider.classList.remove('hidden');
    applySidebarWidth(sidebarWidth);
  }
  requestAnimationFrame(() => fitTerminal());
}

sidebarToggle.addEventListener('click', toggleSidebar);

divider.addEventListener('mousedown', (e) => {
  e.preventDefault();

  const onMove = (ev) => {
    const mainRect = document.getElementById('main').getBoundingClientRect();
    const newSidebarW = mainRect.right - ev.clientX;
    applySidebarWidth(newSidebarW);
    fitTerminal();
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    divider.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    fitTerminal();
  };

  divider.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// Text Shot save function
async function saveTextShot(text) {
  if (!text || !text.trim()) return;
  const result = await window.pangea.saveTextShot(text);
  const shotBtn = document.getElementById('shot-btn');
  if (shotBtn) {
    shotBtn.classList.add('saved');
    shotBtn.querySelector('.shot-label').textContent = result.filename;
    setTimeout(() => {
      shotBtn.classList.remove('saved');
      shotBtn.querySelector('.shot-label').textContent = '';
    }, 2000);
  }
  if (window._refreshTextShots) window._refreshTextShots();
}

// Expose saveTextShot for button (uses active tab's terminal)
window._saveTerminalShot = () => {
  const tabData = tabs.get(activeTabId);
  if (tabData && tabData.term.hasSelection()) saveTextShot(tabData.term.getSelection());
};

// --- Attachments ---
const attachments = []; // { path, filename, dataUrl, isImage, ext }
const attachPreview = document.getElementById('attachment-preview');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');

function renderAttachments() {
  attachPreview.innerHTML = '';
  attachPreview.classList.toggle('has-items', attachments.length > 0);

  attachments.forEach((att, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'attach-thumb';

    if (att.isImage && att.dataUrl) {
      const img = document.createElement('img');
      img.src = att.dataUrl;
      img.alt = att.filename;
      thumb.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'file-placeholder';
      const extLabel = document.createElement('span');
      extLabel.className = 'file-ext';
      extLabel.textContent = att.ext || '?';
      const nameLabel = document.createElement('span');
      nameLabel.textContent = att.filename.length > 10
        ? att.filename.substring(0, 8) + '...'
        : att.filename;
      placeholder.appendChild(extLabel);
      placeholder.appendChild(nameLabel);
      thumb.appendChild(placeholder);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attach-remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      attachments.splice(idx, 1);
      renderAttachments();
    });
    thumb.appendChild(removeBtn);


    attachPreview.appendChild(thumb);
  });
}

// Büroklammer-Button → File-Picker
attachBtn.addEventListener('click', async () => {
  const files = await window.pangea.pickFiles();
  if (files && files.length) {
    attachments.push(...files);
    renderAttachments();
  }
});

// Hidden file input fallback
fileInput.addEventListener('change', () => { fileInput.value = ''; });

// --- Editor Send: receive injected attachment from image editor ---
window.pangea.onAttachmentInjected((att) => {
  attachments.push(att);
  renderAttachments();
});

// --- Cross-Editor Bridge: Image ↔ Video transfer ---
// NOTE: Listener removed here — bridge.js handles onCrossEditorTransfer to avoid double-import.

// --- Attachment History Dropdown ---
const attachHistoryBtn = document.getElementById('attach-history-btn');
const attachHistoryDropdown = document.getElementById('attach-history-dropdown');
const attachHistoryList = document.getElementById('attach-history-list');

async function renderAttachHistory() {
  const items = await window.pangea.getAttachHistory();
  attachHistoryList.innerHTML = '';

  if (!items || items.length === 0) {
    attachHistoryList.innerHTML = '<div class="empty-state">No attachments yet</div>';
    return;
  }

  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'attach-history-item';

    const icon = document.createElement('div');
    icon.className = 'history-icon';
    if (item.isImage) {
      // Lazy-load thumbnail
      const img = document.createElement('img');
      img.alt = item.filename;
      // Load data URL async
      window.pangea.getFileDataUrl(item.path).then(url => {
        if (url) img.src = url;
        else { img.remove(); icon.innerHTML = '<span class="ext-badge">IMG</span>'; }
      });
      icon.appendChild(img);
    } else {
      const badge = document.createElement('span');
      badge.className = 'ext-badge';
      badge.textContent = item.ext || '?';
      icon.appendChild(badge);
    }

    const info = document.createElement('div');
    info.className = 'history-info';
    const name = document.createElement('div');
    name.className = 'history-name';
    name.textContent = item.filename;
    const time = document.createElement('div');
    time.className = 'history-time';
    time.textContent = formatRelativeTime(item.timestamp);
    info.appendChild(name);
    info.appendChild(time);

    el.appendChild(icon);
    el.appendChild(info);

    el.addEventListener('click', async () => {
      // Re-add to current attachments
      let dataUrl = null;
      if (item.isImage) {
        dataUrl = await window.pangea.getFileDataUrl(item.path);
      }
      attachments.push({
        path: item.path,
        filename: item.filename,
        dataUrl,
        isImage: item.isImage,
        ext: item.ext
      });
      renderAttachments();
      attachHistoryDropdown.classList.add('hidden');

    });

    attachHistoryList.appendChild(el);
  }
}

function formatRelativeTime(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `vor ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `vor ${days}d`;
}

attachHistoryBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = !attachHistoryDropdown.classList.contains('hidden');
  attachHistoryDropdown.classList.toggle('hidden');
  if (!isOpen) renderAttachHistory();
});

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (!attachHistoryDropdown.contains(e.target) && e.target !== attachHistoryBtn) {
    attachHistoryDropdown.classList.add('hidden');
  }
});

// --- Input Bar (supports Wispr Flow + Strg+A + Paste) ---
const inputBar = document.getElementById('input-bar');

// Paste handler — images from clipboard
// After pasting an image, user can still type text and send both together (like Perplexity)
inputBar.addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  let hasImage = false;
  let pastedText = '';

  if (items) {
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        hasImage = true;
      } else if (item.type === 'text/plain') {
        // Capture any text that came with the paste (e.g. copied text + screenshot)
        try { pastedText = e.clipboardData.getData('text/plain'); } catch (_) {}
      }
    }
  }

  if (hasImage) {
    e.preventDefault();
    // Insert any co-pasted text manually since we prevented default
    if (pastedText) {
      const start = inputBar.selectionStart;
      const end = inputBar.selectionEnd;
      inputBar.value = inputBar.value.slice(0, start) + pastedText + inputBar.value.slice(end);
      inputBar.selectionStart = inputBar.selectionEnd = start + pastedText.length;
    }
    const result = await window.pangea.pasteImage();
    if (result) {
      attachments.push(result);
      renderAttachments();
    }
    // Re-focus input so user can keep typing after image paste
    inputBar.focus();
  }
  // Text-only paste falls through normally
});

inputBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // User sent a command → re-enable auto-follow for the active terminal
    const activeTab = tabs.get(activeTabId);
    if (activeTab) { activeTab.userScrolledUp = false; activeTab.term.scrollToBottom(); }
    const text = inputBar.value;

    const hasAttachments = attachments.length > 0;

    if (text || hasAttachments) {
      // Save to history before clearing
      if (hasAttachments) {
        window.pangea.addToAttachHistory(attachments.map(a => ({
          path: a.path, filename: a.filename, isImage: a.isImage, ext: a.ext
        })));
      }

      // Build command: user text + attachment refs
      let command = text;
      if (hasAttachments) {
        const nonImagePaths = attachments
          .filter(a => !a.isImage)
          .map(a => a.path.replace(/\\/g, '/'));

        // Append file references for non-images
        if (nonImagePaths.length) {
          const refs = nonImagePaths.map(p => `[Attached: ${p}]`).join(' ');
          command = command ? `${command} ${refs}` : refs;
        }
      }

      if (command) {
        // Send text to PTY, then Enter (\r) after a generous delay.
        // Claude Code's readline needs time to process the input text
        // before receiving the carriage return. Using 500ms fixed delay
        // instead of scaling by length — more reliable across all inputs.
        // Double-Enter: send \r twice to ensure delivery even if terminal
        // didn't have focus or missed the first one.
        window.pangea.sendTerminalInput({ tabId: activeTabId, data: command });
        setTimeout(() => {
          window.pangea.sendTerminalInput({ tabId: activeTabId, data: '\r' });
          // Second Enter after short delay — safety net
          setTimeout(() => {
            window.pangea.sendTerminalInput({ tabId: activeTabId, data: '\r' });
          }, 150);
          // Re-focus input bar so user can keep typing without clicking
          requestAnimationFrame(() => inputBar.focus());
        }, 500);
      }

      // Clear
      inputBar.value = '';
      attachments.length = 0;
      renderAttachments();
    }
  }
  if (e.key === 'Escape') {
    if (attachments.length > 0) {
      attachments.length = 0;
      renderAttachments();
    } else {
      inputBar.value = '';
      term.focus();
    }
  }
  // Strg+A works natively in textarea — select all input text
});

// Shot button click
document.getElementById('shot-btn').addEventListener('click', () => {
  if (window._saveTerminalShot) window._saveTerminalShot();
});

// Refresh button — kompletter App-Neustart (Main + Renderer)
document.getElementById('refresh-btn').addEventListener('click', () => {
  if (window.pangea && window.pangea.relaunchApp) {
    window.pangea.relaunchApp();
  } else {
    window.location.reload();
  }
});

// Keyboard shortcut: Ctrl+Shift+R
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'R') {
    e.preventDefault();
    if (window.pangea && window.pangea.relaunchApp) {
      window.pangea.relaunchApp();
    } else {
      window.location.reload();
    }
  }
});

// --- View Switching (Chat / Terminal) ---
let activeEditorTab = 'terminal'; // 'terminal' | 'chat'

function switchEditorTab(tab) {
  if (openCodeChat.isOpen()) openCodeChat.hide();

  if (tab === 'chat') {
    if (!openCodeChat.isOpen()) {
      openCodeChat.open();
    } else {
      openCodeChat.show();
    }
  }
  // 'terminal' = chat hidden, terminal visible (default)
  if (tab === 'terminal') {
    const tabData = tabs.get(activeTabId);
    if (tabData) {
      requestAnimationFrame(() => {
        tabData.fitAddon.fit();
        tabData.term.focus();
        document.documentElement.style.setProperty('--bg-base', tabData.color);
      });
    }
  }

  activeEditorTab = tab;
  window._activeEditorTab = tab;
}

window.switchEditorTab = switchEditorTab;
window._activeEditorTab = activeEditorTab;

// --- Chat Button (titlebar chat icon) ---
document.getElementById('chat-btn').addEventListener('click', () => {
  switchEditorTab(activeEditorTab === 'chat' ? 'terminal' : 'chat');
  document.getElementById('chat-btn').classList.add('active');
  document.getElementById('terminal-btn')?.classList.remove('active');
});

// --- Terminal Button (titlebar terminal icon) ---
const terminalBtn = document.getElementById('terminal-btn');
if (terminalBtn) {
  terminalBtn.addEventListener('click', () => {
    switchEditorTab('terminal');
    terminalBtn.classList.add('active');
    document.getElementById('chat-btn')?.classList.remove('active');
  });
}

// --- Floating Microphone Button (Push-to-Talk via Web Speech API + Audio Visualizer) ---
// Hold button OR hold Shift+A to dictate. Text appears directly in active input.
// Button glows with mic audio level for visual feedback.
const floatingMic = document.createElement('button');
floatingMic.className = 'ai-floating-mic';
floatingMic.title = 'Hold to dictate (or Shift+A)';
floatingMic.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
document.body.appendChild(floatingMic);

let dictationActive = false;
let speechRecognition = null;
let interimText = '';
let finalText = '';
let audioCtx = null;
let analyser = null;
let micStream = null;
let vuAnimFrame = null;

function getActiveInput() {
  const chatInput = document.querySelector('.chat-input');
  if (chatInput && chatInput.offsetParent !== null) return chatInput;
  return document.getElementById('input-bar');
}

// Audio VU meter — makes button glow with mic volume
function startVU(stream) {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    function tick() {
      if (!dictationActive) return;
      // Use time-domain data (waveform) — more sensitive than frequency data
      analyser.getByteTimeDomainData(data);
      // Calculate RMS volume from waveform (128 = silence)
      let sumSq = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128; // normalize to -1..+1
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / data.length);
      const vol = Math.min(1, rms * 4); // amplify — speech is typically 0.05-0.25 RMS
      // Map to glow intensity
      const glow = Math.min(30, Math.round(vol * 60));
      const scale = 1 + vol * 0.15;
      floatingMic.style.boxShadow = `0 0 ${glow}px ${Math.round(glow/2)}px rgba(240,112,136,${0.2 + vol * 0.5}), 0 4px 16px rgba(240,112,136,0.35)`;
      floatingMic.style.transform = `scale(${scale.toFixed(2)})`;
      // Brightness on the button itself
      floatingMic.style.filter = `brightness(${(1 + vol * 0.8).toFixed(2)})`;
      vuAnimFrame = requestAnimationFrame(tick);
    }
    tick();
  } catch (e) {
    console.warn('[Dictation] AudioContext VU failed:', e.message);
  }
}

function stopVU() {
  if (vuAnimFrame) { cancelAnimationFrame(vuAnimFrame); vuAnimFrame = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; analyser = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  floatingMic.style.boxShadow = '';
  floatingMic.style.transform = '';
  floatingMic.style.filter = '';
}

async function startDictation() {
  if (dictationActive) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.error('[Dictation] Web Speech API not available');
    return;
  }

  // Request mic access — find the USB Audio CODEC or use default
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    console.log('[Dictation] Available mics:', mics.map(m => m.label + ' (' + m.deviceId.slice(0, 8) + ')'));

    // Prefer USB Audio CODEC, fall back to default
    const usbMic = mics.find(m => /usb.*codec/i.test(m.label));
    const constraints = usbMic
      ? { audio: { deviceId: { exact: usbMic.deviceId } } }
      : { audio: true };
    console.log('[Dictation] Using mic:', usbMic ? usbMic.label : 'system default');

    micStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    console.error('[Dictation] Microphone access denied:', e.message);
    return;
  }

  dictationActive = true;
  floatingMic.classList.add('listening');
  interimText = '';
  finalText = '';

  const input = getActiveInput();
  if (input) input.focus();
  const baseText = input ? input.value : '';

  // Start audio visualizer
  startVU(micStream);

  speechRecognition = new SpeechRecognition();
  speechRecognition.lang = 'de-DE';
  speechRecognition.interimResults = true;
  speechRecognition.continuous = true;
  speechRecognition.maxAlternatives = 1;

  speechRecognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }
    if (final) finalText += final;
    interimText = interim;

    const target = getActiveInput();
    if (target) {
      const separator = baseText && !baseText.endsWith(' ') ? ' ' : '';
      const dictated = finalText + interimText;
      target.value = baseText + (dictated ? separator + dictated : '');
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  speechRecognition.onerror = (event) => {
    if (event.error === 'aborted') return;
    console.error('[Dictation] Speech error:', event.error);
    // 'not-allowed' means permission issue — show on button
    if (event.error === 'not-allowed') {
      floatingMic.title = 'Microphone blocked — check permissions';
    }
  };

  speechRecognition.onend = () => {
    if (dictationActive && speechRecognition) {
      try { speechRecognition.start(); } catch (_) {}
    }
  };

  console.log('[Dictation] Starting Web Speech API + VU meter');
  try {
    speechRecognition.start();
  } catch (e) {
    console.error('[Dictation] Start failed:', e.message);
    dictationActive = false;
    floatingMic.classList.remove('listening');
    stopVU();
  }
}

function stopDictation() {
  if (!dictationActive) return;
  dictationActive = false;
  floatingMic.classList.remove('listening');

  console.log('[Dictation] Stopping');
  stopVU();

  if (speechRecognition) {
    speechRecognition.onend = null;
    try { speechRecognition.stop(); } catch (_) {}
    speechRecognition = null;
  }

  const input = getActiveInput();
  if (input) input.focus();
}

// Mouse: hold button to dictate
floatingMic.addEventListener('mousedown', (e) => {
  e.preventDefault();
  startDictation();
});

floatingMic.addEventListener('mouseup', () => {
  stopDictation();
});

floatingMic.addEventListener('mouseleave', () => {
  if (dictationActive) stopDictation();
});

// Keyboard: Shift+A to dictate (keydown = start, keyup = stop)
let shiftADown = false;
document.addEventListener('keydown', (e) => {
  if (e.key === 'A' && e.shiftKey && !e.repeat) {
    const tag = e.target.tagName;
    const isInputBar = e.target.id === 'input-bar';
    if (isInputBar || (tag !== 'INPUT' && tag !== 'TEXTAREA' && !e.target.isContentEditable)) {
      e.preventDefault();
      shiftADown = true;
      startDictation();
    }
  }
});

document.addEventListener('keyup', (e) => {
  if ((e.key === 'A' || e.key === 'a') && shiftADown) {
    shiftADown = false;
    stopDictation();
  }
});

// --- Close Guard + Crash Recovery ---

// When main process asks to close, confirm
if (window.pangea.onCloseRequested) {
  window.pangea.onCloseRequested(() => {
    // Confirmed — tell main to close
    window.pangea.confirmClose();
  });
}

// Crash recovery — minimal: Recover / New
if (window.pangea.onCrashRecovery) {
  window.pangea.onCrashRecovery((state) => {
    const lastSessionId = localStorage.getItem('pangea-last-session-id') || '';
    if (!lastSessionId && !state) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;font-family:var(--font-family,system-ui);';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-secondary,#111118);border:1px solid var(--border,#2a2a35);border-radius:12px;padding:24px 32px;text-align:center;min-width:280px;';
    box.innerHTML = '<div style="font-size:15px;font-weight:700;color:var(--fg,#cdd6f4);margin-bottom:16px;">Previous session found</div><div style="display:flex;gap:12px;justify-content:center;"></div>';
    const btnRow = box.querySelector('div:last-child');

    const recoverBtn = document.createElement('button');
    recoverBtn.textContent = 'Recover';
    recoverBtn.style.cssText = 'padding:10px 28px;font-size:14px;font-weight:600;background:var(--accent,#a6e3a1);color:#1e1e2e;border:none;border-radius:8px;cursor:pointer;';
    recoverBtn.addEventListener('click', () => {
      overlay.remove();
      if (lastSessionId) inputBar.value = 'claude --resume ' + lastSessionId;
    });

    const newBtn = document.createElement('button');
    newBtn.textContent = 'New';
    newBtn.style.cssText = 'padding:10px 28px;font-size:14px;font-weight:600;background:none;color:var(--fg-dim,#6c7086);border:1px solid var(--border,#2a2a35);border-radius:8px;cursor:pointer;';
    newBtn.addEventListener('click', () => overlay.remove());

    btnRow.appendChild(recoverBtn);
    btnRow.appendChild(newBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

// Save session ID whenever Claude starts
const terminalEl = document.getElementById('terminal');
if (terminalEl) {
  const observer = new MutationObserver(() => {
    // Look for session ID in terminal output
    const text = terminalEl.textContent || '';
    const match = text.match(/session[:\s]+([a-f0-9-]{36})/i);
    if (match) {
      localStorage.setItem('pangea-last-session-id', match[1]);
    }
  });
  observer.observe(terminalEl, { childList: true, subtree: true });
}

// --- Global Drag & Drop from external file manager ---
// Detects which editor zone the user is hovering and routes the drop accordingly

const titlebarEl = document.getElementById('titlebar');

// Prevent default browser behavior for all drag events on the document
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

// Titlebar = cancel zone with stop sign cursor
titlebarEl.addEventListener('dragenter', (e) => {
  e.preventDefault();
  titlebarEl.classList.add('drag-cancel-zone');
});

titlebarEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'none';
  titlebarEl.classList.add('drag-cancel-zone');
});

titlebarEl.addEventListener('dragleave', () => {
  titlebarEl.classList.remove('drag-cancel-zone');
});

titlebarEl.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  titlebarEl.classList.remove('drag-cancel-zone');
  // Drop on titlebar = cancel, do nothing
});

// Helper: get file paths from a drag event
function getDroppedFiles(e) {
  const files = [];
  if (e.dataTransfer && e.dataTransfer.files) {
    for (const f of e.dataTransfer.files) {
      files.push({ path: f.path, name: f.name, type: f.type, size: f.size });
    }
  }
  return files;
}

// Helper: check if file is image or video
function classifyFile(file) {
  const ext = (file.name || '').split('.').pop().toLowerCase();
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'];
  if (imageExts.includes(ext) || (file.type && file.type.startsWith('image/'))) return 'image';
  if (videoExts.includes(ext) || (file.type && file.type.startsWith('video/'))) return 'video';
  return 'other';
}

// Expose helpers globally for sub-editors
window._getDroppedFiles = getDroppedFiles;
window._classifyFile = classifyFile;

// --- Global Tooltip Upgrader ---
// Converts all native `title` attributes to `data-tooltip` for styled CSS tooltips.
// Runs on a MutationObserver so dynamically created elements also get upgraded.
function upgradeTooltips(root) {
  const elements = root.querySelectorAll('[title]:not([data-tooltip])');
  for (const el of elements) {
    const title = el.getAttribute('title');
    if (title && title.length > 0) {
      el.dataset.tooltip = title;
      el.removeAttribute('title');
    }
  }
}

// Initial upgrade
upgradeTooltips(document.body);

// Watch for new elements with title attributes
const tooltipObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 1) upgradeTooltips(node);
    }
  }
});
tooltipObserver.observe(document.body, { childList: true, subtree: true });

// --- Settings Panel (includes Skills) ---
const settingsPanel = new SettingsPanel();
(async () => {
  await settingsPanel.init();
  // Bind skills panel into settings
  settingsPanel.bindSkillsPanel(skillsPanel);
})();

const settingsBtn = document.getElementById('settings-btn');
if (settingsBtn) settingsBtn.addEventListener('click', () => settingsPanel.toggle());

// --- OpenCode Chat Integration (Orchestrator) ---
const modelManager = new ModelManager();
const digestEngine = new DigestEngine();

// Initialize: ModelManager -> Orchestrator -> Wire everything
(async () => {
  await modelManager.init();

  // Auth-Status: Login-Screen oder Chat anzeigen
  openCodeChat.setAuthenticated(modelManager.isAuthenticated());

  // Login-Handler: OpenCode Auth oeffnen + Token speichern
  openCodeChat.onLogin(() => {
    modelManager.login();
  });

  const orchestrator = new Orchestrator(modelManager, openCodeChat);

  // === Pearl Controller (Outer Layer) ===
  const { PearlController } = require('./opencode-chat/pearl-controller');
  const pearl = new PearlController(orchestrator, modelManager, openCodeChat);
  orchestrator.setPearl(pearl);

  // Wire Pearl skill toggles to main process
  pearl.setSkillToggleFn((name, enabled) => {
    if (window.pangea.toggleSkill) window.pangea.toggleSkill(name, enabled);
  });

  // Pearl status messages → chat status bar
  pearl.onStatusMessage((msg) => {
    const el = document.getElementById('pearl-skills-badge');
    if (el) el.textContent = msg;
  });

  // Wire orchestrator callbacks to chat UI
  orchestrator.onModelSwitch((model) => {
    if (model) {
      openCodeChat.setActiveModel({
        name: model.name || model.id || 'Unbekannt',
        id: model.id,
        score: model._benchScore || 0,
        tier: 'A',
      });
    }
  });
  orchestrator.onStatusUpdate((msg) => {
    openCodeChat.setStatus(msg);
    // Update status bar indicator
    const statusBar = document.getElementById('model-status-bar');
    if (statusBar) statusBar.textContent = msg;
  });

  // Wire chat UI callbacks to model manager + orchestrator
  openCodeChat.onClaudeToggle((enabled) => { modelManager.setClaudeEnabled(enabled); updateDropdown(); });
  openCodeChat.onSourceToggle((source) => modelManager.setPremiumSource(source));
  openCodeChat.onPremiumMixChange((value) => orchestrator.setPremiumMix(value));
  openCodeChat.onRefresh(() => orchestrator.refresh());
  openCodeChat.onGeminiToggle(async (enabled) => {
    await modelManager.setGeminiEnabled(enabled);
    updateDropdown();
  });

  // Check Gemini OAuth on startup (auto-enable if previously logged in)
  openCodeChat.checkGeminiAuth().then((authed) => {
    if (authed) updateDropdown();
  });

  // Auto-enable Claude toggle if API key was found
  if (modelManager.isClaudeEnabled()) {
    openCodeChat.setClaudeToggleState(true);
    updateDropdown();
  }

  // Model dropdown — force select or auto reset
  openCodeChat.onModelSelect((modelId) => {
    orchestrator.setForcedModel(modelId);
  });
  openCodeChat.onAutoReset(() => {
    orchestrator.clearForcedModel();
  });

  // Populate model dropdown when models change
  const updateDropdown = () => {
    const ranked = modelManager.getRankedModels();
    const premium = [];
    if (modelManager.isClaudeEnabled()) {
      premium.push({ id: 'claude-opus-4-6', name: 'Claude Opus 4.6', _benchScore: 98 });
      premium.push({ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', _benchScore: 92 });
      premium.push({ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', _benchScore: 75 });
    }
    console.log('[Pearl] updateDropdown: ' + ranked.length + ' free models, ' + premium.length + ' premium');
    openCodeChat.updateModelList(ranked, premium);
  };
  modelManager.onModelChange((info) => {
    openCodeChat.setActiveModel(info);
    updateDropdown();
  });
  // Initial populate after init
  updateDropdown();

  // Wire digest engine to Auto tab — summaries from free models appear there
  digestEngine.onNewItem((item) => {
    // Push digest item into sidebar auto stream via main process
    if (window.pangea?.pushAutoItem) {
      window.pangea.pushAutoItem(item);
    }
  });

  // Wire chat digest updates to the digest engine
  openCodeChat.onDigest(async ({ type, content }) => {
    if (type === 'assistant') {
      await digestEngine.processMessage(content);
    }
  });

  // Chat als Standard-Startfenster oeffnen
  openCodeChat.open();
  activeEditorTab = 'chat';
  window._activeEditorTab = 'chat';

  // Set initial model display + populate dropdown
  if (modelManager.isAuthenticated()) {
    const name = modelManager.getActiveModelName();
    openCodeChat.setActiveModel(name ? {
      name, id: modelManager.getActiveModelId(),
      score: modelManager.getActiveModel()?._benchScore || 0, tier: 'A',
    } : 'Not connected');
    updateDropdown();
    // Re-populate after short delay in case models trickled in late
    setTimeout(updateDropdown, 2000);
    setTimeout(updateDropdown, 5000);
  } else {
    openCodeChat.setActiveModel('Not connected');
  }

  // Digest engine — now feeds into Auto tab instead of dedicated digest tab
  // Set up LLM summarizer using the active free model for Auto tab processing
  digestEngine.setLLMSummarizer(async (text) => {
    if (!modelManager.getActiveModel() || !modelManager.getAuthToken()) return null;

    return new Promise((resolve) => {
      let summary = '';
      const timeout = setTimeout(() => resolve(summary || null), 10000);

      const handler = (data) => {
        if (data.type === 'chunk') summary += data.text;
        if (data.type === 'done') {
          clearTimeout(timeout);
          resolve(summary.trim().slice(0, 200));
        }
        if (data.type === 'error') {
          clearTimeout(timeout);
          resolve(null);
        }
      };

      window.pangea.onOpencodeStream(handler);

      window.pangea.opencodeChat(
        modelManager.getActiveModel().id,
        [{ role: 'user', content: `Du bist ein Assistent der AI-Antworten für den User zusammenfasst. Fasse den folgenden Text in 1-2 kurzen Sätzen zusammen. NUR das Ergebnis/die Antwort, KEINE technischen Details, KEINE Dateinamen, KEINE Tool-Aufrufe. Was ist das Resultat für den User?\n\n${text.slice(0, 1500)}` }],
        modelManager.getAuthToken()
      );
    });
  });

  // Update status bar with initial state
  const statusBar = document.getElementById('model-status-bar');
  if (statusBar) {
    statusBar.textContent = modelManager.isAuthenticated()
      ? (modelManager.getActiveModelName() || 'Bereit')
      : 'Nicht verbunden';
  }
})();

// --- Model Status Bar (bottom-right indicator) ---
const modelStatusBar = document.createElement('div');
modelStatusBar.id = 'model-status-bar';
modelStatusBar.style.cssText = 'position:fixed;bottom:6px;right:8px;z-index:9999;' +
  'font-size:10px;font-family:inherit;color:#666;background:rgba(255,250,230,0.9);' +
  'padding:2px 8px;border-radius:4px;pointer-events:none;white-space:nowrap;';
modelStatusBar.textContent = 'Initialisiere...';
document.body.appendChild(modelStatusBar);

// Auto-focus input bar on start
inputBar.focus();
