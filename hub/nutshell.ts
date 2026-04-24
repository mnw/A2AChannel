// Nutshell — one-paragraph project summary, keyed by room.
//
// NOT a kind. Single-row document (well, one-row-per-room), no lifecycle, no
// broadcast fan-out to both parties. Kept standalone as an ad-hoc module per
// design.md §8 — forcing it into KindModule would require stubbing most hooks.
//
// Write path: piggybacks on the handoff primitive (task prefix "[nutshell]",
// context.patch carries the new full text). The handoff's accept path calls
// writeNutshellInTx() in the same transaction as the accept event — that
// coupling is why handoff.ts imports this module.

import type { Database } from "bun:sqlite";
import type { Entry } from "./core/types";
import { ts } from "./core/ids";

export type NutshellSnapshot = {
  room: string;
  text: string;
  version: number;
  updated_at_ms: number;
  updated_by: string | null;
};

type NutshellRow = {
  room: string;
  text: string;
  version: number;
  updated_at_ms: number;
  updated_by: string | null;
};

export function readNutshell(db: Database | null, room: string): NutshellSnapshot {
  if (!db) {
    return { room, text: "", version: 0, updated_at_ms: Date.now(), updated_by: null };
  }
  const row = db
    .query<NutshellRow, [string]>(
      "SELECT room, text, version, updated_at_ms, updated_by FROM nutshell WHERE room = ?",
    )
    .get(room);
  if (!row) {
    // No row yet for this room — return empty sentinel so callers don't branch.
    return { room, text: "", version: 0, updated_at_ms: Date.now(), updated_by: null };
  }
  return {
    room: row.room,
    text: row.text,
    version: row.version,
    updated_at_ms: row.updated_at_ms,
    updated_by: row.updated_by,
  };
}

// Caller must wrap this in the same transaction as the triggering event (handoff accept).
// Upserts the nutshell row for the given room; creates it on first edit.
export function writeNutshellInTx(
  db: Database,
  room: string,
  newText: string,
  updatedBy: string,
): NutshellSnapshot {
  const now = Date.now();
  db.run(
    `INSERT INTO nutshell (room, text, version, updated_at_ms, updated_by)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(room) DO UPDATE SET
       text = excluded.text,
       version = nutshell.version + 1,
       updated_at_ms = excluded.updated_at_ms,
       updated_by = excluded.updated_by`,
    [room, newText, now, updatedBy],
  );
  const row = db
    .query<NutshellRow, [string]>(
      "SELECT room, text, version, updated_at_ms, updated_by FROM nutshell WHERE room = ?",
    )
    .get(room);
  return {
    room: row?.room ?? room,
    text: row?.text ?? newText,
    version: row?.version ?? 0,
    updated_at_ms: row?.updated_at_ms ?? now,
    updated_by: row?.updated_by ?? updatedBy,
  };
}

export function nutshellEntry(snapshot: NutshellSnapshot): Entry {
  return {
    type: "nutshell.updated",
    text: snapshot.text,
    ts: ts(),
    room: snapshot.room,
    snapshot,
  } as Entry;
}
