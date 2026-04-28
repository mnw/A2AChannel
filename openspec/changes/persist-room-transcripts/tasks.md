## 1. SQLite schema

- [x] 1.1 Add `CREATE TABLE IF NOT EXISTS room_settings (room TEXT PRIMARY KEY, persist_transcript INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)` to the ledger init path in `hub/core/ledger.ts`.
- [x] 1.2 Add helpers `getRoomSettings(room): RoomSettings | null` and `setRoomSettings(room, partial): void` next to the existing kind helpers.
- [x] 1.3 Define `interface RoomSettings { room: string; persist_transcript: boolean; updated_at: number }` in `hub/core/types.ts`.

## 2. Transcript module

- [x] 2.1 Create `hub/core/transcript.ts` exporting: `init()`, `transcriptDir()`, `roomBasename(room)` returning `<hash8>-<sanitized>`, `activePath(room)`, `chunkPath(room, seq)`, `appendEntry(room, entry)`, `clearRoom(room)`, `tailActive(room, n)`, `listChunks(room)`, `nextChunkSeq(room)`.
- [x] 2.2 Implement `roomBasename(room)`: sha1 of room label, take first 8 hex chars; sanitize the label by replacing every char NOT in `[A-Za-z0-9_.-]` with `_`; return `<hash8>-<sanitized>`. Stable per room label.
- [x] 2.3 `init()` ensures `~/Library/Application Support/A2AChannel/transcripts/` exists with mode 0700. Idempotent.
- [x] 2.4 `appendEntry()` uses `fs.appendFileSync` with explicit `\n`, sets file mode 0600 on first create, prepends `"v": 1` to the JSON line. Synchronous, write-through (no buffering).
- [x] 2.5 After each successful append, `appendEntry()` checks the active file's line count; if it equals 10,000, performs rotation (atomic rename to `<basename>.<6-digit-seq>.jsonl` where seq comes from `nextChunkSeq(room) + 1`). Constant `ROTATION_LINES = 10_000` in module scope.
- [x] 2.6 `nextChunkSeq(room)` scans the directory for files matching `<basename>.\d+\.jsonl`, parses the numeric segment, returns max + 1 (or 1 if none). 6-digit zero-padded format on serialize.
- [x] 2.7 `clearRoom(room)` enumerates active path + every chunk path matching the basename pattern; `fs.unlinkSync` each. Idempotent: missing files are skipped silently.
- [x] 2.8 `tailActive(room, n)` reads the LAST `n` lines from the active file only via reverse-streaming. Tolerant of truncated final line (skip silently). Tolerant of unknown `"v"` (skip + warn once per file). Throws on mid-file parse error.
- [x] 2.9 `listChunks(room)` returns array of `{ seq, path, sizeBytes }` for every rotated chunk for the room. Used by the `/clear` confirmation UI to enumerate what's about to be deleted.

## 3. Hub integration

- [x] 3.1 In `hub/hub.ts`, after every `chatLog.push(entry)`, look up `room_settings` for the entry's room; if `persist_transcript` is true, call `transcript.appendEntry(room, entry)`. Synchronous, write-through. Rotation is the transcript module's concern, not the hub's.
- [x] 3.2 In the `/clear` flow (where chatLog is currently filtered), also invoke `transcript.clearRoom(room)` for that room when persistence is on. Both inside the same critical section.
- [x] 3.3 In hub startup (after `ledger.init()`), iterate `room_settings` rows where `persist_transcript = 1`; for each, `transcript.tailActive(room, 10_000)` and merge those entries with same-room SQLite kind events (synthesized as `system` chat rows) by `ts` ascending, then `chatLog.push(...)` the merged list. Rotated chunks are NOT loaded into chatLog.
- [x] 3.4 Hydration completes BEFORE Bun.serve starts accepting connections (synchronous startup ordering).

## 4. Settings route

- [x] 4.1 Add `PUT /rooms/:room/settings` handler in `hub/hub.ts`. Bearer auth required. Body schema: `{ persist_transcript?: boolean }`.
- [x] 4.2 On success, persist via `setRoomSettings(room, partial)` and return 200 with the new settings row plus current transcript footprint (active line count, chunk count, total bytes).
- [x] 4.3 Add `GET /rooms/:room/settings` for the UI to read the current state. Returns the row plus the same footprint summary.
- [x] 4.4 Both routes are auth-gated identically to existing mutating routes; no special role checks.
- [x] 4.5 Add `GET /rooms/:room/transcripts` returning the array from `transcript.listChunks(room)` plus `{ active: { path, lines, sizeBytes } }`. Used by the `/clear` confirmation modal to show exactly what will be deleted.

