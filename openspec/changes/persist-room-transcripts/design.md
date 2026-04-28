## Context

A2AChannel keeps the chat log in memory only (`chatLog: Entry[]` in `hub/hub.ts`). Hub restart wipes the room-level conversation history, even though every individual agent's claude session continues to write its own transcript at `~/.claude/projects/<cwd>/<session>.jsonl`. The orchestration layer's view (who said what across agents, system audit rows, briefing emits) is the one slice of state that has no durable home.

Adjacent state is already well-organized:
- **SQLite (`ledger.db`)** owns structured kinds: `events` table + per-kind derived tables (`handoffs`, `interrupts`, `permissions`, `nutshell`). All ACID, all queryable.
- **Filesystem (`~/a2a-attachments/`)** owns blob attachments, mode 0600.
- **In-memory** owns chatLog, ROSTER, presenceState, briefedAgents.

The CLAUDE.md hard rule "Never persist the roster or chat log without being asked" was deliberate — it defends against privacy leaks, schema migration burden, and unbounded disk growth. The user has now asked, but the rule's spirit (default off, opt-in deliberate) should survive into the new design.

## Goals / Non-Goals

**Goals:**
- Per-room opt-in transcript persistence with default off.
- JSONL append-only at `~/Library/Application Support/A2AChannel/transcripts/<room>.jsonl`.
- SQLite (`ledger.db`) untouched in its existing role; only addition is a new `room_settings` table for the per-room flag.
- Hub restart restores the conversation view by hydrating `chatLog` from JSONL + replaying kinds from SQLite, merged by timestamp.
- `/clear` semantics extend cleanly: same command wipes both in-memory cache and on-disk transcript atomically.
- Versioned line schema so future format changes don't break readers.
- Keep the in-memory `chatLog` as a hot cache — no read-from-disk in the SSE serve path.

**Non-Goals:**
- Markdown export, search index, encryption, time-based retention, secret auto-redaction. All deferred to Phase 2.
- Cross-machine sync. Single-host only, same as the rest of the hub.
- Persisting roster, presenceState, or briefedAgents. Those stay in-memory by design.
- Rewriting kinds to use JSONL. Kinds stay in SQLite — they need queryable derived state, JSONL doesn't fit.
- Reconstructing per-agent claude history. That's claude's own JSONL territory; we do not duplicate it.

## Decisions

### D1. Two stores, two responsibilities — SQLite for kinds, JSONL for chat

SQLite continues to own the events table and per-kind derived tables. JSONL owns the append-only chat transcript. They never overlap.

**Why:** Kinds are state machines with lifecycles (`pending → terminal`) and need queryable derived state ("find pending handoffs for agent X"). SQLite's relational model fits naturally. Chat is append-only, has no per-row state transitions, and benefits from grep-friendly portability + simple schema evolution. Forcing chat into SQLite would inflate the schema; forcing kinds into JSONL would require rebuilding indexes on every startup.

**Alternative considered:** Put chat into a `chat_log` SQLite table. Rejected because it conflates two storage concerns, makes the hot append path more expensive (a full ACID write per chat event vs. a fsync'd line append), and gives no portability benefit (you can't `cat ledger.db | grep`).

### D2. JSONL files are per-room, not per-hub-process

One file per room: `transcripts/<room>.jsonl`. Each room's transcript is independent.

**Why:** Rooms are the natural scope for "all the chatter relevant to this project." Per-room files mean a user can `scp transcripts/auth-rewrite.jsonl` to a colleague without leaking unrelated rooms. They also allow per-room retention settings, per-room opt-in, and per-room `/clear` without touching other rooms.

**Alternative considered:** One file per hub process (timestamped). Rejected because cross-room mingling defeats the use case ("read back what builder said about auth") and complicates `/clear`.

### D3. Per-line versioned JSON: `{"v": 1, ...}`

Every line is `{"v": 1, "ts": ..., "from": ..., "to": ..., "text": ..., ...}`. The `v` field is mandatory; readers must tolerate unknown future versions by skipping lines with higher `v` than they understand.

