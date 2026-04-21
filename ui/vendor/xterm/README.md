# Vendored xterm.js

Single-file UMD builds, pinned. Loaded from `../src/index.html` via relative
`<script>` tags (no bundler, no CDN at runtime).

| File | Source | Version |
|---|---|---|
| `xterm.js` | `https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js` | 5.5.0 |
| `xterm.css` | `https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css` | 5.5.0 |
| `addon-fit.js` | `https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js` | 0.10.0 |

UMD loader populates `window.Terminal` (from `xterm.js`) and
`window.FitAddon.FitAddon` (from `addon-fit.js`).

To refresh: re-run the `curl -fsSLO` commands with the same URLs after
bumping the version number. Tauri 2's nonce-CSP accepts `<script src="...">`
against local paths under `'self'`.
