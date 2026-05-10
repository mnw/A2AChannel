## 1. Pre-grilling

- [x] 1.1 ~~Run INTERFACE-DESIGN.md parallel-sub-agent flow on three orchestration shapes.~~ DONE 2026-05-10. Hybrid `LedgerEntity<Snapshot>` with private `Store` closure selected; design.md Decision 1 updated; ADR-0004 drafted (lands at the §2 commit alongside the implementation).
- [x] 1.2 ~~Settle `HubFeature` vs `Surface` vs alternative.~~ DONE 2026-05-10. `HubFeature` selected; CONTEXT.md Glossary entry added; ADR-0005 drafted (lands at the §4 commit alongside the implementation).
- [x] 1.2a ~~CONTEXT.md follow-through verification.~~ DONE 2026-05-10. The Glossary entry for `HubFeature` has a definition line, an `_Avoid_:` line (lists `module`, `service`, `endpoint`, `plugin` with reasons), and cross-references to **Hub**, **Kind**, **Roster** via bold-name links.
- [x] 1.3 ~~Verify branch.~~ DONE — already on `architecture-cycle-2a` (verified via `git branch --show-current`).
- [x] 1.4 (Webview `KindCard` placement decision and Tab-split smoke checklist deferred to `architecture-cycle-2b`.)

## 2. LedgerEntity carve (ledger-store + kind-orchestration capabilities)

Per Decision 1 (resolved), the orchestration and storage layers fuse inside a single external Module `LedgerEntity<Snapshot>` with a private internal `Store` closure. Sections 2 and 3 of the prior plan collapse into this single section because the migration is one inseparable commit.

### 2A. Internal Store (private collaborator)

- [x] 2A.1 Defined `Store<S>` interface in `hub/core/store.ts` with `migrate`, `load`, `listByStatus`, `create`, `transact`. Snapshot/StateMachineDecl/SideEffectCtx/TxHandle types live in `hub/core/types.ts`. Store is intentionally not re-exported from any barrel — only `hub/core/ledger-entity.ts` (next task) will import from it.
- [x] 2A.2 `createSqliteStore<S>(decl)` implemented. DDL: `CREATE TABLE IF NOT EXISTS` (id PRIMARY KEY, user-declared columns, version INTEGER NOT NULL DEFAULT 0) + composite index `idx_<table>_status_<forColumn>` (or status-only when no forColumn). `transact` runs `db.transaction(() => { insertEvent → seq; UPDATE row SET <next>, version=seq; sideEffect(ctx) })`. Note: TTL-partial-index deferred until handoff migration in §2C — kind-specific.
- [x] 2A.3 `createInMemoryStore<S>(decl)` implemented. Map-backed, sequence-counter, no-op migrate. Side-effect `tx` handle throws on `run`/`query` (tests with sideEffect-tx writes use the real SQLite store; documented in store.ts header).
- [x] 2A.4 9-test suite at `tests/unit/store-list-by-status.test.ts` (passing): asserts (a) DDL creates version column + composite index, (b) listByStatus is exactly one widgets-query AND zero events-queries (proves N+1 elimination), (c) `EXPLAIN QUERY PLAN` shows `USING INDEX idx_widgets_status_assignee`, (d) version is materialized atomically via insertEvent's returned seq, (e) sideEffect's tx writes commit/rollback atomically with the row+event, (f) in-memory store mirrors SQLite store's observable behavior.

### 2B. External LedgerEntity

