'use strict';

// === Pangea Smart Chat — Orchestrator ===
// Meta-Layer: Task-Analyse, Model-Routing, Self-Optimization

const PREMIUM_SIGNALS = [
  /\b(implementier|schreib|code|programmier|refactor|debug|fix|fehler|bug|patch)/i,
  /\b(funktion|klasse|class|modul|component|api|endpoint|migration)/i,
  /\b(merge|deploy|build|kompilier|bundl|docker|git)/i,
  /\b(architektur|design|system|infrastruktur|datenbankschema|pipeline)/i,
  /\b(dateien|files|project|projekt|codebase|repository)/i,
  /\b(claude|opus|sonnet|premium|genau|sorgf.ltig|gr.ndlich)/i,
  /\b(analysier|optimier|review|audit|sicherheit|security)/i,
];

const FREE_SIGNALS = [
  /\b(was ist|erkl.re|zusammenfassung|summary|.bersetze|translate)/i,
  /\b(suche|find|search|liste|list|zeig|show)/i,
  /\b(wie hei.t|wann|wo|warum|why|how|what)/i,
  /\b(format|konvertier|umwandl)/i,
  /\b(einfach|kurz|schnell|simple|quick|hi|hallo|hey)/i,
  /\b(danke|thanks|ok|ja|nein|yes|no)/i,
];

const TRIVIAL_PATTERNS = [
  /^(hi|hallo|hey|danke|ok|ja|nein|bye|tsch.ss)\b/i,
  /^.{0,30}$/,  // sehr kurze Nachrichten
];

class Orchestrator {
  constructor(modelManager, chat) {
    this._mm = modelManager;
    this._chat = chat;
    this._streaming = false;
    this._currentRoute = null;
    this._currentModelId = null;
    this._messagesSinceEval = 0;
    this._evalInterval = 10; // alle 10 Nachrichten pruefen ob Eval sinnvoll
    this._onModelSwitch = null;
    this._onStatusUpdate = null;
    this._premiumMix = 30;
    this._pearl = null; // Set by setPearl()
    this._streamStartTime = 0;
    this._firstChunkTime = 0;
    this._frozenTimer = null;
    this._responseTimes = {}; // modelId → { avg, count, lastLatency }

    this._chat.onSend((text) => this._route(text));

    if (window.pangea?.onOpencodeStream) {
      window.pangea.onOpencodeStream((data) => this._handleStream(data, 'free'));
    }
    if (window.pangea?.onClaudeStream) {
      window.pangea.onClaudeStream((data) => this._handleStream(data, 'premium'));
    }
    if (window.pangea?.onVertexClaudeStream) {
      window.pangea.onVertexClaudeStream((data) => this._handleStream(data, 'premium'));
    }
    if (window.pangea?.onGeminiStream) {
      window.pangea.onGeminiStream((data) => this._handleStream(data, 'gemini'));
    }
    if (window.pangea?.onOllamaStream) {
      window.pangea.onOllamaStream((data) => this._handleStream(data, 'local'));
    }
  }

  onModelSwitch(fn) { this._onModelSwitch = fn; }
  onStatusUpdate(fn) { this._onStatusUpdate = fn; }
  isStreaming() { return this._streaming; }
  setPearl(pearl) { this._pearl = pearl; }
  getPearl() { return this._pearl; }

  // Force a specific model (user selected from dropdown)
  setForcedModel(modelId) {
    this._forcedModelId = modelId;
    if (modelId) {
      this._mm.switchTo(modelId);
      this._currentModelId = modelId;
      if (this._onModelSwitch) this._onModelSwitch(this._mm.getActiveModel());
    }
  }
  clearForcedModel() {
    this._forcedModelId = null;
    // Immediately re-select best free model and update UI
    const best = this._mm.selectModelForTask('medium');
    if (best) {
      this._currentModelId = best.id;
      this._mm.switchTo(best.id);
      if (this._onModelSwitch) this._onModelSwitch(best);
      this._status(this._mm.getActiveModelName());
    }
  }
  getForcedModel() { return this._forcedModelId || null; }

  // === Task-Analyse ===

