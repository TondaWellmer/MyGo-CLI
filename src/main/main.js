const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, session, screen, desktopCapturer, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');
const zlib = require('zlib');
const https = require('https');
const pty = require('node-pty');

// Prevent uncaught PTY errors from crashing the entire app
process.on('uncaughtException', (err) => {
  console.error('[Pangea] Uncaught exception:', err.message);
  if (err.message && err.message.includes('resize')) return;
});

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SIDEBAR_JSON = path.join(CLAUDE_DIR, 'pangea-sidebar.json');
const PINNED_JSON = path.join(CLAUDE_DIR, 'pangea-pinned.json');
const INSTANCES_JSON = path.join(CLAUDE_DIR, 'pangea-instances.json');
const SESSIONS_JSON = path.join(CLAUDE_DIR, 'pangea-sessions.json');
const GLOBAL_CONFIG = path.join(CLAUDE_DIR, 'pangea-config.json');
const HIDDEN_JSON = path.join(CLAUDE_DIR, 'pangea-hidden.json');
const ATTACH_HISTORY_JSON = path.join(CLAUDE_DIR, 'pangea-attach-history.json');
const WORKSESSIONS_JSON = path.join(CLAUDE_DIR, 'pangea-worksessions.json');

// Determine workspace root — saved globally so it survives across instances
function getWorkspaceRoot() {
  try {
    if (fs.existsSync(GLOBAL_CONFIG)) {
      const config = JSON.parse(fs.readFileSync(GLOBAL_CONFIG, 'utf-8'));
      if (config.workspaceRoot && fs.existsSync(config.workspaceRoot)) {
        return config.workspaceRoot;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

function saveWorkspaceRoot(dir) {
  if (!fs.existsSync(CLAUDE_DIR)) fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(GLOBAL_CONFIG, JSON.stringify({ workspaceRoot: dir }, null, 2));
}

let WORKSPACE_ROOT = getWorkspaceRoot();

let mainWindow;
let ptyProcesses = new Map(); // tabId -> { pty, color, name }
let activeTabId = null;
let sidebarWatcher;
let instanceId;
let sessionId = null; // Legacy fallback — per-tab session IDs are stored in ptyProcesses[tabId].sessionId
const closedTabs = new Set(); // Tabs explicitly closed by user — skip auto-respawn

// --- Instance Config ---

function loadInstances() {
  try {
    if (fs.existsSync(INSTANCES_JSON)) {
      return JSON.parse(fs.readFileSync(INSTANCES_JSON, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return { instances: {} };
}

function saveInstances(data) {
  fs.writeFileSync(INSTANCES_JSON, JSON.stringify(data, null, 2));
}

function getInstanceConfig() {
  const data = loadInstances();
  if (!data.instances[instanceId]) {
    data.instances[instanceId] = {
      name: path.basename(WORKSPACE_ROOT),
      color: '#12120c',
      cwd: WORKSPACE_ROOT
    };
    saveInstances(data);
  }
  return data.instances[instanceId];
}

function updateInstanceConfig(updates) {
  const data = loadInstances();
  if (!data.instances[instanceId]) {
    data.instances[instanceId] = { name: '', color: '#12120c', cwd: WORKSPACE_ROOT };
  }
  Object.assign(data.instances[instanceId], updates);
  saveInstances(data);
  return data.instances[instanceId];
}

// --- Session History ---

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_JSON)) {
      return JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return { sessions: [] };
}

function saveSessions(data) {
  fs.writeFileSync(SESSIONS_JSON, JSON.stringify(data, null, 2));
}

function addSession(id) {
  const data = loadSessions();
  const config = getInstanceConfig();
  const currentName = config.name || 'Unbenannt';

  // Update existing session with current name
  const existing = data.sessions.find(s => s.id === id);
  if (existing) {
    existing.name = currentName;
    existing.cwd = config.cwd;
    saveSessions(data);
    return;
  }

  data.sessions.unshift({
    id,
    name: currentName,
    cwd: config.cwd,
    timestamp: new Date().toISOString()
  });

  // Keep max 100 sessions
  if (data.sessions.length > 100) {
    data.sessions = data.sessions.slice(0, 100);
  }

  saveSessions(data);
}

// --- CWD / Subprojects ---

function getSubprojects(dirPath) {
  try {
    const projectsDir = path.join(dirPath, 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(projectsDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        projects.push({
          name: entry.name,
          path: fullPath,
          mtime: stat.mtimeMs
        });
      } catch (e) { /* skip inaccessible */ }
    }

    // Sort by mtime descending (most recent first)
    projects.sort((a, b) => b.mtime - a.mtime);
    return projects;
  } catch (e) {
    return [];
  }
}

// --- OpenCode OAuth Token Exchange ---

function _exchangeOAuthCode(code) {
  return new Promise((resolve, reject) => {
    const postData = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent('https://opencode.ai/auth/callback')}&client_id=app`;
    const req = https.request({
      hostname: 'auth.opencode.ai', port: 443, path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            _opencodeToken = json.access_token;
            // Persist to auth.json
            const authDir = path.join(os.homedir(), '.local', 'share', 'opencode');
            if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
            const authPath = path.join(authDir, 'auth.json');
            let existing = {};
            try { existing = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch {}
            existing.opencode = { type: 'api', key: json.access_token };
            fs.writeFileSync(authPath, JSON.stringify(existing, null, 2), 'utf8');
            console.log('[OpenCode Auth] Token saved successfully');
            resolve(json.access_token);
          } else {
            console.warn('[OpenCode Auth] Exchange failed:', json.error, json.error_description);
            reject(new Error(json.error_description || json.error || 'Exchange failed'));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

// --- Window ---

function createWindow() {
  const config = getInstanceConfig();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: config.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: config.color,
      symbolColor: '#cdd6f4',
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      enableRemoteModule: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Grant microphone permission for voice recording
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture'];
    callback(allowed.includes(permission));
  });

  // Close guard — ask renderer if there's unsaved work before closing
  let closeConfirmHandler = null;
  mainWindow.on('close', (e) => {
    // Send check to renderer — if editors have unsaved content, show dialog
    e.preventDefault();
    mainWindow.webContents.send('app:close-requested');

    // Remove stale listener from previous close attempt (user cancelled last time)
    if (closeConfirmHandler) {
      ipcMain.removeListener('app:close-confirmed', closeConfirmHandler);
    }

    // Renderer responds with 'app:close-confirmed' or does nothing (user cancelled)
    closeConfirmHandler = () => {
      _saveCrashRecoveryState();
      mainWindow.destroy();
    };
    ipcMain.once('app:close-confirmed', closeConfirmHandler);

    // Auto-confirm after 5s if renderer doesn't respond (e.g. crashed)
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        _saveCrashRecoveryState();
        mainWindow.destroy();
      }
    }, 5000);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    cleanup();
  });

  // Check for crash recovery on startup
  _checkCrashRecovery();
}

// --- Crash Recovery ---

const RECOVERY_PATH = path.join(CLAUDE_DIR, 'pangea-recovery.json');

function _saveCrashRecoveryState() {
  try {
    // Preserve lastWorkSessionId across clean shutdowns
    let lastWsId = null;
    try {
      if (fs.existsSync(RECOVERY_PATH)) {
        const prev = JSON.parse(fs.readFileSync(RECOVERY_PATH, 'utf8'));
        lastWsId = prev.lastWorkSessionId || null;
      }
    } catch (_) { /* ignore */ }

    const state = {
      timestamp: Date.now(),
      pid: process.pid,
      clean: true,
      lastWorkSessionId: lastWsId
    };
    fs.writeFileSync(RECOVERY_PATH, JSON.stringify(state));
  } catch (_) { /* ignore */ }
}

function _checkCrashRecovery() {
  try {
    if (!fs.existsSync(RECOVERY_PATH)) return;
    const state = JSON.parse(fs.readFileSync(RECOVERY_PATH, 'utf8'));

    // If last shutdown was NOT clean (no 'clean' flag or it's false)
    if (!state.clean) {
      // Notify renderer to offer recovery
      if (mainWindow) {
        mainWindow.webContents.once('did-finish-load', () => {
          mainWindow.webContents.send('app:crash-recovery', state);
        });
      }
    }

    // Mark as unclean — will be overwritten on clean shutdown
    fs.writeFileSync(RECOVERY_PATH, JSON.stringify({ timestamp: Date.now(), clean: false }));
  } catch (_) { /* ignore */ }
}

// --- Terminal ---

function findShell() {
  if (process.platform !== 'win32') return process.env.SHELL || '/bin/bash';
  // Windows: prefer Git\bin\bash.exe (proper Git Bash wrapper with MSYS env)
  // Avoid Git\usr\bin\bash.exe (raw MSYS2 bash — may exit immediately without env)
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    path.join(os.homedir(), 'scoop', 'shims', 'bash.exe'),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  // Fallback: try where, but filter out usr\bin
  const { execSync } = require('child_process');
  try {
    const result = execSync('where bash.exe', { encoding: 'utf-8', timeout: 3000 }).trim();
    const lines = result.split('\n').map(l => l.trim()).filter(l => !l.includes('usr\\bin'));
    if (lines.length) return lines[0];
    // If only usr\bin found, use it as last resort
    return result.split('\n')[0].trim();
  } catch {}
  return 'bash.exe';
}

function spawnTerminal(tabId) {
  if (!tabId) tabId = 'tab-0';
  const config = getInstanceConfig();
  const shellPath = findShell();
  console.log('[Pangea] Shell:', shellPath, '| CWD:', config.cwd);
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color'
  });

  const ptyProc = pty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: config.cwd,
    env
  });

  ptyProcesses.set(tabId, { pty: ptyProc, color: '#eaeae6', name: 'Pangea CLI' });
  if (!activeTabId) activeTabId = tabId;

  ptyProc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { tabId, data });
    }
  });

  let _respawnCount = 0;
  const MAX_RESPAWNS = 3;

  function attachExitHandler(ptyProc2, tabId2) {
    ptyProc2.onExit(({ exitCode }) => {
      console.log('[Pangea] PTY exited:', tabId2, 'code:', exitCode, 'respawns:', _respawnCount);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:exit', { tabId: tabId2, exitCode });
      }
      const oldEntry = ptyProcesses.get(tabId2);
      const keepColor = oldEntry ? oldEntry.color : '#eaeae6';
      const keepName = oldEntry ? oldEntry.name : 'Pangea CLI';
      const keepSessionId = oldEntry ? oldEntry.sessionId : null;
      ptyProcesses.delete(tabId2);

      // Only respawn if not explicitly closed and not in a crash loop
      if (closedTabs.has(tabId2)) { closedTabs.delete(tabId2); return; }
      if (_respawnCount >= MAX_RESPAWNS) {
        console.log('[Pangea] Max respawns reached for', tabId2, '— stopping');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:data', { tabId: tabId2, data: '\r\n\x1b[31m[Shell crashed — max respawns reached. Click terminal tab to retry.]\x1b[0m\r\n' });
        }
        return;
      }
      _respawnCount++;

      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !ptyProcesses.has(tabId2)) {
          const config = getInstanceConfig();
          const shellPath = findShell();
          const env = Object.assign({}, process.env, { TERM: 'xterm-256color' });
          try {
            const newPty = pty.spawn(shellPath, [], {
              name: 'xterm-256color', cols: 120, rows: 30,
              cwd: config.cwd, env
            });
            ptyProcesses.set(tabId2, { pty: newPty, color: keepColor, name: keepName, sessionId: keepSessionId });
            newPty.onData((data) => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('terminal:data', { tabId: tabId2, data });
              }
            });
            attachExitHandler(newPty, tabId2);
            mainWindow.webContents.send('terminal:respawned', { tabId: tabId2 });
          } catch (e) {
            console.error('[Pangea] Respawn failed:', e.message);
          }
        }
      }, 500);
    });
  }

  attachExitHandler(ptyProc, tabId);
  return tabId;
}

// Spawn default preset tabs (4 empty tabs ready to use)
function spawnDefaultTerminal() {
  for (let i = 0; i < 4; i++) {
    spawnTerminal('tab-' + i);
  }
}

// --- Sidebar ---

function watchSidebar() {
  // Fresh start: clear auto items each session, keep pinned
  const fresh = { auto: [], pinned: [] };
  if (fs.existsSync(SIDEBAR_JSON)) {
    try {
      const old = JSON.parse(fs.readFileSync(SIDEBAR_JSON, 'utf-8'));
      fresh.pinned = old.pinned || [];
    } catch (e) { /* ignore */ }
  }
  fs.writeFileSync(SIDEBAR_JSON, JSON.stringify(fresh, null, 2));

  const sendSidebarData = () => {
    try {
      const data = JSON.parse(fs.readFileSync(SIDEBAR_JSON, 'utf-8'));
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sidebar:update', data);
      }
    } catch (e) { /* ignore parse errors */ }
  };

  sendSidebarData();

  sidebarWatcher = fs.watch(SIDEBAR_JSON, { persistent: false }, (eventType) => {
    if (eventType === 'change') {
      setTimeout(sendSidebarData, 100);
    }
  });
}

function loadPinned() {
  try {
    if (fs.existsSync(PINNED_JSON)) {
      return JSON.parse(fs.readFileSync(PINNED_JSON, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function savePinned(items) {
  fs.writeFileSync(PINNED_JSON, JSON.stringify(items, null, 2));
}

// --- Session Detection via File Watcher ---
// Claude's session files are .jsonl in the project directory.
// The filename IS the session ID. Watch for new/modified files.

let sessionWatcher = null;

function watchSessionFiles() {
  const normalizedRoot = WORKSPACE_ROOT.replace(/\\/g, '-').replace(/:/g, '-').replace(/^-/, '');
  const projectDir = path.join(CLAUDE_DIR, 'projects', normalizedRoot);

  if (!fs.existsSync(projectDir)) return;

  // On startup, find the most recently modified .jsonl = current session
  detectCurrentSession(projectDir);

  try {
    sessionWatcher = fs.watch(projectDir, { persistent: false }, (eventType, filename) => {
      if (filename && filename.endsWith('.jsonl')) {
        const id = filename.replace('.jsonl', '');
        // Update global fallback (for history/legacy purposes only)
        sessionId = id;
        addSession(id);
        // Store per-tab: assign to whichever tab is currently active
        // IMPORTANT: Only assign if this tab doesn't already own a DIFFERENT session.
        // This prevents session-watcher from overwriting a tab's own session with
        // another tab's session (race condition when multiple Claude instances run).
        const assignedTab = activeTabId;
        if (assignedTab && ptyProcesses.has(assignedTab)) {
          const entry = ptyProcesses.get(assignedTab);
          // Check if another tab already owns this session ID
          let ownedElsewhere = false;
          for (const [otherTabId, otherEntry] of ptyProcesses.entries()) {
            if (otherTabId !== assignedTab && otherEntry.sessionId === id) {
              ownedElsewhere = true;
              break;
            }
          }
          if (!ownedElsewhere && entry.sessionId !== id) {
            entry.sessionId = id;
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          // Send tabId along so renderer only updates the correct tab's button
          mainWindow.webContents.send('session:id-update', { id, tabId: assignedTab });
        }
      }
    });
  } catch (e) { /* ignore watch errors */ }
}

function detectCurrentSession(projectDir) {
  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        id: f.replace('.jsonl', ''),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      sessionId = files[0].id;
      addSession(sessionId);
      // Also store per-tab if active tab exists
      if (activeTabId && ptyProcesses.has(activeTabId)) {
        ptyProcesses.get(activeTabId).sessionId = sessionId;
      }
      // Notify renderer once window is ready
      const assignedTab = activeTabId;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session:id-update', { id: sessionId, tabId: assignedTab });
      } else {
        // Defer until window is ready
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('session:id-update', { id: sessionId, tabId: assignedTab });
          }
        }, 2000);
      }
    }
  } catch (e) { /* ignore */ }
}

// --- Cleanup ---

function cleanup() {
  for (const [id, entry] of ptyProcesses) {
    try { entry.pty.kill(); } catch {}
  }
  ptyProcesses.clear();
  if (sidebarWatcher) {
    sidebarWatcher.close();
    sidebarWatcher = null;
  }
  if (sessionWatcher) {
    sessionWatcher.close();
    sessionWatcher = null;
  }
}

// --- IPC Handlers ---

// Terminal — Multi-Tab
ipcMain.on('terminal:input', (_, payload) => {
  // Support both legacy string format and new {tabId, data} object format
  if (typeof payload === 'string') {
    const entry = ptyProcesses.get(activeTabId || 'tab-0');
    if (entry) entry.pty.write(payload);
  } else if (payload && payload.data) {
    const id = payload.tabId || activeTabId || 'tab-0';
    const entry = ptyProcesses.get(id);
    if (entry) entry.pty.write(payload.data);
  }
});

ipcMain.on('terminal:resize', (_, payload) => {
  const { tabId, cols, rows } = payload || {};
  if (cols && rows) {
    const id = tabId || activeTabId || 'tab-0';
    const entry = ptyProcesses.get(id);
    if (entry) {
      try { entry.pty.resize(cols, rows); } catch (e) { /* PTY already exited */ }
    }
  }
});

// Tab Management
ipcMain.handle('terminal:create-tab', () => {
  const tabId = 'tab-' + Date.now();
  spawnTerminal(tabId);
  return tabId;
});

ipcMain.on('terminal:close-tab', (_, tabId) => {
  closedTabs.add(tabId); // Mark as explicitly closed — prevents auto-respawn
  const entry = ptyProcesses.get(tabId);
  if (entry) {
    entry.pty.kill();
    ptyProcesses.delete(tabId);
  }
});

ipcMain.on('terminal:set-active-tab', (_, tabId) => {
  activeTabId = tabId;
});

ipcMain.on('terminal:set-tab-color', (_, { tabId, color }) => {
  const entry = ptyProcesses.get(tabId);
  if (entry) entry.color = color;
});

ipcMain.on('terminal:set-tab-name', (_, { tabId, name }) => {
  const entry = ptyProcesses.get(tabId);
  if (entry) entry.name = name;
});

// Sidebar
ipcMain.on('sidebar:open-url', (_, url) => {
  // Only allow http/https URLs — prevent file:// or javascript: protocol abuse
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

ipcMain.on('sidebar:open-file', (_, filePath) => {
  shell.openPath(filePath);
});

ipcMain.on('sidebar:open-folder', (_, filePath) => {
  shell.showItemInFolder(filePath);
});

function getPinKey(item) {
  // Text items: use question or text as key
  if (item.type === 'answer') return `answer:${item.question}`;
  if (item.type === 'milestone') return `milestone:${item.text}`;
  if (item.type === 'message') return `message:${item.text}`;
  // File/URL items
  return item.url || item.path || '';
}

ipcMain.on('sidebar:pin', (_, item) => {
  const pinned = loadPinned();
  const key = getPinKey(item);
  const exists = pinned.some(p => getPinKey(p) === key);
  if (!exists) {
    item.pinnedAt = new Date().toISOString();
    pinned.push(item);
    savePinned(pinned);
  }
  mainWindow.webContents.send('sidebar:pinned-update', pinned);
});

ipcMain.on('sidebar:unpin', (_, item) => {
  let pinned = loadPinned();
  const key = getPinKey(item);
  pinned = pinned.filter(p => getPinKey(p) !== key);
  savePinned(pinned);
  mainWindow.webContents.send('sidebar:pinned-update', pinned);
});

ipcMain.handle('sidebar:get-pinned', () => {
  return loadPinned();
});

// Push item into Auto tab (from DigestEngine via renderer)
ipcMain.on('sidebar:push-auto', (_, item) => {
  try {
    let sidebar = { auto: [], pinned: [] };
    if (fs.existsSync(SIDEBAR_JSON)) {
      sidebar = JSON.parse(fs.readFileSync(SIDEBAR_JSON, 'utf-8'));
    }
    if (!sidebar.auto) sidebar.auto = [];
    sidebar.auto.unshift(item);
    if (sidebar.auto.length > 50) sidebar.auto = sidebar.auto.slice(0, 50);
    fs.writeFileSync(SIDEBAR_JSON, JSON.stringify(sidebar, null, 2));
    // File watcher will trigger sidebar:update automatically
  } catch (e) { /* ignore */ }
});

// Instance Config
ipcMain.handle('instance:get-config', () => {
  return getInstanceConfig();
});

ipcMain.on('instance:set-color', (_, color) => {
  updateInstanceConfig({ color });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitleBarOverlay({ color, symbolColor: '#cdd6f4' });
  }
});

ipcMain.on('instance:set-text-color', (_, color) => {
  updateInstanceConfig({ textColor: color });
});

ipcMain.on('instance:set-sidebar-color', (_, color) => {
  updateInstanceConfig({ sidebarColor: color });
});

ipcMain.on('instance:set-name', (_, name) => {
  updateInstanceConfig({ name });
});

// CWD / Subprojects
ipcMain.handle('cwd:get-info', () => {
  const config = getInstanceConfig();
  const cwd = config.cwd;
  const subprojects = getSubprojects(cwd);
  return {
    cwd,
    basename: path.basename(cwd),
    hasSubprojects: subprojects.length > 0,
    subprojects
  };
});

ipcMain.on('cwd:change', (_, newCwd) => {
  updateInstanceConfig({ cwd: newCwd });
  const entry = ptyProcesses.get(activeTabId || 'tab-0');
  if (entry) {
    entry.pty.write(`cd "${newCwd.replace(/\\/g, '/')}"\r`);
  }
});

// Project Explorer — nur Dateien die für den USER relevant sind
ipcMain.handle('explorer:get-tree', () => {
  const config = getInstanceConfig();
  const rootDir = config.cwd;
  const tree = [];

  // 1. _needs/ — "Was fehlt noch" (immer oben, aufgeklappt)
  const needsDir = path.join(rootDir, '_needs');
  if (fs.existsSync(needsDir)) {
    const needsFiles = fs.readdirSync(needsDir)
      .filter(f => f.endsWith('.txt') && f !== 'INDEX.txt')
      .map(f => ({
        name: f.replace('.txt', '').replace(/-/g, ' '),
        path: path.join(needsDir, f)
      }));
    tree.push({ name: '⚠️ Was fehlt noch', folder: '_needs', files: needsFiles, expanded: false });
  }

  // 2. Attachments
  const attachDir = path.join(rootDir, '_attachments');
  if (fs.existsSync(attachDir)) {
    const attachFiles = fs.readdirSync(attachDir)
      .filter(f => !f.startsWith('.'))
      .sort().reverse()
      .slice(0, 30)
      .map(f => ({ name: f, path: path.join(attachDir, f) }));
    if (attachFiles.length > 0) {
      tree.push({ name: '📎 Anhänge', folder: '_attachments', files: attachFiles, expanded: false });
    }
  }

  // 3. Text Shots
  if (fs.existsSync(getTextShotsDir())) {
    const shots = fs.readdirSync(getTextShotsDir())
      .filter(f => f.endsWith('.txt'))
      .sort().reverse()
      .slice(0, 20)
      .map(f => ({ name: f.replace('.txt', ''), path: path.join(getTextShotsDir(), f) }));
    if (shots.length > 0) {
      tree.push({ name: '📸 Text Shots', folder: '_textshots', files: shots, expanded: false });
    }
  }

  // 3. Pro Projekt: nur user-relevante Dateien
  const projectsDir = path.join(rootDir, 'projects');
  if (fs.existsSync(projectsDir)) {
    const projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const proj of projects) {
      const projPath = path.join(projectsDir, proj.name);
      const userFiles = [];

      // Präsentationen (HTML die man im Browser anschauen will)
      // Scan root + docs/ for presentation*.html
      for (const dir of [projPath, path.join(projPath, 'docs')]) {
        if (!fs.existsSync(dir)) continue;
        const htmls = fs.readdirSync(dir)
          .filter(f => /^presentation.*\.html$/.test(f));
        for (const hf of htmls) {
          const prefix = dir === projPath ? '' : 'docs/';
          userFiles.push({ name: prefix + hf, path: path.join(dir, hf) });
        }
      }

      // .env file (if exists)
      const envFile = path.join(projPath, '.env');
      if (fs.existsSync(envFile)) {
        userFiles.push({ name: '.env', path: envFile });
      }

      // docs/ — nur .txt und .html (für den User lesbar)
      const docsDir = path.join(projPath, 'docs');
      if (fs.existsSync(docsDir)) {
        const docs = fs.readdirSync(docsDir)
          .filter(f => /\.(txt|html)$/.test(f))
          .filter(f => !f.startsWith('.'))
          .map(f => ({ name: f, path: path.join(docsDir, f) }));
        userFiles.push(...docs);
      }

      // Links aus _links/{projektname-lowercase}/
      const linksDir = path.join(rootDir, '_links', proj.name.toLowerCase());
      if (fs.existsSync(linksDir)) {
        const urlFiles = fs.readdirSync(linksDir)
          .filter(f => f.endsWith('.url'));
        for (const uf of urlFiles) {
          try {
            const content = fs.readFileSync(path.join(linksDir, uf), 'utf-8');
            const urlMatch = content.match(/^URL=(.+)$/m);
            if (urlMatch) {
              userFiles.push({
                name: uf.replace('.url', ''),
                url: urlMatch[1].trim(),
                path: path.join(linksDir, uf),
                type: 'link'
              });
            }
          } catch (e) { /* skip unreadable */ }
        }
      }

      if (userFiles.length > 0) {
        tree.push({ name: proj.name, folder: `projects/${proj.name}`, files: userFiles, expanded: false });
      }
    }
  }

  return tree;
});

// Text Shots
function getTextShotsDir() { return path.join(WORKSPACE_ROOT, '_textshots'); }

ipcMain.handle('textshot:save', (_, text) => {
  if (!fs.existsSync(getTextShotsDir())) fs.mkdirSync(getTextShotsDir(), { recursive: true });

  // Find next number
  const existing = fs.readdirSync(getTextShotsDir()).filter(f => /^shot-\d+\.txt$/.test(f));
  const nums = existing.map(f => parseInt(f.match(/\d+/)[0]));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;

  const filename = `shot-${String(next).padStart(3, '0')}.txt`;
  const filepath = path.join(getTextShotsDir(), filename);
  fs.writeFileSync(filepath, text, 'utf-8');
  return { filename, path: filepath };
});

ipcMain.handle('textshot:list', () => {
  if (!fs.existsSync(getTextShotsDir())) return [];
  return fs.readdirSync(getTextShotsDir())
    .filter(f => f.endsWith('.txt'))
    .sort()
    .reverse()
    .map(f => ({
      name: f,
      path: path.join(getTextShotsDir(), f),
      preview: fs.readFileSync(path.join(getTextShotsDir(), f), 'utf-8').substring(0, 80)
    }));
});

ipcMain.handle('textshot:read', (_, filepath) => {
  // Validate path is inside textshots directory to prevent path traversal
  const resolved = path.resolve(filepath);
  if (!resolved.startsWith(path.resolve(getTextShotsDir()))) {
    return null;
  }
  return fs.readFileSync(resolved, 'utf-8');
});

// App relaunch — full restart of the Electron app
ipcMain.on('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

// Session ID
ipcMain.handle('session:get-id', (_, tabId) => {
  // Per-tab session ID ONLY — no global fallback to prevent cross-tab leaking
  const tid = tabId || activeTabId;
  if (tid && ptyProcesses.has(tid)) {
    const entry = ptyProcesses.get(tid);
    if (entry.sessionId) return entry.sessionId;
  }
  return null;
});

ipcMain.on('session:copy-resume', (_, id) => {
  // Use provided id, or per-tab session, or global fallback
  let target = id;
  if (!target && activeTabId && ptyProcesses.has(activeTabId)) {
    target = ptyProcesses.get(activeTabId).sessionId;
  }
  if (!target) target = sessionId;
  if (target) {
    clipboard.writeText(`claude --resume ${target}`);
  }
});

ipcMain.handle('session:get-history', () => {
  const data = loadSessions();
  // Merge in sessions from Claude's project directory (if not already known)
  try {
    const claudeProjectDir = path.join(CLAUDE_DIR, 'projects');
    // Find the project folder matching our workspace
    const normalizedRoot = WORKSPACE_ROOT.replace(/\\/g, '-').replace(/:/g, '-').replace(/^-/, '');
    const projectDir = path.join(claudeProjectDir, normalizedRoot);

    if (fs.existsSync(projectDir)) {
      const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      const knownIds = new Set(data.sessions.map(s => s.id));

      for (const file of jsonlFiles) {
        const id = file.replace('.jsonl', '');
        if (knownIds.has(id)) continue;

        const filePath = path.join(projectDir, file);
        const stat = fs.statSync(filePath);

        data.sessions.push({
          id,
          name: 'Session',
          cwd: WORKSPACE_ROOT,
          timestamp: stat.mtime.toISOString(),
          source: 'claude-history'
        });
      }

      // Sort by timestamp descending
      data.sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Save merged list
      saveSessions(data);
    }
  } catch (e) { /* ignore scan errors */ }

  return data.sessions;
});

ipcMain.handle('session:add-current-to-history', () => {
  // Add the active tab's session ID to session history (the "+" button in Session History)
  const tid = activeTabId;
  if (tid && ptyProcesses.has(tid)) {
    const entry = ptyProcesses.get(tid);
    if (entry.sessionId) {
      addSession(entry.sessionId);
      return { ok: true, id: entry.sessionId };
    }
  }
  return { ok: false };
});

ipcMain.on('session:load', (_, id) => {
  const entry = ptyProcesses.get(activeTabId || 'tab-0');
  if (entry) {
    entry.pty.write(`claude --resume ${id}\r`);
  }
});

// --- Work Sessions ---

function loadWorkSessions() {
  try {
    if (fs.existsSync(WORKSESSIONS_JSON)) {
      return JSON.parse(fs.readFileSync(WORKSESSIONS_JSON, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return { sessions: [] };
}

function saveWorkSessions(data) {
  fs.writeFileSync(WORKSESSIONS_JSON, JSON.stringify(data, null, 2));
}

// Save the last active work session ID for crash recovery
function saveLastWorkSessionId(wsId) {
  try {
    const recovery = fs.existsSync(RECOVERY_PATH)
      ? JSON.parse(fs.readFileSync(RECOVERY_PATH, 'utf8'))
      : {};
    recovery.lastWorkSessionId = wsId;
    fs.writeFileSync(RECOVERY_PATH, JSON.stringify(recovery));
  } catch (_) { /* ignore */ }
}

ipcMain.handle('worksession:list', () => {
  return loadWorkSessions().sessions;
});

ipcMain.handle('worksession:save', (_, name) => {
  const data = loadWorkSessions();
  const tabsSnapshot = [];

  for (const [tabId, entry] of ptyProcesses.entries()) {
    tabsSnapshot.push({
      tabId,
      color: entry.color || '#eaeae6',
      name: entry.name || 'Tab',
      sessionId: entry.sessionId || ((tabId === activeTabId) ? sessionId : null),
      cwd: entry.cwd || WORKSPACE_ROOT
    });
  }

  // Capture instance-level settings (textColor etc.)
  const instanceConfig = getInstanceConfig();

  const wsId = 'ws-' + Date.now();
  const count = data.sessions.length;
  const ws = {
    id: wsId,
    name: name || `Work_Session_${String(count + 1).padStart(2, '0')}`,
    tabs: tabsSnapshot,
    textColor: instanceConfig.textColor || null,
    timestamp: new Date().toISOString()
  };

  data.sessions.unshift(ws);
  if (data.sessions.length > 50) data.sessions = data.sessions.slice(0, 50);
  saveWorkSessions(data);
  saveLastWorkSessionId(wsId);
  return ws;
});

ipcMain.handle('worksession:rename', (_, { id, name }) => {
  const data = loadWorkSessions();
  const ws = data.sessions.find(s => s.id === id);
  if (ws) {
    ws.name = name;
    saveWorkSessions(data);
  }
  return ws;
});

ipcMain.handle('worksession:delete', (_, id) => {
  const data = loadWorkSessions();
  data.sessions = data.sessions.filter(s => s.id !== id);
  saveWorkSessions(data);
  return true;
});

ipcMain.handle('worksession:get-open-tabs', () => {
  const tabsSnapshot = [];
  for (const [tabId, entry] of ptyProcesses.entries()) {
    tabsSnapshot.push({
      tabId,
      color: entry.color || '#eaeae6',
      name: entry.name || 'Tab',
      sessionId: entry.sessionId || null
    });
  }
  return tabsSnapshot;
});

ipcMain.handle('worksession:load', (_, wsId) => {
  const data = loadWorkSessions();
  const ws = data.sessions.find(s => s.id === wsId);
  if (!ws) return null;

  // Kill all existing PTY processes except tab-0
  for (const [tabId, entry] of ptyProcesses.entries()) {
    if (tabId !== 'tab-0') {
      entry.pty.kill();
      ptyProcesses.delete(tabId);
    }
  }

  // Prepare restore data for renderer
  const restoreTabs = [];
  for (const tab of ws.tabs) {
    let tabId = tab.tabId;
    if (tabId === 'tab-0') {
      // Reuse existing tab-0 PTY
      const entry = ptyProcesses.get('tab-0');
      if (entry) {
        entry.color = tab.color;
        entry.name = tab.name;
        entry.sessionId = tab.sessionId;
      }
    } else {
      // Spawn new PTY for this tab
      tabId = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      spawnTerminal(tabId);
      const entry = ptyProcesses.get(tabId);
      if (entry) {
        entry.color = tab.color;
        entry.name = tab.name;
        entry.sessionId = tab.sessionId;
      }
    }
    restoreTabs.push({
      tabId,
      color: tab.color,
      name: tab.name,
      sessionId: tab.sessionId
    });
  }

  saveLastWorkSessionId(wsId);

  // Send restore event to renderer (include textColor for full restore)
  if (mainWindow) {
    mainWindow.webContents.send('worksession:restore', {
      tabs: restoreTabs,
      textColor: ws.textColor || null
    });
  }

  return ws;
});

ipcMain.handle('worksession:recover', () => {
  try {
    if (!fs.existsSync(RECOVERY_PATH)) return null;
    const recovery = JSON.parse(fs.readFileSync(RECOVERY_PATH, 'utf8'));
    if (!recovery.lastWorkSessionId) return null;

    const data = loadWorkSessions();
    const ws = data.sessions.find(s => s.id === recovery.lastWorkSessionId);
    return ws || null;
  } catch (_) { return null; }
});

// --- Attachments ---

function getAttachmentsDir() {
  const dir = path.join(WORKSPACE_ROOT, '_attachments');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('attachment:paste-image', () => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;

  const buffer = image.toPNG();
  const filename = `paste-${Date.now()}.png`;
  const filepath = path.join(getAttachmentsDir(), filename);
  fs.writeFileSync(filepath, buffer);

  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return { path: filepath, filename, dataUrl, isImage: true };
});

ipcMain.handle('attachment:pick-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Dateien anhängen',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
      { name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] },
      { name: 'Dokumente', extensions: ['pdf', 'txt', 'md', 'json', 'csv', 'log'] },
      { name: 'Alle Dateien', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return [];

  return result.filePaths.map(fp => {
    const ext = path.extname(fp).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
    let dataUrl = null;

    if (isImage) {
      try {
        const buf = fs.readFileSync(fp);
        const mime = ext === '.png' ? 'image/png'
          : ext === '.gif' ? 'image/gif'
          : ext === '.webp' ? 'image/webp'
          : ext === '.bmp' ? 'image/bmp'
          : 'image/jpeg';
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      } catch (e) { /* skip preview */ }
    }

    return {
      path: fp,
      filename: path.basename(fp),
      dataUrl,
      isImage,
      ext: ext.replace('.', '')
    };
  });
});

ipcMain.handle('attachment:get-data-url', (_, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const buf = fs.readFileSync(filePath);
    const mime = ext === '.png' ? 'image/png'
      : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp'
      : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    return null;
  }
});

// --- Sidebar Answer Items ---

// Add any item to sidebar auto-stream (answer, milestone, message)
function addToAutoStream(item) {
  try {
    let data = { auto: [], pinned: [] };
    if (fs.existsSync(SIDEBAR_JSON)) {
      data = JSON.parse(fs.readFileSync(SIDEBAR_JSON, 'utf-8'));
    }
    if (!data.auto) data.auto = [];
    item.timestamp = item.timestamp || new Date().toISOString();
    data.auto.unshift(item);
    fs.writeFileSync(SIDEBAR_JSON, JSON.stringify(data, null, 2));
  } catch (e) { /* ignore */ }
}

ipcMain.on('sidebar:add-answer', (_, { question, answer }) => {
  addToAutoStream({ type: 'answer', question, answer });
});

ipcMain.on('sidebar:add-milestone', (_, { text, files }) => {
  addToAutoStream({ type: 'milestone', text, files });
});

ipcMain.on('sidebar:add-message', (_, { text, files }) => {
  addToAutoStream({ type: 'message', text, files });
});

// --- Attachment History ---

function loadAttachHistory() {
  try {
    if (fs.existsSync(ATTACH_HISTORY_JSON)) {
      return JSON.parse(fs.readFileSync(ATTACH_HISTORY_JSON, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return { items: [] };
}

function saveAttachHistory(data) {
  fs.writeFileSync(ATTACH_HISTORY_JSON, JSON.stringify(data, null, 2));
}

function addToAttachHistory(files) {
  const data = loadAttachHistory();
  for (const f of files) {
    // Remove duplicate if exists
    data.items = data.items.filter(i => i.path !== f.path);
    data.items.unshift({
      path: f.path,
      filename: f.filename,
      isImage: f.isImage,
      ext: f.ext || path.extname(f.path).replace('.', ''),
      timestamp: new Date().toISOString()
    });
  }
  // Keep max 50
  if (data.items.length > 50) data.items = data.items.slice(0, 50);
  saveAttachHistory(data);
}

ipcMain.handle('attachment:get-history', () => {
  const data = loadAttachHistory();
  // Filter out files that no longer exist
  const before = data.items.length;
  data.items = data.items.filter(item => fs.existsSync(item.path));
  // Auto-cleanup if items were removed
  if (data.items.length < before) saveAttachHistory(data);
  return data.items;
});

ipcMain.on('attachment:add-to-history', (_, files) => {
  addToAttachHistory(files);
});

// --- Hidden Files ---

function loadHidden() {
  try {
    if (fs.existsSync(HIDDEN_JSON)) {
      return JSON.parse(fs.readFileSync(HIDDEN_JSON, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return { hidden: [] };
}

function saveHidden(data) {
  fs.writeFileSync(HIDDEN_JSON, JSON.stringify(data, null, 2));
}

ipcMain.handle('explorer:get-hidden', () => {
  return loadHidden();
});

ipcMain.on('explorer:hide-file', (_, filepath) => {
  const data = loadHidden();
  if (!data.hidden.includes(filepath)) {
    data.hidden.push(filepath);
    saveHidden(data);
  }
});

ipcMain.on('explorer:unhide-all', (_, folder) => {
  const data = loadHidden();
  data.hidden = data.hidden.filter(p => !p.includes(folder));
  saveHidden(data);
});

// --- Editor File Operations ---
ipcMain.handle('editor:save-file', async (_, filePath, data) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (typeof data === 'string') {
    // JSON or text
    fs.writeFileSync(filePath, data, 'utf-8');
  } else {
    // Binary (Buffer from renderer)
    fs.writeFileSync(filePath, Buffer.from(data));
  }
  return { success: true, path: filePath };
});

ipcMain.handle('editor:show-save-dialog', async (_, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Speichern',
    defaultPath: options.defaultPath || undefined,
    filters: options.filters || [{ name: 'Alle Dateien', extensions: ['*'] }],
  });
  if (result.canceled) return null;
  return result.filePath;
});

ipcMain.handle('editor:show-open-dialog', async (_, options) => {
  const props = options.properties || ['openFile'];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Öffnen',
    defaultPath: options.defaultPath || undefined,
    filters: options.filters || [{ name: 'Alle Dateien', extensions: ['*'] }],
    properties: props,
  });
  if (result.canceled || !result.filePaths.length) return null;
  // Return array when multiSelections is used, single path otherwise
  if (props.includes('multiSelections')) return result.filePaths;
  return result.filePaths[0];
});

ipcMain.handle('editor:file-exists', async (_, filePath) => {
  return fs.existsSync(filePath);
});

ipcMain.handle('editor:read-file', async (_, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pangea-edit' || ext === '.pangea-video' || ext === '.json' || ext === '.xml' || ext === '.srt' || ext === '.vtt') {
    return fs.readFileSync(filePath, 'utf-8');
  }
  // Binary → base64
  const buf = fs.readFileSync(filePath);
  const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
});

// --- Binary File Reader (for audio, video, etc.) ---

ipcMain.handle('editor:read-binary-file', async (_, filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  // Read file as Buffer and convert to ArrayBuffer
  const buffer = fs.readFileSync(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

// --- Premiere .prproj Reader (GZip → XML) ---

ipcMain.handle('prproj:read-xml', async (_, filePath) => {
  if (!fs.existsSync(filePath)) return { error: 'Datei nicht gefunden' };
  try {
    const buf = fs.readFileSync(filePath);
    // .prproj is GZip-compressed XML
    const xmlBuf = zlib.gunzipSync(buf);
    return { xml: xmlBuf.toString('utf-8') };
  } catch (err) {
    // Might be uncompressed XML (older Premiere versions)
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (raw.trimStart().startsWith('<')) {
        return { xml: raw };
      }
    } catch (_) { /* ignore */ }
    return { error: 'GZip-Entpackung fehlgeschlagen: ' + err.message };
  }
});

// --- Editor Send (Image Editor → Attachment Bar) ---

ipcMain.handle('editor:get-attachments-dir', () => {
  return getAttachmentsDir();
});

ipcMain.on('editor:inject-attachment', (_, filePath) => {
  // Build attachment data and send back to renderer for the attachment preview bar
  const ext = path.extname(filePath).toLowerCase();
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
  let dataUrl = null;

  if (isImage) {
    try {
      const buf = fs.readFileSync(filePath);
      const mime = ext === '.png' ? 'image/png'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : ext === '.bmp' ? 'image/bmp'
        : 'image/jpeg';
      dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    } catch (e) { /* skip preview */ }
  }

  const attachment = {
    path: filePath,
    filename: path.basename(filePath),
    dataUrl,
    isImage,
    ext: ext.replace('.', '')
  };

  // Send to renderer so terminal.js can add it to the attachment bar
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('editor:attachment-injected', attachment);
  }

  // Also add to attachment history
  addToAttachHistory([attachment]);
});

// --- Video Editor ---

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

// Find FFprobe/FFmpeg — check common locations
function findFFBinary(name) {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', '**', name + '.exe'),
    path.join(os.homedir(), 'bin', name + '.exe'),
    path.join(os.homedir(), 'bin', name),
    path.join(os.homedir(), 'scoop', 'apps', 'ffmpeg', 'current', 'bin', name + '.exe'),
    path.join(process.env.PROGRAMFILES || '', 'ffmpeg', 'bin', name + '.exe'),
  ];
  // Try PATH first
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const fp = path.join(dir, name + '.exe');
    if (fs.existsSync(fp)) return fp;
    const fpNoExt = path.join(dir, name);
    if (fs.existsSync(fpNoExt)) return fpNoExt;
  }
  // Try known locations
  for (const fp of candidates) {
    if (!fp.includes('*') && fs.existsSync(fp)) return fp;
  }
  return name; // fallback — hope it's on PATH
}

const ffprobePath = findFFBinary('ffprobe');
const ffmpegPath = findFFBinary('ffmpeg');

// --- Video Editor AI API (IPC Bridge) ---
// Forwards API calls from external processes to the renderer's VideoEditorAPI.
// Pattern: ipcMain.handle('video-api:<method>') → sends to renderer → gets result back.

let _videoApiRequestId = 0;
const _videoApiPendingRequests = new Map();

// Generic method handler — any API method can be called by name
ipcMain.handle('video-api:call', async (event, { method, args }) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { error: 'Video Editor nicht verfügbar' };
  }

  const requestId = `vapi-${++_videoApiRequestId}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      _videoApiPendingRequests.delete(requestId);
      resolve({ error: 'Timeout — Video Editor antwortet nicht' });
    }, 30000);

    _videoApiPendingRequests.set(requestId, { resolve, timeout });
    mainWindow.webContents.send('video-api:invoke', { requestId, method, args: args || [] });
  });
});

// Response handler from renderer
ipcMain.on('video-api:response', (event, { requestId, result, error }) => {
  const pending = _videoApiPendingRequests.get(requestId);
  if (!pending) return;
  _videoApiPendingRequests.delete(requestId);
  clearTimeout(pending.timeout);
  if (error) {
    pending.resolve({ error });
  } else {
    pending.resolve({ result });
  }
});

// Convenience handlers for each API method (direct IPC channels)
const VIDEO_API_METHODS = [
  'getClips', 'getClip', 'moveClip', 'trimClip', 'splitClip', 'deleteClip', 'duplicateClip',
  'getTracks', 'addTrack', 'removeTrack', 'reorderTracks', 'setTrackProperties',
  'getPlayheadPosition', 'setPlayheadPosition', 'play', 'pause', 'getDuration',
  'goToStart', 'goToEnd', 'setInPoint', 'setOutPoint', 'getInOutPoints', 'zoomTimeline',
  'addEffect', 'removeEffect', 'getEffects', 'addTransition',
  'importMedia', 'getMediaAssets',
  'getToolMode', 'setToolMode',
  'splitAtPlayhead', 'razorAllTracks',
  'rippleDelete', 'ripplePaste',
  'copyClip', 'cutClip', 'pasteClip',
  'selectClip', 'deselectAll', 'getSelection',
  'getCompositions', 'navigateToComposition', 'navigateUp', 'getCompositionPath',
  'getProxyStatus',
  'exportProject',
  'getProjectInfo', 'undo', 'redo',
  'describe',
];

for (const method of VIDEO_API_METHODS) {
  ipcMain.handle(`video-api:${method}`, async (event, ...args) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'Video Editor nicht verfügbar' };
    }

    const requestId = `vapi-${++_videoApiRequestId}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        _videoApiPendingRequests.delete(requestId);
        resolve({ error: 'Timeout — Video Editor antwortet nicht' });
      }, 30000);

      _videoApiPendingRequests.set(requestId, { resolve, timeout });
      mainWindow.webContents.send('video-api:invoke', { requestId, method, args: args || [] });
    });
  });
}

ipcMain.handle('video:get-metadata', async (event, filePath) => {
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];
    execFile(ffprobePath, args, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve({ error: err.message });
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
        const audioStream = (info.streams || []).find(s => s.codec_type === 'audio');
        const duration = parseFloat(info.format?.duration || '0');
        let fps = 30;
        if (videoStream?.r_frame_rate) {
          const parts = videoStream.r_frame_rate.split('/');
          fps = parts.length === 2 ? parseInt(parts[0]) / parseInt(parts[1]) : parseFloat(parts[0]);
          if (!isFinite(fps) || fps <= 0) fps = 30;
        }
        resolve({
          duration,
          width: parseInt(videoStream?.width || '0'),
          height: parseInt(videoStream?.height || '0'),
          fps: Math.round(fps * 100) / 100,
          codec: videoStream?.codec_name || 'unknown',
          hasAudio: !!audioStream,
        });
      } catch (parseErr) {
        resolve({ error: 'Failed to parse ffprobe output' });
      }
    });
  });
});

ipcMain.handle('video:run-ffmpeg', async (event, args) => {
  return new Promise((resolve) => {
    const child = execFile(ffmpegPath, args, { timeout: 600000 }, (err) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      // Determine output path from args (-y is usually followed by output at end)
      const outputPath = args[args.length - 1] || '';
      resolve({ success: true, outputPath });
    });

    // Stream progress back via stderr (FFmpeg writes progress to stderr)
    if (child.stderr) {
      child.stderr.on('data', (data) => {
        const line = data.toString();
        // Parse time= from FFmpeg output for progress
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch && mainWindow && !mainWindow.isDestroyed()) {
          const seconds = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
          mainWindow.webContents.send('video:ffmpeg-progress', { seconds, raw: line.trim() });
        }
      });
    }
  });
});

// --- Proxy System ---

// Active proxy conversions (for cancellation)
const _proxyProcesses = new Map();

ipcMain.handle('proxy:get-root', async (event, projectName) => {
  const docsDir = app.getPath('documents');
  const safeProjectName = (projectName || 'Untitled').replace(/[<>:"/\\|?*]/g, '_').trim();
  const proxyDir = path.join(docsDir, 'Pangea-Proxy', safeProjectName);
  if (!fs.existsSync(proxyDir)) {
    fs.mkdirSync(proxyDir, { recursive: true });
  }
  return proxyDir;
});

ipcMain.handle('proxy:run-ffmpeg', async (event, opts) => {
  const { args, proxyRoot, proxyPath, duration, id } = opts;

  if (!ffmpegPath) {
    return { success: false, error: 'FFmpeg nicht gefunden. Bitte installieren: https://ffmpeg.org/download.html' };
  }

  // Ensure proxy directory exists
  if (proxyRoot && !fs.existsSync(proxyRoot)) {
    fs.mkdirSync(proxyRoot, { recursive: true });
  }

  return new Promise((resolve) => {
    const child = execFile(ffmpegPath, args, { timeout: 1800000 }, (err) => {
      _proxyProcesses.delete(id || proxyPath);
      if (err) {
        // Check if killed (cancelled)
        if (err.killed || err.signal === 'SIGTERM') {
          resolve({ success: false, error: 'Konvertierung abgebrochen' });
        } else {
          resolve({ success: false, error: err.message });
        }
        return;
      }
      resolve({ success: true, proxyPath });
    });

    // Store for potential cancellation
    if (id || proxyPath) {
      _proxyProcesses.set(id || proxyPath, child);
    }

    // Stream proxy progress
    if (child.stderr) {
      child.stderr.on('data', (data) => {
        const line = data.toString();
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch && mainWindow && !mainWindow.isDestroyed()) {
          const seconds = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
          const percent = duration > 0 ? Math.min(100, Math.round((seconds / duration) * 100)) : 0;
          mainWindow.webContents.send('proxy:ffmpeg-progress', {
            id: id || proxyPath,
            seconds,
            percent,
            raw: line.trim(),
          });
        }
      });
    }
  });
});

ipcMain.on('proxy:cancel-ffmpeg', (event, id) => {
  const child = _proxyProcesses.get(id);
  if (child) {
    try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
    _proxyProcesses.delete(id);
  }
});

ipcMain.handle('proxy:check-ffmpeg', async () => {
  return { available: !!ffmpegPath, path: ffmpegPath || null };
});

// --- AI CLI (SAM2 / CoTracker3) ---

ipcMain.handle('ai:spawn-python', async (event, opts) => {
  const { python, script, stdin, timeout = 300000 } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ exitCode: -1, stdout: '', stderr: err.message });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message });
    });

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
});

ipcMain.handle('ai:find-python', async () => {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      const ver = await new Promise((resolve, reject) => {
        execFile(cmd, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout || '');
        });
      });
      const match = ver.match(/Python\s+(\d+)\.(\d+)/);
      if (match && parseInt(match[1]) >= 3 && parseInt(match[2]) >= 10) {
        return cmd;
      }
    } catch (_) { /* try next */ }
  }
  return null;
});


ipcMain.handle('cross:frame-to-image', async (_, { dataUrl, name }) => {
  try {
    const attachDir = path.join(WORKSPACE_ROOT || os.homedir(), '_attachments');
    if (!fs.existsSync(attachDir)) fs.mkdirSync(attachDir, { recursive: true });

    // Save dataUrl as PNG
    const timestamp = Date.now();
    const pngPath = path.join(attachDir, `cross-frame-${timestamp}.png`);
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(pngPath, Buffer.from(base64Data, 'base64'));

    // Notify renderer via IPC
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cross:transfer', {
        target: 'image',
        dataUrl,
        name: name || 'Video Frame',
        filePath: pngPath
      });
    }

    return { success: true, path: pngPath };
  } catch (err) {
    console.error('[cross:frame-to-image]', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ai:route-prompt', async (_, { prompt, context }) => {
  // Simple keyword-based routing (matches ai-assistant.js logic)
  const lower = prompt.toLowerCase();

  const routeKeywords = {
    'image': ['bild', 'image', 'foto', 'photo', 'zeichne', 'draw', 'malen', 'filter', 'crop'],
    'video': ['video', 'schneiden', 'cut', 'trim', 'timeline', 'clip', 'montage', 'render'],
    'terminal': ['code', 'programmier', 'develop', 'bug', 'fix', 'feature', 'test', 'deploy']
  };

  for (const [tab, keywords] of Object.entries(routeKeywords)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return { tab, action: 'open', params: { prompt, context } };
      }
    }
  }

  // Default: ask for clarification, stay in current editor
  return { tab: null, action: 'clarify', params: { prompt, context } };
});

// --- Secrets (DPAPI-encrypted via Windows PowerShell) ---

/**
 * Get a secret from DPAPI storage via PowerShell.
 * Secrets stored in ~/.claude/secrets/*.enc (encrypted)
 * @param {string} secretName e.g., 'LUMAAI_API_KEY'
 * @returns {Promise<string|null>}
 */
async function getSecret(secretName) {
  return new Promise((resolve) => {
    const scriptPath = path.join(os.homedir(), '.claude', 'get-secret.ps1');
    if (!fs.existsSync(scriptPath)) {
      resolve(null);
      return;
    }

    execFile('powershell', [scriptPath, secretName], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const secret = stdout.trim();
      resolve(secret || null);
    });
  });
}

/**
 * Store a secret in DPAPI via PowerShell.
 * Prompts user for confirmation in interactive mode.
 * For non-interactive use, pass value directly.
 * @param {string} secretName
 * @param {string} secretValue
 * @returns {Promise<boolean>} success
 */
async function storeSecret(secretName, secretValue) {
  return new Promise((resolve) => {
    const scriptPath = path.join(os.homedir(), '.claude', 'store-secret.ps1');
    if (!fs.existsSync(scriptPath)) {
      resolve(false);
      return;
    }

    // Use PowerShell to securely store secret
    const cmd = `"${secretValue}" | & "${scriptPath}" "${secretName}"`;
    execFile('powershell', ['-NoProfile', '-Command', cmd], { timeout: 10000 }, (err) => {
      resolve(!err);
    });
  });
}

ipcMain.handle('secret:get', async (_, secretName) => {
  return getSecret(secretName);
});

ipcMain.handle('secret:set', async (_, secretName, secretValue) => {
  return storeSecret(secretName, secretValue);
});

// --- Dictation IPC (legacy, now handled by Web Speech API in renderer) ---
// Kept as no-op stubs in case preload bridge is still called
ipcMain.handle('dictation:start', () => true);
ipcMain.handle('dictation:stop', () => true);

// --- Skills Manager IPC ---
const { listAllSkills, toggleSkill, toggleCategory, syncToggles } = require('./skills-manager');

ipcMain.handle('skills:list', () => {
  return { skills: listAllSkills() };
});

ipcMain.on('skills:toggle', (_, { name, enabled }) => {
  const result = toggleSkill(name, enabled);
  if (result.success && mainWindow) {
    mainWindow.webContents.send('skills:updated', { skills: listAllSkills() });
  }
});

ipcMain.on('skills:toggle-category', (_, { project, type, enabled }) => {
  toggleCategory(project, type, enabled);
  if (mainWindow) {
    mainWindow.webContents.send('skills:updated', { skills: listAllSkills() });
  }
});

ipcMain.handle('skills:sync', () => {
  return syncToggles();
});

// --- OpenCode & Claude Chat IPC ---
// Token wird NUR im Main-Prozess verwaltet, Renderer sieht ihn nie.
const { zenChatStream, fetchModels, openAuthPage } = require('./opencode-api');
const { claudeChatStream } = require('./claude-api');
const { geminiChatStream, geminiChatStreamOAuth, listGeminiModels, FREE_GEMINI_MODELS } = require('./gemini-api');
const { vertexClaudeChatStream, testVertexAccess, CLAUDE_VERTEX_MODELS } = require('./vertex-claude');

let activeAbortFn = null;
let _opencodeToken = null;

// Token aus opencode auth.json lesen (nach opencode CLI Login)
function _readOpenCodeToken() {
  const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  try {
    const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    return data?.opencode?.key || null;
  } catch { return null; }
}

// Token beim Start laden
_opencodeToken = _readOpenCodeToken();

ipcMain.on('opencode:login', (event) => {
  // Fallback: Poll auth.json für den Fall dass der Token extern gesetzt wird
  const oldToken = _opencodeToken;
  const interval = setInterval(() => {
    const token = _readOpenCodeToken();
    if (token && token !== oldToken) {
      _opencodeToken = token;
      clearInterval(interval);
      if (!event.sender.isDestroyed()) {
        event.sender.send('opencode:auth-complete', { success: true });
      }
    }
  }, 1500);
  setTimeout(() => { clearInterval(interval); }, 180000);
});

// OAuth Code → Token Exchange (opencode.ai auth flow)
ipcMain.handle('opencode:exchangeCode', async (_, code) => {
  if (!code) return { error: 'No code' };
  const postData = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent('https://opencode.ai/auth/callback')}&client_id=app`;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'auth.opencode.ai', port: 443, path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            _opencodeToken = json.access_token;
            // Persist to auth.json
            const authDir = path.join(os.homedir(), '.local', 'share', 'opencode');
            if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
            const authPath = path.join(authDir, 'auth.json');
            let existing = {};
            try { existing = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch {}
            existing.opencode = { type: 'api', key: json.access_token };
            fs.writeFileSync(authPath, JSON.stringify(existing, null, 2), 'utf8');
            resolve({ token: json.access_token });
          } else {
            resolve({ error: json.error_description || json.error || 'Token exchange failed' });
          }
        } catch (e) { resolve({ error: 'Parse error: ' + data.slice(0, 100) }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.write(postData);
    req.end();
  });
});

