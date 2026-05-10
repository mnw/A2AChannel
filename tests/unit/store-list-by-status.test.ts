// Unit tests for hub/core/store.ts — verifies the structural invariants per
// ledger-store/spec.md, in particular: listByStatus runs EXACTLY ONE SQL query
// against the database regardless of result-row count (no N+1).

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createSqliteStore, createInMemoryStore } from "../../hub/core/store";
import type { Snapshot, StateMachineDecl } from "../../hub/core/types";

// Minimal test fixture: a "widget" Kind with status + assignee + room.
type WidgetSnapshot = Snapshot & {
  assignee: string;
  room: string;
  created_at: number;
};

const widgetDecl: StateMachineDecl<WidgetSnapshot> = {
  kind: "widget",
  table: "widgets",
  columns: {
    id: "TEXT",
    status: "TEXT",
    assignee: "TEXT",
    room: "TEXT",
    created_at: "INTEGER",
  },
  forColumn: "assignee",
  terminalStatuses: new Set(["done", "cancelled"]),
  rowToSnapshot: (row) => ({
    id: row.id as string,
    status: row.status as string,
    version: Number(row.version ?? 0),
    assignee: row.assignee as string,
    room: row.room as string,
    created_at: Number(row.created_at),
  }),
  snapshotToRow: (snap) => ({
    ...(snap.id !== undefined ? { id: snap.id } : {}),
    ...(snap.status !== undefined ? { status: snap.status } : {}),
    ...(snap.assignee !== undefined ? { assignee: snap.assignee } : {}),
    ...(snap.room !== undefined ? { room: snap.room } : {}),
    ...(snap.created_at !== undefined ? { created_at: snap.created_at } : {}),
  }),
};

function openTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`PRAGMA journal_mode = WAL;`);
  // Reproduce the events table the hub's ledger.ts creates (events.entity_id post-v7).
  db.exec(`
    CREATE TABLE events (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id    TEXT    NOT NULL,
      kind         TEXT    NOT NULL,
      actor        TEXT    NOT NULL,
      payload_json TEXT    NOT NULL,
      at_ms        INTEGER NOT NULL
    );
  `);
  return db;
}

describe("createSqliteStore — DDL + indices", () => {
  test("migrate creates table with version column + composite index on (status, for_col)", () => {
    const db = openTestDb();
    const store = createSqliteStore(widgetDecl);
    store.migrate(db);

    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(widgets)`).all();
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("status");
    expect(colNames).toContain("assignee");
    expect(colNames).toContain("version");

    const indices = db
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='widgets'`)
      .all();
    const idxNames = indices.map((i) => i.name);
    expect(idxNames).toContain("idx_widgets_status_assignee");
  });

  test("migrate is idempotent (CREATE TABLE IF NOT EXISTS)", () => {
    const db = openTestDb();
    const store = createSqliteStore(widgetDecl);
    store.migrate(db);
    expect(() => store.migrate(db)).not.toThrow();
  });
});

