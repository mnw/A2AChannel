## Context

v0.8 (permission-relay) ships a fourth coordination primitive on top of the v0.7 foundation. The hub still assumes a single flat room: `agents` is a `Map<name, Agent>`, `nutshell` is single-row, every SSE event broadcasts to every subscriber, and the ledger has no notion of scope. This worked while the product assumption was "one A2A window = one project". In practice the human runs 2-4 projects concurrently and the flat room becomes noisy enough that agents waste context tokens filtering out chatter not meant for them, and the shared nutshell becomes a lowest-common-denominator description that helps no project.

The upstream channels-reference ["Gate inbound messages"](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages) pattern is the canonical way channel-bin servers defend against prompt injection — validate the sender identity before forwarding to claude's context. We reuse the same shape for room isolation: channel-bin's second-line defense is to drop any inbound event whose `room` attribute doesn't match its configured `CHATBRIDGE_ROOM`.

Constraints:
- Single instance assumption remains: discovery files, tmux socket, ledger, attachments dir are all at fixed paths. Rooms live inside one hub, not one hub per room.
- The human is always a first-class roster member (v0.7 invariant). With rooms, the human is a super-user who is implicitly in every room.
- Ledger migrations are additive, no backfill (established pattern). Existing rows get `room='default'`.
- No LLM-visible breaking changes to the `post`/`send_handoff`/`send_interrupt` tool schemas — rooms are derived from the sender's identity, not passed as a tool argument.

## Goals / Non-Goals

**Goals:**
- One A2AChannel window hosts multiple isolated projects without cross-project context pollution.
- Agents in different rooms do not see each other's broadcast chatter.
- Explicit cross-room addressing remains possible (peer-to-peer by name).
- Per-room nutshell so new agents in project A are onboarded with project A's summary, not a global blob.
- Human can filter the UI to a single room at a time, or see all rooms concurrently ("All" view).
- Pause / resume a whole room with one click, reusing the interrupt primitive.
- Defense-in-depth: channel-bin re-validates the room on every inbound event so a hub routing bug cannot leak context.

**Non-Goals:**
- Multiple A2AChannel instances running simultaneously. Still a single-instance product.
- Per-room authentication. All rooms share the one bearer token; any agent with the token can address any other room (via explicit `to: "<name>"`).
- Per-room `attachments_dir` or `human_name`. Inherited from global config.
- Room renaming or mid-session reassignment. Rooms are fixed at spawn.
- Cross-room read-only observer roles. An agent is in exactly one room (plus the human who is in all).
- Inferring rooms from cwd at render time. We tried this, rejected because subdirectory agents get falsely separated; rooms are an explicit spawn-time label with a sensible default.

## Decisions

### D1. Room is a string label attached at spawn time, fixed for the agent's lifetime.

**Decision**: `room` is a non-empty string, 1..=64 chars, same validation rules as agent names (`[A-Za-z0-9_.-]` + space, non-space boundaries). Captured once at channel-bin startup via `CHATBRIDGE_ROOM` env. Stored on the hub's agent record at first `/agent-stream` connect. Immutable for the session.

**Alternatives considered**:
- *Room is derived from cwd at render time.* Rejected — agents in `/project/backend` and `/project/frontend` are logically same-project, different cwds. Auto-derivation would incorrectly separate them. Also fragile: any cwd rename renames the room.
- *Room is a list; agents can be in multiple rooms.* Rejected for v0.9 — complicates every broadcast decision and doubles UI complexity. The common case is one agent = one project. If we learn otherwise, v1.0 can widen this.
- *Room is set by the first message, not at spawn.* Rejected — first-message latency means the first few SSE events wouldn't be routed correctly. Spawn-time is deterministic.

**Why this over alternatives**: explicit + immutable = no ambiguity in the broadcast rule. One label per agent maps cleanly to every broadcast path. The spawn modal's default (git-root basename) covers the typical case without requiring the user to think about it.

### D2. Broadcast scope is the sender's room; the human is a super-user.

**Decision**: For every event, the hub computes recipients as:

```
broadcast scope(event) =
    event.sender.room == event.target_room                 // same-room agents
  ∪ {human}                                                 // human always
  ∪ (event.target ∈ roster ? {event.target} : ∅)           // explicit peer target crosses rooms
```

The human is in every room. The human's UI does client-side filtering when a specific room is selected in the switcher.

**Alternatives considered**:
- *Agent must opt-in to cross-room visibility.* Rejected — too heavy for the common case where explicit addressing should "just work".
- *Cross-room explicit addressing is disallowed; send a "room transfer" primitive instead.* Rejected — adds a new primitive for a rare case. Named targets already crossing rooms covers it.
- *No super-user; the human is just another room member.* Rejected — breaks the operator's ability to manage multi-project state. The human is the coordinator by definition.

**Why this over alternatives**: same-room-by-default + explicit-cross-room-by-name matches the human mental model ("I talk to my team; I can explicitly pull in someone from another team"). The super-user role for the human keeps the operator's god view intact without a separate feature.

