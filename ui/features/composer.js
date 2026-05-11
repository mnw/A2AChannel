// composer.js — input wiring. `detectIntent` is a pure SendIntent discriminator; send() dispatches on intent.mode.

const slashErrorEl = document.getElementById('slash-error');

function _showSlashError(msg) {
  if (!slashErrorEl) return;
  slashErrorEl.textContent = msg;
  slashErrorEl.hidden = false;
}
function _hideSlashError() {
  if (!slashErrorEl) return;
  slashErrorEl.textContent = '';
  slashErrorEl.hidden = true;
}

// Pure snapshot of composer state — sole input to detectIntent.
function captureComposerSnapshot() {
  return {
    text: input.value,
    image: pendingImageUrl,
    room: SELECTED_ROOM,
    targetMode: targetEl.value || 'auto',
  };
}

// Returns a discriminated SendIntent. MUST stay DOM-free — callers drive side effects from the discriminator.
function detectIntent(snap) {
  const { text, image, room, targetMode } = snap;

  if (isSlashMode(text)) {
    if (room === ROOM_ALL) {
      return { mode: 'slash', room, validationError: 'no-room' };
    }
    const parsed = parseSlashMessage(text);
    if (!parsed.slashCommand) return { mode: 'slash', room, validationError: 'incomplete' };
    if (!parsed.target) return { mode: 'slash', room, validationError: 'no-target' };
    return { mode: 'slash', room, parsed };
  }

  if (isShiftTabMode(text)) {
    if (room === ROOM_ALL) {
      return { mode: 'shift-tab', room, validationError: 'no-room' };
    }
    const parsed = parseShiftTab(text);
    if (!parsed.target) return { mode: 'shift-tab', room, validationError: 'no-target' };
    return { mode: 'shift-tab', room, parsed };
  }

  if (targetMode.startsWith('!')) {
    const toAgent = targetMode.slice(1);
    if (!text) return { mode: 'interrupt', toAgent, text: '', hasImage: Boolean(image), validationError: 'no-text' };
    if (text.length > 500) {
      return { mode: 'interrupt', toAgent, text, hasImage: Boolean(image), validationError: 'too-long' };
    }
    return { mode: 'interrupt', toAgent, text, hasImage: Boolean(image) };
  }

  if (!text && !image) return { mode: 'chat', text: '', image: null, targetMode, room, mentions: [], validationError: 'empty' };
  const mentions = parseMentions(text);
  return { mode: 'chat', text, image, targetMode, room, mentions };
}

function _refreshSlashState() {
  const intent = detectIntent(captureComposerSnapshot());

  if (intent.mode !== 'slash') {
    if (slashPickerActive()) slashPickerClose();
    _hideSlashError();
    sendBtn.disabled = false;
    return;
  }

  if (!slashPickerActive()) slashPickerOpen();
  else slashPickerUpdate();

  if (intent.validationError === 'no-room') {
    _showSlashError('Select a room first');
    sendBtn.disabled = true;
    return;
  }
  if (intent.validationError === 'incomplete') {
    _hideSlashError();
    sendBtn.disabled = true;
    return;
  }
  if (intent.validationError === 'no-target') {
    _showSlashError('specify @agent or @all');
    sendBtn.disabled = true;
    return;
  }
  _hideSlashError();
  sendBtn.disabled = false;
}

async function send() {
  const intent = detectIntent(captureComposerSnapshot());
  switch (intent.mode) {
    case 'slash':
      return _dispatchSlash(intent);
    case 'shift-tab':
      return _dispatchShiftTab(intent);
    case 'interrupt':
      return _dispatchInterrupt(intent);
    case 'chat':
      return _dispatchChat(intent);
  }
}

