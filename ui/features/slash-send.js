// slash-send.js — fan out a parsed slash send to one or more agent PTYs via
// the existing pty_write Tauri command. Bypasses the hub channel entirely.
// Tier 2 of index.html.
//
// Depends on (declared earlier):
//   from state.js — input, sendBtn, HUMAN_NAME
//   from messages.js — addMessage
//   from slash-mode.js — parseSlashMessage, resolveTargets
//   from slash-discovery.js — DESTRUCTIVE_SLASH_COMMANDS
//   window.__A2A_TERM__.pty.{ptyWrite, strToB64}
//   askConfirm — declared in main.js (custom confirm modal)
//
// Exposes:
//   sendSlash, formatSlashAuditText

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
  return true;
}
