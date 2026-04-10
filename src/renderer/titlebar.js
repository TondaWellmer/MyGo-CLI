// --- Color Wheel ---
const colorDot = document.getElementById('color-dot');
const colorPicker = document.getElementById('color-picker');

colorDot.addEventListener('click', () => colorPicker.click());

colorPicker.addEventListener('input', (e) => {
  applyColor(e.target.value);
});

colorPicker.addEventListener('change', (e) => {
  applyColor(e.target.value);
  window.pangea.setColor(e.target.value);
});

function applyColor(color) {
  document.documentElement.style.setProperty('--bg-base', color);
  document.body.style.background = color;

  // Update xterm background if terminal exists
  if (window._xtermInstance) {
    window._xtermInstance.options.theme = {
      ...window._xtermInstance.options.theme,
      background: color
    };
  }

  // Update active tab color in strip + notify main process
  if (window._updateActiveTabColor) {
    window._updateActiveTabColor(color);
  }
}

// --- Text Color Wheel ---
const textColorDot = document.getElementById('text-color-dot');
const textColorPicker = document.getElementById('text-color-picker');

textColorDot.addEventListener('click', () => textColorPicker.click());

textColorPicker.addEventListener('input', (e) => {
  applyTextColor(e.target.value);
});

textColorPicker.addEventListener('change', (e) => {
  applyTextColor(e.target.value);
  window.pangea.setTextColor(e.target.value);
});

function applyTextColor(color) {
  if (window._xtermInstance) {
    window._xtermInstance.options.theme = {
      ...window._xtermInstance.options.theme,
      foreground: color
    };
    // Force xterm to redraw with new foreground
    window._xtermInstance.refresh(0, window._xtermInstance.rows - 1);
  }

  // Also update CSS custom properties for UI text (--text, --text-dim, --text-muted)
  // Parse hex to derive dimmed/muted variants
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  // --text = full color
  document.documentElement.style.setProperty('--text', color);

  // --text-dim = blend toward mid-gray (50% opacity effect)
  const dimR = Math.round(r + (128 - r) * 0.35);
  const dimG = Math.round(g + (128 - g) * 0.35);
  const dimB = Math.round(b + (128 - b) * 0.35);
  document.documentElement.style.setProperty('--text-dim',
    `#${dimR.toString(16).padStart(2, '0')}${dimG.toString(16).padStart(2, '0')}${dimB.toString(16).padStart(2, '0')}`);

  // --text-muted = blend more toward mid-gray (60% opacity effect)
  const mutR = Math.round(r + (148 - r) * 0.5);
  const mutG = Math.round(g + (148 - g) * 0.5);
  const mutB = Math.round(b + (148 - b) * 0.5);
  document.documentElement.style.setProperty('--text-muted',
    `#${mutR.toString(16).padStart(2, '0')}${mutG.toString(16).padStart(2, '0')}${mutB.toString(16).padStart(2, '0')}`);
}

// --- Editable Instance Name ---
const nameSpan = document.getElementById('instance-name');
const nameInput = document.getElementById('instance-name-input');

nameSpan.addEventListener('dblclick', () => {
  nameInput.value = nameSpan.textContent;
  nameSpan.style.display = 'none';
  nameInput.style.display = 'inline-block';
  nameInput.focus();
  nameInput.select();
});

function finishNameEdit() {
  const newName = nameInput.value.trim();
  if (newName) {
    nameSpan.textContent = newName;
    window.pangea.setName(newName);
    // Update active tab name
    if (window._updateActiveTabName) {
      window._updateActiveTabName(newName);
    }
  }
  nameInput.style.display = 'none';
  nameSpan.style.display = 'inline';
}

nameInput.addEventListener('blur', finishNameEdit);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') finishNameEdit();
  if (e.key === 'Escape') {
    nameInput.style.display = 'none';
    nameSpan.style.display = 'inline';
  }
});

// --- CWD Dropdown ---
const cwdButton = document.getElementById('cwd-button');
const cwdLabel = document.getElementById('cwd-label');
const cwdArrow = document.getElementById('cwd-arrow');
const cwdDropdown = document.getElementById('cwd-dropdown');
let dropdownOpen = false;

function formatTimeAgo(mtimeMs) {
  const diff = Date.now() - mtimeMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'gerade';
  if (mins < 60) return `vor ${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours}h`;
  const days = Math.floor(hours / 24);
  return `vor ${days}d`;
}

