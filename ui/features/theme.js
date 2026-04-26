// theme.js — applies UI settings (theme + font scale) sourced from
// config.yml via the get_ui_settings Tauri command. No UI cycle button:
// edit config.yml and click Reload (titlebar) to re-apply.
//
// tokens.css holds the palette overrides under `[data-theme="<name>"]` and
// multiplies every --fs-* by var(--ui-font-scale). This module just sets
// data-theme on <body> and writes --ui-font-scale to the document root.
//
// Exposes window.A2A_UI = { apply, reload }.

(function uiSettings() {
  const VALID = ['default', 'rose-pine-dawn', 'rose-pine-moon'];

  function applyTheme(name) {
    const safe = VALID.includes(name) ? name : 'default';
    if (safe === 'default') {
      document.body.removeAttribute('data-theme');
    } else {
      document.body.setAttribute('data-theme', safe);
    }
    document.dispatchEvent(
      new CustomEvent('a2a:theme-changed', { detail: { theme: safe } })
    );
  }

  function applyFontScale(scale) {
    const n = Number(scale);
    const safe = Number.isFinite(n) ? Math.min(1.25, Math.max(0.85, n)) : 1;
    document.documentElement.style.setProperty('--ui-font-scale', String(safe));
  }

  // Names from config.yml are pre-sanitized in Rust to [A-Za-z0-9 ._-];
  // wrapping in single quotes is sufficient. Empty string clears the slot
  // so the structural fallback in tokens.css applies.
  function applyUserFontVar(varName, name) {
    if (typeof name === 'string' && name.length > 0) {
      document.documentElement.style.setProperty(varName, `'${name}'`);
    } else {
      document.documentElement.style.removeProperty(varName);
    }
  }

  function applyFonts(fonts) {
    const f = fonts || {};
    applyUserFontVar('--user-sans', f.ui);
    // The same monospace value drives BOTH UI mono labels (--user-mono in
    // tokens.css) and the xterm.js panes (--user-terminal-mono, read via
    // getComputedStyle in xterm-themes.js).
    applyUserFontVar('--user-mono',          f.mono);
    applyUserFontVar('--user-terminal-mono', f.mono);
  }

  function apply(settings) {
    if (!settings) return;
    // Order matters: write --ui-font-scale + user fonts FIRST so listeners
    // on the theme-changed event (terminal.js) see the new values when
    // they re-read getComputedStyle in the same tick.
    applyFontScale(settings.font_scale);
    applyFonts(settings.fonts);
    applyTheme(settings.theme);
  }

  async function reload() {
    if (!window.__TAURI__) return;
    try {
      const s = await window.__TAURI__.core.invoke('get_ui_settings');
      apply(s);
    } catch (e) {
      console.warn('[ui] get_ui_settings failed', e);
    }
  }

  window.A2A_UI = { apply, reload };

  // Boot: pull settings from the shell as soon as Tauri is ready.
  if (window.__TAURI__) {
    reload();
  }
})();
