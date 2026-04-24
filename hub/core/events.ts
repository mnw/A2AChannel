// Event-log insert helper. Thin wrapper around `INSERT INTO events` — every
// persistent state-machine kind writes one event per state change in the same
// transaction as the derived-table update (see CLAUDE.md "Every structured-
// message state change writes exactly one event + one derived-table update
// in one SQLite transaction").
//
// The column is `entity_id` post-v0.9.5 (was `handoff_id` through v0.9.1;
// renamed in the v7 migration — see hub/hub.ts migrateLedger v7 block).

import type { Database } from "bun:sqlite";

export function insertEvent(
  db: Database,
  entity_id: string,
  kind: string,
  actor: string,
  payload: unknown,
  at_ms: number,
): number {
  const res = db.run(
    "INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, ?, ?, ?, ?)",
    [entity_id, kind, actor, JSON.stringify(payload ?? {}), at_ms],
  );
  return Number(res.lastInsertRowid);
}
