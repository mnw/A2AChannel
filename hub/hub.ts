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
import { openLedger as openLedgerCore, LEDGER_SCHEMA_VERSION } from "./core/ledger";
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

// Close the chmod-after-write race on SQLite's ledger.db-wal / ledger.db-shm.
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
const HISTORY_LIMIT = 1000;
const AGENT_QUEUE_MAX = 500;
const UI_QUEUE_MAX = 500;
// IMAGE_MAX_BYTES — see core/auth.ts
// JSON_BODY_MAX, HANDOFF_BODY_MAX, PERMISSION_BODY_MAX, IMAGE_MAX_BYTES — see core/auth.ts
const STALE_AGENT_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;
// HANDOFF_TTL_*, HANDOFF_CONTEXT_MAX_BYTES, HANDOFF_TASK_MAX_CHARS, HANDOFF_REASON_MAX_CHARS — see kinds/handoff.ts
// LEDGER_SCHEMA_VERSION — see core/ledger.ts
// HandoffStatus, HandoffSnapshot, HandoffRow, HandoffOutcome, ListHandoffsFilter — see kinds/handoff.ts
import type { HandoffStatus } from "./kinds/handoff";
// Extension allowlist + upload/image handlers + MIME map — see core/attachments.ts
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
  // null = the human, a super-user in every room. Non-null = this agent's room.
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
  // Sender's room; null for human-originated events and global system events.
  room?: string | null;
};

// class DropQueue — see core/sse.ts

const chatLog: Entry[] = [];
const uiSubscribers = new Set<DropQueue<Entry>>();
let entrySeq = 0;
const SESSION_ID = randomId(8);

// Agent registry — see core/agents.ts. Declared before functions that reference
// it; callbacks use forward refs via closure (broadcastRoster + broadcastPresence
// are defined below and resolved at call time).
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

// migrateLedger — see core/ledger.ts


openLedger();

// Handoff + interrupt + permission state machines + types — see hub/kinds/*.
// Only the expire-sweep wrappers remain hub-local; everything else is driven
// through KIND_ROUTES (routing) + KindModule.pendingFor (replay).

function expireHandoff(id: string): HandoffSnapshot | null {
  if (!ledgerDb) return null;
  return expireHandoffK(ledgerDb, id);
}
function findExpirable(nowMs: number): string[] {
  if (!ledgerDb) return [];
  return findExpirableK(ledgerDb, nowMs);
}

// readNutshell wrapper used by buildBriefing and handleGetNutshell.
function readNutshell(room: string): NutshellSnapshot {
  return readNutshellCore(ledgerDb, resolveRoom(room));
}


// ts, randomId, colorFromName, validName, validRoomLabel, ctEquals — see core/ids.ts + core/auth.ts

// Resolve and clean a room value from untrusted input. Returns DEFAULT_ROOM when
// the input is empty/invalid so callers don't have to branch. Stays in hub.ts
// because it references the hub-level DEFAULT_ROOM constant.
function resolveRoom(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  return s && validRoomLabel(s) ? s : DEFAULT_ROOM;
}

// ensureAgent, removeAgent, scheduleStaleRemoval — see core/agents.ts (aliased above).

function broadcastUI(entry: Entry): void {
  entry.id = ++entrySeq;
  if (chatLog.length >= HISTORY_LIMIT) chatLog.shift();
  chatLog.push(entry);
  for (const q of uiSubscribers) q.push(entry);
}

// Unified SSE scope emit — kinds build an Entry, call emit(entry, scope), and
// the resolver fans out to the right queues. Today this lives in hub.ts because
// it closes over `knownAgents`, `agentQueues`, `permanentAgents`; it moves into
// core/ with `HubCapabilities` in §9 when the agent registry extracts. Scopes:
//   - broadcast:   UI + all non-permanent agents
//   - to-agents:   UI + the listed agents (skips unknown / permanent)
//   - ui-only:     UI subscribers only (roster, presence, nutshell)
//   - room:        UI + all non-permanent agents whose `room` matches
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