ipcMain.handle('opencode:isAuthenticated', async () => {
  if (!_opencodeToken) _opencodeToken = _readOpenCodeToken();
  return !!_opencodeToken;
});

// Save token directly (from manual paste or CLI redirect)
ipcMain.handle('opencode:saveToken', async (_, token) => {
  if (!token) return false;
  _opencodeToken = token;
  // Write to auth.json so it persists
  const authDir = path.join(os.homedir(), '.local', 'share', 'opencode');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  const authPath = path.join(authDir, 'auth.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch {}
  existing.opencode = { type: 'api', key: token };
  fs.writeFileSync(authPath, JSON.stringify(existing, null, 2), 'utf8');
  return true;
});

ipcMain.handle('opencode:auth-status', async () => {
  if (!_opencodeToken) _opencodeToken = _readOpenCodeToken();
  if (!_opencodeToken) return { connected: false };
  try {
    const models = await fetchModels(_opencodeToken);
    return { connected: true, modelCount: models.length };
  } catch (err) { return { connected: false, error: err.message }; }
});

ipcMain.handle('opencode:models', async () => {
  if (!_opencodeToken) _opencodeToken = _readOpenCodeToken();
  if (!_opencodeToken) return { models: [], error: 'Nicht eingeloggt' };
  try {
    const models = await fetchModels(_opencodeToken);
    return { models };
  } catch (err) { return { models: [], error: err.message }; }
});

ipcMain.on('opencode:chat', (event, { model, messages }) => {
  if (!_opencodeToken) { event.sender.send('opencode:chat-stream', { type: 'error', message: 'Nicht eingeloggt' }); return; }
  if (activeAbortFn) { activeAbortFn(); activeAbortFn = null; }
  activeAbortFn = zenChatStream(model, messages, _opencodeToken, {
    onChunk: (text) => { if (!event.sender.isDestroyed()) event.sender.send('opencode:chat-stream', { type: 'chunk', text }); },
    onDone: () => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('opencode:chat-stream', { type: 'done' }); },
    onError: (err) => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('opencode:chat-stream', { type: 'error', message: err.message }); },
  });
});

