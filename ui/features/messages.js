// messages.js — chat-row rendering, attachments, image zoom, copy affordances, DOM trim.

function addMessage(data) {
  const from = data.from || 'system';
  if (lastFrom && lastFrom !== from) {
    const sep = document.createElement('div');
    sep.className = 'sep';
    messagesEl.appendChild(sep);
  }
  lastFrom = from;

  const div = document.createElement('div');
  const cls = from === 'you' || from === 'system' ? `from-${from}` : `from-${cssName(from)}`;
  div.className = `msg ${cls}`;
  // Untagged rows stay visible everywhere; CSS only hides tagged non-matches.
  if (typeof data.room === 'string' && data.room) div.dataset.room = data.room;

  const displayName = NAMES[from] || from;
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = (displayName[0] || '?').toUpperCase();
  if (from === 'you') avatar.style.background = 'var(--orange)';
  else if (from === 'system') avatar.style.background = 'var(--red)';
  else if (COLORS[from]) avatar.style.background = COLORS[from];
  div.appendChild(avatar);

  const content = document.createElement('div');
  content.className = 'msg-content';

  const header = document.createElement('div');
  header.className = 'msg-header';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'msg-name';
  nameSpan.textContent = displayName;
  if (from !== 'you' && from !== 'system' && COLORS[from]) {
    nameSpan.style.color = COLORS[from];
  }
  header.appendChild(nameSpan);
  const tsSpan = document.createElement('span');
  tsSpan.className = 'msg-ts';
  tsSpan.textContent = data.ts || '';
  header.appendChild(tsSpan);
  if (data.to && data.to !== 'all' && data.to !== from) {
    const toSpan = document.createElement('span');
    toSpan.className = 'msg-to';
    toSpan.textContent = '→ ' + (NAMES[data.to] || data.to);
    header.appendChild(toSpan);
  }
  content.appendChild(header);

  // Safe innerHTML: renderChatMarkdown escapes prose and code; linkify runs on prose only.
  const safeAttachment = data.image && isSafeAttachmentSrc(data.image) ? data.image : null;
  const attachmentHtml = safeAttachment ? renderAttachmentHtml(safeAttachment) : '';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = renderChatMarkdown(data.text || '') + attachmentHtml;

  // Copy buttons (top + bottom) on agent messages only; hover-only.
  if (from !== 'you' && from !== 'system') {
    const copyText = data.text || '';
    for (const pos of ['top', 'bottom']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `msg-copy-btn msg-copy-${pos}`;
      btn.title = 'Copy message';
      btn.setAttribute('aria-label', 'Copy message');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
        '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(copyText).then(
          () => showCopyToast('Copied'),
          () => showCopyToast('Copy failed'),
        );
      });
      body.appendChild(btn);
    }
  }

  content.appendChild(body);

  div.appendChild(content);
  messagesEl.appendChild(div);
  trimMessages();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function isSafeAttachmentSrc(u) {
  if (typeof u !== 'string' || !u) return false;
  return ATTACHMENT_URL_RE.test(u) || /^https?:\/\//.test(u);
}

function renderAttachmentHtml(url) {
  const safeUrl = escAttr(imgUrl(url));
  if (IMAGE_EXT_RE.test(url)) {
    return `<img src="${safeUrl}" alt="attachment" data-zoomable="1" />`;
  }
  const filename = url.split('/').pop() || 'attachment';
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toUpperCase() : 'FILE';
  return `<a class="attachment-link" href="${safeUrl}" target="_blank" rel="noopener" download>` +
         `<span class="attachment-link-ext">${escHtml(ext)}</span>` +
         `<span class="attachment-link-name">${escHtml(filename)}</span>` +
         `</a>`;
}

messagesEl.addEventListener('click', (e) => {
  const img = e.target.closest?.('.msg-body img[data-zoomable]');
  if (!img) return;
  const src = img.getAttribute('src') || '';
  if (!/^https?:\/\//.test(src) && !src.startsWith(BUS + '/image/')) return;
  window.open(src, '_blank', 'noopener');
});

// Rapid clicks extend the visible window rather than stacking toasts.
const copyToastEl = document.getElementById('copy-toast');
let _copyToastTimer = 0;
function showCopyToast(msg) {
  if (!copyToastEl) return;
  if (msg) copyToastEl.textContent = msg;
  copyToastEl.classList.add('visible');
  clearTimeout(_copyToastTimer);
  _copyToastTimer = setTimeout(() => copyToastEl.classList.remove('visible'), 1400);
}
window.showCopyToast = showCopyToast;

messagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.msg-link-copy');
  if (!btn) return;
  e.preventDefault();
  const href = btn.dataset.href;
  if (!href) return;
  const flashCopied = () => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1000);
    showCopyToast('Link copied');
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(href).then(flashCopied).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = href;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
      flashCopied();
    });
  } else {
    const ta = document.createElement('textarea');
    ta.value = href;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    flashCopied();
  }
});

// Skip persistent #permission-stack; deleting it would break subsequent pending cards.
function trimMessages() {
  const stack = document.getElementById('permission-stack');
  while (messagesEl.childElementCount > MESSAGE_DOM_LIMIT) {
    let target = messagesEl.firstChild;
    if (target === stack) target = stack.nextSibling;
    if (!target) break;
    if (target._permissionId) permissionCards.delete(target._permissionId);
    if (target._interruptId) interruptCards.delete(target._interruptId);
    if (target._handoffId) handoffCards.delete(target._handoffId);
    messagesEl.removeChild(target);
  }
}
