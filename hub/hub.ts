/**
 * A2AChannel hub — dynamic-roster edition with token auth.
 *
 * Any agent that connects to /agent-stream?agent=<NAME> is auto-registered.
 * Colors are derived from a hash of the name (deterministic).
 *
 * Env:
 *   PORT       default 8011 (Rust shell always sets it)
 *   A2A_TOKEN  bearer token required on mutating routes (Rust shell always sets it;
 *              if absent, mutating routes refuse all requests)
 */

import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8011);
const AUTH_TOKEN = (process.env.A2A_TOKEN ?? "").trim();
const IMAGES_DIR = (process.env.A2A_IMAGES_DIR ?? "").trim();
const HISTORY_LIMIT = 1000;
const AGENT_QUEUE_MAX = 500;
const UI_QUEUE_MAX = 500;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const JSON_BODY_MAX = 262_144; // 256 KiB
const STALE_AGENT_MS = 15_000;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  // image/svg+xml intentionally omitted — SVG can carry executable content.
]);
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
// Allow letters, digits, spaces, and _.- inside; first and last char must be non-space.
const AGENT_NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;
const IMAGE_URL_RE = /^\/image\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i;
const IMAGE_PATH_SEGMENT_RE = /^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i;
const RESERVED_NAMES = new Set(["you", "all", "system"]);

