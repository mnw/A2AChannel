// state.js — shared globals, DOM handles, and tiny helpers; loaded before all other UI modules.

let BUS = 'http://127.0.0.1:8011';
let AUTH_TOKEN = '';
let HUMAN_NAME = 'you';

const handoffCards    = new Map();
const interruptCards  = new Map();
const permissionCards = new Map();
const MESSAGE_DOM_LIMIT = 2000;
const ATTACHMENT_URL_RE = /^\/image\/[A-Za-z0-9_-]+\.[a-z0-9]{1,10}$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

// Tauri WebView returns null from window.prompt for security; this replaces it.
const reasonModal       = document.getElementById('reason-modal');
const reasonModalTitle  = document.getElementById('reason-modal-title');
const reasonModalPrompt = document.getElementById('reason-modal-prompt');
const reasonModalInput  = document.getElementById('reason-modal-input');
const reasonModalOk     = document.getElementById('reason-modal-ok');
const reasonModalCancel = document.getElementById('reason-modal-cancel');
let _reasonResolve = null;
function askReason(title, promptText, { required = false, defaultValue = '' } = {}) {
  return new Promise((resolve) => {
    _reasonResolve = resolve;
    reasonModalTitle.textContent = title;
    reasonModalPrompt.textContent = promptText;
    reasonModalInput.value = defaultValue;
    reasonModalInput.dataset.required = required ? '1' : '0';
    reasonModal.classList.add('open');
    setTimeout(() => { reasonModalInput.focus(); reasonModalInput.select(); }, 0);
  });
}
function _closeReasonModal(val) {
  reasonModal.classList.remove('open');
  const r = _reasonResolve;
  _reasonResolve = null;
  if (r) r(val);
}
reasonModalOk?.addEventListener('click', () => {
  const v = reasonModalInput.value.trim();
  if (reasonModalInput.dataset.required === '1' && !v) {
    reasonModalInput.focus();
    return;
  }
  _closeReasonModal(v);
});
reasonModalCancel?.addEventListener('click', () => _closeReasonModal(null));
reasonModal?.addEventListener('click', (e) => {
  if (e.target === reasonModal) _closeReasonModal(null);
});
reasonModalInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); _closeReasonModal(null); }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); reasonModalOk.click(); }
});

const _confirmModal   = document.getElementById('confirm-modal');
const _confirmTitle   = document.getElementById('confirm-title');
const _confirmPrompt  = document.getElementById('confirm-prompt');
const _confirmOk      = document.getElementById('confirm-ok');
const _confirmCancel  = document.getElementById('confirm-cancel');
let _confirmResolve = null;
function askConfirm(title, prompt) {
  return new Promise((resolve) => {
    _confirmResolve = resolve;
    if (_confirmTitle)  _confirmTitle.textContent  = title;
    if (_confirmPrompt) _confirmPrompt.textContent = prompt;
    _confirmModal?.classList.add('open');
    setTimeout(() => _confirmOk?.focus(), 0);
  });
}
function _closeConfirm(result) {
  _confirmModal?.classList.remove('open');
  const r = _confirmResolve;
  _confirmResolve = null;
  if (r) r(result);
}
_confirmOk?.addEventListener('click',     () => _closeConfirm(true));
_confirmCancel?.addEventListener('click', () => _closeConfirm(false));
_confirmModal?.addEventListener('click', (e) => {
  if (e.target === _confirmModal) _closeConfirm(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _confirmModal?.classList.contains('open')) _closeConfirm(false);
});

const messagesEl = document.getElementById('messages');
const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const input = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const legendEl = document.getElementById('legend');
const targetEl = document.getElementById('target');
const targetDisplay = document.getElementById('target-display');
const targetDisplayText = targetDisplay?.querySelector('.target-display-text');
const targetMenu = document.getElementById('target-menu');
const emojiBtn = document.getElementById('emoji-btn');
const emojiPop = document.getElementById('emoji-popover');
const mentionPop = document.getElementById('mention-popover');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const attachRow = document.getElementById('attachment-row');
const dropOverlay = document.getElementById('drop-overlay');

let lastFrom = null;
let pendingImageUrl = null;
let presenceState = {};
let mentionMatches = [];
let mentionActive = 0;

const EMOJIS = [
  '😀','😁','😂','🤣','😊','😉','😍','😘','🤔','🙃',
  '😎','🤩','😢','😭','😡','🤯','😱','🥳','🤗','🙄',
  '👍','👎','👌','🙏','👏','🙌','💪','🤝','✌️','🤘',
  '❤️','🔥','✨','⭐','💯','🎉','🚀','💡','⚡','✅',
  '❌','⚠️','🐛','🔧','🛠️','📦','📁','📝','💻','🖥️',
  '🌐','☁️','🔒','🔑','🔍','📊','📈','📉','🎯','🏁',
];

const NAMES = { you: 'You', system: 'System', all: 'All' };

// ROOM_ALL = "show every room"; human is super-user across rooms, filter is view-only.
const SELECTED_ROOM_KEY = 'a2achannel_selected_room';
const ROOM_ALL = '__ALL__';
let SELECTED_ROOM = localStorage.getItem(SELECTED_ROOM_KEY) || ROOM_ALL;

const COLORS = {};
let ROSTER = [];
// Inline because Tauri 2's nonce-CSP blocks dynamic <style> tags.
const BODY_COLORS = {};

// Handles v1/v2 invoke namespace split.
function tauriInvoke(cmd, args) {
  const invoke =
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.core?.invoke ||
    window.__TAURI__?.invoke;
  if (!invoke) return Promise.reject(new Error('Tauri IPC unavailable'));
  return args !== undefined ? invoke(cmd, args) : invoke(cmd);
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function shade(hex, pct) {
  // pct positive = lighter (used for msg-body color).
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  r = Math.min(255, Math.round(r + (255 - r) * pct));
  g = Math.min(255, Math.round(g + (255 - g) * pct));
  b = Math.min(255, Math.round(b + (255 - b) * pct));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function cssName(name) {
  return 'a-' + name.replace(/[^A-Za-z0-9_-]/g, '_');
}
