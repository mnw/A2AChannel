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
  handleSaveSession as handleSaveSessionCore,
  handleGetSession as handleGetSessionCore,
} from "./sessions";
import {
  buildAllowedExtensions,
  handleUpload as handleUploadCore,
  handleImage as handleImageCore,
  imageUrlToPath as imageUrlToPathCore,
  IMAGE_URL_RE,
} from "./core/attachments";
import {
  handleSend as handleSendCore,
  handlePost as handlePostCore,
} from "./chat";
import { createDispatcher } from "./core/dispatcher";
import { insertEvent } from "./core/events";
import {
  openLedger as openLedgerCore,
  LEDGER_SCHEMA_VERSION,
  getRoomSettings,
  setRoomSettings,
  listOptedInRooms,
} from "./core/ledger";
import * as transcript from "./core/transcript";
import * as permissionSnapshots from "./core/permission-snapshots";
import type {
  Scope,
  Agent as AgentType,
  AgentCtx,
  HubCapabilities,
  KindModule,
} from "./core/types";
import {
  readNutshell as readNutshellCore,
  nutshellEntry,
  type NutshellSnapshot,
} from "./nutshell";
import { readUsageSnapshot } from "./usage";
import { interruptKind } from "./kinds/interrupt";
import {
  handoffKind,
  handoffEntry,
  expireHandoff as expireHandoffK,
  findExpirable as findExpirableK,
  type HandoffSnapshot,
} from "./kinds/handoff";
import { permissionKind } from "./kinds/permission";
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

type Agent = {
  name: string;
  color: string;
  // null = human (super-user in every room).
  room: string | null;
};
type Entry = {
  id?: number;
  from?: string;
  to?: string;
  text?: string;
  ts?: string;
  image?: string | null;
  type?: string;
  agents?: Agent[] | Record<string, boolean>;
  // null for human-originated events and global system events.
  room?: string | null;
};

const chatLog: Entry[] = [];
const uiSubscribers = new Set<DropQueue<Entry>>();
let entrySeq = 0;
const SESSION_ID = randomId(8);

// Callbacks use forward refs via closure (broadcastRoster + broadcastPresence defined below).
const agents = createAgentRegistry({
  defaultRoom: DEFAULT_ROOM,
  staleMs: STALE_AGENT_MS,
  queueMax: AGENT_QUEUE_MAX,
  resolveRoom: (raw) => resolveRoom(raw),
  onRosterChange: () => { broadcastRoster(); broadcastBriefingsToConnectedAgents(); },
  onPresenceChange: () => broadcastPresence(),
});
const { knownAgents, agentQueues, agentConnections, permanentAgents } = agents;
const ensureAgent = agents.ensure;
const removeAgent = agents.remove;
const scheduleStaleRemoval = agents.scheduleStaleRemoval;

let ledgerDb: Database | null = null;
let ledgerEnabled = false;

function openLedger(): void {
  const result = openLedgerCore(LEDGER_DB);
  ledgerDb = result.db;
  ledgerEnabled = result.enabled;
}

openLedger();
hydrateOptedInRooms();

// On startup, replay each opted-in room's active JSONL chunk into chatLog so
// SSE clients reconnecting after a hub restart see continuity. Rotated chunks
// stay on disk as archive — only the active chunk feeds the in-memory cache.
function hydrateOptedInRooms(): void {
  if (!ledgerDb) return;
  try {
    transcript.init();
  } catch (e) {
    console.error("[transcript] init failed:", e);
    return;
  }
  const rooms = listOptedInRooms(ledgerDb);
  if (!rooms.length) return;
  let total = 0;
  for (const room of rooms) {
    try {
      const tail = transcript.tailActive(room, HISTORY_LIMIT);
      for (const entry of tail) {
        if (typeof entry.id !== "number") entry.id = ++entrySeq;
        else if (entry.id > entrySeq) entrySeq = entry.id;
        if (chatLog.length >= HISTORY_LIMIT) chatLog.shift();
        chatLog.push(entry);
      }
      total += tail.length;
    } catch (e) {
      console.error(`[transcript] hydrate ${room} failed:`, e);
    }
  }
  if (total) console.log(`[transcript] hydrated ${total} entries from ${rooms.length} room(s)`);
}

