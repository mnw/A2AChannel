// slash-send.js — fan parsed slash sends to agent PTYs via pty_capture_turn (bypassing the hub).

const _CAPTURE_TIMEOUT_MS = 15_000;

// Allowlist of fast panel-rendering commands safe for the capture orchestrator.
// Anything outside this set is multi-turn / conversational and would mis-fire on quiescence
// or get SIGWINCH-interrupted by cleanup_geometry mid-render — those use plain pty_write.
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

// Source rendered into 240×100 (no overlap-collapse), so cursor-moves flatten to newlines safely.
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
  const captureable = _CAPTUREABLE.has(slashCommand);
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
      text: formatSlashAuditText({
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
    text: formatSlashAuditText({
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

// Order matters: check "plan" and "accept edits" before "auto" so specific labels win.
function _detectMode(rawBytes) {
  const stripped = stripAnsi(rawBytes || '');
  const hay = stripped.toLowerCase();
  if (hay.includes('plan mode on')) return 'Plan';
  if (hay.includes('accept edits on')) return 'Accept Edits';
  if (hay.includes('auto mode on')) return 'Auto';
  return 'Normal';
}

// CSI `\x1B[Z` cycles claude modes (Normal → Auto-Accept → Plan → Normal); we read the redrawn footer.
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
