// Interrupt kind — high-visibility "stop and re-read this" flags.
// Lifecycle: pending → acknowledged (terminal). No cancel, no expire.
//
// v0.9.5 §5: first extraction from the monolithic hub.ts. Implements the
// KindModule contract from core/types.ts. Schema migration lives historically
// in core/ledger.ts (v2 migration created the `interrupts` table; v6 added the
// `room` column). The `migrate` hook here is a no-op for now — v0.9.5 keeps
// migration history frozen; per-kind migration lifts are a future cleanup.

import type { Database } from "bun:sqlite";
import type {
  AgentCtx,
  Entry,
  HubCapabilities,
  KindModule,
  RouteDef,
  Scope,
} from "../core/types";
import { insertEvent } from "../core/events";
import { mintInterruptId, ts, validName, validRoomLabel } from "../core/ids";

// ---------- Types ----------

export type InterruptStatus = "pending" | "acknowledged";

export type InterruptSnapshot = {
  id: string;
  from_agent: string;
  to_agent: string;
  text: string;
  status: InterruptStatus;
  created_at_ms: number;
  acknowledged_at_ms: number | null;
  acknowledged_by: string | null;
  room: string;
  version: number;
};

type InterruptRow = {
  id: string;
  from_agent: string;
  to_agent: string;
  text: string;
  status: InterruptStatus;
  created_at_ms: number;
  acknowledged_at_ms: number | null;
  acknowledged_by: string | null;
  room: string;
};

const INTERRUPT_ID_RE = /^i_[0-9a-f]{16}$/;
const INTERRUPT_TEXT_MAX_CHARS = 500;

// ---------- State machine ----------

function rowToSnapshot(row: InterruptRow, version: number): InterruptSnapshot {
  return {
    id: row.id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    text: row.text,
    status: row.status,
    created_at_ms: row.created_at_ms,
    acknowledged_at_ms: row.acknowledged_at_ms,
    acknowledged_by: row.acknowledged_by,
    room: row.room,
    version,
  };
}

function loadInterrupt(db: Database, id: string): { row: InterruptRow; version: number } | null {
  const row = db
    .query<InterruptRow, [string]>("SELECT * FROM interrupts WHERE id = ?")
    .get(id);
  if (!row) return null;
  const verRow = db
    .query<{ max_seq: number | null }, [string]>(
      "SELECT MAX(seq) AS max_seq FROM events WHERE entity_id = ?",
    )
    .get(id);
  return { row, version: verRow?.max_seq ?? 0 };
}

function snapshotInterrupt(db: Database, id: string): InterruptSnapshot | null {
  const loaded = loadInterrupt(db, id);
  return loaded ? rowToSnapshot(loaded.row, loaded.version) : null;
}

type CreateInput = { from: string; to: string; text: string; room: string };

