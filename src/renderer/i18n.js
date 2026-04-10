'use strict';

const locales = {
  en: {
    // Chat
    'chat.title': 'Pangea Chat',
    'chat.welcome': 'Ask me anything — I automatically use the best available model.',
    'chat.login.title': 'Use Gratis Models',
    'chat.login.sub': 'Automatic selection of best free available models.',
    'chat.login.btn': 'Sign In',
    'chat.login.hint': 'Token is securely stored. One-time login.',
    'chat.login.progress': 'Signing in...',
    'chat.login.connected': 'Connected!',
    'chat.input.placeholder': 'Type a message...',
    'chat.model.connecting': 'Connecting...',
    'chat.model.none': 'No Model',
    'chat.model.switch': 'Switched to',
    'chat.model.exhausted': 'All free models exhausted.',
    'chat.error.noModels': 'No free models available. Try again later.',
    'chat.error.notConnected': 'Not connected to OpenCode. Please sign in.',
    'chat.status.ready': 'Ready',
    'chat.status.error': 'Error',
    'chat.status.noModels': 'No Models',
    'chat.claude.label': 'Claude',
    'chat.source.api': 'API',
    'chat.source.account': 'Account',
    'chat.refresh.title': 'New context (keep history)',
    'chat.budget.label': 'Token Budget',
    // Settings
    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.theme': 'Theme',
    'settings.font': 'Font',
    'settings.fontSize': 'Font Size',
    'settings.save': 'Save',
    // Sidebar
    'sidebar.projects': 'Projects',
    'sidebar.pinned': 'Pinned',
    'sidebar.auto': 'Auto',
    'sidebar.digest': 'Digest',
    'sidebar.digest.empty': 'No chat results yet',
    'sidebar.skills': 'Skills',
    'sidebar.skills.title': 'Skills & MCPs',
    'sidebar.skills.refresh': 'Context Reload',
    // Titlebar
    'titlebar.chat': 'Chat (Free + Premium Models)',
    'titlebar.terminal': 'Terminal',
    'titlebar.editor': 'Image Editor',
    'titlebar.video': 'Video Editor',
    'titlebar.ai': 'AI Assistant',
    'titlebar.settings': 'Settings',
    // General
    'general.close': 'Close',
    'general.cancel': 'Cancel',
    'general.loading': 'Loading...',
  },
  de: {
    'chat.title': 'Pangea Chat',
    'chat.welcome': 'Frag mich was — ich nutze automatisch das beste verfuegbare Model.',
    'chat.login.title': 'Gratis Models nutzen',
    'chat.login.sub': 'Automatische Auswahl der besten kostenlosen Models.',
    'chat.login.btn': 'Anmelden',
    'chat.login.hint': 'Token wird sicher gespeichert. Einmaliger Login.',
    'chat.login.progress': 'Anmeldung laeuft...',
    'chat.login.connected': 'Verbunden!',
    'chat.input.placeholder': 'Nachricht eingeben...',
    'chat.model.connecting': 'Verbinde...',
    'chat.model.none': 'Kein Model',
    'chat.model.switch': 'Gewechselt zu',
    'chat.model.exhausted': 'Alle Free-Models aufgebraucht.',
    'chat.error.noModels': 'Keine Free-Models verfuegbar. Bitte spaeter versuchen.',
    'chat.error.notConnected': 'Nicht mit OpenCode verbunden. Bitte anmelden.',
    'chat.status.ready': 'Bereit',
    'chat.status.error': 'Fehler',
    'chat.status.noModels': 'Keine Models',
    'chat.claude.label': 'Claude',
    'chat.source.api': 'API',
    'chat.source.account': 'Account',
    'chat.refresh.title': 'Neuer Kontext (Verlauf bleibt)',
    'chat.budget.label': 'Token-Budget',
    'settings.title': 'Einstellungen',
    'settings.language': 'Sprache',
    'settings.theme': 'Design',
    'settings.font': 'Schriftart',
    'settings.fontSize': 'Schriftgroesse',
    'settings.save': 'Speichern',
    'sidebar.projects': 'Projekte',
    'sidebar.pinned': 'Angepinnt',
    'sidebar.auto': 'Auto',
    'sidebar.digest': 'Digest',
    'sidebar.digest.empty': 'Noch keine Chat-Ergebnisse',
    'sidebar.skills': 'Skills',
    'sidebar.skills.title': 'Skills & MCPs',
    'sidebar.skills.refresh': 'Context Reload',
    'titlebar.chat': 'Chat (Free + Premium Models)',
    'titlebar.terminal': 'Terminal',
    'titlebar.editor': 'Bild-Editor',
    'titlebar.video': 'Video-Editor',
    'titlebar.ai': 'AI Assistent',
    'titlebar.settings': 'Einstellungen',
    'general.close': 'Schliessen',
    'general.cancel': 'Abbrechen',
    'general.loading': 'Lade...',
  },
};

let _currentLocale = 'en';
let _onLocaleChange = [];

function setLocale(locale) {
  if (!locales[locale]) return;
  _currentLocale = locale;
  _onLocaleChange.forEach(fn => fn(locale));
}

function getLocale() { return _currentLocale; }
function getAvailableLocales() { return Object.keys(locales); }

function t(key) {
  return locales[_currentLocale]?.[key] || locales.en?.[key] || key;
}

function onLocaleChange(fn) { _onLocaleChange.push(fn); }

module.exports = { t, setLocale, getLocale, getAvailableLocales, onLocaleChange };
