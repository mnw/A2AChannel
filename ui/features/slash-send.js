// slash-send.js — fan out a parsed slash send to one or more agent PTYs via
// the existing pty_write Tauri command. Bypasses the hub channel entirely.
// After writing, captures the agent's PTY output for a quiescence window
// and posts the (ANSI-stripped) result back into the chat as a message
// from the agent. Tier 2 of index.html.
//
// Depends on (declared earlier):
//   from state.js — input, sendBtn, HUMAN_NAME, SELECTED_ROOM
//   from messages.js — addMessage
//   from slash-mode.js — parseSlashMessage, resolveTargets
//   from slash-discovery.js — DESTRUCTIVE_SLASH_COMMANDS,
//                              discoverCommandsForRoom
//   window.__A2A_TERM__.pty.{ptyWrite, strToB64, b64ToBytes}
//   askConfirm — declared in core/state.js (custom confirm modal)
//
// Exposes:
//   sendSlash, formatSlashAuditText, captureSlashResponse, stripAnsi

const _SLASH_QUIET_MS      = 12000;  // close window after this much silence
const _SLASH_HARD_MS       = 90000;  // absolute cap (network-bound commands)
const _SLASH_FIRST_BYTE_MS = 12000;  // wait this long for first byte before giving up

function _ptyWriter() {
  const pty = window.__A2A_TERM__?.pty;
  if (!pty?.ptyWrite || !pty?.strToB64) {
    throw new Error('PTY bridge not available');
  }
  return pty;
}

function _formatTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Render the captured raw bytes into a fresh oversized headless xterm and
// extract whatever was written. Per-capture (not singleton) so state from
// previous slash sends — alt-buffer contents, scroll regions, modes —
// can't leak in and corrupt the rendering.
//
// Headless term is 200 cols × 200 rows + 1000 lines of scrollback, more
// than enough for any TUI panel. We sniff which buffer (alt vs normal)
// claude ended up writing to and prefer alt (TUI panels live there);
// inline output (e.g. /cost) lands in normal.
//
// After choosing a buffer, slice the output between two anchors:
//   - START: the line where the typed slash command appears (e.g. `❯ /context`)
//   - END:   the last divider line `─────────…` that frames claude's
//            prompt area (the visible UI footer below the response)
// Everything between those anchors is the actual command output. This
// strips the prompt-frame cruft that otherwise contaminates the mirror.
async function captureViaHeadless(rawText, slashCommand) {
  const Terminal = window.Terminal;
  if (!Terminal || !rawText) return null;
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed; left:-99999px; top:-99999px; width:2400px; height:6000px; opacity:0; pointer-events:none;';
  document.body.appendChild(div);
  const term = new Terminal({
    cols: 200,
    rows: 200,
    scrollback: 1000,
    allowProposedApi: true,
  });
  term.open(div);
  return new Promise((resolve) => {
    term.write(rawText, () => {
      try {
        const altBuf = term.buffer.alternate;
        const normBuf = term.buffer.normal;
        const altLines = altBuf ? readBufferLines(altBuf) : [];
        const normLines = normBuf ? readBufferLines(normBuf) : [];
        // Pick the buffer that actually contains the typed slash command.
        // Some commands write into normal buffer (inline output, /context,
        // /usage with `⎿` tool-result prefix), some into alt (full-screen
        // modal panels like /model, /clear-confirm). The wrong-buffer
        // pick produces stale content.
        const sliceN = sliceBetweenSlashAndPromptFrame(normLines, slashCommand);
        const sliceA = sliceBetweenSlashAndPromptFrame(altLines, slashCommand);
        // Prefer whichever slice is longer — if both contain the cmd, the
        // one with more content wins (full panel vs partial echo).
        const choice =
          (sliceN && sliceA)
            ? (sliceN.length >= sliceA.length ? sliceN : sliceA)
            : (sliceN || sliceA);
        resolve(choice);
      } finally {
        try { term.dispose(); } catch {}
        try { div.remove(); } catch {}
      }
    });
  });
}

