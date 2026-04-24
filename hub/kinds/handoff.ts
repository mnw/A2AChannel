// Handoff kind — typed work transfer with a full state machine.
// Lifecycle: pending → accepted | declined | cancelled | expired (all terminal).
// The most elaborate of the three kinds: TTL expiry sweep, nutshell-patch-on-
// accept coupling, and four verbs (send/accept/decline/cancel) plus the
// background expire pass.

import type { Database } from "bun:sqlite";
import type {
  AgentCtx,
  Entry,
  HubCapabilities,
  KindModule,
  RouteDef,
} from "../core/types";
import { insertEvent } from "../core/events";
import { mintHandoffId, ts, validName, validRoomLabel } from "../core/ids";
import {
  writeNutshellInTx,
  nutshellEntry,
  type NutshellSnapshot,
} from "../nutshell";

// ---------- Types ----------

export type HandoffStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

const HANDOFF_STATUS_FILTERS = new Set<HandoffStatus | "all">([
  "pending", "accepted", "declined", "cancelled", "expired", "all",
]);
function isHandoffStatusFilter(s: string): s is HandoffStatus | "all" {
  return (HANDOFF_STATUS_FILTERS as Set<string>).has(s);
}

export type HandoffSnapshot = {
  id: string;
  from_agent: string;
  to_agent: string;
  task: string;
  context: unknown;
  status: HandoffStatus;
  decline_reason: string | null;
  comment: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  resolved_at_ms: number | null;
  room: string;
  version: number;
};

type HandoffRow = {
  id: string;
  from_agent: string;
  to_agent: string;
  task: string;
  context_json: string | null;
  status: HandoffStatus;
  decline_reason: string | null;
  comment: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  resolved_at_ms: number | null;
  room: string;
};

const HANDOFF_ID_RE = /^h_[0-9a-f]{16}$/;
const HANDOFF_TTL_MIN_SECONDS = 1;
const HANDOFF_TTL_MAX_SECONDS = 86_400;
const HANDOFF_TTL_DEFAULT_SECONDS = 3_600;
const HANDOFF_CONTEXT_MAX_BYTES = 1_048_576;
const HANDOFF_TASK_MAX_CHARS = 500;
const HANDOFF_REASON_MAX_CHARS = 500;
const HANDOFF_BODY_MAX = 1_048_576;

// ---------- State machine ----------

function rowToSnapshot(row: HandoffRow, version: number): HandoffSnapshot {
  return {
    id: row.id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    task: row.task,
    context: row.context_json ? JSON.parse(row.context_json) : null,
    status: row.status,
    decline_reason: row.decline_reason,
    comment: row.comment,
    cancel_reason: row.cancel_reason,
    cancelled_by: row.cancelled_by,
    created_at_ms: row.created_at_ms,
    expires_at_ms: row.expires_at_ms,
    resolved_at_ms: row.resolved_at_ms,
    room: row.room,
    version,
  };
}

function loadHandoff(db: Database, id: string): { row: HandoffRow; version: number } | null {
  const row = db.query<HandoffRow, [string]>("SELECT * FROM handoffs WHERE id = ?").get(id);
  if (!row) return null;
  const verRow = db
    .query<{ max_seq: number | null }, [string]>(
      "SELECT MAX(seq) AS max_seq FROM events WHERE entity_id = ?",
    )
    .get(id);
  return { row, version: verRow?.max_seq ?? 0 };
}

function snapshotHandoff(db: Database, id: string): HandoffSnapshot | null {
  const loaded = loadHandoff(db, id);
  return loaded ? rowToSnapshot(loaded.row, loaded.version) : null;
}

type CreateInput = {
  from: string;
  to: string;
  task: string;
  context?: unknown;
  ttl_seconds?: number;
  room: string;
};

