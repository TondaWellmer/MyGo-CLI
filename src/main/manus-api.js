'use strict';

// === Manus API Client ===
// Autonomous AI Agent Platform (Meta/Anthropic-backed)
// Can execute multi-step tasks: research, coding, file ops, web browsing
// API: REST + WebSocket for real-time updates

const https = require('https');

const MANUS_HOST = 'api.manus.ai';

function manusCreateTask(task, apiKey, { onUpdate, onDone, onError, model } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      task,
      model: model || 'default',
    });

    const req = https.request({
      hostname: MANUS_HOST, port: 443, path: '/v1/tasks', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const err = parsed.error?.message || `Manus ${res.statusCode}`;
            if (onError) onError(new Error(err));
            reject(new Error(err));
            return;
          }
          if (onDone) onDone(parsed);
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => { if (onError) onError(e); reject(e); });
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Manus timeout')); });
    req.write(body);
    req.end();
  });
}

function manusGetTask(taskId, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: MANUS_HOST, port: 443, path: `/v1/tasks/${taskId}`, method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function manusListTasks(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: MANUS_HOST, port: 443, path: '/v1/tasks', method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).tasks || []); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { manusCreateTask, manusGetTask, manusListTasks };
