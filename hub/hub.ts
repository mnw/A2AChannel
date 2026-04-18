/**
 * A2AChannel hub — dynamic-roster edition with token auth + protocol ledger.
 *
 * Any agent that connects to /agent-stream?agent=<NAME> is auto-registered.
 * The human is registered at startup as a permanent roster member.
 *
 * Env:
 *   PORT                     default 8011 (Rust shell always sets it)
 *   A2A_TOKEN                bearer token required on mutating routes
 *   A2A_ATTACHMENTS_DIR      absolute path where uploaded attachments are persisted
 *                            (legacy name A2A_IMAGES_DIR is read as a fallback)
 *   A2A_LEDGER_DB            absolute path to the SQLite ledger (structured-handoff)
 *   A2A_HUMAN_NAME           name of the human participant in the roster
 *   A2A_ALLOWED_EXTENSIONS   comma-separated file-extension allowlist
 */

import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8011);
const AUTH_TOKEN = (process.env.A2A_TOKEN ?? "").trim();
const ATTACHMENTS_DIR = (
  process.env.A2A_ATTACHMENTS_DIR ??
  process.env.A2A_IMAGES_DIR ?? // legacy env var from ≤ v0.4.x
  ""
).trim();
const LEDGER_DB = (process.env.A2A_LEDGER_DB ?? "").trim();
const HUMAN_NAME = (process.env.A2A_HUMAN_NAME ?? "human").trim();
const HISTORY_LIMIT = 1000;
const AGENT_QUEUE_MAX = 500;
const UI_QUEUE_MAX = 500;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const JSON_BODY_MAX = 262_144;         // 256 KiB (default for JSON routes)
const HANDOFF_BODY_MAX = 1_048_576;    // 1 MiB (only POST /handoffs)
const STALE_AGENT_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;
const HANDOFF_TTL_MIN_SECONDS = 1;
const HANDOFF_TTL_MAX_SECONDS = 86_400;
const HANDOFF_TTL_DEFAULT_SECONDS = 3_600;
const HANDOFF_CONTEXT_MAX_BYTES = 1_048_576;
const HANDOFF_TASK_MAX_CHARS = 500;
const HANDOFF_REASON_MAX_CHARS = 500;
const HANDOFF_ID_RE = /^h_[0-9a-f]{16}$/;
const LEDGER_SCHEMA_VERSION = 1;
type HandoffStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";
// User-configurable file-extension allowlist. Defaults match the Rust
// shell's default_attachment_extensions(); the env always wins when set.
const DEFAULT_ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "pdf", "md"];
const ALLOWED_EXTENSIONS = new Set<string>(
  ((process.env.A2A_ALLOWED_EXTENSIONS ?? "").split(",")
    .map((e) => e.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean)
    .filter((e) => /^[a-z0-9]{1,10}$/.test(e))),
);
if (ALLOWED_EXTENSIONS.size === 0) {
  for (const e of DEFAULT_ALLOWED_EXTENSIONS) ALLOWED_EXTENSIONS.add(e);
}
// Content-Type for the served file. Unknown but allowed extensions get
// served as octet-stream — the browser won't render them inline, which
// is actually the safe default. The CSP header on /image/ also blocks
// any execution if the file happens to be HTML/JS/SVG.
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  html: "text/html; charset=utf-8",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  log: "text/plain; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
};
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
// Allow letters, digits, spaces, and _.- inside; first and last char must be non-space.
const AGENT_NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;
// Generic attachment URL — extension is checked against ALLOWED_EXTENSIONS
// at upload time, so the regex only needs to constrain the URL shape.
const IMAGE_URL_RE = /^\/image\/[A-Za-z0-9_-]+\.[a-z0-9]{1,10}$/i;
const IMAGE_PATH_SEGMENT_RE = /^[A-Za-z0-9_-]+\.[a-z0-9]{1,10}$/i;
const RESERVED_NAMES = new Set(["you", "all", "system"]);

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
const permanentAgents = new Set<string>();  // agents exempt from stale cleanup
let entrySeq = 0;
const SESSION_ID = randomId(8);

