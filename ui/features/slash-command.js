// slash-command.js — the Slash command module. Owns parse → discover → pick →
// send for `/`-prefixed and `Shift+Tab` composer input. Slash sends bypass the
// hub entirely: bytes go through pty_write Tauri IPC straight to the per-Agent
// tmux PTY. The hub sees a single synthetic `system` audit entry per send.
//
// Replaces four sibling files (slash-discovery, slash-mode, slash-picker,
// slash-send) so the version-pinned lists, the busy-Agent fence, and the
// destructive-confirm gate live next to each other and stay in sync on each
// Claude Code release.
//
// External surface used by composer.js (kept as global functions to preserve
// the no-bundler vanilla-JS contract):
//   isSlashMode, isShiftTabMode, parseSlashMessage, parseShiftTab,
//   slashPickerActive, slashPickerOpen, slashPickerClose, slashPickerUpdate,
//   slashPickerMove, slashPickerSelectActive, sendSlash, sendShiftTab.

// =============================================================================
// VERSION-PINNED CONSTANTS — REVIEW ON EACH CLAUDE CODE RELEASE
// Built-ins drift between Claude Code versions; the destructive set gates the
// multi-agent confirm modal; the captureable set is a manual sync point with
// the hub command registry. All three live here intentionally.
// =============================================================================

const BUILTIN_SLASH_COMMANDS = new Map([
  ['/add-dir',           'Add a working directory the agent is allowed to read'],
  ['/advisor',           'Open advisor mode for guided decisions'],
  ['/agents',            'List, create, or edit subagents'],
  ['/bug',               'File a bug report against Claude Code'],
  ['/clear',             'Wipe the conversation context (irreversible)'],
  ['/compact',           'Summarize older messages to free context'],
  ['/context',           'Show current context size + token budget'],
  ['/cost',              'Show estimated cost of the current session'],
  ['/doctor',            'Diagnose Claude Code installation health'],
  ['/editor',            'Open the configured editor at the current cwd'],
  ['/export',            'Export the current session transcript'],
  ['/help',              'List available slash commands'],
  ['/hooks',             'Manage hooks (PreToolUse, PostToolUse, …)'],
  ['/init',              'Create a CLAUDE.md from the current project'],
  ['/login',             'Sign in to Anthropic'],
  ['/logout',            'Sign out of Anthropic'],
  ['/mcp',               'List or invoke MCP servers'],
  ['/memory',            'View or edit the agent\'s memory file'],
  ['/model',             'Switch the active claude model'],
  ['/permissions',       'Manage tool-use permissions for this session'],
  ['/privacy',           'Privacy settings + telemetry controls'],
  ['/release-notes',     'Show release notes for the installed claude version'],
  ['/resume',            'Resume a prior session'],
  ['/review',            'Review a pull request'],
  ['/security-review',   'Run a security review of pending changes'],
  ['/settings',          'Open the settings panel'],
  ['/status',            'Show session status (model, tokens, mode)'],
  ['/terminal-setup',    'Configure terminal integration'],
  ['/usage',             'Show 5-hour and weekly usage stats'],
  ['/vim',               'Toggle vim editing mode in the input'],
]);

// Wipes context per Agent; multi-Agent send requires confirm modal.
const DESTRUCTIVE_SLASH_COMMANDS = new Set(['/clear', '/compact']);

// Fast panel-rendering commands safe for pty_capture_turn. Anything outside
// this set is multi-turn / conversational and would mis-fire on quiescence or
// get SIGWINCH-interrupted by cleanup_geometry mid-render — those use plain
// pty_write and require the Agent to post back via mcp__chatbridge__post.
const _CAPTUREABLE_SLASH_COMMANDS = new Set([
  '/context',
  '/usage',
  '/cost',
  '/memory',
  '/agents',
  '/skills',
  '/help',
  '/mcp',
  '/model',
  '/status',
  '/permissions',
  '/config',
  '/release-notes',
  '/doctor',
]);

const _CAPTURE_TIMEOUT_MS = 15_000;

// =============================================================================
// PARSE — pure functions on textarea content
// =============================================================================

function isSlashMode(textareaValue) {
  return typeof textareaValue === 'string' && textareaValue.startsWith('/');
}

