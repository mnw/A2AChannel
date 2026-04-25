// terminal/pty.js — Tauri-invoke wrappers for the PTY commands plus the
// base64 helpers used to push keystrokes to the master end. Tier 3, loads
// before terminal.js so the IIFE there can pull these via window.__A2A_TERM__.
//
// Depends on (declared earlier):
//   nothing — uses window.__TAURI__.core.invoke directly so it's standalone.
//
// Exposes:
//   window.__A2A_TERM__.pty = { ptySpawn, ptyWrite, ptyResize, ptyKill,
//                               ptyList, strToB64, b64ToBytes }

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
  window.__A2A_TERM__.pty = { ptySpawn, ptyWrite, ptyResize, ptyKill, ptyList, strToB64, b64ToBytes };
})();
