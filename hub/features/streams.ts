// /stream (Webview SSE) + /agent-stream (per-Agent SSE). Owns per-connection state — wired directly, not via dispatcher.

import type { Entry, AgentCtx, Agent, HubCapabilities, KindModule } from "../core/types";
import type { AgentRegistry } from "../core/agents";
import { DropQueue, makeSSE } from "../core/sse";
import { validName } from "../core/ids";
import type { RoomHydrator } from "../core/room-hydrator";
import type { RoomSummariser } from "../core/room-summariser";
import type { BriefingPayload } from "../core/briefing";

export type StreamsDeps = {
  sessionId: string;
  uiQueueMax: number;
  defaultRoom: string;
  ledgerEnabled: () => boolean;
  chatLog: Entry[];
  uiSubscribers: Set<DropQueue<Entry>>;
  agents: AgentRegistry;
  ensureAgent: (name: string, room?: string | null) => Agent | null;
  broadcastPresence: () => void;
  roomHydrator: RoomHydrator | null;
  roomSummariser: RoomSummariser | null;
  buildBriefing: (agent: string) => BriefingPayload;
  /** Called inside /agent-stream's first-connect path so the immediately-scheduled
   *  re-fanout doesn't re-deliver the brief that was just sent inline. */
  seedBriefingSignature: (agent: string, brief: BriefingPayload) => void;
  kinds: readonly KindModule[];
  buildCap: () => HubCapabilities;
};

export type StreamHandlers = {
  handleStream(req: Request): Response;
  handleAgentStream(agent: string, room: string | null): Response;
};

export function createStreamHandlers(deps: StreamsDeps): StreamHandlers {
  const {
    sessionId,
    uiQueueMax,
    defaultRoom,
    chatLog,
    uiSubscribers,
    agents,
    ensureAgent,
    broadcastPresence,
    roomHydrator,
    roomSummariser,
    buildBriefing,
    seedBriefingSignature,
    kinds,
    buildCap,
  } = deps;

  function handleStream(req: Request): Response {
    const url = new URL(req.url);
    const lastIdRaw = url.searchParams.get("last_event_id") ?? req.headers.get("last-event-id");
    const clientSession = url.searchParams.get("session");
    const lastId = clientSession === sessionId && lastIdRaw ? Number(lastIdRaw) : 0;
    return makeSSE(async (send, signal) => {
      const q = new DropQueue<Entry>(uiQueueMax);
      uiSubscribers.add(q);
      try {
        send({ type: "session", id: sessionId });
        send(agents.rosterSnapshot());
        send(agents.presenceSnapshot());
        for (const m of chatLog) {
          if ((m.id ?? 0) > lastId) send(m, m.id);
        }
        while (!signal.aborted) {
          const m = await q.pull(signal);
          if (m.id !== undefined) send(m, m.id);
          else send(m);
        }
      } finally {
        uiSubscribers.delete(q);
      }
    });
  }

  function handleAgentStream(agent: string, room: string | null = null): Response {
    if (!validName(agent)) {
      return Response.json({ error: `invalid agent name: ${agent}` }, { status: 400 });
    }
    if (!ensureAgent(agent, room ?? defaultRoom)) {
      return Response.json({ error: "agent queue missing" }, { status: 500 });
    }
    return makeSSE(async (send, signal) => {
      agents.connect(agent);
      broadcastPresence();

      const me = agents.get(agent);
      if (me?.room && roomHydrator) {
        roomHydrator.maybeHydrate(me.room).catch((e) =>
          console.error(`[hub] hydration error for room=${me.room}:`, e),
        );
      }
      if (me?.room && roomSummariser) {
        roomSummariser.maybeBackfill(me.room).catch((e) =>
          console.error(`[hub] backfill error for room=${me.room}:`, e),
        );
      }

      if (!agents.isPermanent(agent)) {
        try {
          const brief = buildBriefing(agent);
          send(brief);
          seedBriefingSignature(agent, brief);
        } catch (e) {
          console.error("[briefing]", e);
        }
      }

      if (deps.ledgerEnabled()) {
        const ctx: AgentCtx = {
          name: agent,
          room: me?.room ?? null,
          permanent: agents.isPermanent(agent),
        };
        const myRoom = me?.room ?? defaultRoom;
        const cap = buildCap();
        try {
          const sortedKinds = [...kinds].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
          for (const k of sortedKinds) {
            for (const entry of k.pendingFor(ctx, cap)) {
              if (entry.room != null && entry.room !== myRoom) continue;
              send(entry);
            }
          }
        } catch (e) {
          console.error("[replay]", e);
        }
      }

      try {
        for await (const m of agents.subscribe(agent, signal)) {
          send(m);
        }
      } finally {
        agents.disconnect(agent);
        broadcastPresence();
      }
    });
  }

  return { handleStream, handleAgentStream };
}
