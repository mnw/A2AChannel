## ADDED Requirements

### Requirement: Two-column application layout preserved from v0.7.0

The A2AChannel webview SHALL retain the v0.7.0 two-column main-body structure: a Chat column (always visible) and an optional Terminal column (shown when the user toggles the header icon). A drag-resizable splitter SHALL separate the two when both are visible. The header, nutshell strip, and title-bar area SHALL span the full window width above the main body.

An earlier draft of this refresh added a three-column layout with a dedicated Activity Ledger rail; it was rejected after prototype because it duplicated every pending handoff (inline in chat + in the rail) without adding information. Handoff and interrupt cards SHALL continue to render inline in the chat stream exactly as v0.7.0 did.

#### Scenario: Terminal pane disabled

- **GIVEN** `localStorage.a2achannel_terminal_enabled` is `"false"` (or absent)
- **WHEN** the webview renders
- **THEN** the main body displays the Chat column at full width
- **AND** the Terminal column and splitter are hidden

#### Scenario: Terminal pane enabled

- **WHEN** the user clicks the terminal toggle icon in the header
- **THEN** `localStorage.a2achannel_terminal_enabled` is set to `"true"`
- **AND** the main body renders Chat + splitter + Terminal side-by-side
- **AND** the splitter remains drag-resizable within 25–75%

### Requirement: Header composition — brand, status, and roster

The header SHALL contain, in order: a brand area (icon + wordmark + version meta), a status cluster (live-count pill, MCP-configs button, settings button, reload button, terminal-toggle button), and a roster strip (agent pills with coloured dot + name, plus a `+ agent` affordance).

The status pill SHALL show `<N>/<M> agents · hub :<port>` where `N` is the count of online agents and `M` is the roster size. `<port>` is derived from the hub URL that `get_hub_url` returns.

Each agent pill SHALL display: a coloured dot (hash-derived colour matching the avatar in chat) and the agent name. The human's own pill SHALL be styled to indicate "you."

The brand mark SHALL render as an inline simplified SVG visually consistent with the app icon at `icon.svg`: a rounded-rect speech bubble outlined in orange, with three small dots in the palette colours (orange `#d97757`, amber `#e8a857`, green `#7fb069`) and a bottom-left tail.

#### Scenario: Status pill reflects hub state

- **GIVEN** the hub is reachable and 4 of 6 agents are online
- **WHEN** the status pill renders
- **THEN** it shows `4/6 agents · hub :<port>` with a green pulsing dot

#### Scenario: + agent launches the terminal-pane spawn modal

- **WHEN** the user clicks the `+ agent` button in the roster
- **THEN** the same spawn modal used by the terminal-pane tab strip opens (name + cwd picker)
- **AND** on submit, the existing `pty_spawn` flow runs unchanged

### Requirement: Nutshell strip is between header and main layout

The nutshell strip SHALL render as a full-width band between the header and the main body. It SHALL contain a `NUTSHELL` label tag (mono, small-caps), the nutshell body text (Fraunces serif italic), a meta line (version + author), and an Edit affordance.

The strip SHALL be hidden entirely when no nutshell has been set for the project.

#### Scenario: Nutshell set

- **GIVEN** the project nutshell is non-empty
- **WHEN** the webview renders
- **THEN** the nutshell strip is visible between header and main
- **AND** the body text renders in the Fraunces serif italic with the configured text
- **AND** the meta shows `v<N> · by <author>`
- **AND** clicking Edit opens the existing nutshell editor modal

#### Scenario: Nutshell empty

- **GIVEN** no nutshell has been set
- **WHEN** the webview renders
- **THEN** the nutshell strip is not displayed

### Requirement: Composer is a pill-mention + input + icon-actions row

The composer SHALL be organised as a flex row: a mention selector (the existing `<select id="target">` restyled as a pill), a flexible text input, icon-sized emoji and attachment buttons, and an orange Send button. A hints footer below the composer SHALL show keyboard shortcuts in `<kbd>` elements (Enter to send, Shift+Enter for newline, @name to target, no @ broadcasts).

All composer behaviour SHALL remain identical to v0.7.0: Enter sends, Shift+Enter inserts a newline, @name triggers the mention popover, paste/drop uploads an attachment.

#### Scenario: Keyboard send

- **WHEN** the user types "hello @alice" and presses Enter
- **THEN** the message is sent targeting `alice`
- **AND** the composer field clears

#### Scenario: Attachment via drop

- **WHEN** the user drops a file onto the composer
- **THEN** the existing drop overlay appears during drag
- **AND** on drop, the attachment chip renders and the file uploads on send

