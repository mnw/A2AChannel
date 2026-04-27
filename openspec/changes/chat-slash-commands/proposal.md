## Why

Today the human can chat at agents (channel) but cannot drive their slash commands (`/clear`, `/compact`, `/help`, `/refactor`, custom skills, MCP-prompts) without physically focusing each agent's xterm tab and typing. Anthropic exposes no remote-input API; the SDK is a separate-loop replacement, not a control surface; pivoting to the SDK forfeits Max-subscription auth and the live TUI. The pragmatic gap-fill is: let the chat composer route `/`-prefixed messages straight to the per-agent PTY, with explicit targeting and an inline picker.

## What Changes

- Composer detects a leading `/` at the start of a message and switches to **slash mode**: a popover opens listing all slash commands available across the agents in the currently-selected room (built-ins + per-agent `.claude/commands/` + `.claude/skills/` + personal `~/.claude/...`).
- The picker shows commands as a union with per-agent availability badges (e.g. `/refactor — 1/4 agents`).
- Every slash send requires explicit targeting via the existing `@mention` syntax: `@agent` for one agent, `@all` for every live agent in the room. Sending `/cmd` with no `@` is rejected client-side with a hint.
- Slash commands are blocked entirely when the room dropdown is on `All rooms` — the user must select a concrete room first.
- Routing: `/cmd @target` writes raw bytes (`/cmd\r\n`) to the targeted agent's PTY master via the existing `pty_write` Tauri command. Bytes do **not** flow through the channel and do **not** reach claude as a `notifications/claude/channel` message.
- Busy detection (best-effort): agents with a pending permission or interrupt are auto-skipped from `@all` expansion, with a status note. Claude's internal modal state (mid-stream, slash-picker open) is unobservable from outside the PTY and is not handled.
- Audit: each slash send produces one synthetic `system` chat entry (`human → /clear @all (planner, builder, reviewer, docs)`). In-memory only, lost on hub restart. No new persistent kind.
- Destructive confirm: when the command is in a hardcoded destructive set (`/clear`, `/compact`) **and** the resolved target list has more than one agent, a confirm modal appears before the PTY writes. Single-agent destructive sends and any non-destructive `@all` send proceed without confirmation.
- `external`-state agents (sessions A2AChannel does not own a PTY for) are excluded from `@all` and cannot be targeted individually. The shell tab is never an agent and never a target.

## Capabilities

### New Capabilities
- `chat-slash-commands`: slash-mode composer (picker + parser + sender), filesystem-based command discovery, PTY-write routing per resolved target, busy-skip + audit-entry + destructive-confirm policy.

### Modified Capabilities
- `terminal-projection`: documents the new chat→PTY ingress as a second writer to the agent PTY master alongside the xterm. No invariant changes — `pty_write` already exists and ships in v0.9.x — but the spec needs to acknowledge that bytes can now originate from the chat composer, not just the focused xterm tab.

## Impact

- **UI**: new slash-picker popover + composer parser + send-side gating. Reuses `@mention` popover for targeting. ~400 lines under `ui/features/`.
- **Rust shell**: no new Tauri commands. `pty_write(agent, b64)` already exists at `src-tauri/src/pty.rs:374`.
- **Hub**: no new endpoints. Slash sends bypass the hub. The synthetic system audit entry is emitted client-side into the chat log via the existing UI append path; no schema change.
- **Channel / kinds**: no new kind. No persistence. No replay.
- **External APIs / Anthropic surface**: none. Bytes-into-PTY is undocumented but stable (it's the same surface the user uses by typing).
- **Risks**:
  - State-blind injection — bytes land wherever claude's cursor is. Mitigated by busy-skip for known states; unmitigated for claude's internal modal states.
  - Discovery drift — built-in command list rots as claude releases. Mitigated by also showing whatever lives on disk; user can always type any name.
  - Audit ephemerality — chat audit dies on hub restart. Acceptable for a personal tool; can promote to a persistent kind later if needed.
