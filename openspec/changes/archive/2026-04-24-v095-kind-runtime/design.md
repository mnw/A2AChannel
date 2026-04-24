## Context

v0.8 shipped permission-relay as the fourth persistent state-machine primitive on top of the v0.5 handoff scaffolding. The cumulative weight of five such primitives (handoff, interrupt, permission, plus per-kind UI renderers and migrations) compounded into a 2742-line `hub/hub.ts` (post-v0.9.1) with 118+ top-level declarations. v0.9.0 shipped rooms — the cross-cutting routing dimension that touches every kind's broadcast and replay. v0.9.1 added the Shell tab and Usage pill human-affordances.

The operational pain surfaced during v0.8: adding `permission` required finding and touching 20 scattered edit sites across `hub.ts`, `channel.ts`, `main.js`, and `style.css`. Worse, each new kind had to rediscover the implicit contract the others share — version calculation via `MAX(events.seq)`, SSE fan-out to UI and agent queues, replay on `/agent-stream` reconnect, briefing tool aggregation, terminal-state idempotency. None of it was written down; all of it had to hold.

v0.9.5 formalizes that implicit contract. It is not a code-reuse exercise — handoffs, interrupts, and permissions diverge internally enough that attempting to DRY their state machines produces pain. It is an **integration-point standardization** exercise: the boundary between each kind and the hub becomes explicit, so adding a kind is one file plus one registration line.

Current constraints:
- macOS ARM64 only; bun compile as the sidecar toolchain; no UI bundler.
- Ledger schema is versioned (currently v6); migrations must be idempotent and additive.
- `ui/main.js` is vanilla JS loaded as a plain `<script>`; no existing module system.
- No test suite exists yet — the `tests/` directory planned for v0.9 did not land and is now scoped into v0.9.5 step 0.
- v0.9.0 rooms has shipped; the Kind contract can be designed against real room semantics rather than speculation.
- v0.9.1 additions (Shell tab, Usage pill) are human-affordances, not kinds; they stay in `ui/main.js` and are explicitly out of the per-kind split.

## Goals / Non-Goals

**Goals:**
- **Formalize the implicit invariants** that every persistent state-machine kind already obeys, into an explicit `KindModule` contract. The contract is the architecture — removing the invariant-discovery tax.
- **Adding a new kind = one file + one registration line.** No edits to `hub.ts`, no edits to `ui/main.js`, no scattered touchpoints.
- **Each kind owns its slice end-to-end:** schema migration, types, state machine, HTTP routes, SSE shape, reconnect replay, UI rendering, CSS. The slice is moveable.
- **Hub orchestrator knows nothing kind-specific.** It iterates a registry and delegates. Adding scopes (rooms, future roles) changes the SSE layer, never the kinds.
- **Minimum viable safety net** via Bun test scaffolding — so the extraction can be validated without a manual 14-case curl matrix per kind.
- **Preserve all v0.9.4 user-visible behavior.** HTTP contract, SSE payloads, MCP tools, database rows: byte-identical.

**Non-Goals:**
- DRY-ing internal state machines. Kinds diverge inside; the contract only standardizes the outside.
- A plugin framework or dynamic loader. Static imports, static registration.
- Rust-side refactoring (`lib.rs`, `pty.rs`). Separate change if needed.
- Nutshell refit into the Kind interface. Nutshell is a document, not a state-machine kind.
- Extracting the layout / composer / header sections of `ui/style.css`. Separate change.
- A rules engine, auto-approval policies, per-tool timeout policies. Separate features.
- Ephemeral broadcast abstraction (presence, typing indicators). They use their own pattern.
- Any new user feature. This is a refactor. It ships invisible to the end user.

## Decisions

### 1. The Kind contract — narrow, integration-only

**Decision:** Standardize the outer boundary, not the inner implementation. The contract defines exactly five integration points every kind implements:

