// composer.js — input wiring: send (chat + interrupt + slash + shift-tab),
// autoGrow, key handling.
//
// Send mode is an explicit discriminated value (SendIntent), not an emergent
// property of DOM state. `detectIntent` is a pure function of an input
// snapshot; `send()` dispatches once on `intent.mode`. The four modes:
//
//   { mode: "slash",     parsed: {slashCommand, target, args}, room }     → pty_write
//   { mode: "shift-tab", parsed: {target}, room }                          → pty_write \x1B[Z
//   { mode: "interrupt", toAgent, text, hasImage }                         → POST /interrupts
//   { mode: "chat",      text, image, targetMode, room, mentions }         → POST /send
//
// `detectIntent` MUST NOT touch the DOM — no `sendBtn.disabled`, no
// `input.value` mutation, no `slashPickerOpen/Close`. Callers (send,
// _refreshSlashState) drive the side effects from the discriminator.

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

// ─── SendIntent: pure-function mode detection ─────────────────────────

/**
 * Capture the current composer input state as a plain object. The output is the
 * sole input to `detectIntent` — making detectIntent testable without mounting
 * the DOM, and ensuring intent is decided from a single snapshot rather than
 * re-read across the send flow.
 */
function captureComposerSnapshot() {
  return {
    text: input.value,
    image: pendingImageUrl,
    room: SELECTED_ROOM,
    targetMode: targetEl.value || 'auto',
  };
}

/**
 * Pure function: returns a discriminated SendIntent from a snapshot. Each
 * returned shape carries everything the matching dispatch branch needs;
 * `validationError` is set when the input is malformed for the detected mode
 * (caller surfaces the error message; does not flip modes).
 *
 *   { mode: "slash", room, parsed?, validationError? }
 *   { mode: "shift-tab", room, parsed?, validationError? }
 *   { mode: "interrupt", toAgent, text, hasImage, validationError? }
 *   { mode: "chat", text, image, targetMode, room, mentions, validationError? }
 */
function detectIntent(snap) {
  const { text, image, room, targetMode } = snap;

  // Slash mode — `/<command> @<target> <args>`
  if (isSlashMode(text)) {
    if (room === ROOM_ALL) {
      return { mode: 'slash', room, validationError: 'no-room' };
    }
    const parsed = parseSlashMessage(text);
    if (!parsed.slashCommand) return { mode: 'slash', room, validationError: 'incomplete' };
    if (!parsed.target) return { mode: 'slash', room, validationError: 'no-target' };
    return { mode: 'slash', room, parsed };
  }

  // Shift+Tab mode — `\<target>` (compose form for the \x1B[Z send key)
  if (isShiftTabMode(text)) {
    if (room === ROOM_ALL) {
      return { mode: 'shift-tab', room, validationError: 'no-room' };
    }
    const parsed = parseShiftTab(text);
    if (!parsed.target) return { mode: 'shift-tab', room, validationError: 'no-target' };
    return { mode: 'shift-tab', room, parsed };
  }

  // Interrupt mode — target selector prefixed with `!`
  if (targetMode.startsWith('!')) {
    const toAgent = targetMode.slice(1);
    if (!text) return { mode: 'interrupt', toAgent, text: '', hasImage: Boolean(image), validationError: 'no-text' };
    if (text.length > 500) {
      return { mode: 'interrupt', toAgent, text, hasImage: Boolean(image), validationError: 'too-long' };
    }
    return { mode: 'interrupt', toAgent, text, hasImage: Boolean(image) };
  }

  // Chat mode — default
  if (!text && !image) return { mode: 'chat', text: '', image: null, targetMode, room, mentions: [], validationError: 'empty' };
  const mentions = parseMentions(text);
  return { mode: 'chat', text, image, targetMode, room, mentions };
}

// ─── _refreshSlashState — DOM-mutation driver derived from detectIntent ───
// Listens to `input` events, updates sendBtn.disabled + slash error + slash picker
// state. Drives side effects from the discriminator — single source of truth.

function _refreshSlashState() {
  const intent = detectIntent(captureComposerSnapshot());

  if (intent.mode !== 'slash') {
    if (slashPickerActive()) slashPickerClose();
    _hideSlashError();
    sendBtn.disabled = false;
    return;
  }

  // Slash mode: picker stays open while typing
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

// ─── send — dispatch on intent.mode ────────────────────────────────────

async function send() {
  const intent = detectIntent(captureComposerSnapshot());

  // Slash and shift-tab: keep their own input-clear-on-success semantics.
  // Interrupt and chat: clear input immediately before fetch.
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
  if (intent.validationError) return; // _refreshSlashState already surfaced it
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
  // Hub requires room scope on broadcasts ("all" is ambiguous across projects).
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

// ─── Input event wiring (unchanged) ────────────────────────────────────

input.addEventListener('keydown', (e) => {
  const mentionOpen = mentionPop.classList.contains('open');
  const slashOpen   = slashPickerActive();
  // Mention popover wins: once `@` is typed we're picking a target, not slash commands.
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

// Export detectIntent + captureComposerSnapshot for the contract test.
// (Classic-script load — these become globals on window.)
window.detectIntent = detectIntent;
window.captureComposerSnapshot = captureComposerSnapshot;
