'use strict';

// === Pangea Smart Chat — Model Manager ===
// Dynamisches Ranking, Live-Benchmark, Token-Budget-Optimierung, Self-Evolving

const CACHE_FILE = 'pangea-model-cache.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BENCHMARK_TIMEOUT_MS = 12000;
const PROBE_PARALLEL = 7;
const BENCHMARK_PROMPT = 'Bewerte dich: Code 1-10, Deutsch 1-10, Reasoning 1-10. NUR 3 Zeilen, je Zahl + 1 Wort.';

// Official benchmark baselines (SWE-Bench, LMSYS Arena, HumanEval, reasoning scores)
// Updated 2026-04. Dynamic quality tracking evolves these over time.
const KNOWN_TIERS = {
  // S-Tier: SWE-Bench >80%, top LMSYS Arena
  'claude-opus':    { tier: 'S', baseline: 98 },
  'claude-sonnet':  { tier: 'S', baseline: 92 },
  'gpt-5.4-pro':   { tier: 'S', baseline: 95 },
  'gpt-5.4':       { tier: 'S', baseline: 93 },
  'gpt-5.3-codex': { tier: 'S', baseline: 90 },
  'gemini-3.1-pro':{ tier: 'S', baseline: 93 },
  'gemini-3-pro':  { tier: 'S', baseline: 90 },
  'gemini-3-flash':{ tier: 'A', baseline: 82 },
  'gemini-3.1-flash-lite':{ tier: 'A', baseline: 76 },
  'gemini-2.5-pro':{ tier: 'S', baseline: 92 },
  'gemini-2.5-flash':{ tier: 'A', baseline: 84 },
  'gemini-2.5-flash-lite':{ tier: 'A', baseline: 76 },
  'kimi-k2.5':     { tier: 'S', baseline: 88 },
  // A-Tier: SWE-Bench 70-80%, strong coding+reasoning
  'minimax-m2.5':  { tier: 'A', baseline: 85 }, // SWE-Bench 80.2%, near Claude Opus level
  'qwen3.6':       { tier: 'A', baseline: 83 }, // SWE-Bench 78.8%, strong agentic tasks
  'gpt-5.2':       { tier: 'A', baseline: 85 },
  'gpt-5.1':       { tier: 'A', baseline: 82 },
  'gpt-5':         { tier: 'A', baseline: 80 },
  'gemini-3-pro':  { tier: 'A', baseline: 85 },
  'gemini-3-flash':{ tier: 'A', baseline: 78 },
  'kimi-k2':       { tier: 'A', baseline: 82 },
  'claude-haiku':   { tier: 'A', baseline: 75 },
  'glm-5':         { tier: 'A', baseline: 78 },
  // B-Tier: SWE-Bench 50-70%, decent general use
  'nemotron':      { tier: 'B', baseline: 68 }, // SWE-Bench 60.5%, strong long-context (96% @256k)
  'minimax-m2.1':  { tier: 'B', baseline: 65 },
  'glm-4':         { tier: 'B', baseline: 68 },
  'gpt-5-nano':    { tier: 'B', baseline: 60 },
  'trinity':       { tier: 'B', baseline: 62 }, // 400B MoE, Llama-4-Maverick level, AIME25=96.3
  // C-Tier
  'big-pickle':    { tier: 'C', baseline: 40 },
  // Added from YouTube Deep Scan (KW14)
  'minimax-m2.5':  { tier: 'S', baseline: 90 },  // Opus-Level, 1/20 Kosten
  'mercury-2':     { tier: 'A', baseline: 80 },   // Diffusion-LLM, 5x Speed
};

const COMPLEXITY_TIERS = {
  trivial: ['C', 'B', 'A', 'S'],
  simple:  ['B', 'A', 'S'],
  medium:  ['A', 'S'],
  complex: ['S'],
};

class ModelManager {
  constructor() {
    this._authenticated = null;
    this._apiKey = null;
    this._models = [];
    this._freeModels = [];
    this._rankedModels = [];
    this._activeModel = null;
    this._activeIndex = 0;
    this._cache = null;
    this._tokenBudget = {};
    this._benchmarkResults = {};
    this._qualityHistory = {};
    this._onModelChange = null;
    this._claudeEnabled = false;
    this._premiumSource = 'api';
    this._optimizationLog = [];
    this._evalBudget = { used: 0, limit: 20 };
    this._geminiAvailable = false;
    this._geminiModels = [];
  }