// Shift+Tab pseudo-command sends `\x1B[Z` to cycle claude modes.
const _SHIFT_TAB_PREFIX_RE = /^\s*shift[\s+_-]*tab\b/i;

function isShiftTabMode(textareaValue) {
  return typeof textareaValue === 'string' && _SHIFT_TAB_PREFIX_RE.test(textareaValue);
}

function parseShiftTab(text) {
  const out = { target: null };
  if (!isShiftTabMode(text)) return out;
  const tail = text.replace(_SHIFT_TAB_PREFIX_RE, '').trim();
  for (const t of tail.split(/\s+/)) {
    if (!t) continue;
    if (t.startsWith('@')) {
      const tm = t.match(/^@([A-Za-z0-9_.-]+)$/);
      if (tm) { out.target = tm[1]; break; }
    }
  }
  return out;
}

// Returns nulls on missing parts; gating decides the inline error.
function parseSlashMessage(text) {
  const out = { slashCommand: null, target: null, args: '' };
  if (typeof text !== 'string' || !text.startsWith('/')) return out;
  const tokens = text.trim().split(/\s+/);
  const cmdMatch = tokens[0]?.match(/^(\/[A-Za-z0-9_:-]+)$/);
  if (!cmdMatch) return out;
  out.slashCommand = cmdMatch[1];
  const argTokens = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (out.target === null && t.startsWith('@')) {
      const tm = t.match(/^@([A-Za-z0-9_.-]+)$/);
      if (tm) {
        out.target = tm[1];
        continue;
      }
    }
    argTokens.push(t);
  }
  out.args = argTokens.join(' ');
  return out;
}

// =============================================================================
// TARGET RESOLUTION — busy-Agent fence + Room candidate filter
// Reads global mutable state: ROSTER, ROOM_ALL, presenceState, permissionCards,
// interruptCards. Co-located with sendSlash/sendShiftTab so any future code
// path that bypasses the busy-fence is structurally visible.
// =============================================================================

function _busyAgents() {
  const busy = new Set();
  for (const card of permissionCards.values()) {
    if (card.status === 'pending' && card.snapshot?.agent) {
      busy.add(card.snapshot.agent);
    }
  }
  for (const card of interruptCards.values()) {
    if (card.status === 'pending' && card.snapshot?.to) {
      busy.add(card.snapshot.to);
    }
  }
  return busy;
}

// Live in-Room Agents whose PTY we own (excludes Human, Shell, external, offline).
function _slashTargetCandidates(roomName) {
  return ROSTER.filter((a) => {
    if (a.room === null) return false;
    if (roomName === ROOM_ALL) return false;
    if (a.room !== roomName) return false;
    if (!presenceState[a.name]) return false;
    return true;
  }).map((a) => a.name);
}

function _resolveTargets(target, roomName) {
  if (!target) return { resolved: [], skipped: [] };
  const candidates = _slashTargetCandidates(roomName);
  if (target === 'all') {
    const busy = _busyAgents();
    const resolved = [];
    const skipped = [];
    for (const name of candidates) {
      if (busy.has(name)) skipped.push({ name, reason: 'busy (permission or interrupt pending)' });
      else resolved.push(name);
    }
    return { resolved, skipped };
  }
  if (candidates.includes(target)) return { resolved: [target], skipped: [] };
  return { resolved: [], skipped: [{ name: target, reason: 'not a live agent in this room' }] };
}

// =============================================================================
// DISCOVERY — built-ins + per-Agent filesystem scan via Tauri
// =============================================================================

async function _discoverCommandsForAgent(agent) {
  const map = new Map(BUILTIN_SLASH_COMMANDS);
  try {
    const items = await tauriInvoke('slash_discover_for_agent', { agent });
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item === 'string') {
          map.set('/' + item, '');
        } else if (item && typeof item.name === 'string') {
          map.set('/' + item.name, item.description || '');
        }
      }
    }
  } catch {
    // Best-effort: built-ins still returned on Tauri-call failure.
  }
  return map;
}

