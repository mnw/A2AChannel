// main.js — bootstrap, SSE wiring, settings/reload buttons.

async function loadRoster() {
  try {
    const r = await authedFetch('/agents');
    applyRoster(await r.json());
  } catch {
    applyRoster([]);
  }
}

// /stream doesn't replay handoffs like /agent-stream does; load pending ones explicitly.
async function loadPending(path, toEvent, renderFn) {
  try {
    const r = await authedFetch(`${path}?status=pending&limit=500`);
    if (!r.ok) return;
    const snapshots = await r.json();
    if (!Array.isArray(snapshots)) return;
    for (const snapshot of snapshots) {
      if (!snapshot || !snapshot.id) continue;
      renderFn(toEvent(snapshot));
    }
  } catch (e) {
    console.warn(`[${path}] initial load failed:`, e);
  }
}

const loadPendingHandoffs    = () => loadPending('/handoffs', (s) => ({ handoff_id: s.id, version: s.version, snapshot: s, replay: true }), renderHandoffCard);
const loadPendingInterrupts  = () => loadPending('/interrupts', (s) => ({ interrupt_id: s.id, version: s.version, snapshot: s, replay: true }), renderInterruptCard);
const loadPendingPermissions = () => loadPending('/permissions', (s) => ({ permission_id: s.id, kind: 'permission.new', version: s.version, snapshot: s, replay: true }), renderPermissionCard);

async function loadNutshell(room) {
  if (!room || room === ROOM_ALL) return;
  try {
    const r = await authedFetch(`/nutshell?room=${encodeURIComponent(room)}`);
    if (!r.ok) return;
    const snapshot = await r.json();
    applyNutshell(snapshot);
  } catch (e) {
    console.warn('[nutshell] load failed:', e);
  }
}

// (session, lastSeenId) persists across restarts; hub restart mints new session → reset lastSeenId.
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
  if (typeof data.id === 'number') {
    if (data.id <= lastSeenId) return;
    lastSeenId = data.id;
    localStorage.setItem('a2achannel_last_event_id', String(lastSeenId));
  }
  if (typeof data.kind === 'string' && data.kind.startsWith('handoff.')) {
    renderHandoffCard(data);
    return;
  }
  if (typeof data.kind === 'string' && data.kind.startsWith('interrupt.')) {
    renderInterruptCard(data);
    return;
  }
  if (typeof data.kind === 'string' && data.kind.startsWith('permission.')) {
    renderPermissionCard(data);
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

// Tauri 2's auto data-tauri-drag-region isn't reliable; manual startDragging() is the documented path.
(function attachTitleBarDrag() {
  const strip = document.querySelector('.titlebar');
  if (!strip) return;
  strip.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, a, [contenteditable]')) return;
    try {
      const w =
        window.__TAURI__?.window?.getCurrentWindow?.() ||
        window.__TAURI__?.window?.getCurrent?.() ||
        window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
      await w?.startDragging?.();
    } catch (err) {
      console.warn('[titlebar] startDragging failed', err);
    }
  });
})();

async function bootstrap() {
  const invoke =
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.core?.invoke ||
    window.__TAURI__?.invoke;
  if (invoke) {
    try {
      const info = await invoke('get_hub_url');
      // {url, token} or legacy bare-string.
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
      }
    } catch {}
  }
  try {
    await loadRoster();
    // Per-room nutshell: fetch selected room or pre-cache all known rooms for instant switching.
    if (SELECTED_ROOM !== ROOM_ALL) {
      await loadNutshell(SELECTED_ROOM);
    } else {
      for (const r of distinctRooms()) {
        loadNutshell(r);
      }
    }
    await loadPendingHandoffs();
    await loadPendingInterrupts();
    await loadPendingPermissions();
    connect();
    renderNutshell();
  } catch (e) {
    statusText.textContent = `roster load failed: ${e}`;
    dot.className = 'dot error';
  }
}

bootstrap();

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

const mcpGlobalBtn = document.getElementById('mcp-global-btn');
if (mcpGlobalBtn) {
  mcpGlobalBtn.addEventListener('click', async () => {
    try {
      await tauriInvoke('open_global_mcp_config');
    } catch (e) {
      addMessage({
        from: 'system',
        to: HUMAN_NAME,
        text: `Open MCP config failed: ${e?.message ?? e}`,
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
      // Re-apply theme + font scale from re-read config.yml.
      if (window.A2A_UI && typeof window.A2A_UI.reload === 'function') {
        try { await window.A2A_UI.reload(); } catch {}
      }
      try {
        const name = await tauriInvoke('get_human_name');
        if (typeof name === 'string' && name) {
          HUMAN_NAME = name;
          NAMES[HUMAN_NAME] = cap(HUMAN_NAME);
        }
      } catch {}
      // New hub → fresh session id + chatLog; tear down SSE/cards then replay from ledger.
      if (activeES) { try { activeES.close(); } catch {} activeES = null; }
      handoffCards.clear();
      messagesEl.innerHTML = '';
      lastFrom = null;
      lastSeenId = 0;
      localStorage.setItem('a2achannel_last_event_id', '0');
      interruptCards.clear();
      permissionCards.clear();
      nutshellByRoom.clear();
      connect();
      if (SELECTED_ROOM !== ROOM_ALL) await loadNutshell(SELECTED_ROOM);
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
const addAgentBtn = document.getElementById('add-agent-btn');
if (addAgentBtn) {
  addAgentBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('a2a:open-spawn'));
  });
}
