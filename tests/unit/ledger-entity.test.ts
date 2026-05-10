// Unit tests for hub/core/ledger-entity.ts — verifies the load → decide → transact → emit
// dispatcher dispatches each Decision arm correctly, that LedgerConflict surfaces with the
// right httpStatus, that sideEffect commits/rolls back atomically, and that the internal
// Store is not reachable via any property on the LedgerEntity instance.

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createLedgerEntity } from "../../hub/core/ledger-entity";
import { createSqliteStore, createInMemoryStore } from "../../hub/core/store";
import {
  LedgerConflict,
  type Snapshot,
  type StateMachineDecl,
  type VerbDecl,
  type HubCapabilities,
  type Entry,
  type Scope,
} from "../../hub/core/types";

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

type SseLog = { entry: Entry; scope: Scope }[];

function makeFakeCap(db: Database, sseLog: SseLog): HubCapabilities {
  return {
    db,
    agents: {
      get: () => null,
      isPermanent: () => false,
      all: () => [],
      ensure: () => null,
    },
    sse: {
      emit: (entry, scope) => {
        sseLog.push({ entry, scope });
      },
    },
    auth: {
      requireAuth: () => null,
      requireReadAuth: () => null,
      requireJsonBody: () => null,
    },
    events: {
      insert: () => {
        throw new Error("cap.events.insert should not be called from LedgerEntity tests; Store calls insertEvent directly");
      },
    },
    config: {
      humanName: "human",
      attachmentsDir: "/tmp",
      defaultRoom: "default",
    },
  };
}

// ---------- Verbs ----------

const createVerb: VerbDecl<WidgetSnapshot, { id: string; assignee: string; room: string }> = {
  decide(prior, payload, _actor) {
    if (prior) {
      // Same-id-already-exists: idempotent if same assignee, conflict otherwise.
      if (prior.assignee === payload.assignee) return { kind: "idempotent" };
      return { kind: "conflict", httpStatus: 409, message: `widget ${payload.id} already exists with different assignee` };
    }
    const initial: WidgetSnapshot = {
      id: payload.id,
      status: "pending",
      version: 0,
      assignee: payload.assignee,
      room: payload.room,
      created_at: 1_000,
    };
    return {
      kind: "create",
      initial,
      eventKind: "widget.new",
      payload: () => ({ assignee: payload.assignee }),
      entry: (post) => ({ kind: "widget.new", id: post.id, version: post.version, snapshot: post }),
    };
  },
  scope: (_post) => ({ kind: "broadcast" }),
};

const completeVerb: VerbDecl<WidgetSnapshot, { by: string }> = {
  decide(prior, payload, _actor) {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    // Same-status retry: idempotent.
    if (prior.status === "done") return { kind: "idempotent" };
    // Different terminal: 409.
    if (prior.status !== "pending") {
      return { kind: "conflict", httpStatus: 409, message: `widget already ${prior.status}` };
    }
    return {
      kind: "transition",
      next: { status: "done" } as Partial<WidgetSnapshot>,
      eventKind: "widget.done",
      payload: () => ({ by: payload.by }),
      entry: (post) => ({ kind: "widget.done", id: post.id, version: post.version, snapshot: post }),
    };
  },
  scope: (post) => ({ kind: "to-agents", agents: [post.assignee] }),
};

const cancelVerb: VerbDecl<WidgetSnapshot, { by: string }> = {
  decide(prior, payload, _actor) {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (prior.status === "cancelled") return { kind: "idempotent" };
    if (prior.status !== "pending") {
      return { kind: "conflict", httpStatus: 409, message: `widget already ${prior.status}` };
    }
    return {
      kind: "transition",
      next: { status: "cancelled" } as Partial<WidgetSnapshot>,
      eventKind: "widget.cancelled",
      payload: () => ({ by: payload.by }),
      entry: (post) => ({ kind: "widget.cancelled", id: post.id, version: post.version, snapshot: post }),
    };
  },
  scope: () => ({ kind: "broadcast" }),
};

// ---------- Tests ----------

