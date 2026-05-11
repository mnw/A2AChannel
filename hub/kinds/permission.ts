// Permission kind — Claude Code tool-use approval relay. pending → allowed | denied | dismissed.

import type { Database } from "bun:sqlite";
import type {
  AgentCtx,
  Decision,
  Entry,
  HubCapabilities,
  KindModule,
  RouteDef,
  StateMachineDecl,
  VerbDecl,
} from "../core/types";
import { LedgerConflict } from "../core/types";
import { createLedgerEntity, ledgerConflictResponse, withLedgerRequired } from "../core/ledger-entity";
import { ts, validName } from "../core/ids";

// ---------- Types ----------

export type PermissionStatus = "pending" | "allowed" | "denied" | "dismissed";
export type PermissionBehavior = "allow" | "deny";

const PERM_TERMINAL = new Set<PermissionStatus>(["allowed", "denied", "dismissed"]);

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

// Matches Claude Code's request_id format: 5 letters a-z excluding 'l'.
const PERMISSION_ID_RE = /^[a-km-z]{5}$/i;
const PERMISSION_TOOL_NAME_MAX_CHARS = 120;
const PERMISSION_DESCRIPTION_MAX_CHARS = 2_000;
const PERMISSION_INPUT_PREVIEW_MAX_CHARS = 8_000;
const PERMISSION_BODY_MAX = 16_384;

// ---------- StateMachine declaration ----------

const permissionDecl: StateMachineDecl<PermissionSnapshot> = {
  kind: "permission",
  table: "permissions",
  columns: {
    id: "TEXT",
    agent: "TEXT",
    tool_name: "TEXT",
    description: "TEXT",
    input_preview: "TEXT",
    status: "TEXT",
    created_at_ms: "INTEGER",
    resolved_at_ms: "INTEGER_NULL",
    resolved_by: "TEXT_NULL",
    behavior: "TEXT_NULL",
    room: "TEXT",
  },
  forColumn: "agent",
  terminalStatuses: PERM_TERMINAL as ReadonlySet<string>,
  rowToSnapshot: (row) => ({
    id: row.id as string,
    agent: row.agent as string,
    tool_name: row.tool_name as string,
    description: row.description as string,
    input_preview: row.input_preview as string,
    status: row.status as PermissionStatus,
    created_at_ms: Number(row.created_at_ms),
    resolved_at_ms: row.resolved_at_ms == null ? null : Number(row.resolved_at_ms),
    resolved_by: row.resolved_by == null ? null : (row.resolved_by as string),
    behavior: row.behavior == null ? null : (row.behavior as PermissionBehavior),
    room: row.room as string,
    version: Number(row.version ?? 0),
  }),
  snapshotToRow: (snap) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(snap)) {
      if (k === "version") continue;
      out[k] = (snap as Record<string, unknown>)[k];
    }
    return out;
  },
};

// ---------- Entry projection ----------

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

function eventKindFor(status: PermissionStatus): "permission.resolved" | "permission.dismissed" {
  return status === "dismissed" ? "permission.dismissed" : "permission.resolved";
}

// ---------- Verbs ----------

type CreateInput = {
  agent: string;
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
  room: string;
};