async function _dispatchSlash(intent) {
  if (intent.validationError) return;
  sendBtn.disabled = true;
  try {
    const ok = await sendSlash(intent.parsed);
    if (ok) {
      input.value = '';
      autoGrow();
      slashPickerClose();
      _hideSlashError();
    }
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

async function _dispatchShiftTab(intent) {
  if (intent.validationError === 'no-room') {
    _showSlashError('Select a room first');
    return;
  }
  if (intent.validationError === 'no-target') {
    _showSlashError('specify @agent or @all');
    return;
  }
  sendBtn.disabled = true;
  try {
    const ok = await sendShiftTab(intent.parsed);
    if (ok) {
      input.value = '';
      autoGrow();
      _hideSlashError();
    }
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

async function _dispatchInterrupt(intent) {
  if (intent.validationError === 'no-text') {
    addMessage({ from: 'system', to: HUMAN_NAME, text: 'Interrupt text required.', ts: '' });
    return;
  }
  if (intent.validationError === 'too-long') {
    addMessage({ from: 'system', to: HUMAN_NAME, text: 'Interrupt text must be 500 chars or fewer.', ts: '' });
    return;
  }
  if (intent.hasImage) {
    addMessage({ from: 'system', to: HUMAN_NAME, text: 'Attachments not supported on interrupts (dropped).', ts: '' });
  }
  sendBtn.disabled = true;
  input.value = '';
  autoGrow();
  clearAttachment();
  hideMentionPopover();
  try {
    const r = await authedFetch('/interrupts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: HUMAN_NAME, to: intent.toAgent, text: intent.text }),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Interrupt failed: ${err}`, ts: '' });
    }
  } catch (e) {
    addMessage({ from: 'system', to: HUMAN_NAME, text: `Interrupt error: ${e?.message ?? e}`, ts: '' });
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

async function _dispatchChat(intent) {
  if (intent.validationError === 'empty') return;

  let body = { text: intent.text, image: intent.image };
  if (intent.targetMode === 'auto') {
    if (intent.mentions.length) body.targets = intent.mentions;
    else body.target = 'all';
  } else {
    body.target = intent.targetMode;
  }
  if ((body.target === 'all' || (Array.isArray(body.targets) && body.targets.length === 0))
      && intent.room !== ROOM_ALL) {
    body.room = intent.room;
  }

  sendBtn.disabled = true;
  input.value = '';
  autoGrow();
  clearAttachment();
  hideMentionPopover();
  try {
    const r = await authedFetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      const msg = r.status === 401
        ? `Send failed: auth out of sync — did A2AChannel restart? (${err})`
        : `Send failed: ${err}`;
      addMessage({ from: 'system', to: 'you', text: msg, ts: '' });
    }
  } catch (e) {
    addMessage({ from: 'system', to: 'you', text: `Could not reach bus: ${e?.message ?? e}`, ts: '' });
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

input.addEventListener('keydown', (e) => {
  const mentionOpen = mentionPop.classList.contains('open');
  const slashOpen   = slashPickerActive();
  if (mentionOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionActive = (mentionActive + 1) % mentionMatches.length; renderMentionPopover(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); mentionActive = (mentionActive - 1 + mentionMatches.length) % mentionMatches.length; renderMentionPopover(); return; }
    if (e.key === 'Escape')    { e.preventDefault(); hideMentionPopover(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (mentionMatches.length) { e.preventDefault(); selectMention(mentionMatches[mentionActive]); return; }
    }
  } else if (slashOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashPickerMove(1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); slashPickerMove(-1); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      slashPickerClose();
      _hideSlashError();
      input.value = '';
      autoGrow();
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); slashPickerSelectActive(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    send();
    return;
  }
  // Shift+Tab broadcasts `\x1B[Z` to all live agents in current room; modifier-free Tab is unchanged.
  if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (SELECTED_ROOM === ROOM_ALL) {
      _showSlashError('Select a room first');
      e.preventDefault();
      return;
    }
    e.preventDefault();
    sendShiftTab({ target: 'all' }).catch(() => {});
    return;
  }
});

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}
input.addEventListener('input', () => { autoGrow(); updateMentionPopover(); _refreshSlashState(); });
input.addEventListener('click', updateMentionPopover);
input.addEventListener('blur', () => setTimeout(() => { hideMentionPopover(); slashPickerClose(); }, 150));

sendBtn.addEventListener('click', () => send());

window.detectIntent = detectIntent;
window.captureComposerSnapshot = captureComposerSnapshot;
