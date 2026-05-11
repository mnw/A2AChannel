// /post (agent send) + /send (UI/human send). Owns agentEntry URL→disk-path rewrite.

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
  // Inline absolute path into entry.text for agent-bound entries; UI keeps the /image URL via /stream.
  function agentEntry(entry: Entry): Entry {
    if (!entry.image) return entry;
    const absPath = deps.attachmentsDir
      ? imageUrlToPath(entry.image, deps.attachmentsDir)
      : entry.image;
    const suffix = `\n[attachment: ${absPath}]`;
    return { ...entry, text: (entry.text ?? "") + suffix };
  }

  function enqueueTo(name: string, entry: Entry): void {
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
