## Why

Claude Code pauses the agent's session whenever a tool requires approval (Bash, Write, Edit, …). The approval dialog opens in the local terminal and waits for a Y/N keystroke. In v0.7, that local terminal is A2AChannel's embedded xterm pane — which means the human has to be physically focused on that specific tab to unblock the agent.

For a multi-agent workspace this is the wrong shape. If the human is chatting with Alice about architecture while Bob's session hits a `Bash` approval, Bob hangs until the human remembers to switch tabs. At three or four agents the backlog of silent waits becomes a coordination tax that erodes the premise of the product.

Claude Code 2.1.81 added an MCP capability — `claude/channel/permission` — that forwards approval prompts to any two-way channel that declares it. The channel receives `notifications/claude/channel/permission_request` with a request ID, tool name, description, and argument preview. It sends back `notifications/claude/channel/permission` with `allow` or `deny`. Both the remote verdict and the local terminal dialog stay live; first answer wins, the other is dropped.

chatbridge already is a two-way channel. Declaring the capability and wiring request-render + verdict-send into A2AChannel turns every agent's approval prompt into a chat-room event the human (or another agent) can act on from anywhere the hub is reachable. Approve Bob's Bash call from the chat UI while staying in Alice's tab. No more silent waits.

## What Changes

- **BREAKING for the channel protocol (additive):** chatbridge declares `claude/channel/permission: {}` under `capabilities.experimental`. Claude Code 2.1.81+ starts forwarding approval prompts; older versions ignore the capability. No regression for pre-2.1.81 users.
- **New hub endpoints** for the relay lifecycle:
  - `POST /permissions` — chatbridge forwards `permission_request` payloads here (sender = agent name, fields = request_id/tool_name/description/input_preview).
  - `POST /permissions/:request_id/verdict` — any roster member (UI or agent) submits `{ by, behavior: "allow" | "deny" }`.
  - `GET /permissions?status=pending&for=<agent>` — UI bootstraps pending requests on connect.
  - SSE events `permission.new` and `permission.resolved` broadcast on `/stream` and the recipient agent's `/agent-stream`.
- **New ledger table** `permissions`: `(id, agent, tool_name, description, input_preview, status, created_at_ms, resolved_at_ms, resolved_by, behavior)`. Single-writer per status change; follows the same event-log-plus-derived-row invariant as handoffs and interrupts.
- **chatbridge (`hub/channel.ts`)** registers a notification handler for `notifications/claude/channel/permission_request`, forwards to the hub's `POST /permissions`, then listens on the agent-stream for matching `permission.resolved` events and emits `notifications/claude/channel/permission` back to claude with the verdict. Handles the "terminal already answered" race by silently dropping unmatched verdicts.
- **UI** renders a sticky red permission card (same visual language as interrupts — this is a "stop and answer" signal) at the top of the chat with Allow / Deny buttons. Cards appear for any agent's pending approval; the human can answer regardless of which tab they're on. On verdict, the card transitions to a resolved state showing who answered and how.
- **Agent tool set** gains `ack_permission(request_id, behavior)` so other agents in the room (not just the human) can relay-approve on the human's behalf — useful for team workflows where a `reviewer` agent is tasked with approving trivial reads. Gated by the same trust-on-self-assertion model as handoffs; the hub doesn't validate authorisation, just identity.
- **Sender identity recheck.** The docs emphasize that permission relays should only be enabled for channels with real sender gating. Our hub already requires a bearer token on mutating routes; we add a CLAUDE.md hard rule that the `claude/channel/permission` capability MUST NOT be declared without token auth on `/permissions/*`.

## Capabilities

### New Capabilities

- `permission-relay`: the full lifecycle — chatbridge capability declaration, hub routes, ledger table, SSE broadcasts, UI cards, `ack_permission` tool. Mirrors the shape of the existing `structured-handoff` and `interrupt-messages` capabilities; sits alongside them in the protocol surface.

### Modified Capabilities

- `hub-request-safety`: extends to cover `/permissions[/...]` routes with the same auth + body-size + trust-on-self-assertion pattern as existing mutating endpoints. Request body cap: 16 KiB (description + input_preview are bounded; no large-context payloads).
- `agent-onboarding`: briefing gains a line about `ack_permission` being available. No structural change; just extends the tool list.

## Impact

**Code:**
- `hub/hub.ts` — new `permissions` table + migrations → schema_version 3; `createPermission`, `resolvePermission`, `listPermissions` state-machine helpers following the interrupt pattern; routes, broadcasts, replay on reconnect.
- `hub/channel.ts` — add `claude/channel/permission: {}` capability; new notification handler for `permission_request`; new `ack_permission` MCP tool; new `authedPost` to `/permissions/:id/verdict`; outbound verdict emitter on receipt of `permission.resolved` events.
- `ui/main.js` — new `renderPermissionCard` (sticky, red-accented, at top of chat above interrupt cards); Allow/Deny buttons call `/permissions/:id/verdict`; reconciliation by `(id, max-version-seen)`.
- `ui/index.html` — optional: dedicated permission-badge near the header showing pending-count across all agents ("3 agents waiting"). Helps the human scan for blocked work without opening each tab.
- `src-tauri/src/pty.rs` — no change. The terminal pane is orthogonal; claude still renders its local dialog in the xterm, the user can answer there or in chat.
- `docs/PROTOCOL.md` — new "Permissions" section with schemas, routes, SSE events, terminal-state policy, and the upstream `claude/channel/permission` contract.

**APIs:**
- HTTP: `POST /permissions`, `POST /permissions/:id/verdict`, `GET /permissions`.
- SSE: `permission.new`, `permission.resolved`.
- MCP tool: `ack_permission(request_id, behavior)`.
- MCP capability: `claude/channel/permission: {}` on chatbridge.

**Dependencies:** none new. All of this is TypeScript + vanilla JS + SQL; no Rust, no vendored libs.

**Bundle size:** ~no delta (<1 KB compressed on both hub and channel sidecars).

**Migration:**
- Ledger schema_version bumps 2 → 3. Additive table; no backfill. v0.7 ledgers open cleanly under v0.8 (the new table is created on first open).
- MCP protocol additive. Claude Code < 2.1.81 silently ignores the new capability and operates exactly as v0.7; users on older claude see no change.
- Existing sessions relaunched under v0.8 opt in automatically when chatbridge's new capability declaration registers.

**Out of scope (explicitly deferred):**
- Cryptographic agent identity binding on verdicts. Same trust-on-self-assertion as the rest of the protocol.
- Cross-room permission routing (when multi-room lands in v0.9+, a permission request is scoped to the room the requesting agent is in).
- Permission-policy rules (auto-allow `Read`, auto-deny `Bash` for destructive commands, etc.). Useful later but not this change — v0.8 is the plumbing, policy is a separate feature.
- Permission relay for MCP server consent dialogs (the "trust this MCP server?" prompt). Per upstream docs, those don't relay. Only tool-use approvals do.
