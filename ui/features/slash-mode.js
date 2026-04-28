// slash-mode.js — slash-mode state + parser + target resolver; sends bypass the hub via PTY.

function isSlashMode(textareaValue) {
  return typeof textareaValue === 'string' && textareaValue.startsWith('/');
}

// Shift+Tab pseudo-command sends `\x1B[Z` to cycle claude modes (Normal → Auto → Plan → Normal).
const SHIFT_TAB_PREFIX_RE = /^\s*shift[\s+_-]*tab\b/i;

function isShiftTabMode(textareaValue) {
  return typeof textareaValue === 'string' && SHIFT_TAB_PREFIX_RE.test(textareaValue);
}

// Mirrors parseSlashMessage shape; no command/args since Shift+Tab is a fixed key sequence.
function parseShiftTab(text) {
  const out = { target: null };
  if (!isShiftTabMode(text)) return out;
  const tail = text.replace(SHIFT_TAB_PREFIX_RE, '').trim();
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

// Best-effort: pending permission or interrupt cards. Claude's internal modal states are invisible.
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

// Live in-room agents whose PTY we own (excludes human, shell, external, offline).
function slashTargetCandidates(roomName) {
  return ROSTER.filter((a) => {
    if (a.room === null) return false;
    if (roomName === ROOM_ALL) return false;
    if (a.room !== roomName) return false;
    if (!presenceState[a.name]) return false;
    return true;
  }).map((a) => a.name);
}

// `all` expands to candidates minus busy set; bare name returns [name] if a candidate.
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
