'use strict';

// === Vertex AI Claude Bridge ===
// Calls Claude models via Google Vertex AI using OAuth2 Bearer token
// No Anthropic API key needed — just a Google account with cloud-platform scope
// Free tier: Vertex AI gives credits for Claude usage

const https = require('https');

const VERTEX_REGIONS = ['us-east5', 'us-central1', 'europe-west1'];
const VERTEX_HOST_TEMPLATE = '{REGION}-aiplatform.googleapis.com';

// Claude models on Vertex AI use Anthropic's native format
// Vertex AI wraps them at: /v1/projects/{PROJECT}/locations/{REGION}/publishers/anthropic/models/{MODEL}:streamRawPredict
// For Express mode (no project): /v1beta1/projects/-/locations/{REGION}/publishers/anthropic/models/{MODEL}:streamRawPredict

const CLAUDE_VERTEX_MODELS = [
  { id: 'claude-opus-4@20250514', name: 'Claude Opus 4', tier: 'S', baseline: 98 },
  { id: 'claude-sonnet-4@20250514', name: 'Claude Sonnet 4', tier: 'S', baseline: 92 },
  { id: 'claude-haiku-4@20250514', name: 'Claude Haiku 4', tier: 'A', baseline: 75 },
  { id: 'claude-sonnet-4-5@20250514', name: 'Claude Sonnet 4.5', tier: 'S', baseline: 94 },
];

function vertexClaudeChatStream(model, messages, accessToken, { onChunk, onDone, onError, region }) {
  const selectedRegion = region || VERTEX_REGIONS[0];
  const hostname = VERTEX_HOST_TEMPLATE.replace('{REGION}', selectedRegion);

  // Convert to Anthropic message format
  const anthropicMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const body = JSON.stringify({
    anthropic_version: 'vertex-2023-10-16',
    messages: anthropicMessages,
    max_tokens: 8192,
    stream: true,
  });

  // Express mode: project = "-" (auto)
  const reqPath = `/v1/projects/-/locations/${selectedRegion}/publishers/anthropic/models/${model}:streamRawPredict`;

  const options = {
    hostname, port: 443, path: reqPath, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
  };

  let aborted = false;
  const req = https.request(options, (res) => {
    if (res.statusCode === 429) { onError(new Error('TOKENS_EXHAUSTED:429')); return; }
    if (res.statusCode === 401 || res.statusCode === 403) {
      let errData = '';
      res.on('data', c => errData += c);
      res.on('end', () => {
        if (errData.includes('not enabled') || errData.includes('PERMISSION_DENIED')) {
          onError(new Error('VERTEX_NOT_ENABLED:' + errData.slice(0, 200)));
        } else {
          onError(new Error('GOOGLE_AUTH_EXPIRED'));
        }
      });
      return;
    }
    if (res.statusCode >= 400) {
      let errData = '';
      res.on('data', c => errData += c);
      res.on('end', () => onError(new Error(`Vertex AI ${res.statusCode}: ${errData.slice(0, 200)}`)));
      return;
    }

    // Vertex AI streams SSE in Anthropic format
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
          } else if (parsed.type === 'message_stop') {
            onDone(); return;
          }
        } catch {}
      }
    });
    res.on('end', () => { if (!aborted) onDone(); });
  });
  req.on('error', (err) => { if (!aborted) onError(err); });
  req.setTimeout(120000, () => { req.destroy(); onError(new Error('Vertex AI stream timeout')); });
  req.write(body);
  req.end();
  return () => { aborted = true; req.destroy(); };
}

// Check if Vertex AI Claude is accessible with given token
function testVertexAccess(accessToken) {
  return new Promise((resolve) => {
    const hostname = VERTEX_HOST_TEMPLATE.replace('{REGION}', VERTEX_REGIONS[0]);
    const req = https.request({
      hostname, port: 443,
      path: '/v1/projects/-/locations/' + VERTEX_REGIONS[0] + '/publishers/anthropic/models',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        resolve({ status: res.statusCode, available: res.statusCode < 400, response: data.slice(0, 300) });
      });
    });
    req.on('error', () => resolve({ status: 0, available: false }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, available: false }); });
    req.end();
  });
}

module.exports = { vertexClaudeChatStream, testVertexAccess, CLAUDE_VERTEX_MODELS, VERTEX_REGIONS };
