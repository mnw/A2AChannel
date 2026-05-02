# A2AChannel

A2AChannel is a single macOS app that lets multiple Claude Code sessions talk to each other and to a human through a shared chat surface, with structured side-channels for handoffs, interrupts, and tool permissions. This file is the project's domain vocabulary — names of seams that already matter, plus the words to avoid that get confused with them.

## Language

### Processes & topology

**Shell**:
The Tauri Rust process. Owns app lifecycle, picks the **Hub** port, mints the auth token, exposes Tauri commands to the **Webview**, and spawns the **Hub** sidecar.
_Avoid_: app, host, native side.

**Hub**:
The single in-process orchestrator (`hub-bin`, compiled from `hub/hub.ts`). Owns the **Roster**, the **Ledger**, the in-memory chat ring, and all SSE fan-out. Loopback-only on a port chosen at startup.
_Avoid_: server, backend, broker, daemon.

**Sidecar**:
Any helper binary spawned by the **Shell** or by an **Agent**'s MCP config. The two sidecars are `a2a-bin` (in hub mode = the **Hub**) and `a2a-bin` (in channel mode = the **Channel**).
_Avoid_: subprocess, helper, child process.

**Channel**:
The per-**Agent** MCP **Sidecar** (`a2a-bin` in channel mode). Tails `/agent-stream`, exposes the `post` tool, relays the `claude/channel/permission` capability. One **Channel** per **Agent** session.
_Avoid_: bridge, transport, MCP server (too generic — "Channel" is the *named* sidecar).

**Webview**:
The vanilla HTML/CSS/JS UI loaded by the **Shell**. No bundler, no framework. Reaches the **Hub** via SSE + fetch; reaches the **Shell** via Tauri IPC for PTY work.
_Avoid_: frontend, client (overloaded), renderer.

### People & sessions

**Agent**:
A Claude Code session running under a **Tab**, identified by a name. Auto-registered the first time the name appears on `/agent-stream` or `/post`. A name maps 1:1 to a tmux session, an MCP config file, a settings file, and an entry in the **Roster**.
_Avoid_: bot, worker, AI, session (ambiguous).

**Human**:
The permanent **Roster** member representing the user. Name comes from `A2A_HUMAN_NAME` (default `"human"`). Registered at **Hub** start, never expires, has `room = null` so it's implicitly in every **Room**. The only sender allowed to mutate cross-**Room** or broadcast `target: "all"` with an explicit `room`.
_Avoid_: user (overloaded with auth/principal), operator, owner.

**Roster**:
The live set of known **Agents** (plus the **Human**). In-memory only — never persisted. Entries are auto-added on first contact and auto-removed after `STALE_AGENT_MS` of disconnection (with the **Human** exempt via `permanentAgents`). Three structures stay in sync atomically: `knownAgents`, `agentQueues`, `agentConnections`.
_Avoid_: directory, registry (we already use "registry" for Tauri command tables).

**Tab**:
The **Webview**'s representation of one **Agent**'s tmux session. Owns the xterm.js instance, the spinner state, the live/spawning/dead status. One **Tab** per **Agent**, lifecycle independent of the **Roster** entry.
_Avoid_: pane (tmux owns "pane"), terminal (too generic).

### Grouping

**Room**:
An immutable label captured on the **Agent**'s first `/agent-stream` connect from `&room=<label>`. Agents can only mutate state inside their own **Room**; the **Human** can act across all of them. Used to scope chat, **Nutshell**, structured-message broadcasts, and slash-send targeting.
_Avoid_: workspace, project, channel (collides with **Channel**), context.

**Briefing**:
The one-shot init message the **Hub** sends to an **Agent** on its first `/agent-stream` connect within a **Hub** process. Contains the same-**Room** **Nutshell**, pending **Handoffs**/**Interrupts**/**Permissions**, and **Roster** metadata. Tracked in `briefedAgents` per-process — re-issued on **Hub** restart, never on reconnect.
_Avoid_: handshake, init, hello, sync.

### State-machines

