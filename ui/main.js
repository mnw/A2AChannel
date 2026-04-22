let BUS = 'http://127.0.0.1:8011';       // overridden at bootstrap via Tauri invoke
let AUTH_TOKEN = '';                     // filled by bootstrap(); bearer token for mutating routes
let HUMAN_NAME = 'you';                  // filled by bootstrap(); the human's identity in the roster
const handoffCards = new Map();          // handoff_id → { element, version, status, snapshot }
const MESSAGE_DOM_LIMIT = 2000;          // trim #messages to this many nodes
// Generic attachment URL — any allowlisted extension served at /image/<id>.
// (The route is named /image/ for back-compat; the hub allowlist is what
// actually decides which extensions are accepted at upload time.)
const ATTACHMENT_URL_RE = /^\/image\/[A-Za-z0-9_-]+\.[a-z0-9]{1,10}$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

// Inline "ask for a reason" modal. Replaces window.prompt() which Tauri's
// WebView silently returns null from. Resolves to the user's text on OK
// (empty string if they OK'd without typing), or null on Cancel / Escape /
// backdrop click. If `required` is true, an empty input keeps the dialog open.
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

// Wrapper that adds Authorization to mutating fetches.
async function authedFetch(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return fetch(`${BUS}${path}`, { ...init, headers });
}

// Parse an error response body, preferring the JSON `error` field if present.
async function parseErrorBody(r) {
  try {
    const body = await r.text();
    if (!body) return `HTTP ${r.status}`;
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj.error === 'string') return obj.error;
    } catch {}
    return body;
  } catch {
    return `HTTP ${r.status}`;
  }
}
const messagesEl = document.getElementById('messages');
const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const input = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
sendBtn.addEventListener('click', () => send());
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
const COLORS = {};   // name -> hex
let ROSTER = [];     // [{name, color}, ...]

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

// Per-agent body colors pre-shaded. Caller (addMessage / renderLegend)
// reads COLORS[name] and BODY_COLORS[name] directly and applies via
// element.style.* — no dynamic <style> tag (Tauri 2's nonce-CSP blocks
// programmatically-inserted <style> elements even with 'unsafe-inline').
const BODY_COLORS = {};

// Sanitize agent name for CSS class use. Still needed for structural classes
// (mention highlighting, per-agent hover selectors) but no longer carries
// color — colors are inlined on the elements.
function cssName(name) {
  return 'a-' + name.replace(/[^A-Za-z0-9_-]/g, '_');
}

function applyRoster(agents) {
  ROSTER = Array.isArray(agents) ? agents : [];
  for (const k of Object.keys(NAMES)) {
    if (k !== 'you' && k !== 'system' && k !== 'all') delete NAMES[k];
  }
  for (const k of Object.keys(COLORS)) delete COLORS[k];
  for (const k of Object.keys(BODY_COLORS)) delete BODY_COLORS[k];

  for (const a of ROSTER) {
    NAMES[a.name] = cap(a.name);
    COLORS[a.name] = a.color;
    BODY_COLORS[a.name] = shade(a.color, 0.25);
  }

  renderLegend();
  renderTargetDropdown();
}

legendEl.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('.legend-remove');
  if (!btn) return;
  const item = btn.closest('.legend-item');
  const name = item?.dataset?.agent;
  if (!name || name === 'you') return;
  btn.disabled = true;
  try {
    const r = await authedFetch('/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: name }),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: 'you', text: `Remove failed: ${err}`, ts: '' });
      btn.disabled = false;
    }
    // On success the hub broadcasts roster update → UI rebuilds itself.
  } catch (err) {
    addMessage({ from: 'system', to: 'you', text: `Remove failed: ${err?.message ?? err}`, ts: '' });
    btn.disabled = false;
  }
});

function renderLegend() {
  // The human is just another roster member (registered by the hub at startup).
  // Rebuild all pills from ROSTER; the human comes through naturally.
  legendEl.innerHTML = '';

  for (const a of ROSTER) {
    const isHuman = a.name === HUMAN_NAME;
    const legItem = document.createElement('div');
    legItem.className = 'legend-item offline';
    legItem.dataset.agent = a.name;
    // The human pill never gets a remove button — it's a permanent roster member.
    const removeBtn = isHuman
      ? ''
      : `<button type="button" class="legend-remove" title="Remove agent" aria-label="Remove ${a.name}">×</button>`;
    // Dot color is applied inline — the dynamic stylesheet approach collided
    // with Tauri 2's nonce-CSP even with style-src 'unsafe-inline'.
    legItem.innerHTML =
      `<div class="legend-dot" style="background:${a.color}"></div>` +
      `<span class="legend-label">${a.name}</span>` +
      `<span class="presence-dot" title="offline"></span>` +
      `<span class="legend-state">off</span>` +
      removeBtn;
    legendEl.appendChild(legItem);
  }

  if (!ROSTER.length) {
    const empty = document.createElement('div');
    empty.className = 'legend-item offline';
    empty.style.fontStyle = 'italic';
    empty.innerHTML = '<span class="legend-label">waiting for agents…</span>';
    legendEl.appendChild(empty);
  }
}

function renderTargetDropdown() {
  const prev = targetEl.value || 'auto';
  targetEl.innerHTML = '';
  const optAuto = document.createElement('option');
  optAuto.value = 'auto';
  optAuto.textContent = '@ mentions';
  targetEl.appendChild(optAuto);
  for (const a of ROSTER) {
    const opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = `→ ${cap(a.name)}`;
    targetEl.appendChild(opt);
  }
  if (ROSTER.length > 1) {
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = '→ All';
    targetEl.appendChild(optAll);
  }
  // Interrupt composer mode — special option that routes the text through
  // POST /interrupts instead of /send. See the send() function for dispatch.
  const sep = document.createElement('option');
  sep.disabled = true;
  sep.textContent = '──────────';
  targetEl.appendChild(sep);
  for (const a of ROSTER) {
    if (a.name === HUMAN_NAME) continue;
    const opt = document.createElement('option');
    opt.value = `!${a.name}`;
    opt.textContent = `⚠ Interrupt ${cap(a.name)}`;
    targetEl.appendChild(opt);
  }
  const match = [...targetEl.options].some((o) => o.value === prev);
  targetEl.value = match ? prev : 'auto';
  renderTargetMenu();
}

