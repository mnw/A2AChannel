// composer.js — message-input wiring: send (chat + interrupt + slash routing),
// autoGrow, Enter-to-send, mention-popover keynav, slash-popover keynav.
// Tier 2 of index.html.
//
// Depends on (declared earlier):
//   from state.js — input, sendBtn, targetEl, mentionPop, mentionMatches,
//                   mentionActive, pendingImageUrl, HUMAN_NAME, SELECTED_ROOM,
//                   ROOM_ALL
//   from text.js  — parseMentions
//   from http.js  — authedFetch, parseErrorBody
//   from messages.js — addMessage
//   from attachments.js — clearAttachment
//   from mentions.js — hideMentionPopover, updateMentionPopover,
//                      renderMentionPopover, selectMention
//   from slash-mode.js — isSlashMode, parseSlashMessage,
//                          isShiftTabMode, parseShiftTab
//   from slash-picker.js — slashPickerOpen, slashPickerClose,
//                           slashPickerActive, slashPickerMove,
//                           slashPickerSelectActive, slashPickerUpdate
//   from slash-send.js — sendSlash, sendShiftTab
//
// Exposes:
//   send, autoGrow

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

// Re-evaluate slash-mode state on every input event: open/close picker,
// update the disabled state on the send button, surface inline errors.
function _refreshSlashState() {
  const inSlash = isSlashMode(input.value);
  if (!inSlash) {
    if (slashPickerActive()) slashPickerClose();
    _hideSlashError();
    sendBtn.disabled = false;
    return;
  }
  // In slash mode: gate by room selection + parsed completeness.
  if (SELECTED_ROOM === ROOM_ALL) {
    if (!slashPickerActive()) slashPickerOpen();
    else slashPickerUpdate();
    _showSlashError('Select a room first');
    sendBtn.disabled = true;
    return;
  }
  if (!slashPickerActive()) slashPickerOpen();
  else slashPickerUpdate();
  const parsed = parseSlashMessage(input.value);
  if (!parsed.slashCommand) {
    _hideSlashError();
    sendBtn.disabled = true;
    return;
  }
  if (!parsed.target) {
    _showSlashError('specify @agent or @all');
    sendBtn.disabled = true;
    return;
  }
  _hideSlashError();
  sendBtn.disabled = false;
}

async function send() {
  const text = input.value.trim();
  const image = pendingImageUrl;
  if (!text && !image) return;

  // Slash mode bypass — bytes go to PTY, not the channel. Bail out of the
  // chat send entirely on success or graceful failure.
  if (isSlashMode(input.value)) {
    if (SELECTED_ROOM === ROOM_ALL) return;
    const parsed = parseSlashMessage(input.value);
    if (!parsed.slashCommand || !parsed.target) return;
    sendBtn.disabled = true;
    try {
      const ok = await sendSlash(parsed);
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
    return;
  }

  // Shift+Tab bypass — sibling to slash mode. Sends the literal terminal
  // Shift+Tab byte sequence (`\x1B[Z`) to each resolved agent's PTY.
  // Claude uses this to cycle modes (Normal → Auto-Accept → Plan → Normal).
  // Same room rules as slash: concrete room required, @agent or @all.
  if (isShiftTabMode(input.value)) {
    if (SELECTED_ROOM === ROOM_ALL) {
      _showSlashError('Select a room first');
      return;
    }
    const parsed = parseShiftTab(input.value);
    if (!parsed.target) {
      _showSlashError('specify @agent or @all');
      return;
    }
    sendBtn.disabled = true;
    try {
      const ok = await sendShiftTab(parsed);
      if (ok) {
        input.value = '';
        autoGrow();
        _hideSlashError();
      }
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
    return;
  }

  const mode = targetEl.value || 'auto';

  // Targets prefixed with "!" route through /interrupts instead of /send.
  if (mode.startsWith('!')) {
    const toAgent = mode.slice(1);
    if (!text) {
      addMessage({ from: 'system', to: HUMAN_NAME, text: 'Interrupt text required.', ts: '' });
      return;
    }
    if (text.length > 500) {
      addMessage({ from: 'system', to: HUMAN_NAME, text: 'Interrupt text must be 500 chars or fewer.', ts: '' });
      return;
    }
    if (image) {
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
        body: JSON.stringify({ from: HUMAN_NAME, to: toAgent, text }),
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
    return;
  }

  const mentions = parseMentions(text);
  let body = { text, image };
  if (mode === 'auto') {
    if (mentions.length) body.targets = mentions;
    else body.target = 'all';
  } else {
    body.target = mode;
  }
  // When the human broadcasts to "all", the hub requires the room scope explicitly
  // (otherwise "all" is ambiguous across projects). Pass the current room filter.
  if ((body.target === 'all' || (Array.isArray(body.targets) && body.targets.length === 0))
      && SELECTED_ROOM !== ROOM_ALL) {
    body.room = SELECTED_ROOM;
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
  // Mention popover takes precedence — once `@` is typed, we're picking a
  // target, not browsing slash commands.
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
  // Shift+Tab broadcasts to all live agents in the current room — bypasses
  // the browser's default backward-focus behaviour. Sends the literal
  // terminal Shift+Tab byte sequence (`\x1B[Z`) which claude uses to
  // cycle modes (Normal → Auto-Accept → Plan → Normal). Modifier-free
  // Tab still does its browser default (focus next), so users can still
  // navigate forward out of the composer if they want.
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

// Send button click moves here from main.js (where it was provisional).
sendBtn.addEventListener('click', () => send());