**Kind**:
A persistent state-machine type with a lifecycle (verbs that drive it through statuses), durable storage, and broadcast fan-out on each verb. Each **Kind** lives in its own `hub/kinds/<kind>.ts` file implementing the `KindModule` contract. The current **Kinds** are **Handoff**, **Interrupt**, and **Permission**.
_Avoid_: entity, primitive (used informally elsewhere — keep "Kind" precise), record type.

**Handoff**:
A **Kind** for transferring work from one **Agent** to another (or to/from the **Human**). Verbs: `create`, `accept`, `decline`, `cancel`, `expire`. Carries `task` + `context` (free-form JSON, including diffs). Also the carrier of **Nutshell** edits via `task: "[nutshell]"` + `context.patch`.
_Avoid_: task, ticket, request, transfer.

**Interrupt**:
A **Kind** for cooperative attention signals — `pending → acknowledged`, no cancel, no expire, 500-char text cap. Not a preemption; receiver decides when to look.
_Avoid_: notification, alert, ping (those imply unsolicited — **Interrupt** is structured and acknowledged).

**Permission**:
A **Kind** representing a Claude Code tool-use approval prompt that has been relayed out to the **Channel**'s `claude/channel/permission` capability. Carries `tool`, `input`, `context`. Lifecycle: `pending → approved | denied | dismissed | expired`. No TTL — Claude Code's local dialog owns the effective timeout.
_Avoid_: approval, request (too generic), prompt.

**Nutshell**:
A per-**Room** single-row document (the `nutshell` table) that captures the current shared mental model for that **Room**. Edits flow through the **Handoff** primitive (task prefix `[nutshell]`, `context.patch` carries the new full text) and apply atomically with the accept event. **Nutshell** is *not* a **Kind** — it has no lifecycle and no fan-out of its own.
_Avoid_: doc, summary, status (too vague).

### Storage

**Ledger**:
The single SQLite database (`ledger.db`) owning every **Kind**'s events and derived rows. One row in `events` per state change, one update to the per-**Kind** derived table, in a single transaction. Versioned schema (`LEDGER_SCHEMA_VERSION`); migrations run forward-only on open.
_Avoid_: database, store, DB, persistence layer.

**Event**:
The immutable, append-only row in the `events` table. Has a monotonic `seq` that doubles as the broadcast `version`. Every **Kind** state change writes exactly one **Event** + one derived-table update in one transaction.
_Avoid_: log entry, record, message (collides with chat).

**Transcript**:
A per-**Room** JSONL log of chat lines, written only when the **Room**'s `room_settings.persist_transcript` is true. Active file `<hash8>-<sanitized>.jsonl` rotates at 10,000 lines into `<hash8>-<sanitized>.<seq>.jsonl`. Owns chat persistence; the **Ledger** owns **Kind** persistence — they never overlap. **Hub** restart wipes the in-memory chat — the **Transcript** is not replayed back.
_Avoid_: history, log, archive.

**Discovery file**:
One of the two paired files the **Shell** writes for **Sidecars** to find the **Hub**: `hub.url` (URL string) and `hub.token` (bearer token, mode `0600`). The **Channel** re-reads both on every retry so a rotated token self-heals.
_Avoid_: config file, lockfile.

### Messaging

**Chat log**:
The in-memory ring buffer of free-form messages (`chat_history_limit` cap, default 1000). Wiped on **Hub** restart. Distinct from the **Ledger** (which holds **Kind** state) and the **Transcript** (which optionally persists chat to disk per **Room**).
_Avoid_: messages, conversation (singular feels too narrow — there are many **Rooms**).

**Attachment**:
A file uploaded via `POST /upload` and persisted at `<A2A_ATTACHMENTS_DIR>/<id>.<ext>`. Allowlist is by extension, configured in `config.yml`. Referenced in chat text as `[attachment: <path>]`; **Agents** receive absolute paths, the **Webview** receives `/image/<id>.<ext>` URLs.
_Avoid_: upload, file, blob.

**Broadcast scope**:
The destination of an SSE fan-out, expressed as one of `{ kind: "broadcast" }`, `{ kind: "to-agents", agents: [...] }`, `{ kind: "ui-only" }`, `{ kind: "room", room }`. **Kinds** emit through `cap.sse.emit(entry, scope)`; never enumerate **Agent** queues directly from a **Kind**.
_Avoid_: target, audience, recipients (those are properties of an individual message, not the SSE delivery scope).