function createHandoff(db: Database, input: CreateInput): HandoffSnapshot {
  const id = mintHandoffId();
  const now = Date.now();
  const ttl = input.ttl_seconds ?? HANDOFF_TTL_DEFAULT_SECONDS;
  const expires_at = now + ttl * 1000;
  const contextJson = input.context !== undefined ? JSON.stringify(input.context) : null;
  db.transaction(() => {
    insertEvent(
      db,
      id,
      "handoff.created",
      input.from,
      { to: input.to, task: input.task, context: input.context ?? null, ttl_seconds: ttl },
      now,
    );
    db.run(
      `INSERT INTO handoffs
         (id, from_agent, to_agent, task, context_json, status,
          created_at_ms, expires_at_ms, room)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [id, input.from, input.to, input.task, contextJson, now, expires_at, input.room],
    );
  })();
  return snapshotHandoff(db, id)!;
}

export type HandoffOutcome =
  | { kind: "transition"; snapshot: HandoffSnapshot }
  | { kind: "idempotent"; snapshot: HandoffSnapshot }
  | { kind: "conflict"; current_status: HandoffStatus; snapshot: HandoffSnapshot }
  | { kind: "not_found" }
  | { kind: "forbidden"; reason: string };

// Accept returns BOTH the handoff outcome AND an optional nutshell snapshot when
// the handoff was a nutshell-edit proposal. The route handler broadcasts the
// nutshell separately after the transaction commits.
type AcceptResult = {
  outcome: HandoffOutcome;
  nutshell: NutshellSnapshot | null;
};

function acceptHandoff(
  db: Database,
  id: string,
  by: string,
  comment: string | undefined,
  humanName: string,
): AcceptResult {
  const loaded = loadHandoff(db, id);
  if (!loaded) return { outcome: { kind: "not_found" }, nutshell: null };
  if (loaded.row.to_agent !== by) {
    return { outcome: { kind: "forbidden", reason: "not the recipient" }, nutshell: null };
  }
  if (loaded.row.status === "accepted") {
    return {
      outcome: { kind: "idempotent", snapshot: rowToSnapshot(loaded.row, loaded.version) },
      nutshell: null,
    };
  }
  if (loaded.row.status !== "pending") {
    return {
      outcome: {
        kind: "conflict",
        current_status: loaded.row.status,
        snapshot: rowToSnapshot(loaded.row, loaded.version),
      },
      nutshell: null,
    };
  }
  const now = Date.now();
  let nutshellSnapshot: NutshellSnapshot | null = null;

  // Nutshell proposals (task prefix "[nutshell]") apply context.patch in the same tx as accept.
  const isNutshellEdit =
    loaded.row.task.startsWith("[nutshell]") &&
    loaded.row.to_agent === humanName &&
    loaded.row.context_json !== null;
  let nutshellPatch: string | null = null;
  let nutshellRoom: string = loaded.row.room;
  if (isNutshellEdit) {
    try {
      const ctx = JSON.parse(loaded.row.context_json!);
      if (ctx && typeof ctx === "object" && typeof ctx.patch === "string") {
        nutshellPatch = ctx.patch;
        // Explicit context.room wins over handoff.room, but only when the sender
        // can speak for that room (sender is human, or context.room matches handoff.room).
        if (typeof ctx.room === "string" && validRoomLabel(ctx.room)) {
          if (ctx.room === loaded.row.room || loaded.row.from_agent === humanName) {
            nutshellRoom = ctx.room;
          } else {
            nutshellPatch = null;  // cross-room edit by non-human → drop patch
          }
        }
      }
    } catch {
      // Malformed context — accept the handoff but skip the nutshell patch.
    }
  }

  db.transaction(() => {
    insertEvent(db, id, "handoff.accepted", by, { comment: comment ?? null }, now);
    db.run(
      "UPDATE handoffs SET status='accepted', comment=?, resolved_at_ms=? WHERE id=?",
      [comment ?? null, now, id],
    );
    if (nutshellPatch !== null) {
      nutshellSnapshot = writeNutshellInTx(db, nutshellRoom, nutshellPatch, loaded.row.from_agent);
    }
  })();

  return {
    outcome: { kind: "transition", snapshot: snapshotHandoff(db, id)! },
    nutshell: nutshellSnapshot,
  };
}

function declineHandoff(db: Database, id: string, by: string, reason: string): HandoffOutcome {
  const loaded = loadHandoff(db, id);
  if (!loaded) return { kind: "not_found" };
  if (loaded.row.to_agent !== by) {
    return { kind: "forbidden", reason: "not the recipient" };
  }
  if (loaded.row.status === "declined") {
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
    insertEvent(db, id, "handoff.declined", by, { reason }, now);
    db.run(
      "UPDATE handoffs SET status='declined', decline_reason=?, resolved_at_ms=? WHERE id=?",
      [reason, now, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotHandoff(db, id)! };
}

function cancelHandoff(
  db: Database,
  id: string,
  by: string,
  reason: string | undefined,
  humanName: string,
): HandoffOutcome {
  const loaded = loadHandoff(db, id);
  if (!loaded) return { kind: "not_found" };
  if (loaded.row.from_agent !== by && by !== humanName) {
    return { kind: "forbidden", reason: "not the sender" };
  }
  if (loaded.row.status === "cancelled") {
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
    insertEvent(db, id, "handoff.cancelled", by, { reason: reason ?? null }, now);
    db.run(
      "UPDATE handoffs SET status='cancelled', cancel_reason=?, cancelled_by=?, resolved_at_ms=? WHERE id=?",
      [reason ?? null, by, now, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotHandoff(db, id)! };
}

export function expireHandoff(db: Database, id: string): HandoffSnapshot | null {
  const loaded = loadHandoff(db, id);
  if (!loaded || loaded.row.status !== "pending") return null;
  const now = Date.now();
  db.transaction(() => {
    insertEvent(db, id, "handoff.expired", "system", {}, now);
    db.run(
      "UPDATE handoffs SET status='expired', resolved_at_ms=? WHERE id=?",
      [now, id],
    );
  })();
  return snapshotHandoff(db, id);
}

export function findExpirable(db: Database, nowMs: number): string[] {
  const rows = db
    .query<{ id: string }, [number]>(
      "SELECT id FROM handoffs WHERE status='pending' AND expires_at_ms < ?",
    )
    .all(nowMs);
  return rows.map((r) => r.id);
}

type ListFilter = {
  status?: HandoffStatus | "all";
  for?: string;
  limit?: number;
};

function listHandoffs(db: Database, filter: ListFilter = {}): HandoffSnapshot[] {
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
    .query<HandoffRow, typeof params>(
      `SELECT * FROM handoffs ${where} ORDER BY created_at_ms DESC LIMIT ?`,
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

// ---------- Entry + broadcast helpers ----------

export function handoffEntry(
  snapshot: HandoffSnapshot,
  eventKind: "handoff.new" | "handoff.update",
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
    handoff_id: snapshot.id,
    version: snapshot.version,
    expires_at_ms: snapshot.expires_at_ms,
    replay,
    snapshot,
  };
}

function broadcastUpdate(cap: HubCapabilities, snapshot: HandoffSnapshot): void {
  cap.sse.emit(handoffEntry(snapshot, "handoff.update"), {
    kind: "to-agents",
    agents: [snapshot.from_agent, snapshot.to_agent],
  });
}

// ---------- Route handlers ----------

function outcomeResponse(cap: HubCapabilities, outcome: HandoffOutcome): Response {
  switch (outcome.kind) {
    case "not_found":
      return Response.json({ error: "not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: outcome.reason }, { status: 403 });
    case "conflict":
      return Response.json(
        { error: `handoff already ${outcome.current_status}`, snapshot: outcome.snapshot },
        { status: 409 },
      );
    case "idempotent":
      return Response.json({ snapshot: outcome.snapshot, idempotent: true }, { status: 200 });
    case "transition":
      broadcastUpdate(cap, outcome.snapshot);
      return Response.json({ snapshot: outcome.snapshot }, { status: 200 });
  }
}

const routes: RouteDef[] = [
  {
    method: "POST",
    path: "/handoffs",
    auth: "mutating",
    bodyMax: HANDOFF_BODY_MAX,
    handler: async (req, cap) => {
      const body = (await req.json().catch(() => ({}))) as {
        from?: string;
        to?: string;
        task?: string;
        context?: unknown;
        ttl_seconds?: number;
      };
      const from = (body.from ?? "").trim();
      const to = (body.to ?? "").trim();
      const task = (body.task ?? "").trim();

      if (!validName(from)) return Response.json({ error: "invalid from" }, { status: 400 });
      if (!validName(to)) return Response.json({ error: "invalid to" }, { status: 400 });
      if (!task) return Response.json({ error: "task required" }, { status: 400 });
      if (task.length > HANDOFF_TASK_MAX_CHARS) {
        return Response.json({ error: `task too long (max ${HANDOFF_TASK_MAX_CHARS})` }, { status: 400 });
      }
      if (body.context !== undefined && body.context !== null) {
        const serialized = JSON.stringify(body.context);
        if (serialized.length > HANDOFF_CONTEXT_MAX_BYTES) {
          return Response.json({ error: "context too large" }, { status: 400 });
        }
      }
      let ttl = body.ttl_seconds ?? HANDOFF_TTL_DEFAULT_SECONDS;
      if (typeof ttl !== "number" || !Number.isFinite(ttl)) {
        return Response.json({ error: "ttl_seconds must be a number" }, { status: 400 });
      }
      ttl = Math.trunc(ttl);
      if (ttl < HANDOFF_TTL_MIN_SECONDS || ttl > HANDOFF_TTL_MAX_SECONDS) {
        return Response.json(
          { error: `ttl_seconds must be between ${HANDOFF_TTL_MIN_SECONDS} and ${HANDOFF_TTL_MAX_SECONDS}` },
          { status: 400 },
        );
      }

      cap.agents.ensure(from);
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
        return Response.json({ error: "cross-room handoff not permitted" }, { status: 403 });
      }
      const handoffRoom = fromAgent.room ?? toAgent.room ?? cap.config.defaultRoom;

      const snapshot = createHandoff(cap.db, {
        from, to, task, context: body.context, ttl_seconds: ttl, room: handoffRoom,
      });
      cap.sse.emit(handoffEntry(snapshot, "handoff.new"), {
        kind: "to-agents",
        agents: [snapshot.to_agent],
      });
      return Response.json({ id: snapshot.id }, { status: 201 });
    },
  },

  {
    method: "POST",
    path: /^\/handoffs\/([^/]+)\/accept$/,
    auth: "mutating",
    handler: async (req, cap, params) => {
      const id = params.id;
      if (!HANDOFF_ID_RE.test(id)) {
        return Response.json({ error: "invalid handoff id" }, { status: 400 });
      }
      const body = (await req.json().catch(() => ({}))) as { by?: string; comment?: string };
      const by = (body.by ?? "").trim();
      if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
      if (body.comment && body.comment.length > HANDOFF_REASON_MAX_CHARS) {
        return Response.json(
          { error: `comment too long (max ${HANDOFF_REASON_MAX_CHARS} chars)`, max: HANDOFF_REASON_MAX_CHARS },
          { status: 400 },
        );
      }
      const { outcome, nutshell } = acceptHandoff(cap.db, id, by, body.comment, cap.config.humanName);
      // Broadcast nutshell update AFTER the accept transaction + broadcast, so
      // the UI gets the accept event first, then the nutshell patch.
      const resp = outcomeResponse(cap, outcome);
      if (nutshell) {
        // Nutshell is ambient (no chatLog); fan out to same-room agents only.
        cap.sse.emitWhere(nutshellEntry(nutshell), (a) =>
          !a.permanent && a.room === nutshell.room,
        );
      }
      return resp;
    },
  },

  {
    method: "POST",
    path: /^\/handoffs\/([^/]+)\/decline$/,
    auth: "mutating",
    handler: async (req, cap, params) => {
      const id = params.id;
      if (!HANDOFF_ID_RE.test(id)) {
        return Response.json({ error: "invalid handoff id" }, { status: 400 });
      }
      const body = (await req.json().catch(() => ({}))) as { by?: string; reason?: string };
      const by = (body.by ?? "").trim();
      const reason = (body.reason ?? "").trim();
      if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
      if (!reason) return Response.json({ error: "reason required" }, { status: 400 });
      if (reason.length > HANDOFF_REASON_MAX_CHARS) {
        return Response.json(
          { error: `reason too long (max ${HANDOFF_REASON_MAX_CHARS} chars)`, max: HANDOFF_REASON_MAX_CHARS },
          { status: 400 },
        );
      }
      return outcomeResponse(cap, declineHandoff(cap.db, id, by, reason));
    },
  },

  {
    method: "POST",
    path: /^\/handoffs\/([^/]+)\/cancel$/,
    auth: "mutating",
    handler: async (req, cap, params) => {
      const id = params.id;
      if (!HANDOFF_ID_RE.test(id)) {
        return Response.json({ error: "invalid handoff id" }, { status: 400 });
      }
      const body = (await req.json().catch(() => ({}))) as { by?: string; reason?: string };
      const by = (body.by ?? "").trim();
      const reason = body.reason?.trim();
      if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
      if (reason && reason.length > HANDOFF_REASON_MAX_CHARS) {
        return Response.json(
          { error: `reason too long (max ${HANDOFF_REASON_MAX_CHARS} chars)`, max: HANDOFF_REASON_MAX_CHARS },
          { status: 400 },
        );
      }
      return outcomeResponse(cap, cancelHandoff(cap.db, id, by, reason, cap.config.humanName));
    },
  },

  {
    method: "GET",
    path: "/handoffs",
    auth: "read",
    handler: (req, cap) => {
      const url = new URL(req.url);
      const statusParam = url.searchParams.get("status") ?? "pending";
      const forParam = url.searchParams.get("for") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : 100;

      if (!isHandoffStatusFilter(statusParam)) {
        return Response.json({ error: `invalid status: ${statusParam}` }, { status: 400 });
      }
      if (forParam !== undefined && !validName(forParam)) {
        return Response.json({ error: `invalid for: ${forParam}` }, { status: 400 });
      }
      if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
        return Response.json({ error: "invalid limit" }, { status: 400 });
      }
      return Response.json(
        listHandoffs(cap.db, {
          status: statusParam,
          for: forParam,
          limit,
        }),
      );
    },
  },
];

// ---------- KindModule export ----------

function pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[] {
  return listHandoffs(cap.db, { status: "pending", for: agent.name, limit: 1000 }).map((s) =>
    handoffEntry(s, "handoff.new", true),
  );
}

export const handoffKind: KindModule = {
  kind: "handoff",
  migrate: () => {
    // Handoff schema owned historically by core/ledger.ts (v1 + v6 migrations).
  },
  routes,
  pendingFor,
  toolNames: ["send_handoff", "accept_handoff", "decline_handoff", "cancel_handoff"],
};

// Re-exports hub.ts still needs during the intermediate state (disappears in §9).
export {
  createHandoff,
  acceptHandoff,
  declineHandoff,
  cancelHandoff,
  listHandoffs,
  snapshotHandoff,
  loadHandoff,
  rowToSnapshot as handoffRowToSnapshot,
  HANDOFF_ID_RE,
  HANDOFF_BODY_MAX,
  HANDOFF_REASON_MAX_CHARS,
};
export type { ListFilter as ListHandoffsFilter, CreateInput as CreateHandoffInput };