### Requirement: Visual-token system uses CSS custom properties

The stylesheet SHALL define palette and typography tokens as CSS custom properties on `:root`, including:
- Background layers: `--bg`, `--bg-raised`, `--bg-elev`, `--bg-inset`
- Borders: `--line`, `--line-soft`
- Text: `--text`, `--text-muted`, `--text-dim`
- Accents: `--orange`, `--orange-soft`, `--amber`, `--green`, `--red`, `--blue`, `--purple`, `--pink`, `--teal`
- Font stacks: `--mono`, `--serif`, `--sans`

Every component colour and font-family reference in `ui/style.css` SHALL resolve through these tokens. Catppuccin `--ctp-*` variables MAY be retained as a fallback-alias layer so any still-referenced legacy var resolves to the new palette without broken rendering.

#### Scenario: Palette swap would be a single-file edit

- **WHEN** a maintainer changes `--bg` and `--orange` values in `:root`
- **THEN** every surface using those tokens reflects the new values
- **AND** no component CSS file needs edits beyond `style.css`'s `:root` block

### Requirement: Fonts are vendored locally, no external CDN

Inter, Fraunces, and JetBrains Mono WOFF2 files SHALL live under `ui/fonts/` and load via `@font-face` with `src: url("fonts/<file>.woff2") format("woff2")`. The webview SHALL NOT reference any external font URL (no `fonts.googleapis.com`, no CDN).

The CSP `font-src` directive SHALL remain `'self' data:` — no widening to permit external font sources.

#### Scenario: No network font request

- **WHEN** the webview loads
- **THEN** no network request targets `fonts.googleapis.com` or `fonts.gstatic.com`
- **AND** all declared fonts resolve from `ui/fonts/*.woff2`

#### Scenario: Font load failure falls back gracefully

- **GIVEN** a font file is missing or corrupted
- **WHEN** the browser fails to load it
- **THEN** the matching fallback stack renders (system `-apple-system` / `Georgia` / `Menlo` as appropriate)
- **AND** the UI remains functional and readable

### Requirement: Existing IDs are preserved for JS compatibility

DOM elements that `ui/main.js` and `ui/terminal.js` reference by ID SHALL retain those IDs through the visual refresh. This includes at minimum: `#legend`, `#messages`, `#target`, `#msg-input`, `#send-btn`, `#emoji-btn`, `#attach-btn`, `#file-input`, `#attachment-row`, `#mcp-modal`, `#mcp-textarea`, `#mcp-copy-btn`, `#mcp-close-btn`, `#nutshell`, `#nutshell-body`, `#nutshell-meta`, `#nutshell-edit-btn`, `#nutshell-editor`, `#reason-modal`, `#copy-toast`, `#drop-overlay`, `#dot`, `#status-text`, `#settings-btn`, `#reload-btn`, `#reveal-btn`, `#terminal-toggle-btn`, `#terminal-col`, `#terminal-tabs`, `#terminal-body`, `#splitter`, `#spawn-modal` and its children, `#confirm-modal` and its children, `#app-body`.

Any new element introduced by the refresh (e.g., status pill wrapper, `add-agent-btn`) SHALL use new IDs that don't collide with the above.

#### Scenario: Selector survey shows no broken references

- **WHEN** grep for `document.getElementById` and `querySelector('#...` across `ui/main.js` and `ui/terminal.js`
- **THEN** every returned ID exists in the refreshed `ui/index.html`

### Requirement: Brand mark matches the app icon

The header brand mark SHALL render as an inline SVG visually consistent with the app icon (`icon.svg` at the repo root). A simplified representation is acceptable at header size — a rounded-rect speech bubble outlined in the orange accent, a bottom-left tail, and three dots in the palette colours (orange `#d97757`, amber `#e8a857`, green `#7fb069`) placed inside the bubble.

The app bundle icons (`src-tauri/icons/icon.icns` and size variants) SHALL be regenerated from `icon.svg` so the Dock, Finder, and in-app brand mark share a single visual source.

#### Scenario: Icon regeneration pipeline

- **WHEN** a maintainer runs `bun x tauri icon icon.svg -o src-tauri/icons`
- **THEN** `src-tauri/icons/icon.icns` and all size variants are produced from `icon.svg`
- **AND** the next `tauri build` bundles them into `A2AChannel.app/Contents/Resources/`

#### Scenario: Header brand mark visually matches

- **WHEN** the webview renders the header
- **THEN** the `.brand-mark` SVG uses the three-dot-in-speech-bubble motif with the same palette colours as the app icon
- **AND** no external image load is required for the brand mark
