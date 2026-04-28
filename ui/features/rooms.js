// rooms.js — room switcher + menu, client-side filter, pause/resume buttons.

const roomSwitcherEl   = document.getElementById('room-switcher');
const roomDisplayBtn   = document.getElementById('room-display');
const roomDisplayText  = roomDisplayBtn?.querySelector('.room-display-text');
const roomMenu         = document.getElementById('room-menu');
const pauseRoomBtn     = document.getElementById('pause-room-btn');
const resumeRoomBtn    = document.getElementById('resume-room-btn');

function distinctRooms() {
  const rooms = new Set();
  for (const a of ROSTER) {
    if (a && typeof a.room === 'string' && a.room) rooms.add(a.room);
  }
  return [...rooms].sort();
}

function renderRoomSwitcher() {
  if (!roomSwitcherEl) return;
  const rooms = distinctRooms();
  // Mirror options into the hidden <select>; same pattern as composer target-dropdown.
  roomSwitcherEl.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = ROOM_ALL;
  allOpt.textContent = 'All rooms';
  roomSwitcherEl.appendChild(allOpt);
  for (const r of rooms) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = `# ${r}`;
    roomSwitcherEl.appendChild(opt);
  }
  // Snap to valid value if persisted room is gone (last agent in that room quit).
  if (SELECTED_ROOM !== ROOM_ALL && !rooms.includes(SELECTED_ROOM)) {
    SELECTED_ROOM = ROOM_ALL;
    localStorage.setItem(SELECTED_ROOM_KEY, ROOM_ALL);
  }
  roomSwitcherEl.value = SELECTED_ROOM;
  renderRoomMenu();
  updatePauseResumeState();
  applyRoomFilter();
}

function renderRoomMenu() {
  if (!roomMenu) return;
  roomMenu.innerHTML = '';
  const rooms = distinctRooms();
  const build = (value, label) => {
    const el = document.createElement('div');
    el.className = 'room-option';
    if (value === SELECTED_ROOM) el.classList.add('selected');
    el.dataset.value = value;
    el.role = 'option';
    el.textContent = label;
    el.addEventListener('click', () => {
      roomSwitcherEl.value = value;
      roomSwitcherEl.dispatchEvent(new Event('change'));
      closeRoomMenu();
    });
    return el;
  };
  roomMenu.appendChild(build(ROOM_ALL, 'All rooms'));
  if (rooms.length) {
    const div = document.createElement('div');
    div.className = 'room-menu-divider';
    roomMenu.appendChild(div);
    for (const r of rooms) roomMenu.appendChild(build(r, `# ${r}`));
  }
  updateRoomDisplayLabel();
}

function updateRoomDisplayLabel() {
  if (!roomDisplayText) return;
  roomDisplayText.textContent =
    SELECTED_ROOM === ROOM_ALL ? 'All rooms' : `# ${SELECTED_ROOM}`;
}

function openRoomMenu() {
  if (!roomMenu || !roomDisplayBtn) return;
  roomMenu.classList.add('open');
  roomDisplayBtn.setAttribute('aria-expanded', 'true');
}
function closeRoomMenu() {
  if (!roomMenu || !roomDisplayBtn) return;
  roomMenu.classList.remove('open');
  roomDisplayBtn.setAttribute('aria-expanded', 'false');
}
roomDisplayBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (roomMenu?.classList.contains('open')) closeRoomMenu();
  else openRoomMenu();
});
document.addEventListener('click', (e) => {
  if (!roomMenu?.classList.contains('open')) return;
  if (!roomMenu.contains(e.target) && e.target !== roomDisplayBtn
      && !roomDisplayBtn?.contains(e.target)) closeRoomMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && roomMenu?.classList.contains('open')) closeRoomMenu();
});

function updatePauseResumeState() {
  const hasRoom = SELECTED_ROOM !== ROOM_ALL;
  if (pauseRoomBtn) pauseRoomBtn.disabled = !hasRoom;
  if (resumeRoomBtn) resumeRoomBtn.disabled = !hasRoom;
}

function applyRoomFilter() {
  document.body.dataset.selectedRoom = SELECTED_ROOM;
  document.body.classList.toggle('room-filtered', SELECTED_ROOM !== ROOM_ALL);
  // Selectors depend on the runtime room label, so this JS is the single source of truth.
  let styleEl = document.getElementById('room-filter-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'room-filter-style';
    document.head.appendChild(styleEl);
  }
  if (SELECTED_ROOM === ROOM_ALL) {
    styleEl.textContent = '';
  } else {
    const r = CSS.escape(SELECTED_ROOM);
    // Elements without data-room (system events, generic human messages) stay visible everywhere.
    styleEl.textContent = `
      body.room-filtered .msg[data-room]:not([data-room="${r}"]),
      body.room-filtered .handoff-card[data-room]:not([data-room="${r}"]),
      body.room-filtered .interrupt-card[data-room]:not([data-room="${r}"]),
      body.room-filtered .permission-card[data-room]:not([data-room="${r}"]),
      body.room-filtered .legend-item[data-room]:not([data-room="${r}"]),
      body.room-filtered .terminal-tab[data-room]:not([data-room="${r}"]) {
        display: none;
      }
    `;
  }
  if (typeof renderNutshell === 'function') renderNutshell();
  // Notify terminal pane: hiding active tab via CSS alone leaves wrong xterm pane showing.
  document.dispatchEvent(new CustomEvent('a2a:room-filter', {
    detail: { room: SELECTED_ROOM === ROOM_ALL ? null : SELECTED_ROOM },
  }));
}

roomSwitcherEl?.addEventListener('change', () => {
  SELECTED_ROOM = roomSwitcherEl.value || ROOM_ALL;
  localStorage.setItem(SELECTED_ROOM_KEY, SELECTED_ROOM);
  updateRoomDisplayLabel();
  renderRoomMenu();
  updatePauseResumeState();
  applyRoomFilter();
  // Re-filter target dropdown so we don't surface out-of-room agents.
  if (typeof renderTargetDropdown === 'function') renderTargetDropdown();
  if (SELECTED_ROOM !== ROOM_ALL) {
    if (typeof loadNutshell === 'function') loadNutshell(SELECTED_ROOM);
  } else {
    if (typeof renderNutshell === 'function') renderNutshell();
  }
});

async function fireRoomInterrupt(text) {
  if (SELECTED_ROOM === ROOM_ALL) return;
  try {
    const r = await authedFetch('/interrupts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: HUMAN_NAME, rooms: [SELECTED_ROOM], text }),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Bulk interrupt failed: ${err}`, ts: '' });
    }
  } catch (e) {
    addMessage({ from: 'system', to: HUMAN_NAME, text: `Bulk interrupt error: ${e?.message ?? e}`, ts: '' });
  }
}
pauseRoomBtn?.addEventListener('click', () =>
  fireRoomInterrupt('Pause — stop current task, hold state, await resume.'));
resumeRoomBtn?.addEventListener('click', () =>
  fireRoomInterrupt('Resume — continue previous task.'));
