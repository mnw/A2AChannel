// room-hydrator.ts — per-Room transcript replay on first agent reconnect
// post-Hub-restart. Lazily reads the active JSONL chunk for each opted-in Room
// (the one with `room_settings.persist_transcript = true`) and pushes its
// entries through the hub's UI broadcast so reconnecting Webviews see the
// chat history populate.
//
// Why lazy, not eager-on-startup: the Hub doesn't know at startup whether
// agents will reconnect (it can't see tmux directly). If no agent reconnects
// in Room R, we don't hydrate — exactly the "agents killed" → empty room case.
// If agents reconnect, the first one in each Room triggers hydration — the
// "Hub-only restart" → continuity case.
//
// Sealed invariants the module owns (so callers can't violate them by
// accident — same discipline as Candidate 4's agent registry seal):
//   - Per-Room: hydration runs at most once per process per Room. Re-entry
//     for the same Room returns the cached promise (race-safe across
//     simultaneous same-Room agent reconnects).
//   - Capped: replay is bounded by the caller-provided line limit (the
//     existing chat_history_limit), so a 10k-line active chunk doesn't
//     overrun the Hub's in-memory chatLog ring buffer.
//   - Best-effort: a parse error on the JSONL leaves a logged warning and
//     the cached resolved promise — we don't retry mid-process. Hub
//     restart re-attempts.
//   - Replay marker: each replayed entry carries `replay: true` so the UI
//     can flag historical content, mirroring how Kind reconnect-replay
//     works (`pendingFor` returns entries with `replay: true`).

import type { Database } from "bun:sqlite";

import { getRoomSettings } from "./ledger";
import { tailActive } from "./transcript";
import type { Entry } from "./types";

export type RoomHydratorOptions = {
  db: Database;
  capLines: number;
  replay: (entry: Entry) => void;
};

export type RoomHydrator = {
  // Idempotent. Concurrent calls for the same Room await the same promise;
  // subsequent calls after completion return the cached resolved promise
  // without re-reading the JSONL.
  maybeHydrate(room: string): Promise<void>;
};

export function createRoomHydrator(opts: RoomHydratorOptions): RoomHydrator {
  const promises = new Map<string, Promise<void>>();

  function maybeHydrate(room: string): Promise<void> {
    const cached = promises.get(room);
    if (cached) return cached;
    // Set the promise BEFORE the async work so concurrent same-Room callers
    // observe it and await rather than re-entering. This is the race fix
    // referenced in Concern 3 of the architecture review.
    const p = (async () => {
      const settings = getRoomSettings(opts.db, room);
      if (!settings?.persist_transcript) return;
      let entries: Entry[];
      try {
        entries = tailActive(room, opts.capLines);
      } catch (e) {
        console.error(`[hydrator] read failed for room=${room}:`, e);
        return;
      }
      if (!entries.length) return;
      for (const entry of entries) {
        opts.replay({ ...entry, replay: true });
      }
      console.log(`[hydrator] room=${room} replayed ${entries.length} entries`);
    })();
    promises.set(room, p);
    return p;
  }

  return { maybeHydrate };
}
