## 1. Ledger schema v4

> Note: schema v3 was consumed during v0.7 by the `claude_sessions` migration. Permissions target v4.

- [x] 1.1 Bump `LEDGER_SCHEMA_VERSION` to 4 in `hub/hub.ts`.
- [x] 1.2 Add the `permissions` table migration in `migrateLedger`, inside a `db.transaction`:
  ```sql
  CREATE TABLE permissions (
    id TEXT PRIMARY KEY, agent TEXT NOT NULL, tool_name TEXT NOT NULL,
    description TEXT NOT NULL, input_preview TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','allowed','denied')),
    created_at_ms INTEGER NOT NULL, resolved_at_ms INTEGER,
    resolved_by TEXT,
    behavior TEXT CHECK(behavior IS NULL OR behavior IN ('allow','deny'))
  );
  CREATE INDEX idx_permissions_status ON permissions(status, created_at_ms);
  CREATE INDEX idx_permissions_agent  ON permissions(agent, status);
  ```
  Update `meta.schema_version` to `4` inside the same transaction.
- [x] 1.3 Verify downgrade protection: `migrateLedger` throws if `current > LEDGER_SCHEMA_VERSION` (existing behavior; confirm it still fires when a v0.8 ledger is opened by v0.7 code). Existing `if (current > LEDGER_SCHEMA_VERSION) throw` at lines 204-207 covers it.
- [ ] 1.4 Smoke-test idempotency: running v0.8 against a fresh ledger and then against an existing v0.7 ledger both end with `schema_version=4` and no duplicate tables. _(deferred to §8 testing matrix.)_

## 2. Hub state machine

- [x] 2.1 Add `PermissionStatus = 'pending' | 'allowed' | 'denied'` type alias and `PermissionSnapshot` / `PermissionRow` types alongside the existing `HandoffSnapshot` / `InterruptSnapshot`.
- [x] 2.2 `PERMISSION_ID_RE = /^[a-km-z]{5}$/i` — validate request_id shape (lowercase letters a–z excluding `l`, 5 chars). Use this regex in route handlers; claude generates compatible ids.
- [x] 2.3 Implement `createPermission(input: { agent, request_id, tool_name, description, input_preview })` — inserts an `events` row with kind `permission.new` and a `permissions` row, in one `db.transaction`. Returns a `PermissionCreateOutcome` with `created | idempotent | conflict` kinds. Same-id replay while pending → idempotent; same id already resolved → conflict.
- [x] 2.4 Implement `resolvePermission(id, by, behavior)` returning `PermissionOutcome` with kinds `transition | idempotent | conflict | not_found`. Same-status retry → idempotent; different-status retry → conflict; missing id → not_found. Terminal-state policy matches handoffs.
- [x] 2.5 Implement `snapshotPermission(id)` and `loadPermission(id)` mirroring handoff/interrupt helpers.
- [x] 2.6 Implement `listPermissions({ status, for: agent, limit })` with the same shape as `listHandoffs` / `listInterrupts`. Default status `pending`, limit clamped to 1–1000.

## 3. Hub HTTP routes

- [x] 3.1 Add `PERMISSION_BODY_MAX = 16_384` constant near the other body caps.
- [x] 3.2 Route `POST /permissions` → `handleCreatePermission(req)`:
  - requireAuth, requireJsonBody(req, PERMISSION_BODY_MAX).
  - Parse `{ agent, request_id, tool_name, description, input_preview }`, validate all present.
  - `validName(agent)` check; `PERMISSION_ID_RE.test(request_id)` check.
  - Call `createPermission`; same-id-while-pending → idempotent 200; same-id-already-resolved → 409; otherwise 201 with `{ id, snapshot }`.
  - Broadcast `permission.new` via `broadcastPermission(snapshot, "permission.new")`.
- [x] 3.3 Route `POST /permissions/:id/verdict` → `handleResolvePermission(id, req)`:
  - requireAuth, requireJsonBody(req).
  - Parse `{ by, behavior }`, `validName(by)`, `behavior in {allow, deny}`.
  - Call `resolvePermission`; map outcome via a shared `permissionOutcomeResponse` helper (200/200 idempotent/409/404).
  - Broadcast `permission.resolved` on transitions.
- [x] 3.4 Route `GET /permissions` → `handleListPermissions(req)` with readAuth, optional `status`/`for`/`limit` query params.
- [x] 3.5 Wire all three routes into the main `Bun.serve` switch in `hub.ts`. Match the exact pattern used for `/handoffs` and `/interrupts`.

## 4. Hub SSE broadcasts

