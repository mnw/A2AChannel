// A2AChannel hub. Dynamic roster; any agent that hits /agent-stream?agent=<n> auto-registers.
// Env vars: PORT, A2A_TOKEN, A2A_ATTACHMENTS_DIR, A2A_LEDGER_DB, A2A_HUMAN_NAME, A2A_ALLOWED_EXTENSIONS.

import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  JSON_BODY_MAX,
  HANDOFF_BODY_MAX,
  PERMISSION_BODY_MAX,
  IMAGE_MAX_BYTES,
  corsHeaders,
  json,
  ctEquals,
  makeAuthHelpers,
} from "./core/auth";
import { DropQueue, HEARTBEAT_MS, makeSSE, type SSESend } from "./core/sse";
import { createAgentRegistry } from "./core/agents";
import {
  buildAllowedExtensions,
  IMAGE_URL_RE,
} from "./core/attachments";
import { createDispatcher } from "./core/dispatcher";
import { createFanout } from "./core/fanout";
import { createBriefingDispatcher } from "./core/briefing-dispatcher";
import { createCapBuilder } from "./core/capabilities";
import { createUsageFeature } from "./features/usage";
import { createSessionsFeature } from "./features/sessions";
import { createAttachmentsFeature } from "./features/attachments";
import { createRosterFeature } from "./features/roster";
import { createTranscriptFeature } from "./features/transcript";
import { createChatFeature } from "./features/chat";
import { createStreamHandlers } from "./features/streams";
import {
  openLedger as openLedgerCore,
  LEDGER_SCHEMA_VERSION,
  listOptedInRooms,
} from "./core/ledger";
import * as transcript from "./core/transcript";
import { createRoomHydrator, type RoomHydrator } from "./core/room-hydrator";
import {
  createRoomSummariser,
  type RoomSummariser as RoomSummariserT,
} from "./core/room-summariser";
import {
  createSummariser,
  readSummariserConfigFromEnv,
  type Summariser,
} from "./core/summariser";
import {
  createBriefingBuilder,
  briefingSignature as computeBriefingSignature,
  type BriefingBuilder,
  type BriefingPayload,
} from "./core/briefing";
import type {
  Entry,
  HubFeature,
  KindModule,
} from "./core/types";
import {
  readNutshell as readNutshellCore,
  nutshellEntry,
  type NutshellSnapshot,
} from "./nutshell";
import { buildKinds } from "./kinds";
import {
  expireHandoff as expireHandoffK,
  findExpirable as findExpirableK,
  broadcastHandoffSnapshot,
} from "./kinds/handoff";
import {
  AGENT_NAME_RE,
  RESERVED_NAMES,
  randomId,
  ts,
  colorFromName,
  validName,
  validRoomLabel,
} from "./core/ids";

// Close chmod-after-write race on SQLite's ledger.db-wal / ledger.db-shm.
process.umask(0o077);

const PORT = Number(process.env.PORT ?? 8011);
const AUTH_TOKEN = (process.env.A2A_TOKEN ?? "").trim();
const ATTACHMENTS_DIR = (
  process.env.A2A_ATTACHMENTS_DIR ??
  process.env.A2A_IMAGES_DIR ?? // legacy env var from ≤ v0.4.x
  ""
).trim();
const LEDGER_DB = (process.env.A2A_LEDGER_DB ?? "").trim();
const HUMAN_NAME = (process.env.A2A_HUMAN_NAME ?? "human").trim();
const DEFAULT_ROOM = (process.env.A2A_DEFAULT_ROOM ?? "default").trim() || "default";
const HISTORY_LIMIT = (() => {
  const raw = process.env.A2A_CHAT_HISTORY_LIMIT;
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 10 && n <= 100_000) return Math.floor(n);
  return 1000;
})();
const AGENT_QUEUE_MAX = 500;
const UI_QUEUE_MAX = 500;
const STALE_AGENT_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;
import type { HandoffStatus } from "./kinds/handoff";
const ALLOWED_EXTENSIONS = buildAllowedExtensions(process.env.A2A_ALLOWED_EXTENSIONS);

