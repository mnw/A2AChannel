// xterm-themes.js — palette resolver reading --xterm-* tokens; new themes are pure CSS changes.

(function () {
  function read(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

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

  // --fs-terminal already includes --ui-font-scale (single source: tokens.css).
  function fontSize() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--fs-terminal').trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 13;
  }

  // PROTECTED chain (Nerd Font + Apple Symbols + Color Emoji); user override only PREPENDS.
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