// Escape hatch — for one-off delivery rules that don't deserve a named scope.
// Kinds SHOULD prefer named scopes (named > predicate as long as the enum stays
// small); promote a predicate to the Scope enum when the same rule shows up twice.
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
  // Re-brief via the debounced path so a burst of agent joins (e.g., reconnect
  // storm after hub restart) collapses into a single final-state briefing per
  // peer instead of O(N) intermediate snapshots.
  scheduleBriefingFanout();
}

// Peer list excludes self + non-same-room agents (human always included). Tool list must stay
// in sync with channel.ts. Briefing.nutshell is room-scoped.
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
    // Include same-room peers and all cross-room members (human = room null).
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
    // Non-kind tools (chat) + kind-contributed tools aggregated from KINDS.
    // Adding a kind automatically extends the briefing.
    tools: ["post", "post_file", ...KINDS.flatMap((k) => k.toolNames)],
    peers,
    attachments_dir: ATTACHMENTS_DIR,
    human_name: HUMAN_NAME,
    nutshell: nutshell || null,
    ts: ts(),
    room: myRoom,
  };
}

// Per-agent signature of the last briefing sent. Used to suppress re-briefings
// whose visible content (peer set + online map + nutshell + room) is unchanged.
// Reset when the agent is removed from the roster. Without this, a reconnect
// storm of N agents fans out O(N²) briefings even when nothing meaningful
// changes — agents' contexts get polluted with redundant briefing blocks.
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

// Debounce briefing fan-outs triggered by rapid presence changes (e.g., hub
// restart → all agents reconnect within a few seconds). Reset-on-call so the
// fan-out only fires 500ms after the LAST presence change, collapsing an
// entire reconnect storm into a single final-state briefing per agent.
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
  // Re-brief on presence change so agents' briefing-derived peer-online view
  // stays aligned with the delivery pipeline. Debounced (500ms) + sig-deduped
  // to avoid storming during reconnect cascades. F14.
  scheduleBriefingFanout();
}

// Agents get disk paths (so they can Read the file directly); UI still gets URL form via /stream.
function agentEntry(entry: Entry): Entry {
  if (!entry.image) return entry;
  const absPath = ATTACHMENTS_DIR ? imageUrlToPathCore(entry.image, ATTACHMENTS_DIR) : entry.image;
  // Single [attachment:] prefix — the agent dispatches on the path's extension.
  const suffix = `\n[attachment: ${absPath}]`;
  return { ...entry, text: (entry.text ?? "") + suffix };
}

function enqueueTo(name: string, entry: Entry): void {
  // Permanent members have no channel-bin draining their queue; they read via /stream instead.
  if (permanentAgents.has(name)) return;
  const q = agentQueues.get(name);
  if (!q) return; // agent was removed between target resolution and dispatch
  q.push(entry);
}

// corsHeaders, json, ALLOWED_ORIGINS, ctEquals — see core/auth.ts
// SSESend, HEARTBEAT_MS, makeSSE — see core/sse.ts
const { requireAuth, requireReadAuth, requireJsonBody } = makeAuthHelpers(AUTH_TOKEN);

// handleSend + handlePost — see hub/chat.ts.
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

