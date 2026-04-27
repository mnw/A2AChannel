// slash-picker.js — popover that lists slash commands available across the
// agents in the currently-selected room. Tier 2 of index.html.
//
// Opens when the composer is in slash mode AND the room dropdown is on a
// concrete room (not All-rooms). In All-rooms view the picker shows a single
// hint "Select a room first" and the send button stays disabled.
//
// Keyboard: ArrowDown/Up moves selection, Enter commits (replaces composer
// with `<commandName> ` and positions the cursor for `@target` typing).
// Escape dismisses (handled in composer.js).
//
// Depends on (declared earlier):
//   from state.js — input, SELECTED_ROOM, ROOM_ALL
//   from slash-discovery.js — discoverCommandsForRoom, commandUnion,
//                              commandAvailability, BUILTIN_SLASH_COMMANDS
//   from slash-mode.js — parseSlashMessage
//
// Exposes:
//   slashPickerOpen, slashPickerClose, slashPickerActive,
//   slashPickerSelectActive, slashPickerMove, slashPickerUpdate

const slashPop = document.getElementById('slash-popover');

let _slashPickerVisible = false;
let _slashPickerEntries = [];   // [{ command, available, total, missingFrom }]
let _slashPickerActive = 0;
let _slashPickerRoomMap = null; // Map<agent, Set<command>> — cached for the open popover

function slashPickerActive() {
  return _slashPickerVisible;
}

async function slashPickerOpen() {
  if (!slashPop) return;
  if (SELECTED_ROOM === ROOM_ALL) {
    _slashPickerVisible = true;
    _slashPickerEntries = [];
    _slashPickerRoomMap = null;
    slashPop.innerHTML = `<div class="slash-empty">Select a room first</div>`;
    slashPop.classList.add('open');
    return;
  }
  _slashPickerVisible = true;
  slashPop.innerHTML = `<div class="slash-loading">…</div>`;
  slashPop.classList.add('open');
  // Discovery is async (Tauri IPC per agent). Cache the result for the
  // lifetime of this popover-open session — if the user edits .claude/...
  // while the picker is open they'll see stale info; closing and reopening
  // re-scans.
  _slashPickerRoomMap = await discoverCommandsForRoom(SELECTED_ROOM);
  if (!_slashPickerVisible) return; // closed during await
  slashPickerUpdate();
}

function slashPickerUpdate() {
  if (!slashPop || !_slashPickerVisible) return;
  if (SELECTED_ROOM === ROOM_ALL) {
    slashPop.innerHTML = `<div class="slash-empty">Select a room first</div>`;
    return;
  }
  if (!_slashPickerRoomMap) return; // still loading
  const total = _slashPickerRoomMap.size;
  if (total === 0) {
    slashPop.innerHTML = `<div class="slash-empty">No live agents in this room</div>`;
    return;
  }

  const union = commandUnion(_slashPickerRoomMap);  // Map<cmd, description>
  const builtins = BUILTIN_SLASH_COMMANDS;          // Map<cmd, description>
  // Filter by what user has typed after the leading `/`.
  const parsed = parseSlashMessage(input.value);
  const typed = (parsed.slashCommand || input.value || '').toLowerCase();
  const list = [];
  for (const [cmd, desc] of union.entries()) {
    if (typed && typed !== '/' && !cmd.toLowerCase().startsWith(typed)) continue;
    const avail = commandAvailability(cmd, _slashPickerRoomMap);
    list.push({ command: cmd, description: desc || '', ...avail });
  }
  // Built-ins first, then alpha within each group.
  list.sort((a, b) => {
    const ab = builtins.has(a.command), bb = builtins.has(b.command);
    if (ab !== bb) return ab ? -1 : 1;
    return a.command.localeCompare(b.command);
  });
  _slashPickerEntries = list;
  if (_slashPickerActive >= list.length) _slashPickerActive = 0;

  if (!list.length) {
    slashPop.innerHTML = `<div class="slash-empty">No matching commands</div>`;
    return;
  }
  slashPop.innerHTML = '';
  list.forEach((entry, i) => {
    const row = document.createElement('div');
    const unavailable = entry.available === 0;
    row.className = 'slash-item' +
                    (i === _slashPickerActive ? ' active' : '') +
                    (unavailable ? ' unavailable' : '');
    if (unavailable) row.title = 'no live agents have this command';
    else if (entry.missingFrom.length) row.title = 'missing from: ' + entry.missingFrom.join(', ');
    const safeDesc = (entry.description || '').replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
    const safeCmd = entry.command.replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
    row.innerHTML =
      `<span class="slash-cmd">${safeCmd}</span>` +
      (safeDesc ? `<span class="slash-desc">${safeDesc}</span>` : '') +
      `<span class="slash-badge">${entry.available}/${entry.total}</span>`;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      _slashPickerActive = i;
      slashPickerSelectActive();
    });
    slashPop.appendChild(row);
  });
}

function slashPickerMove(delta) {
  if (!_slashPickerVisible || !_slashPickerEntries.length) return;
  _slashPickerActive = (_slashPickerActive + delta + _slashPickerEntries.length)
                       % _slashPickerEntries.length;
  slashPickerUpdate();
}

function slashPickerSelectActive() {
  if (!_slashPickerVisible || !_slashPickerEntries.length) return;
  const entry = _slashPickerEntries[_slashPickerActive];
  if (!entry) return;
  // Replace the leading slash-command token with the picked one + space; keep
  // any trailing user content (target + args).
  const parsed = parseSlashMessage(input.value);
  const tail = input.value.slice((parsed.slashCommand || input.value).length);
  input.value = entry.command + ' ' + tail.replace(/^\s+/, '');
  // Position cursor right after the command and the space, ready for @target.
  const newPos = entry.command.length + 1;
  input.selectionStart = input.selectionEnd = newPos;
  input.focus();
  if (typeof autoGrow === 'function') autoGrow();
  // Don't close — the @-popover will take over once the user types `@`.
}

function slashPickerClose() {
  _slashPickerVisible = false;
  _slashPickerEntries = [];
  _slashPickerActive = 0;
  _slashPickerRoomMap = null;
  if (slashPop) slashPop.classList.remove('open');
}