function expireHandoff(id: string): HandoffSnapshot | null {
  if (!ledgerDb) return null;
  return expireHandoffK(ledgerDb, id);
}
function findExpirable(nowMs: number): string[] {
  if (!ledgerDb) return [];
  return findExpirableK(ledgerDb, nowMs);
}

function readNutshell(room: string): NutshellSnapshot {
  return readNutshellCore(ledgerDb, resolveRoom(room));
}

// Returns DEFAULT_ROOM on empty/invalid input so callers don't have to branch.
function resolveRoom(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  return s && validRoomLabel(s) ? s : DEFAULT_ROOM;
}

function broadcastUI(entry: Entry): void {
  entry.id = ++entrySeq;
  if (chatLog.length >= HISTORY_LIMIT) chatLog.shift();
  chatLog.push(entry);
  persistEntry(entry);
  for (const q of uiSubscribers) q.push(entry);
}

// Write-through to opt-in JSONL transcript. Entries without a concrete room
// (super-user broadcasts from human) are skipped — there's no room to file under.
function persistEntry(entry: Entry): void {
  if (!ledgerDb) return;
  const room = typeof entry.room === "string" && entry.room ? entry.room : null;
  if (!room) return;
  const settings = getRoomSettings(ledgerDb, room);
  if (!settings?.persist_transcript) return;
  try {
    transcript.appendEntry(room, entry);
  } catch (e) {
    console.error(`[transcript] append failed for ${room}:`, e);
  }
}

// Scopes: broadcast | to-agents | ui-only | room. Permanent agents (human) skipped — they read /stream.
function emit(entry: Entry, scope: Scope): void {
  broadcastUI(entry);
  if (scope.kind === "ui-only") return;
  const pushTo = (name: string) => {
    if (permanentAgents.has(name)) return;
    const q = agentQueues.get(name);
    if (q) q.push(entry);
  };
  if (scope.kind === "broadcast") {
    for (const name of knownAgents.keys()) pushTo(name);
    return;
  }
  if (scope.kind === "to-agents") {
    for (const name of new Set(scope.agents)) pushTo(name);
    return;
  }
  if (scope.kind === "room") {
    for (const [name, agent] of knownAgents.entries()) {
      if (agent.room !== scope.room) continue;
      pushTo(name);
    }
    return;
  }
}

// Escape hatch; kinds should prefer named scopes and promote to the Scope enum on second use.
function emitWhere(entry: Entry, predicate: (agent: AgentType) => boolean): void {
  broadcastUI(entry);
  for (const [name, agent] of knownAgents.entries()) {
    if (permanentAgents.has(name)) continue;
    if (!predicate(agent)) continue;
    const q = agentQueues.get(name);
    if (q) q.push(entry);
  }
}

function broadcastRoster(): void {
  const snap = agents.rosterSnapshot();
  for (const q of uiSubscribers) q.push(snap);
  // Debounced so reconnect storms collapse into a single final-state briefing per peer.
  scheduleBriefingFanout();
}

// Peer list excludes self + non-same-room agents (human always included). Tool list mirrors channel.ts.
function buildBriefing(agent: string): Entry & {
  type: string;
  room: string | null;
  tools: string[];
  peers: Array<{ name: string; online: boolean; room: string | null }>;
  attachments_dir: string;
  human_name: string;
  nutshell: string | null;
} {
  const me = knownAgents.get(agent);
  const myRoom = me?.room ?? DEFAULT_ROOM;
  const peers: Array<{ name: string; online: boolean; room: string | null }> = [];
  for (const [name, a] of knownAgents) {
    if (name === agent) continue;
    // Same-room peers and all cross-room members (human = room null).
    if (a.room !== null && a.room !== myRoom) continue;
    peers.push({
      name,
      online: permanentAgents.has(name)
        ? true
        : (agentConnections.get(name) ?? 0) > 0,
      room: a.room,
    });
  }
  const nutshell = ledgerEnabled ? readNutshell(myRoom).text : "";
  return {
    type: "briefing",
    tools: ["post", "post_file", ...KINDS.flatMap((k) => k.toolNames)],
    peers,
    attachments_dir: ATTACHMENTS_DIR,
    human_name: HUMAN_NAME,
    nutshell: nutshell || null,
    ts: ts(),
    room: myRoom,
  };
}