- [x] 4.1 Implement `permissionEntry(snapshot, eventKind, replay=false)` producing the SSE payload shape: `{ from: agent, to: 'all', text: JSON.stringify(snapshot), ts, image: null, kind, permission_id: snapshot.id, version, replay, snapshot }`. Kind is `permission.new` or `permission.resolved`.
- [x] 4.2 Implement `broadcastPermission(snapshot, eventKind)` — calls `broadcastUI(entry)` plus pushes to the requesting agent's queue so chatbridge can relay verdicts back.
- [x] 4.3 Replay path: in `handleAgentStream`, after existing handoff+interrupt replays, add `for (const snapshot of pendingPermissionsFor(agent)) send(permissionEntry(snapshot, "permission.new", replay=true))`.
- [x] 4.4 UI replay path: permissions go through `broadcastUI` → land in `chatLog` → replay via `handleStream`'s existing chat-history replay using `lastId`. Dedicated `listPermissions` pass not needed on `/stream` connect; UI bootstrap fallback (§6.7) covers first-load state.

## 5. chatbridge (channel.ts) — capability + handler + tool

- [x] 5.1 Add `'claude/channel/permission': {}` to the `Server` constructor's `capabilities.experimental` map alongside `claude/channel`.
- [x] 5.2 Install a Zod validator and notification handler for `notifications/claude/channel/permission_request`:
  ```ts
  const PermissionRequestSchema = z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string().regex(/^[a-km-z]{5}$/i),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  });
  mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    await authedPost('/permissions', { agent: AGENT, ...params });
  });
  ```
- [x] 5.3 In `tailHub`, recognize `kind: "permission.new"` and `kind: "permission.resolved"`; pass to mcp.notification as `<channel>` events like handoffs/interrupts do. On `permission.resolved`, also emit `notifications/claude/channel/permission` upstream with `{ request_id: evt.permission_id, behavior: evt.snapshot.behavior }`.
- [x] 5.4 Register MCP tool `ack_permission` in the `ListToolsRequestSchema` response:
  ```ts
  {
    name: "ack_permission",
    description: "Submit a verdict on a pending permission request. Allow or deny.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", pattern: "^[a-km-z]{5}$" },
        behavior: { enum: ["allow", "deny"] },
      },
      required: ["request_id", "behavior"],
    },
  }
  ```
- [x] 5.5 Handle `ack_permission` in the `CallToolRequestSchema` dispatcher — POST to `/permissions/:request_id/verdict` with `{ by: AGENT, behavior }`. Propagate hub error bodies back to the tool caller via `toolError`.

## 6. UI — permission cards

- [x] 6.1 Add the permission state: `const permissionCards = new Map()` (id → `{ element, version, status, snapshot }`) alongside `handoffCards` and `interruptCards` in `ui/main.js`.
- [x] 6.2 In `handleEvent`, branch on `kind.startsWith('permission.')` → `renderPermissionCard(event)` (same dispatch shape as handoff/interrupt).
- [x] 6.3 Implement `renderPermissionCard(event)` with the lifecycle: insert pending cards at top of `#messages`, version-reconcile, transition resolved cards out of sticky positioning.
- [x] 6.4 Implement `buildPermissionCardDom(snapshot, event)` — grid layout with header (agent/tool_name/status/replay badges), description body, input_preview in `<pre>` block, Allow/Deny buttons for pending status.
- [x] 6.5 Implement `handlePermissionAction(id, action)` → POST `/permissions/:id/verdict` with `{ by: HUMAN_NAME, behavior: action }`. On success rely on the `permission.resolved` SSE event for reconciliation; on error surface via the existing `system` message rendering.
- [x] 6.6 Add CSS for `.permission-card` in `ui/style.css`. Mirrors `.interrupt-card` — red accent, blinking pending border via `@keyframes blink-border`, sticky-at-top positioning while pending, inert + grey/green when resolved. Includes `.permission-input-preview` styling for the monospace block.
- [x] 6.7 Bootstrap: add `loadPendingPermissions()` called from `bootstrap()`; GET `/permissions?status=pending&limit=500` and render each as a `permission.new` event.

## 7. Sender gating recheck + hard rules

- [x] 7.1 Add a hard rule to CLAUDE.md: `claude/channel/permission` capability gated on bearer-token auth.
- [x] 7.2 Add a hard rule to CLAUDE.md: no TTL / auto-expiry on permissions.
- [x] 7.3 Verified: `requireAuth` wraps `POST /permissions` and `POST /permissions/:id/verdict`; `requireReadAuth` wraps `GET /permissions`. Pattern matches handoff/interrupt routes. Existing `CLAUDE.md` line "Hub endpoints require auth" covers the route family by construction.

## 8. Testing matrix

