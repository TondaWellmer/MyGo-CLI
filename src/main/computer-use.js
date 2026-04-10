'use strict';

// === Pangea Computer Use ===
// Screenshots + Mouse/Keyboard control for Claude Computer Use API
// Uses Electron's desktopCapturer for screenshots, native addon for input

const { screen, desktopCapturer, nativeImage, clipboard } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const SCREENSHOT_DIR = path.join(os.tmpdir(), 'pangea-screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// --- Screenshot ---

async function takeScreenshot(displayId) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
  });

  const source = displayId
    ? sources.find(s => s.display_id === String(displayId)) || sources[0]
    : sources[0];

  if (!source) throw new Error('No screen source found');

  const image = source.thumbnail;
  const pngBuffer = image.toPNG();
  const base64 = pngBuffer.toString('base64');

  // Also save to file for debugging
  const filepath = path.join(SCREENSHOT_DIR, `screenshot-${Date.now()}.png`);
  fs.writeFileSync(filepath, pngBuffer);

  const { width, height } = image.getSize();
  return { base64, width, height, filepath, mimeType: 'image/png' };
}

// --- Screen Info ---

function getScreenInfo() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return {
    primary: {
      id: primary.id,
      width: primary.size.width,
      height: primary.size.height,
      scaleFactor: primary.scaleFactor,
    },
    displays: displays.map(d => ({
      id: d.id,
      width: d.size.width,
      height: d.size.height,
      scaleFactor: d.scaleFactor,
      bounds: d.bounds,
    })),
  };
}

// --- Mouse & Keyboard (PowerShell-based, no native addon needed) ---
// Works on Windows without compiling native modules

