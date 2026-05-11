# `KindCardRenderer` registry replaces hardcoded per-Kind branches in `main.js`

`ui/main.js` previously hardcoded three branches in `handleEvent` (one per Kind: handoff / interrupt / permission), each matching `data.kind.startsWith('X.')` and calling the matching `renderXxxCard(data)`. The replay-on-connect path had three matching helpers (`loadPendingHandoffs`, `loadPendingInterrupts`, `loadPendingPermissions`) — each a thin wrapper around `loadPending(path, eventShape, render)` that differed only in the three parameters. Adding a fourth Kind would require editing `main.js` in five places. The post-2a code audit (findings #1 + #6) identified this as the same shallow seam from two sides: the dispatch half (`handleEvent`) and the replay half (`loadPendingX`).

This decision implements `architecture-cycle-2b` §1 (registry portion) and was committed in the same patch as this ADR.

## Considered Options

- **Status quo — hardcoded per-Kind branches in `main.js`:** rejected. Adding a Kind required editing `main.js` in two places; the three replay helpers were near-duplicates differing only in parameters.
- **Full ES-module migration (per the original §1 spec):** rejected as out-of-scope for the immediate carve. Migrating only `main.js` + `ui/kinds/*.js` to ES modules would orphan the ~12 other classic-script files that depend on shared-lexical-scope globals (`messagesEl`, `authedFetch`, `parseErrorBody`, `askReason`, `escHtml`, `HUMAN_NAME`, `addMessage`, `trimMessages`, `SELECTED_ROOM`, `input`, `sendBtn`, `targetEl`). It's all-or-nothing for the entire UI; not feasible as a partial migration. Filed for future consideration in the discipline rule from `architecture-cycle-2b/design.md` ("Closing — last planned architectural cycle"): the ES-module migration is opportunistic, not load-bearing.
- **Per-Kind `KindRenderer` factory taking a `ctx` object (`createXRenderer(ctx)`):** the spec's ideal shape. Rejected for the same reason as full ES-module migration — requires ES modules to inject `ctx` cleanly. With classic-script load order, the per-Kind file would still read `messagesEl`, `authedFetch`, etc. as globals at render time; the `ctx` parameter would be cosmetic.
- **Compiled-in registry (e.g., `KINDS = ['handoff', 'interrupt', 'permission']` table):** rejected — every Kind would still need its own renderer function reachable by name at registry-init time, requiring main.js to import all three. Doesn't solve the "edit main.js when adding a Kind" problem.
- **Self-registration via a runtime registry (CHOSEN):** each Kind's file calls `KindCardRenderer.register({...})` at script-load time. The registry's `dispatch` matches by prefix; `loadAllPending` iterates registered adapters. main.js consults the registry — never enumerates Kinds. Adding a Kind is: create the file with its `renderXxxCard` + `KindCardRenderer.register(...)`, add the `<script>` tag to `ui/index.html`. main.js does NOT change.

## Consequences

- **`ui/kinds/kind-renderer.js` (new, ~95 LOC)** exposes `KindCardRenderer = { register, dispatch, loadAllPending, _registeredPrefixes }` as a classic-script global. Loaded BEFORE the per-Kind files (which depend on it for their self-registration call).
- **Each `ui/kinds/<kind>.js` gains a `KindCardRenderer.register({...})` call at file bottom** declaring its prefix, the Hub endpoint for replay (`loadPath`), the snapshot→event shape mapper for replay, and the existing `renderXxxCard` function as the render callback. The renderer adapter is declarative data — no class hierarchy, no interface keyword.
- **`main.js handleEvent`'s three hardcoded branches collapse to one line:** `if (typeof data.kind === 'string' && KindCardRenderer.dispatch(data.kind, data)) return;`. Falls through to `addMessage(data)` for non-Kind events (chat).
- **`main.js`'s three replay helpers collapse to one alias:** `const loadAllPending = () => KindCardRenderer.loadAllPending();`. Two existing call sites (initial connect + reload_settings) updated to call `loadAllPending()` once instead of three sequential awaits.
- **Adding a 4th Kind is structurally cheap:**
  1. Create `ui/kinds/<kind>.js` with `renderXxxCard(event)` + the `KindCardRenderer.register(...)` call
  2. Add one `<script src="kinds/<kind>.js">` tag to `ui/index.html`
  3. main.js does NOT change. Nor does kind-renderer.js.
- **Contract test at `tests/contract/kind-renderer-registry.test.ts` (5 scenarios, all pass)** drift-fails on regression:
  - main.js has no `data.kind.startsWith('X.')` branches
  - main.js has no per-Kind `loadPendingX` helpers
  - Each Kind file calls `KindCardRenderer.register` with the expected prefix + loadPath
  - index.html loads `kind-renderer.js` BEFORE the per-Kind files
  - The registry exposes the canonical `{register, dispatch, loadAllPending}` API
- **Renderer adapter shape rejection at registration time, not dispatch time.** `register` throws if any required property is missing or malformed (mis-spelled property names fail at file-load when the kind file is parsed, not later when a real SSE event arrives). Also rejects duplicate-prefix registrations.

## Post-implementation lessons

- **The "shallow seam from two sides" framing was accurate.** Audit finding #1 (kind cards triplicated) and #6 (SSE dispatch hardcoded) were the same registry-pattern shaped hole. Solving them together was cheap.
- **Self-registration beats compiled-in registry for this codebase.** A static `KINDS = ['handoff', ...]` array would still require main.js to import all three render functions by name at registry-init time. Self-registration moves the coupling INTO each Kind's own file where it belongs.
- **The ES-module migration deferral is the right call.** Audit findings #1 + #6 are addressed without the migration. Locking down "main.js doesn't grow when new Kinds land" is the load-bearing structural win. The renderer-factory + ctx pattern is aesthetic in the absence of a real test-isolation need; classic-script globals work fine at this codebase size.
- **`tests/unit/kind-renderer.test.ts` (the audit's ideal) still requires ES-module extraction.** The renderer adapters are pure data + a function reference; testing them in isolation needs to import the file, which requires it to be an ES module OR a Node-runnable shim. Deferred to whenever ES-module migration is genuinely earned (perhaps never).
- **Per-placement dismiss matrix from design.md Decision 1 NOT implemented in this cycle.** Today's three Kinds each manage their own DOM lifecycle inside `renderXxxCard` / `buildXxxCardDom`. The placement matrix (append → keep + terminal-class; pin → move-inline; stack → remove) would only land if the renderer factories carved further — which they didn't because of the ES-module deferral. Documented as a follow-up if/when a 4th Kind needs the unified lifecycle.

## Recorded by

`architecture-cycle-2b` §1 (KindRenderer carve, registry portion). Commit lands the implementation; this ADR documents the load-bearing rationale and the post-implementation lessons. The full ES-module migration + factory/ctx pattern from the original §1 spec is intentionally deferred — discipline rule from cycle 2b's "Closing" section applies (audit findings that are only LOC reductions or organizational cleanups DO NOT trigger cycles).