// Strip ANSI from raw PTY bytes, split into lines, and slice between the
// typed `/cmd` line and the last prompt-frame divider. Returns the clean
// content or null if the slice is empty. This is the primary capture
// path — chosen over the headless-xterm renderer because the latter
// faithfully reproduces claude's at-width cursor-positioning overlays
// (visual collisions like "(0.9%)" landing at col 0 of the next row).
// Stripping ANSI discards positioning entirely, leaving just text chars
// in write order — coarse but uncorrupted.
function stripAndSlice(rawText, slashCommand) {
  const stripped = stripAnsi(rawText);
  if (!stripped) return null;
  const lines = stripped.split('\n');
  // Collapse runs of repeated whitespace inside each line so two-column
  // gaps look readable but don't break word identity.
  const tightened = lines.map((l) => l.replace(/\s{2,}/g, '  '));
  return sliceBetweenSlashAndPromptFrame(tightened, slashCommand);
}

// Slice between the slash-command anchor (or first non-empty line, if
// anchor not found) and the prompt-frame divider above the `❯` input
// area. Drops surrounding cruft (claude TUI's "shortcuts" hint, prompt
// frame, autocompact buffer line, etc.).
function sliceBetweenSlashAndPromptFrame(lines, slashCommand) {
  if (!Array.isArray(lines) || !lines.length) return null;
  // START anchor: first line containing the typed slash command after
  // claude's prompt indicator (`❯` or `>`). Match on `slashCommand` as a
  // word boundary so we don't false-positive on substrings.
  let start = 0;
  if (slashCommand) {
    const escaped = slashCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const slashRe = new RegExp(`(^|[^A-Za-z0-9_:-])${escaped}(\\s|$)`);
    for (let i = 0; i < lines.length; i++) {
      if (slashRe.test(lines[i])) { start = i; break; }
    }
  }
  // END anchor: scan from the bottom up for the LAST horizontal divider
  // line that's >= 30 box-drawing dashes — that's claude's prompt frame.
  // Everything below is the input area + shortcuts hint, not response.
  const dividerRe = /^[\s─]{30,}$/;
  let end = lines.length;
  for (let i = lines.length - 1; i >= start; i--) {
    if (dividerRe.test(lines[i])) { end = i; break; }
  }
  let sliced = lines.slice(start, end);
  // Trim leading/trailing blank lines that survived the slice.
  while (sliced.length && !sliced[0].trim()) sliced.shift();
  while (sliced.length && !sliced[sliced.length - 1].trim()) sliced.pop();
  return sliced.length ? sliced.join('\n') : null;
}

// Snapshot baseline state of the agent's xterm BEFORE writing the slash
// command. Used for diff-based extraction — we record buffer lengths so we
// can return only what was added/changed in response.
//
// Returns { normalLen, altLen, altLastLine } or null if no terminal.
function captureBaseline(agent) {
  const term = window.__A2A_TERM__?.getTerm?.(agent);
  if (!term) return null;
  try {
    return {
      normalLen: term.buffer.normal.length,
      altLen:    term.buffer.alternate?.length || 0,
      altLastLine: term.buffer.alternate?.length
        ? (term.buffer.alternate.getLine(term.buffer.alternate.length - 1)?.translateToString(true) || '')
        : '',
    };
  } catch { return null; }
}

// Diff the agent's xterm buffer against `baseline` and return the response
// content. Two extraction paths:
//   1. INLINE PANEL (normal buffer grew): claude printed the panel as new
//      lines into the scrollback. Return lines [baseline.normalLen, end).
//   2. ALT BUFFER (alt now has content that's different from baseline): a
//      TUI panel was painted into the alternate screen. Return alt buffer
//      contents whole. xterm.js retains alt content even after switch-back.
//
// Returns null when the agent has no mounted terminal.
function snapshotResponse(agent, baseline) {
  const term = window.__A2A_TERM__?.getTerm?.(agent);
  if (!term) return null;
  try {
    const norm = term.buffer.normal;
    const alt = term.buffer.alternate;
    // Path 1 — normal buffer grew.
    if (baseline && norm.length > baseline.normalLen) {
      const lines = [];
      for (let i = baseline.normalLen; i < norm.length; i++) {
        const line = norm.getLine(i);
        if (!line) continue;
        lines.push(line.translateToString(true));
      }
      // Drop the typed-command line if it survived as the head of the
      // diff (claude usually clears it but some commands echo it back).
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      if (lines.length) return lines.join('\n');
    }
    // Path 2 — alt buffer differs.
    if (alt && alt.length > 0) {
      const lastIdx = alt.length - 1;
      const lastNow = alt.getLine(lastIdx)?.translateToString(true) || '';
      const altChanged =
        !baseline ||
        alt.length !== baseline.altLen ||
        lastNow !== baseline.altLastLine;
      if (altChanged) {
        const altLines = readBufferLines(alt);
        if (altLines.length) return altLines.join('\n');
      }
    }
    return null;
  } catch { return null; }
}

