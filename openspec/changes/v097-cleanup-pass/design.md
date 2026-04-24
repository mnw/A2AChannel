## Context

Ten open items from the pre-v0.9.5 audit survived the kind-runtime + CSS-hygiene passes. Each individually is small; collectively they are ~200 lines of code debt plus three misleading/outdated comments that previous readers have tripped over. The v0.9.5 "Code Quality Cleanup Final Report" claimed several of these as already implemented, but verification against the working tree showed they were not.

Current state (verified 2026-04-24 post v0.9.6 release):
- `ui/styles/tokens.css` — 27 `--ctp-*` declarations, zero `var(--ctp-*)` callers.
- `ui/styles/fonts.css:15` — `"Legacy fallback retained. Safe to remove in a follow-up if desired."` — WRONG; xterm depends on the font.
- `ui/main.js:665-725` — three near-identical loader functions for pending handoffs/interrupts/permissions.
- `hub/core/attachments.ts:42` — `IMAGE_EXTENSIONS` exported, never imported.
- `src-tauri/src/lib.rs:27/40/439/578` — `get_attachments_dir` Tauri command registered + `attachments_dir` field on `HubState`, no webview caller.
- `ui/styles/chat.css:10/101`, `ui/kinds/handoff.css:113-114`, `ui/kinds/interrupt.css:87` — dead selectors.
- `hub/kinds/handoff.ts:576`, `interrupt.ts:343`, `permission.ts:370/432` — `as HandoffStatus | "all"` + `as PermissionBehavior` casts.
- `hub/channel/hub-client.ts` — `authedPost` + `authedUpload` share ~90% of their body.
- `src-tauri/src/pty.rs` — spawn/attach logic duplicated across `pty_spawn` / `pty_attach` / shell-tab spawn.
- 25 empty `catch {}` sites across hub/ + ui/ (most legitimate, some likely swallowing real errors).

Constraints:
- macOS ARM64 only. No new dependencies. No new build steps.
- `bun test` suite (47 tests, v0.9.5 baseline) must stay green.
- `tsc --noEmit` on hub/ must stay clean.
- `cargo check` on src-tauri/ must stay clean.
- No user-visible behavior change.

## Goals / Non-Goals

**Goals:**
- Remove all genuinely-dead code identified by the audit.
- Replace the 4 most-duplicated patterns with shared helpers (loaders, authed HTTP, pty spawn, type guards).
- Correct all misleading comments that future-me will trip on.
- Net line delta: −150 to −200 across the tree.
- Zero behavior regression.

**Non-Goals:**
- v0.9.5/v0.9.6 deferred renames (`.dropdown[data-variant=…]`, `.card.card--handoff`, `<script type="module">`, registry dispatcher). Own changes.
- Rule-level dedup of per-kind card CSS. Own change.
- Speed/correctness fixes. This is hygiene only.
- Any change to hub routes, MCP tool shapes, or DOM contracts.

## Decisions

### 1. Loader dedup → function with three registry entries

**Decision:** Collapse `loadPendingHandoffs` / `loadPendingInterrupts` / `loadPendingPermissions` into one helper:

```js
async function loadPending(path, idField, renderFn) {
  try {
    const r = await authedFetch(`${path}?status=pending&limit=500`);
    if (!r.ok) return;
    const snapshots = await r.json();
    if (!Array.isArray(snapshots)) return;
    for (const snapshot of snapshots) {
      if (!snapshot?.id) continue;
      renderFn({ [idField]: snapshot.id, version: snapshot.version, snapshot, replay: true });
    }
  } catch (e) {
    console.warn(`[${path}] initial load failed:`, e);
  }
}
```

Call sites become:
```js
await loadPending('/handoffs', 'handoff_id', renderHandoffCard);
await loadPending('/interrupts', 'interrupt_id', renderInterruptCard);
await loadPending('/permissions', 'permission_id', (ev) => renderPermissionCard({ ...ev, kind: 'permission.new' }));
```