```
type KindModule = {
  kind: string;                                    // "handoff", "interrupt", "permission"
  migrate(db: Database): void;                     // idempotent schema migration
  routes: RouteDef[];                              // static declaration, not a function
  pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[];  // reconnect-replay
  toolNames: string[];                             // briefing aggregates these
  priority?: number;                               // optional replay-ordering hint
};
```

**Anchor invariant:** "Kinds formalize persistent state-machine entities backed by the event ledger."

**Alternatives considered:**
- A full generic `Kind<Snapshot, Row, Input, Outcome>` with shared state-machine base. Rejected — handoffs carry TTL, permissions do not; interrupts have one verb, handoffs have four. Forcing a common state-machine type yields awkward optionality and nullable fields, and the kind author ends up fighting the type system instead of writing the kind.
- Extending the contract to cover ephemeral broadcasts (typing, presence) and documents (nutshell). Rejected — those have genuinely different shapes (no persistence for ephemeral; no lifecycle for documents). A narrow contract for the 3+ state-machine kinds stays clean; the other concepts use their own patterns.

### 2. Routes are static declarations, handlers are runtime functions

**Decision:** `routes` is a top-level array, not a function of `cap`:

```
type RouteDef = {
  method: "GET" | "POST";
  path: string | RegExp;
  auth: "mutating" | "read";
  bodyMax?: number;
  handler(req: Request, cap: HubCapabilities, params: Record<string, string>): Promise<Response> | Response;
};
```

The `handler` receives `cap` at execution time. The kind declares routes once; capabilities flow per request.

**Why:** Passing `cap` into `routes(cap)` at registration AND again at `handler(req, cap, …)` invited closure over stale state and made routes feel runtime-dependent. Static declarations keep registration deterministic and make the mental model crystal: the kind says what URLs it owns up front; the hub supplies live capabilities per request.

### 3. Capabilities dependency injection — per-hook scope

**Decision:** Every hook receives only the capabilities it needs:

```
migrate(db: Database): void                                        // DB only
routes: RouteDef[]                                                 // static; handlers get full cap
pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[]         // DB + SSE accessors
```

`HubCapabilities` shape:

```
type HubCapabilities = {
  db: Database;
  agents: {
    get(name: string): AgentCtx | null;
    isPermanent(name: string): boolean;
    all(): AgentCtx[];
  };
  sse: {
    emit(entry: Entry, scope: Scope): void;
    emitWhere?(entry: Entry, predicate: (ctx: AgentCtx) => boolean): void;  // escape hatch
  };
  auth: {
    requireAuth(req: Request): Response | null;
    requireReadAuth(req: Request, url: URL): Response | null;
    requireJsonBody(req: Request, max: number): Response | null;
  };
  ids: { mint(prefix: string, bytes?: number): string };
  events: { insert(db: Database, entity_id: string, kind: string, actor: string, payload: unknown, at_ms: number): number };
  config: { humanName: string; attachmentsDir: string; };
};
```

**Why:** Passing the full `cap` to `migrate` would invite drift (a migration quietly firing an SSE is the kind of thing that happens once and then nobody can find). Per-hook injection narrows the surface a kind can touch and makes tests trivially isolatable — stub only what the hook under test uses.

### 4. Broadcast — kinds emit, SSE resolves

**Anchor invariant:** "Kinds emit entries + scopes. The SSE layer resolves scopes to recipients."

**Decision:** Kinds never enumerate queues. They construct an `Entry` and call `cap.sse.emit(entry, scope)`. The SSE layer owns the resolver. Scope enum:

```
type Scope =
  | { kind: "broadcast" }                       // UI + all non-permanent agents
  | { kind: "to-agents"; agents: string[] }     // UI + specific agents (e.g. handoff.new → [to], .update → [from, to])
  | { kind: "ui-only" }                         // roster, presence, nutshell
  | { kind: "room"; room: string };             // v0.9 rooms
```