describe("createLedgerEntity — Decision dispatch", () => {
  test("create arm: INSERT row + emit broadcast + return emitted=true", () => {
    const db = openTestDb();
    const sse: SseLog = [];
    const cap = makeFakeCap(db, sse);
    const entity = createLedgerEntity({ decl: widgetDecl, db });
    entity.migrate(db);

    const r = entity.apply("w1", createVerb, { id: "w1", assignee: "alice", room: "default" }, "alice", cap);
    expect(r.emitted).toBe(true);
    expect(r.snapshot.id).toBe("w1");
    expect(r.snapshot.status).toBe("pending");
    expect(r.version).toBeGreaterThan(0);
    expect(sse.length).toBe(1);
    expect(sse[0]!.entry.kind).toBe("widget.new");
    expect(sse[0]!.scope).toEqual({ kind: "broadcast" });
  });

  test("transition arm: UPDATE row + emit broadcast", () => {
    const db = openTestDb();
    const sse: SseLog = [];
    const cap = makeFakeCap(db, sse);
    const entity = createLedgerEntity({ decl: widgetDecl, db });
    entity.migrate(db);
    entity.apply("w1", createVerb, { id: "w1", assignee: "alice", room: "default" }, "alice", cap);
    sse.length = 0;

    const r = entity.apply("w1", completeVerb, { by: "alice" }, "alice", cap);
    expect(r.emitted).toBe(true);
    expect(r.snapshot.status).toBe("done");
    expect(sse.length).toBe(1);
    expect(sse[0]!.entry.kind).toBe("widget.done");
    expect(sse[0]!.scope).toEqual({ kind: "to-agents", agents: ["alice"] });
  });

  test("idempotent arm: NO event written, NO broadcast, returns emitted=false + prior snapshot", () => {
    const db = openTestDb();
    const sse: SseLog = [];
    const cap = makeFakeCap(db, sse);
    const entity = createLedgerEntity({ decl: widgetDecl, db });
    entity.migrate(db);
    entity.apply("w1", createVerb, { id: "w1", assignee: "alice", room: "default" }, "alice", cap);
    entity.apply("w1", completeVerb, { by: "alice" }, "alice", cap);
    const eventCountBefore = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events`).get()!.c;
    sse.length = 0;

    // Same-status retry — should be idempotent.
    const r = entity.apply("w1", completeVerb, { by: "alice" }, "alice", cap);
    expect(r.emitted).toBe(false);
    expect(r.snapshot.status).toBe("done");
    expect(sse.length).toBe(0);
    const eventCountAfter = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events`).get()!.c;
    expect(eventCountAfter).toBe(eventCountBefore);
  });

  test("conflict arm (different terminal): throws LedgerConflict with httpStatus=409", () => {
    const db = openTestDb();
    const sse: SseLog = [];
    const cap = makeFakeCap(db, sse);
    const entity = createLedgerEntity({ decl: widgetDecl, db });
    entity.migrate(db);
    entity.apply("w1", createVerb, { id: "w1", assignee: "alice", room: "default" }, "alice", cap);
    entity.apply("w1", completeVerb, { by: "alice" }, "alice", cap);
    sse.length = 0;

    let caught: LedgerConflict | null = null;
    try {
      entity.apply("w1", cancelVerb, { by: "alice" }, "alice", cap);
    } catch (e) {
      caught = e as LedgerConflict;
    }
    expect(caught).toBeInstanceOf(LedgerConflict);
    expect(caught!.httpStatus).toBe(409);
    expect(caught!.message).toContain("done");
    expect(caught!.snapshot?.status).toBe("done");
    expect(sse.length).toBe(0);
  });

  test("conflict arm (not found): throws LedgerConflict with httpStatus=404", () => {
    const db = openTestDb();
    const sse: SseLog = [];
    const cap = makeFakeCap(db, sse);
    const entity = createLedgerEntity({ decl: widgetDecl, db });
    entity.migrate(db);

    let caught: LedgerConflict | null = null;
    try {
      entity.apply("missing", completeVerb, { by: "alice" }, "alice", cap);
    } catch (e) {
      caught = e as LedgerConflict;
    }
    expect(caught).toBeInstanceOf(LedgerConflict);
    expect(caught!.httpStatus).toBe(404);
    expect(caught!.snapshot).toBeNull();
  });
});

