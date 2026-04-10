// Prevent xterm.js from stealing scroll events over the sidebar
const sidebarContent = document.getElementById('sidebar-content');
if (sidebarContent) {
  sidebarContent.addEventListener('wheel', (e) => {
    e.stopPropagation();
  }, { passive: true });
}

// Tab switching
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.tab-panel');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// Icons
function getIcon(item) {
  if (item.icon === 'file' || item.path) return '📄';
  if (item.icon === 'link' || item.url) return '🔗';
  if (item.icon === 'action') return '⚡';
  return '📎';
}

// --- Context Menu ---
let activeMenu = null;

function closeContextMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

document.addEventListener('click', closeContextMenu);

function showContextMenu(e, item) {
  e.preventDefault();
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const actions = [];

  if (item.url) {
    actions.push({ label: 'Open in browser', action: () => window.pangea.openUrl(item.url) });
    actions.push({ label: 'Copy URL', action: () => navigator.clipboard.writeText(item.url) });
  }

  if (item.path) {
    actions.push({ label: 'Open file', action: () => window.pangea.openFile(item.path) });
    actions.push({ label: 'Open folder in Explorer', action: () => window.pangea.openFolder(item.path) });
    actions.push({ label: 'Copy path', action: () => navigator.clipboard.writeText(item.path) });
  }

  actions.push({ label: '📌 Pin', action: () => window.pangea.pinItem(item) });

  actions.forEach(({ label, action }) => {
    const menuItem = document.createElement('div');
    menuItem.className = 'context-menu-item';
    menuItem.textContent = label;
    menuItem.addEventListener('click', (ev) => {
      ev.stopPropagation();
      action();
      closeContextMenu();
    });
    menu.appendChild(menuItem);
  });

  document.body.appendChild(menu);
  activeMenu = menu;

  // Keep menu in viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
}

// Render a sidebar item
function createItem(item, isPinned) {
  const el = document.createElement('div');
  el.className = 'sidebar-item';
  el.title = item.url || item.path || '';

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = getIcon(item);

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = item.label || item.url || item.path || 'Unbekannt';

  el.appendChild(icon);
  el.appendChild(label);

  // Category badge
  if (item.category) {
    const badge = document.createElement('span');
    badge.className = 'category-badge';
    badge.textContent = item.category;
    el.appendChild(badge);
  }

  // Folder button (open parent folder)
  if (item.path) {
    const folderBtn = document.createElement('button');
    folderBtn.className = 'folder-btn';
    folderBtn.textContent = '📂';
    folderBtn.title = 'Open folder';
    folderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.pangea.openFolder(item.path);
    });
    el.appendChild(folderBtn);
  }

  // Action button (pin/unpin)
  const actionBtn = document.createElement('button');
  actionBtn.className = 'action-btn';
  actionBtn.textContent = isPinned ? '✕' : '📌';
  actionBtn.title = isPinned ? 'Unpin' : 'Pin';
  actionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isPinned) {
      window.pangea.unpinItem(item);
    } else {
      window.pangea.pinItem(item);
    }
  });
  el.appendChild(actionBtn);

  // Double-click to open
  el.addEventListener('dblclick', () => {
    if (item.url) {
      window.pangea.openUrl(item.url);
    } else if (item.path) {
      window.pangea.openFile(item.path);
    }
  });

  // Right-click for context menu
  el.addEventListener('contextmenu', (e) => showContextMenu(e, item));

  return el;
}

// Create a pinned text item (answer/milestone/message)
function createPinnedTextItem(item) {
  const el = document.createElement('div');
  el.className = 'pinned-text-item';

  if (item.type === 'answer') {
    el.classList.add('pinned-answer');
    const q = document.createElement('div');
    q.className = 'pinned-question';
    q.textContent = item.question;
    const a = document.createElement('div');
    a.className = 'pinned-answer-text';
    a.textContent = item.answer;
    el.appendChild(q);
    el.appendChild(a);
  } else if (item.type === 'milestone') {
    el.classList.add('pinned-milestone');
    const text = document.createElement('div');
    text.className = 'pinned-milestone-text';
    text.textContent = item.text;
    el.appendChild(text);
  } else if (item.type === 'message') {
    const text = document.createElement('div');
    text.className = 'pinned-message-text';
    text.textContent = item.text;
    el.appendChild(text);
  }

  // Unpin button
  const unpinBtn = document.createElement('button');
  unpinBtn.className = 'pinned-unpin-btn';
  unpinBtn.innerHTML = '&times;';
  unpinBtn.title = 'Unpin';
  unpinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.pangea.unpinItem(item);
  });
  el.appendChild(unpinBtn);

  // Copy on right-click
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    const copyOpt = document.createElement('div');
    copyOpt.className = 'context-menu-item';
    copyOpt.textContent = 'Text kopieren';
    copyOpt.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const text = item.type === 'answer' ? `${item.question}\n${item.answer}` : item.text;
      navigator.clipboard.writeText(text);
      closeContextMenu();
    });
    menu.appendChild(copyOpt);
    document.body.appendChild(menu);
    activeMenu = menu;
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
  });

  return el;
}

