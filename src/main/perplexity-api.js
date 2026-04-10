'use strict';

// === Perplexity API Client ===
// Web-Research mit Quellenangaben, Echtzeit-Suche
// API: OpenAI-kompatibel (pplx-api)
// Models: sonar, sonar-pro, sonar-reasoning, sonar-deep-research

const https = require('https');

const PERPLEXITY_HOST = 'api.perplexity.ai';

const PERPLEXITY_MODELS = [
  { id: 'sonar', name: 'Sonar', tier: 'A', description: 'Schnelle Web-Suche + Antwort' },
  { id: 'sonar-pro', name: 'Sonar Pro', tier: 'S', description: 'Tiefe Recherche mit Quellen' },
  { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', tier: 'S', description: 'Multi-Step Reasoning + Suche' },
  { id: 'sonar-deep-research', name: 'Sonar Deep Research', tier: 'S', description: 'Autonome Tiefenrecherche' },
];

function perplexityChatStream(model, messages, apiKey, { onChunk, onDone, onError, system }) {
  const pplxMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  const body = JSON.stringify({
    model: model || 'sonar',
    messages: pplxMessages,
    stream: true,
  });

  const options = {
    hostname: PERPLEXITY_HOST, port: 443, path: '/chat/completions', method: 'POST',
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
      res.on('end', () => onError(new Error(`Perplexity ${res.statusCode}: ${errData.slice(0, 200)}`)));
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
  req.setTimeout(120000, () => { req.destroy(); onError(new Error('Perplexity stream timeout')); });
  req.write(body);
  req.end();
  return () => { aborted = true; req.destroy(); };
}

// Non-streaming for research queries (returns citations)
function perplexitySearch(query, apiKey, { model, system } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: model || 'sonar',
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: query },
      ],
    });

    const req = https.request({
      hostname: PERPLEXITY_HOST, port: 443, path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            answer: parsed.choices?.[0]?.message?.content || '',
            citations: parsed.citations || [],
            model: parsed.model,
            usage: parsed.usage,
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { perplexityChatStream, perplexitySearch, PERPLEXITY_MODELS };