ipcMain.on('claude:chat', async (event, { model, messages, apiKey, system }) => {
  if (activeAbortFn) { activeAbortFn(); activeAbortFn = null; }

  // Resolve API key: explicit > subscription token > DPAPI secret
  let resolvedKey = apiKey;
  // Try Claude subscription token from .credentials.json (Claude Code login)
  if (!resolvedKey) {
    try {
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      if (creds?.claudeAiOauth?.accessToken) resolvedKey = creds.claudeAiOauth.accessToken;
    } catch {}
  }
  if (!resolvedKey) {
    if (!event.sender.isDestroyed()) event.sender.send('claude:chat-stream', { type: 'error', message: 'No Claude credentials found. Log into Claude Code first.' });
    return;
  }

  activeAbortFn = claudeChatStream(model, messages, resolvedKey, {
    system,
    onChunk: (text) => { if (!event.sender.isDestroyed()) event.sender.send('claude:chat-stream', { type: 'chunk', text }); },
    onDone: () => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('claude:chat-stream', { type: 'done' }); },
    onError: (err) => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('claude:chat-stream', { type: 'error', message: err.message }); },
  });
});

ipcMain.on('opencode:abort', () => { if (activeAbortFn) { activeAbortFn(); activeAbortFn = null; } });

// --- Gemini Free Tier Chat (Google OAuth2 Multi-Account + API key) ---
// Google OAuth client credentials for Gemini API access
// Users: Create your own at https://console.cloud.google.com/apis/credentials
// Select "Desktop App" type, enable "Generative Language API"
const GOOGLE_AI_CLIENT_ID = process.env.GOOGLE_AI_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
const GOOGLE_AI_CLIENT_SECRET = process.env.GOOGLE_AI_CLIENT_SECRET || 'YOUR_GOOGLE_CLIENT_SECRET';
const GOOGLE_AI_SCOPES = 'https://www.googleapis.com/auth/cloud-platform openid email profile';