// Render items into a panel
function renderPanel(panelId, items, isPinned) {
  const panel = document.getElementById(panelId);
  panel.innerHTML = '';

  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = isPinned ? 'Keine gepinnten Items' : 'Warte auf Claude...';
    panel.appendChild(empty);
    return;
  }

  items.forEach(item => {
    // Text items (answer/milestone/message) get special rendering in pinned tab
    if (isPinned && (item.type === 'answer' || item.type === 'milestone' || item.type === 'message')) {
      panel.appendChild(createPinnedTextItem(item));
    } else {
      panel.appendChild(createItem(item, isPinned));
    }
  });
}

// --- Project Explorer ---
function getFileIcon(name) {
  if (name.includes('Was fehlt')) return '⚠️';
  if (name.endsWith('.html')) return '🌐';
  if (name.endsWith('.md') || name.endsWith('.txt')) return '📄';
  if (name.endsWith('.json')) return '⚙️';
  return '📄';
}

async function loadProjectExplorer() {
  const tree = await window.pangea.getProjectTree();
  const hiddenData = await window.pangea.getHiddenFiles();
  const hiddenSet = new Set(hiddenData.hidden || []);
  const panel = document.getElementById('tab-projects');
  panel.innerHTML = '';

  if (!tree || tree.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Keine Projekte gefunden';
    panel.appendChild(empty);
    return;
  }

  tree.forEach(group => {
    // Filter hidden files
    const visibleFiles = group.files.filter(f => !hiddenSet.has(f.path));
    const hasHidden = visibleFiles.length < group.files.length;

    // Skip group entirely if all files hidden (unless it had files before)
    if (visibleFiles.length === 0 && !hasHidden) return;

    const groupEl = document.createElement('div');
    groupEl.className = 'explorer-group';

    const header = document.createElement('div');
    header.className = 'explorer-header';

    const arrow = document.createElement('span');
    arrow.className = 'explorer-arrow' + (group.expanded ? ' open' : '');
    arrow.textContent = '▶';

    const name = document.createElement('span');
    name.textContent = group.name;

    const headerSpacer = document.createElement('span');
    headerSpacer.style.flex = '1';

    // Refresh button (unhide all for this group)
    if (hasHidden) {
      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'refresh-btn';
      refreshBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
      refreshBtn.title = 'Ausgeblendete wieder anzeigen';
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.pangea.unhideAll(group.folder);
        loadProjectExplorer();
      });
      header.appendChild(arrow);
      header.appendChild(name);
      header.appendChild(headerSpacer);
      header.appendChild(refreshBtn);
    } else {
      header.appendChild(arrow);
      header.appendChild(name);
      header.appendChild(headerSpacer);
    }

    // Folder button on project header
    const headerFolderBtn = document.createElement('button');
    headerFolderBtn.className = 'folder-btn';
    headerFolderBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
    headerFolderBtn.title = 'Open project folder';
    headerFolderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (group.files.length > 0) {
        window.pangea.openFolder(group.files[0].path);
      }
    });
    header.appendChild(headerFolderBtn);

    const filesContainer = document.createElement('div');
    filesContainer.className = 'explorer-files' + (group.expanded ? ' open' : '');

    visibleFiles.forEach(file => {
      const fileEl = document.createElement('div');
      fileEl.className = 'explorer-file';
      fileEl.title = file.path;

      const isLink = file.type === 'link' || file.url;

      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = isLink ? '🔗' : getFileIcon(file.name);

      const fname = document.createElement('span');
      fname.className = 'file-name';
      fname.textContent = file.name;

      // Copy button for text shots
      const isShot = group.folder === '_textshots';
      if (isShot) {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyBtn.title = 'In Zwischenablage kopieren';
        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const content = await window.pangea.readTextShot(file.path);
          navigator.clipboard.writeText(content);
          copyBtn.innerHTML = '✓';
          setTimeout(() => {
            copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
          }, 1000);
        });
        fileEl.appendChild(copyBtn);
      }

      // Folder button
      const fileFolderBtn = document.createElement('button');
      fileFolderBtn.className = 'folder-btn';
      fileFolderBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
      fileFolderBtn.title = 'Open folder';
      fileFolderBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.pangea.openFolder(file.path);
      });

      // Hide button
      const hideBtn = document.createElement('button');
      hideBtn.className = 'hide-btn';
      hideBtn.innerHTML = '&times;';
      hideBtn.title = 'Ausblenden';
      hideBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.pangea.hideFile(file.path);
        loadProjectExplorer();
      });

      fileEl.appendChild(icon);
      fileEl.appendChild(fname);
      fileEl.appendChild(fileFolderBtn);
      fileEl.appendChild(hideBtn);

      // Double-click to open
      fileEl.addEventListener('dblclick', () => {
        if (isLink && file.url) {
          window.pangea.openUrl(file.url);
        } else {
          window.pangea.openFile(file.path);
        }
      });

      // Right-click context menu
      fileEl.addEventListener('contextmenu', (e) => {
        showContextMenu(e, { path: file.path, label: file.name });
      });

      filesContainer.appendChild(fileEl);
    });

    // Show empty state if all files hidden
    if (visibleFiles.length === 0 && hasHidden) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty-state';
      emptyEl.style.padding = '12px 10px';
      emptyEl.style.fontSize = '11px';
      emptyEl.textContent = 'Alle Dateien ausgeblendet';
      filesContainer.appendChild(emptyEl);
    }

    // Start expanded groups with class
    if (group.expanded) groupEl.classList.add('expanded');

    header.addEventListener('click', () => {
      arrow.classList.toggle('open');
      filesContainer.classList.toggle('open');
      groupEl.classList.toggle('expanded');
    });

    groupEl.appendChild(header);
    groupEl.appendChild(filesContainer);
    panel.appendChild(groupEl);
  });
}

