## ADDED Requirements

### Requirement: Persistent state-machine kinds implement the `KindModule` contract

Every persistent state-machine primitive added to the hub (including the existing `handoff`, `interrupt`, and `permission` primitives) SHALL be implemented as a module conforming to the `KindModule` contract. The contract exposes exactly these integration points:

- `kind: string` — a unique kebab-case identifier used as the prefix for the kind's SSE event kinds (e.g., `"handoff"` → `handoff.new`, `handoff.update`).
- `migrate(db: Database): void` — idempotent schema-migration step invoked once at hub startup.
- `routes: RouteDef[]` — a static array of HTTP route declarations. Each `RouteDef` includes method, path matcher, auth class (`"mutating"` or `"read"`), optional body size cap, and a `handler(req, cap, params)` function invoked per request.
- `pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[]` — returns the list of broadcast entries (with `replay: true`) to emit to a reconnecting agent.
- `toolNames: string[]` — names of MCP tools chatbridge exposes for this kind; the hub aggregates these into the briefing.
- `priority?: number` — optional replay-ordering hint. Defaults to `0`. Higher priority kinds replay first. Kinds MUST NOT depend on cross-kind ordering for correctness; this field exists only as an escape hatch for future kinds whose state must become visible before others can query it.

The hub orchestrator (`hub/hub.ts`) SHALL contain no kind-specific code. It iterates a static `KINDS` array, calls `migrate` on each, registers their routes into `Bun.serve`, and invokes `pendingFor` on `/agent-stream` reconnect.

**Core invariant:** Kinds formalize persistent state-machine entities backed by the event ledger. Ephemeral broadcasts (presence, typing indicators), single-row documents (nutshell), and config/rules do not use this contract.

#### Scenario: Registered kind is migrated on startup

- **GIVEN** a new `KindModule` named `foo` is exported and listed in `hub/kinds/index.ts`
- **WHEN** the hub starts and `openLedger()` runs
- **THEN** `foo.migrate(db)` is invoked exactly once
- **AND** subsequent hub restarts invoke `foo.migrate(db)` again and the migration observes its own idempotency (no-op on second run)

#### Scenario: Registered kind's routes are wired into Bun.serve

- **GIVEN** `foo.routes` declares `[{ method: "POST", path: "/foos", auth: "mutating", bodyMax: 16384, handler }]`
- **WHEN** the hub dispatches an incoming request for `POST /foos`
- **THEN** the hub applies `requireAuth` (because `auth: "mutating"`) and `requireJsonBody(req, 16384)` before invoking `handler(req, cap, {})`
- **AND** the handler receives a live `HubCapabilities` object

#### Scenario: Adding a kind requires no edits to hub.ts

- **WHEN** a developer introduces a new kind `foo` by creating `hub/kinds/foo.ts` and adding one import + one array entry to `hub/kinds/index.ts`
- **THEN** the hub orchestrator in `hub/hub.ts` requires zero edits
- **AND** the kind's migration, routes, briefing tools, and replay all activate on the next hub start

### Requirement: `HubCapabilities` injection is the sole access path to shared hub services

Kind implementations SHALL access shared services (SQLite database, SSE emit, agent registry, auth helpers, event-log insert, id minting, config) exclusively through the `HubCapabilities` object passed into their hooks. Reaching for module-level globals or importing from `hub/hub.ts` is prohibited.

Each hook receives only the capabilities it needs:
- `migrate(db)` — receives the bare `Database` handle, nothing else.
- `handler(req, cap, params)` — receives full `HubCapabilities`.
- `pendingFor(agent, cap)` — receives full `HubCapabilities`.

`HubCapabilities` shape:

```
{
  db: Database,
  agents: { get(name), isPermanent(name), all() },
  sse: { emit(entry, scope), emitWhere(entry, predicate) },
  auth: { requireAuth, requireReadAuth, requireJsonBody },
  ids: { mint(prefix, bytes?) },
  events: { insert(db, entity_id, kind, actor, payload, at_ms) },
  config: { humanName, attachmentsDir }
}
```

#### Scenario: Kind hook receives scoped capabilities

- **GIVEN** `foo.migrate` is declared as `(db) => …`
- **WHEN** the orchestrator invokes it
- **THEN** the function receives only the `Database` handle
- **AND** the function cannot invoke `cap.sse.emit()` (SSE is not in its parameter list)

#### Scenario: Handler receives full capabilities

