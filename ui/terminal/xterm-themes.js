// terminal/xterm-themes.js — xterm.js palette resolver. Reads the
// `--xterm-*` design tokens from CSS at the moment of call, so whichever
// `[data-theme=…]` is active drives the terminal colors automatically.
//
// One source of truth: tokens.css. Adding a new theme is a pure CSS change
// (a new `[data-theme="…"]` block); this file does not need updating.
//
// Exposes:
//   window.__A2A_TERM__.xtermThemes.current()    — palette for xterm.js
//   window.__A2A_TERM__.xtermThemes.fontSize()   — 12 × --ui-font-scale
//   window.__A2A_TERM__.xtermThemes.fontFamily() — user terminal_mono
//                                                  prepended to the
//                                                  protected fallback chain

(function () {
  function read(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  // The 19 keys xterm.js consumes. Maps 1:1 to --xterm-* CSS tokens.
  const KEY_TO_TOKEN = {
    background:     '--xterm-bg',
    foreground:     '--xterm-fg',
    cursor:         '--xterm-cursor',
    black:          '--xterm-black',
    red:            '--xterm-red',
    green:          '--xterm-green',
    yellow:         '--xterm-yellow',
    blue:           '--xterm-blue',
    magenta:        '--xterm-magenta',
    cyan:           '--xterm-cyan',
    white:          '--xterm-white',
    brightBlack:    '--xterm-bright-black',
    brightRed:      '--xterm-bright-red',
    brightGreen:    '--xterm-bright-green',
    brightYellow:   '--xterm-bright-yellow',
    brightBlue:     '--xterm-bright-blue',
    brightMagenta:  '--xterm-bright-magenta',
    brightCyan:     '--xterm-bright-cyan',
    brightWhite:    '--xterm-bright-white',
  };

  function current() {
    const out = {};
    for (const [key, token] of Object.entries(KEY_TO_TOKEN)) {
      out[key] = read(token);
    }
    return out;
  }

  // Terminal font size = the resolved value of --fs-terminal in tokens.css.
  // tokens.css aliases it to a step in the --fs-* scale, which already
  // includes the --ui-font-scale multiplier — no extra math needed here.
  // The single source of truth is tokens.css; this file just reads it.
  function fontSize() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--fs-terminal').trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 13;
  }

  // PROTECTED terminal font chain. Required so claude's TUI renders right:
  //   - CaskaydiaMono Nerd Font: Braille + box-drawing in claude's logo
  //   - JetBrains Mono / SF Mono / Menlo: monospace fallbacks
  //   - Apple Symbols: glyphs the Nerd Font lacks
  //   - Apple Color Emoji: emoji rendering
  // The user override (config.yml fonts.terminal_mono) is PREPENDED only —
  // it can never remove anything from this chain.
  const TERM_BASELINE =
    "'CaskaydiaMono Nerd Font', 'JetBrains Mono', 'SF Mono', Menlo, " +
    "'Apple Symbols', 'Apple Color Emoji', monospace";

  function fontFamily() {
    const user = getComputedStyle(document.documentElement)
      .getPropertyValue('--user-terminal-mono').trim();
    return user ? `${user}, ${TERM_BASELINE}` : TERM_BASELINE;
  }

  window.__A2A_TERM__ = window.__A2A_TERM__ || {};
  window.__A2A_TERM__.xtermThemes = { current, fontSize, fontFamily };
})();