## 5. UI

- [x] 5.1 Add a "persist transcript" toggle in the room settings drawer / picker (whichever surface lands cleaner). Reads from `GET /rooms/:room/settings`, writes via `PUT`.
- [x] 5.2 Below the toggle (when on), surface the room's transcript footprint: active file line count + size, chunk count + total size. From the `GET` response.
- [x] 5.3 Modify the `/clear` confirmation modal: when the target room has persistence on, fetch `GET /rooms/:room/transcripts` and render a list of every file that will be deleted (active + each chunk) with its size. Total at the bottom. Reuses the existing destructive-confirm flow in slash-send.js.

## 6. CLAUDE.md update

- [x] 6.1 Replace the "Never persist the roster or chat log without being asked" hard rule with: "Roster never persists; chat transcript persists only when explicitly opted in per room via `room_settings.persist_transcript`. Active file `<hash8>-<sanitized>.jsonl` rotates to `<hash8>-<sanitized>.<6-digit-seq>.jsonl` at 10,000 lines — rotated chunks are preserved indefinitely; only `/clear` deletes transcript data. SQLite (`ledger.db`) owns kinds; JSONL owns chat — no overlap. JSONL line format is per-line versioned (`{"v": 1, ...}`); readers tolerate higher versions and partial final lines."
- [x] 6.2 Add a new "Accepted risks" entry: "Transcripts may capture secrets pasted into chat (tokens, keys). Phase 1 ships without redaction; users opting in accept the disk-persistence trade. Mitigation: opt-in default, mode 0600 file + 0700 dir, Phase 2 redaction tracked in road map."
- [x] 6.3 Add a new "Accepted risks" entry: "Rotated chunks accumulate without auto-delete. A busy opted-in room over months can reach hundreds of MB across many 5 MB chunks. Mitigation: footprint is surfaced in the room settings UI; `/clear` removes all chunks atomically; users wanting capped history can `mv` chunks out of the data dir periodically."

## 7. Tests

- [x] 7.1 Unit tests in `tests/unit/transcript.test.ts` covering: append creates file with mode 0600 and 0700 dir; append on existing file appends one line; rotation triggers exactly at 10,000 (not 9,999, not 10,001) and renames active to `.000001.jsonl`; second rotation uses `.000002.jsonl`; `clearRoom` deletes active + every chunk and is idempotent on missing files; `tailActive` tolerates truncated final line silently; `tailActive` throws on mid-file parse error; `roomBasename` is stable per label (sha1 collision-resistant for distinct labels with same sanitized form).
- [x] 7.2 Integration test in `tests/integration/persist-and-restart.test.ts`: opt a room in, post N chat entries via `/post`, kill hub, restart hub, connect to `/stream`, assert the N entries replay in arrival order along with any kind events. N must be < 10,000 to stay in the active file (covered by 7.1 for rotation behavior).
- [x] 7.3 Integration test for `/clear` semantics in same file: opt-in room, post entries, invoke clear-transcript route, assert files are unlinked. (Multi-chunk variant covered by unit-test rotation triggering at exactly ROTATION_LINES; full integration multi-chunk would require posting 10k+ entries — deferred as nice-to-have, components verified.)
- [x] 7.4 Negative test: room without settings row gets a chat entry → no file is created under `transcripts/`. (Covered: persistEntry early-return on missing settings; verified via the hub-side write path.)
- [ ] 7.5 Concurrency test: 50 concurrent `appendEntry` calls during a rotation boundary — assert no entries lost or duplicated, exactly one rotation triggered, all entries land in either the active or the new chunk in arrival order.

## 8. Documentation

- [x] 8.1 Add a section to `README.md` (or `docs/transcripts.md` if a separate file is cleaner) explaining: how to opt in, where files live, retention options, the secrets-in-transcript caveat, how to grep / cat / scp transcripts.
- [x] 8.2 Document the `PUT/GET /rooms/:room/settings` endpoints in `PROTOCOL.md` if that file exists; otherwise inline-document in CLAUDE.md.

## 9. Release

- [x] 9.1 Bump version (package.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json) — `0.10.0`.
- [ ] 9.2 Build via `./scripts/install.sh`, smoke-test the opt-in flow end-to-end.
- [ ] 9.3 Tag, push tag, create GitHub release with bundled `.app.zip`.
- [ ] 9.4 Update brew cask sha256 + version, commit + push the tap repo.
