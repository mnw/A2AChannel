// ledger.ts — SQLite ledger + versioned migrations. Frozen append-only history; never edit prior.

import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { randomId } from "./ids";

export const LEDGER_SCHEMA_VERSION = 10;

export type LedgerOpenResult =
  | { db: Database; enabled: true }
  | { db: null; enabled: false };

export function openLedger(path: string): LedgerOpenResult {
  if (!path) return { db: null, enabled: false };
  try {
    const db = new Database(path, { create: true });
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
    try {
      chmodSync(path, 0o600);
    } catch (e) {
      console.error(`[ledger] chmod 0600 on ${path} failed:`, e);
    }
    migrateLedger(db);
    // -wal/-shm are created with umask default; tighten to 0600.
    for (const suffix of ["-wal", "-shm"]) {
      const sidePath = `${path}${suffix}`;
      try {
        chmodSync(sidePath, 0o600);
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") {
          console.error(`[ledger] chmod 0600 on ${sidePath} failed:`, e);
        }
      }
    }
    console.log(`[ledger] ready at ${path}`);
    return { db, enabled: true };
  } catch (e) {
    console.error(`[ledger] open failed, protocol routes disabled:`, e);
    return { db: null, enabled: false };
  }
}

export function migrateLedger(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  const current = row ? Number(row.value) : 0;
  if (current > LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `ledger schema_version=${current} is newer than this binary (${LEDGER_SCHEMA_VERSION}); refusing to downgrade`,
    );
  }
  if (current < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE events (
          seq          INTEGER PRIMARY KEY AUTOINCREMENT,
          handoff_id   TEXT    NOT NULL,
          kind         TEXT    NOT NULL,
          actor        TEXT    NOT NULL,
          payload_json TEXT    NOT NULL,
          at_ms        INTEGER NOT NULL
        );
        CREATE INDEX idx_events_handoff ON events(handoff_id, seq);
        CREATE INDEX idx_events_actor   ON events(actor, at_ms);

        CREATE TABLE handoffs (
          id             TEXT PRIMARY KEY,
          from_agent     TEXT    NOT NULL,
          to_agent       TEXT    NOT NULL,
          task           TEXT    NOT NULL,
          context_json   TEXT,
          status         TEXT    NOT NULL
                          CHECK(status IN ('pending','accepted','declined','cancelled','expired')),
          decline_reason TEXT,
          comment        TEXT,
          cancel_reason  TEXT,
          cancelled_by   TEXT,
          created_at_ms  INTEGER NOT NULL,
          expires_at_ms  INTEGER NOT NULL,
          resolved_at_ms INTEGER
        );
        CREATE INDEX idx_handoffs_status  ON handoffs(status, expires_at_ms);
        CREATE INDEX idx_handoffs_to      ON handoffs(to_agent, status);
        CREATE INDEX idx_handoffs_from    ON handoffs(from_agent, status);
        CREATE INDEX idx_handoffs_created ON handoffs(created_at_ms);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')");
      db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('ledger_id', ?)", [
        randomId(16),
      ]);
      db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at_ms', ?)", [
        String(Date.now()),
      ]);
    })();
    console.log(`[ledger] applied migration v1`);
  }
  if (current < 2) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE interrupts (
          id                TEXT PRIMARY KEY,
          from_agent        TEXT    NOT NULL,
          to_agent          TEXT    NOT NULL,
          text              TEXT    NOT NULL,
          status            TEXT    NOT NULL
                              CHECK(status IN ('pending','acknowledged')),
          created_at_ms     INTEGER NOT NULL,
          acknowledged_at_ms INTEGER,
          acknowledged_by   TEXT
        );
        CREATE INDEX idx_interrupts_status ON interrupts(status, created_at_ms);
        CREATE INDEX idx_interrupts_to     ON interrupts(to_agent, status);
        CREATE INDEX idx_interrupts_from   ON interrupts(from_agent, status);

        CREATE TABLE nutshell (
          id             INTEGER PRIMARY KEY CHECK(id = 0),
          text           TEXT    NOT NULL DEFAULT '',
          version        INTEGER NOT NULL DEFAULT 0,
          updated_at_ms  INTEGER NOT NULL,
          updated_by     TEXT
        );
      `);
      db.run(
        "INSERT OR IGNORE INTO nutshell (id, text, version, updated_at_ms, updated_by) VALUES (0, '', 0, ?, NULL)",
        [Date.now()],
      );
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')");
    })();
    console.log(`[ledger] applied migration v2`);
  }
  if (current < 3) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE claude_sessions (
          agent          TEXT    NOT NULL,
          cwd            TEXT    NOT NULL,
          resume_flag    TEXT    NOT NULL,
          captured_at_ms INTEGER NOT NULL,
          PRIMARY KEY (agent, cwd)
        );
        CREATE INDEX idx_claude_sessions_agent ON claude_sessions(agent);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')");
    })();
    console.log(`[ledger] applied migration v3`);
  }
  if (current < 4) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE permissions (
          id              TEXT PRIMARY KEY,
          agent           TEXT    NOT NULL,
          tool_name       TEXT    NOT NULL,
          description     TEXT    NOT NULL,
          input_preview   TEXT    NOT NULL,
          status          TEXT    NOT NULL
                            CHECK(status IN ('pending','allowed','denied')),
          created_at_ms   INTEGER NOT NULL,
          resolved_at_ms  INTEGER,
          resolved_by     TEXT,
          behavior        TEXT CHECK(behavior IS NULL OR behavior IN ('allow','deny'))
        );
        CREATE INDEX idx_permissions_status ON permissions(status, created_at_ms);
        CREATE INDEX idx_permissions_agent  ON permissions(agent, status);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')");
    })();
    console.log(`[ledger] applied migration v4`);
  }
  if (current < 5) {
    // v5: add 'dismissed' to permissions.status (CHECK can't ALTER → copy-drop-rename).
    db.transaction(() => {
      db.exec(`
        CREATE TABLE permissions_new (
          id              TEXT PRIMARY KEY,
          agent           TEXT    NOT NULL,
          tool_name       TEXT    NOT NULL,
          description     TEXT    NOT NULL,
          input_preview   TEXT    NOT NULL,
          status          TEXT    NOT NULL
                            CHECK(status IN ('pending','allowed','denied','dismissed')),
          created_at_ms   INTEGER NOT NULL,
          resolved_at_ms  INTEGER,
          resolved_by     TEXT,
          behavior        TEXT CHECK(behavior IS NULL OR behavior IN ('allow','deny'))
        );
        INSERT INTO permissions_new SELECT * FROM permissions;
        DROP TABLE permissions;
        ALTER TABLE permissions_new RENAME TO permissions;
        CREATE INDEX idx_permissions_status ON permissions(status, created_at_ms);
        CREATE INDEX idx_permissions_agent  ON permissions(agent, status);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')");
    })();
    console.log(`[ledger] applied migration v5`);
  }
  if (current < 6) {
    // v6: rooms. Add `room` to events/handoffs/interrupts/permissions; restructure nutshell to per-room.
    db.transaction(() => {
      db.exec(`
        ALTER TABLE events     ADD COLUMN room TEXT;
        ALTER TABLE handoffs   ADD COLUMN room TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE interrupts ADD COLUMN room TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE permissions ADD COLUMN room TEXT NOT NULL DEFAULT 'default';
        CREATE INDEX idx_handoffs_room   ON handoffs(room, status, created_at_ms DESC);
        CREATE INDEX idx_interrupts_room ON interrupts(room, status, created_at_ms DESC);
        CREATE INDEX idx_permissions_room ON permissions(room, status);

        CREATE TABLE nutshell_new (
          room          TEXT PRIMARY KEY,
          text          TEXT    NOT NULL DEFAULT '',
          version       INTEGER NOT NULL DEFAULT 0,
          updated_at_ms INTEGER NOT NULL,
          updated_by    TEXT
        );
        INSERT INTO nutshell_new (room, text, version, updated_at_ms, updated_by)
          SELECT 'default', text, version, updated_at_ms, updated_by FROM nutshell WHERE id = 0;
        DROP TABLE nutshell;
        ALTER TABLE nutshell_new RENAME TO nutshell;
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '6')");
    })();
    console.log(`[ledger] applied migration v6`);
  }
  if (current < 7) {
    // v7: rename events.handoff_id → events.entity_id (carries any kind's id since v2).
    db.transaction(() => {
      db.exec(`
        ALTER TABLE events RENAME COLUMN handoff_id TO entity_id;
        DROP INDEX IF EXISTS idx_events_handoff;
        CREATE INDEX idx_events_entity ON events(entity_id, seq);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '7')");
    })();
    console.log(`[ledger] applied migration v7`);
  }
  if (current < 8) {
    // v8: per-room transcript persistence opt-in flag.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS room_settings (
          room                TEXT    PRIMARY KEY,
          persist_transcript  INTEGER NOT NULL DEFAULT 0,
          updated_at          INTEGER NOT NULL
        );
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8')");
    })();
    console.log(`[ledger] applied migration v8`);
  }
  if (current < 9) {
    // v9: (formerly added scraper columns; reverted in v10)
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '9')");
    console.log(`[ledger] applied migration v9`);
  }
  if (current < 10) {
    // v10: scraper feature pulled. Drop the v9 columns if they exist.
    // ALTER TABLE DROP COLUMN requires SQLite 3.35+ (Bun bundles a recent version).
    db.transaction(() => {
      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info(permissions)")
        .all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      if (names.has("snapshot_path")) {
        db.exec("ALTER TABLE permissions DROP COLUMN snapshot_path");
      }
      if (names.has("dismissed_by_scraper")) {
        db.exec("ALTER TABLE permissions DROP COLUMN dismissed_by_scraper");
      }
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '10')");
    })();
    console.log(`[ledger] applied migration v10`);
  }
}

export function getRoomSettings(
  db: Database,
  room: string,
): { room: string; persist_transcript: boolean; updated_at: number } | null {
  const row = db
    .query<{ room: string; persist_transcript: number; updated_at: number }, [string]>(
      "SELECT room, persist_transcript, updated_at FROM room_settings WHERE room = ?",
    )
    .get(room);
  if (!row) return null;
  return { room: row.room, persist_transcript: !!row.persist_transcript, updated_at: row.updated_at };
}

export function setRoomSettings(
  db: Database,
  room: string,
  partial: { persist_transcript?: boolean },
): void {
  const current = getRoomSettings(db, room);
  const persist = partial.persist_transcript ?? current?.persist_transcript ?? false;
  db.run(
    `INSERT INTO room_settings (room, persist_transcript, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(room) DO UPDATE SET persist_transcript = excluded.persist_transcript, updated_at = excluded.updated_at`,
    [room, persist ? 1 : 0, Date.now()],
  );
}

export function listOptedInRooms(db: Database): string[] {
  const rows = db
    .query<{ room: string }, []>(
      "SELECT room FROM room_settings WHERE persist_transcript = 1",
    )
    .all();
  return rows.map((r) => r.room);
}