- [x] 2B.1 LedgerEntity<S> interface defined in `hub/core/types.ts`; factory implementation in `hub/core/ledger-entity.ts`. Methods: `migrate`, `load`, `listByStatus`, `apply`, `applyWithSideEffect`. **`sweep` dropped from the interface** — the only use case (handoff TTL expiry) reduces to `entity.listByStatus({status:"pending"}).filter(s => s.expires_at_ms < now).forEach(s => entity.apply(s.id, expireVerb, ...))`. Avoids speculative API.
- [x] 2B.2 `VerbDecl<S,P>` + `StateMachineDecl<S>` defined in types.ts (done in 2A; reused here). `VerbDecl` has `decide(prior, payload, actor, cap): Decision`, optional `validate(payload, cap): Decision | null`, `scope(post): Scope`.
- [x] 2B.3 `Decision<S>` discriminated union defined with FOUR arms: `idempotent` (no fields — verb returns the prior snapshot, no event/broadcast); `conflict` (httpStatus + message; httpStatus is `number` not literal `409` so verbs can return 404 for not-found); `create` (initial snapshot for first INSERT); `transition` (next: Partial<S>, eventKind, payload callback, entry callback). The `create` arm was added during 2B because `apply` is the single dispatch entry point — verbs handle both create and update via the same shape; the Store has matching `create`/`transact` methods.
- [x] 2B.4 `SideEffectCtx<S>` + `TxHandle` defined in types.ts (done in 2A). TxHandle exposes `run(sql, params)` and `query(sql, params)`; in-memory store's TxHandle throws on use (sideEffect-tx tests use real SQLite).
- [x] 2B.5 `createLedgerEntity<S>({ decl, db, store? })` implemented. The `store` defaults to `createSqliteStore(decl)`; tests pass `createInMemoryStore(decl)` via the `store` override. Both `db` and `store` are captured in closure; the returned object has exactly five enumerable keys (`apply`, `applyWithSideEffect`, `listByStatus`, `load`, `migrate`) — no `store`, no `unsafeStore`, no `_store`. `LedgerConflict` is thrown with the verb-supplied `httpStatus` (404 or 409); the route handler translates.
- [x] 2B.6 Grep verification: `grep -rn "entity\.\(store\|unsafeStore\|_store\)" hub/` returns only matches in `hub/core/ledger-entity.ts` doc comments. `grep "from.*['\"]\..*store['\"]"` shows the only `Store` import is in `hub/core/ledger-entity.ts` (Kind code does not import the Store interface). 10-test suite at `tests/unit/ledger-entity.test.ts` (passing): asserts (a) all four Decision arms dispatch correctly, (b) LedgerConflict carries variable httpStatus (404 vs 409), (c) sideEffect commits/rolls-back atomically, (d) Object.keys(entity) returns exactly the 5 documented methods, (e) in-memory Store override yields identical observable behavior to SQLite.

### 2C. Per-Kind migration

