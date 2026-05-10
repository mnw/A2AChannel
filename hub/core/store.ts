// store.ts — INTERNAL collaborator of LedgerEntity. NOT exported from any package barrel.
// Only `hub/core/ledger-entity.ts` should import from this file. Kind code (hub/kinds/*.ts)
// MUST NOT import Store, createSqliteStore, or createInMemoryStore directly — only
// createLedgerEntity, which captures the Store in closure and never re-exposes it.
//
// Honest seam acknowledgment (per LANGUAGE.md "two adapters means a real seam"):
// today there is one production adapter (createSqliteStore) and one test adapter
// (createInMemoryStore). The seam is hypothetical until a second production adapter
// (multi-process, Postgres, replicated) appears. Cost: ~150 LOC. Benefit: sub-ms verb
// tests + idempotency edge case coverage without SQLite fixtures. See ADR-0004.

import type { Database } from "bun:sqlite";
import type {
  Snapshot,
  StateMachineDecl,
  TxHandle,
  SideEffectCtx,
  ColumnType,
} from "./types";
import { insertEvent } from "./events";

// ---------- Store interface ----------

export type ListFilter = {
  status: string;
  for?: string;
  room?: string;
  limit?: number;
};

export type StoreTransaction<S extends Snapshot> = {
  /** Entity id. */
  id: string;
  /** Field changes for the derived row. `version` is set by the Store, do not include here. */
  next: Partial<S>;
  /** Event kind written to events.kind, e.g. "handoff.accepted". */
  eventKind: string;
  /** Actor written to events.actor. */
  actor: string;
  /** Wall-clock ms; caller-controlled for determinism in tests. */
  at: number;
  /** Event payload; receives the synthesized post-update snapshot (= prior + next). */
  payload: (post: S) => Record<string, unknown>;
  /** Optional same-transaction side effect; runs after derived-row UPDATE. */
  sideEffect?: (ctx: SideEffectCtx<S>) => unknown;
};

export type StoreInsert<S extends Snapshot> = {
  /** Initial snapshot for a brand-new row (status must be non-terminal start state). */
  initial: S;
  eventKind: string;
  actor: string;
  at: number;
  payload: (post: S) => Record<string, unknown>;
  sideEffect?: (ctx: SideEffectCtx<S>) => unknown;
};

export type Store<S extends Snapshot> = {
  /** Idempotent DDL; safe to call on every hub start. */
  migrate(db: Database): void;
  /** Primary-key lookup. Reads the `version` column directly — no MAX(seq) subquery. */
  load(db: Database, id: string): S | null;
  /** Single-query SELECT; uses (status, for_col) composite index. */
  listByStatus(db: Database, filter: ListFilter): S[];
  /** Atomic INSERT-row + INSERT-event; returns the post-create snapshot. */
  create(db: Database, c: StoreInsert<S>): { snapshot: S; sideEffectResult: unknown };
  /** Atomic UPDATE-row + INSERT-event + sideEffect; returns the post-transition snapshot. */
  transact(db: Database, t: StoreTransaction<S>): { snapshot: S; sideEffectResult: unknown };
};

// ---------- Helpers ----------

function sqliteType(t: ColumnType): string {
  switch (t) {
    case "TEXT":
      return "TEXT NOT NULL";
    case "INTEGER":
      return "INTEGER NOT NULL";
    case "JSON":
      return "TEXT"; // JSON stored as TEXT, nullable
    case "TEXT_NULL":
      return "TEXT";
    case "INTEGER_NULL":
      return "INTEGER";
  }
}

// Bun's SQLite db.run/query expects SQLQueryBindings; we widen via `as never` only on the
// outermost call site to keep the inner types honest.
type SqlParam = string | number | bigint | boolean | null | Uint8Array;

function makeTxHandle(db: Database): TxHandle {
  return {
    run(sql, params = []) {
      db.run(sql, params as SqlParam[]);
    },
    query<R = unknown>(sql: string, params: unknown[] = []) {
      return db.query<R, SqlParam[]>(sql).all(...(params as SqlParam[])) as R[];
    },
  };
}

// ---------- SQLite-backed Store ----------

