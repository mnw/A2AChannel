// Chat feature — /post (agent send) + /send (UI/human send).
// Carved out of hub.ts inline routes in architecture-cycle-2a §4 and §7 follow-up.
//
// Owns agentEntry (URL→disk-path rewrite for agent-targeted entries) + enqueueTo
// (permanent-agent skip + per-agent queue push) — these used to be hub.ts inline
// helpers. They're co-located here because chat.ts is their sole caller.

import type { Entry, HubFeature } from "../core/types";
import type { AgentRegistry } from "../core/agents";
import { imageUrlToPath } from "../core/attachments";
import { handleSend, handlePost, type ChatDeps } from "../chat";

export type ChatFeatureDeps = {
  agents: AgentRegistry;
  broadcastUI: (entry: Entry) => void;
  attachmentsDir: string;
};

export function createChatFeature(deps: ChatFeatureDeps): HubFeature {
  // Agents get on-disk paths inlined into entry.text (so they can Read directly);
  // the UI version of the entry retains the /image/<id>.<ext> URL form via /stream.
  function agentEntry(entry: Entry): Entry {
    if (!entry.image) return entry;
    const absPath = deps.attachmentsDir
      ? imageUrlToPath(entry.image, deps.attachmentsDir)
      : entry.image;
    const suffix = `\n[attachment: ${absPath}]`;
    return { ...entry, text: (entry.text ?? "") + suffix };
  }

  function enqueueTo(name: string, entry: Entry): void {
    // Permanent members read via /stream; no channel-bin queue.
    if (deps.agents.isPermanent(name)) return;
    deps.agents.enqueueFor(name, entry);
  }

  const chatDeps: ChatDeps = {
    agents: deps.agents,
    broadcastUI: deps.broadcastUI,
    agentEntry,
    enqueueTo,
  };

  return {
    routes: [
      {
        method: "POST",
        path: "/send",
        auth: "mutating",
        handler: (req) => handleSend(req, chatDeps),
      },
      {
        method: "POST",
        path: "/post",
        auth: "mutating",
        handler: (req) => handlePost(req, chatDeps),
      },
    ],
  };
}