// Local OAuth callback server (loopback redirect for Electron)
const http = require('http');
let _oauthCallbackServer = null;

ipcMain.handle('gemini:startOAuthServer', () => {
  return new Promise((resolve) => {
    if (_oauthCallbackServer) { try { _oauthCallbackServer.close(); } catch {} }
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (code) {
        res.end('<html><body style="background:#1e1e2e;color:#cdd6f4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Connected!</h2><p>You can close this window.</p></div></body></html>');
        // Send code to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('gemini:oauth-code', code);
        }
      } else {
        res.end('<html><body style="background:#1e1e2e;color:#f38ba8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div><h2>Error</h2><p>' + (error || 'Unknown error') + '</p></div></body></html>');
      }
      setTimeout(() => { try { server.close(); } catch {} }, 2000);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      _oauthCallbackServer = server;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
        + '?client_id=' + encodeURIComponent(GOOGLE_AI_CLIENT_ID)
        + '&redirect_uri=' + encodeURIComponent('http://127.0.0.1:' + port)
        + '&response_type=code'
        + '&scope=' + encodeURIComponent(GOOGLE_AI_SCOPES)
        + '&access_type=offline'
        + '&prompt=consent';
      resolve({ port, authUrl });
    });
    server.on('error', () => resolve({ port: 0, authUrl: '' }));
  });
});
const GEMINI_TOKEN_FILE = path.join(CLAUDE_DIR, 'pangea-gemini-accounts.json');

