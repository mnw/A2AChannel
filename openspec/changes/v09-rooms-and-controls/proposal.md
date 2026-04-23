## Why

A2AChannel is single-roster and single-nutshell by design: every agent in the window sees every message, and the project summary is global. That worked when an A2A session equalled one project, but in practice the human runs several projects in parallel from the same window. With the current flat room, backend chatter from project A pollutes the context of every agent in project B — and the nutshell that helps onboard new agents to project A is actively misleading to agents in project B. Starting a second A2AChannel instance is not a workaround: the hub socket, discovery files, tmux socket, and ledger are all at fixed paths, so two instances fight over the same state.

v0.9 introduces **rooms** as a first-class protocol primitive so one A2AChannel window can host multiple isolated projects without cross-project context leakage, and adds a per-room **pause / resume** control that lets the human halt and restart work across a whole room with one click (reusing the existing interrupt primitive).

## What Changes

- **`room` becomes a first-class field on agents and events.** The hub roster carries `room` per agent; every chat entry, handoff, interrupt, and permission event carries the sender's room. Broadcasts to `target: "all"` from an agent in room A fan out only to agents in room A plus the human. Targeted sends (`to: "<name>"`) still cross rooms — explicit cross-room coordination remains allowed, implicit chatter does not.
- **Nutshell becomes per-room.** The single-row `nutshell` table migrates to multi-row keyed by `room`. Each room has its own summary, version sequence, and `updated_by`. The briefing an agent receives on first `/agent-stream` connect includes the nutshell for its room only.
- **Handoffs and interrupts are room-scoped by default.** Sender and recipient must be in the same room unless the sender is the human (who is in every room). This matches the intent of the primitive — cross-project handoffs should be rare and explicit enough to want friction.
- **channel-bin declares its room at spawn time** via `CHATBRIDGE_ROOM=<label>` in the generated MCP config, alongside the existing `CHATBRIDGE_AGENT`. First `/agent-stream` connect per `(agent, room)` pair registers the mapping in the hub. Channel-bin also re-validates inbound events against its room as defense-in-depth, inspired by the upstream channels-reference "[Gate inbound messages](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages)" pattern — even if a hub routing bug ever leaked a cross-room event, the receiving channel-bin drops it before forwarding to claude's context.
- **UI room switcher in the header.** A dropdown lists the distinct rooms present in the current roster plus an "All" option for the human's god view. Switching a room filters chat, presence pills, terminal-pane tabs, and the nutshell strip. Human-side only — no protocol change.
- **Pause / Resume controls** next to the room switcher. Buttons send a canned interrupt to every agent in the currently-selected room: `"Pause — stop current task, hold state, await resume."` and `"Resume — continue previous task."` Reuses the existing `interrupt-messages` primitive; no new protocol. Cooperative, not preemptive (claude finishes the current tool call before reading the card), same semantics the interrupt primitive already documents.
- **Spawn modal** gains an optional `Room` field. Default value is the git-root basename of the selected cwd (walk up until `.git` is found), falling back to cwd basename. Users who want a bespoke label can override. Datalist suggests rooms already in use so typos become obvious.
- **Ledger schema_version bumps 3 → 4.** Additive: `room` column on `agents`, `events`, `handoffs`, `interrupts`, `nutshell`. Existing rows default to `"default"`. v0.8 ledgers open cleanly under v0.9 (column added with default on first open); v0.9 ledgers are unreadable by v0.8 (existing downgrade protection fires).

## Capabilities

### New Capabilities

- `rooms`: room identity on agents and events, hub-side routing scope, per-room nutshell, defense-in-depth sender-gate in channel-bin, UI room switcher.
- `pause-resume`: per-room pause and resume controls that emit canned interrupts to every agent in a room.

### Modified Capabilities

- `agent-onboarding`: briefing fans out only the sender's room's nutshell and peer list; `CHATBRIDGE_ROOM` env var added to the per-agent MCP config.
- `interrupt-messages`: recipient must be in the sender's room unless the sender is the human; the pause/resume flow is documented as a reserved use of this primitive.
- `project-nutshell`: single-row invariant replaced by one-row-per-room invariant; all read and write paths key by `(room, id=0)`.
- `hub-request-safety`: mutating routes that accept a `from` or `by` agent name now additionally validate room membership (except when `from`/`by` is the human).

## Impact

**Code:**
- `hub/hub.ts` — schema_version 4 migration; `room` column + indexes on agents/events/handoffs/interrupts; nutshell table becomes composite-key; `ensureAgent(name, room)` records room on first-connect; `broadcastUI` + `agentEntry` gain room-scoping logic; HTTP routes validate room; SSE events carry `room`.
- `hub/channel.ts` — reads `CHATBRIDGE_ROOM` env, registers with hub using it, re-validates incoming events by `meta.room === my_room` before forwarding to claude. Error on missing env (channel-bin refuses to start without a room — old behavior was "implicit default room"; we default to `"default"` when env is unset, for backward compat with external-spawn sessions that don't know the new env).
- `src-tauri/src/pty.rs` — `write_mcp_config_for` adds `CHATBRIDGE_ROOM` to the generated env map; `pty_spawn(agent, cwd, session_mode, room)` accepts a new optional parameter; default is git-root basename computed in Rust.
- `ui/main.js` — room-aware SSE filtering, room switcher dropdown in header, per-room nutshell rendering, pause/resume buttons wired to the interrupts endpoint with per-room fan-out.
- `ui/terminal.js` — `reconcile()` filters tabs by selected room; verb-pack stays global.
- `ui/index.html`, `ui/style.css` — header dropdown + pause/resume icon buttons; spawn modal adds Room input.
- `docs/PROTOCOL.md` — new "Rooms" section documenting the room identity, routing scope rules, per-room nutshell, and the human's super-user status.
- `scripts/release.sh` — ledger migration smoke test added to the pre-publish checklist.

**APIs:**
- HTTP (additive): every mutating endpoint that already accepts `from`/`by` now enforces room membership; `GET /nutshell?room=<label>`; `POST /interrupts` accepts an optional `rooms: [<label>]` bulk-target shape for the pause/resume buttons.
- SSE: every event on `/stream` and `/agent-stream` gains a `room` field. UI filters client-side; channel-bin filters server-side at the agent boundary.
- MCP (additive): agents receive `room` as a `<channel room="...">` attribute on each forwarded event so claude can reason about cross-room peers when explicitly addressed.
- Env: new `CHATBRIDGE_ROOM` in the per-agent MCP config; `A2A_DEFAULT_ROOM` accepted by the hub sidecar as fallback for external-spawn agents.

**Ledger:**
- schema_version 3 → 4, additive. `room TEXT NOT NULL DEFAULT 'default'` on agents, events, handoffs, interrupts. Nutshell table key changes from `id=0` to `room TEXT PRIMARY KEY`. Existing nutshell content moves to `room='default'`.

**Out of scope (deferred):**
- Room membership changes after spawn (rename, move agent between rooms). v0.9 fixes the room at spawn time; if a user wants a different room, they respawn.
- Cross-room visibility permissions beyond "human sees all, agent sees own room". No read-only observer roles.
- Per-room configuration (per-room `attachments_dir`, per-room `human_name`). Rooms inherit global config.