  onModelChange(fn) { this._onModelChange = fn; }
  isGeminiAvailable() { return this._geminiAvailable; }
  getGeminiModels() { return this._geminiModels; }
  async setGeminiEnabled(enabled) {
    this._geminiAvailable = enabled;
    if (enabled && this._geminiModels.length === 0) {
      await this._discoverGemini();
      await this._smartBenchmark(); // Re-rank with new Gemini models
    }
    // Google Login also enables Claude via Vertex AI (only if we have OAuth tokens, not just API key)
    if (enabled) {
      try {
        const accounts = await window.pangea.geminiListAccounts();
        if (accounts && accounts.length > 0) {
          await this._discoverVertexClaude();
          this._claudeEnabled = true;
          this._premiumSource = 'account';
        }
      } catch {}
    }
    if (this._onModelChange) this._onModelChange(this.getActiveModel());
  }

  async _discoverVertexClaude() {
    if (!window.pangea?.vertexTestAccess) return;
    try {
      const result = await window.pangea.vertexTestAccess();
      this._vertexClaudeAvailable = result.available;
      if (result.available) {
        this._logOpt('Vertex AI Claude: available');
      } else {
        this._logOpt('Vertex AI Claude: not yet available (status ' + result.status + ')');
      }
    } catch (e) {
      console.warn('[ModelManager] Vertex AI test failed:', e.message);
    }
  }

  async init() {
    try { this._authenticated = await window.pangea.opencodeIsAuthenticated(); } catch {}
    try { this._apiKey = await window.pangea.getSecret('ANTHROPIC_API_KEY'); } catch {}
    if (this._apiKey) {
      this._claudeEnabled = true;
      this._premiumSource = 'api';
    }

    // Ensure Google OAuth token is fresh before checking providers
    if (window.pangea?.onetoruleEnsureFresh) {
      try {
        const freshResult = await window.pangea.onetoruleEnsureFresh();
        if (freshResult.refreshed) {
          console.log('[ModelManager] Google token auto-refreshed for', freshResult.email);
        } else if (freshResult.reason === 'refresh-failed') {
          console.log('[ModelManager] Google token refresh failed — Gemini/Vertex may be unavailable');
        }
      } catch {}
    }

    // Check if Google OAuth token exists (for Vertex AI Claude)
    if (!this._claudeEnabled) {
      try {
        const accounts = await window.pangea.geminiListAccounts();
        if (accounts && accounts.length > 0) {
          this._claudeEnabled = true;
          this._premiumSource = 'account';
        }
      } catch {}
    }
    // Check Gemini availability (API key OR OAuth cookies)
    try {
      const gKey = await window.pangea.getSecret('GOOGLE_AI_KEY');
      if (!gKey) { const gKey2 = await window.pangea.getSecret('GEMINI_API_KEY'); this._geminiAvailable = !!gKey2; }
      else { this._geminiAvailable = true; }
    } catch {}
    // Also check OAuth cookie auth (Google login via webview)
    if (!this._geminiAvailable) {
      try { this._geminiAvailable = await window.pangea.geminiIsAuthenticated(); } catch {}
    }
    await this._loadCache();
    if (this._authenticated) {
      await this._discoverModels();
    }
    // Discover Gemini AFTER OpenCode models so they merge into _freeModels
    if (this._geminiAvailable) await this._discoverGemini();
    // Rank all models together (OpenCode + Gemini)
    await this._smartBenchmark();
    // Periodic refresh: check for new/better models every 10 min
    if (!this._refreshInterval) {
      this._refreshInterval = setInterval(() => this._periodicRefresh(), 10 * 60 * 1000);
    }
    // Token refresh every 45min (Google tokens expire after 60min)
    if (!this._tokenRefreshInterval) {
      this._tokenRefreshInterval = setInterval(async () => {
        if (window.pangea?.onetoruleEnsureFresh) {
          try { await window.pangea.onetoruleEnsureFresh(); } catch {}
        }
      }, 45 * 60 * 1000);
    }
  }