async function loadCwdInfo() {
  const info = await window.pangea.getCwdInfo();
  cwdLabel.textContent = info.basename;

  if (info.hasSubprojects) {
    cwdArrow.classList.remove('hidden');
    cwdButton.dataset.hasDropdown = 'true';

    cwdDropdown.innerHTML = '';
    info.subprojects.forEach(proj => {
      const item = document.createElement('div');
      item.className = 'dropdown-item';

      const name = document.createElement('span');
      name.className = 'project-name';
      name.textContent = proj.name;

      const time = document.createElement('span');
      time.className = 'project-time';
      time.textContent = formatTimeAgo(proj.mtime);

      item.appendChild(name);
      item.appendChild(time);

      item.addEventListener('click', () => {
        window.pangea.changeCwd(proj.path);
        closeDropdown();
      });

      cwdDropdown.appendChild(item);
    });
  } else {
    cwdArrow.classList.add('hidden');
    cwdButton.dataset.hasDropdown = 'false';
  }
}

function toggleDropdown() {
  if (cwdButton.dataset.hasDropdown !== 'true') return;
  dropdownOpen = !dropdownOpen;
  cwdDropdown.classList.toggle('hidden', !dropdownOpen);
  cwdArrow.classList.toggle('open', dropdownOpen);
}

function closeDropdown() {
  dropdownOpen = false;
  cwdDropdown.classList.add('hidden');
  cwdArrow.classList.remove('open');
}

cwdButton.addEventListener('click', toggleDropdown);

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (dropdownOpen && !e.target.closest('#cwd-wrapper')) {
    closeDropdown();
  }
});

// --- Session ID Button ---
const sessionBtn = document.getElementById('session-btn');
let currentSessionId = null;

function showSessionBtn(id) {
  currentSessionId = id;
  sessionBtn.classList.remove('hidden');
  sessionBtn.title = `Session: ${id}\nKlick = kopieren`;
}

sessionBtn.addEventListener('click', () => {
  window.pangea.copySessionResume(currentSessionId);
  sessionBtn.classList.add('copied');
  const icon = sessionBtn.querySelector('.session-icon');
  const originalHTML = icon.innerHTML;
  icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  setTimeout(() => {
    sessionBtn.classList.remove('copied');
    icon.innerHTML = originalHTML;
  }, 1500);
});

window.pangea.onSessionIdUpdate((payload) => {
  // payload is now { id, tabId } — only update button if it's for the active tab
  const id = typeof payload === 'string' ? payload : payload?.id;
  const forTab = typeof payload === 'string' ? null : payload?.tabId;
  // Get current active tab from renderer
  const currentActiveTab = window._activeTabId || 'tab-0';
  if (!forTab || forTab === currentActiveTab) {
    showSessionBtn(id);
  }
});

// Expose showSessionBtn globally so terminal.js can update it on tab switch
window._showSessionBtn = showSessionBtn;
window._hideSessionBtn = () => {
  currentSessionId = null;
  sessionBtn.classList.add('hidden');
};

// Check if session already exists for the active tab
window.pangea.getSessionId().then(id => {
  if (id) showSessionBtn(id);
});

// --- Reusable Confirmation Dialog (styled like tab-close dialog) ---
function showConfirmDialog(message, confirmLabel = 'Laden', cancelLabel = 'Abbrechen') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'tab-close-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'tab-close-dialog';

    const msg = document.createElement('div');
    msg.className = 'tab-close-msg';
    msg.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'tab-close-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'tab-close-btn tab-close-btn-keep';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'tab-close-btn tab-close-btn-close';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener('click', () => { overlay.remove(); resolve(true); });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(msg);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // ESC to cancel
    const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); resolve(false); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  });
}

// --- Session History Dropdown ---
const sessionHistoryBtn = document.getElementById('session-history-btn');
const sessionDropdown = document.getElementById('session-dropdown');
const sessionList = document.getElementById('session-list');
let sessionDropdownOpen = false;