let _geminiApiKey = null;
// Multi-account: array of { email, accessToken, refreshToken, exhaustedUntil }
let _geminiAccounts = [];
let _activeAccountIdx = 0;

function _getActiveAccount() {
  if (_geminiAccounts.length === 0) return null;
  // Skip exhausted accounts
  const now = Date.now();
  for (let i = 0; i < _geminiAccounts.length; i++) {
    const idx = (_activeAccountIdx + i) % _geminiAccounts.length;
    const acc = _geminiAccounts[idx];
    if (!acc.exhaustedUntil || acc.exhaustedUntil < now) {
      _activeAccountIdx = idx;
      return acc;
    }
  }
  return null; // All exhausted
}

function _rotateToNextAccount() {
  if (_geminiAccounts.length <= 1) return null;
  const now = Date.now();
  // Mark current as exhausted for 60 min
  if (_geminiAccounts[_activeAccountIdx]) {
    _geminiAccounts[_activeAccountIdx].exhaustedUntil = now + 60 * 60 * 1000;
    _saveGeminiAccounts();
  }
  for (let i = 1; i < _geminiAccounts.length; i++) {
    const idx = (_activeAccountIdx + i) % _geminiAccounts.length;
    const acc = _geminiAccounts[idx];
    if (!acc.exhaustedUntil || acc.exhaustedUntil < now) {
      _activeAccountIdx = idx;
      return acc;
    }
  }
  return null; // All exhausted
}