export function createSqliteStore<S extends Snapshot>(decl: StateMachineDecl<S>): Store<S> {
  const tableQ = `"${decl.table.replace(/"/g, '""')}"`;
  const colNames = Object.keys(decl.columns);
  if (!colNames.includes("id")) {
    throw new Error(`store(${decl.kind}): columns must include "id"`);
  }
  if (!colNames.includes("status")) {
    throw new Error(`store(${decl.kind}): columns must include "status"`);
  }
  // version is added by the Store, not in the user-supplied columns map.
  if (colNames.includes("version")) {
    throw new Error(`store(${decl.kind}): "version" is reserved — Store manages it`);
  }

  const insertCols = ["id", ...colNames.filter((c) => c !== "id"), "version"];
  const insertPlaceholders = insertCols.map(() => "?").join(", ");
  const insertSql = `INSERT INTO ${tableQ} (${insertCols.map((c) => `"${c}"`).join(", ")}) VALUES (${insertPlaceholders})`;

  const ddl = (() => {
    const colDefs = [
      `"id" TEXT PRIMARY KEY`,
      ...colNames
        .filter((c) => c !== "id")
        .map((c) => `"${c}" ${sqliteType(decl.columns[c]!)}`),
      `"version" INTEGER NOT NULL DEFAULT 0`,
    ];
    return `CREATE TABLE IF NOT EXISTS ${tableQ} (${colDefs.join(", ")})`;
  })();

  const indexSql = decl.forColumn
    ? `CREATE INDEX IF NOT EXISTS "idx_${decl.table}_status_${decl.forColumn}" ON ${tableQ} ("status", "${decl.forColumn}")`
    : `CREATE INDEX IF NOT EXISTS "idx_${decl.table}_status" ON ${tableQ} ("status")`;

  function loadRow(db: Database, id: string): Record<string, unknown> | null {
    const row = db
      .query<Record<string, unknown>, [string]>(`SELECT * FROM ${tableQ} WHERE id = ?`)
      .get(id);
    return row ?? null;
  }

  function rowToSnap(row: Record<string, unknown>): S {
    const snap = decl.rowToSnapshot(row);
    // The store guarantees version is on the row; copy it into the snapshot if rowToSnapshot didn't.
    return { ...snap, version: Number(row.version ?? 0) };
  }

  return {
    migrate(db) {
      db.exec(ddl);
      db.exec(indexSql);
    },

    load(db, id) {
      const row = loadRow(db, id);
      return row ? rowToSnap(row) : null;
    },

    listByStatus(db, filter) {
      const limit = Math.max(1, Math.min(1000, filter.limit ?? 200));
      const where: string[] = [`"status" = ?`];
      const params: unknown[] = [filter.status];
      if (filter.for !== undefined && decl.forColumn) {
        where.push(`"${decl.forColumn}" = ?`);
        params.push(filter.for);
      }
      if (filter.room !== undefined) {
        where.push(`"room" = ?`);
        params.push(filter.room);
      }
      params.push(limit);
      const sql = `SELECT * FROM ${tableQ} WHERE ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`;
      const rows = db.query<Record<string, unknown>, SqlParam[]>(sql).all(...(params as SqlParam[]));
      return rows.map(rowToSnap);
    },

    create(db, c) {
      let result!: { snapshot: S; sideEffectResult: unknown };
      db.transaction(() => {
        const initialPayload = c.payload(c.initial);
        const seq = insertEvent(db, c.initial.id, c.eventKind, c.actor, initialPayload, c.at);
        const finalSnap: S = { ...c.initial, version: seq };
        const row = decl.snapshotToRow(finalSnap);
        const values = insertCols.map((col) =>
          col === "version" ? seq : col === "id" ? c.initial.id : row[col] ?? null,
        );
        db.run(insertSql, values as SqlParam[]);
        let sideEffectResult: unknown = null;
        if (c.sideEffect) {
          sideEffectResult = c.sideEffect({
            prior: finalSnap, // for create, prior == post
            next: finalSnap,
            seq,
            tx: makeTxHandle(db),
          });
        }
        result = { snapshot: finalSnap, sideEffectResult };
      })();
      return result;
    },

    transact(db, t) {
      let result!: { snapshot: S; sideEffectResult: unknown };
      db.transaction(() => {
        const priorRow = loadRow(db, t.id);
        if (!priorRow) {
          throw new Error(`store(${decl.kind}).transact: row ${t.id} not found`);
        }
        const prior = rowToSnap(priorRow);
        const synthPost: S = { ...prior, ...t.next };
        const eventPayload = t.payload(synthPost);
        const seq = insertEvent(db, t.id, t.eventKind, t.actor, eventPayload, t.at);
        const finalPost: S = { ...synthPost, version: seq };
        // UPDATE only the fields in `next` plus version.
        const setCols = Object.keys(t.next);
        if (setCols.length === 0) {
          db.run(`UPDATE ${tableQ} SET "version" = ? WHERE id = ?`, [seq, t.id]);
        } else {
          const finalRow = decl.snapshotToRow(finalPost);
          const sets = [...setCols, "version"];
          const setSql = sets.map((c) => `"${c}" = ?`).join(", ");
          const values = sets.map((c) => (c === "version" ? seq : finalRow[c] ?? null));
          db.run(`UPDATE ${tableQ} SET ${setSql} WHERE id = ?`, [...values, t.id] as SqlParam[]);
        }
        let sideEffectResult: unknown = null;
        if (t.sideEffect) {
          sideEffectResult = t.sideEffect({
            prior,
            next: finalPost,
            seq,
            tx: makeTxHandle(db),
          });
        }
        result = { snapshot: finalPost, sideEffectResult };
      })();
      return result;
    },
  };
}

