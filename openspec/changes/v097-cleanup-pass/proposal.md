## Why

The v0.9.5 kind-runtime refactor and v0.9.6 CSS hygiene pass addressed the large structural items from the pre-release audit but left ten smaller cleanup items open. Individually each is cheap (deleting dead tokens, unused constants, near-identical loader functions); collectively they add up to ~200 lines of debt and several misleading comments that cost future-reader attention. v0.9.7 captures the batch.

None of these items changes user-visible behavior. This is a hygiene release gated by the test suite and a click-through smoke.

## What Changes

- **Delete 27 dead `--ctp-*` Catppuccin legacy CSS custom properties** in `ui/styles/tokens.css`. Zero `var(--ctp-*)` references in the tree.
- **Correct misleading comment** on the CaskaydiaMono `@font-face` block in `ui/styles/fonts.css`. Current comment says "Legacy fallback — safe to remove"; the font is actively used by xterm (see `ui/terminal.js`). Replace with a load-bearing-font warning.
- **Dedup the three `loadPending<Kind>` functions** in `ui/main.js` (handoff / interrupt / permission, ~18 near-identical lines each) into one `loadPending(kind, renderFn)` helper.
- **Remove unused `IMAGE_EXTENSIONS`** exported constant from `hub/core/attachments.ts` (no import sites remaining post-v0.9.5 refactor).
- **Remove dead `get_attachments_dir` Tauri command** + associated `attachments_dir` field from `HubState` in `src-tauri/src/lib.rs`. Not called from the UI.
- **Delete unreferenced dead CSS selectors** (`.pane-head`, `.pane-title`, `.pane-hint`, `.msg-arrow`, `.compact` variants) after a grep verification pass. **Keep `data-state="dead"`** — it IS load-bearing (terminal tab state for killed agents).
- **Add 4 status-filter type guards** in `hub/kinds/{handoff,interrupt,permission}.ts` (`isHandoffStatusFilter`, `isInterruptStatusFilter`, `isPermissionStatusFilter`, `isPermissionBehavior`). Replaces `as HandoffStatus | "all"` casts at 4 sites with runtime-safe narrowing.
- **Unify `authedPost` + `authedUpload`** in `hub/channel/hub-client.ts` into one `authedRequest()` handling 401-retry and response parsing once. ~25 lines saved.
- **pty.rs spawn-helper extraction** — pull the spawn setup logic into `attach_and_stream()`, `resolve_utf8_locale()`, `configure_existing_session()` helpers. Deferred-risk item: wants a manual click-through after rebuild.
- **Empty-catch audit** — walk the 25 empty `catch {}` sites across `hub/` + `ui/`. Categorize each: legitimate silent-fall-through (SSE close, JSON body defaults) vs. bug-swallowing (real errors that should log). Add `console.warn` / `console.error` only to the bug-swallowing category. No blanket logging.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hub-request-safety`: adds a **type-guard validation** requirement covering the enum query params (`status`, `behavior`) on the list / verdict endpoints. The runtime behavior is already correct — current handlers validate via ad-hoc `Set.has` + string-equality checks before casting. The new requirement formalizes the pattern (type-guard function per enum, used both for validation AND TypeScript narrowing) as the canonical shape future kinds should adopt. No user-observable change; existing 400 responses for invalid values stay identical.

## Impact

**Code:**
- `ui/styles/tokens.css` — 27 dead token declarations removed (~30 lines).
- `ui/styles/fonts.css` — 1-line comment correction.
- `ui/main.js` — 3 × ~18 line loader functions → 1 × ~20 line helper + 3 registry entries (~30 line savings).
- `hub/core/attachments.ts` — 1 dead export removed.
- `src-tauri/src/lib.rs` — 1 Tauri command + 1 state field + 1 serde field removed (~10 lines).
- `ui/styles/chat.css`, `ui/kinds/handoff.css`, `ui/kinds/interrupt.css` — dead selectors removed after grep verification (~15 lines).
- `hub/kinds/{handoff,interrupt,permission}.ts` — 4 type guards added (+20 lines), 4 `as` casts removed.
- `hub/channel/hub-client.ts` — `authedPost` + `authedUpload` → `authedRequest()` (~25 lines saved).
- `src-tauri/src/pty.rs` — 3 helper extractions, net ~0 lines but improved cohesion.
- Various `catch {}` sites — logging added only where audit flags real errors.

**APIs:** none affected. Hub routes, MCP tool shapes, and UI DOM contracts unchanged.

**Dependencies:** none new.

**Migration:** none. Single PR, can be reverted atomically.

**Out of scope (explicit):**
- Class-rename deferrals from v0.9.5/v0.9.6 (`.dropdown[data-variant=…]`, `.card.card--handoff`). Those are their own change.
- `<script type="module">` switch. Owns its own future change.
- Registry-pattern UI dispatcher (`KIND_MODULES[kind].renderCard`).
- Any user-visible redesign.
- Rule-level dedup of per-kind card CSS (handoff.css / interrupt.css / permission.css still retain cascade-redundant rules shadowed by card.css).
