'use strict';

// === Kairos — Always-On Background Agent ===
// Persistent daemon that runs independently of the Pangea UI.
// Features:
// - Heartbeat (15s interval) — monitors system state
// - Auto-Dream — nightly memory consolidation
// - Push Notifications — alerts for important events
// - Task Queue — background tasks that run when idle
// - Health Monitor — watches services, ports, processes

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const KAIROS_DIR = path.join(os.homedir(), '.claude', 'kairos');
const STATE_FILE = path.join(KAIROS_DIR, 'state.json');
const LOG_FILE = path.join(KAIROS_DIR, 'kairos.log');
const TASK_QUEUE_FILE = path.join(KAIROS_DIR, 'tasks.json');

class KairosAgent {
  constructor() {
    this._running = false;
    this._heartbeatInterval = null;
    this._dreamInterval = null;
    this._state = {
      startedAt: null,
      heartbeatCount: 0,
      lastHeartbeat: null,
      lastDream: null,
      watchers: [],
      notifications: [],
      taskQueue: [],
    };
    this._watchers = new Map(); // name → { check, interval, lastResult }
    this._onNotification = null;
    this._onStateChange = null;
    this._heartbeatIntervalMs = 15000; // 15 seconds
    this._dreamHour = 3; // 3 AM

    // Ensure directory exists
    if (!fs.existsSync(KAIROS_DIR)) fs.mkdirSync(KAIROS_DIR, { recursive: true });
  }

  // --- Lifecycle ---

  start() {
    if (this._running) return;
    this._running = true;
    this._loadState();
    this._state.startedAt = new Date().toISOString();
    this._log('Kairos started');

    // Heartbeat every 15s
    this._heartbeatInterval = setInterval(() => this._heartbeat(), this._heartbeatIntervalMs);

    // Dream check every hour
    this._dreamInterval = setInterval(() => this._checkDreamTime(), 60 * 60 * 1000);

    // Initial heartbeat
    this._heartbeat();
    this._saveState();
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    if (this._dreamInterval) clearInterval(this._dreamInterval);
    this._log('Kairos stopped');
    this._saveState();
  }

  isRunning() { return this._running; }
  getState() { return { ...this._state }; }
  onNotification(fn) { this._onNotification = fn; }
  onStateChange(fn) { this._onStateChange = fn; }

  // --- Heartbeat ---

  async _heartbeat() {
    this._state.heartbeatCount++;
    this._state.lastHeartbeat = new Date().toISOString();

    // Run all watchers
    for (const [name, watcher] of this._watchers) {
      try {
        const result = await watcher.check();
        const changed = JSON.stringify(result) !== JSON.stringify(watcher.lastResult);
        watcher.lastResult = result;

        if (changed && watcher.onChange) {
          watcher.onChange(result, name);
          this._notify('watcher', `${name}: ${JSON.stringify(result).slice(0, 100)}`);
        }
      } catch (err) {
        this._log(`Watcher ${name} failed: ${err.message}`);
      }
    }

    // Process task queue
    await this._processTaskQueue();

    if (this._onStateChange) this._onStateChange(this._state);
    // Save state every 10 heartbeats
    if (this._state.heartbeatCount % 10 === 0) this._saveState();
  }

  // --- Watchers ---

  addWatcher(name, checkFn, { onChange, intervalMs } = {}) {
    this._watchers.set(name, {
      check: checkFn,
      onChange: onChange || null,
      interval: intervalMs || this._heartbeatIntervalMs,
      lastResult: null,
    });
    this._state.watchers = [...this._watchers.keys()];
    this._log(`Watcher added: ${name}`);
  }

  removeWatcher(name) {
    this._watchers.delete(name);
    this._state.watchers = [...this._watchers.keys()];
  }

  // --- Built-in Watchers ---

  addDefaultWatchers() {
    // Watch disk space
    this.addWatcher('disk-space', () => {
      return new Promise((resolve) => {
        exec('powershell -NoProfile -Command "(Get-PSDrive C).Free / 1GB"', (err, out) => {
          resolve({ freeGB: parseFloat(out) || 0 });
        });
      });
    }, {
      onChange: (result) => {
        if (result.freeGB < 10) this._notify('warning', `Low disk space: ${result.freeGB.toFixed(1)} GB free`);
      },
    });

    // Watch memory usage
    this.addWatcher('memory', () => {
      const total = os.totalmem();
      const free = os.freemem();
      return { totalGB: (total / 1e9).toFixed(1), freeGB: (free / 1e9).toFixed(1), usedPct: ((1 - free / total) * 100).toFixed(0) };
    }, {
      onChange: (result) => {
        if (parseInt(result.usedPct) > 90) this._notify('warning', `High memory: ${result.usedPct}% used`);
      },
    });

    // Watch Ollama status
    this.addWatcher('ollama', async () => {
      try {
        const ollamaApi = require('./ollama-api');
        const available = await ollamaApi.isAvailable();
        return { available };
      } catch { return { available: false }; }
    });

    // Watch for new files in _needs/
    this.addWatcher('needs-folder', () => {
      return new Promise((resolve) => {
        const needsDir = path.join(os.homedir(), 'Documents', 'Antigravity-Projects', '_needs');
        try {
          const files = fs.readdirSync(needsDir).filter(f => f.endsWith('.txt'));
          const recent = files.filter(f => {
            const stat = fs.statSync(path.join(needsDir, f));
            return Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000; // last 24h
          });
          resolve({ total: files.length, recentlyModified: recent.length });
        } catch { resolve({ total: 0, recentlyModified: 0 }); }
      });
    });
  }

