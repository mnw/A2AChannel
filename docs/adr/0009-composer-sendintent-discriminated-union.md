# Composer send mode is a discriminated `SendIntent` union, not an emergent property of DOM state

`ui/features/composer.js` previously branched three send paths (chat / slash / shift-tab) plus a fourth (interrupt via `!@agent` target prefix), with the dispatch decision living inside `_refreshSlashState`'s mutation of `sendBtn.disabled` based on `input.value` and `SELECTED_ROOM`. Send mode was an emergent property of DOM state — derived implicitly, mid-keystroke, by side-effecting helpers. The post-2a code audit (finding #4) flagged this as a coupling smell: a user typing what they think is chat could land in the slash branch when state mutated mid-keystroke; "send a thing" had an implicit interface; the three paths coupled through DOM rather than an explicit mode dispatch.

This decision implements `architecture-cycle-2b` §3 and was committed in `2ad99a5` ahead of the rest of cycle 2b's gated implementation.

## Considered Options

- **Mode flag (status quo):** `currentMode = "chat" | "slash" | "shift-tab" | "interrupt"` set by `_refreshSlashState` mutating shared state read by every send-path branch. Rejected — the bug pattern (mid-keystroke flip from chat to slash) is exactly the failure mode that discriminated unions eliminate at the type level.
- **Three completely separate Composer instances:** rejected — they share input state (the `<textarea>`, attachments tray, target room). Forking into separate Composers would duplicate input-handling code.
- **Single `send(input)` with internal branching (status quo with rename):** rejected — internal branching is the status quo; the seam isn't where the orchestration lives.
- **Three-arm union (chat / slash / shift-tab) per the original audit framing:** rejected after reading the actual code — the audit missed `interrupt` mode which routes via `!@agent` target selector. The implemented union has four arms.

## Consequences

- **`detectIntent(snap): SendIntent` is a pure function** of an input snapshot. It does NOT touch the DOM — no `sendBtn.disabled`, no `input.value` mutation, no `slashPickerOpen/Close`. Callers (`send`, `_refreshSlashState`) drive the side effects from the discriminator.
- **`captureComposerSnapshot()`** collects `{text, image, room, targetMode}` from DOM state into a plain object — the single snapshot used through the entire send flow. Same snapshot is read by `detectIntent` and by the per-mode dispatch helper; there is no opportunity for input state to mutate between mode decision and dispatch.
- **Four `SendIntent` arms** (the implementation found four where the audit framed three):
  - `{ mode: "slash", room, parsed?, validationError? }` — `/<command> @<target>` → pty_write
  - `{ mode: "shift-tab", room, parsed?, validationError? }` — escape-code → pty_write `\x1B[Z`
  - `{ mode: "interrupt", toAgent, text, hasImage, validationError? }` — `!@agent` target → POST `/interrupts`
  - `{ mode: "chat", text, image, targetMode, room, mentions, validationError? }` — default → POST `/send`
- **Four per-mode dispatch helpers** (`_dispatchSlash`, `_dispatchShiftTab`, `_dispatchInterrupt`, `_dispatchChat`) each own their mode's side effects (input.value clear timing, sendBtn.disabled lifecycle, error surfacing via `addMessage` or `_showSlashError`, attachment clear, mention popover close).
- **`send()` collapses to** `detectIntent(captureSnapshot())` → `switch (intent.mode)`. Mode is an explicit value at this call site, not derived from re-reading DOM state across the send flow.
- **`_refreshSlashState()` refactored to derive `sendBtn.disabled` + slash error + picker open/close from a `detectIntent()` call.** Single source of truth for what mode the input is in; consistent with `send()`'s dispatch.
- **`validationError` carries the user-surfaceable mode-specific failure** ("no-room", "incomplete", "no-target", "too-long", "no-text", "empty"). Callers map to the existing messages (`'Select a room first'`, `'specify @agent or @all'`, `'Interrupt text must be 500 chars or fewer'`, etc.). The validation logic remains co-located with the mode it validates.

## Post-implementation lessons

- **The audit's three-mode framing missed interrupt.** Reading the actual code revealed the fourth mode. Pre-grill 0.5 should always read the real composer.js, not the audit's summary, before settling the union shape.
- **No bug class actually manifests in the status quo.** JavaScript is single-threaded; `input.value` cannot mutate between two reads inside a synchronous `send()` body. The audit's framing ("user typing what they think is chat lands in slash") was theoretical. The refactor's value is therefore *code clarity* (an explicit named seam) rather than *bug elimination*. This was an over-sell in the audit; the refactor still earns its keep on locality + test-surface grounds.
- **Unit-testing `detectIntent` standalone requires ES-module extraction.** The function is pure, but composer.js is classic-`<script>` with shared-lexical-scope globals. Until `architecture-cycle-2b` §1 lands the ES-module migration, the test must either eval the file in a fake-window context or wait. Deferred `tests/unit/composer-detect-intent.test.ts` to §1 follow-up rather than building a brittle eval-harness.
- **The `validationError` discriminator carries failure reason as a string tag**, not an HTTP-style status code. This kept the union simple — each mode has its own validation vocabulary that doesn't generalize. A typed enum would over-formalize an inherently mode-specific set.

## Recorded by

`architecture-cycle-2b` §3 (Composer mode-dispatch carve, pulled forward from the 2b gate). Commit `2ad99a5` lands the implementation; this ADR documents the load-bearing rationale and the post-implementation lessons.
