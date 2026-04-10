'use strict';

// === Gemini API Client (Free Tier) ===
// Google AI Studio free tier: Gemini 2.5 Flash, Gemini 2.0 Flash etc.
// Rate limits: 15 RPM / 1M TPM / 1500 RPD (free tier)
// No credit card needed — just a Google AI API key

const https = require('https');

const GEMINI_HOST = 'generativelanguage.googleapis.com';

function geminiChatStream(model, messages, apiKey, { onChunk, onDone, onError }) {
  // Convert OpenAI-style messages to Gemini format
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = JSON.stringify({
    contents,
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.7,
    },
  });

  const path = `/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const options = {
    hostname: GEMINI_HOST, port: 443, path, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };

  let aborted = false;
  const req = https.request(options, (res) => {
    if (res.statusCode === 429) { onError(new Error('TOKENS_EXHAUSTED:429')); return; }
    if (res.statusCode >= 400) {
      let errData = '';
      res.on('data', c => errData += c);
      res.on('end', () => onError(new Error(`Gemini API ${res.statusCode}: ${errData.slice(0, 200)}`)));
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
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) onChunk(text);
          // Check for finish reason
          if (parsed.candidates?.[0]?.finishReason === 'STOP') { onDone(); return; }
        } catch {}
      }
    });
    res.on('end', () => { if (!aborted) onDone(); });
  });
  req.on('error', (err) => { if (!aborted) onError(err); });
  req.setTimeout(120000, () => { req.destroy(); onError(new Error('Gemini API stream timeout')); });
  req.write(body);
  req.end();
  return () => { aborted = true; req.destroy(); };
}

// Static fallback — used when dynamic listing fails. IDs must match API exactly.
const FREE_GEMINI_MODELS = [
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'S', baseline: 92 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'A', baseline: 84 },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', tier: 'A', baseline: 76 },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', tier: 'S', baseline: 93 },
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', tier: 'S', baseline: 90 },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', tier: 'A', baseline: 82 },
  { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite', tier: 'A', baseline: 76 },
];

// OAuth-based: Use Google OAuth2 access token (Bearer auth)
// When user logs in via Google in the embedded browser,
// we extract the access token for the generativelanguage API
function geminiChatStreamOAuth(model, messages, accessToken, { onChunk, onDone, onError }) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = JSON.stringify({
    contents,
    generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
  });

  const reqPath = `/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  const options = {
    hostname: GEMINI_HOST, port: 443, path: reqPath, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
  };

  let aborted = false;
  const req = https.request(options, (res) => {
    if (res.statusCode === 429) { onError(new Error('TOKENS_EXHAUSTED:429')); return; }
    if (res.statusCode === 401 || res.statusCode === 403) { onError(new Error('GOOGLE_AUTH_EXPIRED')); return; }
    if (res.statusCode >= 400) {
      let errData = '';
      res.on('data', c => errData += c);
      res.on('end', () => onError(new Error(`Gemini API ${res.statusCode}: ${errData.slice(0, 200)}`)));
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
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) onChunk(text);
          if (parsed.candidates?.[0]?.finishReason === 'STOP') { onDone(); return; }
        } catch {}
      }
    });
    res.on('end', () => { if (!aborted) onDone(); });
  });
  req.on('error', (err) => { if (!aborted) onError(err); });
  req.setTimeout(120000, () => { req.destroy(); onError(new Error('Gemini API stream timeout')); });
  req.write(body);
  req.end();
  return () => { aborted = true; req.destroy(); };
}

// Fetch available models from the API (discovers what the token has access to)
function listGeminiModels(accessTokenOrApiKey, isApiKey) {
  return new Promise((resolve, reject) => {
    const query = isApiKey ? `?key=${accessTokenOrApiKey}` : '';
    const headers = isApiKey ? {} : { 'Authorization': `Bearer ${accessTokenOrApiKey}` };
    const options = {
      hostname: GEMINI_HOST, port: 443,
      path: `/v1beta/models${query}`,
      method: 'GET', headers,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = (parsed.models || [])
            .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
            .map(m => ({
              id: m.name?.replace('models/', '') || m.name,
              name: m.displayName || m.name,
              inputTokenLimit: m.inputTokenLimit,
              outputTokenLimit: m.outputTokenLimit,
            }));
          resolve(models);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

module.exports = { geminiChatStream, geminiChatStreamOAuth, listGeminiModels, FREE_GEMINI_MODELS };