function _saveGeminiAccounts() {
  try {
    fs.writeFileSync(GEMINI_TOKEN_FILE, JSON.stringify({
      accounts: _geminiAccounts.map(a => ({
        email: a.email, accessToken: a.accessToken,
        refreshToken: a.refreshToken, exhaustedUntil: a.exhaustedUntil || 0,
      })),
      activeIdx: _activeAccountIdx,
    }));
  } catch {}
}
function _loadGeminiAccounts() {
  try {
    if (fs.existsSync(GEMINI_TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(GEMINI_TOKEN_FILE, 'utf-8'));
      // Migration from single-account format
      if (data.accessToken && !data.accounts) {
        _geminiAccounts = [{ email: 'account-1', accessToken: data.accessToken, refreshToken: data.refreshToken }];
        _activeAccountIdx = 0;
        _saveGeminiAccounts();
        return true;
      }
      _geminiAccounts = data.accounts || [];
      _activeAccountIdx = data.activeIdx || 0;
      if (_activeAccountIdx >= _geminiAccounts.length) _activeAccountIdx = 0;
      return _geminiAccounts.length > 0;
    }
  } catch {}
  return false;
}

// Refresh a specific account's access token
function _refreshAccountToken(account) {
  return new Promise((resolve) => {
    if (!account.refreshToken) { resolve(false); return; }
    const postData = `client_id=${encodeURIComponent(GOOGLE_AI_CLIENT_ID)}&client_secret=${encodeURIComponent(GOOGLE_AI_CLIENT_SECRET)}&refresh_token=${encodeURIComponent(account.refreshToken)}&grant_type=refresh_token`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com', port: 443, path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.access_token) {
            account.accessToken = data.access_token;
            _saveGeminiAccounts();
            resolve(true);
          } else { resolve(false); }
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.write(postData);
    req.end();
  });
}

// Get user email from access token
function _getGoogleEmail(accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.googleapis.com', port: 443,
      path: '/oauth2/v2/userinfo', method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body).email || 'unknown'); } catch { resolve('unknown'); }
      });
    });
    req.on('error', () => resolve('unknown'));
    req.end();
  });
}

// Get dynamic model list (fallback to static if unavailable)
ipcMain.handle('gemini:models', async () => {
  const acc = _getActiveAccount();
  const token = _geminiApiKey || acc?.accessToken;
  if (!token) return FREE_GEMINI_MODELS;
  try {
    const discovered = await listGeminiModels(token, !!_geminiApiKey);
    if (discovered.length > 0) return discovered;
  } catch {}
  return FREE_GEMINI_MODELS;
});

ipcMain.handle('gemini:isAuthenticated', async () => {
  if (_geminiApiKey) return true;
  // Check for auto-generated API key in persisted file
  if (!_geminiApiKey) {
    try {
      const stored = JSON.parse(fs.readFileSync(GEMINI_TOKEN_FILE, 'utf-8'));
      if (stored.geminiApiKey) { _geminiApiKey = stored.geminiApiKey; return true; }
    } catch {}
  }
  if (_geminiAccounts.length > 0 && _getActiveAccount()?.accessToken) return true;
  // Try loading persisted accounts (also loads API key)
  if (_loadGeminiAccounts()) {
    // Check stored key after load
    try {
      const stored = JSON.parse(fs.readFileSync(GEMINI_TOKEN_FILE, 'utf-8'));
      if (stored.geminiApiKey) { _geminiApiKey = stored.geminiApiKey; return true; }
    } catch {}
    const acc = _getActiveAccount();
    if (acc) {
      if (await _refreshAccountToken(acc)) return true;
    }
  }
  return false;
});

// List connected Google accounts
ipcMain.handle('gemini:listAccounts', () => {
  return _geminiAccounts.map((a, i) => ({
    email: a.email,
    active: i === _activeAccountIdx,
    exhausted: a.exhaustedUntil ? a.exhaustedUntil > Date.now() : false,
  }));
});

// Remove a Google account
ipcMain.handle('gemini:removeAccount', (_, email) => {
  _geminiAccounts = _geminiAccounts.filter(a => a.email !== email);
  if (_activeAccountIdx >= _geminiAccounts.length) _activeAccountIdx = 0;
  _saveGeminiAccounts();
  return { success: true, remaining: _geminiAccounts.length };
});

// Legacy compat
ipcMain.handle('gemini:saveCookies', async () => true);
ipcMain.handle('gemini:extractCookies', async () => {
  const acc = _getActiveAccount();
  return acc ? { success: true, hasToken: true } : { success: false };
});

// OAuth2 code exchange — adds a new account or refreshes existing
ipcMain.handle('gemini:exchangeCode', async (_, codeOrObj) => {
  // Accept either a plain code string or { code, redirectUri } object
  const code = typeof codeOrObj === 'string' ? codeOrObj : codeOrObj.code;
  const redirectUri = (typeof codeOrObj === 'object' && codeOrObj.redirectUri) || 'urn:ietf:wg:oauth:2.0:oob';
  return new Promise((resolve) => {
    const postData = `code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(GOOGLE_AI_CLIENT_ID)}&client_secret=${encodeURIComponent(GOOGLE_AI_CLIENT_SECRET)}&redirect_uri=${encodeURIComponent(redirectUri)}&grant_type=authorization_code`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com', port: 443, path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (data.access_token) {
            // Get email to identify account
            const email = await _getGoogleEmail(data.access_token);
            // Check if account already exists — update it
            const existing = _geminiAccounts.findIndex(a => a.email === email);
            if (existing >= 0) {
              _geminiAccounts[existing].accessToken = data.access_token;
              if (data.refresh_token) _geminiAccounts[existing].refreshToken = data.refresh_token;
              _geminiAccounts[existing].exhaustedUntil = 0;
              _activeAccountIdx = existing;
            } else {
              // New account
              _geminiAccounts.push({
                email, accessToken: data.access_token,
                refreshToken: data.refresh_token || null, exhaustedUntil: 0,
              });
              _activeAccountIdx = _geminiAccounts.length - 1;
            }
            _saveGeminiAccounts();
            // Auto-generate Gemini API key in background (non-blocking)
            _autoGenerateGeminiApiKey(data.access_token).catch(() => {});
            resolve({ success: true, email, totalAccounts: _geminiAccounts.length });
          } else {
            resolve({ success: false, error: data.error_description || data.error || 'token exchange failed' });
          }
        } catch (e) { resolve({ success: false, error: e.message }); }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.write(postData);
    req.end();
  });
});

