// mentions.js — @-autocomplete popover anchored to the composer textarea.
// Tier 2 of index.html.
//
// Depends on (declared earlier):
//   from state.js — input, mentionPop, mentionMatches (mutated), mentionActive
//                   (mutated), presenceState, COLORS, ROSTER, SELECTED_ROOM,
//                   ROOM_ALL
//
// Exposes:
//   currentMentionContext, updateMentionPopover, renderMentionPopover,
//   selectMention, hideMentionPopover

function currentMentionContext() {
  const pos = input.selectionStart ?? 0;
  const before = input.value.slice(0, pos);
  const m = before.match(/@([\w-]*)$/);
  if (!m) return null;
  return { query: m[1].toLowerCase(), start: pos - m[0].length, end: pos };
}

function updateMentionPopover() {
  const ctx = currentMentionContext();
  if (!ctx) { hideMentionPopover(); return; }
  // Slash mode narrows the candidate set: only live in-room agents whose PTY
  // we own (excludes external/dead/launching, the human, and All-rooms view).
  const inSlashMode = typeof isSlashMode === 'function' && isSlashMode(input.value);
  let names;
  let allowAll;
  if (inSlashMode) {
    names = typeof slashTargetCandidates === 'function'
      ? slashTargetCandidates(SELECTED_ROOM)
      : [];
    allowAll = names.length >= 1; // @all works at any count, even 1
  } else {
    // Filter roster by SELECTED_ROOM so the autocomplete doesn't surface peers
    // from other projects. The human (room=null) is always visible (super-user;
    // implicitly in every room). When SELECTED_ROOM === ROOM_ALL the filter is
    // a pass-through (god view).
    const visibleRoster = SELECTED_ROOM === ROOM_ALL
      ? ROSTER
      : ROSTER.filter((a) => a.room === null || a.room === SELECTED_ROOM);
    names = visibleRoster.map(a => a.name);
    allowAll = visibleRoster.length > 1;
  }
  mentionMatches = names.filter(n => n.toLowerCase().startsWith(ctx.query));
  if (allowAll && 'all'.startsWith(ctx.query)) mentionMatches.push('all');
  if (!mentionMatches.length) { hideMentionPopover(); return; }
  if (mentionActive >= mentionMatches.length) mentionActive = 0;
  renderMentionPopover();
  mentionPop.classList.add('open');
}

function renderMentionPopover() {
  mentionPop.innerHTML = '';
  mentionMatches.forEach((name, i) => {
    const online = name === 'all' ? null : !!presenceState[name];
    const item = document.createElement('div');
    item.className = 'mention-item' + (i === mentionActive ? ' active' : '') +
                     (online === false ? ' offline' : '');
    const color = name === 'all' ? 'var(--text-muted)' : (COLORS[name] || 'var(--text-muted)');
    const meta = name === 'all' ? 'broadcast' : (online ? 'online' : 'offline');
    item.innerHTML = `<span class="dot" style="background:${color}"></span>` +
                     `<span>${name}</span>` +
                     `<span class="meta">${meta}</span>`;
    item.addEventListener('mousedown', (e) => { e.preventDefault(); selectMention(name); });
    mentionPop.appendChild(item);
  });
}

function selectMention(name) {
  const ctx = currentMentionContext();
  if (!ctx) { hideMentionPopover(); return; }
  const before = input.value.slice(0, ctx.start);
  const after = input.value.slice(ctx.end);
  const insert = `@${name} `;
  input.value = before + insert + after;
  const newPos = ctx.start + insert.length;
  input.selectionStart = input.selectionEnd = newPos;
  hideMentionPopover();
  input.focus();
  if (typeof autoGrow === 'function') autoGrow();
}

function hideMentionPopover() {
  mentionPop.classList.remove('open');
  mentionMatches = [];
  mentionActive = 0;
}
