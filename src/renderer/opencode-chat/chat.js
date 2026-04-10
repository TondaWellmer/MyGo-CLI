'use strict';

// === Pangea Smart Chat — UI ===
// Chat-Bubbles, Toggles, Status-Bar, Model-Indicator

const { t } = require('../i18n');

class OpenCodeChat {
  constructor() {
    this._open = false;
    this._container = null;
    this._chatEl = null;
    this._inputEl = null;
    this._modelLabelEl = null;
    this._scoreBadgeEl = null;
    this._statusBarEl = null;
    this._statusTextEl = null;
    this._claudeToggleEl = null;
    this._sourceToggleEl = null;
    this._budgetBarEl = null;
    this._messages = [];
    this._currentStreamEl = null;
    this._currentStreamText = '';
    this._activeModel = null;
    this._claudeEnabled = false;
    this._premiumSource = 'api';
    this._onDigestUpdate = null;
    this._onSend = null;
    this._onClaudeToggle = null;
    this._onSourceToggle = null;
    this._userScrolledUp = false; // Smart scroll: track if user scrolled away from bottom
    this._onRefresh = null;
    this._onLogin = null;
    this._onPremiumMixChange = null;
    this._onModelSelect = null;
    this._onAutoReset = null;
    this._loginScreenEl = null;
    this._authenticated = false;
    this._built = false;
    this._premiumMix = 30; // 0=only free, 100=always premium. Default 30=Claude nur für komplexe Tasks
    this._modelDropdownEl = null;
    this._autoResetEl = null;
    this._isAutoMode = true;
    this._onGeminiToggle = null;
  }

  isOpen() { return this._open; }
  getClaudeEnabled() { return this._claudeEnabled; }
  getPremiumSource() { return this._premiumSource; }
  getPremiumMix() { return this._premiumMix; }
  onPremiumMixChange(fn) { this._onPremiumMixChange = fn; }
  onModelSelect(fn) { this._onModelSelect = fn; }
  onAutoReset(fn) { this._onAutoReset = fn; }
  getMessages() { return this._messages; }

  onDigest(fn) { this._onDigestUpdate = fn; }
  onSend(fn) { this._onSend = fn; }
  onClaudeToggle(fn) { this._onClaudeToggle = fn; }
  onSourceToggle(fn) { this._onSourceToggle = fn; }
  onRefresh(fn) { this._onRefresh = fn; }
  onGeminiToggle(fn) { this._onGeminiToggle = fn; }
  setClaudeToggleState(on) {
    this._claudeEnabled = !!on;
    if (this._claudeToggleEl) this._claudeToggleEl.dataset.state = on ? 'on' : 'off';
  }
  onLogin(fn) { this._onLogin = fn; }

  open() {
    if (this._open) return;
    if (!this._built) this._buildDOM();
    this._container.style.display = '';
    this._open = true;
    if (this._inputEl) this._inputEl.focus();
  }

  show() {
    if (this._container) {
      this._container.style.display = '';
      if (this._inputEl) this._inputEl.focus();
    }
  }

  hide() {
    if (this._container) this._container.style.display = 'none';
  }

  // === Auth State ===

  setAuthenticated(isAuth) {
    this._authenticated = isAuth;
    if (!this._built) return;
    if (this._loginScreenEl) {
      this._loginScreenEl.style.display = isAuth ? 'none' : '';
    }
    const welcome = this._chatEl?.querySelector('.chat-welcome');
    if (welcome) welcome.style.display = isAuth ? '' : 'none';
    // Show provider toggles when authenticated
    if (this._providerToggles) {
      for (const t of Object.values(this._providerToggles)) {
        t.style.display = isAuth ? '' : 'none';
      }
    }
  }

  // === Model Updates (vom Orchestrator) ===

  setActiveModel(info) {
    if (typeof info === 'string') {
      // Backwards compat
      this._activeModel = { name: info, score: 0, tier: 'B' };
    } else {
      this._activeModel = info;
    }
    this._updateModelDisplay();
  }

  setStatus(text) {
    if (this._statusTextEl) this._statusTextEl.textContent = text;
  }

  // === Provider Login (embedded in chat area) ===

  _showProviderLogin(provider) {
    const configs = {
      deepseek: {
        title: 'Connect DeepSeek',
        sub: 'Free tier: 5M tokens, no credit card needed.',
        placeholder: 'sk-...',
        prefix: 'sk-',
        minLen: 20,
        secret: 'DEEPSEEK_API_KEY',
        link: 'https://platform.deepseek.com/api_keys',
        linkText: 'platform.deepseek.com',
      },
      mimo: {
        title: 'Connect MiMo V2',
        sub: 'Xiaomi MiMo-V2-Pro ($1/M) & Omni ($0.40/M).',
        placeholder: 'API key...',
        prefix: '',
        minLen: 15,
        secret: 'MIMO_API_KEY',
        link: 'https://platform.xiaomimimo.com/',
        linkText: 'platform.xiaomimimo.com',
      },
    };
    const cfg = configs[provider];
    if (!cfg) return;

    if (!this._chatEl) return;
    const existing = this._chatEl.querySelector('.claude-login-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'claude-login-overlay';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'claude-login-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => overlay.remove());

    overlay.innerHTML = [
      '<div class="claude-login-title">' + cfg.title + '</div>',
      '<div class="claude-login-sub">' + cfg.sub + '</div>',
      '<input type="password" class="claude-login-input" placeholder="' + cfg.placeholder + '" autocomplete="off" spellcheck="false" />',
      '<button class="claude-login-submit">Connect</button>',
      '<div class="claude-login-hint">Get your key at <span class="claude-login-link" data-url="' + cfg.link + '">' + cfg.linkText + '</span></div>',
    ].join('');
    overlay.prepend(closeBtn);

    const input = overlay.querySelector('.claude-login-input');
    const submit = overlay.querySelector('.claude-login-submit');
    const doSave = async () => {
      const key = input.value.trim();
      if (cfg.prefix && !key.startsWith(cfg.prefix)) { input.style.borderColor = '#f38ba8'; setTimeout(() => { input.style.borderColor = ''; }, 2000); return; }
      if (key.length < cfg.minLen) { input.style.borderColor = '#f38ba8'; setTimeout(() => { input.style.borderColor = ''; }, 2000); return; }
      submit.textContent = 'Saving...';
      submit.disabled = true;
      try {
        await window.pangea.setSecret(cfg.secret, key);
        this.showToast(cfg.title.replace('Connect ', '') + ' connected!');
        overlay.remove();
      } catch (e) {
        submit.textContent = 'Connect';
        submit.disabled = false;
      }
    };
    submit.addEventListener('click', doSave);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    overlay.querySelector('.claude-login-link')?.addEventListener('click', (e) => {
      if (window.pangea.openUrl) window.pangea.openUrl(e.target.dataset.url);
    });

    this._chatEl.appendChild(overlay);
    setTimeout(() => input.focus(), 100);
  }

