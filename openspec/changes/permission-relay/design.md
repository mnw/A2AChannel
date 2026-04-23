## Context

v0.7 shipped the embedded terminal pane so a human could interact with claude's TUI without leaving A2AChannel. That fixes "see the agent's output"; it does not fix "unblock the agent." When claude requests approval for a `Bash` or `Write` call, the TUI prompt renders inside that agent's tab. The human must focus that exact tab and press Y/N. With more than two agents in a room, the accumulated wait becomes a coordination failure mode — the human is in Alice's tab discussing architecture while Bob silently hangs on a two-line tool approval.

Claude Code 2.1.81 introduced an MCP extension that relays these approval dialogs to any two-way channel that opts in. Request lifecycle: claude emits a `notifications/claude/channel/permission_request` with a request_id + metadata, stays open for answers from either the local terminal or the channel, applies the first answer to arrive, drops the other. chatbridge is already a two-way channel; the opt-in is a single capability declaration plus handler wiring.

This change routes those prompts through A2AChannel's hub so any participant with chat access can approve or deny from anywhere in the UI, without switching xterm tabs. Architecturally it's a new structured-message kind that mirrors the handoff/interrupt/nutshell pattern: ledger-backed, SSE-broadcast, version-reconciled, replayed on reconnect.

Current constraints:
- macOS ARM64 only.
- Vanilla HTML/CSS/JS in `ui/` (no framework, no bundler).
- Bearer-token auth on all hub routes; additive protocol changes only.
- SQLite ledger schema versioned; migrations additive.
- Trust-on-self-assertion: `by` fields on mutating routes are validated against expected actor but not cryptographically verified.

## Goals / Non-Goals

**Goals:**
- Route every Claude Code tool-use approval prompt through A2AChannel so the human can answer from the chat UI rather than being pinned to the originating xterm tab.
- Keep the local xterm dialog fully functional — first answer wins, no regression for users who want the traditional flow.
- Make any roster member (human or agent) capable of relaying a verdict via `ack_permission`, matching the handoff pattern where agents can accept/decline on their own.
- Preserve the structured-handoff/interrupt playbook: ledger event + derived row in one transaction, SSE broadcast with monotonic version, replay on reconnect, terminal-state idempotency (same-status retry → 200, different-status → 409).
- Ship additive; pre-v0.8 ledgers open cleanly, pre-2.1.81 claudes operate unchanged.

**Non-Goals:**
- Cryptographic verdict authorisation. Same trust model as the rest of the protocol.
- Permission policy rules (auto-allow certain tools, auto-deny dangerous commands). Plumbing first; policy later.
- Relay for non-tool dialogs (MCP server consent, project trust). Upstream explicitly excludes these.
- Cross-room scoping. Multi-room lands later; when it does, permission requests carry the sender's room attribute naturally.
- Any change to xterm pane rendering. The pane stays orthogonal.

## Decisions

### 1. Permission is a first-class structured-message kind

**Decision:** Treat `permission` as a peer to `handoff` and `interrupt` in the protocol:
- Its own `permissions` table in the ledger, keyed by the five-letter ID claude generates.
- Its own routes: `POST /permissions`, `POST /permissions/:id/verdict`, `GET /permissions`.
- Its own SSE event kinds: `permission.new`, `permission.resolved`.
- Its own MCP tool: `ack_permission`.
- Its own UI card type, with the same grid + state-badge + replay-badge structure as handoff/interrupt cards.

**Alternatives considered:**
- Reuse `interrupt` with a different subtype — rejected. Interrupts are cooperative signals; permissions are blocking authorisations. Lifecycle is identical on the surface (pending → resolved) but the semantic weight differs, and shoehorning them into the same table reintroduces the kind-discrimination overhead we've been avoiding.
- Reuse `handoff` — rejected. Handoffs have tasks, contexts, TTLs, accept/decline/cancel. Permissions have tool args, a behavior binary, and no sender choice over the recipient. Too many fields become N/A.

### 2. Verdict routing: who may answer

**Decision:** The human SHALL answer by default. Any agent with a valid bearer token MAY also submit a verdict via `ack_permission`. The hub accepts the first verdict to arrive (regardless of submitter), broadcasts `permission.resolved`, and the chatbridge relays it back to claude.

**Why allow agent verdicts:** matches the existing trust model (handoff accept is open to the recipient, and `cancel_handoff` to the sender or human). In multi-agent team setups where a `reviewer` agent is the designated approver for trivial reads, denying it the ability to ack makes the feature less useful than its precedent. An admin can deploy A2AChannel with a policy hook later if they want to restrict this.

