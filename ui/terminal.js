// Terminal pane. Tab states: external | launching | live.
// Runs as a <script> after main.js; reuses its globals (ROSTER, HUMAN_NAME).

(function terminalPane() {
  const invoke = window.__TAURI__?.core?.invoke;
  const listen = window.__TAURI__?.event?.listen;

  if (!invoke || !listen) {
    console.warn('[terminal] Tauri unavailable; pane disabled');
    return;
  }

  async function pickDirectory() {
    try {
      const res = await invoke('plugin:dialog|open', {
        options: { directory: true, multiple: false, recursive: false },
      });
      return typeof res === 'string' ? res : null;
    } catch (e) {
      console.error('[terminal] pickDirectory', e);
      return null;
    }
  }

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
  const spawnSessionContinue = document.getElementById('spawn-session-continue');
  const spawnSessionResume   = document.getElementById('spawn-session-resume');
  const confirmModal  = document.getElementById('confirm-modal');
  const confirmTitle  = document.getElementById('confirm-title');
  const confirmPrompt = document.getElementById('confirm-prompt');
  const confirmOk     = document.getElementById('confirm-ok');
  const confirmCancel = document.getElementById('confirm-cancel');

  const NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;

  const LOADING_VERBS = [
    'Spawning the session…',
    'Wiring the channel…',
    'Loading the MCP config…',
    'Tailing the SSE stream…',
    'Briefing the agent…',
    'Warming up the PTY…',
    'Summoning Claude…',
    'Registering with the hub…',
    'Dismissing the dev-channels prompt…',
    'Syncing the roster…',
    'Unrolling the nutshell…',
    'Handshaking over stdio…',
    'Awaiting the first byte…',
  ];
  let _verbIdx = -1;
  function pickLoadingVerb() {
    let i = Math.floor(Math.random() * LOADING_VERBS.length);
    if (i === _verbIdx) i = (i + 1) % LOADING_VERBS.length;
    _verbIdx = i;
    return LOADING_VERBS[i];
  }

  const SPLIT_KEY = 'a2achannel_terminal_split';

  localStorage.removeItem('a2achannel_terminal_enabled');
  localStorage.removeItem('a2achannel_ui_version');
  let _paneEnabled = false;

  function paneEnabled() {
    return _paneEnabled;
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
    _paneEnabled = !_paneEnabled;
    applyPaneClass();
    if (_paneEnabled) reconcile();
    for (const t of tabs.values()) if (t.term) t.fitAddon?.fit();
  });

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

  const tabs = new Map();
  let activeAgent = null;
  let cwdCache = JSON.parse(localStorage.getItem('a2achannel_agent_cwds') || '{}');
  function rememberCwd(agent, cwd) {
    cwdCache[agent] = cwd;
    localStorage.setItem('a2achannel_agent_cwds', JSON.stringify(cwdCache));
  }

  async function ptySpawn(agent, cwd, sessionMode) {
    const args = { agent, cwd };
    if (sessionMode === 'resume' || sessionMode === 'continue') {
      args.sessionMode = sessionMode;
    }
    return invoke('pty_spawn', args);
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

  const xtermTheme = {
    background: '#14110f', foreground: '#f5ede2', cursor: '#d97757',
    black: '#2a231e',   red: '#d4604a',  green: '#7fb069',   yellow: '#e8a857',
    blue:  '#6b9bc9',   magenta: '#a788c4', cyan: '#6ab5a3',  white: '#a69583',
    brightBlack: '#4a3d34', brightRed: '#e07a63', brightGreen: '#9dc285',
    brightYellow: '#f0be7a', brightBlue: '#84afd9', brightMagenta: '#bb9fd5',
    brightCyan: '#83c9b9', brightWhite: '#f5ede2',
  };

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
    for (const child of Array.from(t.paneEl.children)) {
      if (child.classList?.contains('terminal-empty') ||
          child.classList?.contains('terminal-external-info') ||
          child.classList?.contains('terminal-loading')) {
        child.remove();
      }
    }
    if (t.state === 'launching' || (t.state === 'live' && !t.term)) {
      const loader = document.createElement('div');
      loader.className = 'terminal-loading';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 48 48');
      svg.setAttribute('class', 'terminal-loading-icon');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML =
        '<g stroke="var(--orange)" stroke-width="4" stroke-linecap="round" fill="none">' +
          '<line x1="24" y1="4"  x2="24" y2="44"/>' +
          '<line x1="4"  y1="24" x2="44" y2="24"/>' +
          '<line x1="10" y1="10" x2="38" y2="38"/>' +
          '<line x1="38" y1="10" x2="10" y2="38"/>' +
        '</g>';
      loader.appendChild(svg);
      const label = document.createElement('div');
      label.className = 'terminal-loading-label';
      label.textContent = pickLoadingVerb();
      loader.appendChild(label);
      loader._verbTimer = setInterval(() => {
        if (!loader.isConnected) { clearInterval(loader._verbTimer); return; }
        label.textContent = pickLoadingVerb();
      }, 2200);
      t.paneEl.appendChild(loader);
      return;
    }
    if (t.state === 'external') {
      const info = document.createElement('div');
      info.className = 'terminal-external-info';
      info.innerHTML =
        '<div>' + t.tabEl.dataset.agent + ' is running outside A2AChannel.</div>' +
        '<div style="font-size:11px; color:var(--text-dim);">Quit the external ' +
        'claude session to launch it inside the pane.</div>';
      t.paneEl.appendChild(info);
    }
  }

  // Caskaydia is inlined as a data: URL in style.css — no fetch, synchronously available.
  // Eagerly fetch every font the xterm instance may reach for. The
  // 2.7 MB CaskaydiaMono Nerd Font is embedded as a base64 data: URI
  // in style.css — browsers defer its parse until something in the
  // DOM asks for it. xterm's canvas atlas bakes glyphs at open() time,
  // so if the font isn't ready we get blank cells for box-drawing /
  // Nerd-patch codepoints claude uses in its banner. Explicit
  // Fonts.load() returns a Promise that resolves once the glyph tables
  // are actually decoded and available for measurement.
  const fontPreload = (async () => {
    const families = [
      '"CaskaydiaMono Nerd Font"',
      '"JetBrains Mono"',
    ];
    // Size doesn't matter for loading — the browser resolves the
    // font file, not a rendered size. Pick 12 (the xterm default).
    try {
      await Promise.all(families.map(f =>
        document.fonts.load(`12px ${f}`)
      ));
    } catch (e) {
      console.warn('[terminal] font preload failed', e);
    }
    try { await document.fonts.ready; } catch {}
  })();

  async function mountXterm(t) {
    if (t.term) return;
    try { await fontPreload; } catch {}
    try { await document.fonts?.ready; } catch {}
    if (t.term) return;
    for (const child of Array.from(t.paneEl.children)) {
      if (child.classList?.contains('terminal-empty') ||
          child.classList?.contains('terminal-external-info') ||
          child.classList?.contains('terminal-loading')) {
        child.remove();
      }
    }
    const term = new window.Terminal({
      theme: xtermTheme,
      fontFamily: "'CaskaydiaMono Nerd Font', 'JetBrains Mono', 'SF Mono', Menlo, 'Apple Symbols', 'Apple Color Emoji', monospace",
      fontSize: 12,
      cursorBlink: true,
      convertEol: false,
      scrollback: 10000,
    });
    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(t.paneEl);
    // Re-assigning fontFamily invalidates xterm's glyph atlas so it rebakes with the loaded font.
    const ff = term.options.fontFamily;
    term.options.fontFamily = 'monospace';
    term.options.fontFamily = ff;
    fitAddon.fit();
    term.onData((data) => {
      ptyWrite(t.tabEl.dataset.agent, strToB64(data)).catch((e) =>
        console.error('[terminal] write', e));
    });
    t.term = term;
    t.fitAddon = fitAddon;
    const ro = new ResizeObserver(() => sendResize(t));
    ro.observe(t.paneEl);
    t._ro = ro;
    sendResize(t);
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
      if (name === agent) t.tabEl.classList.remove('needs-attention');
    }
    activeAgent = agent;
    const t = tabs.get(agent);
    if (t) {
      renderPaneBody(t);
      sendResize(t);
    }
  }

  const DEV_CHANNELS_PROMPT_MARKER = 'Iamusingthisforlocaldevelopment';

  const TAIL_BUFFER_MAX = 4096;
  // Separate decoders: sharing one with {stream:true} corrupts both.
  const devDecoder = new TextDecoder('utf-8', { fatal: false });
  const attnDecoder = new TextDecoder('utf-8', { fatal: false });

  // Strip ANSI before letters-only normalize, otherwise CSI trailing letters pollute the match.
  const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

  const ATTENTION_MARKER = 'Doyouwantto';
  const ATTN_TAIL_MAX = 2048;

  function maybeFlagAttention(t, agent, chunkBytes) {
    t.attnTail = (t.attnTail || '') + attnDecoder.decode(chunkBytes, { stream: true });
    if (t.attnTail.length > ATTN_TAIL_MAX) {
      t.attnTail = t.attnTail.slice(-ATTN_TAIL_MAX);
    }
    const lettersOnly = t.attnTail
      .replace(ANSI_ESCAPE_RE, '')
      .replace(/[^A-Za-z]/g, '');
    if (lettersOnly.includes(ATTENTION_MARKER)) {
      t.attnTail = '';
      if (activeAgent !== agent) {
        t.tabEl.classList.add('needs-attention');
      }
    }
  }

  function maybeAutoDismissDevChannels(t, agent, chunkBytes) {
    if (t.warningDismissed) return;
    t.outputTail = (t.outputTail || '') + devDecoder.decode(chunkBytes, { stream: true });
    if (t.outputTail.length > TAIL_BUFFER_MAX) {
      t.outputTail = t.outputTail.slice(-TAIL_BUFFER_MAX);
    }
    const lettersOnly = t.outputTail
      .replace(ANSI_ESCAPE_RE, '')
      .replace(/[^A-Za-z]/g, '');
    if (lettersOnly.includes(DEV_CHANNELS_PROMPT_MARKER)) {
      t.warningDismissed = true;
      t.outputTail = '';
      t._launchStage?.('dev-channels marker detected');
      setTimeout(() => {
        if (!tabs.has(agent)) return;
        ptyWrite(agent, strToB64('\r')).catch(() => {});
        t._launchStage?.('Enter sent (dismiss)');
        // SIGWINCH cycle forces claude's alt-screen to flush.
        setTimeout(() => {
          const tt = tabs.get(agent);
          if (!tt || !tt.term) return;
          const cols = tt.term.cols;
          const rows = tt.term.rows;
          ptyResize(agent, cols, Math.max(5, rows - 1))
            .then(() => ptyResize(agent, cols, rows))
            .then(() => t._launchStage?.('SIGWINCH cycle done'))
            .catch(() => {});
        }, 300);
      }, 100);
    }
  }

  async function attachOutputListener(agent) {
    const t = tabs.get(agent);
    if (!t) return;
    try { t.outputUnlisten?.(); } catch {}
    try { t.exitUnlisten?.(); } catch {}
    t.warningDismissed = false;
    t.outputTail = '';
    t.outputUnlisten = await listen(`pty://output/${agent}`, async (e) => {
      const bytes = b64ToBytes(e.payload.b64);
      if (!t._firstByteLogged && t._launchStage) {
        t._firstByteLogged = true;
        t._launchStage(`first PTY byte (${bytes.length}B)`);
      }
      if (!t.term) {
        await mountXterm(t);
        t._launchStage?.('xterm mounted');
      }
      // U+23FA ⏺ (E2 8F BA) → U+25CF ● (E2 97 8F) — Caskaydia lacks ⏺, avoids emoji-font fallback.
      for (let i = 0; i + 2 < bytes.length; i++) {
        if (bytes[i] === 0xE2 && bytes[i+1] === 0x8F && bytes[i+2] === 0xBA) {
          bytes[i+1] = 0x97;
          bytes[i+2] = 0x8F;
        }
      }
      t.term?.write(bytes);
      maybeAutoDismissDevChannels(t, agent, bytes);
      maybeFlagAttention(t, agent, bytes);
    });
    t.exitUnlisten = await listen(`pty://exit/${agent}`, () => {
      removeTab(agent);
      reconcile();
    });
  }

  async function handleLaunch(agent, cwd, sessionMode = null) {
    if (!_paneEnabled) {
      _paneEnabled = true;
      applyPaneClass();
    }
    const t0 = performance.now();
    const stage = (label) =>
      console.log(`[launch-timing] +${Math.round(performance.now() - t0)}ms — ${agent} — ${label}`);
    stage('handleLaunch start');
    const t = ensureTab(agent);
    setTabState(agent, 'launching');
    focusTab(agent);
    t._launchT0 = t0;
    t._launchStage = stage;
    try {
      stage('invoke pty_spawn');
      await ptySpawn(agent, cwd, sessionMode);
      stage('pty_spawn returned');
      rememberCwd(agent, cwd);
      t.cwd = cwd;
      t.external = false;
      setTabState(agent, 'live');
      await attachOutputListener(agent);
      stage('output listener attached');
      sendResize(t);
      // Fallback SIGWINCH if claude errored before the dev-channels prompt appeared.
      setTimeout(() => {
        if (!tabs.has(agent) || !t.term) return;
        if (t.warningDismissed) return;
        const cols = t.term.cols;
        const rows = t.term.rows;
        ptyResize(agent, cols, Math.max(5, rows - 1))
          .then(() => ptyResize(agent, cols, rows))
          .catch(() => {});
      }, 15000);
    } catch (e) {
      console.error('[terminal] spawn failed:', e);
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

    // No leading Esc — claude's input layer swallows `\x1b/` as a key-combo and eats `/e`.
    try {
      await ptyWrite(agent, strToB64('/exit\r'));
    } catch (e) {
      console.error('[terminal] /exit write failed:', e);
    }

    setTimeout(async () => {
      if (!tabs.has(agent)) return;
      console.debug('[terminal] /exit timeout on', agent, '— force-killing');
      try { await ptyKill(agent); } catch (e) {
        console.error('[terminal] force-kill failed:', e);
      }
    }, 10000);
  }

  toggleBtn?.addEventListener('dblclick', () => openSpawnModal());

  function openSpawnModal(prefillAgent = '', prefillCwd = '') {
    spawnAgentEl.value = prefillAgent;
    spawnCwdEl.value = prefillCwd;
    if (spawnSessionContinue) spawnSessionContinue.checked = false;
    if (spawnSessionResume)   spawnSessionResume.checked = false;
    spawnModal.classList.add('open');
    setTimeout(() => spawnAgentEl.focus(), 0);
  }
  document.addEventListener('a2a:open-spawn', () => openSpawnModal());
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
    let sessionMode = null;
    if (spawnSessionContinue?.checked) sessionMode = 'continue';
    else if (spawnSessionResume?.checked) sessionMode = 'resume';
    closeSpawnModal();
    await handleLaunch(agent, cwd, sessionMode);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && spawnModal.classList.contains('open')) closeSpawnModal();
  });

  async function reconcile() {
    const rosterNames = (typeof ROSTER !== 'undefined' && Array.isArray(ROSTER))
      ? ROSTER.map(a => a.name).filter(n => n !== (typeof HUMAN_NAME !== 'undefined' ? HUMAN_NAME : 'you'))
      : [];
    const sessionNames = await ptyList();
    const want = new Set([...rosterNames, ...sessionNames]);

    for (const [name, t] of Array.from(tabs)) {
      if (!want.has(name) && t.state !== 'live' && t.state !== 'launching') {
        removeTab(name);
      }
    }

    for (const name of want) {
      if (!tabs.has(name)) {
        ensureTab(name);
        setTabState(name, 'external');
      }
    }

    for (const name of sessionNames) {
      const t = tabs.get(name);
      if (!t) continue;
      if (t.state === 'live' || t.state === 'launching') continue;
      const cwd = cwdCache[name] || (window.__TAURI__ ? '' : '');
      autoAttach(name, cwd).catch((e) =>
        console.warn('[terminal] auto-attach failed for', name, e));
    }

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

    if (!activeAgent && tabs.size) {
      focusTab(tabs.keys().next().value);
    }
  }

  async function autoAttach(agent, cwd) {
    const t = tabs.get(agent);
    if (!t) return;
    if (t.state === 'live' || t.state === 'launching') return;
    setTabState(agent, 'launching');
    try {
      const effectiveCwd = cwd || '/tmp';
      await ptySpawn(agent, effectiveCwd);
      setTabState(agent, 'live');
      await attachOutputListener(agent);
      const tt = tabs.get(agent);
      if (tt) sendResize(tt);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes('already attached')) {
        setTabState(agent, 'live');
      } else {
        console.warn('[terminal] autoAttach', agent, e);
        setTabState(agent, 'external');
      }
    }
  }

  setInterval(() => { if (paneEnabled()) reconcile(); }, 5000);
  setTimeout(reconcile, 500);

  (async () => {
    try {
      const names = await ptyList();
      if (names.length && !_paneEnabled) {
        _paneEnabled = true;
        applyPaneClass();
        reconcile();
        for (const t of tabs.values()) if (t.term) t.fitAddon?.fit();
      }
    } catch (e) {}
  })();

  const legend = document.getElementById('legend');
  if (legend) {
    new MutationObserver(() => { if (paneEnabled()) reconcile(); })
      .observe(legend, { childList: true });
  }
})();