if (!AUTH_TOKEN) {
  console.error(
    "[hub] A2A_TOKEN env not set — mutating routes will reject all requests",
  );
}
if (!IMAGES_DIR) {
  console.error(
    "[hub] A2A_IMAGES_DIR env not set — uploads will fail",
  );
}

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
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 70%, 75%)`;
}

function validName(name: string): boolean {
  return (
    !!name &&
    AGENT_NAME_RE.test(name) &&
    !RESERVED_NAMES.has(name.toLowerCase())
  );
}

// Constant-time string comparison. Returns false immediately for unequal
// lengths (a length oracle is not a secret leak).
function ctEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function ensureAgent(name: string): Agent | null {
  if (!validName(name)) return null;
  const existing = knownAgents.get(name);
  if (existing) {
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

// Rewrite /image/<id>.<ext> URLs to absolute disk paths so agents can read
// them directly with their Read tool. The UI still receives the URL form
// via /stream; only agent-facing deliveries get the rewrite.
function imageUrlToPath(url: string): string {
  // Caller has already validated against IMAGE_URL_RE.
  const segment = url.slice("/image/".length);
  return join(IMAGES_DIR, segment);
}

function agentEntry(entry: Entry): Entry {
  if (!entry.image) return entry;
  const absPath = IMAGES_DIR ? imageUrlToPath(entry.image) : entry.image;
  const suffix = `\n[image: ${absPath}]`;
  return { ...entry, text: (entry.text ?? "") + suffix };
}

function enqueueTo(name: string, entry: Entry): void {
  const q = agentQueues.get(name);
  if (!q) return; // agent was removed between target resolution and dispatch
  q.push(entry);
}

// ── HTTP helpers ───────────────────────────────────────────────
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

// Reject requests that don't present the exact bearer token. Returns null
// on success (authenticated), or a 401 Response on failure.
function requireAuth(req: Request): Response | null {
  if (!AUTH_TOKEN) {
    return json({ error: "hub misconfigured: no token" }, { status: 500 });
  }
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !ctEquals(match[1].trim(), AUTH_TOKEN)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

// Body size gate for JSON routes. Returns null on success, or a 411/413
// Response on failure. Must be called *before* req.json() or req.text().
function requireJsonBody(req: Request, max = JSON_BODY_MAX): Response | null {
  const lenRaw = req.headers.get("content-length");
  if (lenRaw === null) {
    return json({ error: "length required" }, { status: 411 });
  }
  const len = Number(lenRaw);
  if (!Number.isFinite(len) || len < 0) {
    return json({ error: "invalid content-length" }, { status: 400 });
  }
  if (len > max) {
    return json({ error: "payload too large" }, { status: 413 });
  }
  return null;
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

// ── Upload magic-byte validation ────────────────────────────────
function matchesMagic(bytes: Uint8Array, ctype: string): boolean {
  if (bytes.length < 12) return false;
  switch (ctype) {
    case "image/png":
      // 89 50 4E 47 0D 0A 1A 0A
      return (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "image/jpeg":
      // FF D8 FF
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      // GIF87a or GIF89a: 47 49 46 38 (37|39) 61
      return (
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
      );
    case "image/webp":
      // RIFF....WEBP — bytes 0-3 "RIFF", bytes 8-11 "WEBP"
      return (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    default:
      return false;
  }
}

// ── Routes ─────────────────────────────────────────────────────
async function handleSend(req: Request): Promise<Response> {
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as {
    text?: string;
    image?: string | null;
    target?: string;
    targets?: string[];
  };
  const text = (body.text ?? "").trim();
  const image = body.image || null;
  if (!text && !image) return json({ error: "empty" }, { status: 400 });
  if (image && !IMAGE_URL_RE.test(image)) {
    return json({ error: "invalid image url" }, { status: 400 });
  }

  let targets: string[];
  let broadcast = false;

  if (Array.isArray(body.targets) && body.targets.length) {
    // Validate every element first; only then expand "all".
    for (const t of body.targets) {
      if (t === "all") continue;
      if (!knownAgents.has(t)) {
        return json({ error: `unknown target: ${t}` }, { status: 400 });
      }
    }
    const resolved: string[] = [];
    for (const t of body.targets) {
      if (t === "all") {
        resolved.splice(0, resolved.length, ...knownAgents.keys());
        broadcast = true;
        break;
      }
      if (!resolved.includes(t)) resolved.push(t);
    }
    targets = resolved;
  } else if (!body.target || body.target === "all") {
    targets = [...knownAgents.keys()];
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

  const toLabel = broadcast
    ? "all"
    : targets.length === 1
      ? targets[0]
      : targets.join(",");

  const entry: Entry = { from: "you", to: toLabel, text, image, ts: ts() };
  broadcastUI(entry);
  const view = agentEntry(entry);
  for (const t of targets) enqueueTo(t, view);
  return json({ ok: true });
}

async function handlePost(req: Request): Promise<Response> {
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as {
    from?: string;
    to?: string;
    text?: string;
  };
  const frm = body.from;
  const rawTo = body.to ?? "you";
  const reserved = rawTo.toLowerCase();
  const text = (body.text ?? "").trim();
  if (!frm || !text) {
    return json({ error: "bad request" }, { status: 400 });
  }
  // ensureAgent validates the name; no need to pre-validate.
  if (!ensureAgent(frm)) {
    return json({ error: `invalid from: ${frm}` }, { status: 400 });
  }

  let targets: string[];
  if (reserved === "you") {
    targets = [];
  } else if (reserved === "all") {
    targets = [...knownAgents.keys()].filter((a) => a !== frm);
  } else if (knownAgents.has(rawTo)) {
    // Case-sensitive match against original name.
    targets = [rawTo];
  } else {
    return json({ error: `unknown to: ${rawTo}` }, { status: 400 });
  }

  const entry: Entry = { from: frm, to: rawTo, text, ts: ts() };
  broadcastUI(entry);
  for (const t of targets) enqueueTo(t, entry);
  return json({ ok: true });
}

async function handleUpload(req: Request): Promise<Response> {
  if (!IMAGES_DIR) {
    return json({ error: "images dir not configured" }, { status: 500 });
  }
  const sizeCheck = requireJsonBody(req, IMAGE_MAX_BYTES + 64 * 1024);
  if (sizeCheck) return sizeCheck;

  const form = await req.formData().catch(() => null);
  if (!form) return json({ error: "invalid form" }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "no file" }, { status: 400 });
  const ctype = (file.type ?? "").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(ctype)) {
    return json({ error: `unsupported type: ${ctype}` }, { status: 400 });
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return json({ error: "file too large" }, { status: 413 });
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!matchesMagic(buf, ctype)) {
    return json(
      { error: `content does not match declared type ${ctype}` },
      { status: 400 },
    );
  }

  const ext = MIME_TO_EXT[ctype];
  if (!ext) {
    return json({ error: `no extension mapping for ${ctype}` }, { status: 500 });
  }
  const id = randomId();
  const filename = `${id}.${ext}`;
  const target = join(IMAGES_DIR, filename);
  const tmp = join(IMAGES_DIR, `.${filename}.tmp`);
  try {
    await Bun.write(tmp, buf);
    // Atomic rename; writes are visible only after this completes.
    await Bun.$`mv ${tmp} ${target}`.quiet();
  } catch (e) {
    try {
      await Bun.$`rm -f ${tmp}`.quiet();
    } catch {}
    console.error("[hub] upload write failed:", e);
    return json({ error: "failed to persist image" }, { status: 500 });
  }
  return json({ url: `/image/${filename}`, id });
}

async function handleImage(segment: string): Promise<Response> {
  if (!IMAGES_DIR) {
    return json({ error: "images dir not configured" }, { status: 500 });
  }
  if (!IMAGE_PATH_SEGMENT_RE.test(segment)) {
    return json({ error: "invalid image path" }, { status: 400 });
  }
  const absPath = join(IMAGES_DIR, segment);
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    return json({ error: "not found" }, { status: 404 });
  }
  const dot = segment.lastIndexOf(".");
  const ext = segment.slice(dot + 1).toLowerCase();
  const ctype = EXT_TO_MIME[ext] ?? "application/octet-stream";
  return new Response(file, {
    headers: {
      "Content-Type": ctype,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
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
  const q = agentQueues.get(agent);
  if (!q) {
    return json({ error: "agent queue missing" }, { status: 500 });
  }
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

// ── Server ─────────────────────────────────────────────────────
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
      // Public read endpoints.
      if (req.method === "GET" && pathname === "/agents")
        return json([...knownAgents.values()]);
      if (req.method === "GET" && pathname === "/presence")
        return json(presenceSnapshot());
      if (req.method === "GET" && pathname === "/stream") return handleStream(req);
      if (req.method === "GET" && pathname === "/agent-stream") {
        const agent = url.searchParams.get("agent") ?? "";
        return handleAgentStream(agent);
      }
      if (req.method === "GET" && pathname.startsWith("/image/")) {
        return await handleImage(pathname.slice("/image/".length));
      }

      // Authenticated mutating endpoints.
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
      return json({ error: "not found", path: pathname }, { status: 404 });
    } catch (e) {
      console.error("[hub] error", e);
      return json({ error: String(e) }, { status: 500 });
    }
  },
});

console.log(`[hub] listening on http://${server.hostname}:${server.port}`);
console.log(
  `[hub] dynamic roster — agents register on /agent-stream connect (auth ${AUTH_TOKEN ? "enabled" : "DISABLED"})`,
);