- **GIVEN** a route handler `(req, cap, params) => …`
- **WHEN** the orchestrator dispatches an inbound request to it
- **THEN** `cap` contains `db`, `agents`, `sse`, `auth`, `ids`, `events`, `config` as described
- **AND** the handler can perform any documented operation (insert an event, emit a broadcast, check agent presence) without reaching for globals

### Requirement: SSE broadcasts use named scopes; kinds emit, the SSE layer resolves recipients

Kinds SHALL construct an `Entry` and emit it with a `Scope` via `cap.sse.emit(entry, scope)`. The SSE layer SHALL be the sole owner of the mapping from scope to queue list.

**Core invariant:** Kinds emit entries + scopes. The SSE layer resolves scopes to recipients.

Named scopes at v0.9.5 ship:

- `{ kind: "broadcast" }` — UI subscribers + every non-permanent agent queue.
- `{ kind: "to-agents"; agents: string[] }` — UI subscribers + the listed agents' queues. Unknown or permanent agents in the list are skipped. Used for recipient-specific events (handoff.new → `[to]`; handoff.update → `[from, to]`).
- `{ kind: "ui-only" }` — UI subscribers only. Used for roster/presence/nutshell updates.
- `{ kind: "room"; room: string }` — UI subscribers + every non-permanent agent whose `AgentCtx.room === <room>` + the human (who exists in every room). Lands in conjunction with v0.9 rooms.

An `emitWhere(entry, predicate)` escape hatch exists for one-off use cases (admin actions, debug endpoints) but kinds SHOULD prefer named scopes. Promoting a predicate to a named scope is the right move when the same predicate appears in two or more kinds.

#### Scenario: Handoff broadcast lands in UI and recipient's queue