Resolver responsibilities (centralized in one file):
- Enumerate queues matching the scope.
- Skip permanent-agent queues (human reads via `/stream`).
- Ignore removed agents.
- Apply per-scope policy (e.g., room-filtered fan-out includes human).

**Why:** If kinds call `sse.toUI + sse.toAllAgents` directly (the earlier draft), every future scope change (rooms, roles, capability-filtered) requires touching every kind. The scope enum pushes policy into one place where it can evolve without rippling.

**Escape hatch:** `emitWhere(entry, predicate)` is included but undocumented in the kind contract — it's for truly one-off cases (debug endpoints, admin actions) that shouldn't earn a named scope. Kinds should prefer named scopes.

**Growth ceiling:** ~6 scopes long-term. If the enum exceeds that or a Cartesian case appears ("all agents in room R with role reviewer"), switch wholesale to predicate-based. Not this release.

### 5. Static registration — no dynamic loading

**Anchor invariant:** "All kinds are statically registered. No dynamic loading."

**Decision:**

```
// hub/kinds/index.ts
import { handoffKind } from "./handoff";
import { interruptKind } from "./interrupt";
import { permissionKind } from "./permission";

export const KINDS: readonly KindModule[] = [handoffKind, interruptKind, permissionKind];
```

**Why:** A config-driven plugin loader is a framework waiting to happen. Bun compile inlines the entire module tree statically; discovery happens at build time, not runtime. Mental model stays flat: to see which kinds exist, read the array.

### 6. Replay order — undefined by default, priority as escape hatch

**Anchor invariant:** "Replay order is undefined. Kinds must not depend on cross-kind ordering."

**Decision:** The orchestrator calls `kind.pendingFor()` for each kind in registry order. That order is implementation-dependent and kinds MUST NOT rely on cross-kind sequencing for correctness (e.g., "handoffs must replay before permissions"). Each kind's replay is internally ordered by its own state machine (e.g., interrupts replay newest-first).

An optional `priority?: number` field exists as an escape hatch for future kinds that genuinely need ordering guarantees (e.g., an agent-config kind whose state must be visible before kinds that query it). Default is `undefined`, treated as `0`. Orchestrator sorts ascending by `priority ?? 0` before iterating.

**Why include `priority` now if nothing uses it?** Adding the field later is a breaking type change for all kind implementations. Adding it now with a default is free insurance.

### 7. Ledger schema v6 → v7 — rename `handoff_id` → `entity_id`

**Anchor invariant:** "Each kind owns its schema evolution via migrate(db); migrations must be idempotent."

**Decision:** The `events.handoff_id` column has been a misnomer since the v0.6 interrupt migration — it carries handoff ids, interrupt ids, permission ids, and nutshell event ids (the last keyed by `"nutshell"` literal). v0.9.5's schema work renames it:

```sql
BEGIN;
ALTER TABLE events RENAME COLUMN handoff_id TO entity_id;
-- indexes referencing the old column recreated under new name
DROP INDEX IF EXISTS idx_events_handoff;
CREATE INDEX idx_events_entity ON events(entity_id, seq);
COMMIT;
```