**Alternatives considered:**
- Human-only verdicts — rejected. Breaks the symmetry with the rest of the protocol; forces every team-based review flow to route through one person. The coordination tax we're trying to remove comes back as "only the human can approve."
- Recipient-specific routing (agent's own session can self-approve) — rejected. Self-approval defeats the point of an approval dialog; claude wouldn't expose the request if self-approval were meaningful.

**Details:**
- `by` field on the verdict is validated against the hub's roster but not cryptographically bound. Same trust-on-self-assertion rule as elsewhere.
- The UI displays `resolved_by` on the card so the room can see who answered.

### 3. Local terminal dialog stays live

**Decision:** We do not disable claude's local terminal dialog. Both paths are live simultaneously; the first answer wins from the user's perspective.

**Why keep it live:** two reasons.
1. Users who are already focused on the xterm have the fastest path right in front of them; forcing them to switch to the chat UI would be a regression for the common case of one-agent-at-a-time.
2. The upstream protocol keeps it live by design; fighting that would require intercepting and suppressing dialogs, which is outside the claude-channel contract.

**Observed upstream behavior (verified in v0.8 testing, Claude Code 2.1.x):**
- **Chat-first answer** — chatbridge emits `notifications/claude/channel/permission` to claude, claude applies the verdict, claude's local dialog closes. Clean bidirectional mirror.
- **Xterm-first answer** — claude applies the verdict locally and proceeds with the tool call. Claude does NOT emit a reciprocal notification back through the channel. The hub's permission row stays `pending`, and the chat card keeps blinking.

**Consequence — ghost pending card.** In xterm-first mode, the chat UI has no way to know the approval has been resolved. The sticky card would otherwise linger forever (no TTL means ghosts survive hub restart and SSE reconnect).

**Fix shipped in v0.8 — explicit dismiss.** Permissions gain a fourth terminal state `dismissed` reachable via `POST /permissions/:id/dismiss`. Every pending card surfaces a small `×` button in the top-right that calls this route. Dismissing records an audit trail (`events.kind='permission.dismissed'`) but is distinct from `allowed`/`denied` — it documents "we stopped tracking" rather than fabricating a verdict. `behavior` stays `NULL` on dismissed rows.

Why dismiss rather than a forced Allow/Deny:
- An Allow click after the xterm already ran the tool would mislabel the audit log (the hub never actually allowed anything — claude did, locally).
- A Deny click would be worse (claims to have blocked a tool that already ran).
- Dismiss preserves the truth: "a permission was requested, the hub lost visibility, the human acknowledged the divergence."

**Future auto-dismiss.** An optional enhancement is for chatbridge to watch its own MCP transcript for tool-result messages bearing a `request_id` matching a pending permission, then auto-call dismiss. This reduces the manual-click burden but adds complexity and upstream fragility; deferred to post-v0.8.

The hub's `resolvePermission` is idempotent on same-status-retry, so if a future chatbridge version does relay the xterm-first verdict, the race resolves cleanly without modification to the verdict route.

### 4. Ledger schema v4 — add `permissions` table

**Decision:** Bump `LEDGER_SCHEMA_VERSION` to 4 (v3 was consumed by `claude_sessions` in v0.7). Add one table:

```sql
CREATE TABLE permissions (
  id              TEXT PRIMARY KEY,
  agent           TEXT    NOT NULL,
  tool_name       TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  input_preview   TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK(status IN ('pending','allowed','denied')),
  created_at_ms   INTEGER NOT NULL,
  resolved_at_ms  INTEGER,
  resolved_by     TEXT,
  behavior        TEXT    CHECK(behavior IS NULL OR behavior IN ('allow','deny'))
);
CREATE INDEX idx_permissions_status ON permissions(status, created_at_ms);
CREATE INDEX idx_permissions_agent  ON permissions(agent, status);
```

Events continue to land in the existing `events` table (the `handoff_id` column is reused as a generic entity id — already the case since v0.6's interrupt migration).

**Alternatives considered:**
- Shared table `messages` with a discriminator — rejected. Keeps migrations simple and matches the existing pattern; other kinds are already in their own tables.
- In-memory only (no ledger) — rejected. Pending permissions on reconnect need to replay, same as handoffs. Without persistence, a hub restart mid-approval would orphan an agent waiting on an answer.

**Details:**
- `id` is claude's own request_id: five lowercase letters drawn from `a-z` excluding `l`. We don't generate it; we store the value claude sends.
- Status is one of three terminal states — same pattern as handoffs (accepted/declined/cancelled) minus the cancel path (permissions have no sender-side withdraw; claude's local timeout is what expires them).
- `behavior` mirrors `status` in the accepted/denied cases: `status='allowed' ↔ behavior='allow'` and `status='denied' ↔ behavior='deny'`. Redundant but matches the upstream verdict schema and simplifies the event payload.

### 5. Request body size cap: 16 KiB

**Decision:** `POST /permissions` uses a new `PERMISSION_BODY_MAX = 16_384` byte cap, enforced by `requireJsonBody(req, 16_384)`. Description and input_preview are bounded upstream (description is Claude's single-line summary; input_preview is truncated to 200 chars). 16 KiB leaves 15+ KiB of headroom and rejects any wild payload cheaply.

**Alternatives considered:**
- Default 256 KiB cap (same as `/send`, `/post`) — rejected. Unnecessarily wide for bounded fields; gives attackers more room to force hub CPU on JSON parsing.
- 1 MiB (same as `/handoffs`) — rejected. Handoffs carry structured context up to 1 MiB by spec; permissions have no equivalent payload.

### 6. No TTL / auto-expiry on permissions

**Decision:** Permissions have no TTL. Claude Code holds the local dialog open until answered; our hub holds the pending row open for the same duration. When the agent session ends (claude exits), the chatbridge disconnects and the pending row stays in the ledger as `pending` — same treatment as an orphaned handoff, which we also don't auto-expire beyond the TTL on the handoff itself.

**Alternatives considered:**
- 5-minute TTL with auto-deny — rejected. Auto-denying a Bash call the user actually wanted is annoying; auto-allowing is security-violating. There's no safe default.
- Auto-resolve to `denied` when the agent goes offline — rejected. The claude process has its own timeout; if the process exits, the request was implicitly denied anyway (no one receives the verdict). The ledger row is useful as history, but not as a state we need to sweep.

**Details:**
- A v0.9 feature could add policy-driven timeouts per-tool (e.g., auto-deny if `Read` isn't answered in 30 min, auto-allow if... nothing). Out of scope here.

### 7. UI card shape — stacked at top, red-accented

**Decision:** Permission cards render at the top of `#messages`, above any pending interrupts, with a red left-border stripe and a blinking border animation while pending — identical visual treatment to interrupt cards with one additional field line. Resolved cards transition to an inert state (grey stripe, no animation) and drop back into the chat timeline at their original chronological position.

**Alternatives considered:**
- Separate "Pending Approvals" panel / header badge — rejected. Divides attention; the chat is where the human already is. Keep the thing to do visible in the thread.
- Modal dialog — rejected. Blocks the UI, can't interact with other agents while one is pending, and doesn't handle multiple concurrent requests gracefully.

**Details:**
- Grid layout: `tool_name` + `status-badge` header; `description` body; `input_preview` in a monospace block; Allow/Deny buttons on the right.
- The card is version-reconciled by `(id, max-version-seen)` like handoffs and interrupts.
- Multiple pending permissions stack in arrival order, newest at top of the pending block.

### 8. `ack_permission` MCP tool

**Decision:** New MCP tool on chatbridge:

```
ack_permission({
  request_id: string (pattern /^[a-km-z]{5}$/i),
  behavior:   "allow" | "deny"
})
```

**Alternatives considered:**
- Single-string verdict format (`"yes abcde"` / `"no abcde"`) like the webhook reference example — rejected. The tool signature is clearer and more validator-friendly; pattern-matching the phone-autocorrect-tolerant format is for tools that receive text from humans on external platforms, not for MCP-tool calls from an agent in the same process tree.
- Expose as `send_handoff` with a special task prefix — rejected. Same reasoning as Decision 1: protocol purity matters for readability.

**Details:**
- Tool handler POSTs to `/permissions/:id/verdict` with `{ by: AGENT, behavior }`.
- Validation mirrors `accept_handoff` / `decline_handoff` shape: structured idempotent response, 409 on mismatch, 404 on missing id.

## Risks / Trade-offs

**[Risk] Agent ack authority.** Allowing any bearer-token-holder to submit a verdict matches the existing trust model but means a compromised channel-bin could silently approve everything. Mitigation: documented in `hub-request-safety` as same-trust-surface; users with sensitive threat models should restrict `ack_permission` via a future per-tool policy.

**[Risk] Race between local dialog and chat verdict.** Both paths accept input simultaneously. The hub's `resolvePermission` transaction is a single SQL update guarded by a status check; second-caller gets 409 cleanly. Chatbridge handles 409 by treating it as "user already answered elsewhere — we're too late" and logging at info level, not error. Mitigation: testing matrix explicitly covers local-answer-first and chat-answer-first ordering.

**[Risk] Hub restart with pending permission.** Agent's claude is still waiting on its local dialog; chatbridge will reconnect and replay pending permissions (same mechanism as handoffs/interrupts). If the hub restart happened between request-ack and verdict-emit, the agent might see the same request twice. Mitigation: chatbridge de-dupes by request_id in a short in-memory window; claude itself also de-dupes on request_id match.

**[Risk] Pending permission UI clutter.** With many agents all hitting approvals, the chat header stacks up. Mitigation: optional "N pending" collapse chip in the header (referenced in proposal; deferred if scope creeps). Multiple pending cards are still bounded by the number of concurrent agents times claude's per-session approval frequency, which is small.

**[Risk] Pre-2.1.81 claude silently ignores capability.** Users on older Claude Code won't get relay. No error surface; the feature just doesn't activate. Mitigation: document the version requirement in README + CLAUDE.md; chatbridge logs "permission relay inactive — Claude Code 2.1.81+ required" when it detects a pre-relay claude at startup (hard to detect cleanly; may skip this).

**[Risk] MCP server consent dialogs don't relay.** Upstream limitation. First-launch "trust this MCP server?" prompts still gate on the xterm. Mitigation: document; in practice these fire once per project and the human is typically at the xterm for first launch anyway.

**[Trade-off] Always-live local dialog.** We chose to keep claude's xterm prompt functional rather than suppress it for a cleaner "single source of truth" story. Tradeoff: duplicated UX (same prompt shown in two places). The upstream-protocol-compliant answer is what we have; fighting it would be architecturally worse than accepting the minor redundancy.

## Migration Plan

- **Users on v0.7.x:** no migration needed. Relaunch A2AChannel; ledger auto-migrates to v3 on first open. Agents relaunched under v0.8 get the capability automatically via chatbridge.
- **Claude Code < 2.1.81:** no change — capability ignored. Local dialog continues to be the only path.
- **Rollback to v0.7.x:** safe. The `permissions` table stays in the ledger (v0.7 code doesn't read it); no data loss. Chatbridge running as v0.7 simply doesn't declare the capability.
- **MCP protocol:** new tool (`ack_permission`) added. Other tools unchanged. Agents discover it via `tools/list`.
- **No bundle-size delta worth flagging.**

## Open Questions

1. **Pending-count badge in header?** The proposal mentions a "3 agents waiting" chip near the header as UX polish. Recommend: include in v0.8 — it's 10 lines of JS and catches the "I didn't see the card scroll past" case. Alternatively deferred to a follow-up if scope tightens. (Partially addressed in v0.8 via sticky-at-top card behavior — ghosts aside.)
2. **Should `ack_permission` require the agent to be the recipient of the original request?** Current decision: no, any agent can answer for any other. Rationale: matches cancel-handoff-by-any-party symmetry. If this proves risky, tighten in v0.9.
3. **`--channels plugin:chatbridge@...` parallel track.** If we get chatbridge onto Anthropic's approved allowlist, the `--dangerously-load-development-channels` flag goes away and the "server:chatbridge · no MCP server configured with that name" warning follows. Independent of this change; not a prerequisite. Flag for v0.9 work.
4. **Per-tool policy hook (v0.9).** Auto-allow `Read`, auto-deny dangerous `Bash`. Scope: separate feature, not blocking. Need a rule DSL or config entries. Out of this proposal.
5. **Auto-dismiss ghost cards (post-v0.8).** Manual dismiss via `×` button shipped in v0.8. A follow-up enhancement: chatbridge watches its own MCP transcript for tool-result messages whose `request_id` matches a pending permission, then auto-POSTs to `/permissions/:id/dismiss`. Reduces manual-click burden but adds fragility on Claude Code's output format; defer until real-world usage tells us the manual path isn't enough.
6. **`events.handoff_id` column name is misleading.** Since v0.6 it's served as the generic entity id for handoffs, interrupts, and now permissions — namespace-safe (prefixes `h_`, `i_`, 5-letter plain) but the column name is a misnomer. Rename to `entity_id` in a future migration; not worth it this release.
7. **Reconnect replay fan-out cost.** With N agents reconnecting and M pending permissions, the hub emits N×M replay events. Bounded by the `limit: 1000` cap so the worst case stays sane, but at very large room sizes this becomes noise. Not actionable at current scale; revisit when a customer hits it.
