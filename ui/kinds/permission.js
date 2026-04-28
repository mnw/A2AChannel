// Permission card renderer — extracted from ui/main.js during v0.9.6 §6.
// Loaded AFTER main.js as a classic <script>; shares main.js lexical scope.
// trimMessages stays in main.js since it spans all three kinds' state maps.

// Single sticky container that holds every currently-pending permission card.
// Only this element is position:sticky — individual cards inside it are plain
// flow children so they stack vertically instead of piling at top:0.
function getPermissionStack() {
  let stack = document.getElementById('permission-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'permission-stack';
    messagesEl.insertBefore(stack, messagesEl.firstChild);
  } else if (stack !== messagesEl.firstChild) {
    // Keep it pinned as the first child so sticky anchors to the top edge.
    messagesEl.insertBefore(stack, messagesEl.firstChild);
  }
  return stack;
}

function renderPermissionCard(event) {
  const snapshot = event.snapshot || (() => {
    try { return JSON.parse(event.text || '{}'); } catch { return null; }
  })();
  if (!snapshot || !event.permission_id) return;

  const existing = permissionCards.get(event.permission_id);
  const incomingVersion = Number(event.version ?? snapshot.version ?? 0);
  if (existing && existing.version >= incomingVersion) return;

  if (existing) {
    updatePermissionCardDom(existing.element, snapshot, event);
    // Pending → resolved: leave the sticky stack, drop into chronological slot.
    if (existing.status === 'pending' && snapshot.status !== 'pending') {
      existing.element.remove();
      messagesEl.appendChild(existing.element);
      if (typeof permissionScraperUnwatch === 'function') {
        permissionScraperUnwatch(event.permission_id);
      }
    }
    existing.version = incomingVersion;
    existing.status = snapshot.status;
    existing.snapshot = snapshot;
  } else {
    const el = buildPermissionCardDom(snapshot, event);
    if (snapshot.status === 'pending') {
      getPermissionStack().appendChild(el);
      if (typeof permissionScraperWatch === 'function') {
        permissionScraperWatch(
          event.permission_id, snapshot.agent, snapshot.room, snapshot.tool_name,
        );
      }
    } else {
      messagesEl.appendChild(el);
    }
    permissionCards.set(event.permission_id, {
      element: el, version: incomingVersion, status: snapshot.status, snapshot,
    });
    trimMessages();
    if (snapshot.status !== 'pending') messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function buildPermissionCardDom(snapshot, event) {
  const el = document.createElement('div');
  el.className = 'permission-card';
  el._permissionId = snapshot.id;
  if (typeof snapshot.room === 'string' && snapshot.room) el.dataset.room = snapshot.room;
  updatePermissionCardDom(el, snapshot, event);
  return el;
}

function updatePermissionCardDom(el, snapshot, event) {
  el.className = 'permission-card';
  el.classList.add(`status-${snapshot.status}`);
  const replayBadge = event.replay === true || event.replay === 'true'
    ? `<span class="permission-replay-badge">(replay)</span>` : '';
  const preview = String(snapshot.input_preview ?? '');
  const previewHtml = preview
    ? `<details class="permission-preview-details">
         <summary>input</summary>
         <pre class="permission-input-preview">${escHtml(preview)}</pre>
       </details>`
    : '';
  let metaSuffix = '';
  if (snapshot.resolved_by) {
    if (snapshot.status === 'dismissed') {
      const dismisser = snapshot.dismissed_by_scraper || event.by === 'scraper'
        ? 'auto-dismissed'
        : `dismissed by ${escHtml(snapshot.resolved_by)}`;
      metaSuffix = ` · ${dismisser}`;
      if (snapshot.snapshot_path) {
        metaSuffix += ` · <a class="permission-snapshot-link" href="#" data-perm-id="${escHtml(snapshot.id)}">view snapshot</a>`;
      }
    } else {
      metaSuffix = ` · ${escHtml(snapshot.behavior === 'allow' ? 'allowed' : 'denied')} by ${escHtml(snapshot.resolved_by)}`;
    }
  }
  const showActions = snapshot.status === 'pending';
  const actionsHtml = showActions
    ? `<div class="permission-actions">
         <button type="button" class="allow" data-action="allow">Allow</button>
         <button type="button" class="deny"  data-action="deny">Deny</button>
       </div>`
    : '';
  const dismissHtml = showActions
    ? `<button type="button" class="permission-dismiss" title="Dismiss — clears the card without recording an allow/deny verdict. Use when the xterm already answered this prompt." aria-label="Dismiss">×</button>`
    : '';
  el.innerHTML = `
    <div class="permission-header">
      <span class="route">⛔ Approval — ${escHtml(snapshot.agent)} · ${escHtml(snapshot.tool_name)}</span>
      <span class="status-badge">${escHtml(snapshot.status)}</span>
      ${replayBadge}
      ${dismissHtml}
    </div>
    <div class="permission-description">${escHtml(snapshot.description || '(no description)')}</div>
    ${previewHtml}
    <div class="permission-meta">${escHtml(snapshot.id)}${metaSuffix}</div>
    ${actionsHtml}
  `;
  el.querySelectorAll('.permission-actions button').forEach((btn) => {
    btn.addEventListener('click', () => handlePermissionAction(snapshot.id, btn.dataset.action));
  });
  const dismissBtn = el.querySelector('.permission-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => handlePermissionDismiss(snapshot.id));
  }
  const snapLink = el.querySelector('.permission-snapshot-link');
  if (snapLink) {
    snapLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      handlePermissionSnapshotView(snapLink.dataset.permId);
    });
  }
}

