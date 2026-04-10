'use strict';

const { t, setLocale, getLocale, getAvailableLocales, onLocaleChange } = require('../i18n');

// ---------------------------------------------------------------------------
// Built-in Themes — use the same CSS variable names as styles.css :root
// ---------------------------------------------------------------------------
const THEMES = {
  'pearl': {
    name: 'Pearl',
    builtin: true,
    vars: {
      '--bg-base': '#efefeb', '--bg-surface': '#e9e9e3', '--bg-overlay': '#e2e2da',
      '--bg-hover': '#dbdbd3', '--text': '#2a2a30', '--text-dim': '#5a5a68',
      '--text-muted': '#8a8a98', '--accent': '#4a6adf', '--accent-hover': '#3a5ad0',
      '--accent-glow': 'rgba(74, 106, 223, 0.12)', '--border': '#d8d4c8',
      '--border-subtle': '#e2ddd2', '--green': '#2a9a50', '--red': '#d04058',
      '--shadow-dropdown': '0 12px 40px rgba(0, 0, 0, 0.08), 0 0 0 1px #d8d4c8',
    }
  },
  'dark': {
    name: 'Dark',
    builtin: true,
    vars: {
      '--bg-base': '#0a0a0f', '--bg-surface': '#111118', '--bg-overlay': '#1e1e2e',
      '--bg-hover': '#2a2a35', '--text': '#cdd6f4', '--text-dim': '#6c7086',
      '--text-muted': '#585b70', '--accent': '#a6e3a1', '--accent-hover': '#94d693',
      '--accent-glow': 'rgba(166, 227, 161, 0.12)', '--border': '#2a2a35',
      '--border-subtle': '#232330', '--green': '#a6e3a1', '--red': '#f38ba8',
      '--shadow-dropdown': '0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px #2a2a35',
    }
  },
  'midnight': {
    name: 'Midnight',
    builtin: true,
    vars: {
      '--bg-base': '#0d1117', '--bg-surface': '#161b22', '--bg-overlay': '#21262d',
      '--bg-hover': '#30363d', '--text': '#c9d1d9', '--text-dim': '#8b949e',
      '--text-muted': '#6e7681', '--accent': '#58a6ff', '--accent-hover': '#4090e0',
      '--accent-glow': 'rgba(88, 166, 255, 0.12)', '--border': '#30363d',
      '--border-subtle': '#21262d', '--green': '#3fb950', '--red': '#f85149',
      '--shadow-dropdown': '0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px #30363d',
    }
  },
  'nord': {
    name: 'Nord',
    builtin: true,
    vars: {
      '--bg-base': '#2e3440', '--bg-surface': '#3b4252', '--bg-overlay': '#434c5e',
      '--bg-hover': '#4c566a', '--text': '#eceff4', '--text-dim': '#d8dee9',
      '--text-muted': '#a5b1c2', '--accent': '#88c0d0', '--accent-hover': '#7ab0c0',
      '--accent-glow': 'rgba(136, 192, 208, 0.12)', '--border': '#4c566a',
      '--border-subtle': '#434c5e', '--green': '#a3be8c', '--red': '#bf616a',
      '--shadow-dropdown': '0 12px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px #4c566a',
    }
  },
};

const FONTS = [
  'system-ui',
  'Cascadia Code',
  'Fira Code',
  'JetBrains Mono',
  'Consolas',
  'Monaco',
  'Menlo',
  'Inter',
  'Segoe UI',
];

// Color wheel definitions for the custom theme editor
const THEME_WHEELS = [
  { key: '--bg-base',    label: 'Background' },
  { key: '--bg-surface', label: 'Surface' },
  { key: '--text',       label: 'Text' },
  { key: '--accent',     label: 'Accent' },
  { key: '--border',     label: 'Border' },
];

class SettingsPanel {
  constructor() {
    this._container = null;
    this._built = false;
    this._open = false;
    this._settings = {
      locale: 'en',
      theme: 'pearl',
      fontFamily: 'system-ui',
      fontSize: 13,
      customThemes: [], // [{ id, name, vars }]
    };
    this._onSettingsChange = null;
    this._customEditorEl = null; // floating left-side panel
  }

  onSettingsChange(fn) { this._onSettingsChange = fn; }

