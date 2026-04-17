/**
 * A2AChannel hub — dynamic-roster edition.
 *
 * Any agent that connects to /agent-stream?agent=<NAME> is auto-registered.
 * Colors are derived from a hash of the name (deterministic).
 *
 * Env:
 *   PORT   default 8011
 */

const PORT = Number(process.env.PORT ?? 8011);
const HISTORY_LIMIT = 1000;
const AGENT_QUEUE_MAX = 500;
const UI_QUEUE_MAX = 500;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_CACHE_MAX = 64;
const STALE_AGENT_MS = 15_000;  // time after last disconnect before auto-removal
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
// Allow letters, digits, spaces, and _.- inside; first and last char must be non-space.
const AGENT_NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;
const RESERVED_NAMES = new Set(["you", "all", "system"]);

type Agent = { name: string; color: string };
type Entry = {
  id?: number;
  from?: string;
  to?: string;
  text?: string;
  ts?: string;
  image?: string | null;
  type?: string;
  agents?: Agent[] | Record<string, boolean>;
};

// ── Bounded drop-oldest queue with async pull ─────────────────
class DropQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T) => void> = [];
  constructor(private readonly max: number) {}

  push(v: T): void {
    const w = this.waiters.shift();
    if (w) {
      w(v);
      return;
    }
    if (this.items.length >= this.max) this.items.shift();
    this.items.push(v);
  }

  async pull(signal?: AbortSignal): Promise<T> {
    if (this.items.length) return this.items.shift()!;
    return new Promise<T>((resolve, reject) => {
      const waiter = (v: T) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new DOMException("aborted", "AbortError"));
      };
      this.waiters.push(waiter);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

// ── State ──────────────────────────────────────────────────────
const knownAgents = new Map<string, Agent>();
const chatLog: Entry[] = [];
const uiSubscribers = new Set<DropQueue<Entry>>();
const agentQueues = new Map<string, DropQueue<Entry>>();
const agentConnections = new Map<string, number>();
const imageStore = new Map<string, { ctype: string; data: Uint8Array }>();
const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();
let entrySeq = 0;
const SESSION_ID = randomId(8);

// ── Utilities ──────────────────────────────────────────────────
function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

function randomId(bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function colorFromName(name: string): string {
  // Deterministic hue from name hash; consistent saturation/lightness so
  // the palette stays cohesive.
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  // Saturation/lightness tuned to sit comfortably on the Catppuccin Mocha base.
  return `hsl(${hue}, 70%, 75%)`;
}

function validName(name: string): boolean {
  return (
    !!name &&
    AGENT_NAME_RE.test(name) &&
    !RESERVED_NAMES.has(name.toLowerCase())
  );
}

function ensureAgent(name: string): Agent | null {
  if (!validName(name)) return null;
  const existing = knownAgents.get(name);
  if (existing) {
    // Reconnecting an agent that was pending stale-removal: cancel the timer.
    cancelStaleTimer(name);
    return existing;
  }
  const a: Agent = { name, color: colorFromName(name) };
  knownAgents.set(name, a);
  agentQueues.set(name, new DropQueue<Entry>(AGENT_QUEUE_MAX));
  agentConnections.set(name, 0);
  console.log(`[hub] agent joined: ${name} (${a.color})`);
  broadcastRoster();
  return a;
}

function removeAgent(name: string, reason: string): boolean {
  if (!knownAgents.has(name)) return false;
  cancelStaleTimer(name);
  knownAgents.delete(name);
  agentQueues.delete(name);
  agentConnections.delete(name);
  console.log(`[hub] agent removed: ${name} (${reason})`);
  broadcastRoster();
  broadcastPresence();
  return true;
}

function cancelStaleTimer(name: string): void {
  const t = staleTimers.get(name);
  if (t) {
    clearTimeout(t);
    staleTimers.delete(name);
  }
}

function scheduleStaleRemoval(name: string): void {
  cancelStaleTimer(name);
  const t = setTimeout(() => {
    staleTimers.delete(name);
    // Guard: agent may have reconnected within the window.
    if ((agentConnections.get(name) ?? 0) > 0) return;
    removeAgent(name, "stale (no connection)");
  }, STALE_AGENT_MS);
  staleTimers.set(name, t);
}

function broadcastUI(entry: Entry): void {
  entry.id = ++entrySeq;
  if (chatLog.length >= HISTORY_LIMIT) chatLog.shift();
  chatLog.push(entry);
  for (const q of uiSubscribers) q.push(entry);
}

function rosterSnapshot(): Entry {
  return { type: "roster", agents: [...knownAgents.values()] };
}

function broadcastRoster(): void {
  const snap = rosterSnapshot();
  for (const q of uiSubscribers) q.push(snap);
}

function presenceSnapshot(): Entry {
  const agents: Record<string, boolean> = {};
  for (const name of knownAgents.keys()) {
    agents[name] = (agentConnections.get(name) ?? 0) > 0;
  }
  return { type: "presence", agents };
}

function broadcastPresence(): void {
  const snap = presenceSnapshot();
  for (const q of uiSubscribers) q.push(snap);
}

function agentEntry(entry: Entry): Entry {
  if (!entry.image) return entry;
  const suffix = `\n[image: ${entry.image}]`;
  return { ...entry, text: (entry.text ?? "") + suffix };
}

// ── HTTP helpers ───────────────────────────────────────────────
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...(init?.headers ?? {}),
    },
  });
}

