#!/bin/bash
# Pangea Sidebar Hook — runs after Claude tool calls
# Auto-Tab: NUR user-relevante Inhalte, KEINE Meta-Noise
#
# WAS ANGEZEIGT WIRD:
# - Zusammenfassungen von Claude-Antworten (via Pearl/Free Models)
# - Erstellte HTML/relevante User-Dateien
# - Wichtige URLs (nicht npm/registry/github-intern)
# - Echte Fehler die den User betreffen
#
# WAS NICHT ANGEZEIGT WIRD:
# - "Task X erledigt" Meta-Infos
# - Interne Dateien (JSON, config, .md, memory)
# - Agent-Starts (interessiert den User nicht)
# - Read/Glob/Grep/Edit Tool-Calls
# - TaskCreate/TaskUpdate Noise

SIDEBAR="$HOME/.claude/pangea-sidebar.json"
NODE="$(which node 2>/dev/null || echo node)"
HOOK_INPUT=$(cat)

if [ ! -f "$SIDEBAR" ]; then
  echo '{"auto":[],"pinned":[]}' > "$SIDEBAR"
fi

"$NODE" -e "
const fs = require('fs');
const path = require('path');

const input = JSON.parse(process.argv[1] || '{}');
const sidebarPath = process.argv[2];

const toolName = input.tool_name || '';
const toolInput = input.tool_input || {};
const toolOutput = String(input.tool_output || '');

let sidebar;
try {
  sidebar = JSON.parse(fs.readFileSync(sidebarPath, 'utf-8'));
} catch(e) {
  sidebar = { auto: [], pinned: [] };
}

if (!sidebar.auto) sidebar.auto = [];
const ts = new Date().toISOString();
const MAX_AUTO = 50;

// --- Nur user-relevante Dateitypen ---
const USER_FILE_EXTS = /\.(html?|css|jsx?|tsx?|py|sh|sql|vue|svelte|php)$/i;
const IGNORE_PATTERNS = [
  /settings\.json/i, /package\.json/i, /package-lock/i,
  /node_modules/i, /\.env/i, /\.lock/i, /tsconfig/i,
  /\.git\//i, /dist\//i, /\.bundle\.js/i,
  /MEMORY\.md/i, /memory\//i, /CLAUDE\.md/i,
  /\.md$/i, /\.json$/i, /\.txt$/i,
];

function isUserFile(filePath) {
  if (!filePath) return false;
  if (IGNORE_PATTERNS.some(p => p.test(filePath))) return false;
  return USER_FILE_EXTS.test(filePath);
}

// --- Write: Nur user-relevante Dateien (HTML, CSS, JS etc.) ---
if (toolName === 'Write') {
  const fp = toolInput.file_path || '';
  if (fp && isUserFile(fp)) {
    const name = path.basename(fp);
    sidebar.auto.unshift({
      type: 'message',
      text: 'Neue Datei: ' + name,
      path: fp,
      label: name,
      timestamp: ts
    });
  }
}

// --- Bash: Nur wichtige URLs und echte User-relevante Fehler ---
if (toolName === 'Bash') {
  const urlMatch = toolOutput.match(/https?:\\/\\/[^\\s\"'<>\\]\\)]+/g);
  if (urlMatch) {
    const noiseUrls = /npmjs|github\.com|registry\.|localhost|node_modules|127\.0\.0|::1/;
    const unique = [...new Set(urlMatch)].filter(u => !noiseUrls.test(u)).slice(0, 2);
    unique.forEach(url => {
      sidebar.auto.unshift({
        type: 'message',
        text: url,
        url: url,
        label: url.replace(/^https?:\\/\\//, '').substring(0, 60),
        timestamp: ts
      });
    });
  }
}

// Trim + Deduplizierung
if (sidebar.auto.length > MAX_AUTO) {
  sidebar.auto = sidebar.auto.slice(0, MAX_AUTO);
}

if (sidebar.auto.length >= 2) {
  const a = sidebar.auto[0];
  const b = sidebar.auto[1];
  if (a.text === b.text && a.timestamp && b.timestamp) {
    const diff = new Date(a.timestamp) - new Date(b.timestamp);
    if (Math.abs(diff) < 2000) {
      sidebar.auto.shift();
    }
  }
}

fs.writeFileSync(sidebarPath, JSON.stringify(sidebar, null, 2));
" "$HOOK_INPUT" "$SIDEBAR" 2>/dev/null

exit 0