function renderTargetMenu() {
  if (!targetMenu) return;
  targetMenu.innerHTML = '';

  const build = (value, label, extraClass = '') => {
    const el = document.createElement('div');
    el.className = 'target-option' + (extraClass ? ' ' + extraClass : '');
    if (value === targetEl.value) el.classList.add('selected');
    el.dataset.value = value;
    el.role = 'option';
    el.textContent = label;
    el.addEventListener('click', () => {
      targetEl.value = value;
      renderTargetMenu();
      updateTargetDisplayLabel();
      closeTargetMenu();
    });
    return el;
  };

  targetMenu.appendChild(build('auto', '@ mentions'));
  for (const a of ROSTER) {
    targetMenu.appendChild(build(a.name, `→ ${cap(a.name)}`));
  }
  if (ROSTER.length > 1) {
    targetMenu.appendChild(build('all', '→ All'));
  }

  const interruptAgents = ROSTER.filter((a) => a.name !== HUMAN_NAME);
  if (interruptAgents.length) {
    const divider = document.createElement('div');
    divider.className = 'target-menu-divider';
    targetMenu.appendChild(divider);
    for (const a of interruptAgents) {
      targetMenu.appendChild(build(`!${a.name}`, `⚠ Interrupt ${cap(a.name)}`, 'interrupt'));
    }
  }

  updateTargetDisplayLabel();
}

function updateTargetDisplayLabel() {
  if (!targetDisplayText) return;
  const v = targetEl.value || 'auto';
  const opt = [...targetEl.options].find((o) => o.value === v);
  targetDisplayText.textContent = opt ? opt.textContent : '@ mentions';
}

function openTargetMenu() {
  if (!targetMenu || !targetDisplay) return;
  targetMenu.classList.add('open');
  targetDisplay.setAttribute('aria-expanded', 'true');
}
function closeTargetMenu() {
  if (!targetMenu || !targetDisplay) return;
  targetMenu.classList.remove('open');
  targetDisplay.setAttribute('aria-expanded', 'false');
}

if (targetDisplay) {
  targetDisplay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (targetMenu.classList.contains('open')) closeTargetMenu();
    else openTargetMenu();
  });
  document.addEventListener('click', (e) => {
    if (!targetMenu?.classList.contains('open')) return;
    if (targetMenu.contains(e.target) || targetDisplay.contains(e.target)) return;
    closeTargetMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && targetMenu?.classList.contains('open')) closeTargetMenu();
  });
}

async function loadRoster() {
  try {
    const r = await authedFetch('/agents');
    applyRoster(await r.json());
  } catch {
    applyRoster([]);
  }
}

// Pull the current pending-handoff set from the ledger and render cards.
// /agent-stream replays handoffs to the agent's MCP channel on reconnect,
// but /stream does not — so without this call, the UI loses every card on
// page refresh (and on settings reload, which clears the DOM).
async function loadPendingHandoffs() {
  try {
    const r = await authedFetch('/handoffs?status=pending&limit=500');
    if (!r.ok) return;
    const snapshots = await r.json();
    if (!Array.isArray(snapshots)) return;
    for (const snapshot of snapshots) {
      if (!snapshot || !snapshot.id) continue;
      renderHandoffCard({
        handoff_id: snapshot.id,
        version: snapshot.version,
        snapshot,
        replay: true,
      });
    }
  } catch (e) {
    console.warn('[handoffs] initial load failed:', e);
  }
}

async function loadPendingInterrupts() {
  try {
    const r = await authedFetch('/interrupts?status=pending&limit=500');
    if (!r.ok) return;
    const snapshots = await r.json();
    if (!Array.isArray(snapshots)) return;
    for (const snapshot of snapshots) {
      if (!snapshot || !snapshot.id) continue;
      renderInterruptCard({
        interrupt_id: snapshot.id,
        version: snapshot.version,
        snapshot,
        replay: true,
      });
    }
  } catch (e) {
    console.warn('[interrupts] initial load failed:', e);
  }
}

async function loadNutshell() {
  try {
    const r = await authedFetch('/nutshell');
    if (!r.ok) return;
    const snapshot = await r.json();
    applyNutshell(snapshot);
  } catch (e) {
    console.warn('[nutshell] initial load failed:', e);
  }
}

