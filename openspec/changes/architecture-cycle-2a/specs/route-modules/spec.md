## ADDED Requirements

### Requirement: Hub routes are owned by `HubFeature` modules registered with the dispatcher

Every HTTP route the hub exposes (except SSE long-lived connections; see below) SHALL be defined inside a `HubFeature` module under `hub/features/`. The feature module exports `routes: RouteDef[]` with method, path matcher, auth class, optional body cap, and handler. The hub orchestrator (`hub/hub.ts`) iterates a static `FEATURES` array and registers each module's routes through the dispatcher. Adding a route requires editing one feature file; it MUST NOT require editing `hub.ts`.

#### Scenario: Adding a new route is a single-file change

- **GIVEN** a developer wants to add `GET /usage/breakdown`
- **WHEN** they create or edit `hub/features/usage.ts` to add a new `RouteDef` entry
- **THEN** the route works after a hub restart
- **AND** `hub/hub.ts` is not modified

#### Scenario: Dispatcher receives both kind and feature routes

- **WHEN** the hub starts
- **THEN** the dispatcher's compiled-route table contains entries from both `KINDS` (the existing kind-runtime contract) and `FEATURES` (the new route-modules contract)
- **AND** the dispatcher applies auth + body-cap + ledger guards uniformly across both

### Requirement: `HubFeature` is the parent contract; `KindModule` extends it

`HubFeature` SHALL be defined as `{ routes: RouteDef[] }`. `KindModule` extends `HubFeature` by adding kind-specific fields. The full canonical field list of `KindModule` is:

- `routes: RouteDef[]` — inherited from `HubFeature`. Static array of HTTP route declarations. Each `RouteDef` includes method, path matcher, auth class (`"mutating"` or `"read"`), optional body size cap, and a `handler(req, cap, params)` function invoked per request.
- `kind: string` — unique kebab-case identifier used as the prefix for the kind's SSE event kinds (e.g., `"handoff"` → `handoff.new`, `handoff.update`).
- `entity: LedgerEntity<Snapshot>` — per-Kind entity (defined in the `ledger-store` capability) owning the derived-table schema, the atomic event-write+derived-row-update transaction, and the load → decide → transact → emit lifecycle. The entity's `migrate(db)` replaces the per-Kind `migrate` previously on `KindModule` directly. Internal `Store` collaborator is hidden in the entity's closure.
- `stateMachine: StateMachineDecl` — declarative description of statuses, terminal statuses, derived-table column spec, and verb→transition mappings; consumed by `LedgerEntity` (specifically by the `decide` callbacks each verb supplies). Idempotency policy is NOT a field on the state machine — it lives inside each verb's `decide` callback as the appropriate `Decision` discriminated-union arm.
- `pendingFor?(agent, cap): Entry[]` — optional override; default implementation reads from `entity.listByStatus({ status: "pending", for: agent.name })` and projects via the kind's snapshot-to-entry function with `replay: true`.
- `toolNames: string[]` — names of MCP tools chatbridge exposes for this kind; the hub aggregates these into the briefing.
- `priority?: number` — optional replay-ordering hint. Defaults to `0`. Higher priority kinds replay first. Kinds MUST NOT depend on cross-kind ordering for correctness; this field exists only as an escape hatch for future kinds whose state must become visible before others can query it.

The dispatcher consumes `HubFeature[]`; the briefing aggregator consumes the `KindModule` subset (those features declaring `toolNames`).

The `kind-runtime` capability spec cross-references this canonical list rather than duplicating it.

#### Scenario: Dispatcher iteration is type-uniform

- **GIVEN** a mixed array `[chatFeature, transcriptFeature, handoffKind, interruptKind]` typed as `HubFeature[]`
- **WHEN** the dispatcher compiles routes from this array
- **THEN** all four contribute their routes to the dispatch table
- **AND** the dispatcher does not differentiate kinds from non-kind features at the routing level

#### Scenario: Briefing aggregator filters for KindModule

- **WHEN** the briefing builder assembles the tool list for an agent
- **THEN** it filters `FEATURES` to those satisfying the `KindModule` shape (those with `toolNames`)
- **AND** non-kind features (chat, transcript, etc.) are excluded from the tool aggregation

### Requirement: SSE handlers are RouteModules but live outside the dispatcher

`handleStream` (Webview SSE on `/stream`) and `handleAgentStream` (per-Agent SSE on `/agent-stream`) SHALL be registered through their own `HubFeature` modules under `hub/features/streams.ts` (or sibling files), but they wire directly into `Bun.serve`'s URL match rather than through the dispatcher. Their lifecycle is long-lived (per-connection state, briefing trigger, hydration trigger, kind replay) and does not fit the dispatcher's request-response contract.

#### Scenario: SSE routes register without dispatcher

- **WHEN** the hub starts
- **THEN** `hub/features/streams.ts` registers `/stream` and `/agent-stream` directly with `Bun.serve`
- **AND** the dispatcher's compiled-route table does NOT contain entries for these paths
- **AND** the auth check, briefing build, hydration trigger, and kind replay all run inside the SSE handler closure as today

### Requirement: `hub/hub.ts` is wiring-only

After this change, `hub/hub.ts` SHALL contain only: imports, env-var resolution, ledger open + module construction, `FEATURES` array assembly, `Bun.serve` startup, sweep timer, shutdown handlers, and the human-permanent-member registration. Inline route handlers, broadcast logic, briefing dispatch logic, and SSE handler closures are NOT permitted in `hub.ts`. Target size: ≤300 LOC of pure wiring (the irreducible floor is ~225-275 LOC; the 300 budget allows comfort vs an aggressive squeeze).

#### Scenario: hub.ts contains no inline handlers

- **GIVEN** the post-cycle codebase
- **WHEN** the file `hub/hub.ts` is examined
- **THEN** there are no `function handle<X>(...)` declarations for HTTP route bodies
- **AND** there are no `function broadcast<X>(...)` declarations
- **AND** the file's line count (excluding comments/blanks) is ≤300

Note: a grep-based pre-merge lint check (`grep -E "function (handle|broadcast)" hub/hub.ts`) belongs in the cycle's task list, not as a spec scenario; it is a measurement of this requirement, not an independent requirement.
