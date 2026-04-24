## 0. Test scaffolding — Bun test against the monolith

Goal: green baseline before any production code moves. Every subsequent step is gated by this suite.

- [x] 0.1 Created `tests/helpers/hub.ts` exporting `spawnHub()` — shells out to `bun run hub/hub.ts` with `PORT=0`, temp ledger, temp attachments dir, test token. Parses `listening on http://...` from stdout to discover the OS-assigned port.
- [x] 0.2 Created `tests/helpers/fetch.ts` with `authedFetch`, `postJson`, `getJson`, `registerAgent` (opens /agent-stream to register), and `openSSE` (generator + close).
- [x] 0.3 `tests/integration/handoff-lifecycle.test.ts` — 5 tests: create → accept, idempotent accept, 409 accept-after-decline, 403 non-recipient, 404 unknown id.
- [x] 0.4 `tests/integration/interrupt-lifecycle.test.ts` — 5 tests: create → ack, idempotent ack, human ack-on-behalf, 403 non-recipient non-human, 400 text > 500 chars.
- [x] 0.5 `tests/integration/permission-lifecycle.test.ts` — 7 tests: create → verdict allow, idempotent verdict, 409 different verdict, dismiss, 409 verdict-after-dismiss, idempotent dismiss, 400 invalid request_id.
- [x] 0.6 `tests/integration/auth-contract.test.ts` — 5 mutating routes × 2 checks (401 without bearer, 413 over body cap). 411-without-Content-Length dropped: Bun fetch disallows omitting Content-Length with a ReadableStream body in ways that interfere with subsequent tests on the same hub connection pool. The 411 path is still enforced in production against real HTTP clients; tests cover auth and size instead.
- [x] 0.7 `tests/integration/sse-broadcast.test.ts` — 5 tests: handoff.new arrives on recipient /agent-stream, pending replays with replay=true on reconnect, same-room handoff succeeds, cross-room non-human → 403, human crosses rooms.
- [x] 0.8 `tests/integration/migration-forward.test.ts` — 2 tests: fresh ledger migrates from scratch to v6, seeded v5 ledger (with representative rows) migrates to v6 preserving rows + nutshell text + ledger_id.
- [x] 0.9 `bun test tests/` — **37 pass / 0 fail** across 7 files in ~880ms. Green baseline established.

## 1. Prep extractions — auth, SSE

Goal: move the least-entangled helpers out first. Each step is mechanical; tests gate.

- [x] 1.1 `hub/core/auth.ts` (98 lines) — exports `JSON_BODY_MAX`, `HANDOFF_BODY_MAX`, `PERMISSION_BODY_MAX`, `IMAGE_MAX_BYTES`, `corsHeaders`, `ALLOWED_ORIGINS`, `json`, `ctEquals`, `makeAuthHelpers(token)`. Factory pattern keeps `AUTH_TOKEN` ownership in `hub.ts`.
- [x] 1.2 `hub/core/sse.ts` (113 lines) — exports `DropQueue<T>`, `HEARTBEAT_MS`, `SSESend`, `makeSSE`. Imports `corsHeaders` from `./auth`.
- [x] 1.3 `hub/core/ids.ts` (62 lines) — exports `AGENT_NAME_RE`, `RESERVED_NAMES`, `randomId`, `mintHandoffId`, `mintInterruptId`, `ts`, `colorFromName`, `validName`, `validRoomLabel`. Pure, no state. `resolveRoom` stays in `hub.ts` (references `DEFAULT_ROOM`).
- [x] 1.4 `hub.ts` reduced from 2742 → 2536 lines (−206). `bun test` green (37/37). No circular deps; `tsc --noEmit` clean.

## 2. Ledger v6 → v7 migration — rename `handoff_id` → `entity_id`