// Suppresses re-briefings with unchanged visible content; without this, reconnect storms fan O(N²).
const lastBriefingSig = new Map<string, string>();

function briefingSignature(b: ReturnType<typeof buildBriefing>): string {
  const peers = b.peers
    .map((p) => `${p.name}:${p.online ? 1 : 0}:${p.room ?? ""}`)
    .sort()
    .join(",");
  return `${b.room ?? ""}|${peers}|${b.nutshell ?? ""}`;
}

function broadcastBriefingsToConnectedAgents(forceAll: boolean = false): void {
  for (const name of knownAgents.keys()) {
    if (permanentAgents.has(name)) continue;
    if ((agentConnections.get(name) ?? 0) <= 0) continue;
    const q = agentQueues.get(name);
    if (!q) continue;
    const brief = buildBriefing(name);
    const sig = briefingSignature(brief);
    if (!forceAll && lastBriefingSig.get(name) === sig) continue;
    lastBriefingSig.set(name, sig);
    q.push(brief);
  }
}

// Reset-on-call: fires 500ms after the LAST presence change so reconnect storms collapse.
let briefingFanoutTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleBriefingFanout(): void {
  if (briefingFanoutTimer) clearTimeout(briefingFanoutTimer);
  briefingFanoutTimer = setTimeout(() => {
    briefingFanoutTimer = null;
    broadcastBriefingsToConnectedAgents();
  }, 500);
}

function broadcastPresence(): void {
  const snap = agents.presenceSnapshot();
  for (const q of uiSubscribers) q.push(snap);
  // Keeps briefing-derived peer-online view aligned; debounced + sig-deduped.
  scheduleBriefingFanout();
}

// Agents get disk paths (Read directly); UI still gets URL form via /stream.
function agentEntry(entry: Entry): Entry {
  if (!entry.image) return entry;
  const absPath = ATTACHMENTS_DIR ? imageUrlToPathCore(entry.image, ATTACHMENTS_DIR) : entry.image;
  const suffix = `\n[attachment: ${absPath}]`;
  return { ...entry, text: (entry.text ?? "") + suffix };
}

function enqueueTo(name: string, entry: Entry): void {
  // Permanent members read via /stream; no channel-bin queue.
  if (permanentAgents.has(name)) return;
  const q = agentQueues.get(name);
  if (!q) return;
  q.push(entry);
}

const { requireAuth, requireReadAuth, requireJsonBody } = makeAuthHelpers(AUTH_TOKEN);

const chatDeps = { agents, broadcastUI, agentEntry, enqueueTo };
async function handleSend(req: Request): Promise<Response> {
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;
  return handleSendCore(req, chatDeps);
}
async function handlePost(req: Request): Promise<Response> {
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;
  return handlePostCore(req, chatDeps);
}

async function handleUpload(req: Request): Promise<Response> {
  const sizeCheck = requireJsonBody(req, IMAGE_MAX_BYTES + 64 * 1024);
  if (sizeCheck) return sizeCheck;
  return handleUploadCore(req, ATTACHMENTS_DIR, ALLOWED_EXTENSIONS);
}
async function handleImage(segment: string): Promise<Response> {
  return handleImageCore(segment, ATTACHMENTS_DIR);
}

function handleStream(req: Request): Response {
  const url = new URL(req.url);
  const lastIdRaw =
    url.searchParams.get("last_event_id") ?? req.headers.get("last-event-id");
  const clientSession = url.searchParams.get("session");
  const lastId =
    clientSession === SESSION_ID && lastIdRaw ? Number(lastIdRaw) : 0;
  return makeSSE(async (send, signal) => {
    const q = new DropQueue<Entry>(UI_QUEUE_MAX);
    uiSubscribers.add(q);
    try {
      send({ type: "session", id: SESSION_ID });
      send(agents.rosterSnapshot());
      send(agents.presenceSnapshot());
      for (const m of chatLog) {
        if ((m.id ?? 0) > lastId) send(m, m.id);
      }
      while (!signal.aborted) {
        const m = await q.pull(signal);
        if (m.id !== undefined) send(m, m.id);
        else send(m);
      }
    } finally {
      uiSubscribers.delete(q);
    }
  });
}