// ── Ledger (SQLite) ────────────────────────────────────────────
let ledgerDb: Database | null = null;
let ledgerEnabled = false;

function openLedger(): void {
  if (!LEDGER_DB) return;
  try {
    ledgerDb = new Database(LEDGER_DB, { create: true });
    ledgerDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
    try {
      chmodSync(LEDGER_DB, 0o600);
    } catch (e) {
      console.error(`[ledger] chmod 0600 on ${LEDGER_DB} failed:`, e);
    }
    migrateLedger(ledgerDb);
    // WAL mode + the migration's first write materializes the -wal and
    // -shm sidecar files. SQLite creates them with the umask default
    // (typically 0644), which would expose ledger contents (incl. handoff
    // bodies) to other local users. Tighten to match the main DB.
    for (const suffix of ["-wal", "-shm"]) {
      const sidePath = `${LEDGER_DB}${suffix}`;
      try {
        chmodSync(sidePath, 0o600);
      } catch (e: unknown) {
        // ENOENT is expected if WAL hasn't materialized yet; ignore.
        const code = (e as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") {
          console.error(`[ledger] chmod 0600 on ${sidePath} failed:`, e);
        }
      }
    }
    ledgerEnabled = true;
    console.log(`[ledger] ready at ${LEDGER_DB}`);
  } catch (e) {
    console.error(`[ledger] open failed, protocol routes disabled:`, e);
    ledgerDb = null;
    ledgerEnabled = false;
  }
}

