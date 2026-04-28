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

// Allowlist of slash commands that render a discrete panel and finish
// quickly (≤ a few seconds). These are safe to drive through the
// pty_capture_turn orchestrator — geometry forcing, completion-marker
// scanning, capture-and-mirror.
//
// Everything OUTSIDE this list — custom .claude/commands/, .claude/skills,
// MCP prompts (mcp__server__*), model-delegated commands like /openspec-* —
// generates a multi-turn conversational response that takes seconds to
// minutes. Capturing those would (a) prematurely fire on quiescence
// during claude's "thinking" pause, (b) SIGWINCH-interrupt claude when
// the orchestrator's cleanup_geometry fires mid-render. Those go through
// the simple v0.9.13 pty_write path: bytes injected, audit row posted,
// no capture; the response shows in the agent's terminal.
const _CAPTUREABLE = new Set([
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
  // Chrome predicate covers two classes:
  //   - Static prompt-frame elements: dividers, lone ❯, "? for shortcuts",
  //     "Esc to cancel", "Status dialog dismissed".
  //   - Dynamic "thinking" chrome between the prompt frame and the panel
  //     render: spinner frames (single symbol per cursor-move become
  //     single-char lines after ANSI strip) and labelled status rows
  //     ("Cogitated for 2s", "Crunched for 1s", "Churning…", etc).
  // Dynamic chrome appears AFTER the prompt-frame divider but BEFORE the
  // panel content, so we trim leading edges with the same rule used for
  // trailing.
  const STATUS_VERBS = /^(?:Cogit|Cook|Crunch|Churn|Ponder|Think|Reflect|Refresh|Scan|Proof|Brew|Bake|Boil|Bubbl|Distil|Ferment|Marinat|Mull|Roast|Simmer|Steep|Stir|Whisk|Process|Working|Loading|Computing|Resolving|Analy[zs])/i;
  const isChrome = (line) => {
    const t = line.trim();
    if (t === '') return true;
    if (dividerRe.test(line)) return true;
    if (t === '❯' || t === '>') return true;
    if (/^\?\s+for\s+shortcuts/.test(t)) return true;
    if (/^Status\s+dialog\s+dismissed$/.test(t)) return true;
    if (/^[Ee]sc\s+to\s+(cancel|interrupt)/.test(t)) return true;
    // Spinner-frame chrome: very short lines (1-3 visible chars) are
    // overwhelmingly cursor-positioning artifacts, never real panel
    // content. Real panel rows are ≥ 4 chars.
    if (t.length <= 3) return true;
    // Labelled status rows ("Cogitated for 2s", "Scanning sessions…").
    if (STATUS_VERBS.test(t)) return true;
    return false;
  };
  // Trim both edges. Forward-trim drops thinking-spinner chrome between
  // the prompt-frame divider and panel content; backward-trim drops the
  // post-panel idle prompt + hints + dismissal markers.
  let end = lines.length;
  while (end > panelStart && isChrome(lines[end - 1])) end--;
  while (panelStart < end && isChrome(lines[panelStart])) panelStart++;
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

  // For non-captureable commands (custom, MCP prompts, model-delegated),
  // append a chatbridge-reply directive so the agent posts its answer back
  // via mcp__chatbridge__post instead of leaving it stranded in the
  // terminal. Skip if the user already wrote the directive into the args
  // (so doubled phrasing doesn't sneak through). Captureable panel
  // commands (/context, /usage…) skip this — they're mirrored by the
  // capture orchestrator already.
  const REPLY_DIRECTIVE = 'answer in chatbridge';
  const captureable = _CAPTUREABLE.has(slashCommand);
  const hasDirective = args && args.toLowerCase().includes(REPLY_DIRECTIVE);
  let effectiveArgs = args;
  if (!captureable && !hasDirective) {
    effectiveArgs = args ? `${args} - ${REPLY_DIRECTIVE}` : `- ${REPLY_DIRECTIVE}`;
  }
  const cmdText = effectiveArgs ? `${slashCommand} ${effectiveArgs}` : slashCommand;
  const payload = cmdText + '\r';
  const pty = _ptyBridge();

  // Heal tmux geometry on every slash-send. If a previous capture orchestrator
  // run left the pane stuck in `window-size manual` mode, the visible xterm.js
  // viewport shows a sea of dots in the unused area around a tiny pane. Cheap
  // belt-and-suspenders fix — reasserts `latest` + resizes to active client
  // before each user-typed slash command.
  if (pty.ptyHealGeometry) {
    await Promise.all(resolved.map((agent) =>
      pty.ptyHealGeometry(agent).catch(() => {})));
  }

  // Send the slash command as if typed: text first, brief settle, then a
  // standalone \r. Claude's TUI buffers rapid multi-byte writes as a paste
  // (bracketed-paste-like behaviour) — when \r is the last byte of that
  // buffer it's treated as a newline IN the pasted content, not as Enter.
  // Splitting the write makes the lone \r register as "Enter after paste
  // settled" → submits the input.
  async function _writeAsTyped(agent) {
    await pty.ptyWrite(agent, pty.strToB64(cmdText));
    await new Promise((r) => setTimeout(r, 60));
    await pty.ptyWrite(agent, pty.strToB64('\r'));
  }

  // Non-captureable commands (custom commands, MCP prompts, model-delegated
  // work) take the simple path: write bytes, audit row, done. Response
  // renders in the agent's terminal naturally — no SIGWINCH interrupt
  // mid-stream from the orchestrator's cleanup.
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
      text: formatSlashAuditText({
        slashCommand, args, target,
        resolved: finalResolved, skipped: finalSkipped,
      }),
      ts: _formatTimestamp(),
    });
    return true;
  }

  // Captureable: audit first, then per-agent orchestrator + chat-mirror.
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

// Detect claude's current mode by scanning the captured pane content for
// the prompt-frame footer label. There are FOUR distinct modes — "Auto"
// and "Accept Edits" are separate, NOT the same:
//   - "plan mode on"     → Plan
//   - "accept edits on"  → Accept Edits
//   - "auto mode on"     → Auto
//   - none of the above  → Normal (no footer label is shown)
// Case-insensitive substring match. Order matters — check "plan" and
// "accept edits" before "auto" so the more specific labels win.
function _detectMode(rawBytes) {
  const stripped = stripAnsi(rawBytes || '');
  const hay = stripped.toLowerCase();
  if (hay.includes('plan mode on')) return 'Plan';
  if (hay.includes('accept edits on')) return 'Accept Edits';
  if (hay.includes('auto mode on')) return 'Auto';
  return 'Normal';
}

// Send the Shift+Tab key (CSI Cursor Backward Tabulation, `\x1B[Z`) to one
// or more agent PTYs. Claude uses this to cycle modes
// (Normal → Auto-Accept Edits → Plan → Normal). After the keypress, we
// briefly tap pipe-pane (~250ms) per agent to read claude's redrawn
// footer and report the actual new mode in the audit row — no client-side
// guessing, no drift.
async function sendShiftTab({ target }) {
  const { resolved, skipped } = resolveTargets(target, SELECTED_ROOM);
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

  // Read back the actual mode from each agent. After Shift+Tab, claude
  // redraws the prompt-frame footer with the new mode label; we tap
  // pipe-pane briefly to capture that redraw. Tap is fire-and-forget per
  // agent; we await all in parallel.
  const modeReads = pty.ptyTapRead
    ? await Promise.all(finalResolved.map(async (agent) => {
        try {
          // Small delay so claude has time to render the footer redraw.
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
