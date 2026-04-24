// Handoff card renderer — extracted from ui/main.js during v0.9.6 §6.
// Loaded AFTER main.js as a classic <script> so it shares main.js's lexical
// scope: handoffCards, messagesEl, trimMessages, escHtml, HUMAN_NAME,
// updateCountdownLabel, askReason, authedFetch, parseErrorBody, addMessage.

/* ── Handoff card rendering ──────────────────────────────── */
function renderHandoffCard(event) {
  const snapshot = event.snapshot || (() => {
    try { return JSON.parse(event.text || '{}'); } catch { return null; }
  })();
  if (!snapshot || !event.handoff_id) return;

  // Version reconciliation: discard stale broadcasts; log transitions for debugging.
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
    trimMessages();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function buildHandoffCardDom(snapshot, event) {
  const el = document.createElement('div');
  el.className = 'handoff-card';
  el._handoffId = snapshot.id;
  if (typeof snapshot.room === 'string' && snapshot.room) el.dataset.room = snapshot.room;
  updateHandoffCardDom(el, snapshot, event);
  return el;
}

function updateHandoffCardDom(el, snapshot, event) {
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
  } catch (e) {
    addMessage({ from: 'system', to: HUMAN_NAME, text: `Handoff ${action} error: ${e?.message ?? e}`, ts: '' });
  }
}
