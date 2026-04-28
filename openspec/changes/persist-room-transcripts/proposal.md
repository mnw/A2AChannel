## Why

The chat log is in-memory only and resets on every hub restart. Power users running multi-agent rooms over hours or days lose the orchestration view — what each agent said when, system audit rows from slash sends, briefing emits — and currently have no way to read back, search, or share that history. Per-agent transcripts persist already in `~/.claude/projects/<cwd>/<session>.jsonl`, but the *room-level* aggregation is volatile. This change introduces opt-in per-room transcript persistence so users who explicitly want continuity get it without imposing privacy or storage costs on users who don't.

## What Changes

- **Opt-in persistence**, off by default. Each room individually flips on persistence via a new `room_settings.persist_transcript` flag. Default behavior (off) is unchanged from today.
- **JSONL append-only files** at `~/Library/Application Support/A2AChannel/transcripts/<room>.jsonl`, mode 0600, one chat entry per line as versioned JSON.
- **`room_settings` SQLite table** (new) holds `persist_transcript: bool` per room. Belongs in SQLite alongside the existing kinds because it's structured config, not append-only conversation. Rotation size is a global constant (10,000 lines) — not per-room configurable in this change.
- **Hub restart hydration**: on startup, for each room with persistence on, tail the last N entries from JSONL into the in-memory `chatLog` cache. Replay merges JSONL chat entries with SQLite kind events by timestamp so SSE clients see history in true arrival order.
- **`/clear` semantics**: when used to wipe a room's context, it deletes the active JSONL **and** every rotated chunk for that room. `/clear` is the destructive wipe; rotation is the non-destructive size cap. Both the in-memory cache and the on-disk transcript (all chunks) are cleared atomically.
- **File rotation at 10,000 entries**: when the active JSONL hits 10,000 lines, the system renames it to `<hash8>-<sanitized>.<seq>.jsonl` and starts a fresh active file. Rotated chunks are preserved indefinitely — history never gets dropped automatically. `/clear` is the only command that removes transcript data.
- **CLAUDE.md hard-rule update**: the existing "Never persist the roster or chat log without being asked" rule changes to "Roster never persists; chat transcript persists only when explicitly opted in per room. SQLite continues to own kinds; JSONL owns chat — they never overlap."
- Markdown export (`/export` slash command) is **explicitly out of scope** — captured in design.md as Phase 2.

## Capabilities

### New Capabilities

- `room-transcript-persistence`: opt-in per-room durable storage for the chat log. Covers the JSONL append path, the per-room settings store, hub restart hydration, `/clear` integration, retention enforcement, and the trust-on-self-assertion model for who may flip the flag.

### Modified Capabilities

None. The kinds (`handoff`, `interrupt`, `permission`, `nutshell`) and existing storage paths (`ledger.db`, attachments dir) are untouched. `kind-runtime` does not change behavior — kinds keep their existing SQLite path with no awareness of transcripts.

## Impact

**Code**
- `hub/core/transcript.ts` — new module owning per-room JSONL append, tail-replay, atomic truncate, retention enforcement.
- `hub/core/ledger.ts` — new `room_settings` table and migration.
- `hub/hub.ts` — chat append calls `transcript.append(room, entry)` after the existing `chatLog.push`. Hub startup hydrates `chatLog` from JSONL for opted-in rooms.
- `hub/kinds/handoff.ts` — the `/clear` flow (currently affects in-memory chatLog only) extends to truncate the room's JSONL when a clear is targeted.
- UI: a per-room toggle in the room picker / settings drawer for `persist_transcript`. Surface via existing room-settings UI; minimal UI work.
- `CLAUDE.md` — hard-rule update.

**Filesystem**
- New directory: `~/Library/Application Support/A2AChannel/transcripts/`, mode 0700.
- New files: `<room>.jsonl` per opted-in room, mode 0600.
- Bounded by retention setting; no compression in Phase 1.

**APIs**
- Hub `/stream` SSE replay path expands to merge JSONL + SQLite events by `ts` on hydrate; per-message wire format is unchanged.
- New endpoint or settings route to flip `persist_transcript` per room. Auth-gated like other mutating routes.

**Migrations**
- One forward-only SQLite migration adding `room_settings` table.
- JSONL files versioned per line (`{"v": 1, ...}`) so reader can tolerate older schema versions in the future.

**Risk**
- Secrets-in-transcript: once written, secrets are on disk. Phase 1 documents this as a known accepted risk; redaction tooling is Phase 2. Mitigated by the opt-in default — users flipping the flag on are accepting this trade.
- File corruption (partial write at crash): readers must tolerate a truncated final line.
- Disk growth: bounded by retention setting; user is responsible if they choose unlimited and the room is busy.

**Out of scope (Phase 2 candidates, not in this change)**
- Markdown export / `/export` slash command.
- Search index (FTS5 over JSONL or otherwise).
- Time-based retention.
- Encryption at rest.
- Cross-machine transcript sync.
- Auto-detect-and-mask secrets.