**Alternatives considered:**
- Keep three functions, deduplicate only the try/fetch/parse block. Rejected: the three functions exist only to dispatch to a kind-specific renderer, and that dispatch is exactly one line. Inlining into the helper is cleaner.
- Introduce a generic `KIND_LOADERS` registry. Rejected as scope creep — this is the v0.9.5/v0.9.6 KIND_MODULES pattern the deferred registry refactor would use; keep the explicit calls here and revisit when the UI JS registry lands.

### 2. Type guards replacing `as` casts

**Decision:** For each kind, add a `isXStatusFilter` function:

```ts
const HANDOFF_STATUS_FILTERS = new Set<HandoffStatus | "all">([
  "pending", "accepted", "declined", "cancelled", "expired", "all",
]);
function isHandoffStatusFilter(s: string): s is HandoffStatus | "all" {
  return HANDOFF_STATUS_FILTERS.has(s as HandoffStatus | "all");
}
```

Replace `as HandoffStatus | "all"` cast with an `if (!isHandoffStatusFilter(statusParam)) return 400` guard. Same pattern for interrupt and permission status filters, and for `PermissionBehavior`.

**Alternatives considered:**
- Zod or similar runtime-validation library. Rejected: no new deps, the Set membership check is 3 lines.
- Keep `as` casts, add a runtime Set check before them. Rejected — the type guard pattern gives narrowing AND validation in one, which is what TypeScript type guards are for.

### 3. `authedPost` + `authedUpload` → `authedRequest`

**Decision:** Unify the 401-retry + response parsing shell; keep the body-shaping part per-call-site:

```ts
async function authedRequest(
  hubEnv: string,
  method: string,
  path: string,
  buildBody: () => { body: BodyInit; headers: Record<string, string> },
): Promise<AuthedResponse> { ... }
```

Call sites:
```ts
const resp = await authedRequest(hubEnv, 'POST', '/post', () => ({
  body: JSON.stringify({ from, to, text }),
  headers: { 'Content-Type': 'application/json' },
}));
```

For uploads, `buildBody` returns a `FormData` + empty headers (browser sets multipart boundary).

**Alternatives considered:**
- Keep two functions, extract only the shared retry/response-parse block. Rejected: the retry-on-401 token re-read is the bulk of the shared logic, worth unifying.
- Rewrite as a full middleware chain. Over-engineered for one fetch-wrapper.

### 4. pty.rs spawn-helper extraction — user-gated

**Decision:** Extract three helpers but DO NOT land without a smoke-test: `attach_and_stream(session, out_tx)`, `resolve_utf8_locale(env)`, `configure_existing_session(name)`. The current pty.rs inlines these in each of the three spawn paths (initial spawn, reattach, shell tab).

**Risk:** pty.rs is tightly coupled with tmux and macOS locale quirks. A mistake in env resolution or attach semantics breaks terminal rendering in a way that doesn't surface until a user spawns an agent.

**Mitigation:** ship the extraction behind a manual click-through gate in tasks.md §7. Test matrix: spawn agent from UI → claude launches with UTF-8 locale, banner renders with Braille glyphs, stdio streams, tab transitions live → dead on kill.

### 5. Empty-catch audit — triage first, then selective logging

**Decision:** Walk all 25 sites. Categorize each as:
- **A (silent by design):** JSON body defaults (`.catch(() => ({}))`), SSE close on error, graceful Bun cleanup, file-operation cleanup (`unlink` tmp files). Leave untouched.
- **B (swallowing real errors):** any site where failure means the user's action silently didn't happen. Add `console.warn` with the site identifier + the error message.

Add a one-line comment to category-A sites explaining WHY silent is correct (`// ignore — SSE already closed` etc.) so future auditors don't re-flag them.

**Alternatives considered:**
- Add blanket logging to all 25. Rejected: pollutes console with expected noise, trains users to ignore warnings.
- Skip the audit. Rejected: the bug-swallowing sites are the kind of thing that costs hours to debug in prod.

### 6. Dead CSS verification before delete

