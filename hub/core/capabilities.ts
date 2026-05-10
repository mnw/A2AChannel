// Capabilities — factory for the HubCapabilities object passed to every Kind/Feature
// route handler. Carved out of hub.ts in architecture-cycle-2a §7 follow-up.
//
// `cap` is the SOLE access path Kind code has to shared Hub services. It exposes:
//   - db: the live ledger Database
//   - agents: a sanitized AgentCtx-shaped read view of the AgentRegistry
//   - sse.emit: delegates to Fanout (single broadcast call site)
//   - auth: requireAuth / requireReadAuth / requireJsonBody helpers
//   - events.insert: the events-table append helper (transcribed from core/events.ts)
//   - config: the env-resolved humanName / attachmentsDir / defaultRoom

import type { Database } from "bun:sqlite";
import type { AgentCtx, Entry, HubCapabilities, Scope } from "./types";
import type { AgentRegistry } from "./agents";
import type { AuthHelpers } from "./auth";
import { insertEvent } from "./events";

export type CapabilityDeps = {
  db: Database | null;
  agents: AgentRegistry;
  ensureAgent: AgentRegistry["ensure"];
  fanoutSend: (entry: Entry, scope: Scope) => void;
  auth: AuthHelpers;
  config: {
    humanName: string;
    attachmentsDir: string;
    defaultRoom: string;
  };
};

export function createCapBuilder(deps: CapabilityDeps): () => HubCapabilities {
  const { agents, ensureAgent, fanoutSend, auth, config } = deps;

  return function buildCap(): HubCapabilities {
    return {
      db: deps.db!,
      agents: {
        get(name): AgentCtx | null {
          const a = agents.get(name);
          if (!a) return null;
          return { name: a.name, room: a.room, permanent: agents.isPermanent(name) };
        },
        isPermanent(name) {
          return agents.isPermanent(name);
        },
        all(): AgentCtx[] {
          return [...agents.values()].map((a) => ({
            name: a.name,
            room: a.room,
            permanent: agents.isPermanent(a.name),
          }));
        },
        ensure(name, room = config.defaultRoom): AgentCtx | null {
          const a = ensureAgent(name, room);
          if (!a) return null;
          return { name: a.name, room: a.room, permanent: agents.isPermanent(a.name) };
        },
      },
      sse: {
        emit: fanoutSend,
      },
      auth,
      events: {
        insert: insertEvent,
      },
      config,
    };
  };
}
