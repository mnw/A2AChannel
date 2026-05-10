## MODIFIED Requirements

### Requirement: Persistent state-machine kinds implement the `KindModule` contract

Every persistent state-machine primitive added to the hub (including the existing `handoff`, `interrupt`, and `permission` primitives) SHALL be implemented as a module conforming to the `KindModule` contract.

The full `KindModule` field list (including `routes` inherited from `HubFeature`, plus the kind-specific `kind`, `store`, `stateMachine`, `pendingFor?`, `toolNames`, `priority?`) is defined canonically in the `route-modules` capability spec. This spec does NOT re-list the fields; consult `route-modules/spec.md` for the authoritative field set.

The hub orchestrator (`hub/hub.ts`) SHALL contain no kind-specific code. It iterates a static `KINDS` array (a subset of `FEATURES`), calls each kind's `entity.migrate(db)` at startup (where `entity` is the kind's `LedgerEntity` instance — its internal Store handles the DDL), registers their routes through the dispatcher (which consumes the parent `HubFeature` contract), and invokes `pendingFor` on `/agent-stream` reconnect via the briefing path.

**Core invariant:** Kinds formalize persistent state-machine entities backed by the event ledger. Ephemeral broadcasts (presence, typing indicators), single-row documents (nutshell), and config/rules do not use this contract.

#### Scenario: Registered kind is migrated on startup

- **GIVEN** a new `KindModule` named `foo` is exported and listed in `hub/kinds/index.ts`
- **WHEN** the hub starts and `openLedger()` runs
- **THEN** `foo.entity.migrate(db)` is invoked exactly once (delegating to the entity's internal Store)
- **AND** subsequent hub restarts invoke `foo.entity.migrate(db)` again and the migration observes its own idempotency (no-op on second run)

#### Scenario: Registered kind's routes are wired through the dispatcher

- **GIVEN** `foo.routes` declares `[{ method: "POST", path: "/foos", auth: "mutating", bodyMax: 16384, handler }]`
- **WHEN** the hub dispatches an incoming request for `POST /foos`
- **THEN** the dispatcher applies `requireAuth` (because `auth: "mutating"`) and `requireJsonBody(req, 16384)` before invoking `handler(req, cap, {})`
- **AND** the handler receives a live `HubCapabilities` object whose `cap.sse.emit` delegates to the new `Fanout` module

#### Scenario: Adding a kind requires no edits to hub.ts

- **WHEN** a developer introduces a new kind `foo` by creating `hub/kinds/foo.ts` and adding one import + one array entry to `hub/kinds/index.ts`
- **THEN** the hub orchestrator in `hub/hub.ts` requires zero edits
- **AND** the kind's migration, routes, briefing tools, and replay all activate on the next hub start

### Requirement: Each kind owns its schema evolution

Every kind SHALL declare its schema as part of its `StateMachineDecl` (table name + column spec) consumed by `LedgerEntity`'s internal Store. The Store's `migrate(db)` hook SHALL contain idempotent DDL. Kind handler files (e.g. `hub/kinds/handoff.ts`) MUST NOT contain `CREATE TABLE`, `ALTER TABLE`, or `CREATE INDEX` statements directly; all schema knowledge resides in the `StateMachineDecl` passed to `createLedgerEntity`. Migrations MUST check for prior application (via `CREATE TABLE IF NOT EXISTS`, conditional schema-version checks, or equivalent) so that running the migration twice is a no-op.

**Core invariant:** Each kind owns its schema evolution via its `LedgerEntity`'s `migrate(db)` (which delegates to the internal `createSqliteStore`); migrations must be idempotent.

The orchestrator tracks schema versions via the existing `meta` table but does not itself contain any kind-specific DDL. If two kinds share a table (they should not), the one that owns the schema is documented in its module header and the other imports the owning kind's reader functions.

#### Scenario: Running migrate twice is idempotent

- **GIVEN** `handoffKind.entity.migrate(db)` has already applied the `handoffs` table on a previous hub start
- **WHEN** the hub restarts and `handoffKind.entity.migrate(db)` runs again
- **THEN** the migration observes its own prior application (e.g., via schema_version check or `CREATE TABLE IF NOT EXISTS`)
- **AND** no duplicate tables, indexes, or constraint violations arise
- **AND** no existing rows are modified

#### Scenario: Kind handler files contain no DDL

- **WHEN** the codebase is grepped for `CREATE TABLE` or `ALTER TABLE` inside `hub/kinds/*.ts`
- **THEN** zero matches are found
- **AND** all such DDL exists only inside `hub/core/store.ts` (the internal SQLite Store) or `hub/core/ledger.ts` (cross-kind migrations)

> The Webview-side requirement covering UI per-kind modules + `KindCard` factory + per-Kind CSS consolidation is scoped to `architecture-cycle-2b`'s `kind-rendering` capability. 2a's `kind-runtime` modifications are Hub-only.

## ADDED Requirements

### Requirement: `KindModule` extends `HubFeature`

`KindModule` SHALL be defined as a TypeScript subtype of `HubFeature` (the parent contract introduced in the new `route-modules` capability). `HubFeature` provides the `routes: RouteDef[]` baseline; `KindModule` adds kind-specific fields (`kind`, `store`, `stateMachine`, `pendingFor`, `toolNames`, `priority`). The dispatcher consumes `HubFeature[]` for route registration; the briefing aggregator filters for the `KindModule` shape (those with `toolNames`) for tool list aggregation.

#### Scenario: Mixed feature/kind array dispatches uniformly

- **GIVEN** the hub assembles `FEATURES = [chatFeature, transcriptFeature, handoffKind, interruptKind, permissionKind]` typed as `HubFeature[]`
- **WHEN** the dispatcher compiles routes from this array
- **THEN** all five contribute their routes to the dispatch table
- **AND** `requireAuth` / `requireJsonBody` / ledger-guard apply uniformly across kind and non-kind routes

#### Scenario: Briefing tool aggregation filters for KindModule

- **WHEN** the briefing builder assembles the tool list for an agent's briefing
- **THEN** it filters `FEATURES` for those satisfying the `KindModule` shape (those declaring `toolNames`)
- **AND** non-kind features (chat, transcript, sessions, usage, etc.) are excluded from the tool list
