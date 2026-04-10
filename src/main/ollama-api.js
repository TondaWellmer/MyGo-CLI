'use strict';

// === Ollama API Client (Local Models) ===
// OpenAI-compatible API. Host configurable: localhost (this machine) or remote (5090 machine).
// Default: localhost:11434. Override via OLLAMA_HOST env or config.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(os.homedir(), '.claude', 'pangea-ollama.json');

function _loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { host: 'http://localhost:11434' };
  }
}

function _saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getHost() {
  return process.env.OLLAMA_HOST || _loadConfig().host || 'http://localhost:11434';
}

function setHost(host) {
  const config = _loadConfig();
  config.host = host;
  _saveConfig(config);
}

function _parseHost(hostUrl) {
  const url = new URL(hostUrl);
  return {
    protocol: url.protocol === 'https:' ? https : http,
    hostname: url.hostname,
    port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 11434),
  };
}

// --- List available models ---
function listModels() {
  const { protocol, hostname, port } = _parseHost(getHost());
  return new Promise((resolve, reject) => {
    const req = protocol.request({ hostname, port, path: '/api/tags', method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = (parsed.models || []).map(m => ({
            id: m.name || m.model,
            name: m.name || m.model,
            size: m.size,
            modified: m.modified_at,
            family: m.details?.family,
            parameterSize: m.details?.parameter_size,
            quantization: m.details?.quantization_level,
          }));
          resolve(models);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Ollama not reachable at ' + getHost())); });
    req.end();
  });
}

// --- Check if Ollama is running ---
function isAvailable() {
  const { protocol, hostname, port } = _parseHost(getHost());
  return new Promise((resolve) => {
    const req = protocol.request({ hostname, port, path: '/', method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// --- Chat Stream (OpenAI-compatible /v1/chat/completions) ---
function ollamaChatStream(model, messages, { onChunk, onDone, onError }) {
  const { protocol, hostname, port } = _parseHost(getHost());
  const body = JSON.stringify({ model, messages, stream: true });

  const req = protocol.request({
    hostname, port, path: '/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, (res) => {
    if (res.statusCode >= 400) {
      let errData = '';
      res.on('data', c => errData += c);
      res.on('end', () => onError(new Error(`Ollama ${res.statusCode}: ${errData.slice(0, 200)}`)));
      return;
    }
    let buffer = '';
    res.on('data', (chunk) => {
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
    res.on('end', () => onDone());
  });
  req.on('error', (err) => onError(err));
  req.setTimeout(120000, () => { req.destroy(); onError(new Error('Ollama stream timeout')); });
  req.write(body);
  req.end();
  return () => req.destroy();
}

// --- Native Ollama API (for pull, generate, etc.) ---
function ollamaChatNative(model, messages, { onChunk, onDone, onError }) {
  const { protocol, hostname, port } = _parseHost(getHost());
  const body = JSON.stringify({ model, messages, stream: true });

  const req = protocol.request({
    hostname, port, path: '/api/chat', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, (res) => {
    if (res.statusCode >= 400) {
      let errData = '';
      res.on('data', c => errData += c);
      res.on('end', () => onError(new Error(`Ollama ${res.statusCode}: ${errData.slice(0, 200)}`)));
      return;
    }
    res.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) onChunk(parsed.message.content);
          if (parsed.done) onDone();
        } catch {}
      }
    });
    res.on('end', () => onDone());
  });
  req.on('error', (err) => onError(err));
  req.setTimeout(120000, () => { req.destroy(); onError(new Error('Ollama timeout')); });
  req.write(body);
  req.end();
  return () => req.destroy();
}

// --- Pull a model ---
function pullModel(modelName, onProgress) {
  const { protocol, hostname, port } = _parseHost(getHost());
  const body = JSON.stringify({ name: modelName, stream: true });

  return new Promise((resolve, reject) => {
    const req = protocol.request({
      hostname, port, path: '/api/pull', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      res.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (onProgress) onProgress(parsed);
            if (parsed.status === 'success') resolve(true);
          } catch {}
        }
      });
      res.on('end', () => resolve(true));
    });
    req.on('error', reject);
    req.setTimeout(600000, () => { req.destroy(); reject(new Error('Pull timeout')); }); // 10 min
    req.write(body);
    req.end();
  });
}

module.exports = { listModels, isAvailable, ollamaChatStream, ollamaChatNative, pullModel, getHost, setHost };
