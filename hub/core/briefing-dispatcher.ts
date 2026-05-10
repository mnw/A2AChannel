// BriefingDispatcher — owns re-brief debounce + per-Agent signature dedup.
//
// Carved from hub.ts module scope in architecture-cycle-2a §6. The 4 pieces of
// state that previously leaked into hub.ts module scope are now closure-private:
//   - lastBriefingSig: Map<agent, sig>      — dedup signature cache
//   - briefingFanoutTimer: setTimeout ref   — debounce timer
//   - scheduleFanout(): debounce-and-fan    — called from roster/presence change
//   - broadcastToConnected(forceAll?)       — actual fan-out (skipped when sig unchanged)
//
// The scheduler uses reset-on-call: every call clears the prior timer and arms a fresh
// 500ms one, so a reconnect storm of N agents collapses to ONE fan-out at the end of
// the storm. Each agent's brief is built fresh; if the signature matches the prior
// fan-out, no brief is enqueued (skips the queue and the agent's read).
//
// Briefing seeding (called from /agent-stream's first-connect path) sets the agent's
// initial signature so the first auto-fanout doesn't immediately re-deliver the same
// brief that was just sent inline.

import type { AgentRegistry } from "./agents";
import type { BriefingPayload } from "./briefing";

export type BriefingDispatcherDeps = {
  agents: AgentRegistry;
  buildBriefing: (agent: string) => BriefingPayload;
  briefingSignature: (b: BriefingPayload) => string;
  /** Reset-on-call debounce window. Default 500ms. */
  debounceMs?: number;
};

export type BriefingDispatcher = {
  /** Debounced; collapses reconnect storms. Called from roster/presence change. */
  scheduleFanout(): void;
  /** Bypass dedup; force re-issue to all connected agents. */
  forceFanout(): void;
  /** Called from /agent-stream's first-connect path; seeds the dedup signature so the
   *  first scheduled fanout doesn't re-deliver a brief the agent just received inline. */
  seedSignature(agent: string, brief: BriefingPayload): void;
  /** Cleanup hook for graceful shutdown — clears the pending timer. */
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