- [x] 8.1 Hub-side unit smoke (curl against `bun run hub/hub.ts`): create pending permission, verify 201 + `snapshot.status=pending` + broadcast fires. 14/14 route assertions pass (auth, validation, create, list, idempotent-pending, invalid-behavior, transition, idempotent-resolved, different-verdict-409, duplicate-create-409, not-found-404, list-allowed, body-size-413, token-as-query-param).
- [ ] 8.2 Integration: real claude spawning a `Bash` approval. Verify the UI card appears, clicking Allow resolves the request, claude proceeds, xterm's local dialog closes. _(interactive — deferred to user smoke.)_
- [x] 8.3 Race: local xterm answered first. **Actual behavior:** Claude Code applies the xterm verdict locally but does NOT emit a reciprocal channel notification, so the hub row stays `pending` (ghost card). **Fix shipped:** `POST /permissions/:id/dismiss` + `×` button on pending cards. Dismissed rows record `status="dismissed"` with `behavior=NULL` — preserves audit truth (hub never actually saw a verdict). Ledger bumped to schema v5 with the expanded CHECK constraint.
- [ ] 8.4 Race: chat-first answer, concurrent xterm press. Verify both paths converge on the same verdict; second arrival returns idempotent 200. _(interactive — deferred; same-verdict idempotency proven in 8.1.)_
- [x] 8.5 Different-verdict conflict (curl): `allow` then `deny` on the same request → second arrival returns 409 with the current snapshot. Verified in 8.1 matrix.
- [ ] 8.6 Reconnect replay with real chatbridge. _(interactive — deferred. Hub-side replay proven: `GET /agent-stream?agent=alice` emits `permission.new replay=true` for pending rows.)_
- [ ] 8.7 Agent-ack cross-role with real claudes. _(interactive — deferred. `ack_permission` → `POST /permissions/:id/verdict` with `by: AGENT` proven in 8.1.)_
- [ ] 8.8 Pre-2.1.81 compat. _(interactive — deferred; capability is additive, Claude Code silently ignores unknown capability keys.)_
- [x] 8.9 Ledger migration: opened a seeded v3 ledger (simulating v0.7 state with handoffs/interrupts/nutshell/claude_sessions) under v0.8 → applied migration v4, `schema_version=4`, existing handoff rows preserved, `permissions` table created with the documented schema. Downgrade guard fires when `schema_version > LEDGER_SCHEMA_VERSION` (verified by injecting `schema_version=5` and watching `ledger open failed: refusing to downgrade`).

## 9. Docs

- [x] 9.1 Extended `docs/PROTOCOL.md` with a "permission kind" section: snapshot schema, HTTP routes, MCP tools, MCP capability declaration, terminal-state policy table, SSE events, trust semantics.
- [x] 9.2 README: added a "Permission relay — `ack_permission`" subsection under the primitives list, plus Claude Code 2.1.81 version note. Bumped tagline and "Three → Four primitives" heading.
- [ ] 9.3 "What's new in v0.8" block: no existing "What's new" block in README — release notes will live in the GitHub release body (step 10.4). Deferred to release.

## 9b. Dismiss primitive (v0.8 late-add)

- [x] 9b.1 Ledger schema v5: expand `permissions.status` CHECK to include `'dismissed'` via copy-drop-rename (SQLite can't ALTER a CHECK constraint in place).
- [x] 9b.2 Hub: `dismissPermission(id, by)` transitions `pending → dismissed` in one tx (events row + update). Same-status retry → idempotent; non-pending non-dismissed → conflict.
- [x] 9b.3 Hub: `POST /permissions/:id/dismiss` route with bearer auth + 16 KiB body cap.
- [x] 9b.4 Hub: broadcast `permission.dismissed` event on transition.
- [x] 9b.5 chatbridge: no upstream relay on `permission.dismissed` (nothing to tell claude — it already acted).
- [x] 9b.6 UI: `×` dismiss button on pending cards; `handlePermissionDismiss(id)` calls the route.
- [x] 9b.7 CSS: `.permission-card.status-dismissed` renders grey/dim; `.permission-dismiss` button styled in header.
- [x] 9b.8 Docs: `PROTOCOL.md` + README + specs updated to reflect the new terminal state.

## 10. Release

- [x] 10.1 Bumped version to `0.8.0` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `hub/channel.ts` server version string.
- [ ] 10.2 Run `./scripts/install.sh` for a clean install. _(user-run — writes to /Applications/A2AChannel.app)_
- [ ] 10.3 Run the §8 test matrix against the installed build. Log results in the release notes. _(user-run — needs real claude processes)_
- [ ] 10.4 Git tag `v0.8.0`, push, create GitHub release with DMG + `.app.zip`. _(user-gated — per CLAUDE.md "never commit unless asked")_
- [ ] 10.5 Archive this OpenSpec change (`openspec archive permission-relay`). _(after release ships)_