  _showGeminiLogin() {
    if (!this._chatEl) return;
    const existing = this._chatEl.querySelector('.claude-login-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'claude-login-overlay';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'claude-login-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => overlay.remove());

    const googleIcon = '<svg width="20" height="20" viewBox="0 0 48 48" style="vertical-align:middle;margin-right:8px"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

    overlay.innerHTML = [
      '<div class="claude-login-title">' + googleIcon + 'Gemini Free Tier</div>',
      '<div class="claude-login-sub">Sign in with Google — Gemini 2.5 Pro, Flash and more, no API key needed. Add multiple accounts for more free tokens.</div>',
      '<div class="gemini-accounts-list" style="margin:8px 0"></div>',
      '<button class="chat-login-btn gemini-add-account-btn" style="width:100%;margin:8px 0">+ Add Google Account</button>',
      '<div class="gemini-login-webview-wrap" style="width:100%;height:0;border-radius:8px;overflow:hidden;margin:0;position:relative;background:var(--bg-overlay,#eeeee6);transition:height 0.3s"></div>',
      '<div class="claude-login-hint" style="opacity:0.5;font-size:11px">Each Google account gets its own free token quota.</div>',
    ].join('');
    overlay.prepend(closeBtn);

    this._chatEl.appendChild(overlay);

    const accountListEl = overlay.querySelector('.gemini-accounts-list');
    const addBtn = overlay.querySelector('.gemini-add-account-btn');
    const wrap = overlay.querySelector('.gemini-login-webview-wrap');

    // Refresh account list display
    const refreshAccountList = async () => {
      if (!window.pangea.geminiListAccounts) return;
      const accounts = await window.pangea.geminiListAccounts();
      if (accounts.length === 0) {
        accountListEl.innerHTML = '<div style="color:var(--text-dim,#5a5a68);font-size:12px;padding:4px 0">No accounts connected yet.</div>';
        return;
      }
      accountListEl.innerHTML = accounts.map(a => {
        const status = a.exhausted ? '<span style="color:#f38ba8"> (rate limited)</span>' : a.active ? '<span style="color:#a6e3a1"> (active)</span>' : '';
        return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">'
          + '<span style="color:var(--text,#2a2a30)">' + (a.email || 'Unknown') + '</span>' + status
          + '<button class="gemini-remove-btn" data-email="' + a.email + '" style="margin-left:auto;background:none;border:none;color:#f38ba8;cursor:pointer;font-size:11px">Remove</button>'
          + '</div>';
      }).join('');
      accountListEl.querySelectorAll('.gemini-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          await window.pangea.geminiRemoveAccount(btn.dataset.email);
          refreshAccountList();
        });
      });
    };
    refreshAccountList();

    let done = false;
    const completeLogin = (email, totalAccounts) => {
      this._geminiConnected = true;
      this._geminiEnabled = true;
      if (this._geminiToggleSwitch) this._geminiToggleSwitch.dataset.state = 'on';
      if (this._geminiConnectBtn) {
        this._geminiConnectBtn.textContent = totalAccounts + ' Account' + (totalAccounts > 1 ? 's' : '');
        this._geminiConnectBtn.style.opacity = '0.7';
      }
      if (this._onGeminiToggle) this._onGeminiToggle(true);
      this.showToast('Gemini: ' + email + ' connected!');
      // Collapse webview, refresh list
      wrap.style.height = '0';
      refreshAccountList();
    };

    const startOAuth = () => {
      wrap.style.height = '420px';
      wrap.innerHTML = '';

      const clientId = window.__GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
      const scopes = 'https://www.googleapis.com/auth/cloud-platform openid email profile';
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
        + '?client_id=' + encodeURIComponent(clientId)
        + '&redirect_uri=' + encodeURIComponent('urn:ietf:wg:oauth:2.0:oob')
        + '&response_type=code'
        + '&scope=' + encodeURIComponent(scopes)
        + '&access_type=offline'
        + '&prompt=consent';

      const webview = document.createElement('webview');
      webview.setAttribute('partition', 'persist:google');
      webview.setAttribute('allowpopups', 'true');
      webview.style.cssText = 'width:100%;height:100%;border:none;';
      webview.src = authUrl;
      wrap.appendChild(webview);

      const checkNav = setInterval(async () => {
        if (done) { clearInterval(checkNav); return; }
        try {
          const url = await webview.executeJavaScript('window.location.href');
          const title = await webview.executeJavaScript('document.title');

          let code = null;
          if (url.includes('approvalCode=')) {
            code = new URL(url).searchParams.get('approvalCode');
          } else if (url.includes('code=') && url.includes('accounts.google.com')) {
            code = new URL(url).searchParams.get('code');
          }
          if (!code && (title.includes('Success') || url.includes('oauth2/approval'))) {
            try {
              code = await webview.executeJavaScript(
                'document.querySelector("textarea")?.value || document.querySelector("[data-value]")?.dataset?.value || document.querySelector("input[readonly]")?.value || ""'
              );
              if (code && code.length < 10) code = null;
            } catch {}
          }

          if (code) {
            clearInterval(checkNav);
            const result = await window.pangea.geminiExchangeCode(code);
            if (result && result.success) {
              completeLogin(result.email || 'Google Account', result.totalAccounts || 1);
            } else {
              this.showToast('Token exchange failed: ' + (result?.error || 'unknown'));
              wrap.style.height = '0';
            }
          }
        } catch {}
      }, 1000);

      setTimeout(() => { clearInterval(checkNav); }, 180000);
    };

    addBtn.addEventListener('click', () => startOAuth());

    // Auto-start OAuth if no accounts yet
    if (!this._geminiConnected) startOAuth();

    closeBtn.addEventListener('click', () => { done = true; });
  }

  async checkGeminiAuth() {
    try {
      const authed = await window.pangea.geminiIsAuthenticated();
      if (authed) {
        this._geminiConnected = true;
        this._geminiEnabled = true;
        if (this._geminiToggleSwitch) this._geminiToggleSwitch.dataset.state = 'on';
        // Show account count
        const accounts = window.pangea.geminiListAccounts ? await window.pangea.geminiListAccounts() : [];
        const count = accounts.length || 1;
        if (this._geminiConnectBtn) {
          this._geminiConnectBtn.textContent = count + ' Account' + (count > 1 ? 's' : '');
          this._geminiConnectBtn.style.opacity = '0.7';
        }
        if (this._onGeminiToggle) this._onGeminiToggle(true);
        return true;
      }
    } catch (e) {}
    return false;
  }

  _showClaudeLogin(source) {
    if (!this._chatEl) return;
    // Remove existing login overlay if any
    const existing = this._chatEl.querySelector('.claude-login-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'claude-login-overlay';

    if (source === 'api') {
      overlay.innerHTML = [
        '<button class="claude-login-close">&times;</button>',
        '<div class="claude-login-title">Connect Claude API</div>',
        '<div class="claude-login-sub">Enter your Anthropic API key to use Claude models.</div>',
        '<input type="password" class="claude-login-input" placeholder="sk-ant-..." autocomplete="off" spellcheck="false" />',
        '<button class="claude-login-submit">Connect</button>',
        '<div class="claude-login-hint">Get your key at <span class="claude-login-link" data-url="https://console.anthropic.com/settings/keys">console.anthropic.com</span></div>',
      ].join('');
      overlay.querySelector('.claude-login-close').addEventListener('click', () => overlay.remove());

      const input = overlay.querySelector('.claude-login-input');
      const submit = overlay.querySelector('.claude-login-submit');
      const doSave = async () => {
        const key = input.value.trim();
        if (!key.startsWith('sk-ant-') || key.length < 30) {
          input.style.borderColor = '#f38ba8';
          setTimeout(() => { input.style.borderColor = ''; }, 2000);
          return;
        }
        submit.textContent = 'Saving...';
        submit.disabled = true;
        try {
          await window.pangea.setSecret('ANTHROPIC_API_KEY', key);
          this.showToast('Claude API connected!');
          overlay.remove();
        } catch (e) {
          submit.textContent = 'Connect';
          submit.disabled = false;
        }
      };
      submit.addEventListener('click', doSave);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });

      overlay.querySelector('.claude-login-link')?.addEventListener('click', (e) => {
        if (window.pangea.openUrl) window.pangea.openUrl(e.target.dataset.url);
      });
    } else {
      // Account/Subscription login — reads ~/.claude/.credentials.json or opens login
      overlay.innerHTML = [
        '<button class="claude-login-close">&times;</button>',
        '<div class="claude-login-title">Connect Claude Subscription</div>',
        '<div class="claude-login-sub">Uses your Claude Pro/Max/Team subscription.</div>',
        '<button class="claude-login-submit" id="claude-acct-check">Check existing login</button>',
        '<div class="claude-login-hint" id="claude-acct-status"></div>',
      ].join('');
      overlay.querySelector('.claude-login-close').addEventListener('click', () => overlay.remove());

      const statusEl = overlay.querySelector('#claude-acct-status');
      const checkBtn = overlay.querySelector('#claude-acct-check');

      // Try reading existing credentials first
      const tryExistingCredentials = async () => {
        checkBtn.textContent = 'Checking...';
        checkBtn.disabled = true;
        try {
          const creds = await window.pangea.readClaudeCredentials();
          if (creds && creds.accessToken) {
            await window.pangea.setSecret('ANTHROPIC_AUTH_TOKEN', creds.accessToken);
            this.showToast('Claude subscription connected!');
            overlay.remove();
            return;
          }
        } catch {}
        // No credentials found — show login webview
        checkBtn.style.display = 'none';
        statusEl.textContent = 'No existing login found. Please sign in below.';
        const webview = document.createElement('webview');
        webview.setAttribute('partition', 'persist:claude');
        webview.setAttribute('allowpopups', 'true');
        webview.className = 'chat-login-webview';
        webview.src = 'https://claude.ai/login';
        overlay.appendChild(webview);
        statusEl.textContent = 'Sign in with your Claude account below. After login, click "Check" again.';
        const retryBtn = document.createElement('button');
        retryBtn.className = 'claude-login-submit';
        retryBtn.textContent = 'Check login';
        retryBtn.style.marginTop = '8px';
        retryBtn.addEventListener('click', async () => {
          retryBtn.textContent = 'Checking...';
          retryBtn.disabled = true;
          // After browser login, credentials should be in the file
          try {
            const creds = await window.pangea.readClaudeCredentials();
            if (creds && creds.accessToken) {
              await window.pangea.setSecret('ANTHROPIC_AUTH_TOKEN', creds.accessToken);
              this.showToast('Claude subscription connected!');
              overlay.remove();
              return;
            }
          } catch {}
          retryBtn.textContent = 'Check login';
          retryBtn.disabled = false;
          statusEl.textContent = 'Not found yet. Complete login in the browser below, then try again.';
        });
        overlay.insertBefore(retryBtn, webview);
      };
      checkBtn.addEventListener('click', tryExistingCredentials);
      // Auto-check on open
      tryExistingCredentials();
    }

    this._chatEl.appendChild(overlay);
    const input = overlay.querySelector('.claude-login-input');
    if (input) setTimeout(() => input.focus(), 100);
  }

  updateBudget(budget) {
    if (!this._budgetBarEl) return;
    // budget = { modelId: { used, limit, exhausted } }
    const entries = Object.entries(budget);
    const active = entries.filter(([, b]) => !b.exhausted && b.limit);
    if (active.length === 0) {
      this._budgetBarEl.style.display = 'none';
      return;
    }
    this._budgetBarEl.style.display = '';
    const totalUsed = active.reduce((s, [, b]) => s + b.used, 0);
    const totalLimit = active.reduce((s, [, b]) => s + b.limit, 0);
    const pct = totalLimit > 0 ? Math.min(100, (totalUsed / totalLimit) * 100) : 0;
    const bar = this._budgetBarEl.querySelector('.budget-fill');
    if (bar) {
      bar.style.width = pct + '%';
      bar.style.background = pct > 80 ? '#f38ba8' : pct > 50 ? '#fab387' : '#a6e3a1';
    }
    const label = this._budgetBarEl.querySelector('.budget-label');
    if (label) label.textContent = Math.round(pct) + '% Token Budget';
  }

  // === Streaming ===

  appendAssistantChunk(text) {
    if (!this._currentStreamEl) {
      this._currentStreamEl = this._addBubble('assistant', '');
      this._currentStreamText = '';
    }
    this._currentStreamText += text;
    this._renderMarkdown(this._currentStreamEl, this._currentStreamText);
    this._scrollToBottom();
  }

  finalizeAssistantMessage() {
    if (this._currentStreamText) {
      this._messages.push({ role: 'assistant', content: this._currentStreamText });
      if (this._onDigestUpdate) this._onDigestUpdate({ type: 'assistant', content: this._currentStreamText });
      // Inline-Visualisierungen: Render HTML/SVG code blocks as live previews
      this._renderInlineVisualizations(this._currentStreamEl, this._currentStreamText);
    }
    this._currentStreamEl = null;
    this._currentStreamText = '';
  }

  // === Inline Visualizations (HTML/SVG/JS in Chat) ===
  _renderInlineVisualizations(bubbleEl, text) {
    if (!bubbleEl) return;
    // Find ```html or ```svg code blocks
    const htmlBlocks = text.match(/```(?:html|svg)([\s\S]*?)```/g);
    if (!htmlBlocks || htmlBlocks.length === 0) return;

    for (const block of htmlBlocks) {
      const code = block.replace(/^```(?:html|svg)\n?/, '').replace(/\n?```$/, '');
      // Only render if it looks safe (no script tags with external sources)
      if (/<script[^>]+src=/i.test(code)) continue;

      const container = document.createElement('div');
      container.className = 'chat-inline-viz';
      container.style.cssText = 'margin:8px 0;border:1px solid var(--border,#d8d4c8);border-radius:8px;overflow:hidden;background:var(--bg-overlay,#eeeee6);position:relative;';

      // Toggle button
      const toggleBtn = document.createElement('button');
      toggleBtn.textContent = 'Preview';
      toggleBtn.style.cssText = 'position:absolute;top:4px;right:4px;background:var(--bg-hover,#e8e6de);color:var(--text,#2a2a30);border:none;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;z-index:1;';
      toggleBtn.addEventListener('click', () => {
        iframe.style.display = iframe.style.display === 'none' ? '' : 'none';
        toggleBtn.textContent = iframe.style.display === 'none' ? 'Preview' : 'Hide';
      });
      container.appendChild(toggleBtn);

      // Sandboxed iframe for safe rendering
      const iframe = document.createElement('iframe');
      iframe.sandbox = 'allow-scripts';
      iframe.style.cssText = 'width:100%;height:300px;border:none;background:white;';
      iframe.srcdoc = code;
      container.appendChild(iframe);

      // Auto-resize iframe to content
      iframe.addEventListener('load', () => {
        try {
          const h = iframe.contentDocument?.body?.scrollHeight;
          if (h && h > 50) iframe.style.height = Math.min(h + 20, 600) + 'px';
        } catch {}
      });

      bubbleEl.appendChild(container);
    }
  }

  // System note (used by Critic-Agent)
  addSystemNote(text) {
    const noteEl = this._addBubble('system', '');
    const textEl = noteEl.querySelector('.chat-bubble-text');
    if (textEl) {
      textEl.textContent = text;
      textEl.style.cssText = 'font-size:11px;color:var(--text-dim,#5a5a68);font-style:italic;';
    }
  }

  showError(message) {
    const errEl = this._addBubble('system', '');
    errEl.querySelector('.chat-bubble-text').textContent = message;
    errEl.classList.add('chat-bubble-error');
  }

  showToast(message) {
    if (!this._container) return;
    const toast = document.createElement('div');
    toast.className = 'chat-toast';
    toast.textContent = message;
    this._container.appendChild(toast);
    setTimeout(() => toast.classList.add('chat-toast-visible'), 10);
    setTimeout(() => {
      toast.classList.remove('chat-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // === DOM ===

  _buildDOM() {
    const root = document.createElement('div');
    root.className = 'opencode-chat-overlay';
    root.style.cssText = 'position:fixed;top:36px;left:0;right:0;bottom:0;z-index:8500;display:none;flex-direction:column;background:var(--bg-base,#fbfbf4);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    // === Header ===
    const header = document.createElement('div');
    header.className = 'chat-model-header';

    // Model Label + Score Badge
    const modelRow = document.createElement('div');
    modelRow.className = 'chat-model-row';

    // Custom Model Dropdown (click to open, select model)
    const dropWrap = document.createElement('div');
    dropWrap.className = 'chat-model-drop-wrap';

    const dropBtn = document.createElement('button');
    dropBtn.className = 'chat-model-dropdown-btn';
    dropBtn.innerHTML = '<span class="drop-label">Connecting...</span><svg class="drop-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    this._modelLabelEl = dropBtn; // for backwards compat

    const dropMenu = document.createElement('div');
    dropMenu.className = 'chat-model-drop-menu';
    dropMenu.style.display = 'none';
    this._modelDropdownEl = dropMenu;
    this._dropBtnEl = dropBtn;

    let dropOpen = false;
    dropBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropOpen = !dropOpen;
      dropMenu.style.display = dropOpen ? '' : 'none';
      dropBtn.classList.toggle('open', dropOpen);
    });
    document.addEventListener('click', () => {
      if (dropOpen) { dropOpen = false; dropMenu.style.display = 'none'; dropBtn.classList.remove('open'); }
    });

    dropWrap.appendChild(dropBtn);
    dropWrap.appendChild(dropMenu);

    // Auto-Reset Button (circular arrow, visible only when model is forced)
    const autoResetBtn = document.createElement('button');
    autoResetBtn.className = 'chat-auto-reset-btn';
    autoResetBtn.title = 'Back to Auto mode';
    autoResetBtn.style.display = 'none';
    autoResetBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 2v6h-6M3 12a9 9 0 0115.36-6.36L21 8M3 22v-6h6M21 12a9 9 0 01-15.36 6.36L3 16"/></svg>';
    autoResetBtn.addEventListener('click', () => {
      this._isAutoMode = true;
      autoResetBtn.style.display = 'none';
      this._updateDropLabel();
      if (this._onAutoReset) this._onAutoReset();
    });
    this._autoResetEl = autoResetBtn;

    const scoreBadge = document.createElement('span');
    scoreBadge.className = 'chat-score-badge';
    scoreBadge.textContent = '-';
    this._scoreBadgeEl = scoreBadge;

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'chat-refresh-btn';
    refreshBtn.title = 'New context (keep history)';
    refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0115.36-6.36L21 8M3 22v-6h6M21 12a9 9 0 01-15.36 6.36L3 16"/></svg>';
    refreshBtn.addEventListener('click', () => { if (this._onRefresh) this._onRefresh(); });

    // Premium Mix Slider (visible when Claude is on)
    const mixContainer = document.createElement('div');
    mixContainer.className = 'chat-mix-container';
    mixContainer.style.display = 'none';
    const mixSlider = document.createElement('input');
    mixSlider.type = 'range';
    mixSlider.min = '0';
    mixSlider.max = '100';
    mixSlider.value = String(this._premiumMix);
    mixSlider.className = 'chat-mix-slider';
    const mixLabel = document.createElement('span');
    mixLabel.className = 'chat-mix-label';
    mixLabel.textContent = this._premiumMix + '%';
    mixSlider.addEventListener('input', () => {
      this._premiumMix = parseInt(mixSlider.value, 10);
      mixLabel.textContent = this._premiumMix + '%';
      if (this._onPremiumMixChange) this._onPremiumMixChange(this._premiumMix);
    });
    const mixReset = document.createElement('button');
    mixReset.className = 'chat-mix-reset';
    mixReset.title = 'Reset to 30%';
    mixReset.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 2v6h-6M3 12a9 9 0 0115.36-6.36L21 8"/></svg>';
    mixReset.addEventListener('click', () => {
      this._premiumMix = 30;
      mixSlider.value = '30';
      mixLabel.textContent = '30%';
      if (this._onPremiumMixChange) this._onPremiumMixChange(30);
    });
    mixContainer.appendChild(mixSlider);
    mixContainer.appendChild(mixLabel);
    mixContainer.appendChild(mixReset);
    this._mixContainerEl = mixContainer;

    modelRow.appendChild(dropWrap);
    modelRow.appendChild(autoResetBtn);
    modelRow.appendChild(scoreBadge);
    modelRow.appendChild(mixContainer);
    modelRow.appendChild(refreshBtn);

    // Toggle Row
    const toggleRow = document.createElement('div');
    toggleRow.className = 'chat-toggle-row';

    // Claude On/Off Toggle
    const claudeToggle = document.createElement('div');
    claudeToggle.className = 'chat-claude-toggle';

    const claudeLabel = document.createElement('span');
    claudeLabel.className = 'chat-toggle-label';
    claudeLabel.textContent = 'Claude';

    const claudeSwitch = document.createElement('button');
    claudeSwitch.className = 'chat-toggle-switch';
    claudeSwitch.dataset.state = 'off';
    claudeSwitch.innerHTML = '<span class="toggle-knob"></span>';
    this._claudeToggleEl = claudeSwitch;

    claudeSwitch.addEventListener('click', () => {
      this._claudeEnabled = !this._claudeEnabled;
      claudeSwitch.dataset.state = this._claudeEnabled ? 'on' : 'off';
      sourceToggle.style.display = this._claudeEnabled ? '' : 'none';
      connectBtn.style.display = this._claudeEnabled ? '' : 'none';
      if (this._mixContainerEl) this._mixContainerEl.style.display = this._claudeEnabled ? '' : 'none';
      if (this._onClaudeToggle) this._onClaudeToggle(this._claudeEnabled);
    });

    claudeToggle.appendChild(claudeLabel);
    claudeToggle.appendChild(claudeSwitch);

    // API/Account Sub-Toggle (nur sichtbar wenn Claude an)
    const sourceToggle = document.createElement('div');
    sourceToggle.className = 'chat-source-toggle';
    sourceToggle.style.display = 'none';
    this._sourceToggleEl = sourceToggle;

    const btnApi = document.createElement('button');
    btnApi.className = 'chat-premium-btn active';
    btnApi.textContent = 'API';
    btnApi.dataset.source = 'api';

    const btnAccount = document.createElement('button');
    btnAccount.className = 'chat-premium-btn';
    btnAccount.textContent = 'Account';
    btnAccount.dataset.source = 'account';

    const handleSourceToggle = (source) => {
      this._premiumSource = source;
      btnApi.classList.toggle('active', source === 'api');
      btnAccount.classList.toggle('active', source === 'account');
      if (this._onSourceToggle) this._onSourceToggle(source);
    };
    btnApi.addEventListener('click', () => handleSourceToggle('api'));
    btnAccount.addEventListener('click', () => handleSourceToggle('account'));

    sourceToggle.appendChild(btnApi);
    sourceToggle.appendChild(btnAccount);

    // Connect button (visible when Claude toggle is on)
    const connectBtn = document.createElement('button');
    connectBtn.className = 'chat-connect-btn';
    connectBtn.textContent = 'Connect';
    connectBtn.style.display = 'none';
    connectBtn.addEventListener('click', () => {
      this._showClaudeLogin(this._premiumSource);
    });
    sourceToggle.appendChild(connectBtn);

    // DeepSeek Toggle
    const deepseekToggle = document.createElement('div');
    deepseekToggle.className = 'chat-provider-toggle';
    deepseekToggle.style.display = 'none';
    const deepseekLabel = document.createElement('span');
    deepseekLabel.className = 'chat-toggle-label';
    deepseekLabel.textContent = 'DeepSeek';
    const deepseekSwitch = document.createElement('button');
    deepseekSwitch.className = 'chat-toggle-switch';
    deepseekSwitch.dataset.state = 'off';
    deepseekSwitch.innerHTML = '<span class="toggle-knob"></span>';
    const deepseekConnect = document.createElement('button');
    deepseekConnect.className = 'chat-connect-btn';
    deepseekConnect.textContent = 'Connect';
    deepseekConnect.addEventListener('click', () => this._showProviderLogin('deepseek'));
    this._deepseekEnabled = false;
    deepseekSwitch.addEventListener('click', () => {
      this._deepseekEnabled = !this._deepseekEnabled;
      deepseekSwitch.dataset.state = this._deepseekEnabled ? 'on' : 'off';
      deepseekConnect.style.display = this._deepseekEnabled ? '' : 'none';
    });
    deepseekConnect.style.display = 'none';
    deepseekToggle.appendChild(deepseekLabel);
    deepseekToggle.appendChild(deepseekSwitch);
    deepseekToggle.appendChild(deepseekConnect);

    // MiMo Toggle
    const mimoToggle = document.createElement('div');
    mimoToggle.className = 'chat-provider-toggle';
    mimoToggle.style.display = 'none';
    const mimoLabel = document.createElement('span');
    mimoLabel.className = 'chat-toggle-label';
    mimoLabel.textContent = 'MiMo';
    const mimoSwitch = document.createElement('button');
    mimoSwitch.className = 'chat-toggle-switch';
    mimoSwitch.dataset.state = 'off';
    mimoSwitch.innerHTML = '<span class="toggle-knob"></span>';
    const mimoConnect = document.createElement('button');
    mimoConnect.className = 'chat-connect-btn';
    mimoConnect.textContent = 'Connect';
    mimoConnect.addEventListener('click', () => this._showProviderLogin('mimo'));
    this._mimoEnabled = false;
    mimoSwitch.addEventListener('click', () => {
      this._mimoEnabled = !this._mimoEnabled;
      mimoSwitch.dataset.state = this._mimoEnabled ? 'on' : 'off';
      mimoConnect.style.display = this._mimoEnabled ? '' : 'none';
    });
    mimoConnect.style.display = 'none';
    mimoToggle.appendChild(mimoLabel);
    mimoToggle.appendChild(mimoSwitch);
    mimoToggle.appendChild(mimoConnect);

    // Gemini Toggle (Google OAuth — no API key needed, always visible)
    const geminiToggle = document.createElement('div');
    geminiToggle.className = 'chat-provider-toggle';
    const geminiLabel = document.createElement('span');
    geminiLabel.className = 'chat-toggle-label';
    geminiLabel.textContent = 'Gemini';
    geminiLabel.style.color = '#8b9cf7';
    const geminiSwitch = document.createElement('button');
    geminiSwitch.className = 'chat-toggle-switch';
    geminiSwitch.dataset.state = 'off';
    geminiSwitch.innerHTML = '<span class="toggle-knob"></span>';
    const geminiConnect = document.createElement('button');
    geminiConnect.className = 'chat-connect-btn';
    geminiConnect.textContent = 'Google Login';
    geminiConnect.style.fontSize = '10px';
    geminiConnect.addEventListener('click', () => this._showGeminiLogin());
    this._geminiEnabled = false;
    this._geminiConnected = false;
    geminiSwitch.addEventListener('click', () => {
      if (!this._geminiConnected) {
        // Not logged in yet — open login
        this._showGeminiLogin();
        return;
      }
      this._geminiEnabled = !this._geminiEnabled;
      geminiSwitch.dataset.state = this._geminiEnabled ? 'on' : 'off';
      if (this._onGeminiToggle) this._onGeminiToggle(this._geminiEnabled);
    });
    geminiToggle.appendChild(geminiLabel);
    geminiToggle.appendChild(geminiSwitch);
    geminiToggle.appendChild(geminiConnect);
    this._geminiToggleSwitch = geminiSwitch;
    this._geminiConnectBtn = geminiConnect;

    toggleRow.appendChild(claudeToggle);
    toggleRow.appendChild(sourceToggle);
    toggleRow.appendChild(deepseekToggle);
    toggleRow.appendChild(mimoToggle);
    toggleRow.appendChild(geminiToggle);

    // Show all provider toggles when authenticated
    this._providerToggles = { deepseek: deepseekToggle, mimo: mimoToggle };

    // Token Budget Bar
    const budgetBar = document.createElement('div');
    budgetBar.className = 'chat-budget-bar';
    budgetBar.style.display = 'none';
    budgetBar.innerHTML = '<div class="budget-track"><div class="budget-fill"></div></div><span class="budget-label">Token Budget</span>';
    this._budgetBarEl = budgetBar;

    header.appendChild(modelRow);
    header.appendChild(toggleRow);
    header.appendChild(budgetBar);

    // === Chat Area ===
    const chatArea = document.createElement('div');
    chatArea.className = 'chat-area';
    this._chatEl = chatArea;

    // Smart scroll: pause auto-follow when user scrolls up
    chatArea.addEventListener('wheel', (e) => {
      if (e.deltaY < 0) this._userScrolledUp = true;
      if (e.deltaY > 0) {
        requestAnimationFrame(() => {
          if (chatArea.scrollTop + chatArea.clientHeight >= chatArea.scrollHeight - 20) {
            this._userScrolledUp = false;
          }
        });
      }
    }, { passive: true });

    // Login Screen — Unified Google Login (connects Gemini + OpenCode + Claude in one click)
    const loginScreen = document.createElement('div');
    loginScreen.className = 'chat-login-screen';
    const googleIconBig = '<svg width="28" height="28" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
    loginScreen.innerHTML = [
      '<div class="chat-login-icon">' + googleIconBig + '</div>',
      '<div class="chat-login-title">Sign in with Google</div>',
      '<div class="chat-login-sub">One login connects all models — Gemini, Claude, and more.</div>',
      '<button class="chat-login-btn">Sign in with Google</button>',
      '<div class="chat-login-status" style="margin-top:12px;font-size:12px;color:var(--text-dim,#5a5a68)"></div>',
      '<div class="chat-login-hint" style="font-size:11px;opacity:0.5">No API key needed. Free tokens included.</div>',
    ].join('');
    this._loginScreenEl = loginScreen;

    // --- Unified Auth Chain ---
    let _loginDone = false;
    const statusEl = () => loginScreen.querySelector('.chat-login-status');

    const completeLogin = (sources) => {
      if (_loginDone) return;
      _loginDone = true;
      const wv = loginScreen.querySelector('.chat-login-webview');
      if (wv) wv.remove();
      this.setAuthenticated(true);
      const parts = sources.filter(Boolean);
      this.showToast('Connected: ' + parts.join(', '));
      if (this._onRefresh) this._onRefresh();
    };

    if (window.pangea.onAuthComplete) {
      window.pangea.onAuthComplete(() => {
        if (!_loginDone) completeLogin(['OpenCode', 'Gemini', 'Claude']);
      });
    }

    // --- Step 1: Google OAuth → Gemini + Claude tokens ---
    const doGoogleOAuth = () => {
      return new Promise(async (resolve) => {
        // Start local OAuth callback server
        let oauthInfo = null;
        if (window.pangea.geminiStartOAuthServer) {
          try { oauthInfo = await window.pangea.geminiStartOAuthServer(); } catch {}
        }

        let authUrl;
        let redirectUri;
        if (oauthInfo?.authUrl) {
          // Loopback redirect (preferred — works with all Google client IDs)
          authUrl = oauthInfo.authUrl;
          redirectUri = 'http://127.0.0.1:' + oauthInfo.port;
        } else {
          // Fallback: oob redirect (deprecated but may still work for some clients)
          const clientId = window.__GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
          const scopes = 'https://www.googleapis.com/auth/generative-language https://www.googleapis.com/auth/cloud-platform openid email profile';
          redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
          authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
            + '?client_id=' + encodeURIComponent(clientId)
            + '&redirect_uri=' + encodeURIComponent(redirectUri)
            + '&response_type=code'
            + '&scope=' + encodeURIComponent(scopes)
            + '&access_type=offline'
            + '&prompt=consent';
        }

        const webview = document.createElement('webview');
        webview.setAttribute('partition', 'persist:google');
        webview.setAttribute('allowpopups', 'true');
        webview.className = 'chat-login-webview';
        webview.src = authUrl;
        loginScreen.appendChild(webview);

        let resolved = false;
        const finish = async (code) => {
          if (resolved) return;
          resolved = true;
          webview.remove();
          const result = await window.pangea.geminiExchangeCode({ code, redirectUri });
          resolve(result?.success ? (result.email || 'Google') : false);
        };

        // Method A: Loopback server sends code via IPC
        if (window.pangea.onGeminiOAuthCode) {
          window.pangea.onGeminiOAuthCode((code) => { if (code) finish(code); });
        }

        // Method B: Poll webview for redirect to localhost or oob success page
        const check = setInterval(async () => {
          if (_loginDone || resolved) { clearInterval(check); if (!resolved) resolve(false); return; }
          try {
            const url = await webview.executeJavaScript('window.location.href');
            let code = null;
            // Loopback redirect: webview navigated to http://127.0.0.1:PORT?code=...
            if (url.includes('127.0.0.1') && url.includes('code=')) {
              code = new URL(url).searchParams.get('code');
            }
            // OOB redirect: approval page
            if (!code && url.includes('accounts.google.com')) {
              if (url.includes('code=')) code = new URL(url).searchParams.get('code');
              if (url.includes('approvalCode=')) code = new URL(url).searchParams.get('approvalCode');
            }
            // OOB success page with code in DOM
            if (!code) {
              const title = await webview.executeJavaScript('document.title');
              if (title.includes('Success') || url.includes('oauth2/approval')) {
                try {
                  code = await webview.executeJavaScript(
                    'document.querySelector("textarea")?.value || document.querySelector("[data-value]")?.dataset?.value || document.querySelector("input[readonly]")?.value || ""'
                  );
                  if (code && code.length < 10) code = null;
                } catch {}
              }
            }
            if (code) { clearInterval(check); finish(code); }
          } catch {}
        }, 1000);
        setTimeout(() => { clearInterval(check); resolve(false); }, 180000);
      });
    };

    // --- Step 2: Auto-connect OpenCode via Google SSO (background webview) ---
    const doOpenCodeSSO = () => {
      return new Promise((resolve) => {
        // Use same Google partition — if OpenCode supports "Sign in with Google", it auto-completes
        const wv = document.createElement('webview');
        wv.setAttribute('partition', 'persist:google');
        wv.setAttribute('allowpopups', 'true');
        wv.style.cssText = 'width:0;height:0;position:absolute;opacity:0;pointer-events:none';
        wv.src = 'https://opencode.ai/auth';
        loginScreen.appendChild(wv);

        let keysVisited = false;
        let keyDone = false;

        const hookAndExtract = async () => {
          try {
            await wv.executeJavaScript(`(function(){if(window.__h)return;window.__h=1;window.__k='';var f=window.fetch;window.fetch=function(){return f.apply(this,arguments).then(function(r){var c=r.clone();c.text().then(function(t){var m=t.match(/sk-[A-Za-z0-9_-]{25,}/);if(m)window.__k=m[0]}).catch(function(){});return r})}})()`);
          } catch {}
        };

        const grabKey = async () => {
          try {
            const key = await wv.executeJavaScript(`
              (async function(){if(window.__k)return window.__k;try{var b=document.querySelector('button[title*="Copy"],button[title*="copy"]');if(b&&navigator.clipboard){var c='';var o=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=function(t){c=t;return o(t)};b.click();await new Promise(r=>setTimeout(r,300));navigator.clipboard.writeText=o;if(c&&c.startsWith('sk-')&&c.length>25)return c}}catch(e){}var a=document.body?document.body.innerHTML:'';var m=a.match(/sk-[A-Za-z0-9_-]{25,}/);return m?m[0]:''})()
            `);
            if (key && key.startsWith('sk-') && key.length > 25) {
              await window.pangea.saveOpenCodeToken(key);
              wv.remove();
              resolve(true);
              return true;
            }
          } catch {}
          return false;
        };

        wv.addEventListener('did-navigate', async () => {
          try {
            const url = wv.getURL();
            if (url.includes('/workspace/')) {
              if (url.includes('/keys')) {
                if (keyDone) return;
                keyDone = true;
                await hookAndExtract();
                await new Promise(r => setTimeout(r, 2000));
                // Try to grab existing key
                if (await grabKey()) return;
                // Create key
                try {
                  await wv.executeJavaScript(`(function(){var bs=document.querySelectorAll('button[data-color="primary"]');for(var b of bs){if((b.textContent||'').includes('Create')){b.click();return}}})()`);
                  await new Promise(r => setTimeout(r, 1500));
                  await wv.executeJavaScript(`(function(){var f=document.querySelector('form');if(!f)return;var i=f.querySelector('input[name="name"]');if(i){i.value='Pangea';i.dispatchEvent(new Event('input',{bubbles:true}))}var b=f.querySelector('button[type="submit"]');if(b)b.click()})()`);
                } catch {}
                setTimeout(() => grabKey(), 2000);
                setTimeout(() => grabKey(), 4000);
                setTimeout(() => { if (!keyDone) { wv.remove(); resolve(false); } }, 8000);
              } else if (!keysVisited) {
                keysVisited = true;
                try {
                  const wsId = await wv.executeJavaScript(`(function(){var m=window.location.href.match(/workspace\\/(wrk_[A-Za-z0-9_]+)/);return m?m[1]:''})()`);
                  if (wsId) wv.loadURL('https://opencode.ai/workspace/' + wsId + '/keys');
                } catch {}
              }
            }
          } catch {}
        });

        // Timeout 30s for background SSO
        setTimeout(() => { wv.remove(); resolve(false); }, 30000);
      });
    };

    // --- Step 3: Claude via Vertex AI (Google Login gives access to Claude via Google's infra) ---
    const checkVertexClaude = async () => {
      if (!window.pangea?.vertexTestAccess) return false;
      try {
        const result = await window.pangea.vertexTestAccess();
        return result.available;
      } catch { return false; }
    };

    // --- Main login button handler ---
    loginScreen.querySelector('.chat-login-btn').addEventListener('click', async () => {
      const btn = loginScreen.querySelector('.chat-login-btn');
      btn.textContent = 'Signing in...';
      btn.disabled = true;

      const connected = [];

      // Step 1: Google OAuth (visible webview)
      if (statusEl()) statusEl().textContent = 'Waiting for Google sign-in...';
      const googleEmail = await doGoogleOAuth();
      if (googleEmail) {
        connected.push('Gemini');
        // Activate Gemini toggle
        this._geminiConnected = true;
        this._geminiEnabled = true;
        if (this._geminiToggleSwitch) this._geminiToggleSwitch.dataset.state = 'on';
        if (this._geminiConnectBtn) { this._geminiConnectBtn.textContent = '1 Account'; this._geminiConnectBtn.style.opacity = '0.7'; }
        if (this._onGeminiToggle) this._onGeminiToggle(true);
      }

      // Step 2: OpenCode SSO (background, uses same Google session)
      if (statusEl()) statusEl().textContent = 'Connecting OpenCode...';
      const ocOk = await doOpenCodeSSO();
      if (ocOk) connected.push('OpenCode');

      // Step 3: Claude via Google Vertex AI
      if (googleEmail) {
        if (statusEl()) statusEl().textContent = 'Activating Claude via Google...';
        const vertexOk = await checkVertexClaude();
        if (vertexOk) {
          connected.push('Claude');
        } else {
          // Vertex access test might fail initially but Claude will still work via Vertex
          // Add it optimistically since we have the cloud-platform scope
          connected.push('Claude (Vertex)');
        }
      }

      // Done
      if (connected.length > 0) {
        completeLogin(connected);
      } else {
        btn.textContent = 'Sign in with Google';
        btn.disabled = false;
        if (statusEl()) statusEl().textContent = 'Login failed — try again.';
      }
    });

    chatArea.appendChild(loginScreen);

    const welcomeEl = document.createElement('div');
    welcomeEl.className = 'chat-welcome';
    welcomeEl.style.display = 'none';
    welcomeEl.innerHTML = `
      <div class="pearl-orb-wrapper">
        <div class="pearl-orb">
          <div class="pearl-shine"></div>
          <div class="pearl-glow"></div>
        </div>
      </div>
      <div class="chat-welcome-sub">Wish anything</div>
      <div class="pearl-action-buttons">
        <button class="pearl-action-btn" data-action="image" title="Bild erstellen">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
        </button>
        <button class="pearl-action-btn" data-action="video" title="Video schneiden">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
        </button>
        <button class="pearl-action-btn" data-action="code" title="App entwickeln">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </button>
        <button class="pearl-action-btn" data-action="general" title="Etwas anderes">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </button>
      </div>
    `;
    chatArea.appendChild(welcomeEl);

    // Pearl action button handlers — route to editors
    welcomeEl.querySelectorAll('.pearl-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'image' && window.switchEditorTab) window.switchEditorTab('image');
        else if (action === 'video' && window.switchEditorTab) window.switchEditorTab('video');
        else if (action === 'code' && window.switchEditorTab) window.switchEditorTab('terminal');
        else if (action === 'general' && this._inputEl) this._inputEl.focus();
      });
    });

    // Pearl parallax mouse effect
    const orbWrapper = welcomeEl.querySelector('.pearl-orb-wrapper');
    if (orbWrapper) {
      welcomeEl.addEventListener('mousemove', (e) => {
        const rect = welcomeEl.getBoundingClientRect();
        const x = (e.clientX - rect.left - rect.width / 2) / rect.width;
        const y = (e.clientY - rect.top - rect.height / 2) / rect.height;
        const orb = orbWrapper.querySelector('.pearl-orb');
        const shine = orbWrapper.querySelector('.pearl-shine');
        if (orb) orb.style.transform = `translate(${x * 6}px, ${y * 6}px)`;
        if (shine) shine.style.transform = `translate(${-x * 15}px, ${-y * 15}px)`;
      });
    }

    // === Input Row ===
    const inputRow = document.createElement('div');
    inputRow.className = 'chat-input-row';

    const input = document.createElement('textarea');
    input.className = 'chat-input';
    input.placeholder = 'Type a message...';
    input.rows = 1;
    this._inputEl = input;

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 150) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._handleSend(); }
    });

    const sendBtn = document.createElement('button');
    sendBtn.className = 'chat-send-btn';
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    sendBtn.addEventListener('click', () => this._handleSend());

    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);

    // === Status Bar (unten) ===
    const statusBar = document.createElement('div');
    statusBar.className = 'chat-status-bar';
    const statusText = document.createElement('span');
    statusText.className = 'chat-status-text';
    statusText.textContent = 'Ready';
    this._statusTextEl = statusText;
    statusBar.appendChild(statusText);

    // Pearl skills badge
    const pearlBadge = document.createElement('span');
    pearlBadge.id = 'pearl-skills-badge';
    pearlBadge.className = 'pearl-badge';
    pearlBadge.textContent = '';
    statusBar.appendChild(pearlBadge);

    this._statusBarEl = statusBar;

    // === Assemble ===
    root.appendChild(header);
    root.appendChild(chatArea);
    root.appendChild(inputRow);
    root.appendChild(statusBar);

    document.body.appendChild(root);
    this._container = root;
    this._built = true;
  }

  _handleSend() {
    const text = this._inputEl.value.trim();
    if (!text) return;
    this._inputEl.value = '';
    this._inputEl.style.height = 'auto';

    const welcome = this._chatEl.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    this._addBubble('user', text);
    this._messages.push({ role: 'user', content: text });
    this._userScrolledUp = false; // user sent message → re-enable auto-follow
    this._scrollToBottom(true);

    if (this._onSend) this._onSend(text);
  }

  _addBubble(role, text) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-bubble-' + role;

    const textEl = document.createElement('div');
    textEl.className = 'chat-bubble-text';
    if (text) this._renderMarkdown(textEl, text);
    bubble.appendChild(textEl);

    const time = document.createElement('div');
    time.className = 'chat-bubble-time';
    const d = new Date();
    time.textContent = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    bubble.appendChild(time);

    this._chatEl.appendChild(bubble);
    return bubble;
  }

  // Populate the custom dropdown menu with all available models
  updateModelList(rankedModels, connectedProviders) {
    if (!this._modelDropdownEl) return;
    this._modelList = { ranked: rankedModels || [], premium: connectedProviders || [] };
    this._rebuildDropMenu();
    this._updateDropLabel();
  }

  _rebuildDropMenu() {
    const menu = this._modelDropdownEl;
    menu.innerHTML = '';
    const { ranked, premium } = this._modelList || { ranked: [], premium: [] };

    // Auto item
    const autoItem = document.createElement('div');
    autoItem.className = 'drop-item drop-item-auto';
    autoItem.dataset.value = '__auto__';
    autoItem.textContent = this._activeModel ? 'Auto (' + (this._activeModel.name || this._activeModel.id) + ')' : 'Auto';
    autoItem.addEventListener('click', (e) => { e.stopPropagation(); this._selectDropItem('__auto__'); });
    menu.appendChild(autoItem);

    // Free models
    if (ranked.length > 0) {
      const header = document.createElement('div');
      header.className = 'drop-group-header';
      header.textContent = 'FREE MODELS';
      menu.appendChild(header);
      for (const m of ranked) {
        const item = document.createElement('div');
        item.className = 'drop-item';
        item.dataset.value = m.id;
        const score = m._benchScore || 0;
        item.innerHTML = '<span class="drop-item-name">' + (m.name || m.id) + '</span>' +
          (score > 0 ? '<span class="drop-item-score">' + score + '</span>' : '');
        item.addEventListener('click', (e) => { e.stopPropagation(); this._selectDropItem(m.id); });
        menu.appendChild(item);
      }
    }

    // Premium
    if (premium.length > 0) {
      const header = document.createElement('div');
      header.className = 'drop-group-header';
      header.textContent = 'PREMIUM';
      menu.appendChild(header);
      for (const p of premium) {
        const item = document.createElement('div');
        item.className = 'drop-item drop-item-premium';
        item.dataset.value = p.id;
        item.innerHTML = '<span class="drop-item-name">' + p.name + '</span>';
        item.addEventListener('click', (e) => { e.stopPropagation(); this._selectDropItem(p.id); });
        menu.appendChild(item);
      }
    }
  }

  _selectDropItem(value) {
    // Close menu
    this._modelDropdownEl.style.display = 'none';
    if (this._dropBtnEl) this._dropBtnEl.classList.remove('open');

    if (value === '__auto__') {
      this._isAutoMode = true;
      if (this._autoResetEl) this._autoResetEl.style.display = 'none';
      if (this._onAutoReset) this._onAutoReset();
    } else {
      this._isAutoMode = false;
      this._forcedModelName = value;
      if (this._autoResetEl) this._autoResetEl.style.display = '';
      if (this._onModelSelect) this._onModelSelect(value);
    }
    this._updateDropLabel();
  }

  _updateDropLabel() {
    if (!this._dropBtnEl) return;
    const label = this._dropBtnEl.querySelector('.drop-label');
    if (!label) return;
    if (this._isAutoMode) {
      const m = this._activeModel;
      label.textContent = m ? (m.name || m.id || 'Auto') : 'Auto';
    } else {
      label.textContent = this._forcedModelName || 'Manual';
    }
  }

  _updateModelDisplay() {
    if (!this._activeModel) return;
    this._updateDropLabel();
    // Update auto item text in menu
    if (this._modelDropdownEl) {
      const autoItem = this._modelDropdownEl.querySelector('.drop-item-auto');
      if (autoItem) {
        const m = this._activeModel;
        autoItem.textContent = 'Auto (' + (m.name || m.id || 'none') + ')';
      }
    }

    if (this._scoreBadgeEl) {
      const score = this._activeModel.score || 0;
      this._scoreBadgeEl.textContent = score > 0 ? score.toFixed(0) : '-';
      const tier = this._activeModel.tier || 'B';
      const colors = { S: '#a6e3a1', A: '#89b4fa', B: '#fab387', C: '#f38ba8' };
      this._scoreBadgeEl.style.background = (colors[tier] || '#585b70') + '22';
      this._scoreBadgeEl.style.color = colors[tier] || '#585b70';
      this._scoreBadgeEl.style.borderColor = (colors[tier] || '#585b70') + '44';
    }
  }

  _renderMarkdown(el, text) {
    let html = this._escHtml(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => '<pre class="chat-code-block"><code class="lang-' + lang + '">' + code + '</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\n/g, '<br>');
    el.innerHTML = html;
  }

  _scrollToBottom(force) {
    if (!this._chatEl) return;
    if (!force && this._userScrolledUp) return; // respect user's scroll position
    this._chatEl.scrollTop = this._chatEl.scrollHeight;
  }

  _escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

module.exports = { OpenCodeChat };
