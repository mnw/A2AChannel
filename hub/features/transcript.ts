// Transcript feature — per-room settings + transcript file mgmt + clear-transcript.
// Carved out of hub.ts inline routes in architecture-cycle-2a §4.

import type { Database } from "bun:sqlite";
import type { HubFeature, Entry } from "../core/types";
import { validRoomLabel } from "../core/ids";
import { getRoomSettings, setRoomSettings } from "../core/ledger";
import * as transcriptStore from "../core/transcript";
import type { RoomSummariser } from "../core/room-summariser";

export type TranscriptDeps = {
  db: Database;
  chatLog: Entry[];
  roomSummariser: RoomSummariser | null;
};

const ROOM_SETTINGS_RE = /^\/rooms\/([^/]+)\/settings$/;
const ROOM_TRANSCRIPTS_RE = /^\/rooms\/([^/]+)\/transcripts$/;
const ROOM_CLEAR_RE = /^\/rooms\/([^/]+)\/clear-transcript$/;

function decodeRoom(raw: string): string | null {
  const decoded = decodeURIComponent(raw);
  return validRoomLabel(decoded) ? decoded : null;
}

function getRoomSettingsResponse(deps: TranscriptDeps, room: string): Response {
  const settings = getRoomSettings(deps.db, room) ?? {
    room,
    persist_transcript: false,
    room_summary_enabled: false,
    updated_at: 0,
  };
  const stats = settings.persist_transcript ? transcriptStore.activeStats(room) : null;
  const chunks = settings.persist_transcript ? transcriptStore.listChunks(room) : [];
  let summary: { l1_count: number; l2_count: number; last_summarised_line: number; adapter_active: boolean } | null = null;
  if (settings.room_summary_enabled) {
    const l1 = deps.db
      .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM room_summary WHERE room=? AND level=1")
      .get(room);
    const l2 = deps.db
      .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM room_summary WHERE room=? AND level=2")
      .get(room);
    const last = deps.db
      .query<{ m: number | null }, [string]>("SELECT MAX(end_line) AS m FROM room_summary WHERE room=? AND level=1")
      .get(room);
    summary = {
      l1_count: l1?.c ?? 0,
      l2_count: l2?.c ?? 0,
      last_summarised_line: last?.m ?? 0,
      adapter_active: deps.roomSummariser !== null,
    };
  }
  return Response.json({ settings, active: stats, chunks, summary });
}

export function createTranscriptFeature(deps: TranscriptDeps): HubFeature {
  return {
    routes: [
      {
        method: "GET",
        path: ROOM_SETTINGS_RE,
        auth: "read",
        requiresLedger: true,
        handler: (_req, _cap, params) => {
          const room = decodeRoom(params.id);
          if (!room) return Response.json({ error: "invalid room label" }, { status: 400 });
          return getRoomSettingsResponse(deps, room);
        },
      },
      {
        method: "PUT",
        path: ROOM_SETTINGS_RE,
        auth: "mutating",
        requiresLedger: true,
        handler: async (req, _cap, params) => {
          const room = decodeRoom(params.id);
          if (!room) return Response.json({ error: "invalid room label" }, { status: 400 });
          let body: { persist_transcript?: unknown; room_summary_enabled?: unknown };
          try {
            body = (await req.json()) as { persist_transcript?: unknown; room_summary_enabled?: unknown };
          } catch {
            return Response.json({ error: "invalid json" }, { status: 400 });
          }
          const partial: { persist_transcript?: boolean; room_summary_enabled?: boolean } = {};
          if ("persist_transcript" in body) {
            if (typeof body.persist_transcript !== "boolean") {
              return Response.json({ error: "persist_transcript must be boolean" }, { status: 400 });
            }
            partial.persist_transcript = body.persist_transcript;
          }
          if ("room_summary_enabled" in body) {
            if (typeof body.room_summary_enabled !== "boolean") {
              return Response.json({ error: "room_summary_enabled must be boolean" }, { status: 400 });
            }
            partial.room_summary_enabled = body.room_summary_enabled;
          }
          setRoomSettings(deps.db, room, partial);
          if (partial.room_summary_enabled === true && deps.roomSummariser) {
            deps.roomSummariser
              .maybeBackfill(room)
              .catch((e) => console.error(`[summariser] backfill on opt-in failed for ${room}:`, e));
          }
          return getRoomSettingsResponse(deps, room);
        },
      },
      {
        method: "GET",
        path: ROOM_TRANSCRIPTS_RE,
        auth: "read",
        handler: (_req, _cap, params) => {
          const room = decodeRoom(params.id);
          if (!room) return Response.json({ error: "invalid room label" }, { status: 400 });
          const active = transcriptStore.activeStats(room);
          const chunks = transcriptStore.listChunks(room);
          const totalBytes = active.sizeBytes + chunks.reduce((s, c) => s + c.sizeBytes, 0);
          return Response.json({ active, chunks, totalBytes });
        },
      },
      {
        method: "POST",
        path: ROOM_CLEAR_RE,
        auth: "mutating",
        requiresLedger: true,
        handler: (_req, _cap, params) => {
          const room = decodeRoom(params.id);
          if (!room) return Response.json({ error: "invalid room label" }, { status: 400 });
          const settings = getRoomSettings(deps.db, room);
          const result = transcriptStore.rotateActive(room);
          for (let i = deps.chatLog.length - 1; i >= 0; i--) {
            if (deps.chatLog[i]!.room === room) deps.chatLog.splice(i, 1);
          }
          return Response.json({ archivedTo: result.archivedTo, persistence: settings?.persist_transcript ?? false });
        },
      },
    ],
  };
}