type SSESend = (obj: unknown, id?: number | string) => void;
const HEARTBEAT_MS = 15_000;

function makeSSE(
  setup: (send: SSESend, signal: AbortSignal) => void | Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const ac = new AbortController();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: SSESend = (obj, id) => {
        if (closed) return;
        try {
          const idLine = id !== undefined ? `id: ${id}\n` : "";
          controller.enqueue(
            encoder.encode(`${idLine}data: ${JSON.stringify(obj)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      try {
        controller.enqueue(encoder.encode(": connected\n\n"));
      } catch {}

      // Keep the connection alive past Bun.serve's idleTimeout and any
      // intermediary proxies by sending an SSE comment every HEARTBEAT_MS.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: hb ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);
      ac.signal.addEventListener("abort", () => clearInterval(heartbeat), {
        once: true,
      });

      try {
        await setup(send, ac.signal);
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.error("[sse]", e);
      } finally {
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      closed = true;
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      ...corsHeaders,
    },
  });
}

// ── Routes ─────────────────────────────────────────────────────
async function handleSend(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    text?: string;
    image?: string | null;
    target?: string;
    targets?: string[];
  };
  const text = (body.text ?? "").trim();
  const image = body.image || null;
  if (!text && !image) return json({ error: "empty" }, { status: 400 });

  const known = [...knownAgents.keys()];
  // "broadcast" means: send to whoever's currently known (possibly none).
  // Explicitly naming a specific agent requires that agent to exist.
  let targets: string[];
  let broadcast = false;

  if (Array.isArray(body.targets) && body.targets.length) {
    const resolved: string[] = [];
    for (const t of body.targets) {
      if (t === "all") {
        resolved.splice(0, resolved.length, ...known);
        broadcast = true;
        break;
      }
      if (knownAgents.has(t)) {
        if (!resolved.includes(t)) resolved.push(t);
      } else {
        return json({ error: `unknown target: ${t}` }, { status: 400 });
      }
    }
    targets = resolved;
  } else if (!body.target || body.target === "all") {
    // undefined/empty/"all" → broadcast
    targets = [...known];
    broadcast = true;
  } else if (knownAgents.has(body.target)) {
    targets = [body.target];
  } else {
    return json(
      { error: `unknown target: ${body.target}` },
      { status: 400 },
    );
  }

  if (!targets.length && !broadcast) {
    return json({ error: "no targets" }, { status: 400 });
  }

  const toLabel =
    broadcast
      ? "all"
      : targets.length === 1
        ? targets[0]
        : targets.join(",");

  const entry: Entry = { from: "you", to: toLabel, text, image, ts: ts() };
  broadcastUI(entry);
  const view = agentEntry(entry);
  for (const t of targets) agentQueues.get(t)!.push(view);
  return json({ ok: true });
}

async function handlePost(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    from?: string;
    to?: string;
    text?: string;
  };
  const frm = body.from;
  const rawTo = (body.to ?? "you").toLowerCase();
  const text = (body.text ?? "").trim();
  if (!frm || !validName(frm) || !text) {
    return json({ error: "bad request" }, { status: 400 });
  }
  ensureAgent(frm);

  let targets: string[];
  if (rawTo === "you") targets = [];
  else if (rawTo === "all")
    targets = [...knownAgents.keys()].filter((a) => a !== frm);
  else if (knownAgents.has(rawTo)) targets = [rawTo];
  else return json({ error: `unknown to: ${rawTo}` }, { status: 400 });

  const entry: Entry = { from: frm, to: rawTo, text, ts: ts() };
  broadcastUI(entry);
  for (const t of targets) agentQueues.get(t)!.push(entry);
  return json({ ok: true });
}

async function handleUpload(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  if (!form) return json({ error: "invalid form" }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "no file" }, { status: 400 });
  const ctype = (file.type ?? "").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(ctype))
    return json({ error: `unsupported type: ${ctype}` }, { status: 400 });
  if (file.size > IMAGE_MAX_BYTES)
    return json({ error: "file too large" }, { status: 413 });
  const buf = new Uint8Array(await file.arrayBuffer());
  const id = randomId();
  imageStore.set(id, { ctype, data: buf });
  while (imageStore.size > IMAGE_CACHE_MAX) {
    const firstKey = imageStore.keys().next().value;
    if (firstKey === undefined) break;
    imageStore.delete(firstKey);
  }
  return json({ url: `/image/${id}`, id });
}

function handleImage(id: string): Response {
  const hit = imageStore.get(id);
  if (!hit) return json({ error: "not found" }, { status: 404 });
  return new Response(hit.data, {
    headers: {
      "Content-Type": hit.ctype,
      "Cache-Control": "public, max-age=3600",
      ...corsHeaders,
    },
  });
}

function handleStream(req: Request): Response {
  const url = new URL(req.url);
  const lastIdRaw =
    url.searchParams.get("last_event_id") ?? req.headers.get("last-event-id");
  const clientSession = url.searchParams.get("session");
  // If the client's session matches ours, honor their last id; otherwise replay full history.
  const lastId =
    clientSession === SESSION_ID && lastIdRaw ? Number(lastIdRaw) : 0;
  return makeSSE(async (send, signal) => {
    const q = new DropQueue<Entry>(UI_QUEUE_MAX);
    uiSubscribers.add(q);
    try {
      send({ type: "session", id: SESSION_ID });
      send(rosterSnapshot());
      send(presenceSnapshot());
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

function handleAgentStream(agent: string): Response {
  if (!validName(agent)) {
    return json({ error: `invalid agent name: ${agent}` }, { status: 400 });
  }
  ensureAgent(agent);
  const q = agentQueues.get(agent)!;
  return makeSSE(async (send, signal) => {
    agentConnections.set(agent, (agentConnections.get(agent) ?? 0) + 1);
    broadcastPresence();
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
        // No live connections left — schedule auto-removal after the stale window.
        scheduleStaleRemoval(agent);
      }
    }
  });
}

async function handleRemove(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { agent?: string };
  const name = (body.agent ?? "").trim();
  if (!name) return json({ error: "missing agent" }, { status: 400 });
  const removed = removeAgent(name, "manual");
  if (!removed) return json({ error: `unknown agent: ${name}` }, { status: 404 });
  return json({ ok: true });
}

// ── Server ─────────────────────────────────────────────────────
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  // Disable Bun's default 10s idle timeout — long-lived SSE connections
  // need to survive across periods of no traffic. Heartbeats also help.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (req.method === "GET" && pathname === "/agents")
        return json([...knownAgents.values()]);
      if (req.method === "GET" && pathname === "/presence")
        return json(presenceSnapshot());
      if (req.method === "GET" && pathname === "/stream") return handleStream(req);
      if (req.method === "GET" && pathname === "/agent-stream") {
        const agent = url.searchParams.get("agent") ?? "";
        return handleAgentStream(agent);
      }
      if (req.method === "POST" && pathname === "/send") return handleSend(req);
      if (req.method === "POST" && pathname === "/post") return handlePost(req);
      if (req.method === "POST" && pathname === "/remove") return handleRemove(req);
      if (req.method === "POST" && pathname === "/upload") return handleUpload(req);
      if (req.method === "GET" && pathname.startsWith("/image/")) {
        return handleImage(pathname.slice("/image/".length));
      }
      return json({ error: "not found", path: pathname }, { status: 404 });
    } catch (e) {
      console.error("[hub] error", e);
      return json({ error: String(e) }, { status: 500 });
    }
  },
});

console.log(`[hub] listening on http://${server.hostname}:${server.port}`);
console.log(`[hub] dynamic roster — agents register on /agent-stream connect`);