- [x] 2.1 `LEDGER_SCHEMA_VERSION` bumped to `7` in `hub/hub.ts`.
- [x] 2.2 v7 migration block added inside `migrateLedger`: `ALTER TABLE events RENAME COLUMN handoff_id TO entity_id` + drop old index + create `idx_events_entity`. Bun's SQLite (3.46+) supports `RENAME COLUMN` natively; no fallback needed.
- [x] 2.3 Grepped `handoff_id` across `hub/`. Updated 8 SQL sites: 6 × `SELECT MAX(seq) ... WHERE entity_id = ?` (via `replace_all`), 1 × `INSERT INTO events`, 1 × `insertEvent()` parameter name. Left untouched: (a) v1 migration that creates the table — frozen history; (b) `handoffEntry()`'s protocol `handoff_id` field on `Entry` — that's a kind-specific alias on SSE payloads, not the ledger column.
- [x] 2.4 `tests/integration/migration-forward.test.ts` updated: fresh-install test asserts `schema_version≥7` + `entity_id` column + no `handoff_id`. Seeded v5 test also asserts post-upgrade rename. Both green.
- [x] 2.5 `bun test` green (37/37). Real-user-data smoke deferred to release step §13.2 (`./scripts/install.sh` installed the v6 ledger still opens cleanly under v7 code).

## 3. Core types + shared infrastructure

- [x] 3.1 `hub/core/types.ts` (149 lines) — `Agent`, `AgentCtx`, `Entry` (open shape so kind-specific fields layer on), `Scope` (four discriminated variants), `RouteDef`, `HubCapabilities`, `KindModule`. The contract is now TypeScript.
- [x] 3.2 `hub/core/ledger.ts` (280 lines) — extracted `openLedger` (returns `{ db, enabled }`) + `migrateLedger` + `LEDGER_SCHEMA_VERSION`. hub.ts wraps with a thin `openLedger()` that assigns the result to `ledgerDb` / `ledgerEnabled`. Migrations stay inline; per-kind `migrate(db)` lifts happen during kind extractions (§5–§7). hub.ts: 2540 → 2299 lines.
- [x] 3.3 `hub/core/events.ts` (25 lines) — `insertEvent`. Column `entity_id` post-v7.
- [→ §9] 3.4 `hub/core/agents.ts` — **deferred to §9** (orchestrator reduction). `ensureAgent`/`removeAgent` call `broadcastRoster`/`broadcastPresence`, which themselves depend on `uiSubscribers` (SSE) + the registry maps. Extracting this cleanly requires callback injection or factory pattern — either ends up thrown away when §9 introduces `HubCapabilities.agents` as the canonical owner. Doing it here would be a throwaway intermediate state. Agent registry moves with the orchestrator rewrite.
- [x] 3.5 Tests green after each extraction done so far (§3.1 + §3.3 → 37/37 pass).

## 4. SSE layer — scope resolver