(SQLite supports `RENAME COLUMN` since 3.25; Bun's SQLite is modern enough. Fallback to copy-drop-rename if the target runtime proves otherwise.)

The rename is additive from a data perspective — no rows change. It is a schema-v7 migration wrapped in one transaction. Prior versions: v5 (permission-dismiss, v0.8), v6 (rooms columns + per-room nutshell, v0.9.0).

**Why bundle it here and not as a standalone change:** Every kind in this refactor already touches its migration helper. Renaming once, in the same release that formalizes how kinds express migrations, means future kinds reference the honest name from day one.

### 8. Nutshell stays standalone

**Decision:** Nutshell does not implement `KindModule`. It lives at `hub/nutshell.ts` as an ad-hoc module exposing `readNutshell`, `writeNutshellInTx`, `broadcastNutshell`. Its write path continues to piggyback on the handoff primitive (task prefix `"[nutshell]"` with `context.patch`).

**Why:** Nutshell is a single-row document with no lifecycle. Forcing it into the Kind contract means most hooks (`pendingFor`, route-triples for create/list, replay) are either empty or faked. That is architectural dishonesty — the abstraction would be visibly wrong.

**Alternative considered:** A sibling `Document` interface with its own registry. Rejected for v0.9.5 as premature — N=1. Revisit when a second document-like entity (shared scratchpad, project goals, agent-configured policies) arrives and the pattern shows itself clearly.

### 9. UI — per-kind modules, module-type scripts

**Decision:** Each kind gets `ui/kinds/<kind>.js` that exports `{ dispatch(event), bootstrap(cap) }`. `ui/main.js` iterates the registered UI kinds on SSE events:

```
const UI_KINDS = { handoff: handoffUI, interrupt: interruptUI, permission: permissionUI };

function handleEvent(data) {
  if (data.kind && data.kind.includes(".")) {
    const [prefix] = data.kind.split(".");
    const ui = UI_KINDS[prefix];
    if (ui) return ui.dispatch(data);
  }
  // fall through to existing non-kind event handling (chat, roster, presence, nutshell)
}
```

Per-kind CSS co-located at `ui/kinds/<kind>.css`, loaded via `<link>` or CSS `@import`. Layout / composer / header CSS stays in `ui/style.css`.

**Why one file per kind, not three:** `renderCard` / `buildDom` / `updateDom` / `handleAction` share tight state (version-reconcile map, snapshot reference). Splitting a single kind across `render.ts` / `dom.ts` / `actions.ts` creates cross-file shuffling for no payoff. The useful split is **between kinds**, not **within** a kind.

**Module migration:** `<script>` → `<script type="module">` in `index.html`. The codebase already uses `addEventListener` exclusively (no inline `onclick=`), so the migration is a mechanical tag change plus `import`/`export` statements in the extracted files.

### 10. Sequencing — v0.9 done, v0.9.5 absorbs the skipped prep work

**Original plan:** v0.9 lands rooms + prep extractions (`hub/core/auth.ts`, `hub/core/sse.ts`) + Bun test scaffolding. v0.9.5 does the kind extraction with the prep already in place.

**Actual outcome:** v0.9.0 shipped rooms (✅) and v0.9.1 added Shell tab + Usage pill. The prep extractions (`hub/core`) and the test suite did **not** land — those scopes grew and were deferred.

**Updated sequencing for v0.9.5:**

1. **Step 0 — Test scaffolding against the monolith.** Write the ~20 tests against today's `hub/hub.ts`. Green baseline. Commit.
2. **Step 1 — Prep extractions.** Move auth + sse helpers to `hub/core/auth.ts` and `hub/core/sse.ts`. Mechanical; test suite catches regressions.
3. **Step 2+ — Kind extraction.** The original v0.9.5 body (schema v7 rename, types/ledger/agents extractions, per-kind modules, per-kind UI modules, hub orchestrator reduction).

**Why not split steps 0 + 1 into a separate v0.9.2?** That was the original plan and it didn't happen for scoping reasons. Bundling tests + prep into v0.9.5 keeps the refactor intellectually coherent as one unit of work, lets the test suite prove the entire sequence as it's written, and removes the "wait for prep release" gate that stalled v0.9.5 to begin with.

**Why the original "rooms first, extract after" order was still correct:** Designing the Kind contract before rooms ships means the scope enum misses `room`, the SSE layer doesn't know how to fan out to a room, and the contract gets redesigned the week rooms lands. Rooms shipped as the first true cross-cutting stress test — the contract is now designed against v0.9's real behavior, not speculation.

### 11. Test scaffolding — Bun test, real SQLite, real HTTP

**Decision:** `tests/` directory, Bun's built-in test runner. No mocks: tests boot a hub on a dynamic port against a temp ledger file and hit it via `fetch`. The v0.8 curl smoke matrix from `install.sh`-adjacent ad-hoc testing becomes the template.

Test shape:
- `contract/has-required-hooks.test.ts` — iterates `KINDS`, asserts each module has `migrate`, `routes`, `pendingFor`, `toolNames`, `kind`.
- `contract/kinds-index-unique.test.ts` — no two kinds share the same `kind` name or route path+method.
- `integration/<kind>-lifecycle.test.ts` — create → list → transition → broadcast, per kind.
- `integration/auth-contract.test.ts` — 401 without bearer, 413 over body cap, 411 without content-length (once per mutating route).
- `integration/sse-broadcast.test.ts` — pending replay on reconnect, scope fan-out.
- `integration/rooms.test.ts` — same-room broadcasts arrive, cross-room leak is blocked, human sees everything.
- `integration/migration-forward.test.ts` — seed a v5 ledger (pre-rooms) and a v6 ledger (post-rooms), open under v7 code, verify schema version + row preservation + `entity_id` column rename.

~20 tests total. Was originally planned for v0.9 against the monolith; now lands as **Step 0 of v0.9.5**, against today's `hub.ts`. The suite gates every extraction step that follows.

## Risks / Trade-offs

**[Risk] Contract designed around 3 kinds proves wrong for kind 4.** Every abstraction survives until the first new user that doesn't fit.
**Mitigation:** The contract is deliberately narrow (integration points only, not implementation). The 3 kinds already diverge enough internally (TTL / no-TTL; multi-verb / single-verb; recipient / no-recipient) that surviving their divergence should cover most future cases. If kind 4 genuinely doesn't fit, extend the contract; resist by forcing the kind into it.

**[Risk] Broadcast scope enum over-fits to current kinds.** The 4 scopes listed are exactly what the 3 kinds use today plus `room`. A 4th kind might need something new.
**Mitigation:** `emitWhere(predicate)` escape hatch exists. If a new scope appears twice in the wild, promote it to the named enum. Named > predicate as long as the enum stays <~6.

**[Risk] Replay without cross-kind ordering breaks a subtle invariant somewhere.**
**Mitigation:** Tests assert per-kind replay ordering (newest-first within interrupts, etc.). The `priority` escape hatch exists if a real case emerges. The design.md invariant "kinds must not depend on cross-kind ordering" is stated explicitly so future authors can't accidentally lean on it.

**[Risk] UI module migration breaks something in the webview.** `<script type="module">` changes loading timing; module scope closes over variables differently than global scope.
**Mitigation:** Incremental — migrate one kind's UI module first, ship it, verify in the Tauri webview, then migrate the others. The in-browser console (v0.6's devtools-on-in-release accepted risk) makes this fast to debug.