describe("createLedgerEntity — sideEffect coupling", () => {
  test("applyWithSideEffect runs sideEffect inside the same transaction; result returned to caller", () => {
    const db = openTestDb();
    db.exec(`CREATE TABLE nutshell (room TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    const sse: SseLog = [];
    const cap = makeFakeCap(db, sse);
    const entity = createLedgerEntity({ decl: widgetDecl, db });
    entity.migrate(db);
    entity.apply("w1", createVerb, { id: "w1", assignee: "alice", room: "default" }, "alice", cap);

    const r = entity.applyWithSideEffect(
      "w1",
      completeVerb,
      { by: "alice" },
      "alice",
      cap,
      ({ tx, next }) => {
        tx.run(
          `INSERT INTO nutshell (room, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(room) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at`,
          [next.room, "from sideEffect", 9_999],
        );
        return { wrote: next.room };
      },
    );

    expect(r.emitted).toBe(true);
    expect(r.sideEffectResult).toEqual({ wrote: "default" });
    const nut = db.query<{ text: string }, [string]>(`SELECT text FROM nutshell WHERE room = ?`).get("default");
    expect(nut?.text).toBe("from sideEffect");
  });

  test("sideEffect throw rolls back the entire transaction (row, event, side write)", () => {
    const db = openTestDb();
    db.exec(`CREATE TABLE nutshell (room TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    const sse: SseLog = [];
    const cap = makeFakeCap(db, sse);
    const entity = createLedgerEntity({ decl: widgetDecl, db });
    entity.migrate(db);
    entity.apply("w1", createVerb, { id: "w1", assignee: "alice", room: "default" }, "alice", cap);
    const versionBefore = entity.load("w1")!.version;
    const eventCountBefore = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events`).get()!.c;
    sse.length = 0;

    expect(() =>
      entity.applyWithSideEffect("w1", completeVerb, { by: "alice" }, "alice", cap, () => {
        throw new Error("intentional");
      }),
    ).toThrow("intentional");

    const after = entity.load("w1");
    expect(after?.status).toBe("pending");
    expect(after?.version).toBe(versionBefore);
    const eventCountAfter = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events`).get()!.c;
    expect(eventCountAfter).toBe(eventCountBefore);
    // No SSE emit because the transaction failed before the cap.sse.emit call.
    expect(sse.length).toBe(0);
  });
});

describe("createLedgerEntity — Store encapsulation (per ledger-store/spec.md)", () => {
  test("entity instance does NOT expose store, unsafeStore, or any property holding a Store reference", () => {
    const db = openTestDb();
    const entity = createLedgerEntity({ decl: widgetDecl, db });
    expect((entity as Record<string, unknown>).store).toBeUndefined();
    expect((entity as Record<string, unknown>).unsafeStore).toBeUndefined();
    expect((entity as Record<string, unknown>)._store).toBeUndefined();
    // Sanity: only the documented LedgerEntity interface methods exist.
    const keys = Object.keys(entity).sort();
    expect(keys).toEqual(["apply", "applyWithSideEffect", "listByStatus", "load", "migrate"]);
  });

  test("createLedgerEntity accepts an in-memory Store override; entity behavior matches SQLite-backed", () => {
    const fakeStore = createInMemoryStore(widgetDecl);
    const sse: SseLog = [];
    // The cap.db is unused by the in-memory store but still supplied by the framework.
    const cap = makeFakeCap(null as unknown as Database, sse);
    const entity = createLedgerEntity({ decl: widgetDecl, db: null as unknown as Database, store: fakeStore });

    entity.apply("w1", createVerb, { id: "w1", assignee: "alice", room: "default" }, "alice", cap);
    entity.apply("w1", completeVerb, { by: "alice" }, "alice", cap);
    const loaded = entity.load("w1");
    expect(loaded?.status).toBe("done");

    // The TEST holds the fakeStore reference (passed in to createLedgerEntity) and uses it
    // to assert state — the entity itself never re-exposes it.
    const direct = fakeStore.load(null as unknown as Database, "w1");
    expect(direct?.status).toBe("done");
  });
});

describe("createLedgerEntity — listByStatus delegation", () => {
  test("listByStatus filters by status + for via the underlying Store; results carry materialized version", () => {
    const db = openTestDb();
    const sse: SseLog = [];
    const cap = makeFakeCap(db, sse);
    const entity = createLedgerEntity({ decl: widgetDecl, db });
    entity.migrate(db);

    entity.apply("w1", createVerb, { id: "w1", assignee: "alice", room: "default" }, "alice", cap);
    entity.apply("w2", createVerb, { id: "w2", assignee: "alice", room: "default" }, "alice", cap);
    entity.apply("w3", createVerb, { id: "w3", assignee: "bob", room: "default" }, "alice", cap);
    entity.apply("w1", completeVerb, { by: "alice" }, "alice", cap);

    const pendingForAlice = entity.listByStatus({ status: "pending", for: "alice" });
    expect(pendingForAlice.length).toBe(1);
    expect(pendingForAlice[0]!.id).toBe("w2");
    expect(pendingForAlice[0]!.version).toBeGreaterThan(0);

    const pendingForBob = entity.listByStatus({ status: "pending", for: "bob" });
    expect(pendingForBob.length).toBe(1);
    expect(pendingForBob[0]!.id).toBe("w3");
  });
});
