'use strict';

// === OpenAI API Client (GPT-5.4, Codex, o-series) ===
// Direct OpenAI API — for when you have an OpenAI API key or Codex plugin.
// OpenCode already proxies GPT models, but this enables direct access.

const https = require('https');

const OPENAI_HOST = 'api.openai.com';

function openaiChatStream(model, messages, apiKey, { onChunk, onDone, onError, system }) {
  const openaiMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  const body = JSON.stringify({
    model: model || 'gpt-4o',
    messages: openaiMessages,
    max_tokens: 8192,
    stream: true,
  });

  const options = {
    hostname: OPENAI_HOST, port: 443, path: '/v1/chat/completions', method: 'POST',
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
      res.on('end', () => onError(new Error(`OpenAI ${res.statusCode}: ${errData.slice(0, 200)}`)));
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
  req.setTimeout(120000, () => { req.destroy(); onError(new Error('OpenAI stream timeout')); });
  req.write(body);
  req.end();
  return () => { aborted = true; req.destroy(); };
}

function listModels(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: OPENAI_HOST, port: 443, path: '/v1/models', method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.data || []);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

module.exports = { openaiChatStream, listModels };