// Append ?token= to URLs that the browser can't authenticate via header
// (EventSource, <img src>). Idempotent: skips if token is empty or already present.
function withToken(path) {
  if (!AUTH_TOKEN) return path;
  if (/[?&]token=/.test(path)) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(AUTH_TOKEN)}`;
}

function addMessage(data) {
  const from = data.from || 'system';
  if (lastFrom && lastFrom !== from) {
    const sep = document.createElement('div');
    sep.className = 'sep';
    messagesEl.appendChild(sep);
  }
  lastFrom = from;

  const div = document.createElement('div');
  const cls = from === 'you' || from === 'system' ? `from-${from}` : `from-${cssName(from)}`;
  div.className = `msg ${cls}`;

  // Avatar — circle with the sender's initial. Color: agent's hash-derived
  // palette entry, or a fixed accent for you/system.
  const displayName = NAMES[from] || from;
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = (displayName[0] || '?').toUpperCase();
  if (from === 'you') avatar.style.background = 'var(--orange)';
  else if (from === 'system') avatar.style.background = 'var(--red)';
  else if (COLORS[from]) avatar.style.background = COLORS[from];
  div.appendChild(avatar);

  // Content column — header (name/ts/to) stacked above the bubble.
  const content = document.createElement('div');
  content.className = 'msg-content';

  const header = document.createElement('div');
  header.className = 'msg-header';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'msg-name';
  nameSpan.textContent = displayName;
  // Per-agent colour applied inline (dynamic <style> blocked by CSP nonce).
  // from-you / from-system get their colours from the static inline-<style>
  // block in <head>, which CSP accepts as part of the initial document.
  if (from !== 'you' && from !== 'system' && COLORS[from]) {
    nameSpan.style.color = COLORS[from];
  }
  header.appendChild(nameSpan);
  const tsSpan = document.createElement('span');
  tsSpan.className = 'msg-ts';
  tsSpan.textContent = data.ts || '';
  header.appendChild(tsSpan);
  // Only show the "→ to" suffix when the message is directed at a single
  // non-broadcast target. Avoids visual noise on every broadcast line.
  if (data.to && data.to !== 'all' && data.to !== from) {
    const toSpan = document.createElement('span');
    toSpan.className = 'msg-to';
    toSpan.textContent = '→ ' + (NAMES[data.to] || data.to);
    header.appendChild(toSpan);
  }
  content.appendChild(header);

  // Body bubble — innerHTML is fine here because every user-controlled
  // string goes through escHtml before linkify/highlightMentions augment it.
  const safeAttachment = data.image && isSafeAttachmentSrc(data.image) ? data.image : null;
  const attachmentHtml = safeAttachment ? renderAttachmentHtml(safeAttachment) : '';
  const body = document.createElement('div');
  body.className = 'msg-body';
  // Body color is uniform (var(--ctp-rosewater)) for readability. Per-agent
  // color is used only on the name pill — the name already identifies the
  // sender, tinting the body just hurt contrast on the dark background.
  body.innerHTML = highlightMentions(linkify(escHtml(data.text || ''))) + attachmentHtml;
  content.appendChild(body);

  div.appendChild(content);
  messagesEl.appendChild(div);
  // Bound DOM growth on long sessions.
  while (messagesEl.childElementCount > MESSAGE_DOM_LIMIT) {
    messagesEl.removeChild(messagesEl.firstChild);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function isSafeAttachmentSrc(u) {
  if (typeof u !== 'string' || !u) return false;
  return ATTACHMENT_URL_RE.test(u) || /^https?:\/\//.test(u);
}

function renderAttachmentHtml(url) {
  const safeUrl = escAttr(imgUrl(url));
  if (IMAGE_EXT_RE.test(url)) {
    return `<img src="${safeUrl}" alt="attachment" data-zoomable="1" />`;
  }
  // Generic non-image attachment: show filename + extension as a clickable
  // chip that opens in a new tab. Browsers will render PDFs natively and
  // download anything else.
  const filename = url.split('/').pop() || 'attachment';
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toUpperCase() : 'FILE';
  return `<a class="attachment-link" href="${safeUrl}" target="_blank" rel="noopener" download>` +
         `<span class="attachment-link-ext">${escHtml(ext)}</span>` +
         `<span class="attachment-link-name">${escHtml(filename)}</span>` +
         `</a>`;
}

function imgUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//.test(u)) return u;
  // Local /image/<id>.<ext> served by the hub — needs ?token= auth
  // (the <img> tag cannot send the Authorization header).
  return `${BUS}${withToken(u)}`;
}

// Delegated click-to-zoom for image attachments; re-validates URL before
// opening to avoid anything weird that bypassed escaping.
messagesEl.addEventListener('click', (e) => {
  const img = e.target.closest?.('.msg-body img[data-zoomable]');
  if (!img) return;
  const src = img.getAttribute('src') || '';
  if (!/^https?:\/\//.test(src) && !src.startsWith(BUS + '/image/')) return;
  window.open(src, '_blank', 'noopener');
});

// Top-center "Link copied" toast. Single DOM element shared across all copy
// buttons; debounced so rapid clicks extend the visible window instead of
// stacking multiple toasts.
const copyToastEl = document.getElementById('copy-toast');
let _copyToastTimer = 0;
function showCopyToast(msg) {
  if (!copyToastEl) return;
  if (msg) copyToastEl.textContent = msg;
  copyToastEl.classList.add('visible');
  clearTimeout(_copyToastTimer);
  _copyToastTimer = setTimeout(() => copyToastEl.classList.remove('visible'), 1400);
}

// Delegated one-click copy for links inside message bodies. Reads the
// decoded href from dataset so the clipboard gets the unescaped URL.
messagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.msg-link-copy');
  if (!btn) return;
  e.preventDefault();
  const href = btn.dataset.href;
  if (!href) return;
  const flashCopied = () => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1000);
    showCopyToast('Link copied');
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(href).then(flashCopied).catch(() => {
      // Fallback via hidden textarea for older WebViews.
      const ta = document.createElement('textarea');
      ta.value = href;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
      flashCopied();
    });
  } else {
    const ta = document.createElement('textarea');
    ta.value = href;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    flashCopied();
  }
});

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                  .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function linkify(s) {
  // Input is already escaped by escHtml. Use a replacer function so $-sequences
  // in the URL ($&, $1, $', etc.) aren't treated as substitution patterns.
  return s.replace(/(https?:\/\/[^\s<]+)/g, (_, url) =>
    `<a class="msg-link" href="${url}" target="_blank" rel="noopener">${url}</a>` +
    `<button type="button" class="msg-link-copy" data-href="${url}" aria-label="Copy link" title="Copy link"></button>`);
}

// Agent names allow '.' '-' '_' (plus alnum + spaces). '.' and '-' are
// regex metacharacters — without escaping, an agent named "a.b" would
// match "@axb" and silently intercept unrelated mentions.
function escRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

function highlightMentions(html) {
  const names = ROSTER.map(a => a.name);
  if (!names.length) return html;
  const pattern = new RegExp(`@(${names.map(escRegex).join('|')})\\b`, 'g');
  return html.replace(pattern, '<span class="mention">@$1</span>');
}

function parseMentions(text) {
  const names = ROSTER.map(a => a.name);
  const found = new Set();
  const re = new RegExp(`@(${names.map(escRegex).join('|')})\\b`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  return [...found];
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyPresence(agents) {
  presenceState = { ...agents };
  for (const a of ROSTER) {
    const item = legendEl.querySelector(`[data-agent="${a.name}"]`);
    if (!item) continue;
    const online = !!agents[a.name];
    item.classList.toggle('online', online);
    item.classList.toggle('offline', !online);
    const state = item.querySelector('.legend-state');
    if (state) state.textContent = online ? 'on' : 'off';
    const pd = item.querySelector('.presence-dot');
    if (pd) pd.title = online ? 'connected' : 'offline';
  }
  const names = ROSTER.map(a => a.name);
  const onCount = names.filter(n => agents[n]).length;
  let hubLabel = '';
  try {
    const p = new URL(BUS).port;
    if (p) hubLabel = ` · hub :${p}`;
  } catch { /* BUS may be empty pre-bootstrap */ }
  statusText.textContent = `${onCount}/${names.length} agents${hubLabel}`;
  if (mentionPop.classList.contains('open')) updateMentionPopover();
}

function markAllOffline() {
  const empty = {};
  for (const a of ROSTER) empty[a.name] = false;
  applyPresence(empty);
}

// Persist last-seen id across app restarts so chat history is not duplicated.
// Tied to a hub session id so a hub restart (which resets the id sequence) doesn't suppress new messages.
let serverSession = localStorage.getItem('a2achannel_session') || '';
let lastSeenId = parseInt(localStorage.getItem('a2achannel_last_event_id') || '0', 10) || 0;

function handleEvent(data) {
  if (!data) return;
  if (data.type === 'session') {
    if (data.id !== serverSession) {
      serverSession = data.id;
      lastSeenId = 0;
      localStorage.setItem('a2achannel_session', serverSession);
      localStorage.setItem('a2achannel_last_event_id', '0');
    }
    return;
  }
  if (data.type === 'roster')   { applyRoster(data.agents || []); return; }
  if (data.type === 'presence') { applyPresence(data.agents || {}); return; }
  if (data.type === 'nutshell.updated') { applyNutshell(data.snapshot || null); return; }
  // Dedup chat entries by their server-assigned id.
  if (typeof data.id === 'number') {
    if (data.id <= lastSeenId) return;
    lastSeenId = data.id;
    localStorage.setItem('a2achannel_last_event_id', String(lastSeenId));
  }
  // Structured handoff events render as cards, not chat rows.
  if (typeof data.kind === 'string' && data.kind.startsWith('handoff.')) {
    renderHandoffCard(data);
    return;
  }
  // Structured interrupt events — high-visibility cards sticky to the top of
  // the message area while pending.
  if (typeof data.kind === 'string' && data.kind.startsWith('interrupt.')) {
    renderInterruptCard(data);
    return;
  }
  addMessage(data);
}

let activeES = null;
function connect() {
  if (activeES) { try { activeES.close(); } catch {} activeES = null; }
  let qs = `?last_event_id=${lastSeenId}&session=${encodeURIComponent(serverSession)}`;
  if (AUTH_TOKEN) qs += `&token=${encodeURIComponent(AUTH_TOKEN)}`;
  const es = new EventSource(`${BUS}/stream${qs}`);
  activeES = es;
  es.onopen = () => { dot.className = 'dot live'; statusText.textContent = 'live'; };
  es.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); }
    catch (err) { console.warn('[sse] parse failed:', err, e.data); }
  };
  es.onerror = () => {
    dot.className = 'dot error';
    statusText.textContent = 'disconnected — retrying…';
    markAllOffline();
    es.close();
    activeES = null;
    setTimeout(connect, 3000);
  };
}

async function send() {
  const text = input.value.trim();
  const image = pendingImageUrl;
  if (!text && !image) return;

  const mode = targetEl.value || 'auto';

  // Interrupt composer mode — target values like "!bob" route through
  // POST /interrupts instead of /send. No attachment support on interrupts;
  // surface a warning if the user had one queued.
  if (mode.startsWith('!')) {
    const toAgent = mode.slice(1);
    if (!text) {
      addMessage({ from: 'system', to: HUMAN_NAME, text: 'Interrupt text required.', ts: '' });
      return;
    }
    if (text.length > 500) {
      addMessage({ from: 'system', to: HUMAN_NAME, text: 'Interrupt text must be 500 chars or fewer.', ts: '' });
      return;
    }
    if (image) {
      addMessage({ from: 'system', to: HUMAN_NAME, text: 'Attachments not supported on interrupts (dropped).', ts: '' });
    }
    sendBtn.disabled = true;
    input.value = '';
    autoGrow();
    clearAttachment();
    hideMentionPopover();
    try {
      const r = await authedFetch('/interrupts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: HUMAN_NAME, to: toAgent, text }),
      });
      if (!r.ok) {
        const err = await parseErrorBody(r);
        addMessage({ from: 'system', to: HUMAN_NAME, text: `Interrupt failed: ${err}`, ts: '' });
      }
    } catch (e) {
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Interrupt error: ${e?.message ?? e}`, ts: '' });
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
    return;
  }

  const mentions = parseMentions(text);
  let body = { text, image };
  if (mode === 'auto') {
    if (mentions.length) body.targets = mentions;
    else body.target = 'all';
  } else {
    body.target = mode;
  }

  sendBtn.disabled = true;
  input.value = '';
  autoGrow();
  clearAttachment();
  hideMentionPopover();
  try {
    const r = await authedFetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      const msg = r.status === 401
        ? `Send failed: auth out of sync — did A2AChannel restart? (${err})`
        : `Send failed: ${err}`;
      addMessage({ from: 'system', to: 'you', text: msg, ts: '' });
    }
  } catch (e) {
    addMessage({ from: 'system', to: 'you', text: `Could not reach bus: ${e?.message ?? e}`, ts: '' });
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

input.addEventListener('keydown', (e) => {
  const popOpen = mentionPop.classList.contains('open');
  if (popOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionActive = (mentionActive + 1) % mentionMatches.length; renderMentionPopover(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); mentionActive = (mentionActive - 1 + mentionMatches.length) % mentionMatches.length; renderMentionPopover(); return; }
    if (e.key === 'Escape')    { e.preventDefault(); hideMentionPopover(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (mentionMatches.length) { e.preventDefault(); selectMention(mentionMatches[mentionActive]); return; }
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    send();
  }
});

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}
input.addEventListener('input', () => { autoGrow(); updateMentionPopover(); });
input.addEventListener('click', updateMentionPopover);
input.addEventListener('blur', () => setTimeout(hideMentionPopover, 150));

/* ── @mention autocomplete ──────────────────────────────────── */
function currentMentionContext() {
  const pos = input.selectionStart ?? 0;
  const before = input.value.slice(0, pos);
  const m = before.match(/@([\w-]*)$/);
  if (!m) return null;
  return { query: m[1].toLowerCase(), start: pos - m[0].length, end: pos };
}

function updateMentionPopover() {
  const ctx = currentMentionContext();
  if (!ctx) { hideMentionPopover(); return; }
  const names = ROSTER.map(a => a.name);
  mentionMatches = names.filter(n => n.toLowerCase().startsWith(ctx.query));
  if (ROSTER.length > 1 && 'all'.startsWith(ctx.query)) mentionMatches.push('all');
  if (!mentionMatches.length) { hideMentionPopover(); return; }
  if (mentionActive >= mentionMatches.length) mentionActive = 0;
  renderMentionPopover();
  mentionPop.classList.add('open');
}

function renderMentionPopover() {
  mentionPop.innerHTML = '';
  mentionMatches.forEach((name, i) => {
    const online = name === 'all' ? null : !!presenceState[name];
    const item = document.createElement('div');
    item.className = 'mention-item' + (i === mentionActive ? ' active' : '') +
                     (online === false ? ' offline' : '');
    const color = name === 'all' ? 'var(--text-muted)' : (COLORS[name] || 'var(--text-muted)');
    const meta = name === 'all' ? 'broadcast' : (online ? 'online' : 'offline');
    item.innerHTML = `<span class="dot" style="background:${color}"></span>` +
                     `<span>${name}</span>` +
                     `<span class="meta">${meta}</span>`;
    item.addEventListener('mousedown', (e) => { e.preventDefault(); selectMention(name); });
    mentionPop.appendChild(item);
  });
}

function selectMention(name) {
  const ctx = currentMentionContext();
  if (!ctx) { hideMentionPopover(); return; }
  const before = input.value.slice(0, ctx.start);
  const after = input.value.slice(ctx.end);
  const insert = `@${name} `;
  input.value = before + insert + after;
  const newPos = ctx.start + insert.length;
  input.selectionStart = input.selectionEnd = newPos;
  hideMentionPopover();
  input.focus();
  autoGrow();
}

function hideMentionPopover() {
  mentionPop.classList.remove('open');
  mentionMatches = [];
  mentionActive = 0;
}

/* ── Emoji picker ───────────────────────────────────────────── */
function buildEmojiPicker() {
  emojiPop.innerHTML = '';
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.addEventListener('click', () => { insertAtCursor(input, e); emojiPop.classList.remove('open'); input.focus(); });
    emojiPop.appendChild(b);
  }
}
buildEmojiPicker();

