'use strict';

// === Pearl — Controller (Outer Layer) ===
// Sits above the Orchestrator. Analyzes every message BEFORE routing.
// Decides: skill toggles, model hints, MCP activation, session switches.
// The user never sees Pearl — they only see a seamless chat.

const { SkillRouter } = require('./skill-router');
const { ContextBridge } = require('./context-bridge');

// Model preference → actual model ID mapping
const MODEL_PREFERENCE_MAP = {
  code:        { free: null, premium: 'claude-sonnet-4-6' },  // null = let model-manager decide best
  analysis:    { free: null, premium: 'claude-opus-4-6' },
  knowledge:   { free: null, premium: null },
  math:        { free: null, premium: null },
  longcontext: { free: null, premium: null },
  creative:    { free: null, premium: 'claude-sonnet-4-6' },
};

class PearlController {
  constructor(orchestrator, modelManager, chat) {
    this._orchestrator = orchestrator;
    this._mm = modelManager;
    this._chat = chat;
    this._router = new SkillRouter();
    this._bridge = new ContextBridge();
    this._enabled = true;
    this._switchCount = 0;
    this._onStatusMessage = null;
    this._skillToggleFn = null; // Set by terminal.js to call main-process skill toggle

    // Wire skill router events
    this._router.onSkillChange((skills) => {
      this._notifySkillChange(skills);
    });
  }

  // Set callback for toggling skills in main process
  setSkillToggleFn(fn) { this._skillToggleFn = fn; }
  onStatusMessage(fn) { this._onStatusMessage = fn; }

  getRouter() { return this._router; }
  getBridge() { return this._bridge; }
  isEnabled() { return this._enabled; }
  setEnabled(on) { this._enabled = !!on; }

  // === Main Entry Point — called BEFORE orchestrator routes ===
  // Returns: { handled: bool, commandResult?: object }
  // If handled=true, the message was a /command and should NOT go to chat

  intercept(text) {
    if (!this._enabled) return { handled: false };

    // 1. Analyze the message
    const analysis = this._router.analyze(text);

    // 2. Handle explicit /commands
    if (analysis.commands.length > 0) {
      const results = [];
      for (const cmd of analysis.commands) {
        const result = this._router.processCommand(cmd);
        results.push(result);
        this._handleCommandResult(cmd, result);
      }
      return { handled: true, commandResults: results };
    }

    // 3. Auto-detect needed skills/MCPs (background, no user interruption)
    if (analysis.skills.size > 0 || analysis.mcps.size > 0) {
      const changed = this._router.applyAnalysis(analysis);
      if (changed) {
        // Toggle skills in background
        this._applySkillToggles(analysis.skills);
      }
    }

    // 4. Model hint — nudge the orchestrator
    if (analysis.modelHint) {
      this._applyModelHint(analysis.modelHint);
    }

    return { handled: false };
  }

  // Handle command results — show feedback in chat
  _handleCommandResult(cmd, result) {
    switch (result.action) {
      case 'status':
        this._showStatus(result);
        break;
      case 'reset':
        this._chat.showToast('Pearl reset — default config');
        break;
      case 'help':
        this._chat.showToast(result.text);
        break;
      case 'skill-enabled':
        this._chat.showToast('Skill: ' + result.name + (result.correlated.length ? ' (+' + result.correlated.join(', ') + ')' : ''));
        if (this._skillToggleFn) this._skillToggleFn(result.name, true);
        break;
      case 'skill-disabled':
        this._chat.showToast('Skill disabled: ' + result.name);
        if (this._skillToggleFn) this._skillToggleFn(result.name, false);
        break;
      case 'model-switch': {
        const modelArg = result.model.toLowerCase();
        if (modelArg === 'free' || modelArg === 'auto') {
          // Switch to best free model
          this._mm.setClaudeEnabled(false);
          this._chat.showToast('Switched to free models');
        } else if (modelArg === 'claude' || modelArg === 'premium') {
          this._mm.setClaudeEnabled(true);
          this._chat.showToast('Claude enabled');
        } else {
          // Try to switch to specific model by name
          const success = this._mm.switchTo(modelArg);
          if (success) {
            this._chat.showToast('Model: ' + modelArg);
          } else {
            this._chat.showToast('Model not found: ' + modelArg);
          }
        }
        break;
      }
      case 'mcp-enabled':
        this._chat.showToast('MCP: ' + result.name);
        break;
      case 'mcp-disabled':
        this._chat.showToast('MCP disabled: ' + result.name);
        break;
      case 'error':
        this._chat.showToast(result.text);
        break;
    }
  }

  // Show Pearl status in chat
  _showStatus(result) {
    const model = this._mm.getActiveModel();
    const lines = [];
    lines.push('**Pearl Status**');
    lines.push('Model: ' + (model ? (model.name || model.id) : 'none'));
    lines.push('Claude: ' + (this._mm.isClaudeEnabled() ? 'ON' : 'OFF'));
    lines.push('Mix: ' + (this._orchestrator._premiumMix || 30) + '%');
    if (result.skills.length > 0) {
      lines.push('Skills: ' + result.skills.join(', '));
    } else {
      lines.push('Skills: (auto)');
    }
    if (result.mcps.length > 0) {
      lines.push('MCPs: ' + result.mcps.join(', '));
    }
    lines.push('Switches: ' + this._switchCount);
    lines.push('Context Quality: ' + (this._bridge.getAvgQuality() || 'n/a'));

    // Show as system message
    const el = document.createElement('div');
    el.className = 'chat-bubble chat-bubble-system';
    el.style.cssText = 'background:rgba(166,227,161,0.08);border-color:rgba(166,227,161,0.2);color:#a6e3a1;text-align:left;font-family:monospace;font-size:11px;white-space:pre;';
    el.textContent = lines.join('\n');
    if (this._chat._chatEl) this._chat._chatEl.appendChild(el);
  }

  // Apply skill toggles in background (via main process)
  _applySkillToggles(skills) {
    if (!this._skillToggleFn) return;
    for (const skill of skills) {
      this._skillToggleFn(skill, true);
    }
  }

  // Nudge model selection based on task type
  _applyModelHint(hint) {
    const claudeEnabled = this._mm.isClaudeEnabled();
    const prefs = MODEL_PREFERENCE_MAP[hint];
    if (!prefs) return;

    if (claudeEnabled && prefs.premium) {
      // Suggest premium model for this task
      // The orchestrator's complexity analysis will handle the final decision
      // We just make sure the right premium model is set
    }
    // For free models, let model-manager's ranking handle it
    // The hint is logged in routing history for learning
  }

  // Notify UI about skill changes
  _notifySkillChange(skills) {
    if (this._onStatusMessage) {
      this._onStatusMessage(skills.length > 0 ? skills.join(', ') : 'auto');
    }
  }

  // === Context Bridge API ===

  // Harvest context before a session switch
  harvestContext() {
    return this._bridge.harvest(this._chat);
  }

  // Get injection prompt for new session
  getContextInjection() {
    return this._bridge.inject();
  }

  // Score a transfer after new session responds
  scoreTransfer(firstResponse) {
    const harvest = this._bridge.getLastHarvest();
    return this._bridge.scoreTransfer(firstResponse, harvest);
  }

  // === Stats ===

  getStats() {
    return {
      enabled: this._enabled,
      switchCount: this._switchCount,
      activeSkills: this._router.getActiveSkills(),
      activeMCPs: this._router.getActiveMCPs(),
      avgContextQuality: this._bridge.getAvgQuality(),
      routingHistory: this._router.getRoutingHistory().slice(-10),
    };
  }
}

module.exports = { PearlController };