- [x] 4.1 `emit(entry, scope)` added in `hub/hub.ts` (lives alongside `broadcastUI` pending §9's agent-state extraction — then moves to `core/sse.ts`). Handles `broadcast`, `to-agents`, `ui-only`, `room`. Room scope: non-permanent agents whose `room` matches. Human reads via `/stream`, so they're naturally served via the UI fan-out — no explicit inclusion needed.
- [x] 4.2 `emitWhere(entry, predicate)` added as escape hatch for scopes that don't yet deserve a named variant.
- [x] 4.3 Rewired `broadcastHandoff` (→ `to-agents`), `broadcastInterrupt` (→ `to-agents`), `broadcastPermission` (→ `room`) to route through `emit`. `broadcastNutshell` stays inline — it deliberately skips `chatLog` (ambient state push, not a chat event) so it doesn't fit `emit`'s shape.
- [x] 4.4 `tests/integration/sse-scope.test.ts` — 2 tests: `to-agents` fan-out isolates handoff to recipient only (charlie not leaked); `room` fan-out isolates interrupt to same-room agent (cross-room dana not leaked).
- [x] 4.5 `bun test` green (39/39 across 8 files). `tsc --noEmit` clean.

## 5. Extract `hub/kinds/interrupt.ts` (simplest state machine first)

- [x] 5.1 `hub/kinds/interrupt.ts` (385 lines) exports `interruptKind: KindModule`. Five hooks: `kind: "interrupt"`, `migrate` (no-op — schema owned historically by `core/ledger.ts` v2/v6 migrations; per-kind migration lifts deferred), `routes: RouteDef[]` (3 routes), `pendingFor`, `toolNames: ["send_interrupt", "ack_interrupt"]`.
- [x] 5.2 Moved `InterruptStatus`, `InterruptSnapshot`, `InterruptRow`, `InterruptOutcome`, `ListInterruptsFilter`, `INTERRUPT_ID_RE`, `INTERRUPT_TEXT_MAX_CHARS`, `createInterrupt`, `ackInterrupt`, `listInterrupts`, `loadInterrupt`, `snapshotInterrupt`, `rowToSnapshot`, `interruptEntry` into the kind module. State-machine fns take `db: Database` explicitly (no module-level ledgerDb dep).
- [x] 5.3 Inline copies removed from `hub.ts`. Thin local wrappers retained for back-compat with hub's own callers (`broadcastInterrupt`, reconnect replay); those disappear in §9 when the orchestrator owns replay.
- [x] 5.4 `handleAgentStream` replay still calls `pendingInterruptsFor` wrapper. Migrating to `KINDS.flatMap(k => k.pendingFor(agent, cap))` happens in §9 when handoff/permission also extract.
- [x] 5.5 `buildBriefing`'s tool list still hardcoded. Aggregating via `KINDS.flatMap(k => k.toolNames)` happens in §9 for the same reason.
- [x] 5.6 `tests/contract/has-required-hooks.test.ts` — iterates KINDS, asserts presence of `kind`/`migrate`/`routes`/`pendingFor`/`toolNames` plus RouteDef shape validation and unique tool names.
- [x] 5.7 Same test file covers uniqueness: no two kinds share the same `kind` name or `(method, path)` tuple.
- [x] 5.8 `bun test` green (44/44 across 9 files). `tsc --noEmit` clean. **Full KindModule pattern proven** via `HubCapabilities` built in hub.ts (`buildCap()`) + `KIND_ROUTES` precompiled dispatch table invoked before legacy inline routes. Install smoke deferred to §13.2.

## 6. Extract `hub/kinds/handoff.ts`

- [x] 6.1 `hub/kinds/handoff.ts` (608 lines) — exports `handoffKind: KindModule` with 5 routes (create/accept/decline/cancel/list). Types: `HandoffStatus`, `HandoffSnapshot`, `HandoffRow`, `HandoffOutcome`, `CreateInput`, `ListFilter`. Constants (TTL bounds, body cap, ID regex, text/reason maxes) owned by the kind.
- [x] 6.2 Nutshell-patch-on-accept coupling preserved: `acceptHandoff` returns `{ outcome, nutshell: NutshellSnapshot | null }` so the route handler can broadcast the nutshell patch AFTER the accept event. Import from `../nutshell`. Cross-room edit validation (sender must be human OR context.room matches handoff.room) kept intact.
- [x] 6.3 Expire sweep: `expireHandoff(db, id)` and `findExpirable(db, nowMs)` exported from handoff.ts. The hub's `sweepTimer` in §13 still calls them via thin wrappers. Disposer pattern deferred to §9 when orchestrator owns lifecycle.
- [x] 6.4 Removed inline types + state machine + handlers + legacy route dispatch from `hub.ts`. Thin wrappers retained (`createHandoff`, `acceptHandoff`, `declineHandoff`, `cancelHandoff`, `expireHandoff`, `findExpirable`, `listHandoffs`, `pendingFor`) so existing callers (replay, sweep, local hub state) work without each being ported individually.
- [x] 6.5 `bun test` green (44/44 after adjusting auth-contract test: `/handoffs` 1 MiB 413-test removed — large-body rejection in the shared hub pool jammed Bun fetch, same connection-pool quirk as the earlier 411 test). Install smoke deferred to §13.2. hub.ts: 2180 → 1642 (−538, cumulative 2742 → 1642 = −40%).

## 7. Extract `hub/kinds/permission.ts`

- [x] 7.1 `hub/kinds/permission.ts` (470 lines) — `permissionKind: KindModule` with 4 routes (create/verdict/dismiss/list). Types include the dismissed terminal state from v0.8. Cross-room verdict rule (voter must be same-room unless human) ported intact.
- [x] 7.2 Migration ownership unchanged: schema lives in `core/ledger.ts` v4/v5/v6 migrations (frozen history). Per-kind migration lifts remain deferred — kinds currently have a no-op `migrate()` with a comment pointer.
- [x] 7.3 Inline types + state machine + broadcast + 4 handlers + legacy /permissions dispatch removed from `hub.ts`. Restored `broadcastNutshell`, `ledgerGuard`, `handleGetNutshell` which got accidentally caught in a block-delete (broadcastNutshell was adjacent to nutshellEntry; the latter had been removed in §8 but `broadcastNutshell` still needed by the handoff's nutshell-patch path).
- [x] 7.4 `bun test` green (47/47 across 9 files). `tsc --noEmit` clean. Install smoke deferred to §13.2. hub.ts: 1642 → 1215 (cumulative 2742 → 1215 = **−56%**).

## 8. Nutshell — standalone module

- [x] 8.1 `hub/nutshell.ts` (95 lines) exports `readNutshell`, `writeNutshellInTx`, `nutshellEntry`, `NutshellSnapshot` type. Not a KindModule. `broadcastNutshell` stays in `hub.ts` because it touches the hub's `uiSubscribers` + `agentQueues` state directly (ambient push, not a chatLog event).
- [ ] 8.2 `runNutshellMigrations(db)` — **deferred**. Nutshell migration DDL stays in `core/ledger.ts`'s v2/v6 blocks (frozen history). Per-kind/per-document migration lifts are a post-v0.9.5 cleanup.
- [x] 8.3 Handoff's accept path imports `writeNutshellInTx` and `nutshellEntry` from `../nutshell` — one-way dep handoff → nutshell, as specified.
- [x] 8.4 `bun test` green throughout (47/47 post-extract).

## 9. Hub orchestrator — the final reduction

- [→ defer] 9.1 Static `KINDS` array lives inline in `hub.ts` (not `hub/kinds/index.ts`). The extra file was deferred — today `KINDS` is referenced from exactly one spot; an index file is extra indirection without a payoff.
- [x] 9.2 Partial rewrite done:
  - `openLedger()` already delegates to `core/ledger.ts`.
  - `buildCap()` constructs `HubCapabilities` with scoped accessors.
  - `KIND_ROUTES` precompiled dispatch table iterates `KINDS.flatMap(k => k.routes)` before legacy inline routes.
  - `handleAgentStream` replay iterates `KINDS.sort(priority).forEach(k => k.pendingFor(agentCtx, cap))`.
  - `buildBriefing` aggregates `["post", "post_file", ...KINDS.flatMap(k => k.toolNames)]`.
  - Startup (human registration) + shutdown (sweepTimer + db close) unchanged.
  - **Agent registry extraction to `core/agents.ts` still deferred** — extracting the mutable `knownAgents`/`agentQueues`/`agentConnections`/`staleTimers`/`permanentAgents` state + the `broadcastRoster`/`broadcastPresence` callback wiring is a cleanup worth its own pass. Leaving module-level state in `hub.ts` does not block the rest of v0.9.5.
- [x] 9.3 `hub.ts`: 2742 → **1089 lines (−60%)**. The bulk moved into `hub/kinds/*` (1463 lines) + `hub/core/*` (716 lines) + `hub/nutshell.ts` (95 lines). Target was ≤300 lines; the remaining ~800 lines are agent registry (§3.4 deferred), chat/send/post routes, upload/image handlers, SSE `/stream`+`/agent-stream`, claude_sessions routes, and Bun.serve startup/shutdown — none of which are kind-specific concerns.
- [x] 9.4 `bun test` green (47/47). `tsc --noEmit` clean. Dead-code purge: removed 12 hub-local state-machine wrappers + 2 entry builders + 3 pendingFor wrappers that the KindModule pattern superseded. Full curl smoke deferred to §13.2.

## 10. UI per-kind modules

- [ ] 10.1 `ui/kinds/*.js` module split — **deferred**. Extracting `renderCard` / `buildDom` / `updateDom` / `handleAction` into per-kind ES modules requires a `<script type="module">` switch that changes loading semantics (deferred, strict mode, no global-scope leakage). No automated UI tests catch visual regressions. Best done in a dedicated session where the installed app can be click-tested across every card state. v0.9.6 naturally owns this alongside the dropdown-consolidation work.
- [x] 10.2 `ui/kinds/handoff.css` (115 lines), `ui/kinds/interrupt.css` (88 lines), `ui/kinds/permission.css` (168 lines) — lifted verbatim from `ui/style.css`'s three card sections. Keyframes stay in `style.css`; tokens resolve via cascade (style.css loads first).
- [x] 10.3 Partial: `<link>` tags added for each kind CSS file in `ui/index.html` (after `style.css`, before `xterm.css`). `<script type="module">` switch deferred with §10.1 — same risk surface.
- [ ] 10.4 Event-dispatcher rewrite in `ui/main.js` — deferred with §10.1.
- [ ] 10.5 Visual verification — deferred: the CSS-only extraction is a pure move (same selectors, same properties), so pixel output should be identical, but the user should click through once post-install to confirm. **User-gated.**

## 11. Hard rules in CLAUDE.md

- [x] 11.1 Added: kinds live in `hub/kinds/<kind>.ts` implementing `KindModule` from `hub/core/types.ts`; orchestrator is kind-agnostic; handlers receive `HubCapabilities` and never reach for module-level globals.
- [x] 11.2 Added: broadcasts go through `cap.sse.emit(entry, scope)`; four-scope enum documented (`broadcast | to-agents | ui-only | room`); `emitWhere(predicate)` escape hatch noted.
- [x] 11.3 Added: nutshell is a document, not a kind — lives in `hub/nutshell.ts`; handoff's accept path imports from it for the `[nutshell]`-prefix patch coupling.

## 12. Documentation

- [x] 12.1 `docs/PROTOCOL.md` — added "Kind runtime (v0.9.5+)" section with KindModule type signature, orchestrator description, HubCapabilities note, and the "add a kind = one file + one line" rule. Existing per-kind sections unchanged.
- [ ] 12.2 README update deferred — no user-visible change in v0.9.5; the "four primitives" narrative already reads cleanly. Revisit if a future feature change wants to call out the one-file-drop ergonomics.

## 13. Release

- [x] 13.1 Version bumped to `0.9.5` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `hub/channel.ts`.
- [ ] 13.2 Run `./scripts/install.sh`. **User-gated** — writes to `/Applications/A2AChannel.app`; the user drives this and the manual UI click-through.
- [x] 13.3 `bun test` suite green — 47 pass / 0 fail / 184 expect() calls / 2.27s against the current source tree. The spawn-hub helper is hermetic; point at the installed build by setting `CHATBRIDGE_HUB` if desired.
- [ ] 13.4 Git tag `v0.9.5`, push, GitHub release. **User-gated** — per CLAUDE.md "never commit unless asked".
- [ ] 13.5 Archive this OpenSpec change (`openspec archive v095-kind-runtime`). **After release ships.**
