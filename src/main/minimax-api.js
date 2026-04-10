'use strict';

// === MiniMax M2.5 API Client ===
// Konkurriert mit Opus 4.6 bei 1/20 der Kosten, 37% schneller.
// OpenAI-kompatibles API-Format.

const https = require('https');

const MINIMAX_HOST = 'api.minimax.chat';

function minimaxChatStream(model, messages, apiKey, { onChunk, onDone, onError, system }) {
  const miniMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  const body = JSON.stringify({
    model: model || 'MiniMax-M2.5',
    messages: miniMessages,
    max_tokens: 8192,
    stream: true,
  });

  const options = {
    hostname: MINIMAX_HOST, port: 443, path: '/v1/chat/completions', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  };

  let aborted = false;
  const req = https.request(options, (res) => {
    if (res.statusCode === 429) { onError(new Error('TOKENS_EXHAUSTED:429')); return; }
    if (res.statusCode >= 400) {
      let errData = '';
      res.on('data', c => errData += c);
      res.on('end', () => onError(new Error(`MiniMax ${res.statusCode}: ${errData.slice(0, 200)}`)));
      return;
    }
    let buffer = '';
    res.on('data', (chunk) => {
      if (aborted) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') { onDone(); return; }
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) onChunk(delta);
          if (parsed.choices?.[0]?.finish_reason === 'stop') { onDone(); return; }
        } catch {}
      }
    });
    res.on('end', () => { if (!aborted) onDone(); });
  });
  req.on('error', (err) => { if (!aborted) onError(err); });
  req.setTimeout(120000, () => { req.destroy(); onError(new Error('MiniMax stream timeout')); });
  req.write(body);
  req.end();
  return () => { aborted = true; req.destroy(); };
}

module.exports = { minimaxChatStream };