function insertAtCursor(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + text.length;
}

emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPop.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!emojiPop.contains(e.target) && e.target !== emojiBtn) emojiPop.classList.remove('open');
});

/* ── Attachment upload ──────────────────────────────────────── */
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) uploadAttachment(f);
  fileInput.value = '';
});

async function uploadAttachment(file) {
  // Server validates the extension against the configured allowlist.
  // No client-side MIME gate — browsers report wildly inconsistent types.
  renderAttachment(null, file.name, true);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await authedFetch('/upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await parseErrorBody(r));
    const { url } = await r.json();
    pendingImageUrl = url;
    renderAttachment(url, file.name, false);
  } catch (e) {
    clearAttachment();
    addMessage({ from: 'system', to: HUMAN_NAME, text: `Upload failed: ${e?.message ?? e}`, ts: '' });
  }
}

function renderAttachment(url, name, loading) {
  attachRow.innerHTML = '';
  const chip = document.createElement('div');
  chip.className = 'attachment-chip';
  // Inline thumbnail only if the file is an image extension; otherwise
  // show the extension badge so users can tell at a glance what they
  // attached.
  if (url) {
    if (IMAGE_EXT_RE.test(url)) {
      const img = document.createElement('img');
      img.src = imgUrl(url);
      chip.appendChild(img);
    } else {
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot + 1).toUpperCase() : 'FILE';
      const badge = document.createElement('span');
      badge.className = 'attachment-link-ext';
      badge.textContent = ext;
      chip.appendChild(badge);
    }
  }
  const label = document.createElement('span');
  label.textContent = loading ? `uploading ${name}…` : name;
  chip.appendChild(label);
  if (!loading) {
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', clearAttachment);
    chip.appendChild(x);
  }
  attachRow.appendChild(chip);
}

