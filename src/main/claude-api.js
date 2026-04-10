'use strict';

const https = require('https');

const ANTHROPIC_HOST = 'api.anthropic.com';
const API_VERSION = '2023-06-01';

function claudeChatStream(model, messages, apiKey, { onChunk, onDone, onError, system }) {
  const anthropicMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  const body = JSON.stringify({
    model: model || 'claude-sonnet-4-6',
    messages: anthropicMessages,
    max_tokens: 8192,
    stream: true,
    ...(system ? { system } : {}),
  });
  const authHeaders = { 'x-api-key': apiKey };
  const options = {
    hostname: ANTHROPIC_HOST, port: 443, path: '/v1/messages', method: 'POST',
    headers: {
      'Content-Type': 'application/json', ...authHeaders,
      'anthropic-version': API_VERSION, 'Accept': 'text/event-stream',
    },
  };
  let aborted = false;
  const req = https.request(options, (res) => {
    if (res.statusCode === 429) { onError(new Error('TOKENS_EXHAUSTED:429')); return; }
    if (res.statusCode >= 400) {
      let errData = '';
      res.on('data', c => errData += c);
      res.on('end', () => onError(new Error(`Claude API ${res.statusCode}: ${errData.slice(0, 200)}`)));
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
          if (parsed.type === 'content_block_delta') {
            const delta = parsed.delta?.text;
            if (delta) onChunk(delta);
          } else if (parsed.type === 'message_stop') { onDone(); return; }
        } catch {}
      }
    });
    res.on('end', () => { if (!aborted) onDone(); });
  });
  req.on('error', (err) => { if (!aborted) onError(err); });
  req.setTimeout(120000, () => { req.destroy(); onError(new Error('Claude API stream timeout')); });
  req.write(body);
  req.end();
  return () => { aborted = true; req.destroy(); };
}

module.exports = { claudeChatStream };
