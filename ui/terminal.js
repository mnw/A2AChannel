// Terminal pane (v0.7).
//
// Bridge shape (matches design Decision 3):
//   term.onData(str)       → invoke('pty_write',  { agent, b64: btoa(utf8(str)) })
//   listen('pty://output/<agent>', e => term.write(bytesFromB64(e.payload.b64)))
//   ResizeObserver         → invoke('pty_resize', { agent, cols, rows })
//
// Tab state machine (post-v0.7 final):
//   external   agent in roster, no tmux session A2AChannel owns     → info card, no xterm
//   launching  spawn in progress                                     → xterm booting
//   live       we own a PTY, xterm attached                          → active claude / shell
//
// When claude exits the pane exits, session dies, pty://exit fires, tab removes.
// No held-pane / dead state — that was v0.7-alpha.
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
  const spawnSessionContinue = document.getElementById('spawn-session-continue');
  const spawnSessionResume   = document.getElementById('spawn-session-resume');
  const confirmModal  = document.getElementById('confirm-modal');
  const confirmTitle  = document.getElementById('confirm-title');
  const confirmPrompt = document.getElementById('confirm-prompt');
  const confirmOk     = document.getElementById('confirm-ok');
  const confirmCancel = document.getElementById('confirm-cancel');

  // Must mirror hub.ts AGENT_NAME_RE; re-declared here to avoid hunting in main.js.
  const NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;

  // --- Toggle + splitter -------------------------------------------------
  const SPLIT_KEY = 'a2achannel_terminal_split';

  // Pane visibility is NOT persisted across launches. Default is closed;
  // if the user has any tmux sessions outlived their last quit, we
  // auto-open on launch so those agents remain visible. Toggle works
  // during the session; re-opening the app resets to this "closed
  // unless there's work" rule. Split ratio persists separately.
  // Clean up old persisted keys from pre-0.7.1 installs.
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

  // --- Xterm theme (warm-dark, mirrors style.css tokens) -----------------
  const xtermTheme = {
    background: '#14110f', foreground: '#f5ede2', cursor: '#d97757',
    black: '#2a231e',   red: '#d4604a',  green: '#7fb069',   yellow: '#e8a857',
    blue:  '#6b9bc9',   magenta: '#a788c4', cyan: '#6ab5a3',  white: '#a69583',
    brightBlack: '#4a3d34', brightRed: '#e07a63', brightGreen: '#9dc285',
    brightYellow: '#f0be7a', brightBlue: '#84afd9', brightMagenta: '#bb9fd5',
    brightCyan: '#83c9b9', brightWhite: '#f5ede2',
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
          child.classList?.contains('terminal-external-info') ||
          child.classList?.contains('terminal-loading')) {
        child.remove();
      }
    }
    // Show the sparkle-loader during launching AND during early "live"
    // before claude's first byte arrives. Claude's startup (Bun runtime
    // + TUI + MCP init) takes 3–15 s, during which a just-mounted xterm
    // would sit blank — worse feedback than a spinner. We defer the
    // xterm mount until `attachOutputListener` sees the first byte.
    if (t.state === 'launching' || (t.state === 'live' && !t.term)) {
      const loader = document.createElement('div');
      loader.className = 'terminal-loading';
      const img = document.createElement('img');
      img.src = 'sparkle.webp';
      img.alt = '';
      loader.appendChild(img);
      const label = document.createElement('div');
      label.textContent = t.state === 'launching' ? 'spawning session…' : 'claude is starting…';
      loader.appendChild(label);
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
    // `live` with t.term already mounted: nothing to do — xterm stays in place.
  }

  // Lazily create the xterm on first PTY output so the sparkle-loader
  // stays visible during claude's multi-second boot. Idempotent.
  function mountXterm(t) {
    if (t.term) return;
    // Prune any helper overlays (loader, external-info) before mounting.
    for (const child of Array.from(t.paneEl.children)) {
      if (child.classList?.contains('terminal-empty') ||
          child.classList?.contains('terminal-external-info') ||
          child.classList?.contains('terminal-loading')) {
        child.remove();
      }
    }
    const term = new window.Terminal({
      theme: xtermTheme,
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
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
    const ro = new ResizeObserver(() => sendResize(t));
    ro.observe(t.paneEl);
    t._ro = ro;
    // Propagate the real xterm size to the PTY immediately.
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
      // Clear the attention flash on the tab the user is looking at.
      if (name === agent) t.tabEl.classList.remove('needs-attention');
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
  // Claude 2.1.117+ renders the dev-channels confirmation prompt
  // character-by-character with cursor-positioning escape codes
  // interleaved, so the raw byte stream has no spaces between letters.
  // We normalize the tail (strip everything but A-Za-z) before matching
  // against a spaces-stripped marker. Older claude versions emitted the
  // phrase as a contiguous string; this approach matches both shapes.
  const DEV_CHANNELS_PROMPT_MARKER = 'Iamusingthisforlocaldevelopment';
  const TAIL_BUFFER_MAX = 4096;
  // NOTE: each output scanner MUST keep its own TextDecoder. Sharing one
  // decoder with `{stream: true}` across two scanners corrupts both —
  // each call advances the decoder's partial-UTF8 state machine. When
  // dev-channels marker detection fails, claude sits at the confirmation
  // prompt forever and no first screen / chatbridge registration ever
  // happens. Keep these instances separate.
  const devDecoder = new TextDecoder('utf-8', { fatal: false });
  const attnDecoder = new TextDecoder('utf-8', { fatal: false });

  // CSI / OSC escape sequences used by claude's TUI. Strip BEFORE the
  // letters-only scrub — the final letter of `ESC [ n C` (cursor
  // forward) is a letter (`C`) and would otherwise pollute the
  // letters-only string with stray cursor-control characters.
  const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

  // Attention marker — fires when claude prints a permission prompt.
  // All of claude's permission asks start with "Do you want to …"
  // (proceed, continue, allow, run, etc.); letters-only = 'Doyouwantto'.
  // We set `needs-attention` on the tab when the user is NOT currently
  // focused on that tab, so they can see at a glance which agent
  // needs an answer.
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
      // Release the buffer so the next prompt re-fires the flash.
      t.attnTail = '';
      // Only flag if the tab isn't already the focused one — the
      // whole point is to notify about background agents.
      if (activeAgent !== agent) {
        t.tabEl.classList.add('needs-attention');
      }
    }
  }

  function maybeAutoDismissDevChannels(t, agent, chunkBytes) {
    if (t.warningDismissed) return;
    // Accumulate a rolling tail of decoded output to handle the marker
    // being split across chunks. Cheap — bounded at TAIL_BUFFER_MAX.
    t.outputTail = (t.outputTail || '') + devDecoder.decode(chunkBytes, { stream: true });
    if (t.outputTail.length > TAIL_BUFFER_MAX) {
      t.outputTail = t.outputTail.slice(-TAIL_BUFFER_MAX);
    }
    // First strip ANSI escape sequences (claude 2.1.117+ emits each
    // letter of the prompt with a CSI cursor-forward between them, and
    // the trailing `C` of `ESC [ n C` is a letter that would otherwise
    // contaminate the letters-only version), then keep only letters
    // and match against a spaces-stripped marker.
    const lettersOnly = t.outputTail
      .replace(ANSI_ESCAPE_RE, '')
      .replace(/[^A-Za-z]/g, '');
    if (lettersOnly.includes(DEV_CHANNELS_PROMPT_MARKER)) {
      t.warningDismissed = true;
      t.outputTail = ''; // release buffer
      t._launchStage?.('dev-channels marker detected');
      // Small delay so claude's prompt is fully rendered before we Enter.
      setTimeout(() => {
        if (!tabs.has(agent)) return;
        ptyWrite(agent, strToB64('\r')).catch(() => {});
        t._launchStage?.('Enter sent (dismiss)');
        // Force-flush tmux's alt-screen buffer by cycling the PTY size
        // so claude's post-prompt TUI draw reaches our xterm.
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
      if (!t._firstByteLogged && t._launchStage) {
        t._firstByteLogged = true;
        t._launchStage(`first PTY byte (${bytes.length}B)`);
      }
      // Lazy mount: the first byte is our signal that claude's TUI is
      // ready to render. Until then, the sparkle-loader covers the pane.
      if (!t.term) {
        mountXterm(t);
        t._launchStage?.('xterm mounted');
      }
      t.term.write(bytes);
      maybeAutoDismissDevChannels(t, agent, bytes);
      maybeFlagAttention(t, agent, bytes);
    });
    t.exitUnlisten = await listen(`pty://exit/${agent}`, () => {
      // When claude exits the tmux session dies (no remain-on-exit).
      // Remove the tab. Session state is tracked by claude itself under
      // ~/.claude/projects/; our spawn modal offers --continue and
      // --resume radio options that invoke claude's own resume path.
      removeTab(agent);
      reconcile();
    });
  }

  // --- Spawn / Launch / Kill ---------------------------------------------
  async function handleLaunch(agent, cwd, sessionMode = null) {
    // Force the pane open so the loader + xterm are actually visible.
    // Auto-open-on-launch is the documented rule: "if the terminal has
    // agents, keep it open."
    if (!_paneEnabled) {
      _paneEnabled = true;
      applyPaneClass();
    }
    // --- Startup timing instrumentation ---
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
      // renderPaneBody keeps the loader up; xterm mounts on first byte.
      await attachOutputListener(agent);
      stage('output listener attached');
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

    // Graceful: send /exit + Enter to claude's REPL. Claude processes
    // the command, shuts down its MCP servers (including chatbridge),
    // exits. The shell exits, tmux pane ends, session dies (no
    // remain-on-exit), pty://exit fires, removeTab() runs.
    //
    // Note: we do NOT send a leading Escape to back out of nested
    // modes. Claude's input layer consumes `\x1b` (and our `/` that
    // follows) as a key-combo, leaving only `xit` in the input field.
    // If the user is mid-tool (vim, pager, slash-picker), the 10 s
    // force-kill fallback below handles it.
    try {
      await ptyWrite(agent, strToB64('/exit\r'));
    } catch (e) {
      console.error('[terminal] /exit write failed:', e);
    }

    // Fallback: if claude hasn't exited within 10 s (MCP-server
    // cleanup can be slow, or claude is hung), force-kill the tmux
    // session directly. Same chain from there, just less graceful.
    // Not logged as a warning — both paths end the session as
    // requested by the user; it's an implementation detail.
    setTimeout(async () => {
      if (!tabs.has(agent)) return; // already exited cleanly
      console.debug('[terminal] /exit timeout on', agent, '— force-killing');
      try { await ptyKill(agent); } catch (e) {
        console.error('[terminal] force-kill failed:', e);
      }
    }, 10000);
  }

  // --- New agent modal ---------------------------------------------------
  toggleBtn?.addEventListener('dblclick', () => openSpawnModal());
  // Primary entry: the "+" button in the tab strip (created in reconcile).

  function openSpawnModal(prefillAgent = '', prefillCwd = '') {
    spawnAgentEl.value = prefillAgent;
    spawnCwdEl.value = prefillCwd;
    // Session mode radios reset to unselected — user opts in explicitly.
    if (spawnSessionContinue) spawnSessionContinue.checked = false;
    if (spawnSessionResume)   spawnSessionResume.checked = false;
    spawnModal.classList.add('open');
    setTimeout(() => spawnAgentEl.focus(), 0);
  }
  // Allow main.js (the roster's "+ agent" button) to open the spawn
  // modal without cross-script globals.
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

  // Auto-open the pane at launch if tmux has any sessions on our
  // socket — the user had agents open when they last quit, so keeping
  // them visible beats making them re-toggle. No sessions → stay closed.
  (async () => {
    try {
      const names = await ptyList();
      if (names.length && !_paneEnabled) {
        _paneEnabled = true;
        applyPaneClass();
        reconcile();
        for (const t of tabs.values()) if (t.term) t.fitAddon?.fit();
      }
    } catch (e) {
      // No tmux server running yet / hub not up — leave pane closed.
    }
  })();

  // Re-reconcile whenever the legend gets rebuilt (main.js's applyRoster mutates it).
  // Cheap signal: MutationObserver on the legend element.
  const legend = document.getElementById('legend');
  if (legend) {
    new MutationObserver(() => { if (paneEnabled()) reconcile(); })
      .observe(legend, { childList: true });
  }
})();