**[Risk] Schema v6 → v7 rename breaks an unnoticed query.** Any code reading `events.handoff_id` that isn't updated. Post-v0.9.1 the column is referenced by all four kind `load*` helpers and (now) the room-aware event inserts.
**Mitigation:** Grep for `handoff_id` across the repo as part of the migration task. Expect ~6-8 call sites to update (generic event insert + each kind's `load*` + any list helpers). Tests assert the rename is effective and queries work against the new name.

**[Risk] Test suite becomes flaky on hub-port collision or file-system races.**
**Mitigation:** Each test mints a fresh temp dir + fresh dynamic port. Use Bun's `Bun.serve({ port: 0 })` pattern for OS-assigned ports. Close hubs in `afterEach`. The v0.8 install.sh pattern already proves this works.

**[Trade-off] Scope enum vs predicate-based.** Named scopes are more readable and review-friendly; predicates are more flexible. We chose named for 4 scopes today. If the enum grows past 6, the readability argument inverts and we switch. That migration is bounded to the SSE layer plus kind call sites — manageable.

**[Trade-off] Nutshell stays standalone.** One-off module reads as inconsistent alongside three kind modules. Alternative is a Document sibling interface with N=1 users. The N=1 abstraction is always wrong; stay standalone until N=2 shows the right pattern.

**[Trade-off] Per-kind UI CSS.** Adds one CSS file per kind to load on startup. Negligible in a local webview (all files are local, no network).

## Migration Plan

**Landed state at v0.9.5 kickoff:**
- v0.9.0 rooms shipped (schema v6; `room` column on agents/events/handoffs/interrupts/permissions; per-room nutshell).
- v0.9.1 added Shell tab + Usage pill + permission verdict room-check.
- Originally-planned v0.9 prep (`hub/core/auth.ts`, `hub/core/sse.ts`, test suite) **did not land**. Absorbed into v0.9.5 below.

**v0.9.5 implementation order (derived from actual post-v0.9.1 code):**
1. **Test scaffolding.** Write ~20 Bun tests against today's monolithic `hub.ts`. Green baseline. No production code changes.
2. **Prep extractions.** Move auth + sse helpers into `hub/core/auth.ts` and `hub/core/sse.ts`. Test suite gates.
3. **Ledger v6 → v7 migration.** Rename `handoff_id` → `entity_id`. Land standalone so subsequent extractions reference the honest name.
4. Extract `hub/core/ledger.ts`, `hub/core/events.ts`, `hub/core/agents.ts`, `hub/core/types.ts`.
5. Define `KindModule`, `HubCapabilities`, `Scope`, `RouteDef` interfaces.
6. Implement the SSE layer's scope resolver (including the `{ kind: "room", room }` branch that already exists in the monolith's broadcast logic) in `hub/core/sse.ts`.
7. Extract `hub/kinds/interrupt.ts` first — simplest state machine, one verb. Smoke with tests.
8. Extract `hub/kinds/handoff.ts`.
9. Extract `hub/kinds/permission.ts`.
10. Move `hub/nutshell.ts` as standalone module.
11. Reduce `hub.ts` to orchestrator: registry iteration, Bun.serve shell, startup/shutdown.
12. Migrate UI: per-kind modules for handoff / interrupt / permission, `<script type="module">`, co-located CSS. Shell tab + Usage pill stay in `ui/main.js`.
13. Run full test suite; smoke against installed build.
14. Ship.