if (!AUTH_TOKEN) {
  console.error(
    "[hub] A2A_TOKEN env not set — mutating routes will reject all requests",
  );
}
if (!ATTACHMENTS_DIR) {
  console.error(
    "[hub] A2A_ATTACHMENTS_DIR env not set — uploads will fail",
  );
}
if (!LEDGER_DB) {
  console.error(
    "[hub] A2A_LEDGER_DB env not set — handoff routes will be disabled",
  );
}

// (Agent and Entry types live in hub/core/types.ts; no need to redeclare here.)

const chatLog: Entry[] = [];
const uiSubscribers = new Set<DropQueue<Entry>>();
let entrySeq = 0;
const SESSION_ID = randomId(8);

// Callbacks fire roster/presence snapshots through Fanout (ambient — no chatLog) and
// schedule a debounced briefing re-fanout that dedups via per-Agent signature.
const agents = createAgentRegistry({
  defaultRoom: DEFAULT_ROOM,
  staleMs: STALE_AGENT_MS,
  queueMax: AGENT_QUEUE_MAX,
  resolveRoom: (raw) => resolveRoom(raw),
  onRosterChange: () => {
    fanout.send(agents.rosterSnapshot(), { kind: "ui-only-ambient" });
    briefingDispatcher.scheduleFanout();
  },
  onPresenceChange: () => {
    fanout.send(agents.presenceSnapshot(), { kind: "ui-only-ambient" });
    briefingDispatcher.scheduleFanout();
  },
});
const ensureAgent = agents.ensure;
const removeAgent = agents.remove;

let ledgerDb: Database | null = null;
let ledgerEnabled = false;

function openLedger(): void {
  const result = openLedgerCore(LEDGER_DB);
  ledgerDb = result.db;
  ledgerEnabled = result.enabled;
}

openLedger();
if (ledgerDb) {
  try { transcript.init(); }
  catch (e) { console.error("[transcript] init failed:", e); }
}

// Lazy per-Room transcript replay. Triggered from handleAgentStream on the
// first connect for each Room post-restart; no-op for Rooms with persist
// disabled or no agents reconnecting.
let roomHydrator: RoomHydrator | null = null;
if (ledgerDb) {
  roomHydrator = createRoomHydrator({
    db: ledgerDb,
    capLines: HISTORY_LIMIT,
    replay: (entry) => fanout.send(entry, { kind: "ui-only" }),
  });
}

// Phase 3: pluggable Summariser + per-Room RoomSummariser. Adapter selection
// is env-driven (A2A_SUMMARISER=claude|llama-cpp|ollama|disabled, default
// disabled). When disabled the modules are null and Briefing skips the
// room_summary layer cleanly.
let summariser: Summariser | null = null;
let roomSummariser: RoomSummariserT | null = null;
if (ledgerDb) {
  const sCfg = readSummariserConfigFromEnv();
  summariser = createSummariser(sCfg);
  if (summariser) {
    roomSummariser = createRoomSummariser({
      db: ledgerDb,
      summariser,
    });
    // Wire transcript.appendEntry → roomSummariser.maybeSummarise (fire-and-forget).
    transcript.setAppendHook((room) => {
      roomSummariser?.maybeSummarise(room).catch((e) =>
        console.error(`[summariser] maybeSummarise error room=${room}:`, e),
      );
    });
    console.log(`[summariser] enabled adapter=${sCfg.adapter} model=${summariser.modelId}`);
  } else {
    console.log(`[summariser] disabled (A2A_SUMMARISER=${sCfg.adapter})`);
  }
}

// Returns DEFAULT_ROOM on empty/invalid input so callers don't have to branch.
function resolveRoom(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  return s && validRoomLabel(s) ? s : DEFAULT_ROOM;
}

function readNutshell(room: string): NutshellSnapshot {
  return readNutshellCore(ledgerDb, resolveRoom(room));
}