  // --- Dream (Memory Consolidation) ---

  _checkDreamTime() {
    const hour = new Date().getHours();
    if (hour !== this._dreamHour) return;

    // Only dream once per night
    if (this._state.lastDream) {
      const lastDream = new Date(this._state.lastDream);
      const now = new Date();
      if (lastDream.toDateString() === now.toDateString()) return;
    }

    this._dream();
  }

  async _dream() {
    this._log('Dream cycle starting...');
    this._state.lastDream = new Date().toISOString();

    try {
      const memoryDir = path.join(os.homedir(), '.claude', 'projects');
      // Find all MEMORY.md files
      const memoryFiles = this._findFiles(memoryDir, 'MEMORY.md');

      for (const memFile of memoryFiles) {
        const content = fs.readFileSync(memFile, 'utf8');
        const lines = content.split('\n');

        // Check if MEMORY.md is over 200 lines
        if (lines.length > 200) {
          this._notify('dream', `MEMORY.md at ${memFile} has ${lines.length} lines — needs consolidation`);
        }

        // Check for stale entries (referenced files that don't exist)
        const mdLinks = content.match(/\[.*?\]\((.*?\.md)\)/g) || [];
        const dir = path.dirname(memFile);
        let staleCount = 0;
        for (const link of mdLinks) {
          const match = link.match(/\((.*?\.md)\)/);
          if (match) {
            const refPath = path.join(dir, match[1]);
            if (!fs.existsSync(refPath)) staleCount++;
          }
        }
        if (staleCount > 0) {
          this._notify('dream', `${staleCount} stale memory references in ${memFile}`);
        }
      }

      this._log('Dream cycle complete');
    } catch (err) {
      this._log(`Dream error: ${err.message}`);
    }

    this._saveState();
  }

  _findFiles(dir, filename) {
    const results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this._findFiles(fullPath, filename));
        } else if (entry.name === filename) {
          results.push(fullPath);
        }
      }
    } catch {}
    return results;
  }

  // --- Task Queue ---

  addTask(task) {
    this._state.taskQueue.push({
      id: Date.now().toString(36),
      ...task,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    this._saveTaskQueue();
    return this._state.taskQueue[this._state.taskQueue.length - 1].id;
  }

  async _processTaskQueue() {
    const pending = this._state.taskQueue.filter(t => t.status === 'pending');
    if (pending.length === 0) return;

    const task = pending[0];
    task.status = 'running';

    try {
      if (task.type === 'shell') {
        const result = await new Promise((resolve) => {
          exec(task.command, { timeout: task.timeout || 30000 }, (err, stdout, stderr) => {
            resolve({ success: !err, stdout, stderr, error: err?.message });
          });
        });
        task.result = result;
        task.status = result.success ? 'completed' : 'failed';
      } else if (task.type === 'check-url') {
        const result = await this._checkUrl(task.url);
        task.result = result;
        task.status = 'completed';
      } else {
        task.status = 'failed';
        task.result = { error: 'Unknown task type: ' + task.type };
      }
    } catch (err) {
      task.status = 'failed';
      task.result = { error: err.message };
    }

    task.completedAt = new Date().toISOString();
    this._saveTaskQueue();

    if (task.notify) {
      this._notify('task', `Task ${task.id} ${task.status}: ${JSON.stringify(task.result).slice(0, 100)}`);
    }
  }

  _checkUrl(url) {
    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? require('https') : require('http');
      const req = mod.get(url, (res) => {
        resolve({ status: res.statusCode, ok: res.statusCode < 400 });
      });
      req.on('error', (err) => resolve({ status: 0, ok: false, error: err.message }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, ok: false, error: 'timeout' }); });
    });
  }

  // --- Notifications ---

  _notify(type, message) {
    const notification = { type, message, timestamp: new Date().toISOString(), read: false };
    this._state.notifications.push(notification);
    // Keep last 100 notifications
    if (this._state.notifications.length > 100) {
      this._state.notifications = this._state.notifications.slice(-100);
    }
    if (this._onNotification) this._onNotification(notification);
    this._log(`[${type}] ${message}`);
  }

  getNotifications(unreadOnly = false) {
    return unreadOnly
      ? this._state.notifications.filter(n => !n.read)
      : this._state.notifications;
  }

  markRead(index) {
    if (this._state.notifications[index]) {
      this._state.notifications[index].read = true;
    }
  }

  markAllRead() {
    this._state.notifications.forEach(n => { n.read = true; });
  }

  // --- Persistence ---

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        this._state = { ...this._state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
      }
    } catch {}
    try {
      if (fs.existsSync(TASK_QUEUE_FILE)) {
        const tasks = JSON.parse(fs.readFileSync(TASK_QUEUE_FILE, 'utf8'));
        this._state.taskQueue = tasks;
      }
    } catch {}
  }

  _saveState() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(this._state, null, 2)); } catch {}
  }

  _saveTaskQueue() {
    try { fs.writeFileSync(TASK_QUEUE_FILE, JSON.stringify(this._state.taskQueue, null, 2)); } catch {}
  }

  // --- Logging ---

  _log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch {}
  }

  // --- Manual Dream Trigger ---

  async triggerDream() {
    await this._dream();
    return { success: true, lastDream: this._state.lastDream };
  }
}

// Singleton
let _instance = null;

function getInstance() {
  if (!_instance) _instance = new KairosAgent();
  return _instance;
}

module.exports = { KairosAgent, getInstance };
