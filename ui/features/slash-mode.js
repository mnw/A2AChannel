// slash-mode.js — composer slash-mode state machine + parser + target
// resolver. Tier 2 of index.html.
//
// Slash mode activates when the composer's first character is `/` AND the
// composer was previously empty. Backspacing the leading `/` exits slash
// mode; Escape exits slash mode (handled by the keydown listener in
// composer.js).
//
// The slash send path bypasses the hub entirely — bytes go straight to the
// per-agent PTY via window.__A2A_TERM__.pty.ptyWrite. The channel is not
// involved.
//
// Depends on (declared earlier):
//   from state.js — input, ROSTER, SELECTED_ROOM, ROOM_ALL, presenceState,
//                   permissionCards, interruptCards
//
// Exposes:
//   isSlashMode, parseSlashMessage, resolveTargets,
//   busyAgents, slashTargetCandidates

function isSlashMode(textareaValue) {
  // Slash mode is active iff the composer starts with `/`. We deliberately do
  // not require "first character was just typed" — the composer's input event
  // fires on every keystroke, and any state where leading `/` is present is
  // slash mode. Mid-message slashes (e.g. `look at /etc/hosts`) don't
  // qualify because the leading char isn't `/`.
  return typeof textareaValue === 'string' && textareaValue.startsWith('/');
}

// Parse the composer text into (slashCommand, target, args). Tolerant of
// missing parts — returns nulls so the send-button gating can decide what
// inline error to show.
//
// slashCommand: leading `/word` (`[A-Za-z0-9_-]+`)
// target:       first `@word` after the slash command (validated to
//                `[A-Za-z0-9_.-]+`); `all` is reserved for broadcast
// args:         everything else, joined back with single spaces
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

// Set of agent names that are currently busy from the UI's perspective.
// Detection is best-effort and limited to states we explicitly track:
//   - has at least one pending permission card (verdict not given)
//   - has at least one pending interrupt card (not yet acked)
// Claude's internal modal states (mid-stream, slash-picker open, etc.) are
// invisible from outside the PTY and not detected.
function busyAgents() {
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

// Candidate slash targets in the selected room: live agents whose PTY we own
// (excludes external-state, the human, and the shell tab — none of which is
// an agent in the roster anyway). Used by both the @-popover (in slash mode)
// and resolveTargets.
function slashTargetCandidates(roomName) {
  return ROSTER.filter((a) => {
    if (a.room === null) return false;             // human
    if (roomName === ROOM_ALL) return false;       // slash mode requires concrete room
    if (a.room !== roomName) return false;
    if (!presenceState[a.name]) return false;       // offline / external (we don't own the PTY)
    return true;
  }).map((a) => a.name);
}

// Resolve a target token (the bare name without `@`) into the list of agent
// names to write to. `all` expands to live in-room agents minus the busy set.
// A bare name returns `[name]` if that agent is a valid candidate, else [].
function resolveTargets(target, roomName) {
  if (!target) return { resolved: [], skipped: [] };
  const candidates = slashTargetCandidates(roomName);
  if (target === 'all') {
    const busy = busyAgents();
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
