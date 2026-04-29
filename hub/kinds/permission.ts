// Permission kind — Claude Code tool-use approval relay.
// Lifecycle: pending → allowed | denied | dismissed (all terminal).
//
// `dismissed` clears xterm-first ghost cards — when the human answered the
// approval in the local terminal before the chat UI saw it, Claude Code
// doesn't notify the channel, so the hub row would linger. Dismiss records
// `status="dismissed", behavior=NULL` so the audit trail stays truthful
// (the hub never actually saw a verdict).

import type { Database } from "bun:sqlite";
import type {
  AgentCtx,
  Entry,
  HubCapabilities,
  KindModule,
  RouteDef,
} from "../core/types";
import { insertEvent } from "../core/events";
import { ts, validName } from "../core/ids";

// ---------- Types ----------

export type PermissionStatus = "pending" | "allowed" | "denied" | "dismissed";
export type PermissionBehavior = "allow" | "deny";

const PERMISSION_STATUS_FILTERS = new Set<PermissionStatus | "all">([
  "pending", "allowed", "denied", "dismissed", "all",
]);
function isPermissionStatusFilter(s: string): s is PermissionStatus | "all" {
  return (PERMISSION_STATUS_FILTERS as Set<string>).has(s);
}
function isPermissionBehavior(s: string): s is PermissionBehavior {
  return s === "allow" || s === "deny";
}

export type PermissionSnapshot = {
  id: string;
  agent: string;
  tool_name: string;
  description: string;
  input_preview: string;
  status: PermissionStatus;
  created_at_ms: number;
  resolved_at_ms: number | null;
  resolved_by: string | null;
  behavior: PermissionBehavior | null;
  room: string;
  version: number;
};

type PermissionRow = {
  id: string;
  agent: string;
  tool_name: string;
  description: string;
  input_preview: string;
  status: PermissionStatus;
  created_at_ms: number;
  resolved_at_ms: number | null;
  resolved_by: string | null;
  behavior: PermissionBehavior | null;
  room: string;
};

// 5 lowercase letters a-z excluding 'l'. Matches Claude Code's request_id format.
const PERMISSION_ID_RE = /^[a-km-z]{5}$/i;
const PERMISSION_TOOL_NAME_MAX_CHARS = 120;
const PERMISSION_DESCRIPTION_MAX_CHARS = 2_000;
const PERMISSION_INPUT_PREVIEW_MAX_CHARS = 8_000;
const PERMISSION_BODY_MAX = 16_384;

// ---------- State machine ----------

function rowToSnapshot(row: PermissionRow, version: number): PermissionSnapshot {
  return {
    id: row.id,
    agent: row.agent,
    tool_name: row.tool_name,
    description: row.description,
    input_preview: row.input_preview,
    status: row.status,
    created_at_ms: row.created_at_ms,
    resolved_at_ms: row.resolved_at_ms,
    resolved_by: row.resolved_by,
    behavior: row.behavior,
    room: row.room,
    version,
  };
}

function loadPermission(db: Database, id: string): { row: PermissionRow; version: number } | null {
  const row = db.query<PermissionRow, [string]>("SELECT * FROM permissions WHERE id = ?").get(id);
  if (!row) return null;
  const verRow = db
    .query<{ max_seq: number | null }, [string]>(
      "SELECT MAX(seq) AS max_seq FROM events WHERE entity_id = ?",
    )
    .get(id);
  return { row, version: verRow?.max_seq ?? 0 };
}

function snapshotPermission(db: Database, id: string): PermissionSnapshot | null {
  const loaded = loadPermission(db, id);
  return loaded ? rowToSnapshot(loaded.row, loaded.version) : null;
}

type CreateInput = {
  agent: string;
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
  room: string;
};

export type PermissionCreateOutcome =
  | { kind: "created"; snapshot: PermissionSnapshot }
  | { kind: "idempotent"; snapshot: PermissionSnapshot }
  | { kind: "conflict"; snapshot: PermissionSnapshot };