function clearAttachment() {
  pendingImageUrl = null;
  attachRow.innerHTML = '';
}

/* ── Paste from clipboard (any file) ────────────────────────── */
input.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); uploadAttachment(f); return; }
    }
  }
});

/* ── Drag-and-drop (any file) ───────────────────────────────── */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  dropOverlay.classList.add('visible');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.classList.remove('visible');
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('visible');
  const f = e.dataTransfer?.files?.[0];
  if (f) uploadAttachment(f);
});

/* ── Handoff card rendering ──────────────────────────────── */
function renderHandoffCard(event) {
  // Extract the snapshot: hub embeds it directly on the SSE entry.
  const snapshot = event.snapshot || (() => {
    try { return JSON.parse(event.text || '{}'); } catch { return null; }
  })();
  if (!snapshot || !event.handoff_id) return;

  // Version reconciliation: ignore stale broadcasts. Log every transition
  // so we can diagnose "card stuck at pending" bug reports without devtools.
  const existing = handoffCards.get(event.handoff_id);
  const incomingVersion = Number(event.version ?? snapshot.version ?? 0);
  console.debug('[handoff]', event.kind, event.handoff_id,
    'v=', incomingVersion, 'status=', snapshot.status,
    existing ? `(existing v${existing.version} ${existing.status})` : '(new)');
  if (existing && existing.version >= incomingVersion) {
    console.debug('[handoff] dropping stale version', incomingVersion, '<=', existing.version);
    return;
  }

  if (existing) {
    updateHandoffCardDom(existing.element, snapshot, event);
    existing.version = incomingVersion;
    existing.status = snapshot.status;
    existing.snapshot = snapshot;
  } else {
    const el = buildHandoffCardDom(snapshot, event);
    messagesEl.appendChild(el);
    handoffCards.set(event.handoff_id, {
      element: el,
      version: incomingVersion,
      status: snapshot.status,
      snapshot,
    });
    // Trim DOM to bound.
    while (messagesEl.childElementCount > MESSAGE_DOM_LIMIT) {
      const first = messagesEl.firstChild;
      if (first && first._handoffId) handoffCards.delete(first._handoffId);
      messagesEl.removeChild(first);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function buildHandoffCardDom(snapshot, event) {
  const el = document.createElement('div');
  el.className = 'handoff-card';
  el._handoffId = snapshot.id;
  updateHandoffCardDom(el, snapshot, event);
  return el;
}

function updateHandoffCardDom(el, snapshot, event) {
  // Reset status classes.
  el.className = 'handoff-card';
  el.classList.add(`status-${snapshot.status}`);

  const replayBadge = event.replay === true || event.replay === 'true'
    ? `<span class="handoff-replay-badge">(replay)</span>`
    : '';

  const contextHtml = snapshot.context
    ? `<div class="handoff-context">
         <details>
           <summary>context</summary>
           <pre>${escHtml(JSON.stringify(snapshot.context, null, 2))}</pre>
         </details>
       </div>`
    : '';

  const reasonHtml = snapshot.status === 'declined' && snapshot.decline_reason
    ? `<div class="handoff-reason">declined: ${escHtml(snapshot.decline_reason)}</div>`
    : snapshot.status === 'cancelled' && snapshot.cancel_reason
      ? `<div class="handoff-reason">cancelled${snapshot.cancelled_by ? ` by ${escHtml(snapshot.cancelled_by)}` : ''}: ${escHtml(snapshot.cancel_reason)}</div>`
      : snapshot.status === 'cancelled' && snapshot.cancelled_by
        ? `<div class="handoff-reason">cancelled by ${escHtml(snapshot.cancelled_by)}</div>`
        : snapshot.status === 'accepted' && snapshot.comment
          ? `<div class="handoff-reason">accepted: ${escHtml(snapshot.comment)}</div>`
          : '';

  const showActions = snapshot.status === 'pending';
  let actionsHtml = '';
  if (showActions) {
    const buttons = [];
    if (snapshot.to_agent === HUMAN_NAME) {
      buttons.push(`<button type="button" class="accept" data-action="accept">Accept</button>`);
      buttons.push(`<button type="button" class="decline" data-action="decline">Decline</button>`);
    }
    if (snapshot.from_agent === HUMAN_NAME) {
      buttons.push(`<button type="button" class="cancel" data-action="cancel">Cancel</button>`);
    }
    if (buttons.length) {
      actionsHtml = `<div class="handoff-actions">${buttons.join('')}</div>`;
    }
  }

  el.innerHTML = `
    <div class="handoff-header">
      <span class="route">${escHtml(snapshot.from_agent)} → ${escHtml(snapshot.to_agent)}</span>
      <span class="status-badge">${escHtml(snapshot.status)}</span>
      ${replayBadge}
    </div>
    <span class="handoff-countdown" data-expires="${snapshot.expires_at_ms}"></span>
    <div class="handoff-task">${escHtml(snapshot.task)}</div>
    <div class="handoff-meta">handoff ${escHtml(snapshot.id)}</div>
    ${contextHtml}
    ${reasonHtml}
    ${actionsHtml}
  `;

  // Action handlers.
  el.querySelectorAll('.handoff-actions button').forEach((btn) => {
    btn.addEventListener('click', () => handleHandoffAction(snapshot.id, btn.dataset.action));
  });

  updateCountdownLabel(el);
}

async function handleHandoffAction(id, action) {
  let body;
  if (action === 'accept') {
    body = { by: HUMAN_NAME };
  } else if (action === 'decline') {
    // Tauri's WebView silently returns null from window.prompt for security
    // reasons — we need a custom dialog. askReason() below opens a minimal
    // inline modal and resolves to the typed reason (or null on cancel).
    const reason = await askReason('Decline handoff', 'Why are you declining?', { required: true });
    if (!reason) return;
    body = { by: HUMAN_NAME, reason };
  } else if (action === 'cancel') {
    const reason = await askReason('Cancel handoff', 'Optional reason:', { required: false });
    if (reason === null) return; // user clicked Cancel in the dialog
    body = { by: HUMAN_NAME };
    if (reason) body.reason = reason;
  } else {
    return;
  }
  try {
    const r = await authedFetch(`/handoffs/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Handoff ${action} failed: ${err}`, ts: '' });
    }
    // On success the hub broadcasts handoff.update which re-renders the card.
  } catch (e) {
    addMessage({ from: 'system', to: HUMAN_NAME, text: `Handoff ${action} error: ${e?.message ?? e}`, ts: '' });
  }
}

/* ── Interrupt cards ─────────────────────────────────────── */
const interruptCards = new Map(); // interrupt_id → { element, version, status, snapshot }

function renderInterruptCard(event) {
  const snapshot = event.snapshot || (() => {
    try { return JSON.parse(event.text || '{}'); } catch { return null; }
  })();
  if (!snapshot || !event.interrupt_id) return;

  const existing = interruptCards.get(event.interrupt_id);
  const incomingVersion = Number(event.version ?? snapshot.version ?? 0);
  if (existing && existing.version >= incomingVersion) return;

  if (existing) {
    updateInterruptCardDom(existing.element, snapshot, event);
    existing.version = incomingVersion;
    existing.status = snapshot.status;
    existing.snapshot = snapshot;
  } else {
    const el = buildInterruptCardDom(snapshot, event);
    // Sticky: pending interrupts go to the TOP of the message area so they can't
    // be missed; acknowledged ones render in line with chat history.
    if (snapshot.status === 'pending') {
      messagesEl.insertBefore(el, messagesEl.firstChild);
    } else {
      messagesEl.appendChild(el);
    }
    interruptCards.set(event.interrupt_id, {
      element: el, version: incomingVersion, status: snapshot.status, snapshot,
    });
    while (messagesEl.childElementCount > MESSAGE_DOM_LIMIT) {
      const first = messagesEl.firstChild;
      if (first && first._interruptId) interruptCards.delete(first._interruptId);
      if (first && first._handoffId) handoffCards.delete(first._handoffId);
      messagesEl.removeChild(first);
    }
    if (snapshot.status !== 'pending') messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function buildInterruptCardDom(snapshot, event) {
  const el = document.createElement('div');
  el.className = 'interrupt-card';
  el._interruptId = snapshot.id;
  updateInterruptCardDom(el, snapshot, event);
  return el;
}

function updateInterruptCardDom(el, snapshot, event) {
  el.className = 'interrupt-card';
  el.classList.add(`status-${snapshot.status}`);
  const replayBadge = event.replay === true || event.replay === 'true'
    ? `<span class="interrupt-replay-badge">(replay)</span>` : '';
  const actionsHtml = snapshot.status === 'pending' && snapshot.to_agent === HUMAN_NAME
    ? `<div class="interrupt-actions">
         <button type="button" data-action="ack">Acknowledge</button>
       </div>`
    : '';
  el.innerHTML = `
    <div class="interrupt-header">
      <span class="route">⚠ Interrupt — ${escHtml(snapshot.from_agent)} → ${escHtml(snapshot.to_agent)}</span>
      <span class="status-badge">${escHtml(snapshot.status)}</span>
      ${replayBadge}
    </div>
    <div class="interrupt-text">${escHtml(snapshot.text)}</div>
    <div class="interrupt-meta">${escHtml(snapshot.id)}${snapshot.acknowledged_by ? ` · ack by ${escHtml(snapshot.acknowledged_by)}` : ''}</div>
    ${actionsHtml}
  `;
  el.querySelectorAll('.interrupt-actions button').forEach((btn) => {
    btn.addEventListener('click', () => handleInterruptAction(snapshot.id));
  });
}

async function handleInterruptAction(id) {
  try {
    const r = await authedFetch(`/interrupts/${encodeURIComponent(id)}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: HUMAN_NAME }),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Interrupt ack failed: ${err}`, ts: '' });
    }
  } catch (e) {
    addMessage({ from: 'system', to: HUMAN_NAME, text: `Interrupt ack error: ${e?.message ?? e}`, ts: '' });
  }
}

/* ── Nutshell state + editor ─────────────────────────────── */
const nutshellEl        = document.getElementById('nutshell');
const nutshellBodyEl    = document.getElementById('nutshell-body');
const nutshellMetaEl    = document.getElementById('nutshell-meta');
const nutshellEditBtn   = document.getElementById('nutshell-edit-btn');
const nutshellEditor    = document.getElementById('nutshell-editor');
const nutshellTextarea  = document.getElementById('nutshell-editor-textarea');
const nutshellSubmit    = document.getElementById('nutshell-editor-submit');
const nutshellCancel    = document.getElementById('nutshell-editor-cancel');
let nutshellCurrent = { text: '', version: 0, updated_at_ms: 0, updated_by: null };

function applyNutshell(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  nutshellCurrent = {
    text: snapshot.text ?? '',
    version: snapshot.version ?? 0,
    updated_at_ms: snapshot.updated_at_ms ?? 0,
    updated_by: snapshot.updated_by ?? null,
  };
  renderNutshell();
  // Brief highlight so the human notices the change.
  nutshellEl.classList.add('flash');
  setTimeout(() => nutshellEl.classList.remove('flash'), 1400);
}

function renderNutshell() {
  nutshellEl.style.display = 'flex';
  const txt = nutshellCurrent.text.trim();
  if (!txt) {
    nutshellBodyEl.textContent = 'No project summary yet — agents or the human can propose one.';
    nutshellBodyEl.classList.add('empty');
  } else {
    nutshellBodyEl.textContent = txt;
    nutshellBodyEl.classList.remove('empty');
  }
  if (nutshellCurrent.version > 0) {
    const who = nutshellCurrent.updated_by || 'system';
    nutshellMetaEl.textContent = `v${nutshellCurrent.version} · by ${who}`;
  } else {
    nutshellMetaEl.textContent = '';
  }
}

function openNutshellEditor() {
  nutshellTextarea.value = nutshellCurrent.text || '';
  nutshellEditor.classList.add('open');
  nutshellTextarea.focus();
  nutshellTextarea.select();
}

function closeNutshellEditor() {
  nutshellEditor.classList.remove('open');
}

async function submitNutshellProposal() {
  const patch = nutshellTextarea.value.trim();
  if (patch === (nutshellCurrent.text || '').trim()) {
    closeNutshellEditor();
    return;
  }
  nutshellSubmit.disabled = true;
  try {
    // Send as a handoff proposal to the human. The hub's handoff-accept path
    // detects the "[nutshell]" task prefix and applies the patch atomically.
    const r = await authedFetch('/handoffs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: HUMAN_NAME,
        to: HUMAN_NAME,
        task: '[nutshell] human edit',
        context: { patch },
        ttl_seconds: 3600,
      }),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Nutshell proposal failed: ${err}`, ts: '' });
    } else {
      // The human is the sender AND recipient here — auto-accept by firing the
      // accept endpoint immediately. Agents proposing edits follow the normal
      // accept-by-human flow; the human editing their own nutshell shortcircuits.
      const body = await r.json();
      if (body?.id) {
        await authedFetch(`/handoffs/${encodeURIComponent(body.id)}/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ by: HUMAN_NAME, comment: 'human self-edit' }),
        });
      }
    }
    closeNutshellEditor();
  } catch (e) {
    addMessage({ from: 'system', to: HUMAN_NAME, text: `Nutshell proposal error: ${e?.message ?? e}`, ts: '' });
  } finally {
    nutshellSubmit.disabled = false;
  }
}

