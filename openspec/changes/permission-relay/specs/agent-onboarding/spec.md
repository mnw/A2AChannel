## MODIFIED Requirements

### Requirement: Hub pushes an onboarding briefing on first `/agent-stream` connect

When an agent's channel-mode sidecar first connects to `/agent-stream?agent=<name>` during the current hub process's lifetime, the hub SHALL emit a single `briefing` event carrying the tool inventory, peer roster (with online flags), attachments directory, human name, and current nutshell text.

The tool inventory SHALL include `ack_permission` alongside the existing `post`, `post_file`, `send_handoff`, `accept_handoff`, `decline_handoff`, `cancel_handoff`, `send_interrupt`, `ack_interrupt` entries. Agents learn from the briefing that they can relay permission verdicts for any agent in the room, not only themselves.

The briefing is session-scoped — reconnects during the same hub process do NOT re-emit it. Hub restart resets the per-agent "has-been-briefed" flag.

#### Scenario: First-connect briefing includes `ack_permission`

- **GIVEN** A2AChannel v0.8 is running and alice connects for the first time
- **WHEN** the hub emits the briefing event
- **THEN** the `tools` array in the briefing contains `ack_permission`
- **AND** chatbridge's system-prompt forwarding renders the tool so alice's claude knows the capability exists