function formatDate(isoStr) {
  const d = new Date(isoStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'gerade';
  if (diffMins < 60) return `vor ${diffMins}min`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `vor ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `vor ${diffDays}d`;

  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

async function loadSessionHistory() {
  const sessions = await window.pangea.getSessionHistory();
  sessionList.innerHTML = '';

  if (!sessions || sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Noch keine Sessions';
    sessionList.appendChild(empty);
    return;
  }

  sessions.forEach(session => {
    const item = document.createElement('div');
    item.className = 'session-item';
    if (session.id === currentSessionId) item.classList.add('active');

    const info = document.createElement('div');
    info.className = 'session-info';

    const name = document.createElement('div');
    name.className = 'session-name';
    name.textContent = session.name || 'Unbenannt';

    const meta = document.createElement('div');
    meta.className = 'session-meta';

    const time = document.createElement('span');
    time.textContent = formatDate(session.timestamp);

    const idShort = document.createElement('span');
    idShort.className = 'session-id-short';
    idShort.textContent = session.id.substring(0, 12) + '...';

    meta.appendChild(time);
    meta.appendChild(idShort);
    info.appendChild(name);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'session-action-btn';
    copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.title = 'Resume-Befehl kopieren';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.pangea.copySessionResume(session.id);
      copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => { copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }, 1000);
    });

    // Load button
    const loadBtn = document.createElement('button');
    loadBtn.className = 'session-action-btn';
    loadBtn.textContent = '▶';
    loadBtn.title = 'Session laden';
    loadBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await showConfirmDialog(
        'Session in den aktuellen Tab laden? Die laufende Session wird ersetzt.'
      );
      if (!ok) return;
      window.pangea.loadSession(session.id);
      closeSessionDropdown();
    });

    actions.appendChild(copyBtn);
    actions.appendChild(loadBtn);

    item.appendChild(info);
    item.appendChild(actions);

    // Click on row = copy
    item.addEventListener('click', () => {
      window.pangea.copySessionResume(session.id);
    });

    sessionList.appendChild(item);
  });
}

function toggleSessionDropdown() {
  sessionDropdownOpen = !sessionDropdownOpen;
  sessionDropdown.classList.toggle('hidden', !sessionDropdownOpen);
  if (sessionDropdownOpen) loadSessionHistory();
}

function closeSessionDropdown() {
  sessionDropdownOpen = false;
  sessionDropdown.classList.add('hidden');
}

sessionHistoryBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSessionDropdown();
});

// Close on outside click
document.addEventListener('click', (e) => {
  if (sessionDropdownOpen && !e.target.closest('#session-wrapper')) {
    closeSessionDropdown();
  }
});

// --- Session History "+" Button ---
const sessionHistoryAddBtn = document.getElementById('session-history-add');
if (sessionHistoryAddBtn) {
  sessionHistoryAddBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const result = await window.pangea.addCurrentSessionToHistory();
    if (result?.ok) {
      sessionHistoryAddBtn.textContent = '\u2713';
      setTimeout(() => {
        sessionHistoryAddBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
      }, 1000);
      loadSessionHistory();
    } else {
      sessionHistoryAddBtn.title = 'Kein aktiver Session-Tab';
    }
  });
}

// --- Session Dropdown Sub-Tabs ---
const sessionTabBtns = document.querySelectorAll('.session-tab');
const sessionTabPanels = document.querySelectorAll('.session-tab-panel');

sessionTabBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = btn.dataset.sessionTab;
    sessionTabBtns.forEach(b => b.classList.toggle('active', b.dataset.sessionTab === target));
    sessionTabPanels.forEach(p => p.classList.toggle('active', p.id === `session-tab-${target}`));
    if (target === 'worksessions') loadWorkSessions();
  });
});

// --- Work Sessions ---
const worksessionList = document.getElementById('worksession-list');
const worksessionAddBtn = document.getElementById('worksession-add');
const worksessionRecoverBtn = document.getElementById('worksession-recover');

async function loadWorkSessions() {
  const sessions = await window.pangea.getWorkSessions();
  worksessionList.innerHTML = '';

  if (!sessions || sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Keine Work Sessions';
    worksessionList.appendChild(empty);
    return;
  }

  sessions.forEach(ws => {
    const item = document.createElement('div');
    item.className = 'worksession-item';

    const info = document.createElement('div');
    info.className = 'ws-info';

    const name = document.createElement('div');
    name.className = 'ws-name';
    name.textContent = ws.name || 'Work Session';

    // Double-click to rename
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ws-name-input';
      input.value = name.textContent;
      name.replaceWith(input);
      input.focus();
      input.select();

      const finishRename = async () => {
        const newName = input.value.trim();
        if (newName && newName !== ws.name) {
          await window.pangea.renameWorkSession(ws.id, newName);
          ws.name = newName;
        }
        const restored = document.createElement('div');
        restored.className = 'ws-name';
        restored.textContent = ws.name;
        restored.addEventListener('dblclick', name._dblclickHandler);
        input.replaceWith(restored);
      };

      input.addEventListener('blur', finishRename);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
        if (ke.key === 'Escape') { input.value = ws.name; input.blur(); }
      });
    });

    const meta = document.createElement('div');
    meta.className = 'ws-meta';

    const time = document.createElement('span');
    time.textContent = formatDate(ws.timestamp);

    const tabCount = document.createElement('span');
    tabCount.textContent = `${ws.tabs?.length || 0} Tabs`;

    meta.appendChild(time);
    meta.appendChild(tabCount);
    info.appendChild(name);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'ws-actions';

    // Load button
    const loadBtn = document.createElement('button');
    loadBtn.className = 'ws-action-btn';
    loadBtn.textContent = '▶';
    loadBtn.title = 'Work Session laden';
    loadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmAndLoadWorkSession(ws);
    });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'ws-action-btn danger';
    delBtn.textContent = '×';
    delBtn.title = 'Löschen';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.pangea.deleteWorkSession(ws.id);
      loadWorkSessions();
    });

    actions.appendChild(loadBtn);
    actions.appendChild(delBtn);

    item.appendChild(info);
    item.appendChild(actions);

    // Click on row = load
    item.addEventListener('click', () => confirmAndLoadWorkSession(ws));

    worksessionList.appendChild(item);
  });
}

async function confirmAndLoadWorkSession(ws) {
  const confirmed = await showConfirmDialog(
    `Work Session "${ws.name}" laden? Alle aktuellen Tabs werden ersetzt.`
  );
  if (!confirmed) return;

  closeSessionDropdown();
  await window.pangea.loadWorkSession(ws.id);
}

// Save current tabs as Work Session
worksessionAddBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  await window.pangea.saveWorkSession();
  loadWorkSessions();
});

// Recover last Work Session
worksessionRecoverBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const ws = await window.pangea.recoverWorkSession();
  if (!ws) {
    alert('Keine Work Session zum Wiederherstellen gefunden.');
    return;
  }
  const confirmed = await showConfirmDialog(
    `Letzte Work Session "${ws.name}" wiederherstellen? Alle aktuellen Tabs werden ersetzt.`
  );
  if (!confirmed) return;

  closeSessionDropdown();
  await window.pangea.loadWorkSession(ws.id);
});

// Handle Work Session restore event from main process
window.pangea.onWorkSessionRestore((data) => {
  if (!data || !data.tabs) return;

  // Remove all tab buttons except the ones we're restoring
  const strip = document.getElementById('term-tabs');
  const existingBtns = strip.querySelectorAll('.term-tab');
  existingBtns.forEach(btn => {
    const tabId = btn.dataset.tabId;
    // Check if this tab is in the restore set
    const inRestore = data.tabs.some(t => t.tabId === tabId);
    if (!inRestore && tabId !== 'tab-0') {
      btn.remove();
    }
  });

  // Close all renderer-side tabs that aren't in restore set
  if (window._termTabs) {
    for (const [tabId, tabData] of window._termTabs.entries()) {
      if (tabId !== 'tab-0' && !data.tabs.some(t => t.tabId === tabId)) {
        tabData.term.dispose();
        tabData.termEl.remove();
        window._termTabs.delete(tabId);
      }
    }
  }

  // Create/update tabs from restore data
  data.tabs.forEach((tab, i) => {
    if (tab.tabId === 'tab-0') {
      // Update existing tab-0
      if (window._termTabs && window._termTabs.has('tab-0')) {
        const t0 = window._termTabs.get('tab-0');
        t0.color = tab.color;
        t0.name = tab.name;
        const btn0 = strip.querySelector('[data-tab-id="tab-0"] .term-tab-color');
        if (btn0) btn0.style.background = tab.color;
      }
    } else {
      // Create new tab in renderer
      if (window._createTermTab) {
        window._createTermTab(tab.tabId, tab.color, tab.name);
      }
    }

    // Auto-resume Claude session for each tab
    if (tab.sessionId) {
      setTimeout(() => {
        window.pangea.sendTerminalInput({
          tabId: tab.tabId,
          data: `claude --resume ${tab.sessionId}\r`
        });
      }, 1000 + i * 500);
    }
  });

  // Restore textColor if saved
  if (data.textColor) {
    textColorPicker.value = data.textColor;
    applyTextColor(data.textColor);
    window.pangea.setTextColor(data.textColor);
  }

  // Switch to first tab
  if (data.tabs.length > 0 && window._switchTab) {
    window._switchTab(data.tabs[0].tabId);
  }
});

// --- Init: Load config ---
window.pangea.getInstanceConfig().then(config => {
  if (config.name) nameSpan.textContent = config.name;
  if (config.color && config.color !== '#efefeb') {
    colorPicker.value = config.color;
    applyColor(config.color);
  }
  if (config.textColor && config.textColor !== '#1a1a24') {
    textColorPicker.value = config.textColor;
    applyTextColor(config.textColor);
  }
});

loadCwdInfo();