function migrateLedger(db: Database): void {
  // meta table is the version source of truth; create eagerly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  const current = row ? Number(row.value) : 0;
  if (current > LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `ledger schema_version=${current} is newer than this binary (${LEDGER_SCHEMA_VERSION}); refusing to downgrade`,
    );
  }
  if (current < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE events (
          seq          INTEGER PRIMARY KEY AUTOINCREMENT,
          handoff_id   TEXT    NOT NULL,
          kind         TEXT    NOT NULL,
          actor        TEXT    NOT NULL,
          payload_json TEXT    NOT NULL,
          at_ms        INTEGER NOT NULL
        );
        CREATE INDEX idx_events_handoff ON events(handoff_id, seq);
        CREATE INDEX idx_events_actor   ON events(actor, at_ms);

        CREATE TABLE handoffs (
          id             TEXT PRIMARY KEY,
          from_agent     TEXT    NOT NULL,
          to_agent       TEXT    NOT NULL,
          task           TEXT    NOT NULL,
          context_json   TEXT,
          status         TEXT    NOT NULL
                          CHECK(status IN ('pending','accepted','declined','cancelled','expired')),
          decline_reason TEXT,
          comment        TEXT,
          cancel_reason  TEXT,
          cancelled_by   TEXT,
          created_at_ms  INTEGER NOT NULL,
          expires_at_ms  INTEGER NOT NULL,
          resolved_at_ms INTEGER
        );
        CREATE INDEX idx_handoffs_status  ON handoffs(status, expires_at_ms);
        CREATE INDEX idx_handoffs_to      ON handoffs(to_agent, status);
        CREATE INDEX idx_handoffs_from    ON handoffs(from_agent, status);
        CREATE INDEX idx_handoffs_created ON handoffs(created_at_ms);
      `);
      db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [
        String(LEDGER_SCHEMA_VERSION),
      ]);
      db.run("INSERT INTO meta (key, value) VALUES ('ledger_id', ?)", [
        randomId(16),
      ]);
      db.run("INSERT INTO meta (key, value) VALUES ('created_at_ms', ?)", [
        String(Date.now()),
      ]);
    })();
    console.log(`[ledger] applied migration v1`);
  }
}

openLedger();

// ── Handoff state machine ──────────────────────────────────────
type HandoffSnapshot = {
  id: string;
  from_agent: string;
  to_agent: string;
  task: string;
  context: unknown;
  status: HandoffStatus;
  decline_reason: string | null;
  comment: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  resolved_at_ms: number | null;
  version: number;
};

type HandoffRow = {
  id: string;
  from_agent: string;
  to_agent: string;
  task: string;
  context_json: string | null;
  status: HandoffStatus;
  decline_reason: string | null;
  comment: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  resolved_at_ms: number | null;
};

function mintHandoffId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "h_";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

function handoffRowToSnapshot(row: HandoffRow, version: number): HandoffSnapshot {
  return {
    id: row.id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    task: row.task,
    context: row.context_json ? JSON.parse(row.context_json) : null,
    status: row.status,
    decline_reason: row.decline_reason,
    comment: row.comment,
    cancel_reason: row.cancel_reason,
    cancelled_by: row.cancelled_by,
    created_at_ms: row.created_at_ms,
    expires_at_ms: row.expires_at_ms,
    resolved_at_ms: row.resolved_at_ms,
    version,
  };
}

function loadHandoff(id: string): { row: HandoffRow; version: number } | null {
  if (!ledgerDb) return null;
  const row = ledgerDb
    .query<HandoffRow, [string]>("SELECT * FROM handoffs WHERE id = ?")
    .get(id);
  if (!row) return null;
  const verRow = ledgerDb
    .query<{ max_seq: number | null }, [string]>(
      "SELECT MAX(seq) AS max_seq FROM events WHERE handoff_id = ?",
    )
    .get(id);
  const version = verRow?.max_seq ?? 0;
  return { row, version };
}

function snapshotHandoff(id: string): HandoffSnapshot | null {
  const loaded = loadHandoff(id);
  return loaded ? handoffRowToSnapshot(loaded.row, loaded.version) : null;
}

function insertEvent(
  db: Database,
  handoff_id: string,
  kind: string,
  actor: string,
  payload: unknown,
  at_ms: number,
): number {
  const res = db.run(
    "INSERT INTO events (handoff_id, kind, actor, payload_json, at_ms) VALUES (?, ?, ?, ?, ?)",
    [handoff_id, kind, actor, JSON.stringify(payload ?? {}), at_ms],
  );
  return Number(res.lastInsertRowid);
}

type CreateHandoffInput = {
  from: string;
  to: string;
  task: string;
  context?: unknown;
  ttl_seconds?: number;
};

type HandoffOutcome =
  | { kind: "transition"; snapshot: HandoffSnapshot }
  | { kind: "idempotent"; snapshot: HandoffSnapshot }
  | { kind: "conflict"; current_status: HandoffStatus; snapshot: HandoffSnapshot }
  | { kind: "not_found" }
  | { kind: "forbidden"; reason: string };

function createHandoff(input: CreateHandoffInput): HandoffSnapshot {
  if (!ledgerDb) throw new Error("ledger disabled");
  const id = mintHandoffId();
  const now = Date.now();
  const ttl =
    input.ttl_seconds ?? HANDOFF_TTL_DEFAULT_SECONDS;
  const expires_at = now + ttl * 1000;
  const contextJson = input.context !== undefined ? JSON.stringify(input.context) : null;

  const db = ledgerDb;
  db.transaction(() => {
    insertEvent(
      db,
      id,
      "handoff.created",
      input.from,
      {
        to: input.to,
        task: input.task,
        context: input.context ?? null,
        ttl_seconds: ttl,
      },
      now,
    );
    db.run(
      `INSERT INTO handoffs
         (id, from_agent, to_agent, task, context_json, status,
          created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [id, input.from, input.to, input.task, contextJson, now, expires_at],
    );
  })();

  return snapshotHandoff(id)!;
}