function mouseMove(x, y) {
  return _runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})`);
}

function mouseClick(x, y, button = 'left') {
  const btnCode = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
  // Move + click via SendInput
  return _runPS(`
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class Mouse {
      [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
      [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
      public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
      public const uint MOUSEEVENTF_LEFTUP = 0x0004;
      public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
      public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
      public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
      public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
      public static void Click(int x, int y, string btn) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        uint down = btn == "right" ? MOUSEEVENTF_RIGHTDOWN : btn == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
        uint up = btn == "right" ? MOUSEEVENTF_RIGHTUP : btn == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
        mouse_event(down, 0, 0, 0, 0);
        System.Threading.Thread.Sleep(30);
        mouse_event(up, 0, 0, 0, 0);
      }
    }
"@
    [Mouse]::Click(${Math.round(x)}, ${Math.round(y)}, "${button}")
  `);
}

function mouseDoubleClick(x, y) {
  return _runPS(`
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class Mouse2 {
      [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
      [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
      public static void DoubleClick(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(0x0002, 0, 0, 0, 0); mouse_event(0x0004, 0, 0, 0, 0);
        System.Threading.Thread.Sleep(80);
        mouse_event(0x0002, 0, 0, 0, 0); mouse_event(0x0004, 0, 0, 0, 0);
      }
    }
"@
    [Mouse2]::DoubleClick(${Math.round(x)}, ${Math.round(y)})
  `);
}

function mouseDrag(startX, startY, endX, endY) {
  return _runPS(`
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class MouseDrag {
      [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
      [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
      public static void Drag(int x1, int y1, int x2, int y2) {
        SetCursorPos(x1, y1);
        System.Threading.Thread.Sleep(50);
        mouse_event(0x0002, 0, 0, 0, 0);
        System.Threading.Thread.Sleep(50);
        SetCursorPos(x2, y2);
        System.Threading.Thread.Sleep(50);
        mouse_event(0x0004, 0, 0, 0, 0);
      }
    }
"@
    [MouseDrag]::Drag(${Math.round(startX)}, ${Math.round(startY)}, ${Math.round(endX)}, ${Math.round(endY)})
  `);
}

function mouseScroll(x, y, deltaY) {
  return _runPS(`
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class MouseScroll {
      [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
      [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
      public static void Scroll(int x, int y, int delta) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(30);
        mouse_event(0x0800, 0, 0, (uint)(delta * 120), 0);
      }
    }
"@
    [MouseScroll]::Scroll(${Math.round(x)}, ${Math.round(y)}, ${deltaY})
  `);
}

function keyType(text) {
  // Use clipboard + Ctrl+V for reliable text input (handles unicode)
  return _runPS(`
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Clipboard]::SetText('${text.replace(/'/g, "''")}')
    [System.Windows.Forms.SendKeys]::SendWait('^v')
  `);
}

function keyPress(key) {
  // Map common key names to SendKeys format
  const KEY_MAP = {
    'enter': '{ENTER}', 'return': '{ENTER}', 'tab': '{TAB}',
    'escape': '{ESC}', 'esc': '{ESC}', 'backspace': '{BS}', 'delete': '{DEL}',
    'up': '{UP}', 'down': '{DOWN}', 'left': '{LEFT}', 'right': '{RIGHT}',
    'home': '{HOME}', 'end': '{END}', 'pageup': '{PGUP}', 'pagedown': '{PGDN}',
    'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}', 'f5': '{F5}',
    'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}', 'f9': '{F9}', 'f10': '{F10}',
    'f11': '{F11}', 'f12': '{F12}', 'space': ' ',
  };
  const sendKey = KEY_MAP[key.toLowerCase()] || key;
  return _runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKey}')`);
}

function keyCombo(modifiers, key) {
  // modifiers: ['ctrl'], ['ctrl', 'shift'], etc.
  let prefix = '';
  for (const mod of modifiers) {
    if (mod === 'ctrl' || mod === 'control') prefix += '^';
    else if (mod === 'alt') prefix += '%';
    else if (mod === 'shift') prefix += '+';
    else if (mod === 'win') prefix += '{LWIN}';
  }
  const KEY_MAP = { 'enter': '{ENTER}', 'tab': '{TAB}', 'escape': '{ESC}', 'backspace': '{BS}', 'delete': '{DEL}' };
  const sendKey = KEY_MAP[key.toLowerCase()] || key.toLowerCase();
  return _runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${prefix}${sendKey}')`);
}

// --- Claude Computer Use API ---

function buildComputerUseTool() {
  return {
    type: 'computer_20250124',
    name: 'computer',
    display_width_px: screen.getPrimaryDisplay().size.width,
    display_height_px: screen.getPrimaryDisplay().size.height,
    display_number: 1,
  };
}

async function executeComputerAction(action) {
  const { type } = action;
  try {
    switch (type) {
      case 'screenshot':
        return await takeScreenshot(action.display_id);

      case 'click':
        await mouseClick(action.coordinate[0], action.coordinate[1], action.button || 'left');
        return { success: true };

      case 'double_click':
        await mouseDoubleClick(action.coordinate[0], action.coordinate[1]);
        return { success: true };

      case 'drag':
        await mouseDrag(action.start_coordinate[0], action.start_coordinate[1], action.end_coordinate[0], action.end_coordinate[1]);
        return { success: true };

      case 'scroll':
        await mouseScroll(action.coordinate[0], action.coordinate[1], action.delta_y || -3);
        return { success: true };

      case 'type':
        await keyType(action.text);
        return { success: true };

      case 'key':
        if (action.modifiers && action.modifiers.length > 0) {
          await keyCombo(action.modifiers, action.key);
        } else {
          await keyPress(action.key);
        }
        return { success: true };

      case 'move':
        await mouseMove(action.coordinate[0], action.coordinate[1]);
        return { success: true };

      case 'wait':
        await new Promise(r => setTimeout(r, (action.duration || 1) * 1000));
        return { success: true };

      default:
        return { success: false, error: `Unknown action type: ${type}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// --- Computer Use Chat Loop ---
// Sends messages to Claude with computer_use tool, executes actions, loops

async function computerUseChat(apiKey, messages, { onAction, onMessage, onError, onDone, model, system }) {
  const tool = buildComputerUseTool();
  const claudeModel = model || 'claude-sonnet-4-6';

  // Take initial screenshot
  const initialScreenshot = await takeScreenshot();

  // Add screenshot to first message
  const augmentedMessages = [...messages];
  if (augmentedMessages.length > 0) {
    const lastMsg = augmentedMessages[augmentedMessages.length - 1];
    if (lastMsg.role === 'user') {
      augmentedMessages[augmentedMessages.length - 1] = {
        role: 'user',
        content: [
          ...(typeof lastMsg.content === 'string' ? [{ type: 'text', text: lastMsg.content }] : lastMsg.content),
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: initialScreenshot.base64 },
          },
        ],
      };
    }
  }

  let loopCount = 0;
  const MAX_LOOPS = 20;

  async function loop(currentMessages) {
    if (loopCount++ >= MAX_LOOPS) {
      onDone('Max loops reached');
      return;
    }

    const body = {
      model: claudeModel,
      max_tokens: 4096,
      system: system || 'You have access to a computer. Use the computer tool to interact with it. Take screenshots to see the current state.',
      messages: currentMessages,
      tools: [tool],
    };

    try {
      const response = await _claudeApiCall(apiKey, body);

      if (response.error) {
        onError(response.error.message || JSON.stringify(response.error));
        return;
      }

      // Process response content blocks
      const textBlocks = [];
      const toolUseBlocks = [];

      for (const block of response.content || []) {
        if (block.type === 'text') {
          textBlocks.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
        }
      }

      // Send text to UI
      if (textBlocks.length > 0) {
        onMessage(textBlocks.join('\n'));
      }

      // If no tool use, we're done
      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        onDone('completed');
        return;
      }

      // Execute tool calls
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        onAction({ type: toolUse.input.type, ...toolUse.input });

        const result = await executeComputerAction(toolUse.input);

        if (result.base64) {
          // Screenshot result
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: result.base64 },
            }],
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.success ? 'Action completed.' : `Error: ${result.error}`,
          });
        }
      }

      // Continue the loop with tool results
      const nextMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];

      // Small delay between actions
      await new Promise(r => setTimeout(r, 300));
      await loop(nextMessages);

    } catch (err) {
      onError(err.message);
    }
  }

  await loop(augmentedMessages);
}

// --- Claude API (non-streaming, for tool use) ---

function _claudeApiCall(apiKey, body) {
  return new Promise((resolve, reject) => {
    const jsonBody = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'computer-use-2025-01-24',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('API timeout')); });
    req.write(jsonBody);
    req.end();
  });
}

// --- PowerShell helper ---

function _runPS(script) {
  return new Promise((resolve, reject) => {
    const escaped = script.replace(/"/g, '\\"');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${escaped}"`, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

module.exports = {
  takeScreenshot,
  getScreenInfo,
  mouseMove, mouseClick, mouseDoubleClick, mouseDrag, mouseScroll,
  keyType, keyPress, keyCombo,
  buildComputerUseTool,
  executeComputerAction,
  computerUseChat,
};