**Why:** JSONL has no header; per-line versioning is the standard way to evolve the schema without rewriting old files. Tolerant readers means a v0.10 user's files stay readable when v0.11 ships a new field.

**Alternative considered:** A header line declaring the file's version. Rejected because it makes append-only writes brittle (header lock contention) and makes ad-hoc tail viewing harder.

### D4. `/clear` deletes active + every rotated chunk for the room

`/clear` for a room: enumerate every file matching `<hash8>-<sanitized>{,.\d+}.jsonl` in the transcripts directory; `fs.unlinkSync` each. In-memory `chatLog` is filtered for that room's entries in the same hub-side transaction (single mutex hold).

**Why:** `/clear` is the destructive intent — "wipe everything we have for this room." Leaving rotated chunks behind would silently retain data the user thought they deleted. Rotation (D6) is the *non-destructive* automatic size cap; `/clear` is the *destructive* manual reset. Keep these intents cleanly separated in code and behavior.

**Atomicity:** Best-effort. The hub-side mutex guarantees no concurrent appends during the unlink loop. If the loop fails partway through (disk error, permission change), partial state is recoverable — surviving chunks remain valid JSONL, the next append re-creates the active file. We do not need an all-or-nothing transaction here because the operation is idempotent (re-running `/clear` cleans whatever wasn't removed).

**Alternative considered:** Tmpfile + rename for the active file only, leave rotated chunks. Rejected because it surfaces a confusing two-tier model where rotation chunks act as a "shadow archive" the user has no UI to see or delete. Either rotation chunks are part of the room's transcript (in which case `/clear` clears them) or they're a separate concept — picking the former is simpler.

### D5. Hub restart hydration reads the active chunk only

On startup, for each room with `persist_transcript = true` in `room_settings`, the hub reads the **active** JSONL file (`<hash8>-<sanitized>.jsonl`) — not the rotated chunks. Merge those entries with the last N kind events from SQLite by `ts`, push into `chatLog`.

**Why active-only:** The active file is bounded to 10,000 entries by D6, which matches the hub's working `HISTORY_LIMIT` for `chatLog`. Rotated chunks exist as historical archive — they're for the user to grep/cat/scp on demand, not for the hub to load into RAM on every restart. Loading every chunk would defeat the rotation's purpose.

**Implication for users:** `/stream` replay on connect shows at most the active chunk's worth of history. If a user wants to read further back, they `cat <hash8>-<sanitized>.000023.jsonl` directly. Future Phase 2 `/export` or search tooling spans all chunks; the live SSE stream does not.

**Alternative considered:** Hydrate from active + most recent rotated chunk if active is small. Rejected — it adds startup latency without a clear win, and the boundary cases (what if active is 1 entry?) are awkward.

**Alternative considered:** Hydrate from active + walk rotated chunks until reaching N entries. Rejected for the same reason; defer to Phase 2 if real usage shows users miss this.

### D6. File rotation at 10,000 entries — never auto-delete

The active JSONL file `<hash8>-<sanitized>.jsonl` is rotated when it hits 10,000 lines. Rotation = atomic rename to `<hash8>-<sanitized>.<seq>.jsonl` (where `<seq>` is the next zero-padded integer not already taken in the directory), then start a fresh active file. Rotated chunks are preserved indefinitely; the system never auto-deletes any transcript data.

**Why:** The user's stated requirement is "do not delete the current file once the limit is reached — add a new one." Rotation matches log-rotation conventions (nginx, syslog, rotatelogs) that users already understand. It also separates the *automatic* size-bounding mechanism from the *manual* destructive command (`/clear`) — the only path that removes transcript data is the user explicitly asking for it.

**Why 10,000 specifically:** Rough sweet spot. At ~500 bytes per chat entry (typical), 10k lines is ≈ 5 MB per chunk — small enough to `cat`, `grep`, or `scp` casually; large enough that a normal session doesn't produce many chunks. Constant in code, not user-configurable in this change; revise if real usage suggests a different number.

**Alternative considered:** Truncate to last N entries (FIFO discard). Rejected because the user specifically asked NOT to delete; rotation preserves history without sacrificing the size cap.

**Alternative considered:** Time-based rotation (one file per day). Rejected because conversation patterns are bursty — a quiet room would generate one tiny file per day for weeks, while a busy hour might fit in one chunk. Line-count rotation matches activity, not wall clock.

**Alternative considered:** Per-room configurable rotation size. Deferred — global constant is simpler and there's no current evidence anyone needs different sizes per room. Easy to add later as `room_settings.rotation_lines` if needed.

### D6a. Rotated chunk naming uses zero-padded sequence

Rotated chunks are named `<hash8>-<sanitized>.000001.jsonl`, `.000002.jsonl`, … with a 6-digit zero-padded integer. Sequence is determined by directory scan: take the highest existing seq for this room and increment by 1.

**Why:** Zero-padded sequential names sort lexicographically the same way they sort chronologically — `ls` and `glob` give chronological order for free. Six digits handles up to 999,999 chunks per room (≈ 10 billion entries, an absurd ceiling that's effectively infinite). Hub-restart recovery uses the same scan.

**Why not timestamp filenames** (e.g., `<hash8>-<sanitized>.<unix_ms>.jsonl`): Timestamps are unique but not collision-resistant under clock skew or hub-restart races within the same millisecond. Sequence numbers are derived from filesystem state, so they self-coordinate.

**Why not symlink + chunk dir**: A `<room>/active.jsonl` → numbered chunk symlink would be cleaner but adds platform-specific behavior (Windows symlink permissions). Flat naming with a sentinel filename (`<hash8>-<sanitized>.jsonl` is always active, anything with a numeric suffix is rotated) avoids that.

### D7. Trust-on-self-assertion for who flips the flag

The new `PUT /rooms/:room/settings` route accepts `persist_transcript` and `transcript_retention` from any caller bearing the hub bearer token. Same trust model as existing mutating routes (`POST /handoffs`, etc.) — token-holder can claim any identity.

**Why:** The hub's existing trust model is already trust-on-self-assertion (documented in CLAUDE.md). Adding a stricter model just for this one setting would create inconsistency. The room-settings flag is not load-bearing for security; the data is already on the same machine as the hub.

**Alternative considered:** Restrict to the human only. Rejected as inconsistent with how other settings flow.

### D8. UTF-8 only, no compression

Files are UTF-8 JSON, line-delimited. No gzip, no binary framing.

**Why:** Lets users `cat`, `grep`, `tail -f`, and `jq` without tooling. Compression saves disk at the cost of every diagnostic interaction needing a decompress step. Disk is cheap; eyeballs are expensive.

**Alternative considered:** Gzip. Rejected for ergonomics. If a single room hits multi-GB someone will tell us; we can add zstd-on-rotation in Phase 2.

### D9. `room_settings` table is opt-in by absence

A room without a row in `room_settings` is treated as "persistence off, retention unlimited." Inserting a row is the first opt-in. Setting `persist_transcript = false` afterward stops new appends but does not delete the existing JSONL — that requires `/clear` or a manual file delete.

**Why:** Off-by-default falls out for free if absence means off. Toggling the flag back to false leaves the historical file intact, which matches user intuition (turning off recording shouldn't erase past recordings).

### D10. Hot append path: write-through, not write-behind

`hub.append(entry, scope)` calls `chatLog.push(entry)`, broadcasts to SSE subscribers, *then* synchronously calls `transcript.append(room, entry)` if persistence is on. The append is `fs.appendFileSync` with explicit `\n`. No buffering, no batching.

**Why:** A burst of writes from a busy room is bounded by the rate at which chat events occur (human speed for human messages, model speed for agent messages — order of seconds, not milliseconds). The cost of an `fsync` per entry is negligible at that rate. Buffering would introduce data-loss windows on hub crash. The user opted in for durability; honor it.

**Alternative considered:** Batched writes every N ms. Rejected — adds complexity (timer, flush-on-shutdown, partial-batch loss on crash) for negligible perf gain at human-conversation rates.

## Risks / Trade-offs

- **Secrets in transcripts** → Once written, secrets are on disk in plain UTF-8. Mitigated by: (a) opt-in default, (b) `mode 0600` + 0700 directory, (c) Phase 2 redaction tooling tracked in non-goals. Documented as known-accepted-risk in CLAUDE.md after this change ships.
- **Partial line at crash** → A hub crash mid-`appendFileSync` can leave a final line truncated. Mitigated by: tolerant reader that catches `JSON.parse` errors on the *last* line of any file and silently drops it. All other parse errors (mid-file) escalate.
- **Disk growth via accumulating rotated chunks** → A busy room over months produces many 5 MB chunks; nothing auto-deletes them. Mitigated by: surfacing the room's total transcript footprint (active + chunks) in the room-settings UI so users see the cost, and by `/clear` being the well-understood "wipe everything" lever. Users who want capped history without losing data can periodically `mv` old chunks to long-term storage outside the app data dir.
- **`/clear` on a room with persistence drops ALL history including rotated chunks** → That's the intent (D4) but it's a bigger blast radius than users may expect at first. Mitigated by: a confirmation modal that lists the active file + every rotated chunk that will be deleted, with the total byte count, when the room has persistence on. User must explicitly confirm.
- **Replay merge order** → Edge cases where JSONL entry and SQLite event have identical `ts`. Mitigated by: stable sort (insertion order wins ties); both stores use `Date.now()` so collisions are sub-millisecond and rare.
- **JSONL file lock contention** → Single hub process is the only writer per room file; no inter-process contention to manage.
- **Schema drift between JSONL `v=1` and the in-memory `Entry` type** → Adding a field to `Entry` without bumping `v` would write `v=1` lines that contain unknown fields. Mitigated by: rule that any addition to the Entry type bumps `v` and updates the reader to handle both versions.

## Migration Plan

This change is purely additive. No existing data is migrated, no behavior changes for users who don't opt in.

1. **Forward migration:** SQL `CREATE TABLE IF NOT EXISTS room_settings (...)` runs on hub startup if missing.
2. **Rollback:** Setting `persist_transcript = false` for all rooms returns the system to pre-change behavior. JSONL files left on disk are inert (no reader running). A user can `rm -rf ~/Library/Application\ Support/A2AChannel/transcripts/` to fully revert.
3. **Downgrade:** A user installing an older A2AChannel build on top of an installed v0.10+ data dir leaves the JSONL files orphaned but harmless (the older code doesn't know they exist).
4. **Versioned line schema:** Future schema changes append-only — never modify old lines. Readers tolerate unknown `v` by skipping.

## Open Questions

- **UI surface for the toggle**: Reuse the existing room picker drawer or add a dedicated "Room settings" modal? Lean toward the former for minimum UI change but defer to whichever lands cleaner.
- **Should the room-settings UI surface a "view rotated chunks" affordance** so users can browse/copy/delete individual chunks without leaving the app? Lean: no in this change. Direct file access is the affordance for now (the directory is open via Finder); revisit if users complain.
- **JSONL filename collision**: Room labels may include characters that are valid in identifiers but awkward in filenames (e.g., `auth review`). Sanitization scheme: replace non-`[A-Za-z0-9_.-]` with `_`, document collision handling. Lean: prefix with the SHA-1-trunc-8 of the original room label, e.g., `<hash>-<sanitized>.jsonl`.
- **Should the kinds (handoff/interrupt/etc.) also write a "shadow" entry into the JSONL for the room?** The room-level transcript is the *combined* view, so arguably yes — when a handoff is created, append a synthesized `system` chat entry like "system → human: handoff h_abc opened (planner → builder)". This is what `chatLog` does today in memory. Decision: yes, mirror the existing in-memory behavior — what's in chatLog is what's in JSONL.
- **`/export` slash command**: explicitly out of scope, but an obvious Phase 2. Worth pre-deciding output format (markdown with metadata frontmatter) so the JSONL line schema doesn't paint us into a corner.
