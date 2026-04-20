## ADDED Requirements

### Requirement: Hub pushes a briefing notification on first agent connect

The hub SHALL detect the first `/agent-stream` connection for a given agent name within a running hub process and push a single `briefing` event to that agent's queue before any chat or handoff events. "First connection" is defined per hub process (hub restart triggers a fresh briefing).

The briefing shape:
```json
{
  "type": "briefing",
  "tools": ["post", "post_file", "send_handoff", "accept_handoff", "decline_handoff", "cancel_handoff", "send_interrupt", "ack_interrupt"],
  "peers": [{ "name": "alice", "online": true }, { "name": "human", "online": true }],
  "attachments_dir": "/Users/<user>/a2a-attachments",
  "human_name": "human",
  "nutshell": "..." ,
  "ts": "14:22:03"
}
```

`nutshell` is the current project summary (see `project-nutshell` capability); null if empty.

#### Scenario: Briefing is delivered before any chat message

- **GIVEN** the hub has been running since its last start
- **AND** agent `alice` has not yet connected during this hub lifetime
- **WHEN** `alice`'s channel sidecar connects to `/agent-stream?agent=alice`
- **THEN** the very first event on the SSE stream (after the standard `: connected` preamble) is the `briefing` event
- **AND** any queued chat messages are delivered AFTER the briefing

#### Scenario: Reconnect within same hub process does not re-send briefing

- **GIVEN** `alice` already received a briefing during this hub process
- **WHEN** `alice` disconnects and reconnects
- **THEN** no new briefing is sent
- **AND** the usual replay (pending handoffs, etc.) proceeds as today

#### Scenario: Hub restart triggers a fresh briefing

- **GIVEN** `alice` received a briefing, then the hub restarted
- **WHEN** `alice` connects to the new hub
- **THEN** a fresh briefing is pushed

### Requirement: Channel sidecar forwards the briefing as a structured MCP notification

The channel-mode sidecar SHALL recognize `type="briefing"` events on its SSE stream and forward them as `notifications/claude/channel` with `meta.kind="briefing"`. The notification `content` SHALL be a human-readable paragraph summarizing the tool inventory, peers, attachments path, and nutshell in plain prose so the agent's model can absorb it as context without needing JSON parsing.

The sidecar SHALL NOT expose the briefing as a chat message; it is metadata for the agent.

#### Scenario: Agent sees the briefing in its context

- **WHEN** the briefing arrives at the channel sidecar
- **THEN** the agent's claude session receives a `<channel kind="briefing">` tag mid-context
- **AND** the content is a readable paragraph: tools available, who else is in the room, where attachments live, and the current nutshell (if any)

### Requirement: Briefing content is refreshed from live hub state at delivery time

The briefing's `peers`, `attachments_dir`, `human_name`, and `nutshell` SHALL be read at delivery time — never cached across hub restarts or settings reloads. If the hub's configuration changes between boots, the next briefing reflects the new state.

#### Scenario: Settings reload changes briefing for next connection

- **GIVEN** `config.json` has `human_name: "alice"`
- **AND** an agent named `bob` has not yet connected during this hub session
- **WHEN** the user edits `config.json` to `human_name: "captain"`, clicks the reload button
- **AND** `bob` then connects
- **THEN** `bob`'s briefing shows `human_name: "captain"`
