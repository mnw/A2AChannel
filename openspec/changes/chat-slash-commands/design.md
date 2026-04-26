## Context

The Claude Code CLI does not expose any remote-input API: external processes cannot push prompts, slash commands, or keystrokes into a running interactive session. The Anthropic Agent SDK is a fresh-loop control surface, not a way to drive the CLI. A previous architectural exploration (see this change's preceding conversation) confirmed three things:

1. The only way to send slash commands to a running tmux-backed claude is to write raw bytes to its PTY master.
2. A2AChannel already owns those PTY masters via `pty_write(agent: String, b64: String)` (`src-tauri/src/pty.rs:374`).
3. PTY-write is byte-level equivalent to the human typing in the xterm — supports every slash command including TTY-bound ones (`/clear` confirm, `/model` picker, `/help`) that the SDK explicitly excludes.

The chat composer today (`ui/index.html` and `ui/features/`) sends every message through `POST /post` to the hub, which fans it out to agent channel queues as MCP `notifications/claude/channel`. Claude reads channel messages as agent context — they do not invoke slash commands. Adding chat→PTY routing fills this gap without rewriting the channel contract.

Constraints from `CLAUDE.md`:
- Vanilla HTML/CSS/JS in `ui/index.html` — no framework, no bundler.
- Rooms are immutable per agent. Cross-room mutations are 403 for non-human senders. Slash sends are local PTY writes, not hub mutations, so the hub's cross-room rules don't directly gate them — but the UI guardrails enforce equivalent intent (room must be selected; `@all` resolves only within the selected room).
- All persistent state-machine kinds live under `hub/kinds/`. We are explicitly NOT introducing a new kind for slash sends; the audit trail is a UI-side ephemeral chat entry.

## Goals / Non-Goals

**Goals:**
- Let the human send any slash command (built-in, MCP-prompt, custom command, custom skill) to one or more agents from the chat composer, without leaving the room view.
- Reuse existing primitives: `pty_write` Tauri command, `@mention` popover, room dropdown state.
- Surface command discovery: a picker that lists commands available across the room's agents with per-agent badges.
- Produce a visible audit row in chat for each send, so the human can scroll back and see what they did.
- Block obvious footguns: cross-room broadcast (All-rooms view) and ambiguous broadcast (no `@target`).

**Non-Goals:**
- Routing slash commands through the channel as MCP notifications. Bytes go straight to PTY; channel is untouched.
- Adding a new persistent kind. The audit chat row is in-memory only and lost on hub restart. If long-term replay is wanted later, a `command` kind is a separate change.
- Detecting claude's internal modal states (mid-stream, slash-picker open, autocomplete dialog). PTY-write is state-blind; the human owns the consequences.
- Streaming back per-agent stdout for the picker (e.g. running `/help` on each agent and parsing). Discovery is purely filesystem-based + a hardcoded built-in list.
- Supporting agents we don't own a PTY for (`external` state). They are excluded from `@all` and not individually targetable via slash mode.
- Cross-room broadcast. `@all` resolves only within the selected room.

## Decisions

### D1. Routing topology: chat→PTY bypasses the hub

Slash sends invoke `pty_write(agent, base64(text))` directly from the webview via Tauri IPC. They do **not** call `POST /post` on the hub. Rationale:

- Channel and PTY are intentionally separate surfaces. Channel is durable / dedup'd / structured (handoff/interrupt/permission kinds). PTY is raw bytes / no replay / no addressing. Routing slash sends through the channel would couple them and confuse "what was actually said to this agent."
- The hub adds nothing for this use case (no fan-out, no persistence, no kind transitions). Going around it is the correct simplification.
- Trust model is unchanged: the webview already holds the hub bearer token for `/post`; PTY writes are also authoritative-from-the-webview, no new attack surface.

**Alternatives considered:**
- Route via the channel as a "slash" entry kind, then have channel-bin perform the PTY write. Adds a network hop and a new entry kind for no benefit; PTY masters already live in the same Rust process as the webview.
- Add a `/slash` hub endpoint that the webview calls, which then writes via `pty_write`. Same critique; the webview can call `pty_write` directly.

### D2. Command discovery: filesystem scan + hardcoded built-ins

Per agent in the selected room, scan:
- `<agent-cwd>/.claude/commands/*.md` (project commands)
- `<agent-cwd>/.claude/skills/*/SKILL.md` (project skills)
- `~/.claude/commands/*.md` (personal commands)
- `~/.claude/skills/*/SKILL.md` (personal skills)

Plus a hardcoded built-in list: `/clear, /compact, /context, /usage, /cost, /model, /help, /mcp` (subject to evolution as claude releases new built-ins). The picker takes the union, computes the per-agent availability badge as `command ∈ availableSet(agent)`.

Rescan is performed every time the picker opens (on `/` keystroke). Filesystem ops are local + tiny; cost is sub-millisecond and avoids stale state when the user edits commands while the app is running.

**Alternatives considered:**
- Run `/help` on each agent and scrape stdout. Live but slow, racy, and pollutes the agent's xterm. Rejected.
- Watch the directories with `fs.watch`. Overkill; on-`/`-keystroke is good enough.
- Single built-in list shared across all agents. Wrong — built-ins are version-bound to the claude binary; if agents use different `claude_path` values, the built-in set could diverge. Practically rare; we accept the simplification.

The built-in list is a maintenance burden but small. Add one constant in code; review on each Claude Code release.

### D3. Targeting parser: leverage `@mention` popover

The composer already has an `@`-triggered mention popover (`ui/features/mentions.js`) for chat targeting. In slash mode, the same popover triggers when the user types `@` after the slash command. Mention popover already handles roster lookup, fuzzy filter, keyboard nav. Reuse rather than reimplement.

The composer parser splits the message into three segments:
1. `slashCommand` — the leading `/word`
2. `target` — the `@word` (must be one of the live agents in the selected room, or `all`)
3. `args` — everything else, passed verbatim after the slash command

Sending requires both `slashCommand` and `target` to be present; otherwise the composer shows an inline error and disables the send button.

**Alternatives considered:**
- A separate target dropdown for slash mode (mirror of the existing chat target dropdown). Rejected — two visual targeting affordances in the same composer is confusing. Inline `@target` is the simpler model.
- Implicit target = composer's current chat target dropdown selection. Rejected — slash mode and chat mode are distinct enough that conflating their target state surprises the user.

### D4. Busy-skip: detect-and-exclude on `@all` expansion

When `@all` resolves, the resolver:
1. Pulls all agents in the selected room from the roster.
2. Excludes agents whose `data-state !== "live"` (external, dead, launching).
3. Excludes agents we know are busy via existing UI state:
   - Has a pending `permission` (verdict not yet given)
   - Has a pending `interrupt` (not yet acked)
4. Reports the final set + the skipped set to the audit entry.

Internal claude states (mid-stream, slash-picker open, modal) are unobservable; we do not attempt to detect them. The user's xterm shows the consequence; if a send goes wrong, they see it.

**Alternatives considered:**
- Don't auto-skip; let the user decide via per-agent indicators (Q4 option C). Slightly more flexible but requires more UI surface and a "send anyway" confirm flow. We picked auto-skip for simpler default behavior; users can still target individuals manually if they want to override.

### D5. Audit: synthetic system entry per send, in-memory

Each successful send (after busy-skip) emits one chat entry:

```
─ system  human → /clear @all (planner, builder, reviewer, docs)
                  skipped: nebula (permission pending)            12:34
```

Implementation: the existing chat-render path accepts a `system`-typed entry. The webview appends one client-side after `pty_write` resolves. Not persisted to the hub; not broadcast to other clients (there are no other clients in single-user A2AChannel today).

**Alternatives considered:**
- Persistent `command` kind with replay. Overkill for a personal tool. If a future user or team wants persistent slash audit, that's a follow-up change adding a new `KindModule`.
- Nothing in chat. Tested mentally and rejected — the user needs to be able to scroll back and recall what they ran.

### D6. Destructive confirm: hardcoded set × plural target

On send, if `slashCommand ∈ DESTRUCTIVE_SET` and `resolvedTargets.length > 1`, show a modal: "About to run `/clear` on planner, builder, reviewer, docs. Continue?" with Confirm / Cancel.

Initial `DESTRUCTIVE_SET = { "/clear", "/compact" }` — both wipe context per agent, irreversibly. New destructive built-ins added as claude evolves.

Single-agent destructive sends and any non-destructive `@all` send proceed without confirm.

**Alternatives considered:**
- Always confirm any `@all` send. Rejected — `/help @all` is benign and confirming it teaches the user to dismiss the modal reflexively, which defeats the purpose for `/clear @all`.
- Never confirm. Rejected — `/clear @all` to a 4-agent room is 4 irreversible context wipes from one keystroke.

### D7. Slash-mode activation: leading `/` on otherwise-empty composer

Slash mode activates when the composer's first character is `/` AND the composer is otherwise empty. Typing `/` mid-message (e.g. inside a path) does not trigger the picker.

Pressing Escape while the picker is open dismisses it back to chat mode. Backspacing the leading `/` exits slash mode.

This rule mirrors how the `@mention` popover already works (triggers on `@` at word boundaries) and keeps the activation surface narrow enough to avoid accidental triggers.

## Risks / Trade-offs

- **State-blind injection** → Mitigated by busy-skip on `@all` expansion. Unmitigated for claude's internal modal states. Accepted: documented in the audit row when known, otherwise the human owns the consequences (visible in xterm).

- **Built-in command list rots with claude releases** → Mitigated by also showing whatever lives on disk; the user can always type any command name even if not in the picker. Update the constant on each Claude Code version bump.

- **Audit lost on hub restart** → Accepted for a personal tool. Promote to a persistent `command` kind in a follow-up change if needed.

- **Filesystem scan on every `/` keystroke** → Cheap (local fs, tiny markdown files), but a room with many agents in distant cwds could amortize visibly. Mitigation: cache for the lifetime of the popover open, invalidate on close.

- **Cross-room slash broadcasts impossible by design** → Some users may want them. Accepted as out-of-scope for v1; revisit if requested.

- **Two writers to the same PTY** → The xterm tab and the chat composer can both write to an agent's PTY master. tmux supports concurrent clients writing to a session; output multiplexes naturally. Documented in the modified `terminal-projection` spec.

- **`@external` agents invisible to slash mode** → Externally-attached claude sessions (running outside A2AChannel) cannot be targeted because we don't own their PTY. Accepted: out of scope; they remain visible in the roster and chat-targetable as today.
