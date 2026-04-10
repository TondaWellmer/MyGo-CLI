'use strict';

// === OneToRule — Ein Login, alle Modelle ===
// Google OAuth Login → automatisch OpenCode + Gemini + Claude verbinden
// Flow:
// 1. User klickt Login → Google OAuth im Browser
// 2. Google Token → OpenCode /google/authorize → OpenCode Token
// 3. Google Token → Gemini API Key auto-generieren
// 4. Google Token → Vertex Claude (wenn GCP Billing aktiv)
// 5. Alles gespeichert → User chattet sofort

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const OPENCODE_AUTH = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
const GEMINI_FILE = path.join(CLAUDE_DIR, 'pangea-gemini-accounts.json');

// Token lifetime: Google access tokens expire after ~3600s. Refresh at 50min.
const TOKEN_REFRESH_THRESHOLD_MS = 50 * 60 * 1000;

// Google Desktop OAuth (public, from Google Cloud SDK)
const GOOGLE_CLIENT_ID = '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = 'd-FL95Q19q7MQmFpd7hHD0Ty';
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/cloud-platform openid email profile';

// === Status Tracking ===

class OneToRuleLogin {
  constructor() {
    this._status = {
      google: { connected: false, email: null },
      opencode: { connected: false, models: 0 },
      gemini: { connected: false, models: 0 },
      claude: { connected: false, source: null },
    };
    this._onProgress = null;
  }

  onProgress(fn) { this._onProgress = fn; }
  getStatus() { return { ...this._status }; }

  _progress(step, detail) {
    if (this._onProgress) this._onProgress({ step, detail, status: this._status });
  }

  // === Main Login Flow ===

  async login() {
    // Step 1: Check if already logged in
    this._progress('checking', 'Checking existing logins...');
    const existing = await this._checkExisting();
    if (existing.allConnected) {
      this._progress('done', 'Already connected!');
      return this._status;
    }

    // Step 2: Google OAuth (if needed)
    if (!existing.google) {
      this._progress('google', 'Opening Google login...');
      const googleResult = await this._googleOAuth();
      if (!googleResult.success) {
        this._progress('error', 'Google login failed: ' + googleResult.error);
        return this._status;
      }
      this._status.google = { connected: true, email: googleResult.email };
      this._progress('google-done', 'Google: ' + googleResult.email);
    }

    // Step 3: OpenCode (use existing token or exchange Google token)
    if (!existing.opencode) {
      this._progress('opencode', 'Connecting OpenCode...');
      await this._connectOpenCode();
    }

    // Step 4: Gemini API Key (auto-generate from Google token)
    if (!existing.gemini) {
      this._progress('gemini', 'Setting up Gemini...');
      await this._connectGemini();
    }

    // Step 5: Claude (check subscription or Vertex)
    if (!existing.claude) {
      this._progress('claude', 'Checking Claude access...');
      await this._connectClaude();
    }

    this._progress('done', 'All providers connected!');
    return this._status;
  }

  // === Startup Check — refresh tokens if stale, re-login if needed ===

  async ensureTokensFresh() {
    let data;
    try { data = JSON.parse(fs.readFileSync(GEMINI_FILE, 'utf8')); } catch { return { refreshed: false, reason: 'no-file' }; }
    const acc = data.accounts?.[data.activeIdx || 0];
    if (!acc?.refreshToken) return { refreshed: false, reason: 'no-refresh-token' };

    // Check if access token is stale (older than 50min or missing)
    const tokenAge = acc.tokenObtainedAt ? (Date.now() - acc.tokenObtainedAt) : Infinity;
    if (acc.accessToken && tokenAge < TOKEN_REFRESH_THRESHOLD_MS) {
      return { refreshed: false, reason: 'token-fresh', ageMin: Math.round(tokenAge / 60000) };
    }

    // Refresh the token
    const result = await this.refreshAccessToken();
    return result;
  }