const createPermissionVerb: VerbDecl<PermissionSnapshot, CreateInput> = {
  decide(prior, payload, _actor): Decision<PermissionSnapshot> {
    if (prior) {
      if (prior.status === "pending") return { kind: "idempotent" };
      return { kind: "conflict", httpStatus: 409, message: `permission already ${prior.status}` };
    }
    const initial: PermissionSnapshot = {
      id: payload.request_id,
      agent: payload.agent,
      tool_name: payload.tool_name,
      description: payload.description,
      input_preview: payload.input_preview,
      status: "pending",
      created_at_ms: Date.now(),
      resolved_at_ms: null,
      resolved_by: null,
      behavior: null,
      room: payload.room,
      version: 0,
    };
    return {
      kind: "create",
      initial,
      eventKind: "permission.new",
      payload: () => ({
        tool_name: payload.tool_name,
        description: payload.description,
        input_preview: payload.input_preview,
      }),
      entry: (post) => permissionEntry(post, "permission.new"),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

type VerdictInput = { by: string; behavior: PermissionBehavior; humanRoom: string | null };

const verdictPermissionVerb: VerbDecl<PermissionSnapshot, VerdictInput> = {
  decide(prior, payload, _actor): Decision<PermissionSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (payload.humanRoom !== null && payload.humanRoom !== prior.room) {
      return { kind: "conflict", httpStatus: 403, message: "cross-room verdict not permitted" };
    }
    const targetStatus: PermissionStatus = payload.behavior === "allow" ? "allowed" : "denied";
    if (prior.status === targetStatus) return { kind: "idempotent" };
    if (PERM_TERMINAL.has(prior.status)) {
      return { kind: "conflict", httpStatus: 409, message: `permission already ${prior.status}` };
    }
    const now = Date.now();
    return {
      kind: "transition",
      next: {
        status: targetStatus,
        behavior: payload.behavior,
        resolved_at_ms: now,
        resolved_by: payload.by,
      } as Partial<PermissionSnapshot>,
      eventKind: "permission.resolved",
      payload: () => ({ behavior: payload.behavior }),
      entry: (post) => permissionEntry(post, eventKindFor(post.status)),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

type DismissInput = { by: string };

const dismissPermissionVerb: VerbDecl<PermissionSnapshot, DismissInput> = {
  decide(prior, payload, _actor): Decision<PermissionSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (PERM_TERMINAL.has(prior.status)) {
      return prior.status === "dismissed"
        ? { kind: "idempotent" }
        : { kind: "conflict", httpStatus: 409, message: `permission already ${prior.status}` };
    }
    const now = Date.now();
    return {
      kind: "transition",
      next: {
        status: "dismissed",
        resolved_at_ms: now,
        resolved_by: payload.by,
      } as Partial<PermissionSnapshot>,
      eventKind: "permission.dismissed",
      payload: () => ({}),
      entry: (post) => permissionEntry(post, "permission.dismissed"),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

// ---------- Factory ----------

export function createPermissionKind(db: Database): KindModule {
  const entity = createLedgerEntity({ decl: permissionDecl, db });

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

        try {
          const r = entity.apply(
            request_id,
            createPermissionVerb,
            { agent, request_id, tool_name, description, input_preview, room: requesterRoom },
            agent,
            cap,
          );
          if (r.emitted) {
            return Response.json({ id: r.snapshot.id, snapshot: r.snapshot }, { status: 201 });
          }
          return Response.json({ id: r.snapshot.id, snapshot: r.snapshot, idempotent: true }, { status: 200 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
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
        const voter = cap.agents.get(by);
        const humanRoom = voter ? voter.room : null;
        try {
          const r = entity.apply(id, verdictPermissionVerb, { by, behavior, humanRoom }, by, cap);
          return Response.json({ snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) }, { status: 200 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
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
        try {
          const r = entity.apply(id, dismissPermissionVerb, { by }, by, cap);
          return Response.json({ snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) }, { status: 200 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "GET",
      path: "/permissions",
      auth: "read",
      handler: (req, _cap) => {
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
        const list = statusParam === "all"
          ? (["pending", "allowed", "denied", "dismissed"] as PermissionStatus[])
              .flatMap((s) => entity.listByStatus({ status: s, for: forParam, limit }))
              .slice(0, limit)
          : entity.listByStatus({ status: statusParam, for: forParam, limit });
        return Response.json(list);
      },
    },
  ];

  function pendingFor(agent: AgentCtx, _cap: HubCapabilities): Entry[] {
    return entity
      .listByStatus({ status: "pending", for: agent.name, limit: 1000 })
      .map((s) => permissionEntry(s, "permission.new", true));
  }

  return {
    kind: "permission",
    migrate: (d: Database) => entity.migrate(d),
    routes: withLedgerRequired(routes),
    pendingFor,
    toolNames: ["ack_permission"],
  };
}

export { PERMISSION_ID_RE };