loadProjectExplorer();

// Expose refresh for text shots (called from terminal.js after saving)
window._refreshTextShots = loadProjectExplorer;

// Load pinned items on start
window.pangea.getPinned().then(pinned => {
  renderPanel('tab-pinned', pinned, true);
});

// --- Auto-Tab: Chat-style Stream ---
function renderAutoStream(items) {
  const panel = document.getElementById('tab-auto');
  panel.innerHTML = '';

  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Warte auf Claude...';
    panel.appendChild(empty);
    return;
  }

  const stream = document.createElement('div');
  stream.className = 'auto-stream';

  // Chronological order (oldest first, newest at bottom)
  const sorted = [...items].reverse();

  sorted.forEach(item => {
    const entry = document.createElement('div');
    entry.className = 'stream-entry';

    // Timestamp
    const time = document.createElement('span');
    time.className = 'stream-time';
    if (item.timestamp) {
      const d = new Date(item.timestamp);
      time.textContent = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }

    if (item.type === 'answer') {
      entry.classList.add('stream-answer');
      const q = document.createElement('div');
      q.className = 'stream-question';
      q.textContent = item.question;
      const a = document.createElement('div');
      a.className = 'stream-answer-text';
      a.textContent = item.answer;
      entry.appendChild(time);
      entry.appendChild(q);
      entry.appendChild(a);
    } else if (item.type === 'milestone') {
      entry.classList.add('stream-milestone');
      const text = document.createElement('div');
      text.className = 'stream-milestone-text';
      text.textContent = item.text;
      entry.appendChild(time);
      entry.appendChild(text);
    } else if (item.type === 'message') {
      const text = document.createElement('div');
      text.className = 'stream-text';
      text.textContent = item.text || item.label || '';
      entry.appendChild(time);
      entry.appendChild(text);
    } else {
      // Legacy items (file/url from hook) — show as compact inline links
      if (item.url || item.path) {
        entry.classList.add('stream-link');
        const link = document.createElement('span');
        link.className = 'stream-file-link';
        link.textContent = item.label || item.url || item.path;
        link.addEventListener('click', () => {
          if (item.url) window.pangea.openUrl(item.url);
          else if (item.path) window.pangea.openFile(item.path);
        });
        entry.appendChild(time);
        entry.appendChild(link);
      } else {
        return; // skip unknown items
      }
    }

    // Inline file links within any entry
    if (item.files && item.files.length) {
      const links = document.createElement('div');
      links.className = 'stream-files';
      item.files.forEach(f => {
        const link = document.createElement('span');
        link.className = 'stream-file-link';
        link.textContent = f.label || f.path;
        link.title = f.path;
        link.addEventListener('click', () => {
          if (f.url) window.pangea.openUrl(f.url);
          else window.pangea.openFile(f.path);
        });
        links.appendChild(link);
      });
      entry.appendChild(links);
    }

    // Pin button on every stream entry
    const pinBtn = document.createElement('button');
    pinBtn.className = 'stream-pin-btn';
    pinBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 11h14l-1.5 6h-11z"/></svg>';
    pinBtn.title = 'Pinnen';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.pangea.pinItem(item);
      pinBtn.innerHTML = '✓';
      setTimeout(() => {
        pinBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 11h14l-1.5 6h-11z"/></svg>';
      }, 1500);
    });
    entry.appendChild(pinBtn);

    stream.appendChild(entry);
  });

  panel.appendChild(stream);
  // Scroll to bottom (newest)
  panel.scrollTop = panel.scrollHeight;
}

// Listen for sidebar updates from file watcher
window.pangea.onSidebarUpdate((data) => {
  renderAutoStream(data.auto || []);

  if (data.pinned && data.pinned.length > 0) {
    data.pinned.forEach(item => window.pangea.pinItem(item));
  }
});

// Listen for pinned updates
window.pangea.onPinnedUpdate((pinned) => {
  renderPanel('tab-pinned', pinned, true);
});
