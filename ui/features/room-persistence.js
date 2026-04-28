// room-persistence.js — toggle + footprint for opt-in JSONL transcript per room.

(function () {
  const root = document.getElementById('room-persistence');
  const toggle = document.getElementById('rp-toggle-input');
  const meta = document.getElementById('rp-meta');
  const clearBtn = document.getElementById('rp-clear-btn');
  if (!root || !toggle || !meta || !clearBtn) return;

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  async function refresh() {
    if (typeof SELECTED_ROOM === 'undefined' || SELECTED_ROOM === ROOM_ALL) {
      root.style.display = 'none';
      return;
    }
    root.style.display = '';
    try {
      const r = await authedFetch(`/rooms/${encodeURIComponent(SELECTED_ROOM)}/settings`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const data = await r.json();
      toggle.checked = !!data.settings?.persist_transcript;
      if (toggle.checked && data.active) {
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
    }
  }

  toggle.addEventListener('change', async () => {
    if (typeof SELECTED_ROOM === 'undefined' || SELECTED_ROOM === ROOM_ALL) return;
    const desired = toggle.checked;
    try {
      const r = await authedFetch(`/rooms/${encodeURIComponent(SELECTED_ROOM)}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persist_transcript: desired }),
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
    } catch (e) {
      meta.textContent = `Error: ${e?.message || e}`;
      toggle.checked = !desired;
    }
    refresh();
  });

  clearBtn.addEventListener('click', async () => {
    if (typeof SELECTED_ROOM === 'undefined' || SELECTED_ROOM === ROOM_ALL) return;
    try {
      const t = await authedFetch(`/rooms/${encodeURIComponent(SELECTED_ROOM)}/transcripts`);
      const summary = t.ok ? await t.json() : null;
      const chunkCount = summary?.chunks?.length ?? 0;
      const totalBytes = summary?.totalBytes ?? 0;
      const ok = typeof askConfirm === 'function'
        ? await askConfirm(
            `Clear transcript for ${SELECTED_ROOM}?`,
            `This will delete the active file plus ${chunkCount} rotated chunk${chunkCount === 1 ? '' : 's'} (${fmtBytes(totalBytes)} total). Irreversible.`,
          )
        : confirm(`Delete ${chunkCount + 1} transcript files (${fmtBytes(totalBytes)})?`);
      if (!ok) return;
      const r = await authedFetch(`/rooms/${encodeURIComponent(SELECTED_ROOM)}/clear-transcript`, {
        method: 'POST',
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
    } catch (e) {
      meta.textContent = `Clear failed: ${e?.message || e}`;
      return;
    }
    refresh();
  });

  // Refresh whenever the selected room changes. rooms.js dispatches a custom
  // event after switching; fall back to a small interval if that's missing.
  document.addEventListener('a2a:room-filter', refresh);
  setTimeout(refresh, 500);
})();
