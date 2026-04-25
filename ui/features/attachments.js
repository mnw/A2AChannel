// attachments.js — file upload via button / paste / drag-drop. Renders a
// chip in the attachment row showing upload progress + remove (×) action.
// Tier 2 of index.html.
//
// Depends on (declared earlier):
//   from state.js — pendingImageUrl (mutated), attachRow, attachBtn, fileInput,
//                   dropOverlay, input, IMAGE_EXT_RE, HUMAN_NAME
//   from http.js  — authedFetch, parseErrorBody, imgUrl
//   from messages.js — addMessage
//
// Exposes:
//   uploadAttachment, renderAttachment, clearAttachment

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) uploadAttachment(f);
  fileInput.value = '';
});

async function uploadAttachment(file) {
  renderAttachment(null, file.name, true);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await authedFetch('/upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await parseErrorBody(r));
    const { url } = await r.json();
    pendingImageUrl = url;
    renderAttachment(url, file.name, false);
  } catch (e) {
    clearAttachment();
    addMessage({ from: 'system', to: HUMAN_NAME, text: `Upload failed: ${e?.message ?? e}`, ts: '' });
  }
}

function renderAttachment(url, name, loading) {
  attachRow.innerHTML = '';
  const chip = document.createElement('div');
  chip.className = 'attachment-chip';
  if (url) {
    if (IMAGE_EXT_RE.test(url)) {
      const img = document.createElement('img');
      img.src = imgUrl(url);
      chip.appendChild(img);
    } else {
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot + 1).toUpperCase() : 'FILE';
      const badge = document.createElement('span');
      badge.className = 'attachment-link-ext';
      badge.textContent = ext;
      chip.appendChild(badge);
    }
  }
  const label = document.createElement('span');
  label.textContent = loading ? `uploading ${name}…` : name;
  chip.appendChild(label);
  if (!loading) {
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', clearAttachment);
    chip.appendChild(x);
  }
  attachRow.appendChild(chip);
}

function clearAttachment() {
  pendingImageUrl = null;
  attachRow.innerHTML = '';
}

// ── Paste from clipboard (any file) ─────────────────────────
input.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); uploadAttachment(f); return; }
    }
  }
});

// ── Drag-and-drop (any file) ────────────────────────────────
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  dropOverlay.classList.add('visible');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.classList.remove('visible');
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('visible');
  const f = e.dataTransfer?.files?.[0];
  if (f) uploadAttachment(f);
});
