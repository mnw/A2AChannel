// Sessions feature — Claude Code session save/restore endpoints.
// Carved out of hub.ts inline routes in architecture-cycle-2a §4.

import type { Database } from "bun:sqlite";
import type { HubFeature } from "../core/types";
import { handleSaveSession, handleGetSession } from "../sessions";

export function createSessionsFeature(db: Database): HubFeature {
  return {
    routes: [
      {
        method: "POST",
        path: "/sessions",
        auth: "mutating",
        requiresLedger: true,
        handler: async (req) => handleSaveSession(req, db),
      },
      {
        method: "GET",
        path: "/sessions",
        auth: "read",
        requiresLedger: true,
        handler: (req) => handleGetSession(new URL(req.url), db),
      },
    ],
  };
}