  async _periodicRefresh() {
    if (!this._authenticated) return;
    const oldCount = this._freeModels.length;
    const oldBest = this._rankedModels[0]?.id;
    await this._discoverModels();
    await this._smartBenchmark();
    const newBest = this._rankedModels[0]?.id;
    if (newBest !== oldBest || this._freeModels.length !== oldCount) {
      this._logOpt(`Refresh: ${oldBest} → ${newBest} (${this._freeModels.length} free models)`);
      this._notifyModelChange();
    }
  }

  isAuthenticated() { return !!this._authenticated; }
  getActiveModel() { return this._activeModel; }
  getActiveModelName() { return this._activeModel ? (this._activeModel.name || this._activeModel.id) : null; }
  getActiveModelId() { return this._activeModel ? this._activeModel.id : null; }
  getFreeModels() { return this._freeModels; }
  getRankedModels() { return this._rankedModels; }
  getAuthToken() { return this._authenticated; }
  getApiKey() { return this._apiKey; }
  isClaudeEnabled() { return this._claudeEnabled; }
  getPremiumSource() { return this._premiumSource; }
  getTokenBudget() { return { ...this._tokenBudget }; }
  getBenchmarkResults() { return { ...this._benchmarkResults }; }
  getQualityHistory() { return { ...this._qualityHistory }; }
  getOptimizationLog() { return [...this._optimizationLog]; }

  setClaudeEnabled(on) { this._claudeEnabled = !!on; }
  setPremiumSource(src) { this._premiumSource = src === 'account' ? 'account' : 'api'; }

  async setAuthToken(token) {
    this._authenticated = token;
    await window.pangea.setSecret('OPENCODE_AUTH_TOKEN', token);
    await this._discoverModels();
    await this._smartBenchmark();
  }

  login() { window.pangea.opencodeLogin(); }

  async _discoverModels() {
    if (!this._authenticated) return;
    const { models, error } = await window.pangea.opencodeModels();
    if (error) { console.warn('[ModelManager] Discovery failed:', error); return; }
    this._models = models || [];
    // Split: free models (no billing needed) vs paid
    const freeIds = this._models.filter(m => m.id.includes('free')).map(m => m.id);
    this._hasBilling = false; // assume no billing until proven otherwise
    // Use only free models by default. Paid models are tried only if billing is confirmed.
    this._freeModels = freeIds.length > 0
      ? this._models.filter(m => freeIds.includes(m.id))
      : [...this._models]; // fallback: try all if no free models exist
    // Pre-sort by official benchmark baselines (best first). Live benchmark refines.
    this._freeModels.sort((a, b) => {
      const ba = this._getBaselineScore(a.id);
      const bb = this._getBaselineScore(b.id);
      return bb - ba;
    });
    for (const m of this._freeModels) {
      if (!this._tokenBudget[m.id]) {
        this._tokenBudget[m.id] = { used: 0, limit: null, exhausted: false, lastReset: new Date().toISOString() };
      }
    }
  }

  async _discoverGemini() {
    if (!this._geminiAvailable || !window.pangea?.geminiModels) return;
    try {
      const models = await window.pangea.geminiModels();
      // Filter: only current gemini-2.5+ and gemini-3+ chat models
      // Older models (2.0, 1.5) return 404 "no longer available to new users"
      const chatModels = (models || []).filter(m =>
        m.id.startsWith('gemini-') && !m.id.includes('tts') && !m.id.includes('image')
        && !m.id.includes('robotics') && !m.id.includes('computer-use')
        && !m.id.includes('customtools') && !m.id.includes('deep-research')
        && !m.id.includes('-001') && !m.id.includes('-latest')
        && (m.id.includes('2.5') || m.id.includes('3-') || m.id.includes('3.1'))
      );
      this._geminiModels = chatModels.map(m => {
        const baseline = this._getBaselineScore(m.id) || m.baseline || 70;
        return { ...m, name: m.name || m.id, _source: 'gemini', _benchScore: baseline };
      });
      // Add Gemini models to the free pool (they ARE free tier)
      for (const gm of this._geminiModels) {
        if (!this._freeModels.find(m => m.id === gm.id)) {
          this._freeModels.push(gm);
        }
        if (!this._tokenBudget[gm.id]) {
          this._tokenBudget[gm.id] = { used: 0, limit: null, exhausted: false, lastReset: new Date().toISOString() };
        }
      }
      // Re-sort by score after adding
      this._freeModels.sort((a, b) => (b._benchScore || 0) - (a._benchScore || 0));
      this._logOpt('Gemini: ' + this._geminiModels.length + ' chat models added to free pool');
    } catch (e) {
      console.warn('[ModelManager] Gemini discovery failed:', e.message);
    }
  }