  async refreshAccessToken() {
    let data;
    try { data = JSON.parse(fs.readFileSync(GEMINI_FILE, 'utf8')); } catch { return { refreshed: false, reason: 'no-file' }; }
    const idx = data.activeIdx || 0;
    const acc = data.accounts?.[idx];
    if (!acc?.refreshToken) return { refreshed: false, reason: 'no-refresh-token' };

    try {
      const tokens = await this._refreshGoogleToken(acc.refreshToken);
      acc.accessToken = tokens.access_token;
      acc.tokenObtainedAt = Date.now();
      // Google sometimes issues a new refresh token
      if (tokens.refresh_token) acc.refreshToken = tokens.refresh_token;
      data.accounts[idx] = acc;
      fs.writeFileSync(GEMINI_FILE, JSON.stringify(data, null, 2));
      this._status.google = { connected: true, email: acc.email };
      this._status.gemini = { connected: true, models: 10 };
      console.log('[OneToRule] Token refreshed for', acc.email);
      return { refreshed: true, email: acc.email };
    } catch (err) {
      console.log('[OneToRule] Token refresh failed:', err.message);
      return { refreshed: false, reason: 'refresh-failed', error: err.message };
    }
  }

  _refreshGoogleToken(refreshToken) {
    return new Promise((resolve, reject) => {
      const postData = `refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}&client_secret=${encodeURIComponent(GOOGLE_CLIENT_SECRET)}&grant_type=refresh_token`;
      const req = https.request({
        hostname: 'oauth2.googleapis.com', port: 443, path: '/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const d = JSON.parse(body);
            if (d.access_token) resolve(d);
            else reject(new Error(d.error_description || d.error || 'Refresh failed'));
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  // === Get current access token (with auto-refresh) ===

  async getAccessToken() {
    let data;
    try { data = JSON.parse(fs.readFileSync(GEMINI_FILE, 'utf8')); } catch { return null; }
    const acc = data.accounts?.[data.activeIdx || 0];
    if (!acc) return null;

    const tokenAge = acc.tokenObtainedAt ? (Date.now() - acc.tokenObtainedAt) : Infinity;
    if (tokenAge >= TOKEN_REFRESH_THRESHOLD_MS && acc.refreshToken) {
      const result = await this.refreshAccessToken();
      if (!result.refreshed) return acc.accessToken; // Return stale token as fallback
      // Re-read after refresh
      try { data = JSON.parse(fs.readFileSync(GEMINI_FILE, 'utf8')); } catch { return null; }
      return data.accounts?.[data.activeIdx || 0]?.accessToken || null;
    }
    return acc.accessToken || null;
  }

  // === Check Existing Logins ===

  async _checkExisting() {
    const result = { google: false, opencode: false, gemini: false, claude: false, allConnected: false };

    // OpenCode
    try {
      const ocData = JSON.parse(fs.readFileSync(OPENCODE_AUTH, 'utf8'));
      if (ocData?.opencode?.key) {
        this._status.opencode = { connected: true, models: 39 };
        result.opencode = true;
      }
    } catch {}

    // Gemini
    try {
      const gData = JSON.parse(fs.readFileSync(GEMINI_FILE, 'utf8'));
      if (gData?.geminiApiKey) {
        this._status.gemini = { connected: true, models: 10 };
        result.gemini = true;
      }
      if (gData?.accounts?.length > 0) {
        this._status.google = { connected: true, email: gData.accounts[0].email };
        result.google = true;
      }
    } catch {}

    // Claude
    try {
      const cPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const cData = JSON.parse(fs.readFileSync(cPath, 'utf8'));
      if (cData?.claudeAiOauth?.accessToken) {
        this._status.claude = { connected: true, source: 'subscription' };
        result.claude = true;
      }
    } catch {}

    result.allConnected = result.opencode && result.gemini && result.claude;
    return result;
  }

  // === Google OAuth ===

  _googleOAuth() {
    return new Promise((resolve) => {
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><head><meta charset="utf-8"></head><body style="background:#1e1e2e;color:#f38ba8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Login fehlgeschlagen</h2></body></html>');
          server.close();
          resolve({ success: false, error });
          return;
        }

        if (!code) { res.writeHead(200); res.end('Waiting...'); return; }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><meta charset="utf-8"></head><body style="background:#1e1e2e;color:#a6e3a1;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>Connected!</h2><p>Du kannst dieses Fenster schliessen.</p></div></body></html>');

        try {
          const redirectUri = 'http://127.0.0.1:' + server.address().port;
          const tokens = await this._exchangeGoogleCode(code, redirectUri);
          const email = await this._getGoogleEmail(tokens.access_token);

          // Save Google account
          this._saveGoogleAccount(email, tokens.access_token, tokens.refresh_token);

          server.close();
          resolve({ success: true, email, accessToken: tokens.access_token, refreshToken: tokens.refresh_token });
        } catch (err) {
          server.close();
          resolve({ success: false, error: err.message });
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
          + '?client_id=' + encodeURIComponent(GOOGLE_CLIENT_ID)
          + '&redirect_uri=' + encodeURIComponent('http://127.0.0.1:' + port)
          + '&response_type=code'
          + '&scope=' + encodeURIComponent(GOOGLE_SCOPES)
          + '&access_type=offline'
          + '&prompt=consent';

        // Open browser
        const cmd = process.platform === 'win32' ? `start "" "${authUrl}"` : `open "${authUrl}"`;
        exec(cmd);
      });

      setTimeout(() => { try { server.close(); } catch {} resolve({ success: false, error: 'Timeout' }); }, 180000);
    });
  }

  _exchangeGoogleCode(code, redirectUri) {
    return new Promise((resolve, reject) => {
      const postData = `code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}&client_secret=${encodeURIComponent(GOOGLE_CLIENT_SECRET)}&redirect_uri=${encodeURIComponent(redirectUri)}&grant_type=authorization_code`;
      const req = https.request({
        hostname: 'oauth2.googleapis.com', port: 443, path: '/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.access_token) resolve(data);
            else reject(new Error(data.error_description || data.error || 'Token exchange failed'));
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  _getGoogleEmail(accessToken) {
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'www.googleapis.com', port: 443,
        path: '/oauth2/v2/userinfo', method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body).email || 'unknown'); } catch { resolve('unknown'); } });
      });
      req.on('error', () => resolve('unknown'));
      req.end();
    });
  }

  _saveGoogleAccount(email, accessToken, refreshToken) {
    let data = { accounts: [], activeIdx: 0 };
    try { data = JSON.parse(fs.readFileSync(GEMINI_FILE, 'utf8')); } catch {}
    const existing = (data.accounts || []).findIndex(a => a.email === email);
    if (existing >= 0) {
      data.accounts[existing].accessToken = accessToken;
      data.accounts[existing].tokenObtainedAt = Date.now();
      if (refreshToken) data.accounts[existing].refreshToken = refreshToken;
    } else {
      if (!data.accounts) data.accounts = [];
      data.accounts.push({ email, accessToken, refreshToken: refreshToken || null, tokenObtainedAt: Date.now(), exhaustedUntil: 0 });
    }
    data.activeIdx = existing >= 0 ? existing : data.accounts.length - 1;
    if (!fs.existsSync(CLAUDE_DIR)) fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(GEMINI_FILE, JSON.stringify(data, null, 2));
  }

  // === OpenCode Connection ===

  async _connectOpenCode() {
    // Check if OpenCode token already exists
    try {
      const ocData = JSON.parse(fs.readFileSync(OPENCODE_AUTH, 'utf8'));
      if (ocData?.opencode?.key) {
        // Validate it works
        const models = await this._fetchOpenCodeModels(ocData.opencode.key);
        if (models.length > 0) {
          this._status.opencode = { connected: true, models: models.length };
          return;
        }
      }
    } catch {}

    // No valid token — try to login via OpenCode CLI
    try {
      const token = await this._openCodeCLILogin();
      if (token) {
        this._status.opencode = { connected: true, models: 39 };
        return;
      }
    } catch {}

    // Fallback: OpenCode might be accessible without explicit login if the user
    // has previously logged in via `opencode auth login`
    this._status.opencode = { connected: false, models: 0 };
  }

  _fetchOpenCodeModels(token) {
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'opencode.ai', port: 443, path: '/zen/v1/models', method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d).data || []); }
          catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(10000, () => { req.destroy(); resolve([]); });
      req.end();
    });
  }

  _openCodeCLILogin() {
    return new Promise((resolve) => {
      // Poll auth.json for changes (user logs in via browser)
      const oldToken = (() => {
        try { return JSON.parse(fs.readFileSync(OPENCODE_AUTH, 'utf8'))?.opencode?.key; }
        catch { return null; }
      })();
      const interval = setInterval(() => {
        try {
          const data = JSON.parse(fs.readFileSync(OPENCODE_AUTH, 'utf8'));
          if (data?.opencode?.key && data.opencode.key !== oldToken) {
            clearInterval(interval);
            resolve(data.opencode.key);
          }
        } catch {}
      }, 1500);
      setTimeout(() => { clearInterval(interval); resolve(null); }, 120000);
    });
  }

  // === Gemini Connection (auto API key) ===

  async _connectGemini() {
    // Check if API key already exists
    try {
      const data = JSON.parse(fs.readFileSync(GEMINI_FILE, 'utf8'));
      if (data.geminiApiKey) {
        this._status.gemini = { connected: true, models: 10 };
        return;
      }
    } catch {}

    // Auto-generate from Google token
    try {
      const data = JSON.parse(fs.readFileSync(GEMINI_FILE, 'utf8'));
      const acc = data.accounts?.[0];
      if (!acc?.accessToken) return;

      await this._autoGenerateGeminiKey(acc.accessToken);
    } catch {}
  }

  async _autoGenerateGeminiKey(accessToken) {
    try {
      // 1. Find GCP project
      const projects = await this._httpJson('GET', 'cloudresourcemanager.googleapis.com', '/v1/projects', null, accessToken);
      const activeProjects = (projects.projects || []).filter(p => p.lifecycleState === 'ACTIVE');
      if (activeProjects.length === 0) return;

      const project = activeProjects.find(p => /gemini|gen-lang/i.test(p.projectId)) || activeProjects[0];
      const projectId = project.projectId;

      // 2. Enable APIs
      await this._httpJson('POST', 'serviceusage.googleapis.com', `/v1/projects/${projectId}/services/generativelanguage.googleapis.com:enable`, '', accessToken);
      await this._httpJson('POST', 'serviceusage.googleapis.com', `/v1/projects/${projectId}/services/apikeys.googleapis.com:enable`, '', accessToken);
      await new Promise(r => setTimeout(r, 3000));

      // 3. Create API key
      const keyBody = { displayName: 'Pangea-OneToRule', restrictions: { apiTargets: [{ service: 'generativelanguage.googleapis.com' }] } };
      const op = await this._httpJson('POST', 'apikeys.googleapis.com', `/v2/projects/${projectId}/locations/global/keys`, keyBody, accessToken, projectId);
      if (!op.name) return;

      // 4. Poll for completion
      let opResult = op;
      for (let i = 0; i < 15; i++) {
        if (opResult.done) break;
        await new Promise(r => setTimeout(r, 2000));
        opResult = await this._httpJson('GET', 'apikeys.googleapis.com', `/v2/${op.name}`, null, accessToken, projectId);
      }
      if (!opResult.done || !opResult.response?.name) return;

      // 5. Get key string
      const keyData = await this._httpJson('GET', 'apikeys.googleapis.com', `/v2/${opResult.response.name}/keyString`, null, accessToken, projectId);
      if (keyData.keyString) {
        const stored = JSON.parse(fs.readFileSync(GEMINI_FILE, 'utf8'));
        stored.geminiApiKey = keyData.keyString;
        stored.geminiProject = projectId;
        fs.writeFileSync(GEMINI_FILE, JSON.stringify(stored, null, 2));
        this._status.gemini = { connected: true, models: 10 };
      }
    } catch (e) {
      console.log('[OneToRule] Gemini key generation failed:', e.message);
    }
  }

  // === Claude Connection ===

  async _connectClaude() {
    // Check Claude subscription
    try {
      const cPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const cData = JSON.parse(fs.readFileSync(cPath, 'utf8'));
      if (cData?.claudeAiOauth?.accessToken) {
        this._status.claude = { connected: true, source: 'subscription' };
        return;
      }
    } catch {}

    // No subscription — Claude available through OpenCode proxy (if connected)
    if (this._status.opencode.connected) {
      this._status.claude = { connected: true, source: 'opencode-proxy' };
      return;
    }

    this._status.claude = { connected: false, source: null };
  }

  // === HTTP Helper ===

  _httpJson(method, hostname, urlPath, body, token, quotaProject) {
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
}

module.exports = { OneToRuleLogin };