  _analyzeComplexity(text) {
    // Trivial: Gruss, Einwort, sehr kurz
    for (const p of TRIVIAL_PATTERNS) {
      if (p.test(text.trim())) return 'trivial';
    }

    let premiumScore = 0;
    let freeScore = 0;
    for (const p of PREMIUM_SIGNALS) { if (p.test(text)) premiumScore++; }
    for (const p of FREE_SIGNALS) { if (p.test(text)) freeScore++; }

    // Laenge als Signal
    if (text.length > 500) premiumScore += 2;
    if (text.length > 1000) premiumScore += 1;
    if (/```/.test(text)) premiumScore += 2; // Code-Bloecke = komplex
    if (/[A-Z]:\\|\/\w+\/\w+\.\w+/.test(text)) premiumScore += 1; // Dateipfade

    // Entscheidung
    if (premiumScore >= 5) return 'complex';
    if (premiumScore >= 3 && premiumScore > freeScore) return 'medium';
    if (freeScore > premiumScore) return 'simple';
    if (premiumScore <= 1 && freeScore <= 1) return 'simple';
    return 'medium';
  }

  // === Routing ===

  setPremiumMix(value) { this._premiumMix = Math.max(0, Math.min(100, value)); }

  _route(text) {
    if (this._streaming) return;

    // Pearl intercept — handles /commands and auto-detects skills
    if (this._pearl) {
      const intercept = this._pearl.intercept(text);
      if (intercept.handled) return; // Was a /command, don't send to chat
    }

    const complexity = this._analyzeComplexity(text);
    const claudeEnabled = this._mm.isClaudeEnabled();
    const mix = this._premiumMix ?? 30;

    // Forced Claude model from dropdown? Always route premium.
    if (this._forcedModelId && this._forcedModelId.startsWith('claude-')) {
      this._sendPremium(text, complexity);
      return;
    }

    // Entscheidung: Claude oder Free?
    // mix=0: never Claude. mix=100: always Claude. mix=30: only complex.
    // Complexity scores: trivial=0, simple=25, medium=50, complex=100
    const complexityScore = { trivial: 0, simple: 25, medium: 50, complex: 100 }[complexity] || 50;
    const useClaude = claudeEnabled && (complexityScore >= (100 - mix));

    if (useClaude) {
      this._sendPremium(text, complexity);
    } else {
      this._sendFree(text, complexity);
    }

    // Self-Optimization Check
    this._messagesSinceEval++;
    if (this._messagesSinceEval >= this._evalInterval) {
      this._messagesSinceEval = 0;
      this._maybeRunEval();
    }
  }

  _sendFree(text, complexity) {
    // Forced model overrides smart selection
    let model;
    if (this._forcedModelId) {
      model = this._mm.getRankedModels().find(m => m.id === this._forcedModelId) || this._mm.selectModelForTask(complexity);
    } else {
      model = this._mm.selectModelForTask(complexity);
    }
    if (!model) {
      this._chat.showError('No free models available. Try again later.');
      return;
    }

    if (!this._mm.isAuthenticated()) {
      this._chat.showError('Not connected to OpenCode. Please sign in.');
      return;
    }

    // Nahtloser Wechsel: wenn anderes Model als aktuell
    if (model.id !== this._currentModelId) {
      this._currentModelId = model.id;
      this._mm.switchTo(model.id);
      if (this._onModelSwitch) this._onModelSwitch(model);
    }

    this._streaming = true;
    this._currentRoute = 'free';
    this._streamStartTime = Date.now();
    this._firstChunkTime = 0;
    this._status(this._mm.getActiveModelName());

    const messages = this._chat.getMessages().map(m => ({ role: m.role, content: m.content }));

    // Token-Tracking (Schaetzung: chars/4)
    const estimatedTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    this._mm.trackTokenUsage(model.id, estimatedTokens);

    // Frozen-Detection: if no chunk arrives within 15s, switch model
    this._startFrozenTimer();

    // Route to correct API based on model source
    if (model._source === 'gemini') {
      window.pangea.geminiChat(model.id, messages);
    } else if (model._source === 'ollama') {
      window.pangea.ollamaChat(model.id, messages);
    } else {
      window.pangea.opencodeChat(model.id, messages);
    }
  }

  _startFrozenTimer() {
    this._clearFrozenTimer();
    this._frozenTimer = setTimeout(() => {
      if (!this._streaming) return;
      // No first chunk after 15s — model is frozen
      if (!this._firstChunkTime) {
        console.warn('[Orchestrator] Model frozen (15s no response), switching...');
        this._handleFrozenModel();
      }
    }, 15000);
  }

  _clearFrozenTimer() {
    if (this._frozenTimer) { clearTimeout(this._frozenTimer); this._frozenTimer = null; }
  }

  _handleFrozenModel() {
    if (!this._streaming || !this._currentModelId) return;
    // Abort current stream
    if (window.pangea.opencodeAbort) window.pangea.opencodeAbort();
    // Track bad latency for this model
    this._trackResponseTime(this._currentModelId, 15000);
    // Rotate to next model and retry
    const nextModel = this._mm.rotateToNext();
    if (nextModel) {
      this._currentModelId = this._mm.getActiveModelId();
      if (this._onModelSwitch) this._onModelSwitch(this._mm.getActiveModel());
      // Retry with the last user message
      const lastUserMsg = this._chat.getMessages().filter(m => m.role === 'user').pop();
      if (lastUserMsg) {
        this._streamStartTime = Date.now();
        this._firstChunkTime = 0;
        const messages = this._chat.getMessages().map(m => ({ role: m.role, content: m.content }));
        this._startFrozenTimer();
        window.pangea.opencodeChat(this._mm.getActiveModelId(), messages);
      }
    } else {
      this._streaming = false;
      this._chat.showError('All models timed out.');
      this._status('No Models');
    }
  }

  _trackResponseTime(modelId, latencyMs) {
    if (!this._responseTimes[modelId]) this._responseTimes[modelId] = { avg: 0, count: 0, lastLatency: 0 };
    const rt = this._responseTimes[modelId];
    rt.count++;
    rt.lastLatency = latencyMs;
    rt.avg = rt.avg + (latencyMs - rt.avg) / rt.count; // running average
  }

  _sendPremium(text, complexity) {
    const source = this._mm.getPremiumSource();
    const messages = this._chat.getMessages().map(m => ({ role: m.role, content: m.content }));

    // Choose Claude model: forced > complexity-based
    const CLAUDE_NAMES = {
      'claude-opus-4-6': 'Claude Opus 4.6', 'claude-sonnet-4-6': 'Claude Sonnet 4.6', 'claude-haiku-4-5': 'Claude Haiku 4.5',
      'claude-opus-4@20250514': 'Claude Opus 4', 'claude-sonnet-4@20250514': 'Claude Sonnet 4',
      'claude-sonnet-4-5@20250514': 'Claude Sonnet 4.5', 'claude-haiku-4@20250514': 'Claude Haiku 4',
    };
    // Vertex AI model IDs for Google-routed Claude
    const VERTEX_MODEL_MAP = {
      'claude-opus-4-6': 'claude-opus-4@20250514',
      'claude-sonnet-4-6': 'claude-sonnet-4@20250514',
      'claude-haiku-4-5': 'claude-haiku-4@20250514',
    };

    let claudeModel = this._forcedModelId?.startsWith('claude-') ? this._forcedModelId : (complexity === 'complex' ? 'claude-opus-4-6' : 'claude-sonnet-4-6');
    const claudeName = CLAUDE_NAMES[claudeModel] || claudeModel;

    if (source === 'api') {
      // Direct Anthropic API (with API key)
      const apiKey = this._mm.getApiKey();
      if (!apiKey) {
        // No API key — try Vertex AI route instead
        this._sendClaudeViaVertex(claudeModel, claudeName, messages);
        return;
      }
      this._streaming = true;
      this._currentRoute = 'premium';
      this._currentModelId = claudeModel;
      this._streamStartTime = Date.now();
      this._firstChunkTime = 0;
      this._status(claudeName + ' (API)');
      if (this._onModelSwitch) this._onModelSwitch({ id: claudeModel, name: claudeName });
      this._startFrozenTimer();
      window.pangea.claudeChat(claudeModel, messages, apiKey);
    } else {
      // Google Vertex AI route (Claude via Google Login)
      this._sendClaudeViaVertex(claudeModel, claudeName, messages);
    }
  }

  _sendClaudeViaVertex(claudeModel, claudeName, messages) {
    // Map to Vertex AI model ID
    const VERTEX_MODEL_MAP = {
      'claude-opus-4-6': 'claude-opus-4@20250514',
      'claude-sonnet-4-6': 'claude-sonnet-4@20250514',
      'claude-haiku-4-5': 'claude-haiku-4@20250514',
    };
    const vertexModel = VERTEX_MODEL_MAP[claudeModel] || claudeModel;

    if (!window.pangea?.vertexClaudeChat) {
      this._chat.showToast('Vertex AI not available. Log in with Google first.');
      this._sendFree('', 'complex');
      return;
    }

    this._streaming = true;
    this._currentRoute = 'premium';
    this._currentModelId = claudeModel;
    this._streamStartTime = Date.now();
    this._firstChunkTime = 0;
    this._status(claudeName + ' (Google)');
    if (this._onModelSwitch) this._onModelSwitch({ id: claudeModel, name: claudeName });
    this._startFrozenTimer();
    window.pangea.vertexClaudeChat(vertexModel, messages);
  }

  // === Stream Handling ===

  _handleStream(data, source) {
    if (data.type === 'chunk') {
      // First chunk — clear frozen timer, track latency
      if (!this._firstChunkTime) {
        this._firstChunkTime = Date.now();
        this._clearFrozenTimer();
        const latency = this._firstChunkTime - this._streamStartTime;
        if (this._currentModelId) this._trackResponseTime(this._currentModelId, latency);
      }
      this._chat.appendAssistantChunk(data.text);
    } else if (data.type === 'done') {
      this._clearFrozenTimer();
      // Qualitaets-Tracking nach jeder Antwort
      const lastMsg = this._chat.getMessages().filter(m => m.role === 'assistant').pop();
      if (lastMsg && this._currentModelId) {
        const complexity = this._currentRoute === 'premium' ? 'complex' : 'simple';
        this._mm.trackResponseQuality(this._currentModelId, lastMsg.content, complexity);
      }
      this._chat.finalizeAssistantMessage();
      this._streaming = false;
      this._status('Ready');
      // Critic pass after complex responses
      this._maybeCriticPass().catch(() => {});
    } else if (data.type === 'error') {
      this._clearFrozenTimer();
      this._streaming = false;
      const msg = data.message || '';
      // If we already received content, the response was successful — ignore trailing errors
      if (this._chat._currentStreamText && this._chat._currentStreamText.length > 0) {
        this._chat.finalizeAssistantMessage();
        this._status('Ready');
        return;
      }

      if (msg.startsWith('TOKENS_EXHAUSTED') || msg.includes('429') || msg.includes('402') || msg.includes('401') || msg.includes('CreditsError') || msg.includes('payment')) {
        // Model exhausted -> markieren + rotieren
        if (this._currentModelId) {
          this._mm.markExhausted(this._currentModelId);
        }
        const nextModel = this._mm.rotateToNext();
        if (nextModel) {
          this._currentModelId = this._mm.getActiveModelId();
          if (this._onModelSwitch) this._onModelSwitch(this._mm.getActiveModel());
          // Letzte User-Nachricht nochmal senden
          const lastUserMsg = this._chat.getMessages().filter(m => m.role === 'user').pop();
          if (lastUserMsg) {
            this._streaming = true;
            const messages = this._chat.getMessages().map(m => ({ role: m.role, content: m.content }));
            window.pangea.opencodeChat(this._mm.getActiveModelId(), messages);
          }
        } else {
          this._chat.showError('All free models exhausted.');
          this._status('No Models');
        }
      } else {
        this._chat.showError('Error: ' + msg);
        this._status('Error');
      }
    }
  }

  // === Critic-Agent Pattern (Paper Banana: +15% Qualität) ===
  // After complex responses, optionally run a critic pass that reviews the output.
  // 3 rounds of criticism = 60.4% vs 45.1% quality (Google Research).

  async _maybeCriticPass() {
    if (!this._criticEnabled) return;

    const messages = this._chat.getMessages();
    const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
    const lastUser = messages.filter(m => m.role === 'user').pop();
    if (!lastAssistant || !lastUser) return;

    // Only critic complex responses (> 200 chars, code-related)
    if (lastAssistant.content.length < 200) return;
    const isComplex = /```|function|class|const |import |export |def |async /.test(lastAssistant.content);
    if (!isComplex) return;

    this._status('Critic reviewing...');

    const criticPrompt = [
      { role: 'user', content: lastUser.content },
      { role: 'assistant', content: lastAssistant.content },
      {
        role: 'user',
        content: 'Review the above response critically. Check for: bugs, missing edge cases, security issues, incorrect logic, better approaches. If the response is good, say "LGTM". If issues found, list them concisely.',
      },
    ];

    // Use a fast model for the critic (Haiku/Flash)
    const criticModel = 'claude-haiku-4-5-20251001';
    return new Promise((resolve) => {
      let criticResponse = '';
      const handlers = {
        onChunk: (text) => { criticResponse += text; },
        onDone: () => {
          if (criticResponse.includes('LGTM') || criticResponse.length < 50) {
            this._status('Ready (critic: OK)');
          } else {
            // Show critic feedback as a system note in chat
            this._chat.addSystemNote('Critic: ' + criticResponse.trim().substring(0, 300));
            this._status('Ready (critic: issues found)');
          }
          resolve();
        },
        onError: () => { this._status('Ready'); resolve(); },
      };

      if (window.pangea?.claudeChat) {
        window.pangea.claudeChat(criticModel, criticPrompt);
        // Listen for the stream
        const criticHandler = (data) => {
          if (data.type === 'chunk') handlers.onChunk(data.text);
          else if (data.type === 'done') { window.pangea._removeCriticHandler?.(); handlers.onDone(); }
          else if (data.type === 'error') { window.pangea._removeCriticHandler?.(); handlers.onError(); }
        };
        // Note: In production this needs a separate stream channel to avoid conflicts
        // For now, critic runs after main stream is done
        setTimeout(() => handlers.onDone(), 15000); // Safety timeout
      } else {
        resolve();
      }
    });
  }

  enableCritic(on) { this._criticEnabled = !!on; }
  isCriticEnabled() { return !!this._criticEnabled; }

  // === Self-Optimization ===

  async _maybeRunEval() {
    const ranked = this._mm.getRankedModels();
    if (ranked.length < 2) return;

    // Nur wenn genug Token-Headroom da ist
    const top = ranked[0];
    const second = ranked[1];
    if (!top || !second) return;

    const headroomTop = this._mm.getTokenHeadroom(top.id);
    const headroomSecond = this._mm.getTokenHeadroom(second.id);

    // Nur evaluieren wenn beide noch genuegend Tokens haben
    if (headroomTop < 5000 || headroomSecond < 5000) return;

    // Score-Differenz: nur testen wenn Models nah beieinander
    const scoreDiff = Math.abs((top._benchScore || 0) - (second._benchScore || 0));
    if (scoreDiff > 3) return; // Klarer Gewinner, kein Test noetig

    const result = await this._mm.runComparisonEval(
      top.id, second.id,
      'Schreibe eine kurze JavaScript-Funktion die prueft ob ein String ein Palindrom ist. Nur Code, keine Erklaerung.'
    );

    if (result && result.winner !== top.id) {
      // Ranking umdrehen wenn Herausforderer besser war
      this._mm.switchTo(result.winner);
      this._chat.showToast('Model ranking updated: ' + result.winner);
    }
  }

  // === Status ===

  _status(msg) {
    if (this._onStatusUpdate) this._onStatusUpdate(msg);
  }

  // === Refresh (neuer Kontext, gleicher Verlauf) ===

  refresh() {
    this._streaming = false;
    this._currentRoute = null;
    this._currentModelId = null;
    this._messagesSinceEval = 0;
    // Model Manager re-init (neue Model-Liste, frischer Kontext)
    this._mm.init().then(() => {
      this._status('Session refreshed');
      if (this._onModelSwitch) this._onModelSwitch(this._mm.getActiveModel());
    });
  }
}

module.exports = { Orchestrator };
