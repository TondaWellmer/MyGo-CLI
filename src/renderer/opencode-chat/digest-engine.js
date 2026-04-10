'use strict';

const RESULT_MARKERS = /(?:^|\n)\s*(?:ergebnis|result|fertig|done|erstellt|created|gespeichert|saved|geändert|changed|zusammenfassung|summary)\s*[:：]/im;

/**
 * DigestEngine v2 — Processes Claude responses in the background via free models.
 * Produces user-relevant summaries that appear in the Auto tab.
 * NO meta-noise, NO file paths, NO URLs (those come from the sidebar hook).
 * Only substantive content: what Claude answered, key decisions, results.
 */
class DigestEngine {
  constructor() {
    this._items = [];
    this._messageCount = 0;
    this._lastLLMSummaryAt = 0;
    this._llmSummarizer = null;
    this._onNewItem = null; // callback to push items to Auto tab
  }

  setLLMSummarizer(fn) { this._llmSummarizer = fn; }

  /** Register callback for new digest items → Auto tab */
  onNewItem(fn) { this._onNewItem = fn; }

  async processMessage(content) {
    if (!content || content.length < 100) return; // skip trivial responses
    this._messageCount++;

    const needsLLM = this._shouldUseLLM(content);
    if (needsLLM && this._llmSummarizer) {
      try {
        const summary = await this._llmSummarizer(content);
        if (summary && summary.length > 20) {
          const item = {
            type: 'answer',
            question: this._extractContext(content),
            answer: summary,
            timestamp: new Date().toISOString()
          };
          this._items.push(item);
          this._lastLLMSummaryAt = this._messageCount;
          if (this._onNewItem) this._onNewItem(item);
        }
      } catch {}
    } else if (content.length > 300) {
      // Fallback: extract first meaningful sentence as quick summary
      const quickSummary = this._quickExtract(content);
      if (quickSummary) {
        const item = {
          type: 'message',
          text: quickSummary,
          timestamp: new Date().toISOString()
        };
        this._items.push(item);
        if (this._onNewItem) this._onNewItem(item);
      }
    }
  }

  _shouldUseLLM(content) {
    // Throttle: at least 3 messages between LLM calls
    if (this._messageCount - this._lastLLMSummaryAt < 3) return false;
    // Long, substantive responses
    if (content.length > 600) return true;
    // Contains result markers
    if (RESULT_MARKERS.test(content)) return true;
    return false;
  }

  _extractContext(content) {
    // Try to extract what Claude was responding to — first line or header
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      const first = lines[0].replace(/^[#*\->\s]+/, '').trim();
      if (first.length > 10 && first.length < 120) return first;
    }
    return 'Claude Antwort';
  }

  _quickExtract(content) {
    // Extract first non-code, non-header meaningful sentence
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip code, headers, empty, very short
      if (!trimmed || trimmed.startsWith('```') || trimmed.startsWith('#')) continue;
      if (trimmed.length < 30) continue;
      // Skip lines that are just file paths or tool output
      if (/^[A-Z]:\\|^\/[\w]|^\s*\d+\s*\|/.test(trimmed)) continue;
      // Return first real sentence, truncated
      return trimmed.length > 150 ? trimmed.substring(0, 147) + '...' : trimmed;
    }
    return null;
  }
}

module.exports = { DigestEngine };
