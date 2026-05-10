// Interrupt kind — pending → acknowledged (terminal). No cancel, no expire.
// Migrated to LedgerEntity in architecture-cycle-2a — see ADR-0004.

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

const INTERRUPT_ID_RE = /^i_[0-9a-f]{16}$/;
const INTERRUPT_TEXT_MAX_CHARS = 500;

const INTERRUPT_STATUS_FILTERS = new Set<InterruptStatus | "all">([
  "pending", "acknowledged", "all",
]);
function isInterruptStatusFilter(s: string): s is InterruptStatus | "all" {
  return (INTERRUPT_STATUS_FILTERS as Set<string>).has(s);
}

// ---------- StateMachine declaration ----------

const interruptDecl: StateMachineDecl<InterruptSnapshot> = {
  kind: "interrupt",
  table: "interrupts",
  // The Store auto-adds id (PK) and version columns; everything else is declared here.
  columns: {
    id: "TEXT",
    from_agent: "TEXT",
    to_agent: "TEXT",
    text: "TEXT",
    status: "TEXT",
    created_at_ms: "INTEGER",
    acknowledged_at_ms: "INTEGER_NULL",
    acknowledged_by: "TEXT_NULL",
    room: "TEXT",
  },
  forColumn: "to_agent",
  terminalStatuses: new Set(["acknowledged"]),
  rowToSnapshot: (row) => ({
    id: row.id as string,
    from_agent: row.from_agent as string,
    to_agent: row.to_agent as string,
    text: row.text as string,
    status: row.status as InterruptStatus,
    created_at_ms: Number(row.created_at_ms),
    acknowledged_at_ms: row.acknowledged_at_ms == null ? null : Number(row.acknowledged_at_ms),
    acknowledged_by: row.acknowledged_by == null ? null : (row.acknowledged_by as string),
    room: row.room as string,
    version: Number(row.version ?? 0),
  }),
  snapshotToRow: (snap) => {
    const out: Record<string, unknown> = {};
    if (snap.id !== undefined) out.id = snap.id;
    if (snap.from_agent !== undefined) out.from_agent = snap.from_agent;
    if (snap.to_agent !== undefined) out.to_agent = snap.to_agent;
    if (snap.text !== undefined) out.text = snap.text;
    if (snap.status !== undefined) out.status = snap.status;
    if (snap.created_at_ms !== undefined) out.created_at_ms = snap.created_at_ms;
    if (snap.acknowledged_at_ms !== undefined) out.acknowledged_at_ms = snap.acknowledged_at_ms;
    if (snap.acknowledged_by !== undefined) out.acknowledged_by = snap.acknowledged_by;
    if (snap.room !== undefined) out.room = snap.room;
    return out;
  },
};

// ---------- Entry projection ----------

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

// ---------- Verbs ----------

type CreateInput = { id: string; from: string; to: string; text: string; room: string };

const createInterruptVerb: VerbDecl<InterruptSnapshot, CreateInput> = {
  decide(prior, payload, _actor): Decision<InterruptSnapshot> {
    if (prior) {
      // Should not happen with a freshly-minted id; defensive.
      return { kind: "conflict", httpStatus: 409, message: `interrupt ${payload.id} already exists` };
    }
    const initial: InterruptSnapshot = {
      id: payload.id,
      from_agent: payload.from,
      to_agent: payload.to,
      text: payload.text,
      status: "pending",
      created_at_ms: Date.now(),
      acknowledged_at_ms: null,
      acknowledged_by: null,
      room: payload.room,
      version: 0,
    };
    return {
      kind: "create",
      initial,
      eventKind: "interrupt.new",
      payload: () => ({ to: payload.to, text: payload.text }),
      entry: (post) => interruptEntry(post, "interrupt.new"),
    };
  },
  scope: (post) => ({ kind: "to-agents", agents: [post.to_agent] }),
};

type AckInput = { by: string; humanName: string };