function handleAgentStream(agent: string, room: string | null = null): Response {
  if (!validName(agent)) {
    return json({ error: `invalid agent name: ${agent}` }, { status: 400 });
  }
  // Room captured on first registration; reconnects ignore the arg.
  ensureAgent(agent, room ?? DEFAULT_ROOM);
  const q = agentQueues.get(agent);
  if (!q) {
    return json({ error: "agent queue missing" }, { status: 500 });
  }
  return makeSSE(async (send, signal) => {
    agentConnections.set(agent, (agentConnections.get(agent) ?? 0) + 1);
    broadcastPresence();

    // Briefing first so it arrives before replay in the agent's context.
    if (!permanentAgents.has(agent)) {
      try {
        const brief = buildBriefing(agent);
        send(brief);
        // Seed dedup so the queued re-briefing from broadcastPresence doesn't double-send.
        lastBriefingSig.set(agent, briefingSignature(brief));
      } catch (e) {
        console.error("[briefing]", e);
      }
    }

    // Chat is NOT replayed (UI replays via /stream's chatLog). Kinds replay via pendingFor().
    if (ledgerEnabled) {
      const me = knownAgents.get(agent);
      const myRoom = me?.room ?? DEFAULT_ROOM;
      const agentCtx: AgentCtx = {
        name: agent,
        room: me?.room ?? null,
        permanent: permanentAgents.has(agent),
      };
      const cap = buildCap();
      try {
        const sortedKinds = [...KINDS].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
        for (const k of sortedKinds) {
          for (const entry of k.pendingFor(agentCtx, cap)) {
            // Cross-room items never leak on reconnect (channel-bin gate is line 2).
            if (entry.room != null && entry.room !== myRoom) continue;
            send(entry);
          }
        }
      } catch (e) {
        console.error("[replay]", e);
      }
    }

    try {
      while (!signal.aborted) {
        const m = await q.pull(signal);
        send(m);
      }
    } finally {
      const n = Math.max(0, (agentConnections.get(agent) ?? 1) - 1);
      agentConnections.set(agent, n);
      broadcastPresence();
      if (n === 0 && knownAgents.has(agent)) {
        scheduleStaleRemoval(agent);
      }
    }
  });
}

async function handleRemove(req: Request): Promise<Response> {
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as { agent?: string };
  const name = (body.agent ?? "").trim();
  if (!name) return json({ error: "missing agent" }, { status: 400 });
  const removed = removeAgent(name, "manual");
  if (!removed) return json({ error: `unknown agent: ${name}` }, { status: 404 });
  return json({ ok: true });
}

// Kept hub-local for the expire-sweep below.
function broadcastHandoff(
  snapshot: HandoffSnapshot,
  eventKind: "handoff.new" | "handoff.update",
): void {
  const recipients =
    eventKind === "handoff.new"
      ? [snapshot.to_agent]
      : [snapshot.from_agent, snapshot.to_agent];
  emit(handoffEntry(snapshot, eventKind), { kind: "to-agents", agents: recipients });
}

// Ambient fan-out, not chatLog-backed; nutshell updates are fetched via GET /nutshell.
function broadcastNutshell(snapshot: NutshellSnapshot): void {
  const entry = nutshellEntry(snapshot);
  for (const q of uiSubscribers) q.push(entry);
  for (const a of knownAgents.values()) {
    if (permanentAgents.has(a.name)) continue;
    if (a.room !== snapshot.room) continue;
    const q = agentQueues.get(a.name);
    if (!q) continue;
    q.push(nutshellEntry(snapshot));
  }
}

function ledgerGuard(): Response | null {
  if (!ledgerEnabled) {
    return json({ error: "ledger disabled" }, { status: 503 });
  }
  return null;
}

function handleGetNutshell(url: URL): Response {
  const room = url.searchParams.get("room");
  if (room === null) {
    return json({ error: "room parameter required" }, { status: 400 });
  }
  if (!validRoomLabel(room)) {
    return json({ error: "invalid room" }, { status: 400 });
  }
  return json(readNutshell(room));
}

function handleGetRoomSettings(room: string): Response {
  const guard = ledgerGuard();
  if (guard) return guard;
  const settings = getRoomSettings(ledgerDb!, room) ?? {
    room,
    persist_transcript: false,
    updated_at: 0,
  };
  const stats = settings.persist_transcript ? transcript.activeStats(room) : null;
  const chunks = settings.persist_transcript ? transcript.listChunks(room) : [];
  return json({ settings, active: stats, chunks });
}