// handleUpload / handleImage — see core/attachments.ts. Size guard stays hub-side.
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
  // First registration captures the agent's room; reconnects ignore the arg (immutable).
  ensureAgent(agent, room ?? DEFAULT_ROOM);
  const q = agentQueues.get(agent);
  if (!q) {
    return json({ error: "agent queue missing" }, { status: 500 });
  }
  return makeSSE(async (send, signal) => {
    agentConnections.set(agent, (agentConnections.get(agent) ?? 0) + 1);
    broadcastPresence();

    // Briefing lands before replay so it arrives first in the agent's context.
    if (!permanentAgents.has(agent)) {
      try {
        const brief = buildBriefing(agent);
        send(brief);
        // Seed dedup so the follow-up queued re-briefing (from broadcastPresence
        // after the connection increment) doesn't double-send the same content.
        lastBriefingSig.set(agent, briefingSignature(brief));
      } catch (e) {
        console.error("[briefing]", e);
      }
    }

    // Replay pending kind-entries on reconnect. Chat is NOT replayed here (UI replays
    // via /stream's chatLog pass). Each kind owns its pendingFor() return set; the
    // orchestrator fans it out in registry order (priority-sorted — design.md §6).
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
            // Scope replay by the reconnecting agent's room so cross-room items
            // never leak into an agent's context on reconnect (channel-bin's
            // gate is the second line of defense).
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

// handoffEntry — see kinds/handoff.ts
// broadcastHandoff kept as a thin local wrapper for the expire-sweep in §13.
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

// broadcastInterrupt — owned by kinds/interrupt.ts (emits inline via cap.sse.emit).

// Permission broadcast + handlers — owned by hub/kinds/permission.ts.

// broadcastNutshell: ambient fan-out (not chatLog-backed). emit() would insert
// into chatLog, which is wrong for nutshell — nutshell updates are fetched via
// GET /nutshell, not replayed from history.
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

// Session routes — see hub/sessions.ts. Thin wrappers guard ledger + body + wrap db.
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

// ----------------------------------------------------------------------------
// HubCapabilities: the dependency-injection surface kinds consume via routes /
// pendingFor hooks. Closes over module-level state (knownAgents, agentQueues,
// uiSubscribers) — when §9 extracts the agent registry into core/agents.ts,
// this object constructs from the registry's accessors instead. Behavior
// unchanged; shape stabilized in advance so kinds don't need to change.
// ----------------------------------------------------------------------------
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

// Static kind registry. Adding a kind = one import + one array entry — no hub.ts
// edits beyond this list. Ordering is implementation-dependent; kinds MUST NOT
// depend on cross-kind ordering for correctness (design.md §6).
const KINDS: readonly KindModule[] = [handoffKind, interruptKind, permissionKind];

// Precompiled route dispatch table. Each kind's static RouteDef[] gets matched
// against the incoming (method, pathname) before the legacy inline routes run,
// so as kinds lift out of hub.ts they take precedence automatically.
// KIND_ROUTES + dispatchKindRoute — see core/dispatcher.ts.
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
      // Kind registry dispatch runs first — kinds own their URLs. Falls through
      // to the legacy inline routes for non-kind endpoints (chat, roster, etc).
      const kindResp = await dispatchKindRoute(req, url);
      if (kindResp) return kindResp;

      // Read endpoints: header OR ?token= for EventSource / <img>.
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
      // /handoffs and /interrupts routes — owned by hub/kinds/{handoff,interrupt}.ts,
      // dispatched via KIND_ROUTES above.
      // /permissions routes — owned by hub/kinds/permission.ts, dispatched via KIND_ROUTES.
      // Nutshell read; write path is /handoffs with task prefix "[nutshell]".
      if (req.method === "GET" && pathname === "/nutshell") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? handleGetNutshell(url);
      }
      // Fallback room for external-spawn agents that lack CHATBRIDGE_ROOM in their env.
      if (req.method === "GET" && pathname === "/room-default") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? json({ room: DEFAULT_ROOM });
      }
      // Claude session capture for the spawn modal's restore flow.
      if (req.method === "POST" && pathname === "/sessions") {
        const authFail = requireAuth(req);
        return authFail ?? (await handleSaveSession(req));
      }
      if (req.method === "GET" && pathname === "/sessions") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? handleGetSession(url);
      }
      // Claude usage snapshot, derived from ~/.claude/projects transcripts.
      // See hub/usage.ts — no Claude Code API, we parse the JSONL directly.
      if (req.method === "GET" && pathname === "/usage") {
        const authFail = requireReadAuth(req, url);
        if (authFail) return authFail;
        return json(await readUsageSnapshot());
      }
      return json({ error: "not found", path: pathname }, { status: 404 });
    } catch (e) {
      // Log details server-side; return a generic message so internals don't leak.
      console.error("[hub] error", e);
      return json({ error: "internal error" }, { status: 500 });
    }
  },
});

// Register the human as a permanent roster member.
if (validName(HUMAN_NAME)) {
  agents.markPermanent(HUMAN_NAME);
  ensureAgent(HUMAN_NAME, null);
  console.log(`[hub] human registered as "${HUMAN_NAME}" (permanent, all rooms)`);
} else {
  console.error(`[hub] invalid A2A_HUMAN_NAME "${HUMAN_NAME}" — human not registered`);
}

// Expire pending handoffs past their TTL. Runs every SWEEP_INTERVAL_MS.
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
