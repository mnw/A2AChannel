// Interrupt card renderer — extracted from ui/main.js during v0.9.6 §6.
// Loaded AFTER main.js as a classic <script>; shares main.js lexical scope.

/* ── Interrupt cards ─────────────────────────────────────── */
// interruptCards map lives in main.js alongside the other kinds' state maps
// so cross-kind utilities (trimMessages, cleanup) can access all three.

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
    // Pending interrupts sticky to top; acknowledged ones flow in line.
    if (snapshot.status === 'pending') {
      messagesEl.insertBefore(el, messagesEl.firstChild);
    } else {
      messagesEl.appendChild(el);
    }
    interruptCards.set(event.interrupt_id, {
      element: el, version: incomingVersion, status: snapshot.status, snapshot,
    });
    trimMessages();
    if (snapshot.status !== 'pending') messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function buildInterruptCardDom(snapshot, event) {
  const el = document.createElement('div');
  el.className = 'interrupt-card';
  el._interruptId = snapshot.id;
  if (typeof snapshot.room === 'string' && snapshot.room) el.dataset.room = snapshot.room;
  updateInterruptCardDom(el, snapshot, event);
  return el;
}

function updateInterruptCardDom(el, snapshot, event) {
  el.className = 'interrupt-card';
  el.classList.add(`status-${snapshot.status}`);
  const replayBadge = event.replay === true || event.replay === 'true'
    ? `<span class="interrupt-replay-badge">(replay)</span>` : '';
  const isRecipient = snapshot.to_agent === HUMAN_NAME;
  const actionsHtml = snapshot.status === 'pending'
    ? `<div class="interrupt-actions">
         <button type="button" data-action="ack">${isRecipient ? 'Acknowledge' : 'Acknowledge (on behalf)'}</button>
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
