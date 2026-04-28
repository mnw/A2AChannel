// room-persistence.js — toggle + footprint for opt-in JSONL transcript per room.

(function () {
  const root = document.getElementById('room-persistence');
  const toggle = document.getElementById('rp-toggle-input');
  const meta = document.getElementById('rp-meta');
  const clearBtn = document.getElementById('rp-clear-btn');
  if (!root || !toggle || !meta || !clearBtn) {
    console.warn('[room-persistence] required elements missing', { root, toggle, meta, clearBtn });
    return;
  }
  console.log('[room-persistence] initialised');

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function isOn() { return toggle.getAttribute('aria-pressed') === 'true'; }
  function setOn(on) { toggle.setAttribute('aria-pressed', on ? 'true' : 'false'); }

  // Always-visible row. When in "All rooms" the toggle is disabled with a hint;
  // user must pick a concrete room before the API calls make sense.
  function inAllRooms() {
    return typeof SELECTED_ROOM === 'undefined' || SELECTED_ROOM === ROOM_ALL;
  }

  async function refresh() {
    root.style.display = '';
    if (inAllRooms()) {
      toggle.disabled = true;
      toggle.style.opacity = '0.5';
      setOn(false);
      meta.textContent = 'Pick a single room to enable';
      clearBtn.style.display = 'none';
      return;
    }
    toggle.disabled = false;
    toggle.style.opacity = '';
    try {
      const r = await authedFetch(`/rooms/${encodeURIComponent(SELECTED_ROOM)}/settings`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const data = await r.json();
      const on = !!data.settings?.persist_transcript;
      setOn(on);
      if (on && data.active) {
        const chunks = data.chunks || [];
        const totalChunkBytes = chunks.reduce((s, c) => s + (c.sizeBytes || 0), 0);
        meta.textContent =
          `Active: ${data.active.lines} lines (${fmtBytes(data.active.sizeBytes)}) · ` +
          `${chunks.length} rotated chunk${chunks.length === 1 ? '' : 's'} (${fmtBytes(totalChunkBytes)})`;
        clearBtn.style.display = '';
      } else {
        meta.textContent = 'Off — chat history resets on hub restart';
        clearBtn.style.display = 'none';
      }
    } catch (e) {
      meta.textContent = `Error: ${e?.message || e}`;
      clearBtn.style.display = 'none';
      console.error('[room-persistence] refresh failed', e);
    }
  }

  toggle.addEventListener('click', async (e) => {
    console.log('[room-persistence] toggle clicked, SELECTED_ROOM=', SELECTED_ROOM);
    if (inAllRooms()) return;
    const desired = !isOn();
    setOn(desired);
    try {
      const r = await authedFetch(`/rooms/${encodeURIComponent(SELECTED_ROOM)}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persist_transcript: desired }),
      });
      console.log('[room-persistence] PUT response', r.status);
      if (!r.ok) throw new Error(`status ${r.status}`);
    } catch (err) {
      meta.textContent = `Error: ${err?.message || err}`;
      console.error('[room-persistence] toggle failed', err);
      setOn(!desired);
    }
    refresh();
  });

  clearBtn.addEventListener('click', async () => {
    if (typeof SELECTED_ROOM === 'undefined' || SELECTED_ROOM === ROOM_ALL) return;
    try {
      const t = await authedFetch(`/rooms/${encodeURIComponent(SELECTED_ROOM)}/transcripts`);
      const summary = t.ok ? await t.json() : null;
      const lines = summary?.active?.lines ?? 0;
      const sizeBytes = summary?.active?.sizeBytes ?? 0;
      const ok = typeof askConfirm === 'function'
        ? await askConfirm(
            `Archive transcript for ${SELECTED_ROOM}?`,
            `The active transcript (${lines} lines, ${fmtBytes(sizeBytes)}) will be archived to a rotated chunk. Chat history on disk is preserved; the chat window resets; agents will see fresh context on next reconnect.`,
          )
        : confirm(`Archive ${lines} lines (${fmtBytes(sizeBytes)}) and start fresh?`);
      if (!ok) return;
      const r = await authedFetch(`/rooms/${encodeURIComponent(SELECTED_ROOM)}/clear-transcript`, {
        method: 'POST',
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
    } catch (e) {
      meta.textContent = `Archive failed: ${e?.message || e}`;
      return;
    }
    refresh();
  });

  // Refresh whenever the selected room changes. rooms.js dispatches a custom
  // event after switching; fall back to a small interval if that's missing.
  document.addEventListener('a2a:room-filter', refresh);
  setTimeout(refresh, 500);
})();