// Fanout — single owner of every SSE broadcast path (carved in §5).
const fanout = createFanout({
  chatLog,
  uiSubscribers,
  agents,
  historyLimit: HISTORY_LIMIT,
  ledgerDb,
  nextEntryId: () => ++entrySeq,
});

// Briefing assembly is delegated to BriefingBuilder (hub/core/briefing.ts).
// Lazy-initialised because it depends on KINDS (defined below in source order).
let _briefingBuilder: BriefingBuilder | null = null;
function buildBriefing(agent: string): BriefingPayload {
  if (!_briefingBuilder) {
    _briefingBuilder = createBriefingBuilder({
      agents, kinds: KINDS, ledgerDb, ledgerEnabled, roomSummariser,
      defaultRoom: DEFAULT_ROOM, attachmentsDir: ATTACHMENTS_DIR, humanName: HUMAN_NAME,
    });
  }
  return _briefingBuilder.build(agent);
}

// BriefingDispatcher — owns lastSig + timer + scheduleFanout + forceFanout + seedSig (carved in §6).
const briefingDispatcher = createBriefingDispatcher({
  agents, buildBriefing, briefingSignature: computeBriefingSignature,
});

const { requireAuth, requireReadAuth, requireJsonBody } = makeAuthHelpers(AUTH_TOKEN);

function ledgerGuard(): Response | null {
  return ledgerEnabled ? null : json({ error: "ledger disabled" }, { status: 503 });
}

// HubCapabilities: DI surface kinds consume via routes / pendingFor hooks.
const buildCap = createCapBuilder({
  db: ledgerDb,
  agents,
  ensureAgent,
  fanoutSend: (entry, scope) => fanout.send(entry, scope),
  auth: { requireAuth, requireReadAuth, requireJsonBody },
  config: { humanName: HUMAN_NAME, attachmentsDir: ATTACHMENTS_DIR, defaultRoom: DEFAULT_ROOM },
});

// Adding a kind = one import + one array entry. Kinds MUST NOT depend on cross-kind ordering.
// Kinds that have migrated to LedgerEntity (architecture-cycle-2a) are constructed via
// per-Kind factories that take the live ledger db; legacy kinds remain const exports
// until they migrate. KINDS is empty when the ledger is disabled — routes don't register,
// requests to /handoffs etc. return 404 (was 503 via ledgerGuard pre-cycle-2a).
// Adding a new Kind = one import + one entry in `hub/kinds/index.ts`. hub.ts unchanged.
const KINDS: readonly KindModule[] = buildKinds(ledgerDb);

// Per architecture-cycle-2a kind-runtime/spec.md: iterate KINDS and call each kind's
// migrate(db) at startup. Today's three Kinds delegate to LedgerEntity.migrate which
// runs CREATE TABLE IF NOT EXISTS — a no-op for tables already created by the
// versioned migrateLedger() (handoffs/interrupts/permissions exist via v1/v2/v6/v12).
// New Kinds added later don't need a ledger.ts migration; their entity.migrate creates
// the table on first hub start.
if (ledgerDb) {
  for (const k of KINDS) k.migrate(ledgerDb);
}

// HubFeatures: per architecture-cycle-2a route-modules/spec.md, every Hub route lives
// inside a HubFeature module under hub/features/. Kinds are the persistent-state-machine
// subset of HubFeature. SSE long-lived routes (/stream, /agent-stream) do NOT use this
// shape — they wire directly into Bun.serve below per design.md Decision 3.
const FEATURES: readonly HubFeature[] = [
  ...KINDS,
  createUsageFeature(),
  ...(ledgerDb ? [createSessionsFeature(ledgerDb)] : []),
  createAttachmentsFeature({
    attachmentsDir: ATTACHMENTS_DIR,
    allowedExtensions: ALLOWED_EXTENSIONS,
    imageMaxBytes: IMAGE_MAX_BYTES,
  }),
  createRosterFeature({ agents, removeAgent, defaultRoom: DEFAULT_ROOM, readNutshell }),
  ...(ledgerDb
    ? [createTranscriptFeature({ db: ledgerDb, chatLog, roomSummariser })]
    : []),
  createChatFeature({
    agents,
    broadcastUI: (entry) => fanout.send(entry, { kind: "ui-only" }),
    attachmentsDir: ATTACHMENTS_DIR,
  }),
];