describe("createSqliteStore — listByStatus is single-query (no N+1)", () => {
  test("listByStatus runs exactly one SELECT regardless of result row count", () => {
    const db = openTestDb();
    const store = createSqliteStore(widgetDecl);
    store.migrate(db);

    // Seed 50 pending widgets.
    for (let i = 0; i < 50; i++) {
      store.create(db, {
        initial: {
          id: `w${i}`,
          status: "pending",
          version: 0,
          assignee: "alice",
          room: "default",
          created_at: 1_000 + i,
        },
        eventKind: "widget.new",
        actor: "human",
        at: 1_000 + i,
        payload: () => ({ seeded: true }),
      });
    }

    // Wrap db.query to count SELECTs against the widgets table.
    let widgetSelectCount = 0;
    let eventSelectCount = 0;
    const realQuery = db.query.bind(db);
    db.query = ((sql: string, ...rest: unknown[]) => {
      if (/SELECT[\s\S]+FROM\s+"?widgets"?/i.test(sql)) widgetSelectCount++;
      if (/SELECT[\s\S]+FROM\s+events/i.test(sql)) eventSelectCount++;
      return realQuery(sql, ...(rest as []));
    }) as typeof db.query;

    const results = store.listByStatus(db, { status: "pending", for: "alice" });
    expect(results.length).toBe(50);

    // The whole point of materializing version on the derived row: zero events-table queries
    // on the read path.
    expect(eventSelectCount).toBe(0);
    // And exactly one widgets-table query.
    expect(widgetSelectCount).toBe(1);
  });

  test("EXPLAIN QUERY PLAN uses the composite index when status + for are filtered", () => {
    const db = openTestDb();
    const store = createSqliteStore(widgetDecl);
    store.migrate(db);
    // Seed enough rows that SQLite's optimizer cares about index choice.
    for (let i = 0; i < 100; i++) {
      store.create(db, {
        initial: {
          id: `w${i}`,
          status: i % 2 === 0 ? "pending" : "done",
          version: 0,
          assignee: i % 3 === 0 ? "alice" : "bob",
          room: "default",
          created_at: 1_000 + i,
        },
        eventKind: "widget.new",
        actor: "human",
        at: 1_000 + i,
        payload: () => ({ seeded: true }),
      });
    }

    const plan = db
      .query<{ detail: string }, [string, string, number]>(
        `EXPLAIN QUERY PLAN SELECT * FROM widgets WHERE status = ? AND assignee = ? ORDER BY rowid DESC LIMIT ?`,
      )
      .all("pending", "alice", 200);
    const detail = plan.map((p) => p.detail).join(" | ");
    expect(detail).toMatch(/USING INDEX idx_widgets_status_assignee/);
  });
});

describe("createSqliteStore — version materialization", () => {
  test("create writes version = events.seq atomically; subsequent load reads it without MAX(seq) subquery", () => {
    const db = openTestDb();
    const store = createSqliteStore(widgetDecl);
    store.migrate(db);

    const { snapshot } = store.create(db, {
      initial: { id: "w1", status: "pending", version: 0, assignee: "alice", room: "default", created_at: 1_000 },
      eventKind: "widget.new",
      actor: "human",
      at: 1_000,
      payload: () => ({}),
    });
    expect(snapshot.version).toBeGreaterThan(0);

    const eventSeq = db.query<{ seq: number }, [string]>(`SELECT seq FROM events WHERE entity_id = ?`).get("w1");
    expect(snapshot.version).toBe(eventSeq!.seq);

    const reloaded = store.load(db, "w1");
    expect(reloaded?.version).toBe(snapshot.version);
  });

  test("transact UPDATE writes version = new events.seq atomically", () => {
    const db = openTestDb();
    const store = createSqliteStore(widgetDecl);
    store.migrate(db);

    const { snapshot: created } = store.create(db, {
      initial: { id: "w1", status: "pending", version: 0, assignee: "alice", room: "default", created_at: 1_000 },
      eventKind: "widget.new",
      actor: "human",
      at: 1_000,
      payload: () => ({}),
    });

    const { snapshot: updated } = store.transact(db, {
      id: "w1",
      next: { status: "done" } as Partial<WidgetSnapshot>,
      eventKind: "widget.done",
      actor: "alice",
      at: 2_000,
      payload: () => ({ done: true }),
    });
    expect(updated.version).toBeGreaterThan(created.version);
    expect(updated.status).toBe("done");

    // Two events for w1, but the row's version column reflects the LAST one.
    const events = db
      .query<{ seq: number; kind: string }, [string]>(
        `SELECT seq, kind FROM events WHERE entity_id = ? ORDER BY seq`,
      )
      .all("w1");
    expect(events.length).toBe(2);
    expect(updated.version).toBe(events[1]!.seq);

    const reloaded = store.load(db, "w1");
    expect(reloaded?.version).toBe(updated.version);
  });
});

