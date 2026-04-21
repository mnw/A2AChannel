// Terminal pane (v0.7).
//
// Bridge shape (matches design Decision 3):
//   term.onData(str)       → invoke('pty_write',  { agent, b64: btoa(utf8(str)) })
//   listen('pty://output/<agent>', e => term.write(bytesFromB64(e.payload.b64)))
//   ResizeObserver         → invoke('pty_resize', { agent, cols, rows })
//
// Tab state machine (design Decision 7):
//   external   agent in roster, no tmux session A2AChannel owns     → info card, no xterm
//   launching  spawn in progress                                     → xterm booting
//   live       we own a PTY, xterm attached                          → active claude / shell
//   dead       held pane (remain-on-exit); Restart affordance shown  → xterm retained for scrollback
//
// Runs as a plain <script> after main.js; reuses its globals (ROSTER, HUMAN_NAME,
// legendEl, AGENT_NAME_RE by re-declaration) without polluting them.

(function terminalPane() {
  // --- Tauri helpers -----------------------------------------------------
  const invoke = window.__TAURI__?.core?.invoke;
  const listen = window.__TAURI__?.event?.listen;

  if (!invoke || !listen) {
    console.warn('[terminal] Tauri unavailable; pane disabled');
    return;
  }

  // Use the dialog plugin's low-level command directly — the JS wrapper
  // from @tauri-apps/plugin-dialog needs a bundler we don't have.
  // plugin:dialog|open is registered by tauri_plugin_dialog::init() in
  // lib.rs and gated by "dialog:default" in capabilities/default.json.
  async function pickDirectory() {
    try {
      const res = await invoke('plugin:dialog|open', {
        options: { directory: true, multiple: false, recursive: false },
      });
      // Tauri 2 returns a string path on selection, null on cancel.
      return typeof res === 'string' ? res : null;
    } catch (e) {
      console.error('[terminal] pickDirectory', e);
      return null;
    }
  }

  // --- DOM references ----------------------------------------------------
  const body          = document.body;
  const toggleBtn     = document.getElementById('terminal-toggle-btn');
  const splitter      = document.getElementById('splitter');
  const appBody       = document.getElementById('app-body');
  const tabsEl        = document.getElementById('terminal-tabs');
  const bodyEl        = document.getElementById('terminal-body');
  const spawnModal    = document.getElementById('spawn-modal');
  const spawnAgentEl  = document.getElementById('spawn-agent-input');
  const spawnCwdEl    = document.getElementById('spawn-cwd-input');
  const spawnCwdPick  = document.getElementById('spawn-cwd-pick');
  const spawnCancel   = document.getElementById('spawn-cancel');
  const spawnSubmit   = document.getElementById('spawn-submit');
  const confirmModal  = document.getElementById('confirm-modal');
  const confirmTitle  = document.getElementById('confirm-title');
  const confirmPrompt = document.getElementById('confirm-prompt');
  const confirmOk     = document.getElementById('confirm-ok');
  const confirmCancel = document.getElementById('confirm-cancel');

  // Must mirror hub.ts AGENT_NAME_RE; re-declared here to avoid hunting in main.js.
  const NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;

  // --- Toggle + splitter -------------------------------------------------
  const PANE_KEY  = 'a2achannel_terminal_enabled';
  const SPLIT_KEY = 'a2achannel_terminal_split';

  function paneEnabled() {
    return localStorage.getItem(PANE_KEY) === 'true';
  }
  function applyPaneClass() {
    body.classList.toggle('no-terminal', !paneEnabled());
  }
  function applySplit() {
    const raw = localStorage.getItem(SPLIT_KEY);
    const pct = raw ? Number(raw) : 50;
    const clamped = Math.max(25, Math.min(75, Number.isFinite(pct) ? pct : 50));
    appBody.style.setProperty('--split', clamped + '%');
  }
  applyPaneClass();
  applySplit();

  toggleBtn?.addEventListener('click', () => {
    const next = !paneEnabled();
    localStorage.setItem(PANE_KEY, String(next));
    applyPaneClass();
    if (next) reconcile();
    // Force xterm refits since the container size changed.
    for (const t of tabs.values()) if (t.term) t.fitAddon?.fit();
  });

  // Splitter drag — updates --split on #app-body.
  let dragStart = null;
  splitter?.addEventListener('pointerdown', (e) => {
    if (!paneEnabled()) return;
    dragStart = { x: e.clientX, width: appBody.getBoundingClientRect().width };
    splitter.classList.add('dragging');
    splitter.setPointerCapture(e.pointerId);
  });
  splitter?.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const rect = appBody.getBoundingClientRect();
    const chatWidth = e.clientX - rect.left;
    const rawPct = (chatWidth / rect.width) * 100;
    const clamped = Math.max(25, Math.min(75, rawPct));
    appBody.style.setProperty('--split', clamped + '%');
    localStorage.setItem(SPLIT_KEY, String(Math.round(clamped)));
    // Refit all live xterms mid-drag.
    for (const t of tabs.values()) if (t.term) t.fitAddon?.fit();
  });
  const endDrag = (e) => {
    if (!dragStart) return;
    splitter.classList.remove('dragging');
    try { splitter.releasePointerCapture(e.pointerId); } catch {}
    dragStart = null;
    for (const t of tabs.values()) if (t.term) sendResize(t);
  };
  splitter?.addEventListener('pointerup',     endDrag);
  splitter?.addEventListener('pointercancel', endDrag);

  // --- askConfirm (tasks §4.2a) -----------------------------------------
  let confirmResolver = null;
  function askConfirm(title, prompt) {
    return new Promise((resolve) => {
      confirmResolver = resolve;
      confirmTitle.textContent = title;
      confirmPrompt.textContent = prompt;
      confirmModal.classList.add('open');
      confirmOk.focus();
    });
  }
  function closeConfirm(result) {
    confirmModal.classList.remove('open');
    const r = confirmResolver;
    confirmResolver = null;
    if (r) r(result);
  }
  confirmOk?.addEventListener('click',     () => closeConfirm(true));
  confirmCancel?.addEventListener('click', () => closeConfirm(false));
  confirmModal?.addEventListener('click', (e) => {
    if (e.target === confirmModal) closeConfirm(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && confirmModal.classList.contains('open')) closeConfirm(false);
  });

  // --- Tab state ---------------------------------------------------------
  // Map<agentName, TabEntry>
  // TabEntry: { state, paneEl, term?, fitAddon?, outputUnlisten?, exitUnlisten?,
  //             cwd?, tabEl, external }
  const tabs = new Map();
  let activeAgent = null;
  let cwdCache = JSON.parse(localStorage.getItem('a2achannel_agent_cwds') || '{}');
  function rememberCwd(agent, cwd) {
    cwdCache[agent] = cwd;
    localStorage.setItem('a2achannel_agent_cwds', JSON.stringify(cwdCache));
  }

  // --- Tauri IPC wrappers ------------------------------------------------
  async function ptySpawn(agent, cwd) {
    return invoke('pty_spawn', { agent, cwd });
  }
  async function ptyWrite(agent, b64) {
    return invoke('pty_write', { agent, b64 });
  }
  async function ptyResize(agent, cols, rows) {
    return invoke('pty_resize', { agent, cols, rows });
  }
  async function ptyKill(agent) {
    return invoke('pty_kill', { agent });
  }
  async function ptyList() {
    try { return await invoke('pty_list'); }
    catch { return []; }
  }

  // --- Encoding helpers (base64) ----------------------------------------
  const encoder = new TextEncoder();
  function strToB64(str) {
    const bytes = encoder.encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // --- Xterm theme (Catppuccin Mocha, mirrors CSS vars) -----------------
  const xtermTheme = {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
    black: '#45475a',   red: '#f38ba8',   green: '#a6e3a1',   yellow: '#f9e2af',
    blue:  '#89b4fa',   magenta: '#f5c2e7', cyan: '#94e2d5',  white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  };

  // --- Tab rendering -----------------------------------------------------
  function ensureTab(agent) {
    let t = tabs.get(agent);
    if (t) return t;
    const tabEl = document.createElement('div');
    tabEl.className = 'terminal-tab';
    tabEl.dataset.agent = agent;
    tabEl.dataset.state = 'external';
    tabEl.innerHTML =
      '<span class="state-dot"></span>' +
      '<span class="tab-label"></span>' +
      '<span class="close-x" title="Kill session">×</span>';
    tabEl.querySelector('.tab-label').textContent = agent;
    tabEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('close-x')) return;
      focusTab(agent);
    });
    tabEl.querySelector('.close-x').addEventListener('click', async (e) => {
      e.stopPropagation();
      await handleKill(agent);
    });
    tabsEl.insertBefore(tabEl, tabsEl.querySelector('.terminal-tab-new'));

    const paneEl = document.createElement('div');
    paneEl.className = 'terminal-pane';
    paneEl.dataset.agent = agent;
    bodyEl.appendChild(paneEl);

    t = { state: 'external', tabEl, paneEl, term: null, fitAddon: null,
          outputUnlisten: null, exitUnlisten: null, cwd: cwdCache[agent] || null, external: true };
    tabs.set(agent, t);
    return t;
  }

  function removeTab(agent) {
    const t = tabs.get(agent);
    if (!t) return;
    try { t.outputUnlisten?.(); } catch {}
    try { t.exitUnlisten?.(); } catch {}
    try { t.term?.dispose(); } catch {}
    t.tabEl.remove();
    t.paneEl.remove();
    tabs.delete(agent);
    if (activeAgent === agent) activeAgent = null;
  }

  function setTabState(agent, state) {
    const t = tabs.get(agent);
    if (!t) return;
    t.state = state;
    t.tabEl.dataset.state = state;
    renderPaneBody(t);
  }

  function renderPaneBody(t) {
    // Prune any helper overlays; xterm (if present) stays inside.
    for (const child of Array.from(t.paneEl.children)) {
      if (child.classList?.contains('terminal-empty') ||
          child.classList?.contains('terminal-external-info')) {
        child.remove();
      }
    }
    if (t.state === 'external') {
      const info = document.createElement('div');
      info.className = 'terminal-external-info';
      info.innerHTML =
        '<div>' + t.tabEl.dataset.agent + ' is running outside A2AChannel.</div>' +
        '<div style="font-size:11px; color:var(--ctp-overlay0);">Quit the external ' +
        'claude session to launch it inside the pane.</div>';
      t.paneEl.appendChild(info);
    } else if (t.state === 'live' && !t.term) {
      // Mount a fresh xterm.
      const term = new window.Terminal({
        theme: xtermTheme,
        fontFamily: "'SF Mono', Menlo, monospace",
        fontSize: 12,
        cursorBlink: true,
        convertEol: false,
        scrollback: 10000,
      });
      const fitAddon = new window.FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(t.paneEl);
      fitAddon.fit();
      term.onData((data) => {
        ptyWrite(t.tabEl.dataset.agent, strToB64(data)).catch((e) =>
          console.error('[terminal] write', e));
      });
      t.term = term;
      t.fitAddon = fitAddon;
      // Observe size changes so SIGWINCH propagates.
      const ro = new ResizeObserver(() => sendResize(t));
      ro.observe(t.paneEl);
      t._ro = ro;
    }
  }

  function sendResize(t) {
    if (!t.term || !t.fitAddon) return;
    t.fitAddon.fit();
    const { cols, rows } = t.term;
    if (cols > 0 && rows > 0) {
      ptyResize(t.tabEl.dataset.agent, cols, rows).catch(() => {});
    }
  }

  function focusTab(agent) {
    for (const [name, t] of tabs) {
      t.tabEl.classList.toggle('active', name === agent);
      t.paneEl.classList.toggle('active', name === agent);
    }
    activeAgent = agent;
    const t = tabs.get(agent);
    if (t) {
      renderPaneBody(t);
      sendResize(t);
    }
  }

  // Marker for the claude 2.1+ `--dangerously-load-development-channels`
  // confirmation prompt. When we see this text in the output stream, we
  // auto-send Enter (option 1 is pre-selected) and force a redraw so the
  // rest of the TUI flushes to the xterm.
  const DEV_CHANNELS_PROMPT_MARKER = 'I am using this for local development';
  const TAIL_BUFFER_MAX = 1024;
  const decoder = new TextDecoder('utf-8', { fatal: false });

  function maybeAutoDismissDevChannels(t, agent, chunkBytes) {
    if (t.warningDismissed) return;
    // Accumulate a rolling tail of decoded output to handle the marker
    // being split across chunks. Cheap — bounded at TAIL_BUFFER_MAX.
    t.outputTail = (t.outputTail || '') + decoder.decode(chunkBytes, { stream: true });
    if (t.outputTail.length > TAIL_BUFFER_MAX) {
      t.outputTail = t.outputTail.slice(-TAIL_BUFFER_MAX);
    }
    if (t.outputTail.includes(DEV_CHANNELS_PROMPT_MARKER)) {
      t.warningDismissed = true;
      t.outputTail = ''; // release buffer
      // Small delay so claude's prompt is fully rendered before we Enter.
      setTimeout(() => {
        if (!tabs.has(agent)) return;
        ptyWrite(agent, strToB64('\r')).catch(() => {});
        // Force-flush tmux's alt-screen buffer by cycling the PTY size
        // so claude's post-prompt TUI draw reaches our xterm.
        setTimeout(() => {
          const tt = tabs.get(agent);
          if (!tt || !tt.term) return;
          const cols = tt.term.cols;
          const rows = tt.term.rows;
          ptyResize(agent, cols, Math.max(5, rows - 1))
            .then(() => ptyResize(agent, cols, rows))
            .catch(() => {});
        }, 300);
      }, 100);
    }
  }

  // --- Event wiring ------------------------------------------------------
  async function attachOutputListener(agent) {
    const t = tabs.get(agent);
    if (!t) return;
    try { t.outputUnlisten?.(); } catch {}
    try { t.exitUnlisten?.(); } catch {}
    // Reset per-attach dismiss state so a re-attach after claude restart
    // (future feature) can auto-dismiss again.
    t.warningDismissed = false;
    t.outputTail = '';
    t.outputUnlisten = await listen(`pty://output/${agent}`, (e) => {
      const bytes = b64ToBytes(e.payload.b64);
      if (t.term) t.term.write(bytes);
      maybeAutoDismissDevChannels(t, agent, bytes);
    });
    t.exitUnlisten = await listen(`pty://exit/${agent}`, () => {
      // No more held pane / dead state — when claude exits, the tmux
      // session is gone. Remove the tab; the next reconcile re-surfaces
      // an `external` tab if the agent is still in the hub roster
      // (unlikely since chatbridge exits with claude).
      removeTab(agent);
      reconcile();
    });
  }

  // --- Spawn / Launch / Restart / Kill -----------------------------------
  async function handleLaunch(agent, cwd) {
    const t = ensureTab(agent);
    setTabState(agent, 'launching');
    focusTab(agent);
    try {
      await ptySpawn(agent, cwd);
      rememberCwd(agent, cwd);
      t.cwd = cwd;
      t.external = false;
      setTabState(agent, 'live');
      // renderPaneBody mounts the xterm; then attach listeners.
      await attachOutputListener(agent);
      sendResize(t);
      // Auto-dismiss + redraw is now output-driven in
      // maybeAutoDismissDevChannels — fires exactly when the warning
      // prompt text appears in the PTY stream. Keep a single 15s fallback
      // resize cycle for the edge case where claude errors before the
      // prompt and we need to force a flush to show whatever DID draw.
      setTimeout(() => {
        if (!tabs.has(agent) || !t.term) return;
        if (t.warningDismissed) return; // output-scan path already flushed
        const cols = t.term.cols;
        const rows = t.term.rows;
        ptyResize(agent, cols, Math.max(5, rows - 1))
          .then(() => ptyResize(agent, cols, rows))
          .catch(() => {});
      }, 15000);
    } catch (e) {
      console.error('[terminal] spawn failed:', e);
      // No held state to recover to — remove the tab and let reconcile
      // re-surface an `external`-state tab if the agent is still in the
      // hub roster. User can click + New agent to retry.
      alert(`Launch failed: ${e?.message ?? e}`);
      removeTab(agent);
      reconcile();
    }
  }

  async function handleKill(agent) {
    const ok = await askConfirm(
      'Shut down claude session?',
      `Sends /exit to claude and closes the tmux session once claude shuts down cleanly. Scrollback will be lost.`,
    );
    if (!ok) return;

    // Graceful: send /exit to claude. Claude processes the command,
    // shuts down its MCP servers (including chatbridge), prints goodbye,
    // and exits. The shell exits, tmux pane ends, session dies (no
    // remain-on-exit), pty://exit fires, removeTab() runs — natural chain.
    try {
      await ptyWrite(agent, strToB64('/exit\n'));
    } catch (e) {
      console.error('[terminal] /exit write failed:', e);
    }

    // Fallback: if claude hasn't exited within 5 s (hung tool, weird
    // state), force-kill the tmux session directly. Same chain from
    // there, just less graceful.
    setTimeout(async () => {
      if (!tabs.has(agent)) return; // already exited cleanly
      console.warn('[terminal] /exit timeout on', agent, '— force-killing');
      try { await ptyKill(agent); } catch (e) {
        console.error('[terminal] force-kill failed:', e);
      }
    }, 5000);
  }

  // --- New agent modal ---------------------------------------------------
  toggleBtn?.addEventListener('dblclick', () => openSpawnModal());
  // Primary entry: the "+" button in the tab strip (created in reconcile).

  function openSpawnModal(prefillAgent = '', prefillCwd = '') {
    spawnAgentEl.value = prefillAgent;
    spawnCwdEl.value = prefillCwd;
    spawnModal.classList.add('open');
    setTimeout(() => spawnAgentEl.focus(), 0);
  }
  function closeSpawnModal() { spawnModal.classList.remove('open'); }
  spawnCancel?.addEventListener('click', closeSpawnModal);
  spawnModal?.addEventListener('click', (e) => {
    if (e.target === spawnModal) closeSpawnModal();
  });
  spawnCwdPick?.addEventListener('click', async () => {
    const dir = await pickDirectory();
    if (dir) spawnCwdEl.value = dir;
  });
  spawnSubmit?.addEventListener('click', async () => {
    const agent = spawnAgentEl.value.trim();
    const cwd = spawnCwdEl.value.trim();
    if (!NAME_RE.test(agent)) {
      alert('Invalid agent name (letters, digits, _.-, spaces in the middle).');
      return;
    }
    if (!cwd) { alert('Pick a working directory.'); return; }
    closeSpawnModal();
    await handleLaunch(agent, cwd);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && spawnModal.classList.contains('open')) closeSpawnModal();
  });

  // --- Reconcile: tabs = ROSTER ∪ pty_list -------------------------------
  async function reconcile() {
    const rosterNames = (typeof ROSTER !== 'undefined' && Array.isArray(ROSTER))
      ? ROSTER.map(a => a.name).filter(n => n !== (typeof HUMAN_NAME !== 'undefined' ? HUMAN_NAME : 'you'))
      : [];
    const sessionNames = await ptyList();
    const want = new Set([...rosterNames, ...sessionNames]);

    // Remove tabs whose agents disappeared from both sources and we don't own the PTY.
    for (const [name, t] of Array.from(tabs)) {
      if (!want.has(name) && t.state !== 'live' && t.state !== 'launching') {
        removeTab(name);
      }
    }

    // Add missing tabs.
    for (const name of want) {
      if (!tabs.has(name)) {
        ensureTab(name);
        setTabState(name, 'external');
      }
    }

    // Auto-attach: any tmux session on our socket that we don't yet have
    // a live local handle for. Happens on app restart — tmux sessions
    // survive, but the PtyRegistry is fresh. `pty_spawn` is idempotent
    // (new-session -A + set-option); cwd is ignored when the session
    // already exists, so we can pass remembered or default.
    for (const name of sessionNames) {
      const t = tabs.get(name);
      if (!t) continue;
      if (t.state === 'live' || t.state === 'launching') continue;
      const cwd = cwdCache[name] || (window.__TAURI__ ? '' : '');
      // If we have no memoized cwd, fall back to $HOME; resolves in Rust
      // via the command builder inheriting env. tmux ignores -c for
      // existing sessions so this only matters on brand-new creates (N/A here).
      autoAttach(name, cwd).catch((e) =>
        console.warn('[terminal] auto-attach failed for', name, e));
    }

    // Ensure "+" button is present at end.
    let addBtn = tabsEl.querySelector('.terminal-tab-new');
    if (!addBtn) {
      addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'terminal-tab-new';
      addBtn.title = 'Launch a new agent session';
      addBtn.textContent = '+';
      addBtn.addEventListener('click', () => openSpawnModal());
      tabsEl.appendChild(addBtn);
    }

    // If nothing is focused but we have tabs, focus first one.
    if (!activeAgent && tabs.size) {
      focusTab(tabs.keys().next().value);
    }
  }

  // Silent re-attach for tmux sessions that outlived the app.
  async function autoAttach(agent, cwd) {
    const t = tabs.get(agent);
    if (!t) return;
    if (t.state === 'live' || t.state === 'launching') return;
    setTabState(agent, 'launching');
    try {
      // cwd falls through to $HOME if empty — tmux ignores -c for
      // already-existing sessions anyway.
      const effectiveCwd = cwd || '/tmp';
      await ptySpawn(agent, effectiveCwd);
      setTabState(agent, 'live');
      await attachOutputListener(agent);
      const tt = tabs.get(agent);
      if (tt) sendResize(tt);
    } catch (e) {
      // Likely "already attached" if reconcile ran twice quickly.
      const msg = String(e?.message ?? e);
      if (msg.includes('already attached')) {
        setTabState(agent, 'live');
      } else {
        console.warn('[terminal] autoAttach', agent, e);
        setTabState(agent, 'external');
      }
    }
  }

  // Reconcile every 5s while the pane is visible.
  setInterval(() => { if (paneEnabled()) reconcile(); }, 5000);
  // Initial reconcile on load (roster might not be ready yet; retries on interval).
  setTimeout(reconcile, 500);

  // Re-reconcile whenever the legend gets rebuilt (main.js's applyRoster mutates it).
  // Cheap signal: MutationObserver on the legend element.
  const legend = document.getElementById('legend');
  if (legend) {
    new MutationObserver(() => { if (paneEnabled()) reconcile(); })
      .observe(legend, { childList: true });
  }
})();
