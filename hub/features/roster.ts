// Roster feature — read endpoints for agents/presence + manual remove + nutshell GET + room-default.
// Carved out of hub.ts inline routes in architecture-cycle-2a §4.

import type { HubFeature } from "../core/types";
import type { AgentRegistry } from "../core/agents";
import { validRoomLabel } from "../core/ids";
import type { NutshellSnapshot } from "../nutshell";

export type RosterDeps = {
  agents: AgentRegistry;
  removeAgent: (name: string, reason: "manual" | "stale (no connection)") => boolean;
  defaultRoom: string;
  readNutshell: (room: string) => NutshellSnapshot;
};

export function createRosterFeature(deps: RosterDeps): HubFeature {
  const { agents, removeAgent, defaultRoom, readNutshell } = deps;

  return {
    routes: [
      {
        method: "GET",
        path: "/agents",
        auth: "read",
        handler: () => Response.json([...agents.values()]),
      },
      {
        method: "GET",
        path: "/presence",
        auth: "read",
        handler: () => Response.json(agents.presenceSnapshot()),
      },
      {
        method: "POST",
        path: "/remove",
        auth: "mutating",
        handler: async (req) => {
          const body = (await req.json().catch(() => ({}))) as { agent?: string };
          const name = (body.agent ?? "").trim();
          if (!name) return Response.json({ error: "missing agent" }, { status: 400 });
          const removed = removeAgent(name, "manual");
          if (!removed) return Response.json({ error: `unknown agent: ${name}` }, { status: 404 });
          return Response.json({ ok: true });
        },
      },
      {
        method: "GET",
        path: "/nutshell",
        auth: "read",
        handler: (req) => {
          const url = new URL(req.url);
          const room = url.searchParams.get("room");
          if (room === null) return Response.json({ error: "room parameter required" }, { status: 400 });
          if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
          return Response.json(readNutshell(room));
        },
      },
      {
        method: "GET",
        path: "/room-default",
        auth: "read",
        handler: () => Response.json({ room: defaultRoom }),
      },
    ],
  };
}