const { dispatch } = createDispatcher({
  features: FEATURES,
  auth: { requireAuth, requireReadAuth, requireJsonBody },
  ledgerGuard,
  buildCap,
});

const { handleStream, handleAgentStream } = createStreamHandlers({
  sessionId: SESSION_ID,
  uiQueueMax: UI_QUEUE_MAX,
  defaultRoom: DEFAULT_ROOM,
  ledgerEnabled: () => ledgerEnabled,
  chatLog,
  uiSubscribers,
  agents,
  ensureAgent,
  broadcastPresence: () => {
    fanout.send(agents.presenceSnapshot(), { kind: "ui-only-ambient" });
    briefingDispatcher.scheduleFanout();
  },
  roomHydrator,
  roomSummariser,
  buildBriefing,
  seedBriefingSignature: (agent, brief) => briefingDispatcher.seedSignature(agent, brief),
  kinds: KINDS,
  buildCap,
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // SSE long-lived routes — registered directly here, not through the dispatcher
      // (they own per-connection state: briefing, hydration, kind replay, queue subscribe).
      // See design.md Decision 3.
      if (req.method === "GET" && pathname === "/stream") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? handleStream(req);
      }
      if (req.method === "GET" && pathname === "/agent-stream") {
        const authFail = requireReadAuth(req, url);
        if (authFail) return authFail;
        const agent = url.searchParams.get("agent") ?? "";
        const room = url.searchParams.get("room");
        return handleAgentStream(agent, room);
      }

      // All other routes go through the HubFeature dispatcher.
      const featResp = await dispatch(req, url);
      if (featResp) return featResp;

      return json({ error: "not found", path: pathname }, { status: 404 });
    } catch (e) {
      // Log server-side; return generic message so internals don't leak.
      console.error("[hub] error", e);
      return json({ error: "internal error" }, { status: 500 });
    }
  },
});

if (validName(HUMAN_NAME)) {
  agents.markPermanent(HUMAN_NAME);
  ensureAgent(HUMAN_NAME, null);
  console.log(`[hub] human registered as "${HUMAN_NAME}" (permanent, all rooms)`);
} else {
  console.error(`[hub] invalid A2A_HUMAN_NAME "${HUMAN_NAME}" — human not registered`);
}

const sweepTimer = setInterval(() => {
  if (!ledgerEnabled || !ledgerDb) return;
  try {
    for (const id of findExpirableK(ledgerDb, Date.now())) {
      const snapshot = expireHandoffK(ledgerDb, id);
      if (snapshot) {
        broadcastHandoffSnapshot((entry, scope) => fanout.send(entry, scope), snapshot, "handoff.update");
      }
    }
  } catch (e) {
    console.error("[sweep]", e);
  }
}, SWEEP_INTERVAL_MS);

function shutdown() {
  clearInterval(sweepTimer);
  briefingDispatcher.dispose();
  try { ledgerDb?.close(); } catch {}
}
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

// Defensive: never let a single rogue error kill the hub. Log + continue.
// Each kind/sidecar/adapter SHOULD handle its own errors locally; these are
// last-resort guards. EPIPE on child-process stdin (when a spawned tool exits
// before draining input) is the most likely uncaught case.
process.on("uncaughtException", (e) => {
  console.error("[hub] uncaughtException — continuing:", e);
});
process.on("unhandledRejection", (reason) => {
  console.error("[hub] unhandledRejection — continuing:", reason);
});

console.log(`[hub] listening on http://${server.hostname}:${server.port}`);
console.log(
  `[hub] dynamic roster — agents register on /agent-stream connect (auth ${AUTH_TOKEN ? "enabled" : "DISABLED"})`,
);
console.log(
  `[hub] protocol ledger ${ledgerEnabled ? "enabled" : "DISABLED"}; handoff sweep every ${SWEEP_INTERVAL_MS} ms`,
);