const ackInterruptVerb: VerbDecl<InterruptSnapshot, AckInput> = {
  decide(prior, payload, _actor): Decision<InterruptSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    // Human may ack on behalf of a non-responding agent.
    if (prior.to_agent !== payload.by && payload.by !== payload.humanName) {
      return { kind: "conflict", httpStatus: 403, message: "not the recipient" };
    }
    if (prior.status === "acknowledged") return { kind: "idempotent" };
    if (prior.status !== "pending") {
      return { kind: "conflict", httpStatus: 409, message: `interrupt already ${prior.status}` };
    }
    const now = Date.now();
    return {
      kind: "transition",
      next: {
        status: "acknowledged",
        acknowledged_at_ms: now,
        acknowledged_by: payload.by,
      } as Partial<InterruptSnapshot>,
      eventKind: "interrupt.ack",
      payload: () => ({}),
      entry: (post) => interruptEntry(post, "interrupt.ack"),
    };
  },
  // Ack notifies BOTH parties.
  scope: (post) => ({ kind: "to-agents", agents: [post.from_agent, post.to_agent] }),
};

// ---------- Factory ----------

export function createInterruptKind(db: Database): KindModule {
  const entity = createLedgerEntity({ decl: interruptDecl, db });

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

        // Bulk shape (human-only): one interrupt per non-human agent in each named room.
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
              if (a.room !== room) continue;
              const id = mintInterruptId();
              try {
                entity.apply(id, createInterruptVerb, { id, from, to: a.name, text, room }, from, cap);
                ids.push(id);
              } catch (e) {
                if (e instanceof LedgerConflict) continue; // shouldn't happen for fresh ids; skip
                throw e;
              }
            }
            created.push({ room, interrupts: ids });
          }
          return Response.json({ created }, { status: 201 });
        }

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
        const id = mintInterruptId();
        try {
          const r = entity.apply(id, createInterruptVerb, { id, from, to, text, room: interruptRoom }, from, cap);
          return Response.json({ id: r.snapshot.id }, { status: 201 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
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
        try {
          const r = entity.apply(id, ackInterruptVerb, { by, humanName: cap.config.humanName }, by, cap);
          return Response.json({ snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) }, { status: 200 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "GET",
      path: "/interrupts",
      auth: "read",
      handler: (req, _cap) => {
        const url = new URL(req.url);
        const statusParam = url.searchParams.get("status") ?? "pending";
        const forParam = url.searchParams.get("for") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 100;

        if (!isInterruptStatusFilter(statusParam)) {
          return Response.json({ error: `invalid status: ${statusParam}` }, { status: 400 });
        }
        if (forParam !== undefined && !validName(forParam)) {
          return Response.json({ error: `invalid for: ${forParam}` }, { status: 400 });
        }
        if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
          return Response.json({ error: "invalid limit" }, { status: 400 });
        }
        const list = statusParam === "all"
          ? [
              ...entity.listByStatus({ status: "pending", for: forParam, limit }),
              ...entity.listByStatus({ status: "acknowledged", for: forParam, limit }),
            ].slice(0, limit)
          : entity.listByStatus({ status: statusParam, for: forParam, limit });
        return Response.json(list);
      },
    },
  ];

  function pendingFor(agent: AgentCtx, _cap: HubCapabilities): Entry[] {
    return entity
      .listByStatus({ status: "pending", for: agent.name, limit: 1000 })
      .map((s) => interruptEntry(s, "interrupt.new", true));
  }

  return {
    kind: "interrupt",
    migrate: (d: Database) => entity.migrate(d),
    routes: withLedgerRequired(routes),
    pendingFor,
    toolNames: ["send_interrupt", "ack_interrupt"],
  };
}

// ---------- Re-exports for back-compat (tests import these) ----------

export { INTERRUPT_TEXT_MAX_CHARS, INTERRUPT_ID_RE };