**Decision:** For each candidate selector (`.pane-head`, `.pane-title`, `.pane-hint`, `.msg-arrow`, `.compact`), run `grep -rn "<selector-class-no-dot>" ui/` BEFORE deletion. If the selector IS used anywhere (DOM, JS attribute, event handler), keep it. `data-state="dead"` is already known load-bearing — do not remove.

**Rationale:** the v0.9.5 audit incorrectly flagged `data-state="dead"` as dead; repeating that mistake here would regress terminal behavior.

## Risks / Trade-offs

**[Risk] Type-guard function adds runtime Set allocation per request.** Negligible — the Set is module-top-level, allocated once.

**[Risk] Loader dedup changes the order of error messages in console.** The log prefix changes from `[handoffs]` to `[/handoffs]` (or whatever path shape we pick). Mitigation: match existing prefix convention.

**[Risk] pty.rs refactor breaks terminal rendering in a non-reproducible way.** Mitigation: gated behind §7 smoke. Keep the v0.9.6 pty.rs as the known-good baseline for rollback.

**[Risk] authedRequest change is on the trusted-boundary path.** Every MCP tool call from agents goes through this. A bug could break every hub interaction.
Mitigation: bun integration tests cover the auth contract (`tests/integration/auth-contract.test.ts`). Run them before shipping. Plus rotate-token round-trip smoke on the installed build.

**[Risk] Empty-catch triage is subjective.** Two reviewers might disagree on A vs B categorization for some borderline sites. Mitigation: err on the side of A (silent by design) with a comment, only add logging when failure clearly means a user-observable action silently missed.

**[Trade-off] Dead `--ctp-*` tokens removed = CSS rollback to v0.9.4 or earlier could hit undefined `var(--ctp-*)` values.** Acceptable — users who rollback that far also rollback the hub/ UI code that would consume them, so both sides stay in sync. Not worth keeping dead tokens to smooth a rollback path no one takes.

## Migration Plan

**Implementation order (low-risk → higher-risk):**

1. Delete dead `--ctp-*` tokens. Visual verify: computed styles on any element show identical colors. Commit.
2. Correct the CaskaydiaMono comment. Commit.
3. Delete unused `IMAGE_EXTENSIONS`. `grep -r IMAGE_EXTENSIONS hub/` must return zero. Commit.
4. Delete `get_attachments_dir` + `attachments_dir` field. `grep -r "get_attachments_dir\|attachments_dir" src-tauri/ ui/` returns only the field-removal diff. Commit.
5. Dead CSS selector deletions (per-selector grep gate). Commit.
6. Loader dedup in `ui/main.js`. Commit.
7. Type guards in `hub/kinds/*.ts`. Commit.
8. `authedRequest` unification in `hub/channel/hub-client.ts`. Run `bun test tests/integration/auth-contract.test.ts` before shipping. Commit.
9. pty.rs spawn helpers. **User click-through gate.** Commit only after smoke passes.
10. Empty-catch audit. Commit per file as the triage proceeds.

Each step is atomic and individually reversible. A regression caught during the progression rolls back to the prior commit without affecting later items.

**Rollback:** per-commit. Full rollback = `git revert` each of the ten commits.

## Open Questions

1. **Should `authedRequest` be exported so `hub/channel/call-tool.ts` can use it directly?** Currently `call-tool.ts` imports `authedPost` + `authedUpload`. If we unify, export the unified helper and let call-tool.ts migrate the call sites. Mild scope creep but tidy.

2. **Empty-catch site categorization: who signs off on borderline cases?** Proposal: the author (me/claude) categorizes, commit message explains, user reviews the diff and objects if a B-category site looks wrong. No formal second-reviewer gate.

3. **Do any of the 27 `--ctp-*` tokens appear in user config (e.g., `config.json`)?** No — config.json holds app settings (human_name, attachment_extensions, etc.), not CSS vars. Safe to delete.

4. **pty.rs refactor: split into one commit or three (one per helper)?** Three is safer for bisect. Propose three, combine if trivially reviewed.