nutshellEditBtn?.addEventListener('click', openNutshellEditor);
nutshellSubmit?.addEventListener('click', submitNutshellProposal);
nutshellCancel?.addEventListener('click', closeNutshellEditor);
nutshellEditor?.addEventListener('click', (e) => {
  if (e.target === nutshellEditor) closeNutshellEditor();
});
nutshellTextarea?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeNutshellEditor(); }
  if ((e.key === 'Enter') && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submitNutshellProposal();
  }
});

/* Countdown ticker: updates "N left" labels on pending handoff cards. */
function updateCountdownLabel(cardEl) {
  const label = cardEl.querySelector('.handoff-countdown');
  if (!label) return;
  const expiresAt = Number(label.dataset.expires ?? 0);
  if (!expiresAt) { label.textContent = ''; return; }
  if (!cardEl.classList.contains('status-pending')) {
    label.textContent = '';
    return;
  }
  const now = Date.now();
  const delta = Math.max(0, expiresAt - now);
  if (delta === 0) {
    label.textContent = 'expiring…';
    return;
  }
  const totalSec = Math.round(delta / 1000);
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    label.textContent = `${m}m ${s}s left`;
  } else {
    label.textContent = `${totalSec}s left`;
  }
}

setInterval(() => {
  // Early-out: most sessions have no open handoffs, so don't iterate
  // a Map every second for nothing.
  if (handoffCards.size === 0) return;
  for (const { element } of handoffCards.values()) {
    if (element.classList.contains('status-pending')) {
      updateCountdownLabel(element);
    }
  }
}, 1000);

