## Why

After shipping v0.5.0 (typed handoffs + security hardening), an external contributor proposed a PTY-backed architecture rewrite coupled with multi-room chat (PR #1). The rewrite is an overreach — it collapses three sensible concerns (session lifecycle, coordination protocol, UI presentation) into one product category change (session orchestrator) with weeks of work and an unclear user win. But the proposal surfaced real gaps in today's product: the human can't observe raw agent output, can't send slash commands, can't answer interactive permission prompts, and new agents joining a project cold-start on every invocation. This change bundles the *useful* responses to those gaps with three adjacent polish and coordination improvements, as the v0.6 release target.

## What Changes

1. **UI polish.** Message bubbles with per-sender accent colors and avatars, right-aligned self messages, links rendered in a lighter color with a one-click copy button next to each link. Pure visual work in `ui/index.html`; no protocol change.
2. **Agents post files.** A new `post_file` MCP tool lets agents write into `attachments_dir` and broadcast a card to the room — symmetric with the existing human-upload path. Unlocks agent-generated artifacts (diffs, logs, reports) as first-class messages.
3. **Terminal pane per agent via tmux.** Bundle tmux; `a2a-bin` orchestrates one named tmux session per agent running `claude`. Webview gets a vertically-tabbed right pane with `xterm.js` attached. Delivers slash commands, interactive prompt handling, raw output visibility, and session continuity across A2AChannel restarts. MCP channels stay intact — tmux is strictly additive for surfaces channels deliberately don't cover.
4. **Human interrupt / attention flag.** A new typed message kind (`interrupt`) that pauses the receiving agent until acknowledged, rendered as a prominent card in the agent's channel notifications and the UI. Small protocol addition on top of the existing ledger, following the `handoff` pattern.
5. **Onboarding instructions on agent connect.** When a channel-mode sidecar registers with the hub, the hub sends a first notification containing available tools, room/peer-addressing conventions, and the attachments path. Replaces per-user system-prompt boilerplate with a built-in briefing.
6. **Persistent project nutshell.** A living project summary stored in the SQLite ledger. Any participant (agent or human) can propose edits via the existing handoff primitive — changes land only after peers accept. New agents joining mid-project receive the current nutshell as onboarding context alongside #5. Solves the cold-start problem of "re-explain the project to agent N" growing linearly with team size.

Multi-room chat (PR #1's core feature) is **not** included — the cost is real and the gain is speculative at current scale. Revisit once a concrete scenario emerges that a single shared room can't serve. Same for A2AChannel owning claude's process lifecycle end-to-end; tmux as the PTY layer gets us the observable/controllable surface without that commitment.

## Capabilities

### New Capabilities
- `attachment-upload-by-agent`: The `post_file` MCP tool and its server-side path — agent-originated uploads that land in `attachments_dir` and broadcast as cards.
- `terminal-projection`: tmux-backed session lifecycle, the webview's right-pane xterm integration, and the `a2a-bin` orchestration commands that create/attach/list sessions.
- `interrupt-messages`: Typed `interrupt` kind (one more alongside `handoff`) with its lifecycle (sent → acknowledged), ledger storage, and UI/agent rendering.
- `agent-onboarding`: The hub-pushed first-connect briefing — tool inventory, peer-addressing conventions, attachments path, and the current nutshell.
- `project-nutshell`: Ledger-backed living summary, handoff-gated edit approval, replay to newly connecting agents.

### Modified Capabilities
- `images-storage`: Extends to cover agent-written attachments (not just human uploads). The storage layer already handles this path; only the documentation + `post_file` tool integration is new. Rename scope to `attachment-storage` or keep the legacy name — design.md decides.
- `hub-request-safety`: Adds `post_file` route with body-size cap, extension allowlist reuse, and auth rules matching the existing `/upload` route. No changes to existing routes.

## Impact

**Code:**
- `hub/hub.ts` — new routes for `post_file`, tmux session metadata (hub doesn't own tmux, but tracks session names per agent), `interrupt` kind in the state machine, nutshell event kind.
- `hub/channel.ts` — register `post_file`, `send_interrupt` (maybe `send_interrupt`/`ack_interrupt`), `propose_nutshell_edit` tools; consume the onboarding briefing notification.
- `src-tauri/src/lib.rs` — bundle tmux binary under `src-tauri/resources/`, resolve its path at runtime, expose a Tauri command for the UI to attach to a named session.
- `ui/index.html` — bubble/avatar redesign, link copy-button component, right-pane xterm.js tab bar + per-session tab, interrupt card, nutshell viewer.
- New file: `hub/pty.ts` (or similar) — tmux orchestration helpers used by both hub and channel modes.

**APIs:**
- New MCP tools: `post_file(path|bytes, caption?)`, `send_interrupt(to, text)`, `ack_interrupt(id)`, `propose_nutshell_edit(patch, reason?)`.
- New HTTP routes: `POST /upload` extended to accept agent auth, `POST /interrupts`, `POST /interrupts/:id/ack`, `GET /interrupts?for=`, `GET /nutshell`, `POST /nutshell/edit` (accepts a handoff-style proposal).
- New SSE event kinds: `interrupt.new`, `interrupt.ack`, `nutshell.updated`.

**Dependencies:**
- Bundled tmux binary (~1–2 MB ARM64 static). BSD-licensed, added to `src-tauri/resources/` and to `install.sh`.
- `xterm.js` in the UI (CDN-free single file, ~230 KB). No bundler required.

**Bundle size:** approximately +1.5 MB (tmux) + 230 KB (xterm.js). Total app size ≈ 130 MB → ~132 MB. Acceptable.

**Out of scope (explicitly deferred):**
- Multi-room chat (PR #1).
- A2AChannel owning `claude` spawn/kill/crash-recovery end-to-end.
- Per-`(agentId, roomId)` session instancing.
- Cryptographic per-sidecar identity (still trust-on-self-assertion).
