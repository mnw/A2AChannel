// slash-picker.js — popover listing slash commands available across the room's live agents.

const slashPop = document.getElementById('slash-popover');

let _slashPickerVisible = false;
let _slashPickerEntries = [];
let _slashPickerActive = 0;
let _slashPickerRoomMap = null;

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
  // Cached per popover-open session; reopen to re-scan after editing .claude/.
  _slashPickerRoomMap = await discoverCommandsForRoom(SELECTED_ROOM);
  if (!_slashPickerVisible) return;
  slashPickerUpdate();
}

function slashPickerUpdate() {
  if (!slashPop || !_slashPickerVisible) return;
  if (SELECTED_ROOM === ROOM_ALL) {
    slashPop.innerHTML = `<div class="slash-empty">Select a room first</div>`;
    return;
  }
  if (!_slashPickerRoomMap) return;
  const total = _slashPickerRoomMap.size;
  if (total === 0) {
    slashPop.innerHTML = `<div class="slash-empty">No live agents in this room</div>`;
    return;
  }

  const union = commandUnion(_slashPickerRoomMap);
  const builtins = BUILTIN_SLASH_COMMANDS;
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
  const parsed = parseSlashMessage(input.value);
  const tail = input.value.slice((parsed.slashCommand || input.value).length);
  input.value = entry.command + ' ' + tail.replace(/^\s+/, '');
  const newPos = entry.command.length + 1;
  input.selectionStart = input.selectionEnd = newPos;
  input.focus();
  if (typeof autoGrow === 'function') autoGrow();
  // Stay open: @-popover takes over once the user types `@`.
}

function slashPickerClose() {
  _slashPickerVisible = false;
  _slashPickerEntries = [];
  _slashPickerActive = 0;
  _slashPickerRoomMap = null;
  if (slashPop) slashPop.classList.remove('open');
}