async function bootstrap() {
  const invoke =
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.core?.invoke ||
    window.__TAURI__?.invoke;
  if (invoke) {
    try {
      const info = await invoke('get_hub_url');
      // The Rust command now returns { url, token }. Accept the legacy
      // bare-string return too, so a hub downgrade doesn't brick the UI.
      if (info && typeof info === 'object') {
        if (typeof info.url === 'string' && info.url) BUS = info.url;
        if (typeof info.token === 'string') AUTH_TOKEN = info.token;
      } else if (typeof info === 'string' && info) {
        BUS = info;
      }
    } catch (e) {
      statusText.textContent = `hub URL lookup failed: ${e}`;
      dot.className = 'dot error';
      return;
    }
    try {
      const name = await invoke('get_human_name');
      if (typeof name === 'string' && name) {
        HUMAN_NAME = name;
        NAMES[HUMAN_NAME] = cap(HUMAN_NAME);
        // Keep legacy "you" → "You" label for free-text chat routing.
      }
    } catch {
      // older Rust shell without the command: stick with default "you".
    }
  }
  try {
    await loadRoster();
    await loadNutshell();
    await loadPendingHandoffs();
    await loadPendingInterrupts();
    connect();
  } catch (e) {
    statusText.textContent = `roster load failed: ${e}`;
    dot.className = 'dot error';
  }
}