function createPermission(db: Database, input: CreateInput): PermissionCreateOutcome {
  const existing = loadPermission(db, input.request_id);
  if (existing) {
    const snap = rowToSnapshot(existing.row, existing.version);
    return existing.row.status === "pending"
      ? { kind: "idempotent", snapshot: snap }
      : { kind: "conflict", snapshot: snap };
  }
  const now = Date.now();
  db.transaction(() => {
    insertEvent(
      db,
      input.request_id,
      "permission.new",
      input.agent,
      {
        tool_name: input.tool_name,
        description: input.description,
        input_preview: input.input_preview,
      },
      now,
    );
    db.run(
      `INSERT INTO permissions
         (id, agent, tool_name, description, input_preview, status, created_at_ms, room)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [input.request_id, input.agent, input.tool_name, input.description, input.input_preview, now, input.room],
    );
  })();
  return { kind: "created", snapshot: snapshotPermission(db, input.request_id)! };
}

export type PermissionOutcome =
  | { kind: "transition"; snapshot: PermissionSnapshot }
  | { kind: "idempotent"; snapshot: PermissionSnapshot }
  | { kind: "conflict"; current_status: PermissionStatus; snapshot: PermissionSnapshot }
  | { kind: "not_found" };

function resolvePermission(
  db: Database,
  id: string,
  by: string,
  behavior: PermissionBehavior,
): PermissionOutcome {
  const loaded = loadPermission(db, id);
  if (!loaded) return { kind: "not_found" };
  const targetStatus: PermissionStatus = behavior === "allow" ? "allowed" : "denied";
  if (loaded.row.status === targetStatus) {
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
    insertEvent(db, id, "permission.resolved", by, { behavior }, now);
    db.run(
      "UPDATE permissions SET status=?, behavior=?, resolved_at_ms=?, resolved_by=? WHERE id=?",
      [targetStatus, behavior, now, by, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotPermission(db, id)! };
}

function dismissPermission(db: Database, id: string, by: string): PermissionOutcome {
  const loaded = loadPermission(db, id);
  if (!loaded) return { kind: "not_found" };
  if (loaded.row.status === "dismissed") {
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
    insertEvent(db, id, "permission.dismissed", by, {}, now);
    db.run(
      "UPDATE permissions SET status='dismissed', resolved_at_ms=?, resolved_by=? WHERE id=?",
      [now, by, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotPermission(db, id)! };
}

type ListFilter = {
  status?: PermissionStatus | "all";
  for?: string;
  limit?: number;
};

function listPermissions(db: Database, filter: ListFilter = {}): PermissionSnapshot[] {
  const status = filter.status ?? "pending";
  const limit = Math.max(1, Math.min(1000, filter.limit ?? 100));
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (status !== "all") {
    clauses.push("status = ?");
    params.push(status);
  }
  if (filter.for) {
    clauses.push("agent = ?");
    params.push(filter.for);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  const rows = db
    .query<PermissionRow, typeof params>(
      `SELECT * FROM permissions ${where} ORDER BY created_at_ms DESC LIMIT ?`,
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

export function permissionEntry(
  snapshot: PermissionSnapshot,
  eventKind: "permission.new" | "permission.resolved" | "permission.dismissed",
  replay = false,
): Entry {
  const entry: Entry = {
    from: snapshot.agent,
    to: "all",
    text: JSON.stringify(snapshot),
    ts: ts(),
    image: null,
    room: snapshot.room,
    kind: eventKind,
    permission_id: snapshot.id,
    version: snapshot.version,
    replay,
    snapshot,
  };
  return entry;
}

// ---------- Route handlers ----------

function resolvedResponse(cap: HubCapabilities, outcome: PermissionOutcome): Response {
  switch (outcome.kind) {
    case "not_found":
      return Response.json({ error: "not found" }, { status: 404 });
    case "conflict":
      return Response.json(
        { error: `permission already ${outcome.current_status}`, snapshot: outcome.snapshot },
        { status: 409 },
      );
    case "idempotent":
      return Response.json({ snapshot: outcome.snapshot, idempotent: true }, { status: 200 });
    case "transition":
      // The eventKind here is "resolved" — dismiss uses its own response path below.
      cap.sse.emit(permissionEntry(outcome.snapshot, "permission.resolved"), {
        kind: "room",
        room: outcome.snapshot.room,
      });
      return Response.json({ snapshot: outcome.snapshot }, { status: 200 });
  }
}

const routes: RouteDef[] = [
  {
    method: "POST",
    path: "/permissions",
    auth: "mutating",
    bodyMax: PERMISSION_BODY_MAX,
    handler: async (req, cap) => {
      const body = (await req.json().catch(() => ({}))) as {
        agent?: string;
        request_id?: string;
        tool_name?: string;
        description?: string;
        input_preview?: string;
      };
      const agent = (body.agent ?? "").trim();
      const request_id = (body.request_id ?? "").trim();
      const tool_name = (body.tool_name ?? "").trim();
      const description = body.description ?? "";
      const input_preview = body.input_preview ?? "";

      if (!validName(agent)) return Response.json({ error: "invalid agent" }, { status: 400 });
      if (!PERMISSION_ID_RE.test(request_id)) {
        return Response.json({ error: "invalid request_id" }, { status: 400 });
      }
      if (!tool_name || tool_name.length > PERMISSION_TOOL_NAME_MAX_CHARS) {
        return Response.json({ error: "invalid tool_name" }, { status: 400 });
      }
      if (typeof description !== "string" || description.length > PERMISSION_DESCRIPTION_MAX_CHARS) {
        return Response.json({ error: "invalid description" }, { status: 400 });
      }
      if (typeof input_preview !== "string" || input_preview.length > PERMISSION_INPUT_PREVIEW_MAX_CHARS) {
        return Response.json({ error: "invalid input_preview" }, { status: 400 });
      }
      cap.agents.ensure(agent);
      const requester = cap.agents.get(agent);
      const requesterRoom = requester?.room ?? cap.config.defaultRoom;

      const outcome = createPermission(cap.db, {
        agent, request_id, tool_name, description, input_preview, room: requesterRoom,
      });
      switch (outcome.kind) {
        case "created":
          cap.sse.emit(permissionEntry(outcome.snapshot, "permission.new"), {
            kind: "room",
            room: outcome.snapshot.room,
          });
          return Response.json({ id: outcome.snapshot.id, snapshot: outcome.snapshot }, { status: 201 });
        case "idempotent":
          return Response.json(
            { id: outcome.snapshot.id, snapshot: outcome.snapshot, idempotent: true },
            { status: 200 },
          );
        case "conflict":
          return Response.json(
            { error: `permission already ${outcome.snapshot.status}`, snapshot: outcome.snapshot },
            { status: 409 },
          );
      }
    },
  },

  {
    method: "POST",
    path: /^\/permissions\/([^/]+)\/verdict$/,
    auth: "mutating",
    bodyMax: PERMISSION_BODY_MAX,
    handler: async (req, cap, params) => {
      const id = params.id;
      if (!PERMISSION_ID_RE.test(id)) {
        return Response.json({ error: "invalid request_id" }, { status: 400 });
      }
      const body = (await req.json().catch(() => ({}))) as { by?: string; behavior?: string };
      const by = (body.by ?? "").trim();
      const behavior = (body.behavior ?? "").trim();
      if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
      if (!isPermissionBehavior(behavior)) {
        return Response.json({ error: "invalid behavior" }, { status: 400 });
      }
      // Cross-room verdict rule: voter must be in the requester's room, OR be human.
      const loaded = loadPermission(cap.db, id);
      if (loaded) {
        const voter = cap.agents.get(by);
        if (voter && voter.room !== null && voter.room !== loaded.row.room) {
          return Response.json({ error: "cross-room verdict not permitted" }, { status: 403 });
        }
      }
      return resolvedResponse(cap, resolvePermission(cap.db, id, by, behavior));
    },
  },

  {
    method: "POST",
    path: /^\/permissions\/([^/]+)\/dismiss$/,
    auth: "mutating",
    bodyMax: PERMISSION_BODY_MAX,
    handler: async (req, cap, params) => {
      const id = params.id;
      if (!PERMISSION_ID_RE.test(id)) {
        return Response.json({ error: "invalid request_id" }, { status: 400 });
      }
      const body = (await req.json().catch(() => ({}))) as { by?: string };
      const by = (body.by ?? "").trim();
      if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });

      const outcome = dismissPermission(cap.db, id, by);
      switch (outcome.kind) {
        case "not_found":
          return Response.json({ error: "not found" }, { status: 404 });
        case "conflict":
          return Response.json(
            { error: `permission already ${outcome.current_status}`, snapshot: outcome.snapshot },
            { status: 409 },
          );
        case "idempotent":
          return Response.json({ snapshot: outcome.snapshot, idempotent: true }, { status: 200 });
        case "transition":
          cap.sse.emit(permissionEntry(outcome.snapshot, "permission.dismissed"), {
            kind: "room",
            room: outcome.snapshot.room,
          });
          return Response.json({ snapshot: outcome.snapshot }, { status: 200 });
      }
    },
  },

  {
    method: "GET",
    path: "/permissions",
    auth: "read",
    handler: (req, cap) => {
      const url = new URL(req.url);
      const statusParam = url.searchParams.get("status") ?? "pending";
      const forParam = url.searchParams.get("for") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : 100;

      if (!isPermissionStatusFilter(statusParam)) {
        return Response.json({ error: `invalid status: ${statusParam}` }, { status: 400 });
      }
      if (forParam !== undefined && !validName(forParam)) {
        return Response.json({ error: `invalid for: ${forParam}` }, { status: 400 });
      }
      if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
        return Response.json({ error: "invalid limit" }, { status: 400 });
      }
      return Response.json(
        listPermissions(cap.db, {
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
  return listPermissions(cap.db, { status: "pending", for: agent.name, limit: 1000 }).map((s) =>
    permissionEntry(s, "permission.new", true),
  );
}

export const permissionKind: KindModule = {
  kind: "permission",
  migrate: () => {
    // Permissions schema owned historically by core/ledger.ts (v4, v5, v6 migrations).
  },
  routes,
  pendingFor,
  toolNames: ["ack_permission"],
};

// Re-exports for hub.ts back-compat (disappear in §9).
export {
  createPermission,
  resolvePermission,
  dismissPermission,
  listPermissions,
  snapshotPermission,
  loadPermission,
  rowToSnapshot as permissionRowToSnapshot,
  PERMISSION_ID_RE,
};
export type { ListFilter as ListPermissionsFilter, CreateInput as CreatePermissionInput };