async function _discoverCommandsForRoom(roomName) {
  // Discovery requires PTY ownership; external/dead/launching skipped.
  const inRoom = ROSTER.filter((a) => {
    if (a.room === null) return false;
    if (roomName !== ROOM_ALL && a.room !== roomName) return false;
    return !!presenceState[a.name];
  });
  const result = new Map();
  await Promise.all(
    inRoom.map(async (a) => {
      const cmds = await _discoverCommandsForAgent(a.name);
      result.set(a.name, cmds);
    })
  );
  return result;
}

// Description from the first agent supplying a non-empty one (built-ins always win).
function _commandUnion(roomMap) {
  const u = new Map();
  for (const cmds of roomMap.values()) {
    for (const [cmd, desc] of cmds.entries()) {
      const prev = u.get(cmd);
      if (prev === undefined || (!prev && desc)) u.set(cmd, desc || '');
    }
  }
  return u;
}

function _commandAvailability(commandName, roomMap) {
  const total = roomMap.size;
  let available = 0;
  const missingFrom = [];
  for (const [agent, cmds] of roomMap.entries()) {
    if (cmds.has(commandName)) available++;
    else missingFrom.push(agent);
  }
  return { available, total, missingFrom };
}

// =============================================================================
// PICKER — popover listing commands available across the Room's live Agents
// =============================================================================

const _slashPop = document.getElementById('slash-popover');

let _slashPickerVisible = false;
let _slashPickerEntries = [];
let _slashPickerActiveIdx = 0;
let _slashPickerRoomMap = null;
// Remember which Room the cache was populated for so a Room switch invalidates
// it instead of showing stale results from the previously selected Room.
let _slashPickerCacheRoom = null;

function slashPickerActive() {
  return _slashPickerVisible;
}

async function slashPickerOpen() {
  if (!_slashPop) return;
  if (SELECTED_ROOM === ROOM_ALL) {
    _slashPickerVisible = true;
    _slashPickerEntries = [];
    _slashPickerRoomMap = null;
    _slashPickerCacheRoom = null;
    _slashPop.innerHTML = `<div class="slash-empty">Select a room first</div>`;
    _slashPop.classList.add('open');
    return;
  }
  _slashPickerVisible = true;
  _slashPop.innerHTML = `<div class="slash-loading">…</div>`;
  _slashPop.classList.add('open');
  const roomAtOpen = SELECTED_ROOM;
  const map = await _discoverCommandsForRoom(roomAtOpen);
  // Bail if the user closed the picker or switched rooms while we were awaiting.
  if (!_slashPickerVisible || SELECTED_ROOM !== roomAtOpen) return;
  _slashPickerRoomMap = map;
  _slashPickerCacheRoom = roomAtOpen;
  slashPickerUpdate();
}

function slashPickerUpdate() {
  if (!_slashPop || !_slashPickerVisible) return;
  if (SELECTED_ROOM === ROOM_ALL) {
    _slashPop.innerHTML = `<div class="slash-empty">Select a room first</div>`;
    return;
  }
  // Stale cache from a previous Room → re-fetch instead of rendering wrong list.
  if (_slashPickerCacheRoom !== SELECTED_ROOM) {
    slashPickerOpen();
    return;
  }
  if (!_slashPickerRoomMap) return;
  const total = _slashPickerRoomMap.size;
  if (total === 0) {
    _slashPop.innerHTML = `<div class="slash-empty">No live agents in this room</div>`;
    return;
  }

  const union = _commandUnion(_slashPickerRoomMap);
  const parsed = parseSlashMessage(input.value);
  const typed = (parsed.slashCommand || input.value || '').toLowerCase();
  const list = [];
  for (const [cmd, desc] of union.entries()) {
    if (typed && typed !== '/' && !cmd.toLowerCase().startsWith(typed)) continue;
    const avail = _commandAvailability(cmd, _slashPickerRoomMap);
    list.push({ command: cmd, description: desc || '', ...avail });
  }
  // Built-ins first, then alpha within each group.
  list.sort((a, b) => {
    const ab = BUILTIN_SLASH_COMMANDS.has(a.command), bb = BUILTIN_SLASH_COMMANDS.has(b.command);
    if (ab !== bb) return ab ? -1 : 1;
    return a.command.localeCompare(b.command);
  });
  _slashPickerEntries = list;
  if (_slashPickerActiveIdx >= list.length) _slashPickerActiveIdx = 0;

  if (!list.length) {
    _slashPop.innerHTML = `<div class="slash-empty">No matching commands</div>`;
    return;
  }
  _slashPop.innerHTML = '';
  list.forEach((entry, i) => {
    const row = document.createElement('div');
    const unavailable = entry.available === 0;
    row.className = 'slash-item' +
                    (i === _slashPickerActiveIdx ? ' active' : '') +
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
      _slashPickerActiveIdx = i;
      slashPickerSelectActive();
    });
    _slashPop.appendChild(row);
  });
}

