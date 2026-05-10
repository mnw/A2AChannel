// Usage feature — reads /usage snapshot from `~/.claude/projects` JSONL transcripts.
// Carved out of hub.ts inline routes in architecture-cycle-2a §4.

import type { HubFeature } from "../core/types";
import { readUsageSnapshot } from "../usage";

export function createUsageFeature(): HubFeature {
  return {
    routes: [
      {
        method: "GET",
        path: "/usage",
        auth: "read",
        handler: async () => Response.json(await readUsageSnapshot()),
      },
    ],
  };
}