// --- Auto Gemini API Key Generation (after Google OAuth) ---
// Uses the OAuth token to auto-create a Gemini API key in the user's GCP project
async function _autoGenerateGeminiApiKey(accessToken) {
  if (_geminiApiKey) return; // Already have a key
  // Check if we already stored one
  try {
    const stored = JSON.parse(fs.readFileSync(GEMINI_TOKEN_FILE, 'utf-8'));
    if (stored.geminiApiKey) { _geminiApiKey = stored.geminiApiKey; return; }
  } catch {}

  try {
    // 1. Find a GCP project
    const projects = await _httpJson('GET', 'cloudresourcemanager.googleapis.com', '/v1/projects', null, accessToken);
    const activeProjects = (projects.projects || []).filter(p => p.lifecycleState === 'ACTIVE');
    if (activeProjects.length === 0) { console.log('[AutoKey] No GCP projects found'); return; }
    // Prefer a project with "gemini" or "gen-lang" in the name
    const geminiProject = activeProjects.find(p => /gemini|gen-lang/i.test(p.projectId)) || activeProjects[0];
    const projectId = geminiProject.projectId;
    console.log('[AutoKey] Using project:', projectId);

    // 2. Enable required APIs
    await _httpJson('POST', 'serviceusage.googleapis.com', `/v1/projects/${projectId}/services/generativelanguage.googleapis.com:enable`, '', accessToken);
    await _httpJson('POST', 'serviceusage.googleapis.com', `/v1/projects/${projectId}/services/apikeys.googleapis.com:enable`, '', accessToken);
    // Wait for API enablement to propagate
    await new Promise(r => setTimeout(r, 3000));

    // 3. Create API key restricted to Gemini
    const keyBody = { displayName: 'Pangea-Gemini-Auto', restrictions: { apiTargets: [{ service: 'generativelanguage.googleapis.com' }] } };
    const op = await _httpJson('POST', 'apikeys.googleapis.com', `/v2/projects/${projectId}/locations/global/keys`, keyBody, accessToken, projectId);
    if (!op.name) { console.log('[AutoKey] Key creation failed:', JSON.stringify(op).slice(0, 200)); return; }

    // 4. Poll operation until done
    let opResult = op;
    for (let i = 0; i < 15; i++) {
      if (opResult.done) break;
      await new Promise(r => setTimeout(r, 2000));
      opResult = await _httpJson('GET', 'apikeys.googleapis.com', `/v2/${op.name}`, null, accessToken, projectId);
    }
    if (!opResult.done || !opResult.response?.name) { console.log('[AutoKey] Operation timed out'); return; }

    // 5. Get the actual key string
    const keyData = await _httpJson('GET', 'apikeys.googleapis.com', `/v2/${opResult.response.name}/keyString`, null, accessToken, projectId);
    if (keyData.keyString) {
      _geminiApiKey = keyData.keyString;
      // Persist alongside accounts
      try {
        const stored = JSON.parse(fs.readFileSync(GEMINI_TOKEN_FILE, 'utf-8'));
        stored.geminiApiKey = keyData.keyString;
        stored.geminiProject = projectId;
        fs.writeFileSync(GEMINI_TOKEN_FILE, JSON.stringify(stored, null, 2));
      } catch {}
      console.log('[AutoKey] Gemini API key created and saved');
    }
  } catch (e) {
    console.log('[AutoKey] Failed:', e.message);
  }
}

// Generic HTTPS JSON helper
function _httpJson(method, hostname, urlPath, body, token, quotaProject) {
  return new Promise((resolve, reject) => {
    const headers = { 'Authorization': `Bearer ${token}` };
    if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json';
    if (quotaProject) headers['x-goog-user-project'] = quotaProject;
    const reqBody = body && typeof body === 'object' ? JSON.stringify(body) : (body || '');
    const req = https.request({ hostname, port: 443, path: urlPath, method, headers }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d, _status: res.statusCode }); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

// Save access token directly
ipcMain.handle('gemini:saveToken', async (_, tokenData) => {
  const email = tokenData.email || 'direct-token';
  const existing = _geminiAccounts.findIndex(a => a.email === email);
  if (existing >= 0) {
    _geminiAccounts[existing].accessToken = tokenData.accessToken;
    if (tokenData.refreshToken) _geminiAccounts[existing].refreshToken = tokenData.refreshToken;
  } else {
    _geminiAccounts.push({ email, accessToken: tokenData.accessToken, refreshToken: tokenData.refreshToken });
  }
  _saveGeminiAccounts();
  return { success: true };
});

ipcMain.on('gemini:chat', async (event, { model, messages }) => {
  if (activeAbortFn) { activeAbortFn(); activeAbortFn = null; }

  const makeHandlers = (acc) => ({
    onChunk: (text) => { if (!event.sender.isDestroyed()) event.sender.send('gemini:chat-stream', { type: 'chunk', text }); },
    onDone: () => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('gemini:chat-stream', { type: 'done' }); },
    onError: async (err) => {
      const msg = err.message || '';
      // Rate limited / exhausted — rotate to next account
      if (msg.includes('429') || msg.includes('TOKENS_EXHAUSTED')) {
        if (acc) acc.exhaustedUntil = Date.now() + 60 * 60 * 1000;
        _saveGeminiAccounts();
        const nextAcc = _rotateToNextAccount();
        if (nextAcc) {
          // Notify renderer about account switch
          if (!event.sender.isDestroyed()) event.sender.send('gemini:chat-stream', { type: 'account-switch', email: nextAcc.email });
          activeAbortFn = geminiChatStreamOAuth(model, messages, nextAcc.accessToken, makeHandlers(nextAcc));
          return;
        }
      }
      // Auth expired — try refresh, then rotate
      if (msg === 'GOOGLE_AUTH_EXPIRED' && acc?.refreshToken) {
        const refreshed = await _refreshAccountToken(acc);
        if (refreshed) {
          activeAbortFn = geminiChatStreamOAuth(model, messages, acc.accessToken, makeHandlers(acc));
          return;
        }
        // Refresh failed — try next account
        const nextAcc = _rotateToNextAccount();
        if (nextAcc) {
          activeAbortFn = geminiChatStreamOAuth(model, messages, nextAcc.accessToken, makeHandlers(nextAcc));
          return;
        }
      }
      activeAbortFn = null;
      if (!event.sender.isDestroyed()) event.sender.send('gemini:chat-stream', { type: 'error', message: msg });
    },
  });

  // Prefer API key, then multi-account OAuth
  if (_geminiApiKey) {
    activeAbortFn = geminiChatStream(model, messages, _geminiApiKey, makeHandlers(null));
  } else {
    let acc = _getActiveAccount();
    if (!acc && _loadGeminiAccounts()) acc = _getActiveAccount();
    if (acc) {
      activeAbortFn = geminiChatStreamOAuth(model, messages, acc.accessToken, makeHandlers(acc));
    } else {
      if (!event.sender.isDestroyed()) event.sender.send('gemini:chat-stream', { type: 'error', message: 'Not logged in to Google. Use the Gemini toggle to connect.' });
    }
  }
});

// --- Vertex AI Claude (Claude via Google Login, no Anthropic key needed) ---
ipcMain.handle('vertex:claude-models', () => CLAUDE_VERTEX_MODELS);

ipcMain.handle('vertex:test-access', async () => {
  const acc = _getActiveAccount();
  if (!acc?.accessToken) return { available: false, reason: 'no_google_token' };
  return testVertexAccess(acc.accessToken);
});

ipcMain.on('vertex:claude-chat', async (event, { model, messages }) => {
  if (activeAbortFn) { activeAbortFn(); activeAbortFn = null; }

  const acc = _getActiveAccount();
  if (!acc?.accessToken) {
    if (!event.sender.isDestroyed()) event.sender.send('vertex:claude-stream', { type: 'error', message: 'Not logged in to Google.' });
    return;
  }

  const makeHandlers = (account) => ({
    onChunk: (text) => { if (!event.sender.isDestroyed()) event.sender.send('vertex:claude-stream', { type: 'chunk', text }); },
    onDone: () => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('vertex:claude-stream', { type: 'done' }); },
    onError: async (err) => {
      const msg = err.message || '';
      // Rate limited — rotate account
      if (msg.includes('429') || msg.includes('TOKENS_EXHAUSTED')) {
        if (account) account.exhaustedUntil = Date.now() + 60 * 60 * 1000;
        _saveGeminiAccounts();
        const next = _rotateToNextAccount();
        if (next) {
          activeAbortFn = vertexClaudeChatStream(model, messages, next.accessToken, makeHandlers(next));
          return;
        }
      }
      // Auth expired — refresh
      if (msg === 'GOOGLE_AUTH_EXPIRED' && account?.refreshToken) {
        if (await _refreshAccountToken(account)) {
          activeAbortFn = vertexClaudeChatStream(model, messages, account.accessToken, makeHandlers(account));
          return;
        }
      }
      activeAbortFn = null;
      if (!event.sender.isDestroyed()) event.sender.send('vertex:claude-stream', { type: 'error', message: msg });
    },
  });

  activeAbortFn = vertexClaudeChatStream(model, messages, acc.accessToken, makeHandlers(acc));
});

// --- Claude Credentials (subscription OAuth) ---
ipcMain.handle('claude:readCredentials', async () => {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const data = JSON.parse(await fs.promises.readFile(credPath, 'utf8'));
    if (data.claudeAiOauth?.accessToken) {
      return { accessToken: data.claudeAiOauth.accessToken };
    }
  } catch {}
  return null;
});

// --- Generic JSON Read/Write IPC ---

ipcMain.handle('readJSON', async (_, filename) => {
  const fpath = path.join(os.homedir(), '.claude', filename);
  try { return JSON.parse(await fs.promises.readFile(fpath, 'utf8')); } catch { return null; }
});

ipcMain.handle('writeJSON', async (_, filename, data) => {
  const fpath = path.join(os.homedir(), '.claude', filename);
  await fs.promises.writeFile(fpath, JSON.stringify(data, null, 2), 'utf8');
});

// Read OpenCode auth token from ~/.local/share/opencode/auth.json
ipcMain.handle('opencode:readToken', async () => {
  const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  try {
    const data = JSON.parse(await fs.promises.readFile(authPath, 'utf8'));
    return data?.opencode?.key || null;
  } catch { return null; }
});


// Helper: download URL to file
function _downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? require('https') : require('http');
    const file = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        _downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

// --- MCP Management IPC ---

ipcMain.handle('mcp:list', async () => {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'));
    const servers = settings.mcpServers || {};
    // Load toggle state
    const togglesPath = path.join(os.homedir(), '.claude', 'mcp-toggles.json');
    let toggles = {};
    try { toggles = JSON.parse(await fs.promises.readFile(togglesPath, 'utf8')); } catch { /* no toggles yet */ }
    return Object.keys(servers).map(name => ({
      name,
      enabled: toggles[name] !== undefined ? toggles[name] : true,
      command: servers[name].command || null,
    }));
  } catch { return []; }
});

ipcMain.handle('mcp:toggle', async (_, name, enabled) => {
  const togglesPath = path.join(os.homedir(), '.claude', 'mcp-toggles.json');
  let toggles = {};
  try { toggles = JSON.parse(await fs.promises.readFile(togglesPath, 'utf8')); } catch { /* fresh */ }
  toggles[name] = enabled;
  await fs.promises.writeFile(togglesPath, JSON.stringify(toggles, null, 2), 'utf8');
  return { success: true };
});

// --- App Lifecycle ---

async function init() {
  instanceId = crypto.randomUUID();

  // First-Run: ask for workspace folder if not configured
  if (!WORKSPACE_ROOT) {
    const result = await dialog.showOpenDialog({
      title: 'Pangea CLI — Projektordner wählen',
      message: 'Wähle deinen Hauptordner (z.B. wo deine Claude-Projekte liegen):',
      properties: ['openDirectory'],
      defaultPath: os.homedir()
    });

    if (result.canceled || !result.filePaths[0]) {
      // Use home directory as fallback
      WORKSPACE_ROOT = os.homedir();
    } else {
      WORKSPACE_ROOT = result.filePaths[0];
    }
    saveWorkspaceRoot(WORKSPACE_ROOT);

    // Create _needs/ folder for the new workspace
    const needsDir = path.join(WORKSPACE_ROOT, '_needs');
    if (!fs.existsSync(needsDir)) {
      fs.mkdirSync(needsDir, { recursive: true });
      fs.writeFileSync(path.join(needsDir, 'INDEX.txt'),
        'Was fehlt noch — Zentrale Uebersicht\n' +
        '=====================================\n\n' +
        'Hier werden alle offenen Punkte, fehlende Infos und TODOs gesammelt.\n' +
        'Pro Thema eine eigene .txt Datei anlegen.\n', 'utf-8');
    }
  }

  createWindow();
  spawnDefaultTerminal();
  watchSidebar();
  watchSessionFiles();

  // Auto-refresh Google OAuth token on startup
  _onetorule.ensureTokensFresh().then((result) => {
    if (result.refreshed) {
      console.log('[Startup] Google token refreshed for', result.email);
    } else if (result.reason === 'no-refresh-token' || result.reason === 'no-file') {
      console.log('[Startup] No Google login found — user needs to OneToRule login');
    } else if (result.reason === 'refresh-failed') {
      console.log('[Startup] Google token refresh failed:', result.error, '— user needs to re-login');
    } else if (result.reason === 'token-fresh') {
      console.log('[Startup] Google token still fresh (' + result.ageMin + 'min old)');
    }
    // Notify renderer about auth state
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('onetorule:startup-status', result);
    }
  }).catch((err) => {
    console.log('[Startup] Token check error:', err.message);
  });
}