### D3. Channel-bin re-validates room on every inbound event.

**Decision**: channel-bin, after decoding an SSE event from `/agent-stream`, checks the event's `room` attribute against its own `CHATBRIDGE_ROOM`. Mismatch → event is dropped before `notifications/claude/channel` forwards it to claude. Mirrors the upstream "Gate inbound messages" pattern — identity-level filtering at the boundary.

**Alternatives considered**:
- *Trust the hub's routing; don't re-validate.* Rejected — defense-in-depth is cheap (one string compare per event) and catches routing bugs before they pollute agent context. Costs nothing, saves face.
- *Validate in claude itself (via `instructions` telling claude to ignore wrong-room events).* Rejected — this is the kind of security-by-prompt that the channels-reference explicitly warns against.

**Why this over alternatives**: two filters in series. Hub's room-aware routing is the primary; channel-bin's gate is the fallback. If either has a bug, the other still holds.

### D4. Nutshell becomes one-row-per-room.

**Decision**: Schema change: `nutshell` table drops the `CHECK(id = 0)` single-row invariant. Primary key becomes `room TEXT PRIMARY KEY`. All read/write paths key by room. Existing global nutshell migrates to `room='default'`. The human's "All" view shows each room's nutshell stacked; a single-room view shows only that room's.

**Alternatives considered**:
- *Keep the single global nutshell, let agents reason about "the bit for my project".* Rejected — defeats the point of the primitive, which is machine-actionable onboarding summary.
- *One nutshell per agent, not per room.* Rejected — nutshell is a *shared* summary by design; splitting to per-agent turns it into private notes.

**Why this over alternatives**: per-room matches the mental model of "project summary." A new agent joining project A gets project A's summary, full stop.

### D5. Pause / resume reuses the interrupt primitive; no new protocol.

**Decision**: The Pause button sends one `POST /interrupts` per agent in the currently-selected room with fixed text: `"Pause — stop current task, hold state, await resume."`. The Resume button does the same with `"Resume — continue previous task."`. Bulk-targeting is an optional optimisation — hub accepts `{ rooms: ["<label>"], text: "..." }` as a shorthand that fans out server-side. Interrupts are cooperative (claude finishes the current tool call before reading the card) — that's fine, "please pause" doesn't need to be preemptive.

**Alternatives considered**:
- *New `pause_agent` / `resume_agent` MCP tools and a dedicated primitive.* Rejected — interrupts already do exactly this ("stop and re-read"). Adding a parallel primitive is duplication.
- *Inject `/compact` or similar slash command via PTY write.* Rejected — slash commands are interpreted by claude's TUI, not a stable protocol. Breaks on claude upgrade.
- *Preemptive cancellation (send SIGINT to claude).* Rejected — lossy, loses in-flight tool calls, violates the "cooperative" invariant that the interrupt primitive is designed around.

**Why this over alternatives**: reuse > new. The interrupt primitive is already designed for "stop and re-read"; pause/resume is a UI surface on top of it, not a new protocol.

### D6. Bulk-interrupt shape: `rooms: []` on POST /interrupts.

**Decision**: `POST /interrupts` accepts either `to: "<name>"` (single recipient, existing shape) or `rooms: ["<label>", ...]` (fan out to every non-human agent in the listed rooms). Server generates one interrupt per target internally so the ledger and each agent's replay queue stay uniform. The UI uses the `rooms` shape for the Pause/Resume buttons; clients that want per-agent targeting use the existing `to` shape.

**Why**: keeps the wire protocol minimal — no bulk endpoint, just a shape variant on the existing one. Each generated interrupt still has its own ID, ack state, and ledger row, so the observability surface stays identical.

### D7. Spawn modal default: git-root basename, fallback cwd basename.

**Decision**: Rust walks up from the selected cwd looking for `.git`. If found, room default = basename of that directory. If not, room default = basename of cwd. User can override. A datalist on the Room input suggests rooms already present in the current roster to reduce typos.

**Alternatives considered**:
- *Default to cwd basename always.* Rejected — subdir agents get wrong room label by default.
- *Always prompt, no default.* Rejected — UX friction for the common case.
- *Use `git config --get remote.origin.url` last path segment.* Rejected — depends on remote config, doesn't work offline or for unpushed repos. Git-root basename works everywhere a `.git` directory exists.

### D8. The human is identified as "room member of every room" implicitly, not by listing them in every room.

**Decision**: The hub's `Agent` record still has one `room` field. The human's record has `room = null` (or a sentinel like `"*"`) and every broadcast path treats `null`/`"*"` as "in every room". No enumeration of rooms the human belongs to.

**Alternatives considered**:
- *Human has an explicit list of rooms.* Rejected — the human is by definition in every room; enumerating them is both redundant and prone to drift when new rooms are created.
- *Special-case the human's name in every broadcast.* Rejected — same effect but uses the name as implicit policy. Fragile if `human_name` is changed via config.