async function handlePutRoomSettings(req: Request, room: string): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;
  let body: { persist_transcript?: unknown };
  try {
    body = (await req.json()) as { persist_transcript?: unknown };
  } catch {
    return json({ error: "invalid json" }, { status: 400 });
  }
  const partial: { persist_transcript?: boolean } = {};
  if ("persist_transcript" in body) {
    if (typeof body.persist_transcript !== "boolean") {
      return json({ error: "persist_transcript must be boolean" }, { status: 400 });
    }
    partial.persist_transcript = body.persist_transcript;
  }
  setRoomSettings(ledgerDb!, room, partial);
  return handleGetRoomSettings(room);
}

function handleGetRoomTranscripts(room: string): Response {
  const active = transcript.activeStats(room);
  const chunks = transcript.listChunks(room);
  const totalBytes = active.sizeBytes + chunks.reduce((s, c) => s + c.sizeBytes, 0);
  return json({ active, chunks, totalBytes });
}

function handlePostClearTranscript(room: string): Response {
  const guard = ledgerGuard();
  if (guard) return guard;
  const settings = getRoomSettings(ledgerDb!, room);
  // Non-destructive: rotate the active file to a numbered chunk so historical
  // data is archived. Subsequent appends start a fresh active file. ChatLog is
  // filtered so the visible chat window resets and restart hydration replays
  // nothing into reconnecting agents.
  const result = transcript.rotateActive(room);
  for (let i = chatLog.length - 1; i >= 0; i--) {
    if (chatLog[i].room === room) chatLog.splice(i, 1);
  }
  return json({ archivedTo: result.archivedTo, persistence: settings?.persist_transcript ?? false });
}

async function handleSaveSession(req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;
  return handleSaveSessionCore(req, ledgerDb!);
}
function handleGetSession(url: URL): Response {
  const guard = ledgerGuard();
  if (guard) return guard;
  return handleGetSessionCore(url, ledgerDb!);
}

// HubCapabilities: DI surface kinds consume via routes / pendingFor hooks.
function buildCap(): HubCapabilities {
  return {
    db: ledgerDb!,
    agents: {
      get(name): AgentCtx | null {
        const a = knownAgents.get(name);
        if (!a) return null;
        return { name: a.name, room: a.room, permanent: permanentAgents.has(name) };
      },
      isPermanent(name) {
        return permanentAgents.has(name);
      },
      all(): AgentCtx[] {
        return [...knownAgents.values()].map((a) => ({
          name: a.name,
          room: a.room,
          permanent: permanentAgents.has(a.name),
        }));
      },
      ensure(name, room = DEFAULT_ROOM): AgentCtx | null {
        const a = ensureAgent(name, room);
        if (!a) return null;
        return { name: a.name, room: a.room, permanent: permanentAgents.has(a.name) };
      },
    },
    sse: {
      emit,
      emitWhere(entry, predicate) {
        emitWhere(entry, (a: AgentType) =>
          predicate({ name: a.name, room: a.room, permanent: permanentAgents.has(a.name) }),
        );
      },
    },
    auth: {
      requireAuth,
      requireReadAuth,
      requireJsonBody,
    },
    ids: {
      mint(_prefix, bytes) {
        return randomId(bytes);
      },
    },
    events: {
      insert: insertEvent,
    },
    config: {
      humanName: HUMAN_NAME,
      attachmentsDir: ATTACHMENTS_DIR,
      defaultRoom: DEFAULT_ROOM,
    },
  };
}

// Adding a kind = one import + one array entry. Kinds MUST NOT depend on cross-kind ordering.
const KINDS: readonly KindModule[] = [handoffKind, interruptKind, permissionKind];