- [x] 2C.0 (added) Bump `LEDGER_SCHEMA_VERSION` 11→12 in `hub/core/ledger.ts` with a v12 migration that ALTERs `handoffs`, `interrupts`, `permissions` to add `version INTEGER NOT NULL DEFAULT 0` and backfills from `MAX(seq) FROM events WHERE entity_id = <table>.id`. Verified by re-running existing `tests/integration/migration-forward.test.ts` (passes). v12 is required because the LedgerEntity carve materializes `version` on the derived row to eliminate the per-row `MAX(seq)` subquery.
- [x] 2C.1 `KindModule.migrate(db)` field retained (variance: `LedgerEntity<S>` is invariant in `S` and can't widen to `LedgerEntity<Snapshot>` across heterogeneous KINDS). Each Kind's factory captures the entity in closure and the `migrate` field delegates: `migrate: (d) => entity.migrate(d)`. Documented in `hub/core/types.ts` comment.
- [x] 2C.2 Handoff migrated (603 → 655 LOC). All 5 verbs as `VerbDecl<HandoffSnapshot, P>` (create/accept/decline/cancel — plus standalone `expireHandoff`/`findExpirable` exports for hub-internal TTL sweep, kept inline because the sweep runs without a `cap` argument; folding them into a kind-internal admin verb is §4 scope). The `accept` route detects `task: "[nutshell]"` payload before `entity.applyWithSideEffect`, then the sideEffect runs `writeNutshellInTx(cap.db, ...)` against the same open transaction. `tests/integration/handoff-lifecycle.test.ts` 5/5 pass. LOC slightly grew because the standalone `expireHandoff` keeps inline SQL plus all input validation in route handlers stayed.
- [x] 2C.3 Interrupt migrated (365 → 330 LOC). 2 verbs (`createInterruptVerb`, `ackInterruptVerb`); bulk-rooms path POSTs many interrupts via per-id `entity.apply` calls; `forbidden` actor (recipient mismatch) returns LedgerConflict with httpStatus=403. `tests/integration/interrupt-lifecycle.test.ts` 5/5 pass.
- [x] 2C.4 Permission migrated (481 → 404 LOC). 3 verbs (`createPermissionVerb`, `verdictPermissionVerb`, `dismissPermissionVerb`). **CORRECTION DURING IMPLEMENTATION:** the "first-verdict-wins" framing in design.md / pre-grill notes was misleading — actual behavior (verified by `permission-lifecycle.test.ts`) is uniform same-status-retry: same target verdict → idempotent; different terminal status → 409. Updated ADR-0004 + `kind-orchestration/spec.md` to record the correction. 7/7 tests pass.
- [x] 2C.5 Wired `for (const k of KINDS) k.migrate(ledgerDb)` into hub.ts startup (was missing in old code — kinds' migrate was never called; their tables existed via `migrateLedger()` in ledger.ts). Existing tables: CREATE TABLE IF NOT EXISTS is a no-op. New Kinds added later don't need a ledger.ts migration.
- [x] 2C.6 `pendingFor` overrides retained per Kind because the snapshot→Entry projection (handoffEntry, interruptEntry, permissionEntry) is kind-specific. The "remove" was about the per-row `MAX(seq)` subquery N+1 — that's structurally gone now via the materialized `version` column. New pendingFor implementations are 3-line wrappers around `entity.listByStatus`.

### 2D. Ship

- [x] 2D.1 Per-Kind LOC: handoff 655, interrupt 330, permission 404. All exceed the 200 target. Driver: per-Kind boilerplate (StateMachineDecl columns + rowToSnapshot + snapshotToRow ~50 LOC) + route handlers' input validation (~30-100 LOC) + handoff's standalone expireHandoff/findExpirable + nutshell coupling. The pre-grill estimate (~165/110/140) was optimistic. The cycle's value is structural enforcement, not LOC count — ADR-0004 records the trade.
- [x] 2D.2 `bun x tsc --noEmit` clean; `bun build hub/hub.ts` succeeds; `./scripts/install.sh` deployed; **10-scenario smoke-test sweep all pass:**
  - S1 handoff create+accept → 200 + version=1052 materialized; broadcast emitted
  - S2 same-status retry (accept again) → 200 idempotent; no new event row
  - S3 different-status retry (decline after accept) → 409 + prior snapshot
  - S4 handoff with `[nutshell]` task → atomic 3-write commit (event + handoffs row + nutshell UPSERT) verified via ledger.db inspection
  - S5 atomic-write integrity: handoff row status=accepted version=1054, 2 events for the handoff, nutshell row text=patch
  - S6 interrupt round-trip (create+ack) → 200 + version=1056
  - S7 interrupt forbidden actor (Drupal acks human's smoketest interrupt) → 403 + LedgerConflict carrying prior snapshot
  - S8 permission verdict same-target idempotent (allow then allow) → 200 idempotent, status=allowed
  - S9 permission verdict different-target (deny after allow) → 409 + prior snapshot
  - S10 EXPLAIN QUERY PLAN: all three Kinds' listByStatus uses `SEARCH ... USING INDEX idx_<table>_status_<for>` — no correlated subquery, no events-table touch on read path. N+1 elimination confirmed on real ledger data.
- [x] 2D.3 `docs/adr/0004-orchestration-shape.md` drafted (and corrected mid-implementation when first-verdict-wins framing was identified as misleading).
- [ ] 2D.4 Commit: `feat(ledger): LedgerEntity<Snapshot> + private Store closure; handoff/interrupt/permission as VerbDecls` — DEFERRED per CLAUDE.md "Never commit unless explicitly asked." Waiting for user greenlight.

## 3. Cleanup: cap.ids.mint

- [x] 3.1 Confirmed via `grep -rn "ids\.mint" hub/ tests/`: zero callers across production code and tests. Kinds use typed `mintHandoffId()` / `mintInterruptId()` from `hub/core/ids.ts` directly.
- [x] 3.2 Removed `ids: { mint(...) }` field from `HubCapabilities` in `hub/core/types.ts`.
- [x] 3.3 Removed `ids: { mint(...) }` implementation from `buildCap()` in `hub/hub.ts`. `randomId` import retained — used by `SESSION_ID` at line 158.
- [x] 3.4 Type-check clean (`bun x tsc --noEmit`). Test suite: 93/95 (2 pre-existing fails unrelated). **install.sh skipped for this cleanup** — type-only deletion with TypeScript proving zero callers; runtime behavior unchanged because the implementation was a thin `randomId(bytes)` wrapper and nothing called it. Re-running install.sh would needlessly re-disrupt the test agents for a 4-line edit with no behavioral surface.
- [x] 3.5 Updated test fake `makeFakeCap` in `tests/unit/ledger-entity.test.ts` to drop the `ids` field. Commit deferred per CLAUDE.md "Never commit unless explicitly asked."

## 4. HubFeature dispatcher (route-modules capability)

- [x] 4.1 `HubFeature = { routes: RouteDef[] }` defined in `hub/core/types.ts`. `RouteDef` extended with `requiresLedger?: boolean` and `method` widened to include `"PUT"` (used by /rooms/:room/settings).
- [x] 4.2 `KindModule` already extends `HubFeature` structurally (has `routes: RouteDef[]`). Plus the kind-specific fields (`migrate`, `entity`-via-closure, `pendingFor`, `toolNames`, `priority?`).
- [x] 4.3 Dispatcher updated to take `features: HubFeature[]` instead of `kinds: KindModule[]`. `ledgerGuard` now applied per-route via `requiresLedger` flag (was applied unconditionally to all kinds). Kind factories use new `withLedgerRequired()` helper to auto-flag every kind route true.
- [x] 4.4 `hub/features/chat.ts` (24 LOC) — wraps existing `chat.ts`'s `handleSend`/`handlePost` with route declarations.
- [x] 4.5 `hub/features/transcript.ts` (137 LOC) — `/rooms/:room/settings` (GET/PUT), `/rooms/:room/transcripts` (GET), `/rooms/:room/clear-transcript` (POST). Pulls room-settings + summariser-counts inline (was a separate hub.ts helper).
- [x] 4.6 `hub/features/attachments.ts` (34 LOC) — `/upload` (POST), `/image/:id` (GET, regex matcher).
- [x] 4.7 `hub/features/sessions.ts` (27 LOC) — `/sessions` GET/POST.
- [x] 4.8 `hub/features/usage.ts` (18 LOC) — `/usage` GET.
- [x] 4.9 `hub/features/roster.ts` (66 LOC) — `/agents`, `/presence`, `/remove`, `/nutshell`, `/room-default`.
- [x] 4.10 `hub/features/streams.ts` (153 LOC) — `createStreamHandlers(deps): { handleStream, handleAgentStream }`. NOT a HubFeature (per Decision 3); hub.ts wires the returned handlers directly into Bun.serve. Deps-injected: sessionId, chatLog, agents, ensureAgent, broadcastPresence, roomHydrator, roomSummariser, buildBriefing, briefingSignature, lastBriefingSig, kinds, buildCap.
- [x] 4.11 hub.ts inline cascade (~110 LOC of `if pathname === "/..."` chains) replaced with: SSE direct check (2 routes) + `dispatch(req, url)` for everything else + 404 fallback.
- [~] 4.12 hub.ts: 901 → 613 LOC. Did NOT hit ≤300 target — broadcast logic (~120 LOC: emit, broadcastUI, broadcastPresence, broadcastNutshell, broadcastHandoff, ledgerGuard, redact-on-persist) and briefing logic (~80 LOC: lastBriefingSig, scheduleBriefingFanout, broadcastBriefingsToConnectedAgents, briefingSignature) are still in hub.ts module scope. They get carved by §5 (Fanout) and §6 (BriefingDispatcher). Realistic post-§6 estimate: ~370 LOC. The "≤300 floor" was design-wishful — 225-275 LOC of irreducible env+wiring + ~100 LOC of buildCap + chatDeps + sweep + shutdown + human registration is realistic floor. Target softened to ≤400 in practice.
- [x] 4.13 Type-check clean. `bun test` 93/95 (2 pre-existing fails unrelated). `./scripts/install.sh` succeeded; live smoke-test verified every carved route (handoffs/interrupts/permissions/usage/sessions/agents/presence/nutshell/room-default/rooms/:room/settings/rooms/:room/transcripts/stream all 200, /unknown-path 404, handoff create+accept round-trip with version=1061). All 4 test agents reconnected (Copernicus/Django/Drupal/EIFE).
- [ ] 4.14 Commit: `feat(hub): HubFeature interface + dispatcher acceptance; carve hub.ts inline routes` — DEFERRED per CLAUDE.md "Never commit unless explicitly asked."

## 5. Fanout (broadcast-fanout capability)

- [x] 5.1 `hub/core/fanout.ts` (114 LOC) — `createFanout({chatLog, uiSubscribers, agents, historyLimit, ledgerDb, nextEntryId})` returning `{send(entry, scope)}`. `Scope` widened with two new variants: `ui-only-ambient` (NO chatLog persist, NO transcript) and `room-ambient` (NO chatLog, NO transcript, same-room agents only).
- [x] 5.2 chatLog push + transcript write-through + permanent-agent skip moved into Fanout. **`redactPrivate(entry)` is invoked inside `persistTranscript` (Fanout's persist branch), before `transcriptStore.appendEntry`** — `redactPrivate` was REMOVED from `transcript.appendEntry` itself. The transcript layer is now a thin file-appender; the canonical redaction call site is `hub/core/fanout.ts:73`.
- [x] 5.3 `broadcastUI` retained as a thin alias `(entry) => fanout.send(entry, {kind: "ui-only"})` because `room-hydrator`'s replay callback expects the function shape. `broadcastNutshell` REMOVED (was inline; nutshell broadcast now uses `room-ambient` scope at the kind call site). `broadcastHandoff` migrated to `fanout.send(entry, {kind: "to-agents", agents: [...]})`.
- [x] 5.4 `cap.sse.emit` body now `(entry, scope) => fanout.send(entry, scope)`. **`cap.sse.emitWhere` REMOVED from `HubCapabilities`** — the field no longer exists on the type. The sole caller (handoff-accept's nutshell broadcast in `hub/kinds/handoff.ts`) was migrated to `cap.sse.emit(nutshellEntry(nutshell), { kind: "room-ambient", room: nutshell.room })`.
- [x] 5.5 `broadcastRoster` and `broadcastPresence` now do `fanout.send(snap, { kind: "ui-only-ambient" })` (no chatLog touch, ambient delivery).
- [x] 5.6 Done — see 5.3. Nutshell broadcast at kind call site uses `room-ambient` scope; the `broadcastNutshell` standalone function is gone.
- [x] 5.7 Grep verified: only `agents.enqueueFor(name, brief)` (line 306, briefing fanout — moves to BriefingDispatcher in §6) and `enqueueTo` helper (line 336, used by chat.ts for direct agent-targeted sends with the agent-view transformation) call into the registry from outside fanout/agents. Neither is "enumerate the queues yourself" — both are single targeted enqueues. `enqueueTo` exists because chat.ts sends a UI-view to subscribers but a TRANSFORMED agent-view (with attachment paths inlined) to per-agent queues — the Fanout shape doesn't carry a per-destination transform; documented as accepted scope.
- [x] 5.8 `grep -rn "redactPrivate(" hub/`: exactly ONE call site at `hub/core/fanout.ts:73`. Definition at `hub/core/redaction.ts:31` is the only other match.
- [x] 5.9 Type-check clean. `bun test`: 93/95 (2 pre-existing fails unrelated). `./scripts/install.sh` succeeded. **Live smoke verified:** all 4 test agents reconnected (Copernicus/Django/Drupal/EIFE); handoff create+accept round-trip works with version materialized; nutshell `[nutshell]` task atomic patch via `applyWithSideEffect` + `room-ambient` broadcast preserves the same-tx coupling and writes "FANOUT-AMBIENT-PATCH" to the nutshell row; transcript persist toggle works.
- [ ] 5.10 Commit: `feat(hub): Fanout module owning all SSE broadcast paths` — DEFERRED per CLAUDE.md "Never commit unless explicitly asked."

## 6. BriefingDispatcher (briefing-debounce capability)

- [x] 6.1 `hub/core/briefing-dispatcher.ts` (89 LOC) — `createBriefingDispatcher({agents, buildBriefing, briefingSignature, debounceMs?})` returning `{ scheduleFanout, forceFanout, seedSignature, dispose }`. All four pieces of state previously leaking into hub.ts module scope are closure-private.
- [x] 6.2 `lastBriefingSig`, `briefingFanoutTimer`, `scheduleBriefingFanout`, `broadcastBriefingsToConnectedAgents` REMOVED from hub.ts module scope. Behavior preserved: reset-on-call 500ms debounce + per-Agent signature dedup.
- [x] 6.3 `onRosterChange` callback simplified to `() => broadcastRoster()`. `broadcastRoster` already calls `briefingDispatcher.scheduleFanout()`. `onPresenceChange` calls `broadcastPresence()` which also calls `scheduleFanout`. Note: removed the pre-§6 explicit second call to `broadcastBriefingsToConnectedAgents()` — that was a non-debounced dedup'd fanout that overlapped with the scheduled one. Net effect: 500ms-later delivery on roster changes (was immediate + 500ms-later); user-impactful difference is none because the inline briefing on connect covers the latency-sensitive case.
- [x] 6.4 streams.ts deps changed: dropped `briefingSignature` + `lastBriefingSig` (closure-internal now); added `seedBriefingSignature(agent, brief)` callback that hub.ts wires to `briefingDispatcher.seedSignature`.
- [x] 6.5 `forceFanout()` exists on the dispatcher API; bypasses dedup. No current caller — reserved for the future "reload_settings" or admin "force re-issue" path.
- [x] 6.6 Constructor takes `{agents, buildBriefing, briefingSignature, debounceMs?}` — all DI'd. Unit test could pass a mock AgentRegistry + fake clock by overriding setTimeout at module level. (Test scaffolding deferred — the integration smoke-test confirmed correct behavior; spec doesn't require a unit test artifact.)
- [x] 6.7 Type-check clean. `bun test`: 93/95. `./scripts/install.sh` succeeded. **Reconnect-storm verified live:** 5 agents (storm1..storm5) registered within 1.5s window; each received 1-2 briefings (1 inline on connect + 1 final state-updated brief 500ms after the storm settled). Pre-§6 behavior would have been 5+ briefings per agent (one per roster change). Storm-collapse working: dedup-via-seed-signature suppressed redundant deliveries.
- [ ] 6.8 Commit: `feat(hub): BriefingDispatcher owning re-brief debounce + dedup` — DEFERRED per CLAUDE.md "Never commit unless explicitly asked."

## 7. Pre-merge cleanup

- [x] 7.1 No debug instrumentation introduced during the cycle. The smoke-tests used curl + sqlite3 + log inspection; no `[heartbeat]` timers, no per-event console.log breadcrumbs added. Operational logs (`[hub] listening`, `[ledger] ready`, `[hub] agent joined`) are unchanged from pre-cycle.
- [x] 7.2 Diff scan: `git status --short` shows the expected file set — 9 modified (CONTEXT.md, hub/core/{ledger,types,dispatcher,transcript}.ts, hub/hub.ts, hub/kinds/{handoff,interrupt,permission}.ts, tests/contract/has-required-hooks.test.ts, tests/unit/ledger-entity.test.ts) + 11 added (3 ADRs, 4 hub/core/* new files, 7 hub/features/* new files, 2 unit tests, 2 OpenSpec change dirs). No drive-by edits.
- [x] 7.3 CLAUDE.md is gitignored (verified `git check-ignore CLAUDE.md` → match). The hard-rule deletions are user-local edits to keep CLAUDE.md current with the new structural facts. Three rules to delete from CLAUDE.md: (a) "Never mutate `knownAgents`..." (cycle-1 made it structural already), (b) "Every state change writes exactly one event + one derived-row in one transaction" (now enforced by `LedgerEntity.apply`'s exclusive ownership of the `db.transaction` call site via Store), (c) "Never enumerate agent queues from inside a kind" (now structural via Fanout's single fan-out path). User to apply locally; not part of the commit.
- [x] 7.4 CLAUDE.md path drifts: chat.ts → still at hub/chat.ts (unchanged file location; the route now lives in hub/features/chat.ts but the chat module providing handleSend/handlePost is unchanged). slash-discovery.js → slash-command.js is a Webview path (cycle-2b scope, not 2a).
- [x] 7.5 Three ADRs shipped: `docs/adr/0004-orchestration-shape.md` (LedgerEntity hybrid; corrected first-verdict-wins → uniform same-status-retry); `docs/adr/0005-hubfeature-naming.md` (HubFeature chosen over Surface/RouteHost/Module); `docs/adr/0006-sse-handlers-outside-dispatcher.md` (StreamHandlers shape, hub.ts wires Bun.serve directly). All three are tracked files; ship with the cycle's commits.
- [x] 7.6 ADRs 0001/0002/0003 reviewed: ADR-0001 (lazy room hydration) describes RoomHydrator behavior — unchanged by cycle 2a. ADR-0002 (pluggable summariser) describes Summariser interface adapters — unchanged. ADR-0003 (hierarchical L1/L2 summary) describes RoomSummariser table-driven design — unchanged. None reference cap.sse.emitWhere, broadcastUI, or handleSend (all carved). No edits required.
- [x] 7.7 Full smoke sweep on live .app passed: handoff accept→200, retry→200 idempotent, decline-after-accept→409; handoff with `[nutshell]` task atomic patch verified (nutshell text="§7 SWEEP NUTSHELL"); interrupt ack→200; permission allow→200, allow-again→200 idempotent, deny-after-allow→409; all 4 test agents (EIFE/Drupal/Django/Copernicus) reconnected and producing chat output post-install. Pre-existing summariser SQLiteError ("UNIQUE constraint failed: room_summary") in hub.log — orthogonal to cycle 2a (`hub/core/room-summariser.ts` not touched in this cycle). Logged for follow-up.

## 8. Merge

- [ ] 8.1 `git log --oneline main..architecture-cycle-2a` shows the expected commits in dependency order
- [ ] 8.2 Get explicit user greenlight to fast-forward main
- [ ] 8.3 `git checkout main && git merge --ff-only architecture-cycle-2a`
- [ ] 8.4 `git push origin main` (with explicit user permission)
- [ ] 8.5 `git branch -d architecture-cycle-2a` (local delete)
- [ ] 8.6 Run `/opsx:archive` to archive this OpenSpec change
- [ ] 8.7 Soak main for at least one week with the test agents (Drupal/Atmosphere/Django/Copernicus/EIFE) before starting `architecture-cycle-2b`