function slashPickerMove(delta) {
  if (!_slashPickerVisible || !_slashPickerEntries.length) return;
  _slashPickerActiveIdx = (_slashPickerActiveIdx + delta + _slashPickerEntries.length)
                          % _slashPickerEntries.length;
  slashPickerUpdate();
}

function slashPickerSelectActive() {
  if (!_slashPickerVisible || !_slashPickerEntries.length) return;
  const entry = _slashPickerEntries[_slashPickerActiveIdx];
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
  _slashPickerActiveIdx = 0;
  _slashPickerRoomMap = null;
  _slashPickerCacheRoom = null;
  if (_slashPop) _slashPop.classList.remove('open');
}

// =============================================================================
// SEND — fan parsed slash sends to Agent PTYs via pty_capture_turn / pty_write
// =============================================================================

function _ptyBridge() {
  const pty = window.__A2A_TERM__?.pty;
  if (!pty?.ptyCaptureTurn || !pty?.ptyReadCapture || !pty?.ptyWrite || !pty?.strToB64) {
    throw new Error('PTY bridge not available');
  }
  return pty;
}

function _formatTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Source rendered into 240×100 (no overlap-collapse), so cursor-moves flatten to newlines safely.
function _stripAnsi(text) {
  if (!text) return '';
  let s = text;
  s = s.replace(/\x1B\[\d*;?\d*H/g, '\n');     // CUP / HVP
  s = s.replace(/\x1B\[\d*[ABEF]/g, '\n');     // CUU / CUD / CNL / CPL
  s = s.replace(/\x1B\[\d*[CDG]/g, ' ');       // CUF / CUB / CHA
  s = s.replace(/\x1B\[s|\x1B\[u/g, '');       // SCP / RCP
  s = s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ''); // generic CSI
  s = s.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, ''); // OSC
  s = s.replace(/\x1B[ -/]*[0-~]/g, '');       // ANSI X3.64 ESC
  s = s.replace(/\x1B/g, '');
  s = s.replace(/\r\n/g, '\n');
  s = s.split('\n').map((line) => {
    if (line.indexOf('\r') < 0) return line;
    let result = '';
    for (const segment of line.split('\r')) {
      if (!segment) continue;
      if (segment.length >= result.length) result = segment;
      else result = segment + result.slice(segment.length);
    }
    return result;
  }).join('\n');
  s = s.replace(/.\x08/g, '');                  // backspace
  s = s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ''); // C0 except \n \t
  s = s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.split('\n').reduce((acc, line) => {
    if (acc.length && acc[acc.length - 1] === line) return acc;
    acc.push(line);
    return acc;
  }, []).join('\n');
  return s.trim();
}

function _sliceBetweenSlashAndDivider(text, slashCommand) {
  if (!text) return null;
  const lines = text.split('\n');
  let start = 0;
  if (slashCommand) {
    const escaped = slashCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const slashRe = new RegExp(`(^|[^A-Za-z0-9_:-])${escaped}(\\s|$)`);
    for (let i = 0; i < lines.length; i++) {
      if (slashRe.test(lines[i])) { start = i; break; }
    }
  }
  const dividerRe = /^[\s─]{30,}$/;
  // Skip past the prompt-frame divider after the typed input (within 5 lines).
  let panelStart = start + 1;
  for (let j = start + 1; j < Math.min(start + 6, lines.length); j++) {
    if (dividerRe.test(lines[j])) { panelStart = j + 1; break; }
  }
  const STATUS_VERBS = /^(?:Cogit|Cook|Crunch|Churn|Ponder|Think|Reflect|Refresh|Scan|Proof|Brew|Bake|Boil|Bubbl|Distil|Ferment|Marinat|Mull|Roast|Simmer|Steep|Stir|Whisk|Process|Working|Loading|Computing|Resolving|Analy[zs])/i;
  const isChrome = (line) => {
    const t = line.trim();
    if (t === '') return true;
    if (dividerRe.test(line)) return true;
    if (t === '❯' || t === '>') return true;
    if (/^\?\s+for\s+shortcuts/.test(t)) return true;
    if (/^Status\s+dialog\s+dismissed$/.test(t)) return true;
    if (/^[Ee]sc\s+to\s+(cancel|interrupt)/.test(t)) return true;
    // ≤3-char lines are spinner cursor-positioning artifacts, not real panel content.
    if (t.length <= 3) return true;
    if (STATUS_VERBS.test(t)) return true;
    return false;
  };
  let end = lines.length;
  while (end > panelStart && isChrome(lines[end - 1])) end--;
  while (panelStart < end && isChrome(lines[panelStart])) panelStart++;
  if (end <= panelStart) return null;
  const sliced = lines.slice(panelStart, end);
  return sliced.length ? sliced.join('\n') : null;
}

function _formatSlashAuditText({ slashCommand, args, target, resolved, skipped }) {
  const cmdLine = args ? `${slashCommand} ${args}` : slashCommand;
  const targetExpr = `@${target}`;
  const resolvedCsv = resolved.length ? ` (${resolved.join(', ')})` : ' (none)';
  let txt = `human → ${cmdLine} ${targetExpr}${resolvedCsv}`;
  if (skipped.length) {
    const parts = skipped.map((s) => `${s.name} (${s.reason})`);
    txt += ` — skipped: ${parts.join(', ')}`;
  }
  return txt;
}

async function sendSlash({ slashCommand, target, args }) {
  const { resolved, skipped } = _resolveTargets(target, SELECTED_ROOM);
  if (!resolved.length) {
    addMessage({
      from: 'system',
      to: HUMAN_NAME,
      text: `Slash send aborted: no live target for ${slashCommand} @${target} in room`,
      ts: _formatTimestamp(),
    });
    return false;
  }

  if (DESTRUCTIVE_SLASH_COMMANDS.has(slashCommand) && resolved.length > 1) {
    if (typeof askConfirm !== 'function') return false;
    const ok = await askConfirm(
      `Run ${slashCommand}?`,
      `About to run ${slashCommand} on ${resolved.length} agents: ${resolved.join(', ')}. This wipes context per agent. Continue?`
    );
    if (!ok) return false;
  }

  // Non-captureable commands need a reply directive so the agent posts back via mcp__chatbridge__post.
  const REPLY_DIRECTIVE = 'answer in chatbridge';
  const captureable = _CAPTUREABLE_SLASH_COMMANDS.has(slashCommand);
  const hasDirective = args && args.toLowerCase().includes(REPLY_DIRECTIVE);
  let effectiveArgs = args;
  if (!captureable && !hasDirective) {
    effectiveArgs = args ? `${args} - ${REPLY_DIRECTIVE}` : `- ${REPLY_DIRECTIVE}`;
  }
  const cmdText = effectiveArgs ? `${slashCommand} ${effectiveArgs}` : slashCommand;
  const payload = cmdText + '\r';
  const pty = _ptyBridge();

  // Heal stuck `window-size manual` from a previous interrupted capture before each slash-send.
  if (pty.ptyHealGeometry) {
    await Promise.all(resolved.map((agent) =>
      pty.ptyHealGeometry(agent).catch(() => {})));
  }

  // Split write so the lone \r registers as Enter, not as a newline inside a buffered paste.
  async function _writeAsTyped(agent) {
    await pty.ptyWrite(agent, pty.strToB64(cmdText));
    await new Promise((r) => setTimeout(r, 60));
    await pty.ptyWrite(agent, pty.strToB64('\r'));
  }

  if (!captureable) {
    const failures = [];
    await Promise.all(resolved.map(async (agent) => {
      try { await _writeAsTyped(agent); }
      catch (e) { failures.push({ name: agent, reason: e?.message || String(e) }); }
    }));
    const finalResolved = resolved.filter((n) => !failures.find((f) => f.name === n));
    const finalSkipped = [...skipped, ...failures];
    addMessage({
      from: 'system',
      to: HUMAN_NAME,
      text: _formatSlashAuditText({
        slashCommand, args, target,
        resolved: finalResolved, skipped: finalSkipped,
      }),
      ts: _formatTimestamp(),
    });
    return true;
  }

  addMessage({
    from: 'system',
    to: HUMAN_NAME,
    text: _formatSlashAuditText({
      slashCommand, args, target,
      resolved, skipped,
    }),
    ts: _formatTimestamp(),
  });

  // Detached per-agent capture so the audit appears immediately while panels trickle in.
  for (const agent of resolved) {
    (async () => {
      try {
        const result = await pty.ptyCaptureTurn(agent, payload, _CAPTURE_TIMEOUT_MS);
        if (!result || !result.log_path) return;
        let raw = '';
        try {
          raw = await pty.ptyReadCapture(result.log_path, null);
        } catch (e) {
          console.error(`[slash-command] read capture for ${agent}:`, e);
          return;
        }
        const stripped = _stripAnsi(raw);
        const body = _sliceBetweenSlashAndDivider(stripped, slashCommand) || stripped;
        if (!body || !body.trim()) return;
        addMessage({
          from: agent,
          to: HUMAN_NAME,
          text: `\`\`\`\n${body}\n\`\`\``,
          ts: _formatTimestamp(),
        });
      } catch (e) {
        const reason = e?.message ?? String(e);
        addMessage({
          from: 'system',
          to: HUMAN_NAME,
          text: `[capture failed for ${agent}] ${reason}`,
          ts: _formatTimestamp(),
        });
      }
    })();
  }
  return true;
}

// Order matters: check "plan" and "accept edits" before "auto" so specific labels win.
function _detectMode(rawBytes) {
  const stripped = _stripAnsi(rawBytes || '');
  const hay = stripped.toLowerCase();
  if (hay.includes('plan mode on')) return 'Plan';
  if (hay.includes('accept edits on')) return 'Accept Edits';
  if (hay.includes('auto mode on')) return 'Auto';
  return 'Normal';
}

// CSI `\x1B[Z` cycles claude modes (Normal → Auto-Accept → Plan → Normal); we read the redrawn footer.
async function sendShiftTab({ target }) {
  const { resolved, skipped } = _resolveTargets(target, SELECTED_ROOM);
  if (!resolved.length) {
    addMessage({
      from: 'system',
      to: HUMAN_NAME,
      text: `Shift+Tab aborted: no live target for @${target} in room`,
      ts: _formatTimestamp(),
    });
    return false;
  }
  const pty = _ptyBridge();
  if (pty.ptyHealGeometry) {
    await Promise.all(resolved.map((a) => pty.ptyHealGeometry(a).catch(() => {})));
  }
  const b64 = pty.strToB64('\x1B[Z');
  const failures = [];
  await Promise.all(resolved.map(async (agent) => {
    try { await pty.ptyWrite(agent, b64); }
    catch (e) { failures.push({ name: agent, reason: e?.message || String(e) }); }
  }));
  const finalResolved = resolved.filter((n) => !failures.find((f) => f.name === n));
  const finalSkipped = [...skipped, ...failures];

  const modeReads = pty.ptyTapRead
    ? await Promise.all(finalResolved.map(async (agent) => {
        try {
          // Delay so claude has time to render the footer redraw.
          await new Promise((r) => setTimeout(r, 80));
          const raw = await pty.ptyTapRead(agent, 250);
          return `${agent}: ${_detectMode(raw)}`;
        } catch {
          return agent;
        }
      }))
    : finalResolved;

  const targetExpr = `@${target}`;
  const resolvedCsv = modeReads.length ? ` → ${modeReads.join(', ')}` : ' (none)';
  let txt = `human → Shift+Tab ${targetExpr}${resolvedCsv}`;
  if (finalSkipped.length) {
    const parts = finalSkipped.map((s) => `${s.name} (${s.reason})`);
    txt += ` — skipped: ${parts.join(', ')}`;
  }
  addMessage({
    from: 'system',
    to: HUMAN_NAME,
    text: txt,
    ts: _formatTimestamp(),
  });
  return true;
}
