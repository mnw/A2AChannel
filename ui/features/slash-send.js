// slash-send.js — fan out a parsed slash send to one or more agent PTYs via
// the deterministic-tui-capture orchestrator (`pty_capture_turn`). Bypasses
// the hub channel entirely. Tier 2 of index.html.
//
// Capture flow per agent:
//   1. pty_capture_turn(agent, payload) — Tauri command coordinates tmux
//      geometry override (240×100), pipe-pane teeing to a per-capture file,
//      input injection, marker-driven completion detection (alt-screen
//      exit / idle-prompt / quiescence circuit-breaker), restore. Returns
//      { log_path, status }.
//   2. pty_read_capture(log_path) — reads the captured bytes (size-capped).
//   3. stripAnsi() — flattens the byte stream to readable text. The bytes
//      are already clean (claude rendered into a 240×100 buffer, no
//      narrow-width self-corruption), so a simple ANSI strip recovers
//      the panel content faithfully.
//   4. Slice between typed `/cmd` line and the trailing prompt frame.
//   5. Post to chat as a `[a2a-capture]` row in a markdown code fence.
//
// Depends on (declared earlier):
//   from state.js — input, sendBtn, HUMAN_NAME, SELECTED_ROOM
//   from messages.js — addMessage
//   from slash-mode.js — parseSlashMessage, resolveTargets
//   from slash-discovery.js — DESTRUCTIVE_SLASH_COMMANDS
//   window.__A2A_TERM__.pty.{ptyCaptureTurn, ptyReadCapture, ptyWrite, strToB64}
//   askConfirm — declared in core/state.js (custom confirm modal)
//
// Exposes:
//   sendSlash, formatSlashAuditText, stripAnsi

const _CAPTURE_TIMEOUT_MS = 15_000;

function _ptyBridge() {
  const pty = window.__A2A_TERM__?.pty;
  if (!pty?.ptyCaptureTurn || !pty?.ptyReadCapture) {
    throw new Error('PTY capture bridge not available');
  }
  return pty;
}

function _formatTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Minimal ANSI strip for clean-width capture bytes. Because the source was
// rendered into a 240×100 buffer (no overlap-collapse), cursor-position
// moves can be flattened to newlines without losing 2D structure.
//   - CSI cursor moves (CUP/HVP) → newline (preserves row separation)
//   - CSI relative row moves (CUU/CUD/CNL/CPL) → newline
//   - CSI column-only moves (CUF/CUB/CHA) → space
//   - All other CSI/OSC/ESC → drop
//   - CRLF → LF; bare CR → in-place overwrite per line
function stripAnsi(text) {
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

// Slice the cleaned text between the typed slash command and the prompt
// frame that follows the panel. Drops surrounding chrome.
function sliceBetweenSlashAndDivider(text, slashCommand) {
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
  // Step over the prompt-frame divider that follows the typed input. Look
  // ahead up to 5 lines for it; if found, skip past it. If not, use start+1.
  let panelStart = start + 1;
  for (let j = start + 1; j < Math.min(start + 6, lines.length); j++) {
    if (dividerRe.test(lines[j])) { panelStart = j + 1; break; }
  }
  // Trim trailing chrome from the bottom: dividers, lone `❯`, hints,
  // status-dialog markers, blank lines.
  const isChrome = (line) => {
    const t = line.trim();
    if (t === '') return true;
    if (dividerRe.test(line)) return true;
    if (t === '❯' || t === '>') return true;
    if (/^\?\s+for\s+shortcuts/.test(t)) return true;
    if (/^Status\s+dialog\s+dismissed$/.test(t)) return true;
    if (/^Esc\s+to\s+(cancel|interrupt)/.test(t)) return true;
    return false;
  };
  let end = lines.length;
  while (end > panelStart && isChrome(lines[end - 1])) end--;
  if (end <= panelStart) return null;
  const sliced = lines.slice(panelStart, end);
  return sliced.length ? sliced.join('\n') : null;
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
  const { resolved, skipped } = resolveTargets(target, SELECTED_ROOM);
  if (!resolved.length) {
    addMessage({
      from: 'system',
      to: HUMAN_NAME,
      text: `Slash send aborted: no live target for ${slashCommand} @${target} in room`,
      ts: _formatTimestamp(),
    });
    return false;
  }

  // Destructive confirm: command in destructive set AND target plural.
  if (DESTRUCTIVE_SLASH_COMMANDS.has(slashCommand) && resolved.length > 1) {
    if (typeof askConfirm !== 'function') return false;
    const ok = await askConfirm(
      `Run ${slashCommand}?`,
      `About to run ${slashCommand} on ${resolved.length} agents: ${resolved.join(', ')}. This wipes context per agent. Continue?`
    );
    if (!ok) return false;
  }

  const payload = (args ? `${slashCommand} ${args}` : slashCommand) + '\r';
  const pty = _ptyBridge();

  // Audit row first — appears immediately, before per-agent captures
  // resolve. Capture results trickle in as separate chat rows.
  addMessage({
    from: 'system',
    to: HUMAN_NAME,
    text: formatSlashAuditText({
      slashCommand, args, target,
      resolved, skipped,
    }),
    ts: _formatTimestamp(),
  });

  // Per-agent capture: pty_capture_turn drives geometry + pipe-pane +
  // marker-driven completion; then we read the file and clean it.
  // Detached so the audit appears immediately and panel content trickles in.
  for (const agent of resolved) {
    (async () => {
      try {
        const result = await pty.ptyCaptureTurn(agent, payload, _CAPTURE_TIMEOUT_MS);
        if (!result || !result.log_path) return;
        let raw = '';
        try {
          raw = await pty.ptyReadCapture(result.log_path, null);
        } catch (e) {
          console.error(`[slash-send] read capture for ${agent}:`, e);
          return;
        }
        const stripped = stripAnsi(raw);
        const body = sliceBetweenSlashAndDivider(stripped, slashCommand) || stripped;
        if (!body || !body.trim()) return;
        const statusBadge = (result.status === 'timeout' || result.status === 'quiescence')
          ? ` _(${result.status})_`
          : '';
        addMessage({
          from: agent,
          to: HUMAN_NAME,
          text: `**[a2a-capture]**${statusBadge}\n\`\`\`\n${body}\n\`\`\``,
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