  async _smartBenchmark() {
    if (this._freeModels.length === 0) return;
    // Rank instantly by official benchmarks + persistent experience — NO live chat test.
    // This avoids token waste, timeouts, and startup delay.
    this._rankedModels = this._freeModels.map(m => ({
      ...m,
      _benchScore: this._getBaselineScore(m.id),
      _benchLatency: 0,
    }));
    this._rankedModels.sort((a, b) => b._benchScore - a._benchScore);
    if (this._rankedModels.length > 0) {
      this._activeIndex = 0;
      this._activeModel = this._rankedModels[0];
      this._notifyModelChange();
    }
    await this._saveCache();
  }

  _selectBenchmarkCandidates() {
    const candidates = [];
    const seen = new Set();
    if (this._cache?.ranking) {
      for (const entry of this._cache.ranking.slice(0, 3)) {
        const model = this._freeModels.find(m => m.id === entry.modelId);
        if (model && !seen.has(model.id)) { candidates.push(model); seen.add(model.id); }
      }
    }
    for (const [prefix] of Object.entries(KNOWN_TIERS)) {
      for (const model of this._freeModels) {
        if (!seen.has(model.id) && model.id.toLowerCase().includes(prefix)) {
          candidates.push(model); seen.add(model.id);
        }
      }
    }
    for (const model of this._freeModels) {
      if (!seen.has(model.id)) { candidates.push(model); seen.add(model.id); }
    }
    return candidates.slice(0, PROBE_PARALLEL);
  }

  async _runParallelBenchmark(candidates) {
    const promises = candidates.map(model => this._benchmarkSingle(model));
    const results = await Promise.allSettled(promises);
    return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  }

