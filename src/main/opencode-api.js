'use strict';

const https = require('https');
const { shell } = require('electron');

const ZEN_BASE = 'opencode.ai';
const ZEN_PATH_PREFIX = '/zen/v1';

function zenRequest(method, path, body, authToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: ZEN_BASE, port: 443, path: `${ZEN_PATH_PREFIX}${path}`, method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error(`Zen API ${res.statusCode}: ${data.slice(0, 200)}`)); return; }
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Zen API timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function zenChatStream(model, messages, authToken, { onChunk, onDone, onError }) {
  const body = JSON.stringify({ model, messages, stream: true });
  const options = {
    hostname: ZEN_BASE, port: 443, path: `${ZEN_PATH_PREFIX}/chat/completions`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`, 'Accept': 'text/event-stream' },
  };
  let aborted = false;
  const req = https.request(options, (res) => {
    if (res.statusCode === 429 || res.statusCode === 402) { onError(new Error(`TOKENS_EXHAUSTED:${res.statusCode}`)); return; }
    if (res.statusCode >= 400) {
      let errData = '';
      res.on('data', c => errData += c);
      res.on('end', () => onError(new Error(`Zen API ${res.statusCode}: ${errData.slice(0, 200)}`)));
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
        } catch {}
      }
    });
    res.on('end', () => { if (!aborted) onDone(); });
  });
  req.on('error', (err) => { if (!aborted) onError(err); });
  req.setTimeout(120000, () => { req.destroy(); onError(new Error('Zen API stream timeout')); });
  req.write(body);
  req.end();
  return () => { aborted = true; req.destroy(); };
}

async function fetchModels(authToken) {
  const data = await zenRequest('GET', '/models', null, authToken);
  return data.data || data.models || [];
}

function openAuthPage() { shell.openExternal('https://opencode.ai/auth'); }

module.exports = { zenRequest, zenChatStream, fetchModels, openAuthPage };