// Kind routes take precedence over legacy inline routes.
const { dispatch: dispatchKindRoute } = createDispatcher({
  kinds: KINDS,
  auth: { requireAuth, requireReadAuth, requireJsonBody },
  ledgerGuard,
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
      const kindResp = await dispatchKindRoute(req, url);
      if (kindResp) return kindResp;

      // Read endpoints accept header OR ?token= for EventSource / <img>.
      if (req.method === "GET" && pathname === "/agents") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? json([...knownAgents.values()]);
      }
      if (req.method === "GET" && pathname === "/presence") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? json(agents.presenceSnapshot());
      }
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
      if (req.method === "GET" && pathname.startsWith("/image/")) {
        const authFail = requireReadAuth(req, url);
        return authFail ?? (await handleImage(pathname.slice("/image/".length)));
      }

      if (req.method === "POST" && pathname === "/send") {
        const authFail = requireAuth(req);
        return authFail ?? (await handleSend(req));
      }
      if (req.method === "POST" && pathname === "/post") {
        const authFail = requireAuth(req);
        return authFail ?? (await handlePost(req));
      }
      if (req.method === "POST" && pathname === "/remove") {
        const authFail = requireAuth(req);
        return authFail ?? (await handleRemove(req));
      }
      if (req.method === "POST" && pathname === "/upload") {
        const authFail = requireAuth(req);
        return authFail ?? (await handleUpload(req));
      }
      // Nutshell read; write path is /handoffs with task prefix "[nutshell]".
      if (req.method === "GET" && pathname === "/nutshell") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? handleGetNutshell(url);
      }
      // Fallback for external-spawn agents that lack CHATBRIDGE_ROOM.
      if (req.method === "GET" && pathname === "/room-default") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? json({ room: DEFAULT_ROOM });
      }
      // Per-room settings + transcript management.
      const roomSettingsMatch = /^\/rooms\/([^/]+)\/settings$/.exec(pathname);
      if (roomSettingsMatch) {
        const room = decodeURIComponent(roomSettingsMatch[1]);
        if (!validRoomLabel(room)) return json({ error: "invalid room label" }, { status: 400 });
        if (req.method === "GET") {
          const authFail = requireReadAuth(req, url);
          return authFail ?? handleGetRoomSettings(room);
        }
        if (req.method === "PUT") {
          const authFail = requireAuth(req);
          return authFail ?? (await handlePutRoomSettings(req, room));
        }
      }
      const roomTranscriptsMatch = /^\/rooms\/([^/]+)\/transcripts$/.exec(pathname);
      if (roomTranscriptsMatch && req.method === "GET") {
        const authFail = requireReadAuth(req, url);
        if (authFail) return authFail;
        const room = decodeURIComponent(roomTranscriptsMatch[1]);
        if (!validRoomLabel(room)) return json({ error: "invalid room label" }, { status: 400 });
        return handleGetRoomTranscripts(room);
      }
      const roomClearMatch = /^\/rooms\/([^/]+)\/clear-transcript$/.exec(pathname);
      if (roomClearMatch && req.method === "POST") {
        const authFail = requireAuth(req);
        if (authFail) return authFail;
        const room = decodeURIComponent(roomClearMatch[1]);
        if (!validRoomLabel(room)) return json({ error: "invalid room label" }, { status: 400 });
        return handlePostClearTranscript(room);
      }
      if (req.method === "POST" && pathname === "/sessions") {
        const authFail = requireAuth(req);
        return authFail ?? (await handleSaveSession(req));
      }
      if (req.method === "GET" && pathname === "/sessions") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? handleGetSession(url);
      }
      // Parsed from ~/.claude/projects JSONL transcripts (no Claude Code API).
      if (req.method === "GET" && pathname === "/usage") {
        const authFail = requireReadAuth(req, url);
        if (authFail) return authFail;
        return json(await readUsageSnapshot());
      }
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
  if (!ledgerEnabled) return;
  try {
    const expirable = findExpirable(Date.now());
    for (const id of expirable) {
      const snapshot = expireHandoff(id);
      if (snapshot) broadcastHandoff(snapshot, "handoff.update");
    }
  } catch (e) {
    console.error("[sweep]", e);
  }
}, SWEEP_INTERVAL_MS);

function shutdown() {
  clearInterval(sweepTimer);
  try { ledgerDb?.close(); } catch {}
}
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

console.log(`[hub] listening on http://${server.hostname}:${server.port}`);
console.log(
  `[hub] dynamic roster — agents register on /agent-stream connect (auth ${AUTH_TOKEN ? "enabled" : "DISABLED"})`,
);
console.log(
  `[hub] protocol ledger ${ledgerEnabled ? "enabled" : "DISABLED"}; handoff sweep every ${SWEEP_INTERVAL_MS} ms`,
);