async function handlePermissionSnapshotView(id) {
  try {
    const r = await authedFetch(`/permissions/${encodeURIComponent(id)}/snapshot`);
    if (!r.ok) {
      const err = await parseErrorBody(r);
      alert(`Snapshot unavailable: ${err}`);
      return;
    }
    const text = await r.text();
    // Quick-and-dirty modal — re-uses the existing nutshell-editor box style.
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999;' +
      'display:flex; align-items:center; justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText =
      'background:var(--bg); border:var(--border-1) solid var(--line);' +
      'border-radius:var(--radius-md); padding:var(--sp-16); max-width:80vw;' +
      'max-height:80vh; overflow:auto; font-family:var(--mono); font-size:var(--fs-sm);';
    box.innerHTML =
      `<div style="margin-bottom:var(--sp-8); color:var(--text-dim); font-size:var(--fs-2xs);">` +
      `Captured pane bytes used by the scraper to confirm dialog absence. ` +
      `May contain secrets visible at the time of capture.</div>` +
      `<pre style="white-space:pre-wrap; margin:0;">${escHtml(text)}</pre>`;
    overlay.appendChild(box);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  } catch (e) {
    alert(`Snapshot fetch error: ${e?.message ?? e}`);
  }
}

async function handlePermissionAction(id, behavior) {
  if (behavior !== 'allow' && behavior !== 'deny') return;
  try {
    const r = await authedFetch(`/permissions/${encodeURIComponent(id)}/verdict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: HUMAN_NAME, behavior }),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Permission ${behavior} failed: ${err}`, ts: '' });
    }
  } catch (e) {
    addMessage({ from: 'system', to: HUMAN_NAME, text: `Permission ${behavior} error: ${e?.message ?? e}`, ts: '' });
  }
}

async function handlePermissionDismiss(id) {
  try {
    const r = await authedFetch(`/permissions/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: HUMAN_NAME }),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Permission dismiss failed: ${err}`, ts: '' });
    }
  } catch (e) {
    addMessage({ from: 'system', to: HUMAN_NAME, text: `Permission dismiss error: ${e?.message ?? e}`, ts: '' });
  }
}
