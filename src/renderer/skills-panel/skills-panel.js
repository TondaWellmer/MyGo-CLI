'use strict';

/**
 * Skills Panel — Enhanced with project categories, toggles, MCP section, and persistence.
 *
 * IPC API (window.pangea):
 *   listSkills()              -> [{name, description, enabled, path}]
 *   toggleSkill(name, enabled) -> renames SKILL.md <-> SKILL.md.off
 *   listMCPs()                -> [{name, enabled, config}]
 *   toggleMCP(name, enabled)  -> enables/disables MCP in settings
 */

const CATEGORY_PATTERNS = [
  { pattern: /^chatbot-/i,  category: 'Chatbot-Platform' },
  { pattern: /^4based-/i,   category: 'Chatbot-Platform' },
  { pattern: /^content-/i,  category: 'Chatbot-Platform' },
  { pattern: /^revenue-/i,  category: 'Chatbot-Platform' },
  { pattern: /^safety-/i,   category: 'Chatbot-Platform' },
  { pattern: /^safeminds-/i, category: 'Safeminds' },
  { pattern: /^trading-/i,  category: 'Trading' },
  { pattern: /^momentum/i,  category: 'Trading' },
  { pattern: /^risiko-/i,   category: 'Trading' },
  { pattern: /^pangea/i,    category: 'Pangea' },
  { pattern: /^fanvue-/i,   category: 'Plugins' },
  { pattern: /^instagram-/i, category: 'Plugins' },
  { pattern: /^youtube-/i,  category: 'Plugins' },
  { pattern: /^social-/i,   category: 'Plugins' },
  { pattern: /^n8n-/i,      category: 'Plugins' },
  { pattern: /^brevo-/i,    category: 'Plugins' },
  { pattern: /^wordpress-/i, category: 'Plugins' },
  { pattern: /^browser-/i,  category: 'Plugins' },
  { pattern: /^voice-/i,    category: 'Plugins' },
];

const CATEGORY_ORDER = [
  'Chatbot-Platform',
  'Safeminds',
  'Trading',
  'Pangea',
  'Global',
  'Plugins',
  'MCPs',
];

class SkillsPanel {
  constructor() {
    this._skills = [];
    this._mcps = [];
    this._expanded = {};
    this._panelEl = null;
    this._loaded = false;
  }

  bind(panelEl) {
    this._panelEl = panelEl;
  }

  async load() {
    if (!this._panelEl) return;
    try {
      const [skillsResult, mcpsResult] = await Promise.all([
        window.pangea.listSkills(),
        window.pangea.listMCPs().catch(() => []),
      ]);
      this._skills = Array.isArray(skillsResult) ? skillsResult : (skillsResult.skills || []);
      this._mcps = Array.isArray(mcpsResult) ? mcpsResult : (mcpsResult.mcps || []);
      this._loaded = true;
      this._render();
    } catch (err) {
      this._panelEl.innerHTML = `<div class="skills-error">Error: ${err.message}</div>`;
    }
  }

  update(skills) {
    this._skills = skills;
    this._render();
  }

  // --- Categorization ---

  _categorize(skillName) {
    for (const { pattern, category } of CATEGORY_PATTERNS) {
      if (pattern.test(skillName)) return category;
    }
    return 'Global';
  }

  _groupSkills() {
    const groups = {};
    for (const cat of CATEGORY_ORDER) {
      if (cat !== 'MCPs') groups[cat] = [];
    }
    for (const skill of this._skills) {
      const cat = this._categorize(skill.name);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(skill);
    }
    // Remove empty categories
    for (const cat of Object.keys(groups)) {
      if (groups[cat].length === 0) delete groups[cat];
    }
    return groups;
  }

  // --- Rendering ---

  _render() {
    if (!this._panelEl) return;

    const groups = this._groupSkills();
    let html = '<div class="skills-panel">';

    // Header with refresh button
    html += `<div class="skills-panel-header">
      <span class="skills-panel-title">Skills & MCPs</span>
      <button class="skills-refresh-btn" title="Context Reload">&#x21bb;</button>
    </div>`;

    // Skill categories
    const orderedCats = CATEGORY_ORDER.filter(c => c !== 'MCPs' && groups[c]);
    for (const cat of orderedCats) {
      html += this._renderCategory(cat, groups[cat], 'skill');
    }

    // MCP section
    if (this._mcps.length > 0) {
      html += this._renderMCPCategory();
    }

    html += '</div>';
    this._panelEl.innerHTML = html;
    this._bindEvents();
  }