  _benchmarkSingle(model) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let response = '';
      let resolved = false;
      const timeout = setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, BENCHMARK_TIMEOUT_MS);
      const handler = (data) => {
        if (resolved) return;
        if (data.type === 'chunk') response += data.text;
        if (data.type === 'done' || data.type === 'error') {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          if (data.type === 'error') { resolve(null); return; }
          const latency = Date.now() - startTime;
          const score = this._scoreBenchmark(response, latency, model);
          this._benchmarkResults[model.id] = { score, latency, response: response.slice(0, 200), timestamp: new Date().toISOString() };
          resolve({ modelId: model.id, score, latency });
        }
      };
      window.pangea.onOpencodeStream(handler);
      window.pangea.opencodeChat(model.id, [{ role: 'user', content: BENCHMARK_PROMPT }]);
    });
  }

  _getBaselineScore(modelId) {
    const id = (modelId || '').toLowerCase();
    let best = 50; // default
    for (const [prefix, info] of Object.entries(KNOWN_TIERS)) {
      if (id.includes(prefix) && info.baseline > best) best = info.baseline;
    }
    // Boost from persistent quality history
    const history = this._qualityHistory[modelId];
    if (history && history.length >= 3) {
      const avg = history.slice(-10).map(h => h.score).reduce((a, b) => a + b, 0) / Math.min(history.length, 10);
      best = best * 0.7 + avg * 3; // blend: 70% official, 30% experience (scaled)
    }
    return best;
  }

  _scoreBenchmark(response, latencyMs, model) {
    // Start with official baseline (0-100 scale, normalized to 0-10)
    const baseline = this._getBaselineScore(model.id);
    let score = Math.round(baseline / 10); // 85 → 8.5 → 9
    // Live test adjustments
    const lines = response.trim().split('\n').filter(l => l.trim());
    const numberedLines = lines.filter(l => /\d/.test(l));
    if (numberedLines.length >= 3) score += 2;
    else if (numberedLines.length >= 1) score += 1;
    if (/[aouAOU]\u0308|[\u00e4\u00f6\u00fc\u00df]/i.test(response)) score += 1;
    if (/\b(Code|Deutsch|Reasoning)\b/i.test(response)) score += 1;
    if (response.length > 20 && response.length < 500) score += 1;
    if (latencyMs < 3000) score += 2;
    else if (latencyMs < 6000) score += 1;
    const ctx = model.context_length || model.context_window || 0;
    if (ctx >= 128000) score += 1;
    return score;
  }

  // === Token-Budget ===

  trackTokenUsage(modelId, estimatedTokens) {
    if (!this._tokenBudget[modelId]) {
      this._tokenBudget[modelId] = { used: 0, limit: null, exhausted: false, lastReset: new Date().toISOString() };
    }
    this._tokenBudget[modelId].used += estimatedTokens;
  }

  markExhausted(modelId) {
    if (!this._tokenBudget[modelId]) return;
    const budget = this._tokenBudget[modelId];
    budget.exhausted = true;
    if (!budget.limit || budget.used < budget.limit) {
      budget.limit = budget.used;
      this._logOpt(`${modelId}: Limit gelernt ~${budget.used}`);
    }
    this._saveCache();
  }

  _checkBudgetResets() {
    const now = Date.now();
    for (const [modelId, budget] of Object.entries(this._tokenBudget)) {
      if (!budget.exhausted) continue;
      const resetAge = now - new Date(budget.lastReset).getTime();
      if (resetAge > 24 * 60 * 60 * 1000) {
        budget.exhausted = false;
        budget.used = 0;
        budget.lastReset = new Date().toISOString();
        this._logOpt(`${modelId}: Reset (24h)`);
      }
    }
  }

  getTokenHeadroom(modelId) {
    const budget = this._tokenBudget[modelId];
    if (!budget) return Infinity;
    if (budget.exhausted) return 0;
    if (!budget.limit) return Infinity;
    return Math.max(0, budget.limit - budget.used);
  }

  // === Quality Tracking ===

  trackResponseQuality(modelId, response, taskType) {
    if (!this._qualityHistory[modelId]) this._qualityHistory[modelId] = [];
    const score = this._evalAlgo(response);
    this._qualityHistory[modelId].push({ score, taskType, timestamp: new Date().toISOString(), responseLen: response.length });
    if (this._qualityHistory[modelId].length > 100) {
      this._qualityHistory[modelId] = this._qualityHistory[modelId].slice(-100);
    }
    this._evolveModelTier(modelId);
    return score;
  }

  _evalAlgo(response) {
    let score = 0;
    if (response.length > 50) score += 1;
    if (response.length > 200) score += 1;
    if (/```/.test(response)) score += 1;
    if (/\n[-*]\s/.test(response)) score += 1;
    if (/[\u00e4\u00f6\u00fc\u00df]/i.test(response)) score += 1;
    if (response.split('\n').length > 3) score += 1;
    if (response.length < 20) score -= 2;
    if (/sorry|entschuldigung|cannot|kann nicht/i.test(response)) score -= 1;
    if (/error|fehler|invalid/i.test(response) && response.length < 100) score -= 1;
    return Math.max(0, Math.min(10, score));
  }

  _evolveModelTier(modelId) {
    const history = this._qualityHistory[modelId];
    if (!history || history.length < 5) return;
    const recentScores = history.slice(-10).map(h => h.score);
    const avg = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
    const id = modelId.toLowerCase();
    let currentTier = 'B';
    for (const [prefix, info] of Object.entries(KNOWN_TIERS)) {
      if (id.includes(prefix)) { currentTier = info.tier; break; }
    }
    let newTier = currentTier;
    if (avg >= 7) newTier = 'S';
    else if (avg >= 5) newTier = 'A';
    else if (avg >= 3) newTier = 'B';
    else newTier = 'C';
    if (newTier !== currentTier) {
      for (const [prefix] of Object.entries(KNOWN_TIERS)) {
        if (id.includes(prefix)) {
          KNOWN_TIERS[prefix].tier = newTier;
          this._logOpt(`${modelId}: Tier ${currentTier}->${newTier} (avg:${avg.toFixed(1)})`);
          break;
        }
      }
    }
  }

  async runComparisonEval(modelIdA, modelIdB, testPrompt) {
    if (this._evalBudget.used >= this._evalBudget.limit) return null;
    this._evalBudget.used++;
    const [respA, respB] = await Promise.all([this._quickChat(modelIdA, testPrompt), this._quickChat(modelIdB, testPrompt)]);
    if (!respA || !respB) return null;
    const scoreA = this._evalAlgo(respA);
    const scoreB = this._evalAlgo(respB);
    this._logOpt(`Eval: ${modelIdA}=${scoreA} vs ${modelIdB}=${scoreB}`);
    return { modelIdA, scoreA, modelIdB, scoreB, winner: scoreA >= scoreB ? modelIdA : modelIdB };
  }

  _quickChat(modelId, prompt) {
    return new Promise((resolve) => {
      let response = '';
      let resolved = false;
      const timeout = setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 15000);
      const handler = (data) => {
        if (resolved) return;
        if (data.type === 'chunk') response += data.text;
        if (data.type === 'done') { resolved = true; clearTimeout(timeout); resolve(response); }
        if (data.type === 'error') { resolved = true; clearTimeout(timeout); resolve(null); }
      };
      window.pangea.onOpencodeStream(handler);
      window.pangea.opencodeChat(modelId, [{ role: 'user', content: prompt }]);
    });
  }

  // === Smart Selection ===

  selectModelForTask(complexity) {
    this._checkBudgetResets();
    const allowedTiers = COMPLEXITY_TIERS[complexity] || COMPLEXITY_TIERS.medium;
    const candidates = this._rankedModels.filter(m => {
      const tier = this._getModelTier(m.id);
      if (!allowedTiers.includes(tier)) return false;
      if (this._tokenBudget[m.id]?.exhausted) return false;
      return true;
    });
    if (candidates.length === 0) {
      return this._rankedModels.find(m => !this._tokenBudget[m.id]?.exhausted) || null;
    }
    if (complexity === 'trivial' || complexity === 'simple') {
      candidates.sort((a, b) => {
        const headA = this.getTokenHeadroom(a.id);
        const headB = this.getTokenHeadroom(b.id);
        if (headA === Infinity && headB === Infinity) return (a._benchScore || 0) - (b._benchScore || 0);
        return headB - headA;
      });
    }
    return candidates[0] || null;
  }

  _getModelTier(modelId) {
    const id = (modelId || '').toLowerCase();
    // Laengstes Prefix zuerst matchen (claude-opus vor claude)
    let bestMatch = null;
    let bestLen = 0;
    for (const [prefix, info] of Object.entries(KNOWN_TIERS)) {
      if (id.startsWith(prefix) || id.includes(prefix)) {
        if (prefix.length > bestLen) { bestMatch = info; bestLen = prefix.length; }
      }
    }
    if (bestMatch) return bestMatch.tier;
    return 'B';
  }

  // === Rotation ===

  rotateToNext() {
    for (let i = this._activeIndex + 1; i < this._rankedModels.length; i++) {
      const m = this._rankedModels[i];
      if (!this._tokenBudget[m.id]?.exhausted) {
        this._activeIndex = i;
        this._activeModel = m;
        this._notifyModelChange();
        return this.getActiveModelName();
      }
    }
    for (let i = 0; i < this._activeIndex; i++) {
      const m = this._rankedModels[i];
      if (!this._tokenBudget[m.id]?.exhausted) {
        this._activeIndex = i;
        this._activeModel = m;
        this._notifyModelChange();
        return this.getActiveModelName();
      }
    }
    this._activeModel = null;
    this._notifyModelChange();
    return null;
  }

  switchTo(modelId) {
    const idx = this._rankedModels.findIndex(m => m.id === modelId);
    if (idx >= 0) {
      this._activeIndex = idx;
      this._activeModel = this._rankedModels[idx];
      this._notifyModelChange();
      return true;
    }
    return false;
  }

  // === Background Discovery ===

  async _backgroundDiscoverNewModels() {
    const cachedIds = new Set((this._cache?.ranking || []).map(r => r.modelId));
    const newModels = this._freeModels.filter(m => !cachedIds.has(m.id));
    if (newModels.length === 0) return;
    this._logOpt(`${newModels.length} neue Models entdeckt`);
    const results = await this._runParallelBenchmark(newModels.slice(0, 3));
    for (const r of results) {
      const model = this._freeModels.find(m => m.id === r.modelId);
      if (!model) continue;
      const enriched = { ...model, _benchScore: r.score, _benchLatency: r.latency };
      const insertIdx = this._rankedModels.findIndex(m => (m._benchScore || 0) < r.score);
      if (insertIdx >= 0) this._rankedModels.splice(insertIdx, 0, enriched);
      else this._rankedModels.push(enriched);
    }
    if (results.length > 0) await this._saveCache();
  }

  // === Cache ===

  async _loadCache() {
    try {
      const data = await window.pangea.readJSON(CACHE_FILE);
      if (data && data.timestamp) {
        const age = Date.now() - new Date(data.timestamp).getTime();
        if (age < CACHE_TTL_MS) {
          this._cache = data;
          this._tokenBudget = data.tokenBudget || {};
          this._benchmarkResults = data.benchmarkResults || {};
          this._qualityHistory = data.qualityHistory || {};
          this._optimizationLog = data.optimizationLog || [];
        }
      }
    } catch {}
  }

  async _saveCache() {
    const data = {
      timestamp: new Date().toISOString(),
      ranking: this._rankedModels.map(m => ({ modelId: m.id, name: m.name || m.id, score: m._benchScore || 0, latency: m._benchLatency || 0 })),
      tokenBudget: this._tokenBudget,
      benchmarkResults: this._benchmarkResults,
      qualityHistory: this._qualityHistory,
      optimizationLog: this._optimizationLog.slice(-50),
    };
    try { await window.pangea.writeJSON(CACHE_FILE, data); } catch {}
  }

  _getValidCachedRanking() {
    if (!this._cache?.ranking) return null;
    const result = [];
    for (const entry of this._cache.ranking) {
      const model = this._freeModels.find(m => m.id === entry.modelId);
      if (model && !this._tokenBudget[model.id]?.exhausted) {
        result.push({ ...model, _benchScore: entry.score, _benchLatency: entry.latency });
      }
    }
    return result;
  }

  async selfTest() {
    const model = this._activeModel;
    if (!model || !this._authenticated) return false;
    try {
      const resp = await this._quickChat(model.id, 'Reply with exactly: OK');
      return !!(resp && resp.length > 0);
    } catch { return false; }
  }

  _logOpt(msg) {
    this._optimizationLog.push({ time: new Date().toISOString(), msg });
    console.log('[ModelManager:Opt]', msg);
    if (this._optimizationLog.length > 50) this._optimizationLog = this._optimizationLog.slice(-50);
  }

  getOptimizationInsights() {
    const insights = [];
    const budget = this._tokenBudget;
    const exhausted = Object.entries(budget).filter(([, b]) => b.exhausted);
    if (exhausted.length > 0) insights.push(exhausted.length + ' exhausted: ' + exhausted.map(([id]) => id).join(', '));
    for (const [modelId, history] of Object.entries(this._qualityHistory)) {
      if (history.length < 5) continue;
      const recent = history.slice(-10).map(h => h.score);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      if (avg < 3) insights.push(modelId + ': schlecht (' + avg.toFixed(1) + ')');
      if (avg > 7) insights.push(modelId + ': stark (' + avg.toFixed(1) + ')');
    }
    return insights;
  }

  _notifyModelChange() {
    if (this._onModelChange) {
      this._onModelChange({
        name: this.getActiveModelName(), id: this.getActiveModelId(),
        score: this._activeModel?._benchScore || 0,
        tier: this._getModelTier(this._activeModel?.id || ''),
        headroom: this.getTokenHeadroom(this._activeModel?.id || ''),
      });
    }
  }
}

module.exports = { ModelManager, COMPLEXITY_TIERS, KNOWN_TIERS };
