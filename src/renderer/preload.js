const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pangea', {
  // Terminal — Multi-Tab
  onTerminalData: (cb) => ipcRenderer.on('terminal:data', (_, data) => cb(data)),
  onTerminalExit: (cb) => ipcRenderer.on('terminal:exit', (_, data) => cb(data)),
  onTerminalRespawned: (cb) => ipcRenderer.on('terminal:respawned', (_, data) => cb(data)),
  sendTerminalInput: (data) => ipcRenderer.send('terminal:input', data),
  resizeTerminal: (colsOrObj, rows) => {
    if (typeof colsOrObj === 'object') {
      ipcRenderer.send('terminal:resize', colsOrObj);
    } else {
      ipcRenderer.send('terminal:resize', { cols: colsOrObj, rows });
    }
  },
  createTab: () => ipcRenderer.invoke('terminal:create-tab'),
  closeTab: (tabId) => ipcRenderer.send('terminal:close-tab', tabId),
  setActiveTab: (tabId) => ipcRenderer.send('terminal:set-active-tab', tabId),
  setTabColor: (tabId, color) => ipcRenderer.send('terminal:set-tab-color', { tabId, color }),
  setTabName: (tabId, name) => ipcRenderer.send('terminal:set-tab-name', { tabId, name }),

  // Sidebar
  onSidebarUpdate: (cb) => ipcRenderer.on('sidebar:update', (_, data) => cb(data)),
  onPinnedUpdate: (cb) => ipcRenderer.on('sidebar:pinned-update', (_, data) => cb(data)),
  getPinned: () => ipcRenderer.invoke('sidebar:get-pinned'),
  openUrl: (url) => ipcRenderer.send('sidebar:open-url', url),
  openFile: (path) => ipcRenderer.send('sidebar:open-file', path),
  openFolder: (path) => ipcRenderer.send('sidebar:open-folder', path),
  pinItem: (item) => ipcRenderer.send('sidebar:pin', item),
  unpinItem: (item) => ipcRenderer.send('sidebar:unpin', item),
  pushAutoItem: (item) => ipcRenderer.send('sidebar:push-auto', item),

  // Instance Config
  getInstanceConfig: () => ipcRenderer.invoke('instance:get-config'),
  setColor: (color) => ipcRenderer.send('instance:set-color', color),
  setTextColor: (color) => ipcRenderer.send('instance:set-text-color', color),
  setSidebarColor: (color) => ipcRenderer.send('instance:set-sidebar-color', color),
  setName: (name) => ipcRenderer.send('instance:set-name', name),

  // CWD / Subprojects
  getCwdInfo: () => ipcRenderer.invoke('cwd:get-info'),
  changeCwd: (newCwd) => ipcRenderer.send('cwd:change', newCwd),

  // Text Shots
  saveTextShot: (text) => ipcRenderer.invoke('textshot:save', text),
  listTextShots: () => ipcRenderer.invoke('textshot:list'),
  readTextShot: (path) => ipcRenderer.invoke('textshot:read', path),

  // Project Explorer
  getProjectTree: () => ipcRenderer.invoke('explorer:get-tree'),
  getHiddenFiles: () => ipcRenderer.invoke('explorer:get-hidden'),
  hideFile: (path) => ipcRenderer.send('explorer:hide-file', path),
  unhideAll: (folder) => ipcRenderer.send('explorer:unhide-all', folder),

  // Session ID + History
  getSessionId: (tabId) => ipcRenderer.invoke('session:get-id', tabId),
  onSessionIdUpdate: (cb) => ipcRenderer.on('session:id-update', (_, id) => cb(id)),
  copySessionResume: (id) => ipcRenderer.send('session:copy-resume', id),
  getSessionHistory: () => ipcRenderer.invoke('session:get-history'),
  addCurrentSessionToHistory: () => ipcRenderer.invoke('session:add-current-to-history'),
  loadSession: (id) => ipcRenderer.send('session:load', id),

  // Work Sessions
  getWorkSessions: () => ipcRenderer.invoke('worksession:list'),
  saveWorkSession: (name) => ipcRenderer.invoke('worksession:save', name),
  loadWorkSession: (id) => ipcRenderer.invoke('worksession:load', id),
  renameWorkSession: (id, name) => ipcRenderer.invoke('worksession:rename', { id, name }),
  deleteWorkSession: (id) => ipcRenderer.invoke('worksession:delete', id),
  recoverWorkSession: () => ipcRenderer.invoke('worksession:recover'),
  getOpenTabs: () => ipcRenderer.invoke('worksession:get-open-tabs'),
  onWorkSessionRestore: (cb) => ipcRenderer.on('worksession:restore', (_, data) => cb(data)),

  // Sidebar Stream (Auto-Tab)
  addSidebarAnswer: (question, answer) => ipcRenderer.send('sidebar:add-answer', { question, answer }),
  addSidebarMilestone: (text, files) => ipcRenderer.send('sidebar:add-milestone', { text, files }),
  addSidebarMessage: (text, files) => ipcRenderer.send('sidebar:add-message', { text, files }),

  // Attachments
  pasteImage: () => ipcRenderer.invoke('attachment:paste-image'),
  pickFiles: () => ipcRenderer.invoke('attachment:pick-files'),
  getFileDataUrl: (filePath) => ipcRenderer.invoke('attachment:get-data-url', filePath),
  getAttachHistory: () => ipcRenderer.invoke('attachment:get-history'),
  addToAttachHistory: (files) => ipcRenderer.send('attachment:add-to-history', files),

  // Editor
  saveEditorFile: (filePath, data) => ipcRenderer.invoke('editor:save-file', filePath, data),
  readEditorFile: (filePath) => ipcRenderer.invoke('editor:read-file', filePath),
  readBinaryFile: (filePath) => ipcRenderer.invoke('editor:read-binary-file', filePath),
  showSaveDialog: (options) => ipcRenderer.invoke('editor:show-save-dialog', options || {}),
  showOpenDialog: (options) => ipcRenderer.invoke('editor:show-open-dialog', options || {}),
  fileExists: (filePath) => ipcRenderer.invoke('editor:file-exists', filePath),

  // Editor Send
  getAttachmentsDir: () => ipcRenderer.invoke('editor:get-attachments-dir'),
  injectAttachment: (filePath) => ipcRenderer.send('editor:inject-attachment', filePath),
  onAttachmentInjected: (cb) => ipcRenderer.on('editor:attachment-injected', (_, data) => cb(data)),

  // Video Editor
  getVideoMetadata: (filePath) => ipcRenderer.invoke('video:get-metadata', filePath),
  runFFmpeg: (args) => ipcRenderer.invoke('video:run-ffmpeg', args),
  onFFmpegProgress: (cb) => ipcRenderer.on('video:ffmpeg-progress', (_, data) => cb(data)),

  // Proxy System
  getProxyRoot: (projectName) => ipcRenderer.invoke('proxy:get-root', projectName),
  runFFmpegProxy: (opts) => ipcRenderer.invoke('proxy:run-ffmpeg', opts),
  onProxyProgress: (cb) => ipcRenderer.on('proxy:ffmpeg-progress', (_, data) => cb(data)),
  cancelFFmpegProxy: (id) => ipcRenderer.send('proxy:cancel-ffmpeg', id),
  checkFFmpeg: () => ipcRenderer.invoke('proxy:check-ffmpeg'),

  // AI CLI (SAM2 / CoTracker3) — spawns Python child process in main
  spawnPython: (opts) => ipcRenderer.invoke('ai:spawn-python', opts),
  findPython: () => ipcRenderer.invoke('ai:find-python'),

  // Secrets (DPAPI-encrypted via powershell)
  getSecret: (name) => ipcRenderer.invoke('secret:get', name),
  setSecret: (name, value) => ipcRenderer.invoke('secret:set', name, value),

  // Luma Labs API (Dream Machine — video/image generation)
  lumaRequest: (opts) => ipcRenderer.invoke('luma:request', opts),
  lumaGenerate: (prompt, options) => ipcRenderer.invoke('luma:request', { method: 'POST', path: '/generations', body: { prompt, ...options } }),
  lumaGetGeneration: (id) => ipcRenderer.invoke('luma:request', { method: 'GET', path: `/generations/${id}` }),
  lumaListGenerations: (limit, offset) => ipcRenderer.invoke('luma:request', { method: 'GET', path: `/generations?limit=${limit || 10}&offset=${offset || 0}` }),
  lumaHasKey: () => ipcRenderer.invoke('secret:get', 'LUMAAI_API_KEY').then(k => !!k),

  // Premiere .prproj (GZip → XML in main process)
  readPrprojXml: (filePath) => ipcRenderer.invoke('prproj:read-xml', filePath),

  // Cross-Editor Bridge
  sendImageToVideo: (dataUrl, name, duration) => ipcRenderer.invoke('cross:image-to-video', { dataUrl, name, duration }),
  sendFrameToImage: (dataUrl, name) => ipcRenderer.invoke('cross:frame-to-image', { dataUrl, name }),
  routePrompt: (prompt, context) => ipcRenderer.invoke('ai:route-prompt', { prompt, context }),
  onCrossEditorTransfer: (cb) => ipcRenderer.on('cross:transfer', (_, data) => cb(data)),

  // Video Editor AI API (programmatic control from external AI agents)
  videoApiCall: (method, ...args) => ipcRenderer.invoke('video-api:call', { method, args }),
  videoApiInvoke: (method, ...args) => ipcRenderer.invoke(`video-api:${method}`, ...args),
  onVideoApiInvoke: (cb) => ipcRenderer.on('video-api:invoke', (_, data) => cb(data)),
  sendVideoApiResponse: (data) => ipcRenderer.send('video-api:response', data),

  // Skills Manager
  listSkills: () => ipcRenderer.invoke('skills:list'),
  toggleSkill: (name, enabled) => ipcRenderer.send('skills:toggle', { name, enabled }),
  toggleSkillCategory: (project, type, enabled) => ipcRenderer.send('skills:toggle-category', { project, type, enabled }),
  syncSkills: () => ipcRenderer.invoke('skills:sync'),
  onSkillsUpdated: (cb) => ipcRenderer.on('skills:updated', (_, data) => cb(data)),

  // Generic JSON (read/write files in ~/.claude/)
  readJSON: (filename) => ipcRenderer.invoke('readJSON', filename),
  writeJSON: (filename, data) => ipcRenderer.invoke('writeJSON', filename, data),

  // OpenCode Token (reads from ~/.local/share/opencode/auth.json)
  readOpenCodeToken: () => ipcRenderer.invoke('opencode:readToken'),

  // MCP Management
  listMCPs: () => ipcRenderer.invoke('mcp:list'),
  toggleMCP: (name, enabled) => ipcRenderer.invoke('mcp:toggle', name, enabled),

  // OpenCode Chat (Token wird NUR im Main-Prozess verwaltet)
  opencodeLogin: () => ipcRenderer.send('opencode:login'),
  readClaudeCredentials: () => ipcRenderer.invoke('claude:readCredentials'),
  opencodeExchangeCode: (code) => ipcRenderer.invoke('opencode:exchangeCode', code),
  saveOpenCodeToken: (token) => ipcRenderer.invoke('opencode:saveToken', token),
  onAuthUrl: (cb) => ipcRenderer.on('opencode:auth-url', (_, data) => cb(data)),
  opencodeIsAuthenticated: () => ipcRenderer.invoke('opencode:isAuthenticated'),
  onAuthComplete: (cb) => ipcRenderer.on('opencode:auth-complete', (_, data) => cb(data)),
  opencodeAuthStatus: () => ipcRenderer.invoke('opencode:auth-status'),
  opencodeModels: () => ipcRenderer.invoke('opencode:models'),
  opencodeChat: (model, messages) => ipcRenderer.send('opencode:chat', { model, messages }),
  onOpencodeStream: (cb) => ipcRenderer.on('opencode:chat-stream', (_, data) => cb(data)),
  opencodeAbort: () => ipcRenderer.send('opencode:abort'),

  // Recraft V4 Image API
  recraftGenerate: (opts) => ipcRenderer.invoke('recraft:generate', opts),
  recraftRemoveBackground: (imageUrl) => ipcRenderer.invoke('recraft:removeBackground', imageUrl),
  recraftClarityUpscale: (imageUrl) => ipcRenderer.invoke('recraft:clarityUpscale', imageUrl),
  recraftGenerativeUpscale: (imageUrl) => ipcRenderer.invoke('recraft:generativeUpscale', imageUrl),
  recraftVectorize: (imageUrl) => ipcRenderer.invoke('recraft:vectorize', imageUrl),
  recraftInpaint: (imageUrl, maskUrl, prompt) => ipcRenderer.invoke('recraft:inpaint', imageUrl, maskUrl, prompt),
  recraftReplaceBackground: (imageUrl, prompt) => ipcRenderer.invoke('recraft:replaceBackground', imageUrl, prompt),
  recraftListStyles: () => ipcRenderer.invoke('recraft:listStyles'),
  recraftHasKey: () => ipcRenderer.invoke('recraft:hasKey'),

  // Claude API Chat (direct Anthropic API — needs API key)
  claudeChat: (model, messages, apiKey, system) => ipcRenderer.send('claude:chat', { model, messages, apiKey, system }),
  onClaudeStream: (cb) => ipcRenderer.on('claude:chat-stream', (_, data) => cb(data)),

  // Vertex AI Claude (Claude via Google Login — no API key needed)
  vertexClaudeModels: () => ipcRenderer.invoke('vertex:claude-models'),
  vertexTestAccess: () => ipcRenderer.invoke('vertex:test-access'),
  vertexClaudeChat: (model, messages) => ipcRenderer.send('vertex:claude-chat', { model, messages }),
  onVertexClaudeStream: (cb) => ipcRenderer.on('vertex:claude-stream', (_, data) => cb(data)),

  // Gemini Free Tier Chat (OAuth or API key)
  geminiModels: () => ipcRenderer.invoke('gemini:models'),
  geminiIsAuthenticated: () => ipcRenderer.invoke('gemini:isAuthenticated'),
  geminiChat: (model, messages) => ipcRenderer.send('gemini:chat', { model, messages }),
  onGeminiStream: (cb) => ipcRenderer.on('gemini:chat-stream', (_, data) => cb(data)),
  geminiSaveCookies: (cookies) => ipcRenderer.invoke('gemini:saveCookies', cookies),
  geminiExtractCookies: () => ipcRenderer.invoke('gemini:extractCookies'),
  geminiExchangeCode: (codeOrObj) => ipcRenderer.invoke('gemini:exchangeCode', codeOrObj),
  geminiStartOAuthServer: () => ipcRenderer.invoke('gemini:startOAuthServer'),
  onGeminiOAuthCode: (cb) => ipcRenderer.on('gemini:oauth-code', (_, code) => cb(code)),
  geminiSaveToken: (tokenData) => ipcRenderer.invoke('gemini:saveToken', tokenData),
  geminiListAccounts: () => ipcRenderer.invoke('gemini:listAccounts'),
  geminiRemoveAccount: (email) => ipcRenderer.invoke('gemini:removeAccount', email),

  // OneToRule (1 Login → alle Modelle)
  onetoruleStatus: () => ipcRenderer.invoke('onetorule:status'),
  onetoruleLogin: () => ipcRenderer.invoke('onetorule:login'),
  onetoruleRefresh: () => ipcRenderer.invoke('onetorule:refresh'),
  onetoruleEnsureFresh: () => ipcRenderer.invoke('onetorule:ensure-fresh'),
  onetoruleGetToken: () => ipcRenderer.invoke('onetorule:get-token'),
  onOnetoruleProgress: (cb) => ipcRenderer.on('onetorule:progress', (_, data) => cb(data)),
  onOnetoruleStartupStatus: (cb) => ipcRenderer.on('onetorule:startup-status', (_, data) => cb(data)),

  // Kairos Always-On Agent
  kairosState: () => ipcRenderer.invoke('kairos:state'),
  kairosNotifications: (unreadOnly) => ipcRenderer.invoke('kairos:notifications', unreadOnly),
  kairosMarkRead: (index) => ipcRenderer.invoke('kairos:markRead', index),
  kairosMarkAllRead: () => ipcRenderer.invoke('kairos:markAllRead'),
  kairosDream: () => ipcRenderer.invoke('kairos:dream'),
  kairosAddTask: (task) => ipcRenderer.invoke('kairos:addTask', task),
  kairosAddWatcher: (name, command) => ipcRenderer.invoke('kairos:addWatcher', { name, command }),
  kairosRemoveWatcher: (name) => ipcRenderer.invoke('kairos:removeWatcher', name),
  onKairosNotification: (cb) => ipcRenderer.on('kairos:notification', (_, data) => cb(data)),

  // OpenAI / Codex (GPT-5.4, o-series — direct API)
  openaiIsAuthenticated: () => ipcRenderer.invoke('openai:isAuthenticated'),
  openaiModels: () => ipcRenderer.invoke('openai:models'),
  openaiSaveKey: (key) => ipcRenderer.invoke('openai:saveKey', key),
  openaiChat: (model, messages, system) => ipcRenderer.send('openai:chat', { model, messages, system }),
  onOpenaiStream: (cb) => ipcRenderer.on('openai:chat-stream', (_, data) => cb(data)),

  // MiniMax M2.5 (Opus-Level, 1/20 Kosten)
  minimaxIsAuthenticated: () => ipcRenderer.invoke('minimax:isAuthenticated'),
  minimaxSaveKey: (key) => ipcRenderer.invoke('minimax:saveKey', key),
  minimaxChat: (model, messages, system) => ipcRenderer.send('minimax:chat', { model, messages, system }),
  onMinimaxStream: (cb) => ipcRenderer.on('minimax:chat-stream', (_, data) => cb(data)),

  // Ollama (local models — this machine or remote 5090)
  ollamaIsAvailable: () => ipcRenderer.invoke('ollama:isAvailable'),
  ollamaModels: () => ipcRenderer.invoke('ollama:models'),
  ollamaHost: () => ipcRenderer.invoke('ollama:host'),
  ollamaSetHost: (host) => ipcRenderer.invoke('ollama:setHost', host),
  ollamaChat: (model, messages) => ipcRenderer.send('ollama:chat', { model, messages }),
  onOllamaStream: (cb) => ipcRenderer.on('ollama:chat-stream', (_, data) => cb(data)),
  ollamaPull: (modelName) => ipcRenderer.invoke('ollama:pull', modelName),
  onOllamaPullProgress: (cb) => ipcRenderer.on('ollama:pull-progress', (_, data) => cb(data)),

  // Perplexity (Web-Research mit Quellenangaben)
  perplexityIsAuthenticated: () => ipcRenderer.invoke('perplexity:isAuthenticated'),
  perplexitySearch: (query, options) => ipcRenderer.invoke('perplexity:search', { query, ...options }),
  perplexityChat: (model, messages, system) => ipcRenderer.send('perplexity:chat', { model, messages, system }),
  onPerplexityStream: (cb) => ipcRenderer.on('perplexity:chat-stream', (_, data) => cb(data)),

  // Manus (Autonomous AI Agent Platform)
  manusIsAuthenticated: () => ipcRenderer.invoke('manus:isAuthenticated'),
  manusCreateTask: (task, options) => ipcRenderer.invoke('manus:createTask', { task, ...options }),
  manusGetTask: (taskId) => ipcRenderer.invoke('manus:getTask', taskId),
  manusListTasks: () => ipcRenderer.invoke('manus:listTasks'),

  // Computer Use (screenshot + mouse/keyboard control)
  computerScreenshot: (displayId) => ipcRenderer.invoke('computer:screenshot', displayId),
  computerScreenInfo: () => ipcRenderer.invoke('computer:screenInfo'),
  computerAction: (action) => ipcRenderer.invoke('computer:action', action),
  computerChat: (task, model, system) => ipcRenderer.send('computer:chat', { task, model, system }),
  onComputerUpdate: (cb) => ipcRenderer.on('computer:chat-update', (_, data) => cb(data)),
  computerAbort: () => ipcRenderer.send('computer:abort'),

  // Windows Dictation (Win+H push-to-talk)
  startDictation: () => ipcRenderer.invoke('dictation:start'),
  stopDictation: () => ipcRenderer.invoke('dictation:stop'),

  // App lifecycle
  onCloseRequested: (cb) => ipcRenderer.on('app:close-requested', () => cb()),
  confirmClose: () => ipcRenderer.send('app:close-confirmed'),
  onCrashRecovery: (cb) => ipcRenderer.on('app:crash-recovery', (_, state) => cb(state)),
  relaunchApp: () => ipcRenderer.send('app:relaunch'),
});