function readBufferLines(buffer) {
  if (!buffer) return [];
  const out = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    out.push(line.translateToString(true));
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  while (out.length && !out[0].trim()) out.shift();
  return out;
}

// Best-effort ANSI / control-sequence strip. Removes:
//   - CSI sequences (`\x1B[…<final>`)
//   - OSC sequences (`\x1B]…\x07` or `\x1B]…\x1B\\`)
//   - Character-set selection (`\x1B(B`, `\x1B)0`, `\x1B*`, `\x1B+`)
//   - DECKPAM/DECKPNM (`\x1B=`, `\x1B>`)
//   - DECSC/DECRC (`\x1B7`, `\x1B8`)
//   - Other ANSI X3.64 ESC sequences (intermediate 0x20-0x2F + final 0x30-0x7E)
//   - Bare control chars except newline + tab
// Then collapses runs of blank lines to two max.
function stripAnsi(text) {
  if (!text) return '';
  let s = text;
  // BEFORE CSI strip: convert cursor-position moves to newlines so content
  // written to different rows doesn't run together. Claude's TUI uses
  // \x1B[<row>;<col>H (or \x1B[<row>H, or \x1B[H for home) to move between
  // rows. We treat each absolute-position move as a row separator, which
  // gives us "one logical line per claude-row" without needing a real
  // terminal emulator. Same for vertical moves: \x1B[<n>A (up), \x1B[<n>B
  // (down), \x1B[<n>E (next line), \x1B[<n>F (prev line) — row changes.
  // Horizontal-only moves (\x1B[<n>C, \x1B[<n>D, \x1B[<n>G) become a
  // single space so columns don't smash but rows don't proliferate.
  s = s.replace(/\x1B\[(\d*);?\d*H/g, '\n');     // CUP / HVP — absolute position
  s = s.replace(/\x1B\[\d*[ABEF]/g, '\n');         // CUU / CUD / CNL / CPL — row delta
  s = s.replace(/\x1B\[\d*[CDG]/g, ' ');           // CUF / CUB / CHA — column-only
  s = s.replace(/\x1B\[s|\x1B\[u/g, '');           // SCP / RCP — save/restore (drop)
  // CSI: ESC [ params... intermediates final  (color codes, modes, etc.)
  s = s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  // OSC ... BEL or ST
  s = s.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '');
  // ANSI X3.64 ESC sequences: ESC + intermediate-bytes (0x20-0x2F)* + final (0x30-0x7E).
  // Catches \x1B(B (charset), \x1B7 (save cursor), \x1B=, \x1BD, etc.
  s = s.replace(/\x1B[ -/]*[0-~]/g, '');
  // Any remaining stray ESC.
  s = s.replace(/\x1B/g, '');
  // CRLF → LF (single newline, no overwrite semantics).
  s = s.replace(/\r\n/g, '\n');
  // Process bare CR per-line as "cursor to col 0; subsequent chars overwrite
  // from there" — preserving the visible final state of progressive
  // re-renders (e.g. [READY]\r[VERIFIED] → [VERIFIED], not [READY][VERIFIED]).
  // If the new segment is shorter than the existing line, the tail of the
  // existing line remains visible (matches terminal-emulator behavior).
  s = s.split('\n').map((line) => {
    if (line.indexOf('\r') < 0) return line;
    let result = '';
    for (const segment of line.split('\r')) {
      if (!segment) continue;
      if (segment.length >= result.length) {
        result = segment;
      } else {
        result = segment + result.slice(segment.length);
      }
    }
    return result;
  }).join('\n');
  // Strip backspaces by collapsing them with the preceding character.
  s = s.replace(/.\x08/g, '');
  // Drop other C0 controls except \n and \t.
  s = s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  // Trim trailing whitespace per line.
  s = s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
  // Collapse 3+ consecutive blank lines to 2.
  s = s.replace(/\n{3,}/g, '\n\n');
  // De-duplicate consecutive identical lines — claude often re-renders the
  // same line during progressive loading (e.g. /usage's "Scanning sessions…"
  // updates 5 times in 1 second). Keeping each render in chat is noise.
  s = s.split('\n').reduce((acc, line) => {
    if (acc.length && acc[acc.length - 1] === line) return acc;
    acc.push(line);
    return acc;
  }, []).join('\n');
  return s.trim();
}

// Tee the per-agent PTY output stream and resolve with the captured text.
// Timing model:
//   - Wait up to _SLASH_FIRST_BYTE_MS for the FIRST output byte to arrive.
//     Network-bound commands like /usage and /cost can sit silent for
//     several seconds before claude renders the response.
//   - Once first output arrives, start the quiescence clock. Resolve when
//     no new output has arrived for _SLASH_QUIET_MS.
//   - Absolute cap _SLASH_HARD_MS regardless.
//
// Event payload shape matches terminal.js:524 — `e.payload.b64`. Tauri
// emits the same event to every listener, so this tee runs alongside the
// xterm renderer without disturbing it.
async function captureSlashResponse(agent) {
  const event = window.__TAURI__?.event;
  if (!event?.listen) return '';
  const pty = window.__A2A_TERM__?.pty;
  if (!pty?.b64ToBytes) return '';
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let collected = '';
  let firstByteAt = null;
  let lastWrite = null;
  const startedAt = Date.now();
  const unlisten = await event.listen(`pty://output/${agent}`, (e) => {
    try {
      const b64 = e.payload?.b64 ?? e.payload;
      if (typeof b64 !== 'string') return;
      const bytes = pty.b64ToBytes(b64);
      const text = decoder.decode(bytes, { stream: true });
      collected += text;
      const now = Date.now();
      if (firstByteAt === null) firstByteAt = now;
      lastWrite = now;
    } catch { /* ignore decode error */ }
  });
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(timer);
      clearTimeout(hardTimer);
      try { unlisten(); } catch {}
      resolve(collected);
    };
    const timer = setInterval(() => {
      const now = Date.now();
      // No first byte yet — only give up once first-byte budget exhausted.
      if (firstByteAt === null) {
        if (now - startedAt >= _SLASH_FIRST_BYTE_MS) finish();
        return;
      }
      // Have first byte — close on quiescence.
      if (now - lastWrite >= _SLASH_QUIET_MS) finish();
    }, 250);
    const hardTimer = setTimeout(finish, _SLASH_HARD_MS);
  });
}

function formatSlashAuditText({ slashCommand, args, target, resolved, skipped }) {
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
  let { resolved, skipped } = resolveTargets(target, SELECTED_ROOM);
  if (!resolved.length) {
    addMessage({
      from: 'system',
      to: HUMAN_NAME,
      text: `Slash send aborted: no live target for ${slashCommand} @${target} in room`,
      ts: _formatTimestamp(),
    });
    return false;
  }

  // Pre-flight availability filter: only target agents whose command
  // discovery (BUILTIN_SLASH_COMMANDS + .claude/commands/ + .claude/skills/
  // per cwd) actually contains this slash command. Otherwise we'd type
  // /unknown into agents that just respond with "Unknown command" — visible
  // failure for the user and noise in the chat audit.
  const roomMap = await discoverCommandsForRoom(SELECTED_ROOM);
  const supportSet = new Set();
  const unsupported = [];
  for (const agent of resolved) {
    const cmds = roomMap.get(agent);
    if (cmds && cmds.has(slashCommand)) supportSet.add(agent);
    else unsupported.push({ name: agent, reason: `doesn't have ${slashCommand}` });
  }
  resolved = resolved.filter((n) => supportSet.has(n));
  skipped = [...skipped, ...unsupported];

  if (!resolved.length) {
    const checked = unsupported.length ? unsupported.map((u) => u.name).join(', ') : '(none live)';
    addMessage({
      from: 'system',
      to: HUMAN_NAME,
      text: `Slash send aborted: no agent in this room has ${slashCommand} — checked: ${checked}`,
      ts: _formatTimestamp(),
    });
    return false;
  }

  // Destructive confirm: command in destructive set AND target plural.
  if (DESTRUCTIVE_SLASH_COMMANDS.has(slashCommand) && resolved.length > 1) {
    if (typeof askConfirm !== 'function') {
      // Fallback if main.js hasn't loaded yet (shouldn't happen at runtime).
      return false;
    }
    const ok = await askConfirm(
      `Run ${slashCommand}?`,
      `About to run ${slashCommand} on ${resolved.length} agents: ${resolved.join(', ')}. This wipes context per agent. Continue?`
    );
    if (!ok) return false;
  }

  const payload = (args ? `${slashCommand} ${args}` : slashCommand) + '\r';
  const pty = _ptyWriter();
  const b64 = pty.strToB64(payload);
  const failures = [];
  // Snapshot pre-write buffer baselines so we can diff after quiescence
  // and return only what was added in response (instead of dumping the
  // whole scrollback).
  const baselines = new Map();
  for (const agent of resolved) baselines.set(agent, captureBaseline(agent));
  // Start capture listeners BEFORE writing so we don't miss the leading
  // bytes of the response (claude can echo + start streaming within
  // milliseconds of the keystroke).
  const captures = new Map();
  for (const agent of resolved) {
    try { captures.set(agent, captureSlashResponse(agent)); }
    catch { /* event API unavailable — degrade silently */ }
  }
  await Promise.all(
    resolved.map(async (agent) => {
      try { await pty.ptyWrite(agent, b64); }
      catch (e) { failures.push({ name: agent, reason: e?.message || String(e) }); }
    })
  );

  // Compose final audit row. Treat write failures as additional skips so the
  // user sees what actually happened.
  const finalResolved = resolved.filter((n) => !failures.find((f) => f.name === n));
  const finalSkipped = [...skipped, ...failures];
  addMessage({
    from: 'system',
    to: HUMAN_NAME,
    text: formatSlashAuditText({
      slashCommand, args, target,
      resolved: finalResolved, skipped: finalSkipped,
    }),
    ts: _formatTimestamp(),
  });

  // Wait for each per-agent capture window to close, then post the captured
  // response back into chat as a message from that agent. Detached from the
  // send-completion path so the audit row appears immediately and
  // responses trickle in over the following seconds.
  //
  // Two-source extraction:
  //   1. Snapshot the agent's xterm visible buffer (preferred — preserves
  //      column layout because cursor moves are already resolved).
  //   2. Fall back to ANSI-stripping the captured raw bytes (used when the
  //      agent's tab isn't mounted yet; column layout will be collapsed).
  for (const agent of finalResolved) {
    const cap = captures.get(agent);
    if (!cap) continue;
    cap.then(async (raw) => {
      // Primary: render captured raw bytes through an oversized headless
      // xterm.js (200×200, 1000 lines scrollback). xterm.js processes the
      // cursor-positioning escapes the same way the visible terminal does,
      // so the resulting buffer mirrors what the human sees in xterm —
      // including aligned columns, padded grids, and the prompt frame.
      // We then slice between the typed /cmd line and the prompt-frame
      // divider, and trim trailing whitespace per row.
      let body = await captureViaHeadless(raw, slashCommand);
      if (!body) {
        // Fallback A: ANSI-strip with row-tracking + CR-overwrite handling.
        // Loses 2D layout but recovers content for cases where the headless
        // render produces nothing (e.g. claude wrote only to alt-buffer and
        // we're reading normal-buffer or vice versa).
        body = stripAndSlice(raw, slashCommand);
      }
      if (!body) {
        // Fallback B: visible terminal buffer diff (last resort).
        body = snapshotResponse(agent, baselines.get(agent));
      }
      if (!body || !body.trim()) return;
      addMessage({
        from: agent,
        to: HUMAN_NAME,
        text: '**[a2a-capture]** PTY → headless render → slice\n```\n' + body + '\n```',
        ts: _formatTimestamp(),
      });
    });
  }
  return true;
}