**Slash command**:
A `/`-prefixed message in the composer. Bypasses the **Hub** entirely — bytes go through `pty_write` Tauri IPC straight to the per-**Agent** tmux PTY. Logs one synthetic `system` entry in the **Chat log** for the audit trail. Requires a concrete **Room** (not "All rooms") and explicit `@agent` / `@all` targeting.
_Avoid_: command, shortcut.

### Capture & PTY

**Capture**:
A deterministic single-turn TUI **Capture** primitive (`pty_capture_turn`). Coordinates geometry (tmux `set-option window-size manual` + `resize-window 240×100`), output (`tmux pipe-pane -o`), and completion (Stop-hook sentinel poll) atomically. Writes to `/tmp/a2a/<agent>/captures/turn-<epoch>.log`.
_Avoid_: snapshot (collides with the deleted scraper), screenshot, dump.

## Relationships

- A **Shell** spawns one **Hub** and zero or more **Channels** (indirectly, via **Agent** MCP configs).
- A **Hub** has one **Roster**, one **Ledger**, one in-memory **Chat log** (per process), and many **Rooms**.
- A **Roster** contains one **Human** and zero or more **Agents**.
- An **Agent** belongs to exactly one **Room** (immutable post-first-connect). The **Human** belongs to all **Rooms** implicitly.
- An **Agent** has exactly one **Tab** in the **Webview** while alive.
- A **Channel** serves exactly one **Agent**.
- A **Room** has at most one **Nutshell** and at most one **Transcript** file family.
- A **Kind** instance lives in the **Ledger**: many **Events** + one derived row, addressable by id, broadcast on every verb.
- A **Briefing** is sent once per **Agent** per **Hub** process — surviving across reconnects, lost on **Hub** restart.

## Example dialogue

> **Dev:** "When the **Human** sends a chat with `target: "all"`, does that fan out to every **Agent**?"
> **Domain expert:** "Only every **Agent** in the **Room** the **Human** explicitly named. We force the **Webview** to pass `room` because 'all' is ambiguous across **Rooms** — silently broadcasting everywhere is worse than a 400."

> **Dev:** "If I want to add a `signoff` workflow, that's another **Kind**?"
> **Domain expert:** "Yes — its own file under `hub/kinds/`, implementing `KindModule`. It writes to the **Ledger**, broadcasts via `cap.sse.emit`, gets included in the **Briefing**. Don't shortcut it as a **Nutshell** edit unless it's literally a document patch with no lifecycle."

> **Dev:** "Why doesn't the **Hub** replay the **Transcript** back into the **Chat log** on restart?"
> **Domain expert:** "Deliberate. **Transcript** is forensic; **Chat log** is live. Mixing them surprises users who closed all **Agents** expecting state to clear."

## Flagged ambiguities

- **"channel"** is overloaded between (1) the **Channel** sidecar and (2) the `claude/channel/permission` MCP capability. Resolved: capitalize **Channel** for the sidecar, keep `claude/channel/*` lowercased and quoted when referring to the MCP capability namespace.
- **"session"** was used informally for tmux sessions, **Agent** sessions, and SSE sessions. Resolved: prefer **Agent** for the per-Claude-Code lifetime, "tmux session" when explicitly tmux, and "SSE connection" for transport. Avoid bare "session".
- **"client"** was used for the **Webview**, the **Channel**, and arbitrary HTTP callers. Resolved: name the specific role (**Webview**, **Channel**, **Agent**, **Human**) — never bare "client".
- **"primitive"** was used in CLAUDE.md hard rules to mean both **Kind** and lower-level building blocks (e.g., `pty_capture_turn`). Resolved: **Kind** for the persistent state-machine types only; use "primitive" informally elsewhere.
- **"snapshot"** was used by the deleted permission scraper. Now reserved for the **Ledger**'s `PermissionSnapshot` row type. Don't reintroduce it for capture/screenshot work — use **Capture**.
