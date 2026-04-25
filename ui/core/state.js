// state.js — module-level globals, DOM element handles, and tiny helpers
// shared across every UI module. Tier 1 of ui/index.html (no dependencies
// on other modules). Loaded BEFORE everything else.
//
// Convention: declare here; mutate from feature modules. The "current room"
// state and roster state live here even though their CRUD lives in rooms.js
// and roster.js — that's deliberate, so any module can read SELECTED_ROOM /
// ROSTER / COLORS without dragging in the renderer.
//
// Exposes (as globals via classic-script lexical scope):
//   Hub: BUS, AUTH_TOKEN, HUMAN_NAME
//   Card maps: handoffCards, interruptCards, permissionCards
//   Constants: MESSAGE_DOM_LIMIT, ATTACHMENT_URL_RE, IMAGE_EXT_RE, EMOJIS, NAMES
//   Roster: COLORS, ROSTER, BODY_COLORS
//   Room state: SELECTED_ROOM_KEY, ROOM_ALL, SELECTED_ROOM
//   Composer state: lastFrom, pendingImageUrl, presenceState, mentionMatches, mentionActive
//   DOM handles: messagesEl, dot, statusText, input, sendBtn, legendEl, targetEl,
//                targetDisplay, targetDisplayText, targetMenu, emojiBtn, emojiPop,
//                mentionPop, attachBtn, fileInput, attachRow, dropOverlay
//   Reason-modal helper: askReason
//   Tiny pure helpers: cap, shade, cssName

let BUS = 'http://127.0.0.1:8011';       // overridden at bootstrap via Tauri invoke
let AUTH_TOKEN = '';                     // filled by bootstrap(); bearer token for mutating routes
let HUMAN_NAME = 'you';                  // filled by bootstrap(); the human's identity in the roster

// Card state maps: declared here so cross-kind utilities (trimMessages,
// cleanup on reset, countdown timer) can access all three. Per-kind
// render/handle functions live in ui/kinds/<kind>.js and mutate via
// shared classic-script lexical scope.
const handoffCards    = new Map();  // handoff_id → { element, version, status, snapshot }
const interruptCards  = new Map();  // interrupt_id → { element, version, status, snapshot }
const permissionCards = new Map();  // request_id → { element, version, status, snapshot }
const MESSAGE_DOM_LIMIT = 2000;          // trim #messages to this many nodes
const ATTACHMENT_URL_RE = /^\/image\/[A-Za-z0-9_-]+\.[a-z0-9]{1,10}$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

// ── Reason-modal (window.prompt replacement; Tauri's WebView returns null
// from window.prompt for security). Used by handoff decline/cancel and any
// other place that needs a single-line text input via promise.
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

// ── Element handles. DOMContentLoaded already fired by the time this script
// runs (it's a classic <script>, not deferred / async). Stable for the app's
// lifetime — the DOM is built once at HTML parse.
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

// ── Mutable composer / roster state.
let lastFrom = null;
let pendingImageUrl = null;
let presenceState = {};        // {agent: bool}
let mentionMatches = [];       // current autocomplete matches
let mentionActive = 0;         // active index in popup

const EMOJIS = [
  '😀','😁','😂','🤣','😊','😉','😍','😘','🤔','🙃',
  '😎','🤩','😢','😭','😡','🤯','😱','🥳','🤗','🙄',
  '👍','👎','👌','🙏','👏','🙌','💪','🤝','✌️','🤘',
  '❤️','🔥','✨','⭐','💯','🎉','🚀','💡','⚡','✅',
  '❌','⚠️','🐛','🔧','🛠️','📦','📁','📝','💻','🖥️',
  '🌐','☁️','🔒','🔑','🔍','📊','📈','📉','🎯','🏁',
];

const NAMES = { you: 'You', system: 'System', all: 'All' };

// ── Room filter state. SELECTED_ROOM is persisted across launches in
// localStorage. ROOM_ALL is the special "show every room" sentinel — the
// human is super-user across rooms, so the filter is purely a view choice.
const SELECTED_ROOM_KEY = 'a2achannel_selected_room';
const ROOM_ALL = '__ALL__';
let SELECTED_ROOM = localStorage.getItem(SELECTED_ROOM_KEY) || ROOM_ALL;

// ── Roster state. Mutated by applyRoster (in roster.js); read everywhere.
const COLORS = {};   // name -> hex
let ROSTER = [];     // [{name, color}, ...]
// Per-agent colors are applied inline — Tauri 2's nonce-CSP blocks dynamic <style> tags.
const BODY_COLORS = {};

// ── Tauri IPC helper. Thin wrapper around the global invoke that handles
// the v1/v2 namespace split. Used by mcp-modal.js, the settings/reload
// buttons in main.js, and bootstrap. Promise-based; rejects when Tauri
// IPC isn't available (running outside the webview).
function tauriInvoke(cmd, args) {
  const invoke =
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.core?.invoke ||
    window.__TAURI__?.invoke;
  if (!invoke) return Promise.reject(new Error('Tauri IPC unavailable'));
  return args !== undefined ? invoke(cmd, args) : invoke(cmd);
}

// ── Tiny pure helpers used in many places.
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function shade(hex, pct) {
  // lighten for msg-body color (pct positive = lighter)
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