- **GIVEN** a `handoff.new` event for handoff id `h_xxx` from `alice` to `bob`
- **WHEN** the kind calls `cap.sse.emit(entry, { kind: "to-agents", agents: ["bob"] })`
- **THEN** every `/stream` UI subscriber receives the entry
- **AND** `bob`'s `/agent-stream` queue receives the entry
- **AND** no other agent queue (including `alice`'s) receives the entry unless `alice` happens to be a UI subscriber

#### Scenario: Room-scoped broadcast excludes agents in other rooms

- **GIVEN** agents `a1` in room `R` and `a2` in room `S`
- **WHEN** a kind emits an entry with scope `{ kind: "room", room: "R" }`
- **THEN** UI subscribers receive the entry
- **AND** `a1` receives the entry
- **AND** `a2` does NOT receive the entry
- **AND** the human receives the entry (human participates in every room)

#### Scenario: SSE layer skips removed or permanent agents

- **GIVEN** scope `{ kind: "broadcast" }` and agent `gone` was removed from the roster
- **WHEN** the SSE layer resolves the scope
- **THEN** `gone` is skipped (its queue no longer exists)
- **AND** the human (permanent) is not enqueued — the human reads via `/stream`

### Requirement: Kinds are statically registered

All kinds SHALL be imported and listed in `hub/kinds/index.ts` as a `readonly KindModule[]` array. Dynamic loading, config-driven plugin discovery, or runtime module resolution are prohibited.

**Core invariant:** All kinds are statically registered. No dynamic loading.

#### Scenario: KINDS array is the canonical registry

- **GIVEN** `hub/kinds/index.ts` exports `KINDS = [handoffKind, interruptKind, permissionKind]`
- **WHEN** the hub starts
- **THEN** exactly those three kinds are migrated, routed, and replayed
- **AND** no other kind can be added at runtime

#### Scenario: Bun compile inlines every kind statically

- **WHEN** `bun build --compile` produces `a2a-bin`
- **THEN** the resulting binary contains all kind modules inline (verified by absence of dynamic `import()` calls in the kind-loading path)

### Requirement: Replay order across kinds is undefined

On `/agent-stream` reconnect, the orchestrator SHALL invoke `kind.pendingFor(agent, cap)` for each kind in registry order (sorted ascending by `priority ?? 0`). Kinds MUST NOT depend on any cross-kind ordering for correctness.

**Core invariant:** Replay order is undefined. Kinds must not depend on cross-kind ordering.

Within a kind, `pendingFor` SHALL order entries deterministically per the kind's own semantics (e.g., interrupts newest-first). Across kinds, no ordering is guaranteed.

#### Scenario: Reconnect replays every kind's pending entries

- **GIVEN** agent `alice` has one pending handoff, one pending interrupt, and two pending permissions
- **WHEN** `alice` reconnects to `/agent-stream`
- **THEN** the hub emits all four entries, each flagged `replay: true`
- **AND** the relative ordering between kinds is not guaranteed
- **AND** the relative ordering within a kind (e.g., the two permissions) is stable per that kind's documented semantics

### Requirement: Each kind owns its schema evolution

Every kind SHALL implement its own `migrate(db)` hook containing idempotent schema DDL. Migrations MUST check for prior application (via `CREATE TABLE IF NOT EXISTS`, conditional schema-version checks, or equivalent) so that running the migration twice is a no-op.

**Core invariant:** Each kind owns its schema evolution via migrate(db); migrations must be idempotent.

The orchestrator tracks schema versions via the existing `meta` table but does not itself contain any kind-specific DDL. If two kinds share a table (they should not), the one that owns the schema is documented in its module header and the other imports the owning kind's reader functions.

#### Scenario: Running migrate twice is idempotent

- **GIVEN** `handoffKind.migrate(db)` has already applied the `handoffs` table on a previous hub start
- **WHEN** the hub restarts and `handoffKind.migrate(db)` runs again
- **THEN** the migration observes its own prior application (e.g., via schema_version check or `CREATE TABLE IF NOT EXISTS`)
- **AND** no duplicate tables, indexes, or constraint violations arise
- **AND** no existing rows are modified

### Requirement: UI per-kind modules own their slice end-to-end

Every persistent state-machine kind with UI surface SHALL ship as a module at `ui/kinds/<kind>.js` exporting `{ dispatch(event), bootstrap(cap) }`. Co-located CSS lives at `ui/kinds/<kind>.css`. `ui/main.js` SHALL delegate to the per-kind module when it sees an SSE event whose `kind` field starts with that module's prefix.

Layout, composer, header, and other non-kind UI concerns remain in `ui/main.js` and `ui/style.css`.

`ui/index.html` SHALL load per-kind modules via `<script type="module">`. No inline event handlers (`onclick=`, etc.) are permitted; all interaction uses `addEventListener`.

#### Scenario: SSE event routes to the matching UI module

- **GIVEN** the UI registry exposes `handoffUI`, `interruptUI`, `permissionUI`
- **WHEN** an SSE event arrives with `kind: "permission.new"`
- **THEN** `permissionUI.dispatch(event)` is invoked
- **AND** `handoffUI.dispatch` is not invoked

#### Scenario: Adding a UI kind requires no edits to main.js

- **WHEN** a developer adds `ui/kinds/foo.js` exporting the UI module contract, adds a `<script type="module">` entry in `index.html`, and registers it in the UI kind registry
- **THEN** `ui/main.js` requires zero edits
- **AND** `ui/style.css` requires zero edits (kind-specific CSS lives in `ui/kinds/foo.css`)

### Requirement: Contract conformance is enforced by test

A `tests/contract/has-required-hooks.test.ts` file SHALL iterate every module in `KINDS` and assert the presence and callable shape of `kind`, `migrate`, `routes`, `pendingFor`, `toolNames`. A second test SHALL assert no two kinds declare the same `kind` string or the same `(method, path)` tuple.

These tests fail the build; a kind that satisfies the TypeScript type but leaves a hook as an empty stub is caught at test time.

#### Scenario: Half-implemented kind fails the conformance test

- **GIVEN** a `KindModule` named `foo` declares `kind: "foo"` but leaves `migrate` as `() => { throw new Error("not implemented") }` or omits `routes`
- **WHEN** `bun test tests/contract` runs
- **THEN** the conformance test fails with a message identifying `foo` and the missing or stubbed hook

#### Scenario: Duplicate kind name fails the uniqueness test

- **GIVEN** two kinds both declare `kind: "handoff"`
- **WHEN** the uniqueness test runs
- **THEN** the test fails with a message listing the conflicting modules

### Requirement: Nutshell is not a kind

The nutshell single-row document SHALL NOT implement the `KindModule` contract. It remains an ad-hoc module at `hub/nutshell.ts` exposing `readNutshell`, `writeNutshellInTx`, and `broadcastNutshell`. Its write path continues to piggyback on the handoff primitive via the `[nutshell]` task prefix — no separate edit route.

Forcing nutshell into `KindModule` would require most hooks to be empty or faked, visibly wrong against the narrow "persistent state-machine entity" purpose of the contract. A sibling `Document` interface is deferred until a second document-like entity exists.

#### Scenario: Nutshell does not appear in the kind registry

- **GIVEN** v0.9.5 has shipped
- **WHEN** reading `hub/kinds/index.ts`
- **THEN** `nutshell` is not listed in `KINDS`
- **AND** the contract conformance test does not include it
- **AND** `hub/nutshell.ts` exists as a standalone module