describe("createSqliteStore — sideEffect runs in same transaction", () => {
  test("sideEffect's tx handle can write to a sibling table; rollback if anything throws", () => {
    const db = openTestDb();
    db.exec(`CREATE TABLE nutshell (room TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    const store = createSqliteStore(widgetDecl);
    store.migrate(db);
    store.create(db, {
      initial: { id: "w1", status: "pending", version: 0, assignee: "alice", room: "default", created_at: 1_000 },
      eventKind: "widget.new",
      actor: "human",
      at: 1_000,
      payload: () => ({}),
    });

    store.transact(db, {
      id: "w1",
      next: { status: "done" } as Partial<WidgetSnapshot>,
      eventKind: "widget.done",
      actor: "alice",
      at: 2_000,
      payload: () => ({}),
      sideEffect: ({ tx, next }) => {
        tx.run(
          `INSERT INTO nutshell (room, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(room) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at`,
          [next.room, "patched by sideEffect", 2_000],
        );
      },
    });

    const nut = db.query<{ text: string }, [string]>(`SELECT text FROM nutshell WHERE room = ?`).get("default");
    expect(nut?.text).toBe("patched by sideEffect");
  });

  test("sideEffect throw rolls back the entire transaction (event + row + side write)", () => {
    const db = openTestDb();
    db.exec(`CREATE TABLE nutshell (room TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    const store = createSqliteStore(widgetDecl);
    store.migrate(db);
    store.create(db, {
      initial: { id: "w1", status: "pending", version: 0, assignee: "alice", room: "default", created_at: 1_000 },
      eventKind: "widget.new",
      actor: "human",
      at: 1_000,
      payload: () => ({}),
    });
    const versionBefore = store.load(db, "w1")!.version;
    const eventCountBefore = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events`).get()!.c;

    expect(() =>
      store.transact(db, {
        id: "w1",
        next: { status: "done" } as Partial<WidgetSnapshot>,
        eventKind: "widget.done",
        actor: "alice",
        at: 2_000,
        payload: () => ({}),
        sideEffect: () => {
          throw new Error("intentional failure");
        },
      }),
    ).toThrow("intentional failure");

    // Row unchanged, no new event written.
    const after = store.load(db, "w1");
    expect(after?.status).toBe("pending");
    expect(after?.version).toBe(versionBefore);
    const eventCountAfter = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events`).get()!.c;
    expect(eventCountAfter).toBe(eventCountBefore);
  });
});

describe("createInMemoryStore", () => {
  test("create + load + transact + listByStatus mirror the SQLite Store's observable behavior", () => {
    const fake = createInMemoryStore(widgetDecl);
    const fakeDb = null as unknown as Database; // ignored by in-memory store
    fake.migrate(fakeDb);

    const { snapshot: c1 } = fake.create(fakeDb, {
      initial: { id: "w1", status: "pending", version: 0, assignee: "alice", room: "default", created_at: 1_000 },
      eventKind: "widget.new",
      actor: "human",
      at: 1_000,
      payload: () => ({}),
    });
    expect(c1.version).toBe(1);

    const { snapshot: c2 } = fake.create(fakeDb, {
      initial: { id: "w2", status: "pending", version: 0, assignee: "alice", room: "default", created_at: 1_001 },
      eventKind: "widget.new",
      actor: "human",
      at: 1_001,
      payload: () => ({}),
    });
    expect(c2.version).toBe(2);

    const list = fake.listByStatus(fakeDb, { status: "pending", for: "alice" });
    expect(list.length).toBe(2);

    const { snapshot: u1 } = fake.transact(fakeDb, {
      id: "w1",
      next: { status: "done" } as Partial<WidgetSnapshot>,
      eventKind: "widget.done",
      actor: "alice",
      at: 2_000,
      payload: () => ({}),
    });
    expect(u1.version).toBe(3);
    expect(u1.status).toBe("done");

    const reloaded = fake.load(fakeDb, "w1");
    expect(reloaded?.status).toBe("done");
    expect(reloaded?.version).toBe(3);

    const stillPending = fake.listByStatus(fakeDb, { status: "pending", for: "alice" });
    expect(stillPending.length).toBe(1);
    expect(stillPending[0]!.id).toBe("w2");
  });
});