**Rollback:**
- If a regression surfaces post-ship, the whole v0.9.5 refactor reverts atomically (it's one PR). User-facing behavior is unchanged, so a revert doesn't require data migration other than the schema-version bump-down — caught by the downgrade-refuse guard.
- The `handoff_id` → `entity_id` rename is the only data-level change. A revert needs the inverse rename migration; documented in the release notes.

**No feature flag.** The refactor is either in or out. Flags hide the thing the refactor tries to eliminate (implicit invariants scattered across code paths).

## Open Questions

1. **Does Bun's SQLite support `ALTER TABLE … RENAME COLUMN` reliably?** Needs a quick runtime check during v0.9.5 Task 1. If not, fall back to copy-drop-rename inside one transaction (same pattern used for the v5 permissions CHECK-constraint expansion).
2. **Does the UI module migration need a polyfill for older WKWebView?** macOS ARM64 only; Safari-compatible ES modules are standard since macOS 10.14. Should be fine but worth confirming on the actual Tauri webview.
3. **Should contract conformance be enforced at TypeScript type level, runtime test, or both?** Recommend both: `const KINDS: readonly KindModule[]` catches compile-time shape, `contract/has-required-hooks.test.ts` catches half-implemented modules that satisfy the type but leave hooks as stubs.
4. **Is `AgentCtx` a good fit for v0.9.5, or should we wait for rooms to stabilize the shape?** The field set (name, room, future role, future capabilities) is v0.9-stable. Adding a field later is non-breaking thanks to optional properties. Keep it.
5. **Should `hub/nutshell.ts` use `HubCapabilities` even though it isn't a kind?** Yes — the same DI discipline applies to any module that used to reach for hub.ts globals. Consistency across the codebase is worth keeping even for non-kind modules.
