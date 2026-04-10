'use strict';

// === Pearl — Context Bridge ===
// Harvests context from current session and injects into new session
// Ensures seamless transitions when skills/MCPs/models change

class ContextBridge {
  constructor() {
    this._lastHarvest = null;
    this._transferLog = [];
    this._qualityScores = [];
  }

  // Harvest context from current chat state
  harvest(chat, options = {}) {
    const messages = chat.getMessages();
    const maxMessages = options.maxMessages || 10;

    // Build summary from all messages
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    // Extract key info
    const summary = this._buildSummary(messages);
    const recentMessages = messages.slice(-maxMessages);
    const openTasks = this._extractTasks(assistantMessages);
    const activeFiles = this._extractFiles(messages);
    const decisions = this._extractDecisions(assistantMessages);
    const userIntent = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';

    this._lastHarvest = {
      timestamp: new Date().toISOString(),
      summary,
      messages: recentMessages,
      messageCount: messages.length,
      openTasks,
      activeFiles,
      decisions,
      userIntent,
    };

    return this._lastHarvest;
  }

  // Generate context injection prompt for new session
  inject(harvest) {
    if (!harvest) harvest = this._lastHarvest;
    if (!harvest) return '';

    const parts = [];
    parts.push('Du uebernimmst eine laufende Konversation nahtlos. Der User soll keinen Unterschied merken.\n');

    if (harvest.summary) {
      parts.push('BISHERIGER VERLAUF (' + harvest.messageCount + ' Nachrichten):');
      parts.push(harvest.summary);
      parts.push('');
    }

    if (harvest.openTasks.length > 0) {
      parts.push('OFFENE TASKS:');
      for (const t of harvest.openTasks) parts.push('- ' + t);
      parts.push('');
    }

    if (harvest.activeFiles.length > 0) {
      parts.push('AKTIVE DATEIEN:');
      for (const f of harvest.activeFiles) parts.push('- ' + f);
      parts.push('');
    }

    if (harvest.decisions.length > 0) {
      parts.push('ENTSCHEIDUNGEN:');
      for (const d of harvest.decisions) parts.push('- ' + d);
      parts.push('');
    }

    if (harvest.userIntent) {
      parts.push('LETZTE USER-NACHRICHT:');
      parts.push(harvest.userIntent);
    }

    parts.push('\nFahre nahtlos fort.');
    return parts.join('\n');
  }

  // Build a concise summary from message history
  _buildSummary(messages) {
    if (messages.length === 0) return '';
    if (messages.length <= 5) {
      return messages.map(m => (m.role === 'user' ? 'User: ' : 'AI: ') + m.content.slice(0, 150)).join('\n');
    }

    // For longer conversations: first message + key turning points + last 3
    const parts = [];
    const first = messages[0];
    parts.push((first.role === 'user' ? 'User begann mit: ' : 'AI begann mit: ') + first.content.slice(0, 200));

    // Extract topic changes (messages where user shifts topic)
    const userMsgs = messages.filter(m => m.role === 'user');
    if (userMsgs.length > 4) {
      const mid = userMsgs[Math.floor(userMsgs.length / 2)];
      parts.push('Zwischendurch: ' + mid.content.slice(0, 150));
    }

    // Last 3 messages
    const last3 = messages.slice(-3);
    parts.push('Zuletzt:');
    for (const m of last3) {
      parts.push((m.role === 'user' ? 'User: ' : 'AI: ') + m.content.slice(0, 200));
    }

    return parts.join('\n');
  }

  // Extract TODO/task mentions from assistant messages
  _extractTasks(messages) {
    const tasks = [];
    for (const m of messages.slice(-5)) {
      const lines = m.content.split('\n');
      for (const line of lines) {
        if (/^\s*[-*]\s*\[[ x]\]/.test(line)) {
          const task = line.replace(/^\s*[-*]\s*\[[ x]\]\s*/, '').trim();
          if (task && !tasks.includes(task)) tasks.push(task);
        }
        if (/\b(TODO|NOCH OFFEN|als nächstes|next step)\b/i.test(line)) {
          const task = line.replace(/^.*?(TODO|NOCH OFFEN|als nächstes|next step):?\s*/i, '').trim();
          if (task && task.length > 5 && !tasks.includes(task)) tasks.push(task);
        }
      }
    }
    return tasks.slice(0, 10);
  }

  // Extract file paths mentioned in messages
  _extractFiles(messages) {
    const files = new Set();
    const pathPattern = /(?:[A-Z]:\\|\/|\.\/|src\/|projects\/)[^\s"'`,;:)}\]>]+\.\w{1,6}/g;
    for (const m of messages.slice(-10)) {
      const matches = m.content.match(pathPattern);
      if (matches) matches.forEach(f => files.add(f));
    }
    return [...files].slice(0, 15);
  }

  // Extract key decisions from assistant messages
  _extractDecisions(messages) {
    const decisions = [];
    const decisionPatterns = [
      /(?:ich (?:habe|werde)|I (?:will|chose|decided))\s+(.{20,100})/gi,
      /(?:entscheidung|decision|gewählt|ausgewählt|using|nutze)\s*:?\s*(.{10,100})/gi,
    ];
    for (const m of messages.slice(-5)) {
      for (const p of decisionPatterns) {
        p.lastIndex = 0;
        let match;
        while ((match = p.exec(m.content)) !== null) {
          const d = match[1].trim().replace(/\n.*/s, '');
          if (d.length > 10 && !decisions.includes(d)) decisions.push(d);
        }
      }
    }
    return decisions.slice(0, 5);
  }

  // Score context transfer quality (call after new session responds)
  scoreTransfer(newSessionFirstResponse, harvest) {
    let score = 5; // baseline

    if (!newSessionFirstResponse || !harvest) return score;

    // Does the response reference the previous context?
    if (harvest.activeFiles.some(f => newSessionFirstResponse.includes(f))) score += 1;
    if (harvest.openTasks.some(t => newSessionFirstResponse.toLowerCase().includes(t.toLowerCase().slice(0, 20)))) score += 1;

    // Does it continue naturally?
    if (!/was kann ich|wie kann ich helfen|hallo|hello/i.test(newSessionFirstResponse)) score += 1;
    if (newSessionFirstResponse.length > 100) score += 1;

    // Penalty for confusion
    if (/was meinst du|ich verstehe nicht|kontext fehlt/i.test(newSessionFirstResponse)) score -= 3;

    score = Math.max(0, Math.min(10, score));

    this._qualityScores.push({
      timestamp: new Date().toISOString(),
      score,
      messageCount: harvest.messageCount,
    });
    if (this._qualityScores.length > 50) this._qualityScores = this._qualityScores.slice(-50);

    return score;
  }

  getLastHarvest() { return this._lastHarvest; }
  getQualityScores() { return [...this._qualityScores]; }
  getAvgQuality() {
    if (this._qualityScores.length === 0) return 0;
    return this._qualityScores.reduce((s, q) => s + q.score, 0) / this._qualityScores.length;
  }
}

module.exports = { ContextBridge };