  _renderCategory(cat, items, type) {
    const expanded = this._expanded[cat] !== false;
    const enabledCount = items.filter(i => i.enabled).length;
    const totalCount = items.length;
    const allOn = enabledCount === totalCount;
    const noneOn = enabledCount === 0;
    const indeterminate = !allOn && !noneOn;

    let html = `<div class="skills-category" data-category="${this._esc(cat)}">
      <div class="skills-category-header" data-category="${this._esc(cat)}">
        <span class="skills-expand-icon">${expanded ? '\u25BE' : '\u25B8'}</span>
        <span class="skills-category-name">${this._esc(cat)}</span>
        <span class="skills-category-count">(${enabledCount}/${totalCount})</span>
        <label class="skills-toggle-switch skills-cat-toggle" title="${allOn ? 'Disable all' : 'Enable all'}">
          <input type="checkbox" data-cat-toggle="${this._esc(cat)}" data-type="${type}"
            ${allOn ? 'checked' : ''} ${indeterminate ? 'data-indeterminate="true"' : ''}>
          <span class="skills-toggle-slider"></span>
        </label>
      </div>`;

    if (expanded) {
      html += '<div class="skills-category-items">';
      const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
      for (const item of sorted) {
        html += `<div class="skills-item ${item.enabled ? '' : 'skills-item-disabled'}"
          title="${this._esc(item.description || item.path || '')}">
          <span class="skills-item-name">${this._esc(item.name)}</span>
          <label class="skills-toggle-switch">
            <input type="checkbox" data-skill="${this._esc(item.name)}" ${item.enabled ? 'checked' : ''}>
            <span class="skills-toggle-slider"></span>
          </label>
        </div>`;
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  _renderMCPCategory() {
    const cat = 'MCPs';
    const expanded = this._expanded[cat] !== false;
    const enabledCount = this._mcps.filter(m => m.enabled).length;
    const totalCount = this._mcps.length;
    const allOn = enabledCount === totalCount;
    const noneOn = enabledCount === 0;
    const indeterminate = !allOn && !noneOn;

    let html = `<div class="skills-category skills-mcp-section" data-category="${cat}">
      <div class="skills-category-header" data-category="${cat}">
        <span class="skills-expand-icon">${expanded ? '\u25BE' : '\u25B8'}</span>
        <span class="skills-category-name">${cat}</span>
        <span class="skills-category-count">(${enabledCount}/${totalCount})</span>
        <label class="skills-toggle-switch skills-cat-toggle" title="${allOn ? 'Disable all' : 'Enable all'}">
          <input type="checkbox" data-cat-toggle="${cat}" data-type="mcp"
            ${allOn ? 'checked' : ''} ${indeterminate ? 'data-indeterminate="true"' : ''}>
          <span class="skills-toggle-slider"></span>
        </label>
      </div>`;

    if (expanded) {
      html += '<div class="skills-category-items">';
      const sorted = [...this._mcps].sort((a, b) => a.name.localeCompare(b.name));
      for (const mcp of sorted) {
        html += `<div class="skills-item ${mcp.enabled ? '' : 'skills-item-disabled'}"
          title="${this._esc(JSON.stringify(mcp.config || {}))}">
          <span class="skills-item-name">${this._esc(mcp.name)}</span>
          <label class="skills-toggle-switch">
            <input type="checkbox" data-mcp="${this._esc(mcp.name)}" ${mcp.enabled ? 'checked' : ''}>
            <span class="skills-toggle-slider"></span>
          </label>
        </div>`;
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  // --- Events ---

  _bindEvents() {
    if (!this._panelEl) return;

    // Set indeterminate state on category checkboxes (can only be done via JS)
    this._panelEl.querySelectorAll('[data-indeterminate="true"]').forEach(el => {
      el.indeterminate = true;
    });

    // Expand/collapse categories
    this._panelEl.querySelectorAll('.skills-category-header').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.skills-toggle-switch')) return;
        const cat = el.dataset.category;
        this._expanded[cat] = this._expanded[cat] === false;
        this._render();
      });
    });

    // Category-level toggle
    this._panelEl.querySelectorAll('[data-cat-toggle]').forEach(el => {
      el.addEventListener('change', (e) => {
        e.stopPropagation();
        const cat = el.dataset.catToggle;
        const type = el.dataset.type;
        const enabled = el.checked;
        this._toggleCategory(cat, type, enabled);
      });
    });

    // Individual skill toggle
    this._panelEl.querySelectorAll('[data-skill]').forEach(el => {
      el.addEventListener('change', (e) => {
        e.stopPropagation();
        const name = el.dataset.skill;
        const enabled = el.checked;
        this._toggleSingleSkill(name, enabled);
      });
    });

    // Individual MCP toggle
    this._panelEl.querySelectorAll('[data-mcp]').forEach(el => {
      el.addEventListener('change', (e) => {
        e.stopPropagation();
        const name = el.dataset.mcp;
        const enabled = el.checked;
        this._toggleSingleMCP(name, enabled);
      });
    });

    // Refresh button
    const refreshBtn = this._panelEl.querySelector('.skills-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this._refreshContext());
    }
  }

  // --- Toggle logic ---

  async _toggleSingleSkill(name, enabled) {
    try {
      await window.pangea.toggleSkill(name, enabled);
      const skill = this._skills.find(s => s.name === name);
      if (skill) skill.enabled = enabled;
      this._render();
    } catch (err) {
      console.error(`Failed to toggle skill "${name}":`, err);
    }
  }

  async _toggleSingleMCP(name, enabled) {
    try {
      await window.pangea.toggleMCP(name, enabled);
      const mcp = this._mcps.find(m => m.name === name);
      if (mcp) mcp.enabled = enabled;
      this._render();
    } catch (err) {
      console.error(`Failed to toggle MCP "${name}":`, err);
    }
  }

  async _toggleCategory(cat, type, enabled) {
    if (type === 'mcp') {
      const promises = this._mcps.map(m =>
        window.pangea.toggleMCP(m.name, enabled).then(() => { m.enabled = enabled; })
      );
      await Promise.allSettled(promises);
    } else {
      const items = this._skills.filter(s => this._categorize(s.name) === cat);
      const promises = items.map(s =>
        window.pangea.toggleSkill(s.name, enabled).then(() => { s.enabled = enabled; })
      );
      await Promise.allSettled(promises);
    }
    this._render();
  }

  async _refreshContext() {
    const btn = this._panelEl.querySelector('.skills-refresh-btn');
    if (btn) {
      btn.classList.add('skills-refresh-spinning');
      btn.disabled = true;
    }
    try {
      // Reload skills and MCPs from disk
      await this.load();
      // Trigger context reload in the terminal session if available
      if (typeof window.pangea.refreshContext === 'function') {
        await window.pangea.refreshContext();
      }
    } finally {
      if (btn) {
        btn.classList.remove('skills-refresh-spinning');
        btn.disabled = false;
      }
    }
  }

  // --- Util ---

  _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

module.exports = { SkillsPanel };