// --- OneToRule Login (1 Login → alle Modelle) ---
const { OneToRuleLogin } = require('./onetorule');
const _onetorule = new OneToRuleLogin();

ipcMain.handle('onetorule:status', async () => {
  const existing = await _onetorule._checkExisting();
  return { ...existing, providers: _onetorule.getStatus() };
});

ipcMain.handle('onetorule:login', async (event) => {
  _onetorule.onProgress((p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('onetorule:progress', p);
    }
  });
  return await _onetorule.login();
});

ipcMain.handle('onetorule:refresh', async () => {
  return await _onetorule.refreshAccessToken();
});

ipcMain.handle('onetorule:ensure-fresh', async () => {
  return await _onetorule.ensureTokensFresh();
});

ipcMain.handle('onetorule:get-token', async () => {
  return await _onetorule.getAccessToken();
});

// --- Kairos Always-On Agent IPC ---
const kairos = require('./kairos-agent');
const _kairos = kairos.getInstance();

// Auto-start Kairos with default watchers
_kairos.addDefaultWatchers();
_kairos.start();

// Forward notifications to renderer
_kairos.onNotification((notification) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('kairos:notification', notification);
  }
});

ipcMain.handle('kairos:state', () => _kairos.getState());
ipcMain.handle('kairos:notifications', (_, unreadOnly) => _kairos.getNotifications(unreadOnly));
ipcMain.handle('kairos:markRead', (_, index) => { _kairos.markRead(index); return { success: true }; });
ipcMain.handle('kairos:markAllRead', () => { _kairos.markAllRead(); return { success: true }; });
ipcMain.handle('kairos:dream', () => _kairos.triggerDream());
ipcMain.handle('kairos:addTask', (_, task) => {
  const id = _kairos.addTask(task);
  return { success: true, taskId: id };
});
ipcMain.handle('kairos:addWatcher', (_, { name, command }) => {
  _kairos.addWatcher(name, () => new Promise((resolve) => {
    exec(command, { timeout: 10000 }, (err, stdout) => {
      resolve({ output: stdout?.trim(), error: err?.message });
    });
  }));
  return { success: true };
});
ipcMain.handle('kairos:removeWatcher', (_, name) => { _kairos.removeWatcher(name); return { success: true }; });

// --- OpenAI / Codex (GPT-5.4, o-series) IPC ---
const openaiApi = require('./openai-api');

let _openaiApiKey = null;

ipcMain.handle('openai:isAuthenticated', async () => {
  if (_openaiApiKey) return true;
  try { _openaiApiKey = await getSecret('OPENAI_API_KEY'); } catch {}
  return !!_openaiApiKey;
});

ipcMain.handle('openai:models', async () => {
  if (!_openaiApiKey) try { _openaiApiKey = await getSecret('OPENAI_API_KEY'); } catch {}
  if (!_openaiApiKey) return [];
  try { return await openaiApi.listModels(_openaiApiKey); } catch { return []; }
});

ipcMain.handle('openai:saveKey', async (_, key) => {
  _openaiApiKey = key;
  return { success: true };
});

ipcMain.on('openai:chat', (event, { model, messages, system }) => {
  if (!_openaiApiKey) { event.sender.send('openai:chat-stream', { type: 'error', message: 'No OpenAI API key' }); return; }
  if (activeAbortFn) { activeAbortFn(); activeAbortFn = null; }
  activeAbortFn = openaiApi.openaiChatStream(model, messages, _openaiApiKey, {
    system,
    onChunk: (text) => { if (!event.sender.isDestroyed()) event.sender.send('openai:chat-stream', { type: 'chunk', text }); },
    onDone: () => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('openai:chat-stream', { type: 'done' }); },
    onError: (err) => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('openai:chat-stream', { type: 'error', message: err.message }); },
  });
});

// --- Perplexity (Web-Research mit Quellen) IPC ---
const perplexityApi = require('./perplexity-api');
let _perplexityApiKey = null;

ipcMain.handle('perplexity:isAuthenticated', async () => {
  if (_perplexityApiKey) return true;
  try { _perplexityApiKey = await getSecret('PERPLEXITY_API_KEY'); } catch {}
  return !!_perplexityApiKey;
});

ipcMain.handle('perplexity:saveKey', (_, key) => { _perplexityApiKey = key; return { success: true }; });
ipcMain.handle('perplexity:models', () => perplexityApi.PERPLEXITY_MODELS);

ipcMain.handle('perplexity:search', async (_, { query, model, system }) => {
  if (!_perplexityApiKey) return { error: 'No Perplexity API key' };
  try { return await perplexityApi.perplexitySearch(query, _perplexityApiKey, { model, system }); }
  catch (err) { return { error: err.message }; }
});

ipcMain.on('perplexity:chat', (event, { model, messages, system }) => {
  if (!_perplexityApiKey) { event.sender.send('perplexity:chat-stream', { type: 'error', message: 'No Perplexity API key' }); return; }
  if (activeAbortFn) { activeAbortFn(); activeAbortFn = null; }
  activeAbortFn = perplexityApi.perplexityChatStream(model, messages, _perplexityApiKey, {
    system,
    onChunk: (text) => { if (!event.sender.isDestroyed()) event.sender.send('perplexity:chat-stream', { type: 'chunk', text }); },
    onDone: () => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('perplexity:chat-stream', { type: 'done' }); },
    onError: (err) => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('perplexity:chat-stream', { type: 'error', message: err.message }); },
  });
});

// --- Manus (Autonomous Agent Platform) IPC ---
const manusApi = require('./manus-api');
let _manusApiKey = null;

ipcMain.handle('manus:isAuthenticated', async () => {
  if (_manusApiKey) return true;
  try { _manusApiKey = await getSecret('MANUS_API_KEY'); } catch {}
  return !!_manusApiKey;
});

ipcMain.handle('manus:saveKey', (_, key) => { _manusApiKey = key; return { success: true }; });

ipcMain.handle('manus:createTask', async (_, { task, model }) => {
  if (!_manusApiKey) return { error: 'No Manus API key' };
  try { return await manusApi.manusCreateTask(task, _manusApiKey, { model }); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('manus:getTask', async (_, taskId) => {
  if (!_manusApiKey) return { error: 'No Manus API key' };
  try { return await manusApi.manusGetTask(taskId, _manusApiKey); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('manus:listTasks', async () => {
  if (!_manusApiKey) return [];
  try { return await manusApi.manusListTasks(_manusApiKey); }
  catch { return []; }
});

// --- MiniMax M2.5 (Opus-Level, 1/20 Kosten) IPC ---
const minimaxApi = require('./minimax-api');
let _minimaxApiKey = null;

ipcMain.handle('minimax:isAuthenticated', async () => {
  if (_minimaxApiKey) return true;
  try { _minimaxApiKey = await getSecret('MINIMAX_API_KEY'); } catch {}
  return !!_minimaxApiKey;
});

ipcMain.handle('minimax:saveKey', (_, key) => { _minimaxApiKey = key; return { success: true }; });

ipcMain.on('minimax:chat', (event, { model, messages, system }) => {
  if (!_minimaxApiKey) { event.sender.send('minimax:chat-stream', { type: 'error', message: 'No MiniMax API key' }); return; }
  if (activeAbortFn) { activeAbortFn(); activeAbortFn = null; }
  activeAbortFn = minimaxApi.minimaxChatStream(model, messages, _minimaxApiKey, {
    system,
    onChunk: (text) => { if (!event.sender.isDestroyed()) event.sender.send('minimax:chat-stream', { type: 'chunk', text }); },
    onDone: () => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('minimax:chat-stream', { type: 'done' }); },
    onError: (err) => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('minimax:chat-stream', { type: 'error', message: err.message }); },
  });
});

// --- Ollama (Local Models) IPC ---
const ollamaApi = require('./ollama-api');

ipcMain.handle('ollama:isAvailable', () => ollamaApi.isAvailable());
ipcMain.handle('ollama:models', () => ollamaApi.listModels());
ipcMain.handle('ollama:host', () => ollamaApi.getHost());
ipcMain.handle('ollama:setHost', (_, host) => { ollamaApi.setHost(host); return { success: true }; });

ipcMain.on('ollama:chat', (event, { model, messages }) => {
  if (activeAbortFn) { activeAbortFn(); activeAbortFn = null; }
  activeAbortFn = ollamaApi.ollamaChatStream(model, messages, {
    onChunk: (text) => { if (!event.sender.isDestroyed()) event.sender.send('ollama:chat-stream', { type: 'chunk', text }); },
    onDone: () => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('ollama:chat-stream', { type: 'done' }); },
    onError: (err) => { activeAbortFn = null; if (!event.sender.isDestroyed()) event.sender.send('ollama:chat-stream', { type: 'error', message: err.message }); },
  });
});

ipcMain.handle('ollama:pull', async (event, modelName) => {
  try {
    await ollamaApi.pullModel(modelName, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('ollama:pull-progress', progress);
    });
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// --- Computer Use IPC ---
const computerUse = require('./computer-use');

ipcMain.handle('computer:screenshot', async (_, displayId) => {
  return computerUse.takeScreenshot(displayId);
});

ipcMain.handle('computer:screenInfo', () => {
  return computerUse.getScreenInfo();
});

ipcMain.handle('computer:action', async (_, action) => {
  return computerUse.executeComputerAction(action);
});

// Full Computer Use chat loop — Claude sees screen, acts, loops
let _computerUseChatAbort = false;
ipcMain.on('computer:chat', async (event, { task, model, system }) => {
  _computerUseChatAbort = false;

  // Resolve Claude API key (subscription token or DPAPI)
  let apiKey;
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    if (creds?.claudeAiOauth?.accessToken) apiKey = creds.claudeAiOauth.accessToken;
  } catch {}
  if (!apiKey) {
    if (!event.sender.isDestroyed()) event.sender.send('computer:chat-update', { type: 'error', message: 'No Claude credentials for Computer Use.' });
    return;
  }

  const messages = [{ role: 'user', content: task }];

  try {
    await computerUse.computerUseChat(apiKey, messages, {
      model: model || 'claude-sonnet-4-6',
      system: system || 'You control a Windows 11 computer. Take screenshots to see what is on screen, then use mouse and keyboard to accomplish the task. Be precise with coordinates.',
      onAction: (action) => {
        if (!event.sender.isDestroyed()) event.sender.send('computer:chat-update', { type: 'action', action });
      },
      onMessage: (text) => {
        if (!event.sender.isDestroyed()) event.sender.send('computer:chat-update', { type: 'message', text });
      },
      onError: (err) => {
        if (!event.sender.isDestroyed()) event.sender.send('computer:chat-update', { type: 'error', message: err });
      },
      onDone: (reason) => {
        if (!event.sender.isDestroyed()) event.sender.send('computer:chat-update', { type: 'done', reason });
      },
    });
  } catch (err) {
    if (!event.sender.isDestroyed()) event.sender.send('computer:chat-update', { type: 'error', message: err.message });
  }
});

ipcMain.on('computer:abort', () => { _computerUseChatAbort = true; });

app.whenReady().then(init);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) init();
});

app.on('window-all-closed', () => {
  cleanup();
  app.quit();
});

app.on('before-quit', cleanup);
