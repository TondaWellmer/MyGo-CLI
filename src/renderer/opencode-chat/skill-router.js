'use strict';

// === Pearl — Skill Router ===
// Maps keywords/intents to skills, models, and MCPs

const SKILL_TRIGGERS = [
  { pattern: /\b(deploy|hetzner|server)\b/i, skills: ['hetzner-deploy', 'security-audit'] },
  { pattern: /\b(backtest|trading|strategi|portfolio|risk.?regler)\b/i, skills: ['trading-backtest', 'trading-simulation', 'trading-monitor'] },
  { pattern: /\b(safeminds|kursplattform|learnDash|arbeitsschutz)\b/i, skills: ['safeminds-course-builder', 'safeminds-onboarding'] },
  { pattern: /\b(instagram|insta|reel|story|hashtag)\b/i, skills: ['instagram-automation', 'social-media'] },
  { pattern: /\b(content.?generat|comfyui|lora|pulid|text2img)\b/i, skills: ['content-pipeline', 'content-generation'] },
  { pattern: /\b(4based|creator.?chat|chatbot|dm.?auto)\b/i, skills: ['4based-api', 'chatbot-llm'] },
  { pattern: /\b(youtube|transkri|video.?analy)\b/i, skills: ['youtube-analyst', 'youtube-transcript'] },
  { pattern: /\b(security.?audit|sicherheits.?pr)/i, skills: ['security-audit'] },
  { pattern: /\b(recherch|research|deep.?search)\b/i, skills: ['deep-research'] },
  { pattern: /\b(fanvue|oauth.*fanvue)\b/i, skills: ['fanvue-api'] },
  { pattern: /\b(brevo|e.?mail.*auto|newsletter)\b/i, skills: ['brevo-automation'] },
  { pattern: /\b(browser|scraping|playwright|screenshot)\b/i, skills: ['browser-automation'] },
  { pattern: /\b(revenue|pricing|whale|conversion)\b/i, skills: ['revenue-analytics'] },
  { pattern: /\b(wordpress|seo|learndash)\b/i, skills: ['wordpress-seo'] },
  { pattern: /\b(probros|dienstleist)/i, skills: [] },
];

const MODEL_HINTS = [
  { pattern: /\b(implementier|schreib.*code|programmier|refactor|debug|fix.*bug|patch|endpoint|migration)\b/i, preference: 'code' },
  { pattern: /\b(analysier|review|audit|architektur|design|system.*entwurf)\b/i, preference: 'analysis' },
  { pattern: /\b(erkl.re|was ist|zusammenfassung|summary|.bersetze)\b/i, preference: 'knowledge' },
  { pattern: /\b(berechne|formel|integral|ableitung|statistik|wahrscheinlich)\b/i, preference: 'math' },
  { pattern: /\b(lang|dokument|pdf|200.?seiten|komplett.*lesen)\b/i, preference: 'longcontext' },
  { pattern: /\b(gedicht|kreativ|story|brainstorm|idee)\b/i, preference: 'creative' },
];

const MCP_TRIGGERS = [
  { pattern: /\b(browser|website|selenium|playwright|screenshot|scrape)\b/i, mcp: 'playwright' },
  { pattern: /\b(datenbank|sql|mysql|query|tabelle)\b/i, mcp: 'mysql' },
  { pattern: /\b(embedding|pinecone|vector|rag|semantic)\b/i, mcp: 'pinecone' },
  { pattern: /\b(comfyui|render|workflow.*node)\b/i, mcp: 'comfyui' },
];

// Skills that often go together (learned correlations)
const SKILL_CORRELATIONS = {
  'trading-backtest': ['trading-simulation', 'trading-monitor'],
  'trading-simulation': ['trading-backtest', 'momentumvertiefung'],
  'safeminds-course-builder': ['safeminds-onboarding', 'safeminds-compliance'],
  '4based-api': ['chatbot-llm', 'safety-guardrails'],
  'chatbot-llm': ['4based-api', 'revenue-analytics'],
  'instagram-automation': ['social-media', 'content-generation'],
  'content-pipeline': ['content-generation'],
  'hetzner-deploy': ['security-audit'],
  'youtube-analyst': ['youtube-transcript'],
};

class SkillRouter {
  constructor() {
    this._activeSkills = new Set();
    this._activeMCPs = new Set();
    this._routingHistory = [];
    this._onSkillChange = null;
    this._onMCPChange = null;
  }

  onSkillChange(fn) { this._onSkillChange = fn; }
  onMCPChange(fn) { this._onMCPChange = fn; }
  getActiveSkills() { return [...this._activeSkills]; }
  getActiveMCPs() { return [...this._activeMCPs]; }

