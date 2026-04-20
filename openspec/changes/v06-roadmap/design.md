## Context

v0.5.0 shipped the coordination layer (typed handoffs, SQLite ledger, security hardening, attachment allowlist). An external contributor (PR #1) surfaced real workflow gaps — the human can't send slash commands, can't answer interactive permission prompts, can't observe raw agent output — and proposed a PTY-owned rewrite. That rewrite is an overcommit; the gaps are real but addressable with a smaller intervention.

This change groups six improvements that together raise the coordination workspace to a more useful day-to-day tool while keeping the "A2AChannel is an MCP-based coordination layer on top of user-managed sessions" positioning intact. Items are ordered by compounding value — UI polish first because everything else benefits, terminal pane early because it unblocks observability, deeper protocol additions (interrupt, nutshell) last because they require stabler UI around them.

Current constraints:
- macOS ARM64 only.
- Vanilla HTML/CSS/JS in `ui/` — no framework, no bundler.
- Bun-compiled `a2a-bin` dispatches hub and channel modes from one binary.
- Bundle size ceiling is informal but should stay under ~150 MB.

## Goals / Non-Goals

**Goals:**
- Close the top three observability gaps (raw output, slash commands, permission prompts) without owning Claude's lifecycle.
- Make agents first-class authors of attachments, not just consumers.
- Reduce per-team onboarding friction (new-agent briefing, shared project nutshell).
- Ship visual polish that makes the product demo-able to non-technical users.
- Keep all additions strictly incremental on top of the existing hub / channel / ledger architecture.

**Non-Goals:**
- Multi-room chat (PR #1). Deferred.
- A2AChannel spawning / managing the `claude` process lifecycle end-to-end. tmux is a deliberate indirection that lets users retain control.
- Cryptographic per-sidecar identity. Still trust-on-self-assertion.
- Windows / Linux / Intel Mac support.
- Real-time multi-cursor or live collaborative editing of the nutshell.

## Decisions

### 1. UI polish — no framework, no bundler

**Decision:** Extend the existing `ui/index.html` with additional CSS and minimal JS. Use Catppuccin palette CSS variables already in `:root`. No Tailwind, no React, no build step.

**Alternatives considered:**
- Tailwind (rejected — CDN is not-for-production, build step violates the repo's no-framework rule, and the delta is ~150 lines of plain CSS that's no faster to write as utility classes).
- Shoelace / similar component library (rejected — adds a dep for work that's trivial in vanilla).

**Details:**
- `.msg` layout gets a `flex-direction: row-reverse` variant for `from-<HUMAN>` rows.
- Circular avatar element (`.msg-avatar`) with `background: COLORS[name]` and `textContent = name[0].toUpperCase()` built in `addMessage()`.
- Bubble backgrounds via existing `shade()` helper (colors already derived per agent).
- Link rendering: `linkify()` output gets wrapped in `<a class="msg-link">` + a sibling `<button class="msg-link-copy">📋</button>`. Delegated click handler on `messagesEl` copies `href` to `navigator.clipboard`. `msg-link` color uses `var(--ctp-sky)` (lighter than `var(--ctp-blue)` used for bold elements).

### 2. `post_file` tool and route

**Decision:** Reuse the existing `/upload` route with a new auth surface (agent Bearer token works the same way as the UI's). Add an MCP tool `post_file` that takes a local filesystem path (agent-side), streams the bytes to `/upload`, and then calls `/post` with the returned `/image/...` URL as the attachment.

**Alternatives considered:**
- Separate route `/attachments` (rejected — same semantics, more surface area).
- Agent writes directly to `attachments_dir` via filesystem (rejected — breaks the hub's ownership of the storage abstraction and bypasses chmod-0600 invariants).

**Details:**
- Tool signature: `post_file(path: string, to?: string, caption?: string, room?: string)`.
- Channel-side implementation reads `path` from disk (agent's filesystem), POSTs multipart to `/upload`, then POSTs `/post` with `{from, to, text: caption ?? "", image: url, room}`.
- Extension allowlist from `config.json` applies exactly as today — no per-tool override.
- Size cap 8 MiB same as human uploads.
- On `/upload` failure, surface the hub's error message to the tool caller (propagates extension-rejection, size-rejection etc.).

### 3. Terminal projection via tmux

**Decision:** Bundle a static tmux binary under `src-tauri/resources/`. `a2a-bin` gains a new mode (`A2A_MODE=pty`) that orchestrates tmux sessions: spawn `tmux new-session -d -s <agentId> -s <cwd> claude --dangerously-load-development-channels`, list active sessions, attach via tmux control-mode and stream bytes over Tauri events to the webview. UI renders with `xterm.js`.

**Alternatives considered:**
- Custom PTY wrapper in Rust/Go (rejected — reimplements session continuity, which is tmux's killer feature).
- Require users to install tmux (rejected — adds setup friction, version drift).
- Agent-owned session spawn (rejected — breaks the "user retains control of their claude sessions" property).

**Details:**
- **Binary sourcing:** Build tmux 3.5a statically linked for `aarch64-apple-darwin` once; check in the binary under `src-tauri/resources/tmux`. Document the build command in `scripts/build-tmux.sh` for reproducibility.
- **Session naming:** one session per agent, name = agent name (validated against `AGENT_NAME_RE`). The user can still `tmux attach -t <agent>` from their own terminal via the bundled tmux's socket; expose the socket path as `~/.config/A2AChannel/tmux.sock` and document.
- **Control mode:** The webview-side pane uses `tmux -C attach-session -t <agent>` over a child process (IPC via Tauri shell plugin); parse `%output` blocks into `xterm.js`. `send-keys` for stdin from the pane.
- **Race between user terminal and webview pane:** Accept tmux's native multi-client behavior — both clients can type; document that the user should only use one at a time when running interactive prompts. Not solving with an ownership toggle in v0.6.
- **Lifecycle:** A2AChannel does NOT kill sessions on app quit. tmux sessions detach and persist. A2AChannel reattaches on next launch. Explicit "kill session" button in UI (per-tab) for the user to tear down.
- **Session discovery on app launch:** `tmux -S <sock> list-sessions` gives the current set; populate the right-pane tab bar from that list.
- **xterm.js sourcing:** Single-file ESM from GitHub releases, checked in under `ui/vendor/xterm.js`. No CDN.

### 4. Interrupt / attention flag

**Decision:** A new ledger event kind `interrupt` following the same pattern as `handoff`. Schema: `{id, from, to, text, status: "pending" | "acknowledged", created_at_ms, acknowledged_at_ms}`. Lifecycle: pending → acknowledged (terminal). No decline, no cancel (for v0.6 — interrupts are unilateral by design; if the sender wants to retract they can send a follow-up).

**Alternatives considered:**
- Reuse `post` with a special `urgent: true` flag (rejected — the point is protocol-level semantics so the agent's system prompt can teach it "interrupt means stop and re-read," which requires a typed signal).
- Reuse `handoff` with `task: "read this"` (rejected — conflates work transfer with attention interruption).

**Details:**
- Agent-side tool: `ack_interrupt(interrupt_id)`. `send_interrupt(to, text)` available to agents and the human (latter via UI).
- MCP notification to the recipient carries `kind="interrupt.new"` and `text`; the agent's system prompt (delivered via onboarding briefing, see #5) instructs: "when you receive an interrupt, stop current work, acknowledge it, and read the text before continuing."
- UI render: larger card than handoffs, red-ish accent, persistent until acknowledged.
- Does NOT actually pause the agent's LLM turn — that's not something the hub can do. The agent's behavior is guided by the system-prompt instruction. We just make the signal impossible to miss.

### 5. Onboarding briefing on agent connect

**Decision:** Hub detects first `/agent-stream` connection for a given agent name (tracked via `agentConnections` map going 0 → 1 combined with a "has-connected-before" flag persisted in-memory per session) and pushes a `briefing` notification as the first event on that agent's queue. Briefing contents: tool list, peer-addressing, attachments path, current nutshell (from #6).

**Alternatives considered:**
- Require users to copy a canonical system prompt into each `.mcp.json` (rejected — exactly the boilerplate we're trying to eliminate).
- Ship a static template rendered by the UI's MCP config generator (partial solution — doesn't cover runtime-dependent info like current nutshell or active agents).

**Details:**
- Hub emits to the agent's queue: `{type: "briefing", tools: [...], peers: [...], attachments_dir: "/abs/path", nutshell: "..." | null, ts}`.
- channel.ts receives the briefing as its first inbound event and translates it into a `notifications/claude/channel` notification with kind=`briefing` so it lands in the agent's context as a `<channel kind="briefing">` tag.
- Session-scoped, not persistent per-agent — reconnect triggers a fresh briefing. Cheap; just re-read live state.

### 6. Project nutshell

**Decision:** Single-row table `nutshell` in the SQLite ledger: `{text TEXT, version INTEGER, updated_at_ms INTEGER, updated_by TEXT}`. Edits are proposed via a new handoff kind `handoff.nutshell_edit` — the proposal carries the new text in `context.patch`; acceptance applies the patch atomically; decline / expire leaves the nutshell unchanged.

**Alternatives considered:**
- Free-for-all edits (any agent can write any time) — rejected, defeats the "agreed reference point" intent.
- Dedicated voting protocol — rejected, over-engineered for v0.6. The existing handoff primitive is good enough: one agent proposes, recipients (human + other agents) accept or decline.

**Details:**
- Handoff `to` must be `HUMAN_NAME` for nutshell edits (v0.6 simplification — human is the canonical arbiter; revisit if it's too centralized).
- On handoff accept: hub atomically writes new `text`, increments `version`, emits `nutshell.updated` SSE event.
- UI: a small pinned pane (top of chat, collapsible) showing the current nutshell, with a "propose edit" button that opens a textarea and fires `send_handoff(to=human, task="nutshell edit", context={patch: "..."})`.
- Briefing in #5 includes `nutshell.text` verbatim (not a summary — it's already a nutshell).

### Bundling decisions

- **tmux:** single static binary per arch. Build recipe in `scripts/build-tmux.sh`; output goes under `src-tauri/resources/`. Tauri bundler already copies resources.
- **xterm.js:** single-file ESM under `ui/vendor/xterm.js` and `ui/vendor/xterm.css`. Checked into git. No npm install needed.

## Risks / Trade-offs

**[Risk] tmux version drift / CVEs** → Mitigation: document the exact tmux version in `scripts/build-tmux.sh`; audit CVE list at release time; plan a rebuild cadence (on major A2AChannel releases or when a CVE affects the bundled version).

**[Risk] tmux `send-keys` / control-mode interface isn't a stable ABI** → Mitigation: scope the integration narrowly to `new-session`, `list-sessions`, `attach -C`, `send-keys`, `kill-session`. Avoid fancier features (panes, windows) that change between versions. If tmux's control-mode output format changes, update our parser.

**[Risk] Multi-client typing races (user's terminal + webview pane simultaneously)** → Mitigation: document in README that interactive prompts should be answered from one client at a time. If it becomes a real problem, add an ownership-toggle UI in v0.7.

**[Risk] Bundled tmux adds ~1.5 MB and a foreign binary to the signed bundle** → Mitigation: ad-hoc signing already covers this (no separate notarization needed). Size delta is negligible against the 60 MB Bun runtime.

**[Risk] `post_file` from agent opens a path-traversal surface** → Mitigation: Agent reads its OWN filesystem and POSTs bytes — the hub never sees a path. Same validation as human uploads (extension allowlist, size cap). No new attack surface on the hub.

**[Risk] Nutshell becomes a bottleneck if every edit requires human accept** → Mitigation: document as an intentional v0.6 constraint. If it becomes painful, v0.7 can add a "delegate nutshell approval" flag per room/project.

**[Risk] Interrupt semantics depend on the agent honoring the system-prompt instruction** → Mitigation: explicit, honest — the README and the briefing both say interrupts are a coordination primitive, not a hard preemption. An agent that ignores them will ignore them. Acceptable for a cooperation-oriented tool.

**[Risk] Onboarding briefing bloats the agent's context on every reconnect** → Mitigation: briefing is small (tool list ~200 tokens, nutshell typically <1 KB, peers <100 tokens). Reconnects are infrequent. Not a cost center.

**[Trade-off]** Shipping six items in one change vs. six separate changes. Grouping them lets us ship a coherent v0.6 without interleaving release versioning — but also means one stuck item blocks the release. Tasks.md orders items so each can ship standalone if needed; the change can be partially archived if scope shifts.

## Migration Plan

- **Users on v0.5.x:** no migration needed. New features are additive.
- **Config changes:** none. `config.json` schema unchanged.
- **Ledger schema:** `nutshell` table added (schema_version bump 1 → 2). Migration is idempotent; existing ledgers auto-migrate on first v0.6 open. `interrupts` table also added in the same migration step.
- **MCP protocol:** new tools (`post_file`, `send_interrupt`, `ack_interrupt`) added. Existing tools unchanged. channel.ts advertises them; agents see them via `tools/list`.
- **Bundle:** tmux binary ships inside the `.app`. Install.sh gains no new step — Tauri's resource bundling handles it.
- **Rollback:** downgrade to v0.5.x works as long as the ledger's `schema_version` still reads. Since the v0.6 migration only adds tables (never modifies or drops), v0.5 opens the same ledger cleanly (it just ignores the new tables). Nutshell + interrupt state is lost on rollback but chat and handoffs survive.

## Open Questions

1. **Should the terminal pane be always-visible or opt-in?** Always-visible makes it feel like a core feature; opt-in keeps the simpler chat UI for users who don't want it. Recommend: opt-in toggle in header, persisted to localStorage.
2. **Nutshell edit approval — just the human, or any two peers can ratify?** v0.6 says "human only" for simplicity. Revisit if team size grows.
3. **xterm.js theming to match Catppuccin Mocha** — straightforward with the xterm.js theme API but needs a bit of CSS plumbing. Call it out in tasks.md.
4. **Per-session tmux socket vs. one shared socket** — one shared socket is simpler (all sessions listed together), per-session is more isolated. Recommend: one shared socket at `~/.config/A2AChannel/tmux.sock`.
