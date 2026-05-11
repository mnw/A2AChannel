// Owns re-brief debounce + per-Agent signature dedup. Reset-on-call collapses reconnect storms.

import type { AgentRegistry } from "./agents";
import type { BriefingPayload } from "./briefing";

export type BriefingDispatcherDeps = {
  agents: AgentRegistry;
  buildBriefing: (agent: string) => BriefingPayload;
  briefingSignature: (b: BriefingPayload) => string;
  debounceMs?: number;
};

export type BriefingDispatcher = {
  scheduleFanout(): void;
  forceFanout(): void;
  seedSignature(agent: string, brief: BriefingPayload): void;
  dispose(): void;
};

export function createBriefingDispatcher(deps: BriefingDispatcherDeps): BriefingDispatcher {
  const { agents, buildBriefing, briefingSignature } = deps;
  const debounceMs = deps.debounceMs ?? 500;

  const lastSig = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function broadcastToConnected(forceAll: boolean): void {
    for (const [name] of agents.entries()) {
      if (agents.isPermanent(name)) continue;
      if (agents.connectionCount(name) <= 0) continue;
      const brief = buildBriefing(name);
      const sig = briefingSignature(brief);
      if (!forceAll && lastSig.get(name) === sig) continue;
      lastSig.set(name, sig);
      agents.enqueueFor(name, brief);
    }
  }

  function scheduleFanout(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      broadcastToConnected(false);
    }, debounceMs);
  }

  function forceFanout(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    broadcastToConnected(true);
  }

  function seedSignature(agent: string, brief: BriefingPayload): void {
    lastSig.set(agent, briefingSignature(brief));
  }

  function dispose(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { scheduleFanout, forceFanout, seedSignature, dispose };
}
