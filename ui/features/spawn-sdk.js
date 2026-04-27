// spawn-sdk.js — modal handler for "+ SDK" agent registration.
// Spike v1: simple form (name, cwd, room) → POST /sdk/agents.
// No PTY allocation, no xterm tab.
//
// Depends on (declared earlier):
//   from state.js — SELECTED_ROOM, ROOM_ALL, tauriInvoke
//   from http.js  — authedFetch, parseErrorBody
//   from messages.js — addMessage

(function () {
  const btn        = document.getElementById('add-sdk-agent-btn');
  const modal      = document.getElementById('spawn-sdk-modal');
  const nameEl     = document.getElementById('spawn-sdk-name');
  const cwdEl      = document.getElementById('spawn-sdk-cwd');
  const cwdPickBtn = document.getElementById('spawn-sdk-cwd-pick');
  const roomEl     = document.getElementById('spawn-sdk-room');
  const cancelBtn  = document.getElementById('spawn-sdk-cancel');
  const submitBtn  = document.getElementById('spawn-sdk-submit');

  if (!btn || !modal) return;

  function open() {
    nameEl.value = '';
    cwdEl.value = '';
    // Default room: the currently-selected room when it's a concrete room,
    // otherwise empty (hub will fall back to its DEFAULT_ROOM).
    if (typeof SELECTED_ROOM !== 'undefined' && SELECTED_ROOM !== ROOM_ALL) {
      roomEl.value = SELECTED_ROOM;
    } else {
      roomEl.value = '';
    }
    modal.classList.add('open');
    setTimeout(() => nameEl.focus(), 0);
  }
  function close() { modal.classList.remove('open'); }

  btn.addEventListener('click', open);
  cancelBtn?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });

  // Reuse Tauri's directory picker (same plugin used by the tmux spawn modal).
  cwdPickBtn?.addEventListener('click', async () => {
    try {
      const res = await tauriInvoke('plugin:dialog|open', {
        options: { directory: true, multiple: false, recursive: false },
      });
      if (typeof res === 'string') cwdEl.value = res;
    } catch (e) {
      console.error('[spawn-sdk] cwd picker', e);
    }
  });

  submitBtn?.addEventListener('click', async () => {
    const name = nameEl.value.trim();
    const cwd  = cwdEl.value.trim();
    const room = roomEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    if (!cwd)  { cwdPickBtn?.focus(); return; }
    submitBtn.disabled = true;
    try {
      const r = await authedFetch('/sdk/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cwd, room: room || undefined }),
      });
      if (!r.ok) {
        const err = await parseErrorBody(r);
        addMessage({ from: 'system', to: 'you', text: `SDK register failed: ${err}`, ts: '' });
        submitBtn.disabled = false;
        return;
      }
      close();
    } catch (e) {
      addMessage({
        from: 'system',
        to: 'you',
        text: `SDK register error: ${e?.message ?? e}`,
        ts: '',
      });
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