function createInterrupt(db: Database, input: CreateInput): InterruptSnapshot {
  const id = mintInterruptId();
  const now = Date.now();
  db.transaction(() => {
    insertEvent(db, id, "interrupt.new", input.from, { to: input.to, text: input.text }, now);
    db.run(
      `INSERT INTO interrupts (id, from_agent, to_agent, text, status, created_at_ms, room)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [id, input.from, input.to, input.text, now, input.room],
    );
  })();
  return snapshotInterrupt(db, id)!;
}

type AckOutcome =
  | { kind: "transition"; snapshot: InterruptSnapshot }
  | { kind: "idempotent"; snapshot: InterruptSnapshot }
  | { kind: "conflict"; current_status: InterruptStatus; snapshot: InterruptSnapshot }
  | { kind: "not_found" }
  | { kind: "forbidden"; reason: string };

function ackInterrupt(db: Database, id: string, by: string, humanName: string): AckOutcome {
  const loaded = loadInterrupt(db, id);
  if (!loaded) return { kind: "not_found" };
  // Recipient or human can ack — human may ack on behalf of a non-responding agent.
  if (loaded.row.to_agent !== by && by !== humanName) {
    return { kind: "forbidden", reason: "not the recipient" };
  }
  if (loaded.row.status === "acknowledged") {
    return { kind: "idempotent", snapshot: rowToSnapshot(loaded.row, loaded.version) };
  }
  if (loaded.row.status !== "pending") {
    return {
      kind: "conflict",
      current_status: loaded.row.status,
      snapshot: rowToSnapshot(loaded.row, loaded.version),
    };
  }
  const now = Date.now();
  db.transaction(() => {
    insertEvent(db, id, "interrupt.ack", by, {}, now);
    db.run(
      "UPDATE interrupts SET status = 'acknowledged', acknowledged_at_ms = ?, acknowledged_by = ? WHERE id = ?",
      [now, by, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotInterrupt(db, id)! };
}

type ListFilter = {
  status?: InterruptStatus | "all";
  for?: string;
  limit?: number;
};

function listInterrupts(db: Database, filter: ListFilter = {}): InterruptSnapshot[] {
  const status = filter.status ?? "pending";
  const limit = Math.max(1, Math.min(1000, filter.limit ?? 100));
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (status !== "all") {
    clauses.push("status = ?");
    params.push(status);
  }
  if (filter.for) {
    clauses.push("(to_agent = ? OR from_agent = ?)");
    params.push(filter.for, filter.for);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  const rows = db
    .query<InterruptRow, typeof params>(
      `SELECT * FROM interrupts ${where} ORDER BY created_at_ms DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map((row) => {
    const ver = db
      .query<{ max_seq: number | null }, [string]>(
        "SELECT MAX(seq) AS max_seq FROM events WHERE entity_id = ?",
      )
      .get(row.id);
    return rowToSnapshot(row, ver?.max_seq ?? 0);
  });
}

// ---------- Entry + broadcast ----------

export function interruptEntry(
  snapshot: InterruptSnapshot,
  eventKind: "interrupt.new" | "interrupt.ack",
  replay = false,
): Entry {
  return {
    from: snapshot.from_agent,
    to: snapshot.to_agent,
    text: JSON.stringify(snapshot),
    ts: ts(),
    image: null,
    room: snapshot.room,
    kind: eventKind,
    interrupt_id: snapshot.id,
    version: snapshot.version,
    replay,
    snapshot,
  };
}

function broadcastAck(cap: HubCapabilities, snapshot: InterruptSnapshot): void {
  // Ack notifies both parties; create-time notifies recipient only (via the
  // create route's own broadcast — handled inline there to keep bulk semantics).
  cap.sse.emit(interruptEntry(snapshot, "interrupt.ack"), {
    kind: "to-agents",
    agents: [snapshot.from_agent, snapshot.to_agent],
  });
}

// ---------- Route handlers ----------

function outcomeResponse(outcome: AckOutcome, cap: HubCapabilities): Response {
  switch (outcome.kind) {
    case "not_found":
      return Response.json({ error: "not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: outcome.reason }, { status: 403 });
    case "conflict":
      return Response.json(
        { error: `interrupt already ${outcome.current_status}`, snapshot: outcome.snapshot },
        { status: 409 },
      );
    case "idempotent":
      return Response.json({ snapshot: outcome.snapshot, idempotent: true }, { status: 200 });
    case "transition":
      broadcastAck(cap, outcome.snapshot);
      return Response.json({ snapshot: outcome.snapshot }, { status: 200 });
  }
}

const routes: RouteDef[] = [
  {
    method: "POST",
    path: "/interrupts",
    auth: "mutating",
    handler: async (req, cap) => {
      const body = (await req.json().catch(() => ({}))) as {
        from?: string;
        to?: string;
        text?: string;
        rooms?: string[];
      };
      const from = (body.from ?? "").trim();
      const text = (body.text ?? "").trim();
      if (!validName(from)) return Response.json({ error: "invalid from" }, { status: 400 });
      if (!text) return Response.json({ error: "text required" }, { status: 400 });
      if (text.length > INTERRUPT_TEXT_MAX_CHARS) {
        return Response.json(
          { error: `text too long (max ${INTERRUPT_TEXT_MAX_CHARS})` },
          { status: 400 },
        );
      }
      cap.agents.ensure?.(from);

      // Bulk shape: { from, rooms: [...], text } — human-only, fans out one interrupt per
      // non-human agent in each named room. Response maps room → created interrupt IDs.
      if (Array.isArray(body.rooms)) {
        if (from !== cap.config.humanName) {
          return Response.json({ error: "bulk interrupt restricted to human" }, { status: 403 });
        }
        const created: Array<{ room: string; interrupts: string[] }> = [];
        for (const roomRaw of body.rooms) {
          const room = typeof roomRaw === "string" ? roomRaw.trim() : "";
          if (!validRoomLabel(room)) continue;
          const ids: string[] = [];
          for (const a of cap.agents.all()) {
            if (a.room !== room) continue; // skip human (room=null) and other rooms
            const snapshot = createInterrupt(cap.db, { from, to: a.name, text, room });
            cap.sse.emit(interruptEntry(snapshot, "interrupt.new"), {
              kind: "to-agents",
              agents: [snapshot.to_agent],
            });
            ids.push(snapshot.id);
          }
          created.push({ room, interrupts: ids });
        }
        return Response.json({ created }, { status: 201 });
      }

      // Single-recipient shape.
      const to = (body.to ?? "").trim();
      if (!validName(to)) return Response.json({ error: "invalid to" }, { status: 400 });
      const toAgent = cap.agents.get(to);
      if (!toAgent) {
        return Response.json(
          {
            error: `unknown recipient: ${to} (must be a currently-registered agent or "${cap.config.humanName}")`,
          },
          { status: 400 },
        );
      }
      const fromAgent = cap.agents.get(from);
      if (!fromAgent) return Response.json({ error: "invalid from" }, { status: 400 });
      if (fromAgent.room !== null && toAgent.room !== null && fromAgent.room !== toAgent.room) {
        return Response.json({ error: "cross-room interrupt not permitted" }, { status: 403 });
      }
      const interruptRoom = fromAgent.room ?? toAgent.room ?? cap.config.defaultRoom;
      const snapshot = createInterrupt(cap.db, { from, to, text, room: interruptRoom });
      cap.sse.emit(interruptEntry(snapshot, "interrupt.new"), {
        kind: "to-agents",
        agents: [snapshot.to_agent],
      });
      return Response.json({ id: snapshot.id }, { status: 201 });
    },
  },

  {
    method: "POST",
    path: /^\/interrupts\/([^/]+)\/ack$/,
    auth: "mutating",
    handler: async (req, cap, params) => {
      const id = params.id;
      if (!INTERRUPT_ID_RE.test(id)) {
        return Response.json({ error: "invalid interrupt id" }, { status: 400 });
      }
      const body = (await req.json().catch(() => ({}))) as { by?: string };
      const by = (body.by ?? "").trim();
      if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
      return outcomeResponse(ackInterrupt(cap.db, id, by, cap.config.humanName), cap);
    },
  },

  {
    method: "GET",
    path: "/interrupts",
    auth: "read",
    handler: (req, cap) => {
      const url = new URL(req.url);
      const statusParam = url.searchParams.get("status") ?? "pending";
      const forParam = url.searchParams.get("for") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : 100;

      const validStatus = new Set(["pending", "acknowledged", "all"]);
      if (!validStatus.has(statusParam)) {
        return Response.json({ error: `invalid status: ${statusParam}` }, { status: 400 });
      }
      if (forParam !== undefined && !validName(forParam)) {
        return Response.json({ error: `invalid for: ${forParam}` }, { status: 400 });
      }
      if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
        return Response.json({ error: "invalid limit" }, { status: 400 });
      }
      return Response.json(
        listInterrupts(cap.db, {
          status: statusParam as InterruptStatus | "all",
          for: forParam,
          limit,
        }),
      );
    },
  },
];

// ---------- KindModule export ----------

function pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[] {
  return listInterrupts(cap.db, { status: "pending", for: agent.name, limit: 1000 }).map((s) =>
    interruptEntry(s, "interrupt.new", true),
  );
}

export const interruptKind: KindModule = {
  kind: "interrupt",
  migrate: () => {
    // Interrupts schema is owned by core/ledger.ts historical migrations (v2, v6).
    // v0.9.5 §5 keeps migration history frozen — per-kind migration lifts are a
    // future cleanup after all kinds extract.
  },
  routes,
  pendingFor,
  toolNames: ["send_interrupt", "ack_interrupt"],
};

// Re-export the things hub.ts still needs during the intermediate state (§5-§9).
// These disappear from the public surface once the orchestrator takes over
// routing and replay (§9).
export {
  createInterrupt,
  ackInterrupt,
  listInterrupts,
  snapshotInterrupt,
  loadInterrupt,
  rowToSnapshot as interruptRowToSnapshot,
  INTERRUPT_TEXT_MAX_CHARS,
  INTERRUPT_ID_RE,
};
export type { ListFilter as ListInterruptsFilter, AckOutcome as InterruptOutcome };
