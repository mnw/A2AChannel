## Why

Adding a new persistent state-machine primitive to A2AChannel (`handoff`, `interrupt`, `permission`) currently requires ~20 edits scattered across `hub/hub.ts` (now 2742 lines post-v0.9.1), `hub/channel.ts` (756 lines), `ui/main.js` (1998 lines), and `ui/style.css` — plus rediscovering the implicit invariants those kinds share (event-sourced version via `MAX(events.seq)`, SSE fan-out rules, replay-on-reconnect, briefing tool list, terminal-state idempotency). The pain is not file size — it is **invariant discovery**. Every new kind re-learns the same unwritten contract by reading the other kinds, and every modification risks missing one of the 20 touchpoints.

v0.9.0 shipped rooms and v0.9.1 added the Shell tab + Usage pill affordances; the monolith grew by ~240 lines but more importantly the cross-cutting routing dimension (`room` on agents and events, per-room nutshell, room-filtered fan-out) is now proven in the monolith. v0.9.5 captures that finished picture and formalizes it: a single explicit `KindModule` contract, a runtime that registers kinds and owns orchestration, and per-kind modules that each own their slice end-to-end. Adding a kind becomes **one file + one registration line**, not surgery across eight places.

## What Changes

- **New `KindModule` contract** defining the five integration points every persistent state-machine kind implements: schema migration, HTTP routes, reconnect-replay, briefing tool names, and an optional replay-ordering hint. Implementation shape per kind stays free — only the outer boundary is standardized.
- **Hub orchestrator reduced to ~200 lines** in `hub/hub.ts`. It loads kinds from a static registry (`hub/kinds/index.ts`), calls `migrate(db)` on each, registers their routes into `Bun.serve`, runs their replay hooks on `/agent-stream` reconnect, and aggregates their `toolNames` into the briefing. It knows nothing about handoff/interrupt/permission beyond "they are Kinds."
- **Capabilities dependency injection.** Every hook receives a `HubCapabilities` object (DB, SSE emit + scope resolver, agents registry, auth helpers, event-log insert, id minting). No ambient globals. Kinds become pure functions of their inputs — portable and unit-testable in isolation.
- **Centralized broadcast with scope enum.** Kinds emit `(entry, scope)` via `cap.sse.emit()`. The SSE layer owns the resolver: which scope maps to which queues. Scopes today: `broadcast`, `to-agents`, `ui-only`, `room` (post v0.9). Adding a scope is one contained change; adding a kind never touches SSE.
- **Static registration, no dynamic loading.** Kinds are imported and listed in a const array. No config-driven plugin system, no dependency-injection framework. Bun compile stays happy, the mental model stays flat.
- **Per-kind UI modules** at `ui/kinds/<kind>.js` each exporting `{ dispatch, bootstrap }`. `ui/main.js` switches to `<script type="module">` (no inline handlers to port — the codebase already uses `addEventListener` everywhere). Per-kind CSS co-located at `ui/kinds/<kind>.css`; layout / composer / header CSS stays in `ui/style.css`.
- **Nutshell stays standalone.** It is a single-row document, not a state-machine kind. Keeping it under `hub/nutshell.ts` as an ad-hoc module preserves the purity of the Kind abstraction. A sibling `Document` interface is deferred until a second document-like entity exists.
- **Ledger schema v6 → v7**: rename `events.handoff_id` → `events.entity_id`. The column has served as a generic entity id since the v0.6 interrupt migration — namespace-safe but misleading. Additive rename via copy-drop-rename; no data loss. Indexes recreated under the new name. (v5 was consumed by permission-dismiss in v0.8; v6 was consumed by rooms in v0.9.)
- **Minimal Bun test scaffolding** for contract conformance + integration smoke (~20 tests covering create → list → transition, auth, body caps, migration forward-compat, SSE replay). The tests are the safety net the refactor leans on. _Originally planned to land in v0.9 as prep; it didn't, so v0.9.5 now includes it as step 0._
- **Non-goals (explicit):** Rust-side refactor; `style.css` layout/composer split; rules engine; ephemeral-broadcast abstraction; `Document` interface; any new user-facing feature. **Shell tab** and **Usage pill** (v0.9.1) stay where they are in `ui/main.js` — they are not kinds and are not part of the per-kind UI split.

## Capabilities

### New Capabilities

- `kind-runtime`: the `KindModule` contract, `HubCapabilities` injection, scoped SSE emit, static registry, per-kind UI module convention, and conformance-test expectations. Governs how future persistent state-machine primitives are added without re-expanding `hub/hub.ts`.

### Modified Capabilities

None. User-visible behavior of `interrupt-messages`, `project-nutshell`, `hub-request-safety`, `agent-onboarding`, and the (pending v0.8 archive) permission-relay capability is unchanged. This is an implementation refactor; the specs describe what the system does, which does not move.

## Impact

**Code:**
- `hub/hub.ts` — reduced from ~2800 (post-rooms) to ~200 lines: kind registry iteration, Bun.serve routing shell, startup/shutdown.
- `hub/kinds/handoff.ts`, `hub/kinds/interrupt.ts`, `hub/kinds/permission.ts` — new, each ~400–600 lines owning types + state machine + routes + replay + migration for its kind.
- `hub/kinds/index.ts` — exports the `KINDS` array.
- `hub/core/auth.ts`, `hub/core/sse.ts`, `hub/core/agents.ts`, `hub/core/ledger.ts`, `hub/core/events.ts`, `hub/core/types.ts` — extracted shared infrastructure.
- `hub/nutshell.ts` — standalone (not a kind).
- `hub/channel.ts` — no structural change; tool list continues to aggregate from briefing.
- `ui/kinds/handoff.js`, `ui/kinds/interrupt.js`, `ui/kinds/permission.js` — per-kind modules.
- `ui/main.js` — reduced: SSE connect, composer, @mentions, bootstrap. Card rendering moves to kind modules.
- `ui/kinds/handoff.css`, etc. — co-located styles.
- `ui/index.html` — `<script type="module">` entries for per-kind modules.
- `tests/` — new directory; Bun test suite.

**APIs:**
- HTTP: no changes. Paths, bodies, status codes identical.
- SSE: no changes. Event kinds and payload shapes identical.
- MCP: no changes. Tool signatures identical.

**Dependencies:** none new. No bundler, no DI framework, no runtime module loader.

**Bundle size:** neutral or slightly smaller (dead-code eliminated across split files; bun compile inlines).

**Migration:**
- Ledger schema_version bumps 6 → 7. Rename column via copy-drop-rename inside one transaction. v0.9.x ledgers open cleanly under v0.9.5; downgrade guard fires as usual if a v0.9.5 ledger is opened by older code.

**State at v095 planning time vs today (v0.9.1 shipped):**

| Originally planned as "v0.9 prerequisite" | Actual status | Disposition |
|---|---|---|
| Rooms feature complete | ✅ shipped in v0.9.0 | Planned cross-cutting stress test delivered; Kind contract can be designed against real room semantics. |
| `hub/core/auth.ts` + `hub/core/sse.ts` pre-extractions | ❌ did not land | Rolled into v0.9.5 as step 0 (mechanical, no behavior change). |
| Bun test scaffolding committed green against the monolith | ❌ did not land | Rolled into v0.9.5 as step 1. Sequencing becomes: tests first, then extraction, with the suite gating each kind's move. |

**Rollout:** v0.9.5 is release-cut behind a single PR; no feature flag. The refactor either lands whole or reverts whole. Test suite (now committed as part of this change) gates merge.