  bindSkillsPanel(skillsPanel) {
    this._skillsPanel = skillsPanel;
    // If settings panel is already built, inject skills section
    if (this._built) this._injectSkillsSection();
  }

  async init() {
    try {
      const saved = await window.pangea.readJSON('pangea-settings.json');
      if (saved) {
        Object.assign(this._settings, saved);
        this._applySettings();
      }
    } catch {}
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  open() {
    if (!this._built) this._buildDOM();
    this._container.style.display = 'flex';
    this._open = true;
  }

  close() {
    if (this._container) this._container.style.display = 'none';
    this._open = false;
  }

  getSettings() { return { ...this._settings }; }

  _buildDOM() {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });

    const panel = document.createElement('div');
    panel.className = 'settings-panel-container';

    const allThemes = this._getAllThemes();
    panel.innerHTML = `
      <div class="settings-header">
        <span class="settings-title">${t('settings.title')}</span>
        <button class="settings-close-btn">&times;</button>
      </div>
      <div class="settings-body">
        <div class="settings-group">
          <label class="settings-label">${t('settings.language')}</label>
          <select class="settings-select" data-setting="locale">
            <option value="en" ${this._settings.locale === 'en' ? 'selected' : ''}>English</option>
            <option value="de" ${this._settings.locale === 'de' ? 'selected' : ''}>Deutsch</option>
          </select>
        </div>
        <div class="settings-group">
          <label class="settings-label">${t('settings.theme')}</label>
          <div class="settings-theme-grid" id="theme-grid">
            ${Object.entries(allThemes).map(([id, theme]) => `
              <button class="settings-theme-btn ${this._settings.theme === id ? 'active' : ''}" data-theme="${id}">
                <div class="theme-preview" style="background:${theme.vars['--bg-base']};border-color:${theme.vars['--accent']}">
                  <div class="theme-accent" style="background:${theme.vars['--accent']}"></div>
                  <div class="theme-fg" style="background:${theme.vars['--text']}"></div>
                </div>
                <span class="theme-name-label" ${!theme.builtin ? 'data-custom="true"' : ''}>${theme.name}</span>
                ${!theme.builtin ? '<button class="theme-delete-btn" data-delete-theme="' + id + '">&times;</button>' : ''}
              </button>
            `).join('')}
            <button class="settings-theme-btn theme-add-btn" id="theme-add-btn">
              <div class="theme-preview theme-add-preview">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </div>
              <span>Custom</span>
            </button>
          </div>
        </div>
        <div class="settings-group">
          <label class="settings-label">${t('settings.font')}</label>
          <select class="settings-select" data-setting="fontFamily">
            ${FONTS.map(f => `<option value="${f}" ${this._settings.fontFamily === f ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
        </div>
        <div class="settings-group">
          <label class="settings-label">${t('settings.fontSize')}: <span class="font-size-value">${this._settings.fontSize}px</span></label>
          <input type="range" class="settings-range" data-setting="fontSize" min="10" max="20" value="${this._settings.fontSize}">
        </div>
      </div>
    `;

    panel.querySelector('.settings-close-btn').addEventListener('click', () => this.close());

    // Theme buttons (not the add-btn)
    this._bindThemeButtons(panel);

    // "Custom" add button
    panel.querySelector('#theme-add-btn').addEventListener('click', () => {
      this.close();
      this._openCustomThemeEditor();
    });

    // Select changes
    panel.querySelectorAll('.settings-select').forEach(sel => {
      sel.addEventListener('change', () => {
        this._settings[sel.dataset.setting] = sel.value;
        this._applySettings();
        this._save();
      });
    });

    // Range changes
    panel.querySelectorAll('.settings-range').forEach(range => {
      range.addEventListener('input', () => {
        this._settings[range.dataset.setting] = parseInt(range.value);
        const label = panel.querySelector('.font-size-value');
        if (label) label.textContent = range.value + 'px';
        this._applySettings();
        this._save();
      });
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this._container = overlay;
    this._panel = panel;
    this._built = true;

    // If skills panel was already bound, inject it now
    if (this._skillsPanel) this._injectSkillsSection();
  }

  _injectSkillsSection() {
    if (!this._panel || !this._skillsPanel) return;
    const body = this._panel.querySelector('.settings-body');
    if (!body) return;

    // Check if already injected
    if (body.querySelector('#settings-skills-container')) return;

    const group = document.createElement('div');
    group.className = 'settings-group';

    const label = document.createElement('label');
    label.className = 'settings-label';
    label.textContent = 'Skills & MCPs';
    group.appendChild(label);

    const container = document.createElement('div');
    container.id = 'settings-skills-container';
    container.style.maxHeight = '300px';
    container.style.overflowY = 'auto';
    container.style.marginTop = '6px';
    group.appendChild(container);

    body.appendChild(group);

    this._skillsPanel.bind(container);
    this._skillsPanel.load();

    if (window.pangea?.onSkillsUpdated) {
      window.pangea.onSkillsUpdated(({ skills }) => {
        this._skillsPanel.update(skills);
      });
    }
  }

  // -----------------------------------------------------------------------
  // Theme helpers
  // -----------------------------------------------------------------------

  /** Merge built-in + custom themes into one object */
  _getAllThemes() {
    const all = { ...THEMES };
    for (const ct of (this._settings.customThemes || [])) {
      all[ct.id] = { name: ct.name, builtin: false, vars: ct.vars };
    }
    return all;
  }

  /** Bind click/dblclick/delete on theme buttons */
  _bindThemeButtons(panel) {
    panel.querySelectorAll('.settings-theme-btn:not(.theme-add-btn)').forEach(btn => {
      if (!btn.dataset.theme) return;
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.theme-delete-btn')) return;
        panel.querySelectorAll('.settings-theme-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._settings.theme = btn.dataset.theme;
        this._applySettings();
        this._save();
        // Open custom theme editor when clicking a custom (non-builtin) theme
        const allThemes = this._getAllThemes();
        const theme = allThemes[btn.dataset.theme];
        if (theme && !theme.builtin) {
          this._openCustomThemeEditor(btn.dataset.theme);
        } else {
          // Close editor when switching to a builtin theme
          this._closeCustomThemeEditor();
        }
      });
    });

    // Double-click to rename custom themes
    panel.querySelectorAll('.theme-name-label[data-custom="true"]').forEach(label => {
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const themeBtn = label.closest('.settings-theme-btn');
        const themeId = themeBtn?.dataset.theme;
        if (!themeId) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'theme-rename-input';
        input.value = label.textContent;
        label.replaceWith(input);
        input.focus();
        input.select();
        const finish = () => {
          const newName = input.value.trim() || label.textContent;
          const ct = this._settings.customThemes.find(c => c.id === themeId);
          if (ct) ct.name = newName;
          const span = document.createElement('span');
          span.className = 'theme-name-label';
          span.dataset.custom = 'true';
          span.textContent = newName;
          input.replaceWith(span);
          // Re-bind dblclick
          span.addEventListener('dblclick', (ev) => {
            ev.stopPropagation();
            this._rebuildThemeGrid();
          });
          this._save();
        };
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') input.blur();
          if (ke.key === 'Escape') { input.value = label.textContent; input.blur(); }
        });
      });
    });

    // Delete custom themes
    panel.querySelectorAll('.theme-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const themeId = btn.dataset.deleteTheme;
        this._settings.customThemes = this._settings.customThemes.filter(c => c.id !== themeId);
        if (this._settings.theme === themeId) {
          this._settings.theme = 'pearl';
          this._applySettings();
        }
        this._rebuildThemeGrid();
        this._save();
      });
    });
  }

  /** Rebuild the theme grid (after add/delete/rename) */
  _rebuildThemeGrid() {
    const grid = this._panel?.querySelector('#theme-grid');
    if (!grid) return;
    const allThemes = this._getAllThemes();
    grid.innerHTML = Object.entries(allThemes).map(([id, theme]) => `
      <button class="settings-theme-btn ${this._settings.theme === id ? 'active' : ''}" data-theme="${id}">
        <div class="theme-preview" style="background:${theme.vars['--bg-base']};border-color:${theme.vars['--accent']}">
          <div class="theme-accent" style="background:${theme.vars['--accent']}"></div>
          <div class="theme-fg" style="background:${theme.vars['--text']}"></div>
        </div>
        <span class="theme-name-label" ${!theme.builtin ? 'data-custom="true"' : ''}>${theme.name}</span>
        ${!theme.builtin ? '<button class="theme-delete-btn" data-delete-theme="' + id + '">&times;</button>' : ''}
      </button>
    `).join('') + `
      <button class="settings-theme-btn theme-add-btn" id="theme-add-btn">
        <div class="theme-preview theme-add-preview">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </div>
        <span>Custom</span>
      </button>
    `;
    this._bindThemeButtons(grid);
    grid.querySelector('#theme-add-btn').addEventListener('click', () => {
      this.close();
      this._openCustomThemeEditor();
    });
  }

  // -----------------------------------------------------------------------
  // Custom Theme Editor (floating left-side panel)
  // -----------------------------------------------------------------------

  _openCustomThemeEditor(existingThemeId) {
    if (this._customEditorEl) this._customEditorEl.remove();
    this._editingThemeId = existingThemeId || null;

    // Start from the target theme's vars (existing or current)
    const targetTheme = existingThemeId
      ? this._getAllThemes()[existingThemeId]
      : this._getAllThemes()[this._settings.theme] || THEMES['pearl'];
    const editVars = { ...targetTheme.vars };

    // Derive secondary vars from the 5 primary wheels
    const deriveSecondary = (vars) => {
      const bg = vars['--bg-base'];
      const surface = vars['--bg-surface'];
      const text = vars['--text'];
      const accent = vars['--accent'];
      const border = vars['--border'];
      // Auto-derive overlay, hover, dim, muted, etc.
      vars['--bg-overlay'] = this._blendColors(bg, border, 0.3);
      vars['--bg-hover'] = this._blendColors(bg, border, 0.4);
      vars['--text-dim'] = this._blendColors(text, '#808080', 0.35);
      vars['--text-muted'] = this._blendColors(text, '#808080', 0.55);
      vars['--accent-hover'] = this._blendColors(accent, '#000000', 0.15);
      vars['--accent-glow'] = this._hexToRgba(accent, 0.12);
      vars['--border-subtle'] = this._blendColors(border, bg, 0.4);
      vars['--green'] = vars['--green'] || '#2a9a50';
      vars['--red'] = vars['--red'] || '#d04058';
      // Shadow based on lightness
      const bgLight = this._hexLightness(bg);
      const shadowAlpha = bgLight > 0.5 ? 0.08 : 0.5;
      vars['--shadow-dropdown'] = `0 12px 40px rgba(0,0,0,${shadowAlpha}), 0 0 0 1px ${border}`;
    };

    deriveSecondary(editVars);

    const panel = document.createElement('div');
    panel.className = 'custom-theme-editor';
    panel.innerHTML = `
      <div class="cte-header">Custom Theme</div>
      <div class="cte-wheels">
        ${THEME_WHEELS.map(w => `
          <div class="cte-wheel-row">
            <label class="cte-wheel-label">${w.label}</label>
            <div class="cte-wheel-wrap">
              <div class="cte-wheel-swatch" style="background:${editVars[w.key]}"></div>
              <input type="color" class="cte-wheel-input" data-var="${w.key}" value="${editVars[w.key]}">
            </div>
          </div>
        `).join('')}
      </div>
      <div class="cte-actions">
        <button class="cte-save-btn" title="Save as new theme">&#10003;</button>
        <button class="cte-cancel-btn" title="Cancel">&times;</button>
      </div>
    `;

    document.body.appendChild(panel);
    this._customEditorEl = panel;

    // Click on swatch opens the native color picker
    panel.querySelectorAll('.cte-wheel-swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        const inp = swatch.nextElementSibling;
        if (inp) inp.click();
      });
    });

    // Live preview as colors change
    panel.querySelectorAll('.cte-wheel-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const varName = inp.dataset.var;
        editVars[varName] = inp.value;
        // Update swatch
        inp.previousElementSibling.style.background = inp.value;
        // Derive and apply live
        deriveSecondary(editVars);
        this._applyVars(editVars);
        this._syncXterm(editVars);
      });
    });

    // Save — update existing theme or create new
    panel.querySelector('.cte-save-btn').addEventListener('click', () => {
      if (this._editingThemeId) {
        // Update existing custom theme in place
        const ct = this._settings.customThemes.find(c => c.id === this._editingThemeId);
        if (ct) {
          ct.vars = { ...editVars };
          this._settings.theme = this._editingThemeId;
        }
      } else {
        // Create new custom theme
        const idx = (this._settings.customThemes || []).length + 1;
        const id = 'custom_' + Date.now();
        const ct = { id, name: 'Theme_' + String(idx).padStart(2, '0'), vars: { ...editVars } };
        this._settings.customThemes.push(ct);
        this._settings.theme = id;
      }
      this._applySettings();
      this._save();
      this._closeCustomThemeEditor();
      // Rebuild theme grid so changes appear immediately
      if (this._panel) this._rebuildThemeGrid();
    });

    // Cancel
    panel.querySelector('.cte-cancel-btn').addEventListener('click', () => {
      this._applySettings(); // revert to saved theme
      this._closeCustomThemeEditor();
    });
  }

  _closeCustomThemeEditor() {
    if (this._customEditorEl) {
      this._customEditorEl.remove();
      this._customEditorEl = null;
    }
  }

  // -----------------------------------------------------------------------
  // Color utilities
  // -----------------------------------------------------------------------

  _hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
  }

  _rgbToHex(r, g, b) {
    return '#' + [r,g,b].map(c => Math.round(Math.max(0,Math.min(255,c))).toString(16).padStart(2,'0')).join('');
  }

  _blendColors(hex1, hex2, t) {
    const [r1,g1,b1] = this._hexToRgb(hex1);
    const [r2,g2,b2] = this._hexToRgb(hex2);
    return this._rgbToHex(r1+(r2-r1)*t, g1+(g2-g1)*t, b1+(b2-b1)*t);
  }

  _hexToRgba(hex, alpha) {
    const [r,g,b] = this._hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  _hexLightness(hex) {
    const [r,g,b] = this._hexToRgb(hex);
    return (0.299*r + 0.587*g + 0.114*b) / 255;
  }

  // -----------------------------------------------------------------------
  // Apply
  // -----------------------------------------------------------------------

  /** Apply a raw vars object to the document */
  _applyVars(vars) {
    for (const [key, value] of Object.entries(vars)) {
      document.documentElement.style.setProperty(key, value);
    }
    document.body.style.background = vars['--bg-surface'] || vars['--bg-base'];
    // Sync titlebar overlay color with theme
    if (window.pangea?.setColor) {
      window.pangea.setColor(vars['--bg-surface'] || vars['--bg-base']);
    }
  }

  /** Sync xterm terminal theme with current CSS vars + update all tab colors */
  _syncXterm(vars) {
    const bgColor = vars['--bg-base'];
    // Update ALL tabs to the new theme background
    if (window._termTabs) {
      for (const [tabId, tabData] of window._termTabs.entries()) {
        tabData.color = bgColor;
        tabData.term.options.theme = {
          ...tabData.term.options.theme,
          background: bgColor,
          foreground: vars['--text'],
          cursor: vars['--accent'],
          selectionBackground: vars['--accent-glow'],
        };
        tabData.term.refresh(0, tabData.term.rows - 1);
        // Update tab swatch color
        const swatch = document.querySelector(`.term-tab[data-tab-id="${tabId}"] .term-tab-color`);
        if (swatch) swatch.style.background = bgColor;
      }
    } else if (window._xtermInstance) {
      // Fallback: single instance
      window._xtermInstance.options.theme = {
        ...window._xtermInstance.options.theme,
        background: bgColor,
        foreground: vars['--text'],
        cursor: vars['--accent'],
        selectionBackground: vars['--accent-glow'],
      };
      window._xtermInstance.refresh(0, window._xtermInstance.rows - 1);
    }
    // Sync color picker value
    const colorPicker = document.getElementById('color-picker');
    if (colorPicker) colorPicker.value = bgColor;
  }

  _applySettings() {
    // Theme
    const allThemes = this._getAllThemes();
    const theme = allThemes[this._settings.theme];
    if (theme) {
      this._applyVars(theme.vars);
      this._syncXterm(theme.vars);
    }
    // Font
    document.documentElement.style.setProperty('--font-family', this._settings.fontFamily);
    document.documentElement.style.setProperty('--font-size', this._settings.fontSize + 'px');
    document.body.style.fontFamily = this._settings.fontFamily;
    document.body.style.fontSize = this._settings.fontSize + 'px';
    // Locale
    setLocale(this._settings.locale);
    // Notify
    if (this._onSettingsChange) this._onSettingsChange(this._settings);
  }

  async _save() {
    try { await window.pangea.writeJSON('pangea-settings.json', this._settings); } catch {}
  }
}

module.exports = { SettingsPanel, THEMES };
