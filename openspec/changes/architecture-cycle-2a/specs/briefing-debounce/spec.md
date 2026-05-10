## ADDED Requirements

### Requirement: `BriefingDispatcher` owns the re-brief debounce + per-Agent dedup

The hub SHALL expose a `BriefingDispatcher` module under `hub/core/briefing-dispatcher.ts` that owns the debounced re-issue of Briefings to currently-connected agents. The module owns its own state: the per-Agent `lastBriefingSig` Map, the debounce timer, and the seed-on-initial-send Map. `hub.ts` does NOT contain module-scope state for any of these concerns. The dispatcher exposes `scheduleFanout()`, `seedSignature(agent, brief)`, and `dispose()`.

#### Scenario: Roster change schedules a debounced re-brief

- **WHEN** an agent joins or leaves the roster
- **THEN** `AgentRegistry.onRosterChange` calls `briefingDispatcher.scheduleFanout()`
- **AND** the dispatcher resets its internal 500ms timer (debounce-reset-on-call)
- **AND** the timer fires once after the last `scheduleFanout` call
- **AND** when the timer fires, the dispatcher iterates connected non-permanent agents and emits a re-brief to each

#### Scenario: Reconnect storm collapses to single fanout

- **GIVEN** five agents reconnect in quick succession (within 500ms)
- **WHEN** each reconnect triggers `onRosterChange` via `agents.connect`
- **THEN** `scheduleFanout` is called five times
- **AND** the debounce timer resets four times
- **AND** the timer fires exactly once
- **AND** the resulting fanout iterates the five agents and dedups by signature so no agent receives a re-brief identical to its last one

### Requirement: Per-Agent signature dedup suppresses redundant re-briefs

The dispatcher SHALL maintain a `lastBriefingSig: Map<agent, string>` of the most recent briefing signature delivered to each agent. When the debounced fanout runs, agents whose computed signature equals their last delivered signature are skipped. The signature includes peers' online state, peer rooms, and the same-room nutshell text.

#### Scenario: Agent with unchanged peers + nutshell is skipped

- **GIVEN** agent `Drupal` last received a briefing with signature `S1` for room `EU Space`
- **WHEN** an unrelated event triggers `scheduleFanout` and `Drupal`'s computed signature is again `S1`
- **THEN** no re-brief is sent to `Drupal`'s queue
- **AND** the dispatcher's stored signature for `Drupal` remains `S1`

#### Scenario: Initial briefing seeds the signature

- **WHEN** an agent first connects and `handleAgentStream` sends the initial briefing
- **THEN** the handler calls `briefingDispatcher.seedSignature(agent, brief)` after the send
- **AND** the next debounced fanout for the same agent compares against this seeded signature
- **AND** does NOT send a duplicate immediately after first connect

### Requirement: Force-all override exists for explicit re-issue

The dispatcher SHALL accept a `forceAll: true` option on a fanout invocation that bypasses signature dedup and re-sends to every connected non-permanent agent. This is reserved for cases where the briefing's externally-visible content has changed without a roster/presence/nutshell event (e.g. a Hub-wide config reload).

#### Scenario: Force-all bypasses dedup

- **GIVEN** every connected agent's last signature equals their current signature
- **WHEN** the dispatcher's fanout runs with `forceAll: true`
- **THEN** every connected non-permanent agent receives a re-brief
- **AND** every agent's stored signature is updated to the new signature

### Requirement: Dispatcher is testable with a fake clock + fake registry

The `BriefingDispatcher` interface SHALL accept its dependencies (clock for `setTimeout`/`clearTimeout`, AgentRegistry, BriefingBuilder) via constructor injection so unit tests can drive it with a fake clock and fake registry. Tests assert reconnect-storm collapsing, signature dedup, and force-all without spinning up the hub.

#### Scenario: Test verifies storm collapsing without hub

- **GIVEN** a unit test constructs `BriefingDispatcher` with a fake clock + fake registry
- **WHEN** the test calls `scheduleFanout` 5 times within the debounce window
- **AND** the test advances the fake clock past the debounce window
- **THEN** the fake registry observes exactly one round of fanout invocations