// ---------- In-memory Store (test fake) ----------

export function createInMemoryStore<S extends Snapshot>(decl: StateMachineDecl<S>): Store<S> {
  const rows = new Map<string, S>();
  let seqCounter = 0;
  const events: { entity_id: string; kind: string; actor: string; payload: unknown; at: number; seq: number }[] = [];

  function nextSeq(): number {
    return ++seqCounter;
  }

  function makeFakeTxHandle(): TxHandle {
    return {
      run() {
        throw new Error(`InMemoryStore.tx.run is not supported — pass a real DB-backed Store for sideEffect tests`);
      },
      query() {
        throw new Error(`InMemoryStore.tx.query is not supported — pass a real DB-backed Store for sideEffect tests`);
      },
    };
  }

  return {
    migrate() {
      // No-op for in-memory; rows live in the Map.
    },

    load(_db, id) {
      const snap = rows.get(id);
      return snap ? { ...snap } : null;
    },

    listByStatus(_db, filter) {
      const limit = Math.max(1, Math.min(1000, filter.limit ?? 200));
      const out: S[] = [];
      for (const snap of rows.values()) {
        if (snap.status !== filter.status) continue;
        if (filter.for !== undefined && decl.forColumn) {
          const value = (snap as unknown as Record<string, unknown>)[decl.forColumn];
          if (value !== filter.for) continue;
        }
        if (filter.room !== undefined) {
          const value = (snap as unknown as Record<string, unknown>).room;
          if (value !== filter.room) continue;
        }
        out.push({ ...snap });
        if (out.length >= limit) break;
      }
      return out;
    },

    create(_db, c) {
      const seq = nextSeq();
      events.push({ entity_id: c.initial.id, kind: c.eventKind, actor: c.actor, payload: c.payload(c.initial), at: c.at, seq });
      const finalSnap: S = { ...c.initial, version: seq };
      rows.set(c.initial.id, finalSnap);
      let sideEffectResult: unknown = null;
      if (c.sideEffect) {
        sideEffectResult = c.sideEffect({
          prior: finalSnap,
          next: finalSnap,
          seq,
          tx: makeFakeTxHandle(),
        });
      }
      return { snapshot: { ...finalSnap }, sideEffectResult };
    },

    transact(_db, t) {
      const prior = rows.get(t.id);
      if (!prior) throw new Error(`store(${decl.kind}).transact: row ${t.id} not found`);
      const seq = nextSeq();
      const synthPost: S = { ...prior, ...t.next };
      events.push({ entity_id: t.id, kind: t.eventKind, actor: t.actor, payload: t.payload(synthPost), at: t.at, seq });
      const finalPost: S = { ...synthPost, version: seq };
      rows.set(t.id, finalPost);
      let sideEffectResult: unknown = null;
      if (t.sideEffect) {
        sideEffectResult = t.sideEffect({
          prior,
          next: finalPost,
          seq,
          tx: makeFakeTxHandle(),
        });
      }
      return { snapshot: { ...finalPost }, sideEffectResult };
    },
  };
}