### D9. External-spawn fallback: `A2A_DEFAULT_ROOM` env on the hub.

**Decision**: Agents launched by users from their own terminal (not via the + agent button) don't know their room — the spawning user types `claude --mcp-config ... server:chatbridge` from some shell. Their channel-bin has no `CHATBRIDGE_ROOM`. In that case, channel-bin falls back to reading the hub's `A2A_DEFAULT_ROOM` via `GET /room-default` at startup. Hub's default is `"default"`. Users who want external-spawn sessions to land in a specific room edit config.json (`"default_room": "mobile"`).

**Alternatives considered**:
- *Refuse to register external-spawn agents without an explicit room.* Rejected — breaks the classic "my-terminal claude" workflow. The v0.7 "roster is dynamic" invariant says any connect auto-registers.
- *Infer room from cwd at connect time.* Rejected for the same D1 reason.

## Risks / Trade-offs

- **[Cross-room handoff friction]** → Handoffs from room A to an agent in room B would fail the room membership check (D2). Mitigation: the hub's handoff validation explicitly allows cross-room when the recipient is named (not "all"). Same rule as for chat. Documented in the modified `interrupt-messages` and `structured-handoff` spec deltas.
- **[Missing nutshell on first connect for a freshly-created room]** → An agent that creates a new room (first agent in that room) has no nutshell yet; briefing is empty for that field. Mitigation: spec explicitly allows `nutshell: null` in briefings; UI shows "No project summary yet — agents or the human can propose one." per room.
- **[UI state confusion: which room am I in]** → Human switches rooms, forgets, sends a message meant for room A while looking at room B. Mitigation: composer placeholder shows the current room name. Messages the human sends always inherit the room selected in the switcher; "All" view disables the composer (human must pick a room to speak into).
- **[Legacy ledger rows with `room='default'`]** → A user upgrading from v0.8 sees all their old agents and history under "default" — they'll have to manually recategorise if they want finer rooms. Not a mitigation: this is an acceptable migration tax, rare enough (single-user tool) not to warrant an interactive migration.
- **[channel-bin gate masks hub bugs]** → The D3 defense-in-depth gate could hide an actual routing regression in the hub. Mitigation: channel-bin logs every dropped event with the mismatched room pair, so a hub bug would show up as a surge of drop-log entries even if user-visible behavior stays correct.
- **[Pause interrupt doesn't actually stop in-flight tool calls]** → User expects Pause to halt claude immediately; in reality claude finishes its current tool call first. Mitigation: tooltip on the Pause button reads "agents finish their current tool call before pausing". This matches the existing interrupt primitive's documented cooperative semantics.

## Migration Plan

**Code rollout** (single-instance, single-user; no staged rollout needed):
1. Ledger migration (schema_version 3 → 4) runs on first hub start of v0.9. Additive `ALTER TABLE` statements; existing rows get `room='default'` via the column default. Nutshell migration: insert `room='default'` row with old `id=0` row's content, then drop `id=0` invariant.
2. Hub begins accepting and writing `room` on every event. Agents connecting without `CHATBRIDGE_ROOM` register as `room='default'`.
3. channel-bin published in the same release starts setting `CHATBRIDGE_ROOM`. App-spawned agents go to the right room; external-spawn agents go to `default`.
4. UI shows the room switcher on boot. Default selection is the room of the first agent in the roster, or "All" if mixed.

**Rollback**:
- Downgrade to v0.8 is blocked by the existing ledger downgrade-protection check (v0.9 ledger has schema_version=4, v0.8 refuses to open it). To force a downgrade, the user `rm ~/Library/Application\ Support/A2AChannel/ledger.db` before starting v0.8 — they lose handoff / interrupt / nutshell history. Documented as a caveat.
- The `room` column being additive means a v0.8 codebase reading a v0.9 ledger would work *if* the downgrade check were bypassed. We don't bypass it; the protection is intentional.

**Release checklist**:
- `scripts/release.sh` gains a migration smoke test: install v0.8, create a handful of handoffs/interrupts/nutshell edits, upgrade to v0.9, verify ledger opens and existing items appear under `room='default'`.

## Open Questions

1. **Does the human's "All" view show merged chat or per-room columns?** Lean toward merged chat with a subtle room tag on each message (like a source badge). Column-per-room adds UI surface for a feature the single-room view already covers. Decide during UI implementation.
2. **Pause/resume: does Resume clear an earlier Pause interrupt or just stack?** Interrupts are currently `pending → acknowledged` (no superseding). Suggest: Resume generates a *new* interrupt, and the UI side-effects auto-ack the prior Pause interrupt when the human clicks Resume. Alternative: leave Pause acknowledged by the agent naturally when it reads the Resume card; the Pause interrupt remains in the ledger as an audit trail.
3. **Should `GET /nutshell` without `room` query param return the human's current room's nutshell, or error?** Lean toward: require the query param; stale clients get a clean 400 and migrate. The cost of inferring a "default room" from the hub's state is brittleness on the client side.