function acceptHandoff(id: string, by: string, comment?: string): HandoffOutcome {
  if (!ledgerDb) throw new Error("ledger disabled");
  const loaded = loadHandoff(id);
  if (!loaded) return { kind: "not_found" };
  if (loaded.row.to_agent !== by) {
    return { kind: "forbidden", reason: "not the recipient" };
  }
  if (loaded.row.status === "accepted") {
    return { kind: "idempotent", snapshot: handoffRowToSnapshot(loaded.row, loaded.version) };
  }
  if (loaded.row.status !== "pending") {
    return {
      kind: "conflict",
      current_status: loaded.row.status,
      snapshot: handoffRowToSnapshot(loaded.row, loaded.version),
    };
  }
  const now = Date.now();
  const db = ledgerDb;
  db.transaction(() => {
    insertEvent(db, id, "handoff.accepted", by, { comment: comment ?? null }, now);
    db.run(
      "UPDATE handoffs SET status='accepted', comment=?, resolved_at_ms=? WHERE id=?",
      [comment ?? null, now, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotHandoff(id)! };
}

function declineHandoff(id: string, by: string, reason: string): HandoffOutcome {
  if (!ledgerDb) throw new Error("ledger disabled");
  const loaded = loadHandoff(id);
  if (!loaded) return { kind: "not_found" };
  if (loaded.row.to_agent !== by) {
    return { kind: "forbidden", reason: "not the recipient" };
  }
  if (loaded.row.status === "declined") {
    return { kind: "idempotent", snapshot: handoffRowToSnapshot(loaded.row, loaded.version) };
  }
  if (loaded.row.status !== "pending") {
    return {
      kind: "conflict",
      current_status: loaded.row.status,
      snapshot: handoffRowToSnapshot(loaded.row, loaded.version),
    };
  }
  const now = Date.now();
  const db = ledgerDb;
  db.transaction(() => {
    insertEvent(db, id, "handoff.declined", by, { reason }, now);
    db.run(
      "UPDATE handoffs SET status='declined', decline_reason=?, resolved_at_ms=? WHERE id=?",
      [reason, now, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotHandoff(id)! };
}

function cancelHandoff(id: string, by: string, reason?: string): HandoffOutcome {
  if (!ledgerDb) throw new Error("ledger disabled");
  const loaded = loadHandoff(id);
  if (!loaded) return { kind: "not_found" };
  if (loaded.row.from_agent !== by && by !== HUMAN_NAME) {
    return { kind: "forbidden", reason: "not the sender" };
  }
  if (loaded.row.status === "cancelled") {
    return { kind: "idempotent", snapshot: handoffRowToSnapshot(loaded.row, loaded.version) };
  }
  if (loaded.row.status !== "pending") {
    return {
      kind: "conflict",
      current_status: loaded.row.status,
      snapshot: handoffRowToSnapshot(loaded.row, loaded.version),
    };
  }
  const now = Date.now();
  const db = ledgerDb;
  db.transaction(() => {
    insertEvent(db, id, "handoff.cancelled", by, { reason: reason ?? null }, now);
    db.run(
      "UPDATE handoffs SET status='cancelled', cancel_reason=?, cancelled_by=?, resolved_at_ms=? WHERE id=?",
      [reason ?? null, by, now, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotHandoff(id)! };
}

function expireHandoff(id: string): HandoffSnapshot | null {
  if (!ledgerDb) return null;
  const loaded = loadHandoff(id);
  if (!loaded || loaded.row.status !== "pending") return null;
  const now = Date.now();
  const db = ledgerDb;
  db.transaction(() => {
    insertEvent(db, id, "handoff.expired", "system", {}, now);
    db.run(
      "UPDATE handoffs SET status='expired', resolved_at_ms=? WHERE id=?",
      [now, id],
    );
  })();
  return snapshotHandoff(id);
}

type ListHandoffsFilter = {
  status?: HandoffStatus | "all";
  for?: string;
  limit?: number;
};

function listHandoffs(filter: ListHandoffsFilter = {}): HandoffSnapshot[] {
  if (!ledgerDb) return [];
  const status = filter.status ?? "pending";
  const limit = Math.max(1, Math.min(1000, filter.limit ?? 100));
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (status !== "all") {
    clauses.push("status = ?");
    params.push(status);
  }
  if (filter.for) {
    clauses.push("(to_agent = ? OR from_agent = ?)");
    params.push(filter.for, filter.for);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // Bind LIMIT as a parameter — the value is already validated to a numeric
  // range above, but parameterization keeps the SQL builder discipline
  // uniform across all user-derived inputs.
  params.push(limit);
  const rows = ledgerDb
    .query<HandoffRow, typeof params>(
      `SELECT * FROM handoffs ${where} ORDER BY created_at_ms DESC LIMIT ?`,
    )
    .all(...params);
  // Version lookup per row — n+1 but n is bounded by limit (default 100).
  return rows.map((row) => {
    const ver = ledgerDb!
      .query<{ max_seq: number | null }, [string]>(
        "SELECT MAX(seq) AS max_seq FROM events WHERE handoff_id = ?",
      )
      .get(row.id);
    return handoffRowToSnapshot(row, ver?.max_seq ?? 0);
  });
}

function findExpirable(nowMs: number): string[] {
  if (!ledgerDb) return [];
  const rows = ledgerDb
    .query<{ id: string }, [number]>(
      "SELECT id FROM handoffs WHERE status='pending' AND expires_at_ms < ?",
    )
    .all(nowMs);
  return rows.map((r) => r.id);
}

function pendingFor(agent: string): HandoffSnapshot[] {
  return listHandoffs({ status: "pending", for: agent, limit: 1000 });
}

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
  if (permanentAgents.has(name)) return;   // human (and other permanent members) never stale-clean
  cancelStaleTimer(name);
  const t = setTimeout(() => {
    staleTimers.delete(name);
    if ((agentConnections.get(name) ?? 0) > 0) return;
    if (permanentAgents.has(name)) return;
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
    // Permanent roster members (e.g. the human) are always online whenever
    // the hub is running — they don't have a channel-bin to report via
    // /agent-stream, so connection-count would always be 0 and the pill
    // would show offline otherwise.
    agents[name] = permanentAgents.has(name)
      ? true
      : (agentConnections.get(name) ?? 0) > 0;
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
  return join(ATTACHMENTS_DIR, segment);
}

function agentEntry(entry: Entry): Entry {
  if (!entry.image) return entry;
  const absPath = ATTACHMENTS_DIR ? imageUrlToPath(entry.image) : entry.image;
  // Generic "attachment" prefix covers images, PDFs, markdown, etc. The
  // agent inspects the path's extension to decide whether to use Read
  // (text/code/markdown), Read with pages= (PDFs), or its image vision.
  const suffix = `\n[attachment: ${absPath}]`;
  return { ...entry, text: (entry.text ?? "") + suffix };
}

function enqueueTo(name: string, entry: Entry): void {
  // Permanent roster members (the human) have no channel-bin draining
  // their queue, so anything pushed here just fills up to AGENT_QUEUE_MAX
  // and gets dropped — pointless work. The human reads via /stream, which
  // already received this entry through broadcastUI.
  if (permanentAgents.has(name)) return;
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

// Reject requests that don't present the exact bearer token in the
// Authorization header. Used for mutating routes (POST). Returns null on
// success (authenticated), or a 401 Response on failure.
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

// Read-route auth: accepts either Authorization: Bearer header OR
// ?token=<token> query param. EventSource and <img> tags cannot set
// custom headers, so the query-param fallback is required for /stream,
// /agent-stream, /image/<id>, and JSON probes the UI makes via fetch.
// Tokens-in-URLs land in access logs — hub.log is mode 0600 to compensate.
function requireReadAuth(req: Request, url: URL): Response | null {
  if (!AUTH_TOKEN) {
    return json({ error: "hub misconfigured: no token" }, { status: 500 });
  }
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : (url.searchParams.get("token") ?? "").trim();
  if (!token || !ctEquals(token, AUTH_TOKEN)) {
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
  if (!ATTACHMENTS_DIR) {
    return json({ error: "attachments dir not configured" }, { status: 500 });
  }
  const sizeCheck = requireJsonBody(req, IMAGE_MAX_BYTES + 64 * 1024);
  if (sizeCheck) return sizeCheck;

  const form = await req.formData().catch(() => null);
  if (!form) return json({ error: "invalid form" }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "no file" }, { status: 400 });
  if (file.size > IMAGE_MAX_BYTES) {
    return json({ error: "file too large" }, { status: 413 });
  }
  // Extension-based allowlist. We trust the filename's extension over
  // the browser-provided MIME (which is sniffed and frequently wrong).
  // The /image/<id> serve route applies a strict CSP + nosniff so an
  // attacker mis-uploading HTML disguised as .pdf can't execute in the
  // viewer; agents read the file by absolute path with their own tooling.
  const rawName = (file.name ?? "").trim();
  const dot = rawName.lastIndexOf(".");
  const ext = dot >= 0 ? rawName.slice(dot + 1).toLowerCase() : "";
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    return json(
      {
        error: `extension '${ext || "(none)"}' not in allowlist (${[...ALLOWED_EXTENSIONS].sort().join(", ")})`,
      },
      { status: 400 },
    );
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  const id = randomId();
  const filename = `${id}.${ext}`;
  const target = join(ATTACHMENTS_DIR, filename);
  const tmp = join(ATTACHMENTS_DIR, `.${filename}.tmp`);
  try {
    await Bun.write(tmp, buf);
    // Tighten perms before publishing the file — the hub process is the
    // only legitimate reader (it serves /image/<id> over HTTP); other
    // local users have no business reading uploads off disk.
    chmodSync(tmp, 0o600);
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
  if (!ATTACHMENTS_DIR) {
    return json({ error: "attachments dir not configured" }, { status: 500 });
  }
  if (!IMAGE_PATH_SEGMENT_RE.test(segment)) {
    return json({ error: "invalid attachment path" }, { status: 400 });
  }
  const absPath = join(ATTACHMENTS_DIR, segment);
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

    // Reconnect replay: deliver any pending handoffs (as recipient OR originator)
    // so the agent can resume its open-work queue. Chat messages are NOT replayed.
    if (ledgerEnabled) {
      try {
        for (const snapshot of pendingFor(agent)) {
          send(handoffEntry(snapshot, "handoff.new", /* replay */ true));
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

// ── Handoff broadcasts ─────────────────────────────────────────
function handoffEntry(
  snapshot: HandoffSnapshot,
  eventKind: "handoff.new" | "handoff.update",
  replay = false,
): Entry & {
  kind: string;
  handoff_id: string;
  version: number;
  expires_at_ms: number;
  replay: boolean;
  snapshot: HandoffSnapshot;
} {
  return {
    from: snapshot.from_agent,
    to: snapshot.to_agent,
    text: JSON.stringify(snapshot),
    ts: ts(),
    image: null,
    kind: eventKind,
    handoff_id: snapshot.id,
    version: snapshot.version,
    expires_at_ms: snapshot.expires_at_ms,
    replay,
    snapshot,
  };
}

function broadcastHandoff(
  snapshot: HandoffSnapshot,
  eventKind: "handoff.new" | "handoff.update",
): void {
  const entry = handoffEntry(snapshot, eventKind);
  // Record in chat_log (gets a monotonic id from broadcastUI) + broadcast to all UI subscribers.
  broadcastUI(entry);
  // Push notifications to the relevant agents' queues.
  const recipients: string[] =
    eventKind === "handoff.new"
      ? [snapshot.to_agent]
      : [snapshot.from_agent, snapshot.to_agent];
  for (const name of new Set(recipients)) {
    // Permanent members (human) have no channel-bin to consume — they
    // already saw this via the broadcastUI call above.
    if (permanentAgents.has(name)) continue;
    const q = agentQueues.get(name);
    if (!q) continue;
    // Agents receive a slightly different shape: they don't need the `snapshot`
    // object embedded twice, since `text` already carries the JSON and channel.ts
    // forwards top-level fields as meta.
    const queueEntry = handoffEntry(snapshot, eventKind);
    q.push(queueEntry);
  }
}

// ── Handoff HTTP routes ────────────────────────────────────────
function ledgerGuard(): Response | null {
  if (!ledgerEnabled) {
    return json({ error: "ledger disabled" }, { status: 503 });
  }
  return null;
}

async function handleCreateHandoff(req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  const sizeCheck = requireJsonBody(req, HANDOFF_BODY_MAX);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as {
    from?: string;
    to?: string;
    task?: string;
    context?: unknown;
    ttl_seconds?: number;
  };
  const from = (body.from ?? "").trim();
  const to = (body.to ?? "").trim();
  const task = (body.task ?? "").trim();

  if (!validName(from)) return json({ error: "invalid from" }, { status: 400 });
  if (!validName(to)) return json({ error: "invalid to" }, { status: 400 });
  if (!task) return json({ error: "task required" }, { status: 400 });
  if (task.length > HANDOFF_TASK_MAX_CHARS) {
    return json({ error: `task too long (max ${HANDOFF_TASK_MAX_CHARS})` }, { status: 400 });
  }
  if (body.context !== undefined && body.context !== null) {
    const serialized = JSON.stringify(body.context);
    if (serialized.length > HANDOFF_CONTEXT_MAX_BYTES) {
      return json({ error: "context too large" }, { status: 400 });
    }
  }
  let ttl = body.ttl_seconds ?? HANDOFF_TTL_DEFAULT_SECONDS;
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) {
    return json({ error: "ttl_seconds must be a number" }, { status: 400 });
  }
  ttl = Math.trunc(ttl);
  if (ttl < HANDOFF_TTL_MIN_SECONDS || ttl > HANDOFF_TTL_MAX_SECONDS) {
    return json(
      { error: `ttl_seconds must be between ${HANDOFF_TTL_MIN_SECONDS} and ${HANDOFF_TTL_MAX_SECONDS}` },
      { status: 400 },
    );
  }

  ensureAgent(from);
  ensureAgent(to);

  const snapshot = createHandoff({ from, to, task, context: body.context, ttl_seconds: ttl });
  broadcastHandoff(snapshot, "handoff.new");
  return json({ id: snapshot.id }, { status: 201 });
}

function outcomeResponse(outcome: HandoffOutcome): Response {
  switch (outcome.kind) {
    case "not_found":
      return json({ error: "not found" }, { status: 404 });
    case "forbidden":
      return json({ error: outcome.reason }, { status: 403 });
    case "conflict":
      return json(
        { error: `handoff already ${outcome.current_status}`, snapshot: outcome.snapshot },
        { status: 409 },
      );
    case "idempotent":
      return json({ snapshot: outcome.snapshot, idempotent: true }, { status: 200 });
    case "transition":
      broadcastHandoff(outcome.snapshot, "handoff.update");
      return json({ snapshot: outcome.snapshot }, { status: 200 });
  }
}

async function handleAcceptHandoff(id: string, req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  if (!HANDOFF_ID_RE.test(id)) {
    return json({ error: "invalid handoff id" }, { status: 400 });
  }
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as { by?: string; comment?: string };
  const by = (body.by ?? "").trim();
  if (!validName(by)) return json({ error: "invalid by" }, { status: 400 });
  if (body.comment && body.comment.length > HANDOFF_REASON_MAX_CHARS) {
    return json({ error: "comment too long" }, { status: 400 });
  }
  return outcomeResponse(acceptHandoff(id, by, body.comment));
}

async function handleDeclineHandoff(id: string, req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  if (!HANDOFF_ID_RE.test(id)) {
    return json({ error: "invalid handoff id" }, { status: 400 });
  }
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as { by?: string; reason?: string };
  const by = (body.by ?? "").trim();
  const reason = (body.reason ?? "").trim();
  if (!validName(by)) return json({ error: "invalid by" }, { status: 400 });
  if (!reason) return json({ error: "reason required" }, { status: 400 });
  if (reason.length > HANDOFF_REASON_MAX_CHARS) {
    return json({ error: "reason too long" }, { status: 400 });
  }
  return outcomeResponse(declineHandoff(id, by, reason));
}

async function handleCancelHandoff(id: string, req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  if (!HANDOFF_ID_RE.test(id)) {
    return json({ error: "invalid handoff id" }, { status: 400 });
  }
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as { by?: string; reason?: string };
  const by = (body.by ?? "").trim();
  const reason = body.reason?.trim();
  if (!validName(by)) return json({ error: "invalid by" }, { status: 400 });
  if (reason && reason.length > HANDOFF_REASON_MAX_CHARS) {
    return json({ error: "reason too long" }, { status: 400 });
  }
  return outcomeResponse(cancelHandoff(id, by, reason));
}

function handleListHandoffs(req: Request): Response {
  const guard = ledgerGuard();
  if (guard) return guard;
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "pending";
  const forParam = url.searchParams.get("for") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 100;

  const validStatus = new Set(["pending", "accepted", "declined", "cancelled", "expired", "all"]);
  if (!validStatus.has(statusParam)) {
    return json({ error: `invalid status: ${statusParam}` }, { status: 400 });
  }
  if (forParam !== undefined && !validName(forParam)) {
    return json({ error: `invalid for: ${forParam}` }, { status: 400 });
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
    return json({ error: "invalid limit" }, { status: 400 });
  }

  return json(listHandoffs({ status: statusParam as HandoffStatus | "all", for: forParam, limit }));
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
      // Read endpoints — auth via header OR ?token= query param so EventSource
      // and <img> tags (which cannot set headers) can authenticate.
      if (req.method === "GET" && pathname === "/agents") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? json([...knownAgents.values()]);
      }
      if (req.method === "GET" && pathname === "/presence") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? json(presenceSnapshot());
      }
      if (req.method === "GET" && pathname === "/stream") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? handleStream(req);
      }
      if (req.method === "GET" && pathname === "/agent-stream") {
        const authFail = requireReadAuth(req, url);
        if (authFail) return authFail;
        const agent = url.searchParams.get("agent") ?? "";
        return handleAgentStream(agent);
      }
      if (req.method === "GET" && pathname.startsWith("/image/")) {
        const authFail = requireReadAuth(req, url);
        return authFail ?? (await handleImage(pathname.slice("/image/".length)));
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
      // Handoff endpoints.
      if (req.method === "POST" && pathname === "/handoffs") {
        const authFail = requireAuth(req);
        return authFail ?? (await handleCreateHandoff(req));
      }
      if (req.method === "POST" && pathname.startsWith("/handoffs/")) {
        const match = pathname.match(/^\/handoffs\/([^/]+)\/(accept|decline|cancel)$/);
        if (match) {
          const authFail = requireAuth(req);
          if (authFail) return authFail;
          const [, id, action] = match;
          if (action === "accept") return await handleAcceptHandoff(id, req);
          if (action === "decline") return await handleDeclineHandoff(id, req);
          if (action === "cancel") return await handleCancelHandoff(id, req);
        }
      }
      if (req.method === "GET" && pathname === "/handoffs") {
        const authFail = requireAuth(req);
        return authFail ?? handleListHandoffs(req);
      }
      return json({ error: "not found", path: pathname }, { status: 404 });
    } catch (e) {
      console.error("[hub] error", e);
      return json({ error: String(e) }, { status: 500 });
    }
  },
});

// Register the human as a permanent roster member so handoffs can target them
// and so the UI legend/mention autocomplete always lists them.
if (validName(HUMAN_NAME)) {
  permanentAgents.add(HUMAN_NAME);
  ensureAgent(HUMAN_NAME);
  console.log(`[hub] human registered as "${HUMAN_NAME}" (permanent)`);
} else {
  console.error(`[hub] invalid A2A_HUMAN_NAME "${HUMAN_NAME}" — human not registered`);
}

// Expiry sweep: every SWEEP_INTERVAL_MS, transition pending handoffs whose
// expires_at_ms has passed into status='expired' with an audit event.
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
