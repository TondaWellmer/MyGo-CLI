# MyGo-CLI

AI Chat Terminal mit kostenlosen und Premium-Modellen, Multi-Login und Multi-Tab Terminal.

## Voraussetzungen

- **Node.js** v18+ ([nodejs.org](https://nodejs.org))
- **Git** mit Git Bash ([git-scm.com](https://git-scm.com))
- **Windows Build Tools** (fuer node-pty):
  ```
  npm install -g windows-build-tools
  ```
  Falls das nicht klappt: Visual Studio Build Tools installieren mit "Desktop Development with C++" Workload.

## Installation

```bash
git clone https://github.com/TondaWellmer/MyGo-CLI.git
cd MyGo-CLI
npm install
```

Falls `npm install` bei node-pty fehlschlaegt:
```bash
npm install --build-from-source
# oder:
npx electron-rebuild
```

## Starten

```bash
npm start
```

## Features

- **Multi-Tab Terminal** mit echtem PTY (Git Bash)
- **AI Chat** mit kostenlosen Modellen (OpenCode, Gemini)
- **Multi-Login** fuer Google/Gemini Accounts (Token-Rotation bei Rate Limits)
- **Session History** — Sessions speichern, laden, wiederherstellen
- **Work Sessions** — kompletten Tab-Zustand snapshotten
- **Crash Recovery** — nach Absturz letzte Session wiederherstellen

## Google Login einrichten (optional, fuer Gemini)

1. MyGo-CLI starten
2. Im Chat-Bereich auf "Gemini" Toggle klicken
3. Google Account einloggen
4. Mehrere Accounts moeglich (rotiert automatisch bei Rate Limits)

## Troubleshooting

**"node-pty build failed"**: Windows Build Tools fehlen. `npm install -g windows-build-tools` ausfuehren (als Admin).

**"electron not found"**: `npm install` nochmal ausfuehren.

**Leerer Bildschirm nach Start**: `npm run build` separat ausfuehren, dann `electron .`