bootstrap();

/* ── MCP config modal ───────────────────────────────────────── */
const mcpBtn = document.getElementById('reveal-btn');
const mcpModal = document.getElementById('mcp-modal');
const mcpTextarea = document.getElementById('mcp-textarea');
const mcpCopyBtn = document.getElementById('mcp-copy-btn');
const mcpCloseBtn = document.getElementById('mcp-close-btn');
const mcpCopiedStatus = document.getElementById('mcp-copied-status');

function tauriInvoke(cmd, args) {
  const invoke =
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.core?.invoke ||
    window.__TAURI__?.invoke;
  if (!invoke) return Promise.reject(new Error('Tauri IPC unavailable'));
  return args !== undefined ? invoke(cmd, args) : invoke(cmd);
}

function fallbackTemplate() {
  // Used when running in a plain browser (no Tauri). Path is the typical
  // install location; user can edit the textarea to correct it.
  return JSON.stringify({
    mcpServers: {
      chatbridge: {
        command: '/Applications/A2AChannel.app/Contents/MacOS/a2a-bin',
        args: [],
        env: {
          A2A_MODE: 'channel',
          CHATBRIDGE_AGENT: 'agent',
        },
      },
    },
  }, null, 2);
}

async function openMcpModal() {
  let text;
  try {
    text = await tauriInvoke('get_mcp_template');
  } catch {
    text = fallbackTemplate();
  }
  mcpTextarea.value = text;
  mcpModal.classList.add('open');
  mcpCopiedStatus.classList.remove('visible');
  mcpTextarea.focus();
  mcpTextarea.select();
}

function closeMcpModal() {
  mcpModal.classList.remove('open');
}

if (mcpBtn) mcpBtn.addEventListener('click', openMcpModal);

const settingsBtn = document.getElementById('settings-btn');
if (settingsBtn) {
  settingsBtn.addEventListener('click', async () => {
    try {
      await tauriInvoke('open_config_file');
    } catch (e) {
      addMessage({
        from: 'system',
        to: HUMAN_NAME,
        text: `Open settings failed: ${e?.message ?? e}`,
        ts: '',
      });
    }
  });
}

const reloadBtn = document.getElementById('reload-btn');
if (reloadBtn) {
  reloadBtn.addEventListener('click', async () => {
    reloadBtn.disabled = true;
    const prevTitle = reloadBtn.title;
    reloadBtn.title = 'Reloading…';
    statusText.textContent = 'applying settings…';
    dot.className = 'dot';
    try {
      const info = await tauriInvoke('reload_settings');
      if (info && typeof info === 'object') {
        if (typeof info.url === 'string' && info.url) BUS = info.url;
        if (typeof info.token === 'string') AUTH_TOKEN = info.token;
      }
      // Refresh the human name in case it changed.
      try {
        const name = await tauriInvoke('get_human_name');
        if (typeof name === 'string' && name) {
          HUMAN_NAME = name;
          NAMES[HUMAN_NAME] = cap(HUMAN_NAME);
        }
      } catch {}
      // Tear down the existing SSE + card state; the new hub has a fresh
      // session id and chatLog, so the old lastSeenId is stale.
      if (activeES) { try { activeES.close(); } catch {} activeES = null; }
      handoffCards.clear();
      // Drop any rendered chat + handoff cards from the DOM; they'll replay
      // (roster + presence + pending handoffs) from the fresh hub.
      messagesEl.innerHTML = '';
      lastFrom = null;
      lastSeenId = 0;
      localStorage.setItem('a2achannel_last_event_id', '0');
      // Reconnect SSE against the new URL, then re-render any handoffs,
      // interrupts, and the nutshell already in the (fresh) hub's ledger —
      // the hub keeps them across restarts; the UI just lost them when we
      // cleared #messages.
      interruptCards.clear();
      connect();
      await loadNutshell();
      await loadPendingHandoffs();
      await loadPendingInterrupts();
      addMessage({
        from: 'system',
        to: HUMAN_NAME,
        text: `Settings applied. Hub restarted; active Claude sessions will reconnect within ~2s.`,
        ts: '',
      });
    } catch (e) {
      statusText.textContent = 'reload failed';
      dot.className = 'dot error';
      addMessage({
        from: 'system',
        to: HUMAN_NAME,
        text: `Reload settings failed: ${e?.message ?? e}`,
        ts: '',
      });
    } finally {
      reloadBtn.disabled = false;
      reloadBtn.title = prevTitle;
    }
  });
}
if (mcpCloseBtn) mcpCloseBtn.addEventListener('click', closeMcpModal);
if (mcpModal) mcpModal.addEventListener('click', (e) => {
  if (e.target === mcpModal) closeMcpModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mcpModal.classList.contains('open')) closeMcpModal();
});

if (mcpCopyBtn) mcpCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(mcpTextarea.value);
    mcpCopiedStatus.classList.add('visible');
    setTimeout(() => mcpCopiedStatus.classList.remove('visible'), 1500);
  } catch (e) {
    mcpTextarea.select();
    document.execCommand?.('copy');
  }
});

/* ── + agent → terminal-pane spawn modal ─────────────────── */
// The roster's "+ agent" button uses the same spawn flow as the
// terminal pane's tab-strip "+". terminal.js listens for this event.
const addAgentBtn = document.getElementById('add-agent-btn');
if (addAgentBtn) {
  addAgentBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('a2a:open-spawn'));
  });
}
