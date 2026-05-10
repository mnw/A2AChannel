## ADDED Requirements

### Requirement: All SSE broadcast goes through `Fanout.send(entry, scope, opts?)`

The hub SHALL expose a single `Fanout` module owning every path that emits an entry to UI subscribers and/or per-Agent SSE queues. Callers — kinds (via `cap.sse.emit`), chat handlers, nutshell write-through, briefing dispatch — invoke `Fanout.send(entry, scope)` and never enumerate `uiSubscribers` or `agents.values()` directly. Direct mutations of `uiSubscribers`, `agentQueues`, and `chatLog` are confined to `Fanout` and `AgentRegistry`.

#### Scenario: Kind emit goes through Fanout

- **GIVEN** a handoff transition completes via `KindStore.apply`
- **WHEN** `KindBase` calls `cap.sse.emit(entry, { kind: "to-agents", agents: [from, to] })`
- **THEN** the emit delegates to `Fanout.send(entry, scope)`
- **AND** `Fanout.send` enqueues the entry to the named agents and persists it to chatLog and (if opted-in) the room's transcript JSONL

#### Scenario: No call site enumerates agentQueues directly

- **WHEN** the codebase is grepped for `agentQueues.get` or `agents.values()` followed by `.push(`
- **THEN** the only matches are inside `hub/core/fanout.ts` and `hub/core/agents.ts`
- **AND** no kind, chat handler, briefing handler, or feature module enumerates queues

### Requirement: `Scope` enum widens to cover ambient broadcasts

The existing `Scope` enum SHALL gain two variants: `{ kind: "ui-only-ambient" }` (deliver to `uiSubscribers` only, no `chatLog` push, no transcript write) and `{ kind: "room-ambient", room }` (deliver to same-room agent queues + UI subscribers, no `chatLog` push, no transcript write). The pre-existing four (`broadcast`, `to-agents`, `ui-only`, `room`) preserve their current delivery and persistence semantics.

#### Scenario: Nutshell update uses room-ambient scope

- **WHEN** a nutshell update broadcasts via `Fanout.send(nutshellEntry, { kind: "room-ambient", room })`
- **THEN** all same-room non-permanent agents receive the entry on their queues
- **AND** the human's `/stream` subscribers receive the entry
- **AND** no entry is appended to `chatLog`
- **AND** no entry is written to the room's transcript JSONL

#### Scenario: Roster snapshot uses ui-only-ambient scope

- **WHEN** a roster change broadcasts via `Fanout.send(rosterSnap, { kind: "ui-only-ambient" })`
- **THEN** all `/stream` subscribers receive the entry
- **AND** no agent queues receive the entry
- **AND** no entry is appended to `chatLog`
- **AND** no transcript file is touched

### Requirement: `<private>` redaction happens on the persistence path, not the delivery path

CLAUDE.md hard rule: `<private>...</private>` blocks are stripped at persistence time, not at delivery. After this cycle moves transcript write-through into `Fanout`, the redaction call (`redactPrivate(entry)`) MUST happen inside Fanout's persist branch — before the entry is appended to the room's JSONL transcript. The entry delivered to live agents and `/stream` UI subscribers MUST contain the unredacted text (current behaviour preserved). The in-memory `chatLog` ring buffer MUST contain the unredacted text (so that mid-session SSE re-delivery sees what the live session saw).

#### Scenario: Live agents and UI see private content; transcript file does not

- **GIVEN** room `EU Space` has `room_settings.persist_transcript = true`
- **WHEN** an agent posts a chat message containing `<private>secret</private>`
- **AND** `Fanout.send(entry, { kind: "room", room: "EU Space" })` is invoked
- **THEN** the entry pushed to `chatLog` contains the literal text `<private>secret</private>`
- **AND** the entry pushed to same-room agent queues contains the literal text `<private>secret</private>`
- **AND** the entry pushed to `/stream` UI subscribers contains the literal text `<private>secret</private>`
- **AND** the line appended to the JSONL transcript contains an empty `text` field (the `<private>...</private>` block stripped)

### Requirement: `emitWhere` predicate-based fan-out is removed; replaced by `room-ambient` scope

The pre-existing `emitWhere(entry, predicate)` escape hatch on `cap.sse.emit` SHALL be removed in this cycle. Its only caller today is the handoff-accept path's nutshell broadcast, which the new `{ kind: "room-ambient", room }` scope subsumes cleanly. After the cycle, no predicate-based fan-out path exists; all callers use named scopes from the (extended) `Scope` enum.

#### Scenario: `emitWhere` is no longer in `HubCapabilities`

- **WHEN** the `HubCapabilities.sse` interface is examined
- **THEN** `sse.emitWhere` is not a member
- **AND** `sse.emit(entry, scope)` is the only fan-out method
- **AND** kind code that previously called `cap.sse.emitWhere` now calls `cap.sse.emit(entry, { kind: "room-ambient", room })` or another named scope

### Requirement: chatLog persistence + transcript write-through live in `Fanout`

Whether an entry lands in the in-memory `chatLog` ring buffer and whether it gets persisted to the room's JSONL transcript is a property of the scope, not a per-call-site convention. `Fanout` SHALL apply the policy: scopes `broadcast`, `to-agents`, `room` push to chatLog AND persist to transcript (if opt-in); `ui-only` pushes to chatLog only; ambient scopes push to neither. Permanent agents (the human) are skipped from queue fan-out uniformly.

#### Scenario: Non-ambient broadcast persists to opted-in transcript

- **GIVEN** room `EU Space` has `room_settings.persist_transcript = true`
- **WHEN** `Fanout.send(chatEntry, { kind: "room", room: "EU Space" })` is invoked
- **THEN** the entry appends to the active JSONL transcript file
- **AND** the entry pushes to chatLog
- **AND** all same-room non-permanent agent queues receive the entry

#### Scenario: Permanent member skipped from queue fan-out

- **GIVEN** the human is registered as a permanent agent
- **WHEN** `Fanout.send(entry, { kind: "broadcast" })` is invoked
- **THEN** the human's agent queue (if any) is skipped
- **AND** the human still receives the entry via the UI `/stream` path
