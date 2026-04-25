// nutshell.js — per-room project-summary strip + editor + handoff-card
// countdown ticker. Tier 2 of index.html.
//
// Nutshell is per-room: an SSE update for room X stores into nutshellByRoom[X];
// only the currently-selected room renders. Edits flow through the handoff
// primitive — the hub's accept path detects the "[nutshell]" task prefix.
//
// The countdown ticker lives here too because it's a sibling concern of
// "ambient room context" — it reads from handoffCards (the global shared
// map declared in state.js) and updates each pending card's "Xm Ys left"
// label once per second. Could move to messages.js or its own file later.
//
// Depends on (declared earlier):
//   from state.js — SELECTED_ROOM, ROOM_ALL, HUMAN_NAME, handoffCards, NAMES
//   from http.js  — authedFetch, parseErrorBody
//   from messages.js — addMessage
//
// Exposes:
//   applyNutshell, renderNutshell, currentNutshell,
//   openNutshellEditor, closeNutshellEditor, submitNutshellProposal,
//   updateCountdownLabel

const nutshellEl        = document.getElementById('nutshell');
const nutshellBodyEl    = document.getElementById('nutshell-body');
const nutshellMetaEl    = document.getElementById('nutshell-meta');
const nutshellEditBtn   = document.getElementById('nutshell-edit-btn');
const nutshellEditor    = document.getElementById('nutshell-editor');
const nutshellTextarea  = document.getElementById('nutshell-editor-textarea');
const nutshellSubmit    = document.getElementById('nutshell-editor-submit');
const nutshellCancel    = document.getElementById('nutshell-editor-cancel');
const nutshellByRoom = new Map(); // room -> { text, version, updated_at_ms, updated_by }
const EMPTY_NUTSHELL = { text: '', version: 0, updated_at_ms: 0, updated_by: null };

function currentNutshell() {
  if (SELECTED_ROOM === ROOM_ALL) return null;
  return nutshellByRoom.get(SELECTED_ROOM) ?? EMPTY_NUTSHELL;
}

function applyNutshell(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  // Hub always returns a `room` field in v0.9+. Fall back defensively if missing
  // (e.g. during a mid-rollout downgrade), storing under "default".
  const room = (typeof snapshot.room === 'string' && snapshot.room) ? snapshot.room : 'default';
  nutshellByRoom.set(room, {
    text: snapshot.text ?? '',
    version: snapshot.version ?? 0,
    updated_at_ms: snapshot.updated_at_ms ?? 0,
    updated_by: snapshot.updated_by ?? null,
  });
  // Only re-render if the update is for the currently-viewed room.
  if (SELECTED_ROOM === room) {
    renderNutshell();
    nutshellEl.classList.add('flash');
    setTimeout(() => nutshellEl.classList.remove('flash'), 1400);
  }
}

const NUTSHELL_PREVIEW_MAX = 125;

function renderNutshell() {
  nutshellEl.style.display = 'flex';
  if (SELECTED_ROOM === ROOM_ALL) {
    nutshellBodyEl.textContent = 'Select a room to see its summary.';
    nutshellBodyEl.classList.add('empty');
    nutshellBodyEl.removeAttribute('title');
    nutshellMetaEl.textContent = '';
    if (nutshellEditBtn) nutshellEditBtn.disabled = true;
    return;
  }
  if (nutshellEditBtn) nutshellEditBtn.disabled = false;
  const snap = nutshellByRoom.get(SELECTED_ROOM) ?? EMPTY_NUTSHELL;
  const txt = (snap.text ?? '').trim();
  if (!txt) {
    nutshellBodyEl.textContent = `No summary for #${SELECTED_ROOM} yet — agents or the human can propose one.`;
    nutshellBodyEl.classList.add('empty');
    nutshellBodyEl.removeAttribute('title');
  } else {
    const preview = txt.length > NUTSHELL_PREVIEW_MAX
      ? txt.slice(0, NUTSHELL_PREVIEW_MAX).trimEnd() + '…'
      : txt;
    nutshellBodyEl.textContent = preview;
    nutshellBodyEl.classList.remove('empty');
    nutshellBodyEl.title = txt;
  }
  if (snap.version > 0) {
    const who = snap.updated_by || 'system';
    nutshellMetaEl.textContent = `#${SELECTED_ROOM} · v${snap.version} · by ${who}`;
  } else {
    nutshellMetaEl.textContent = `#${SELECTED_ROOM}`;
  }
}

function openNutshellEditor() {
  const snap = currentNutshell();
  nutshellTextarea.value = snap?.text || '';
  nutshellEditor.classList.add('open');
  nutshellTextarea.focus();
  nutshellTextarea.select();
}

function closeNutshellEditor() {
  nutshellEditor.classList.remove('open');
}

async function submitNutshellProposal() {
  if (SELECTED_ROOM === ROOM_ALL) {
    addMessage({ from: 'system', to: HUMAN_NAME, text: 'Select a room before editing its nutshell.', ts: '' });
    closeNutshellEditor();
    return;
  }
  const patch = nutshellTextarea.value.trim();
  const current = currentNutshell();
  if (patch === ((current?.text || '').trim())) {
    closeNutshellEditor();
    return;
  }
  nutshellSubmit.disabled = true;
  try {
    // Nutshell edits flow through the handoff primitive — the accept path detects
    // the "[nutshell]" task prefix and applies context.patch atomically. `context.room`
    // tells the hub which room's nutshell to update (human is super-user so any room is ok).
    const r = await authedFetch('/handoffs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: HUMAN_NAME,
        to: HUMAN_NAME,
        task: '[nutshell] human edit',
        context: { patch, room: SELECTED_ROOM },
        ttl_seconds: 3600,
      }),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Nutshell proposal failed: ${err}`, ts: '' });
    } else {
      // Human is both sender and recipient — auto-accept to skip the confirmation step.
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

// ── Countdown ticker for pending handoff cards ("Nm Ss left").
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
  if (handoffCards.size === 0) return;
  for (const { element } of handoffCards.values()) {
    if (element.classList.contains('status-pending')) {
      updateCountdownLabel(element);
    }
  }
}, 1000);