  // Analyze a message and return needed skills/MCPs/model preference
  analyze(text) {
    const result = { skills: new Set(), mcps: new Set(), modelHint: null, commands: [] };

    // Check for explicit /commands first
    const cmdMatch = text.match(/^\/(skill|model|mcp|pearl)\s*(.*)/i);
    if (cmdMatch) {
      result.commands.push({ type: cmdMatch[1].toLowerCase(), arg: cmdMatch[2].trim() });
      return result;
    }

    // Skill triggers
    for (const trigger of SKILL_TRIGGERS) {
      if (trigger.pattern.test(text)) {
        for (const s of trigger.skills) result.skills.add(s);
      }
    }

    // Add correlated skills
    const correlated = new Set();
    for (const skill of result.skills) {
      const cors = SKILL_CORRELATIONS[skill];
      if (cors) cors.forEach(c => correlated.add(c));
    }
    for (const c of correlated) result.skills.add(c);

    // Model hints
    for (const hint of MODEL_HINTS) {
      if (hint.pattern.test(text)) { result.modelHint = hint.preference; break; }
    }

    // MCP triggers
    for (const trigger of MCP_TRIGGERS) {
      if (trigger.pattern.test(text)) result.mcps.add(trigger.mcp);
    }

    return result;
  }

  // Process a /command and return the action taken
  processCommand(cmd) {
    const { type, arg } = cmd;

    if (type === 'pearl') {
      if (arg === 'status') {
        return {
          action: 'status',
          skills: this.getActiveSkills(),
          mcps: this.getActiveMCPs(),
        };
      }
      if (arg === 'reset') {
        this._activeSkills.clear();
        this._activeMCPs.clear();
        if (this._onSkillChange) this._onSkillChange([]);
        if (this._onMCPChange) this._onMCPChange([]);
        return { action: 'reset' };
      }
      return { action: 'help', text: 'Commands: /pearl status, /pearl reset, /skill NAME, /skill -NAME, /model NAME, /mcp NAME' };
    }

    if (type === 'skill') {
      const disable = arg.startsWith('-');
      const name = disable ? arg.slice(1).trim() : arg.trim();
      if (!name) return { action: 'error', text: 'Usage: /skill NAME or /skill -NAME' };

      if (disable) {
        this._activeSkills.delete(name);
        if (this._onSkillChange) this._onSkillChange(this.getActiveSkills());
        return { action: 'skill-disabled', name };
      } else {
        this._activeSkills.add(name);
        // Add correlated skills
        const cors = SKILL_CORRELATIONS[name];
        if (cors) cors.forEach(c => this._activeSkills.add(c));
        if (this._onSkillChange) this._onSkillChange(this.getActiveSkills());
        return { action: 'skill-enabled', name, correlated: cors || [] };
      }
    }

    if (type === 'model') {
      return { action: 'model-switch', model: arg.trim() };
    }

    if (type === 'mcp') {
      const disable = arg.startsWith('-');
      const name = disable ? arg.slice(1).trim() : arg.trim();
      if (disable) {
        this._activeMCPs.delete(name);
        if (this._onMCPChange) this._onMCPChange(this.getActiveMCPs());
        return { action: 'mcp-disabled', name };
      } else {
        this._activeMCPs.add(name);
        if (this._onMCPChange) this._onMCPChange(this.getActiveMCPs());
        return { action: 'mcp-enabled', name };
      }
    }

    return { action: 'unknown' };
  }

  // Check if the analyzed skills differ from current active skills
  needsSwitch(analysis) {
    const newSkills = [...analysis.skills].filter(s => !this._activeSkills.has(s));
    const newMCPs = [...analysis.mcps].filter(m => !this._activeMCPs.has(m));
    return newSkills.length > 0 || newMCPs.length > 0;
  }

  // Apply analyzed changes
  applyAnalysis(analysis) {
    let changed = false;
    for (const s of analysis.skills) {
      if (!this._activeSkills.has(s)) { this._activeSkills.add(s); changed = true; }
    }
    for (const m of analysis.mcps) {
      if (!this._activeMCPs.has(m)) { this._activeMCPs.add(m); changed = true; }
    }
    if (changed) {
      if (this._onSkillChange) this._onSkillChange(this.getActiveSkills());
      if (this._onMCPChange) this._onMCPChange(this.getActiveMCPs());
    }

    // Log routing decision
    this._routingHistory.push({
      timestamp: new Date().toISOString(),
      skills: [...analysis.skills],
      mcps: [...analysis.mcps],
      modelHint: analysis.modelHint,
      changed,
    });
    if (this._routingHistory.length > 100) this._routingHistory = this._routingHistory.slice(-100);

    return changed;
  }

  getRoutingHistory() { return [...this._routingHistory]; }
}

module.exports = { SkillRouter };
