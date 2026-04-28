// terminal/pty.js — Tauri PTY-invoke wrappers + base64 helpers; standalone (window.__TAURI__).

(function () {
  function _invoke() {
    return window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  }

  async function ptySpawn(agent, cwd, sessionMode, room) {
    const args = { agent, cwd };
    if (sessionMode === 'resume' || sessionMode === 'continue') {
      args.sessionMode = sessionMode;
    }
    if (room) args.room = room;
    return _invoke()('pty_spawn', args);
  }
  async function ptyWrite(agent, b64) {
    return _invoke()('pty_write', { agent, b64 });
  }
  async function ptyResize(agent, cols, rows) {
    return _invoke()('pty_resize', { agent, cols, rows });
  }
  async function ptyKill(agent) {
    return _invoke()('pty_kill', { agent });
  }
  async function ptyList() {
    try { return await _invoke()('pty_list'); }
    catch { return []; }
  }
  // status ∈ { "alt-exit" | "idle-prompt" | "quiescence" | "timeout" }.
  async function ptyCaptureTurn(agent, input, timeoutMs) {
    return _invoke()('pty_capture_turn', {
      agent, input, timeoutMs: timeoutMs ?? null,
    });
  }
  // Path must start with /tmp/a2a/; maxBytes defaults to 256 KiB.
  async function ptyReadCapture(logPath, maxBytes) {
    return _invoke()('pty_read_capture', {
      logPath, maxBytes: maxBytes ?? null,
    });
  }
  // Idempotent; safe to call on every slash-send.
  async function ptyHealGeometry(agent) {
    try { return await _invoke()('pty_heal_geometry', { agent }); }
    catch (e) { console.warn('[pty] heal failed for', agent, e); }
  }
  // Short post-keypress footer reads (no geometry forcing); duration_ms clamped [50, 5000].
  async function ptyTapRead(agent, durationMs) {
    try { return await _invoke()('pty_tap_read', { agent, durationMs: durationMs ?? null }); }
    catch (e) { console.warn('[pty] tap-read failed for', agent, e); return ''; }
  }
  // Poll agent's pane until `pattern` (regex) matches or timeout.
  async function ptyAwaitPattern(agent, pattern, timeoutMs, pollIntervalMs) {
    return _invoke()('pty_await_pattern', {
      agent, pattern,
      timeoutMs: timeoutMs ?? null,
      pollIntervalMs: pollIntervalMs ?? null,
    });
  }
  // Resolves matched=true when pattern has been absent for N consecutive snapshots.
  async function ptyAwaitPatternAbsent(agent, pattern, timeoutMs, confirmations, pollIntervalMs) {
    return _invoke()('pty_await_pattern_absent', {
      agent, pattern,
      timeoutMs: timeoutMs ?? null,
      confirmations: confirmations ?? null,
      pollIntervalMs: pollIntervalMs ?? null,
    });
  }

  const encoder = new TextEncoder();
  function strToB64(str) {
    const bytes = encoder.encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  window.__A2A_TERM__ = window.__A2A_TERM__ || {};
  window.__A2A_TERM__.pty = {
    ptySpawn, ptyWrite, ptyResize, ptyKill, ptyList,
    ptyCaptureTurn, ptyReadCapture, ptyHealGeometry, ptyTapRead,
    ptyAwaitPattern, ptyAwaitPatternAbsent,
    strToB64, b64ToBytes,
  };
})();
