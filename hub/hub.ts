// A2AChannel hub. Dynamic roster; any agent that hits /agent-stream?agent=<n> auto-registers.
// Env vars: PORT, A2A_TOKEN, A2A_ATTACHMENTS_DIR, A2A_LEDGER_DB, A2A_HUMAN_NAME, A2A_ALLOWED_EXTENSIONS.

import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";

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
const HISTORY_LIMIT = 1000;
const AGENT_QUEUE_MAX = 500;
const UI_QUEUE_MAX = 500;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const JSON_BODY_MAX = 262_144;         // 256 KiB (default for JSON routes)
const HANDOFF_BODY_MAX = 1_048_576;    // 1 MiB (only POST /handoffs)
const PERMISSION_BODY_MAX = 16_384;    // 16 KiB (POST /permissions — bounded fields)
const STALE_AGENT_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;
const HANDOFF_TTL_MIN_SECONDS = 1;
const HANDOFF_TTL_MAX_SECONDS = 86_400;
const HANDOFF_TTL_DEFAULT_SECONDS = 3_600;
const HANDOFF_CONTEXT_MAX_BYTES = 1_048_576;
const HANDOFF_TASK_MAX_CHARS = 500;
const HANDOFF_REASON_MAX_CHARS = 500;
const HANDOFF_ID_RE = /^h_[0-9a-f]{16}$/;
const LEDGER_SCHEMA_VERSION = 5;
type HandoffStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";
// Extension allowlist; env wins over the defaults (which match the Rust shell's defaults).
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
// Unknown-but-allowed extensions serve as octet-stream; the strict CSP on /image/ blocks execution.
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
const AGENT_NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;
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

const knownAgents = new Map<string, Agent>();
const chatLog: Entry[] = [];
const uiSubscribers = new Set<DropQueue<Entry>>();
const agentQueues = new Map<string, DropQueue<Entry>>();
const agentConnections = new Map<string, number>();
const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const permanentAgents = new Set<string>();  // agents exempt from stale cleanup
let entrySeq = 0;
const SESSION_ID = randomId(8);

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
    // WAL-mode sidecars (-wal/-shm) are created by SQLite with umask default; tighten to 0600.
    for (const suffix of ["-wal", "-shm"]) {
      const sidePath = `${LEDGER_DB}${suffix}`;
      try {
        chmodSync(sidePath, 0o600);
      } catch (e: unknown) {
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
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')");
      db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('ledger_id', ?)", [
        randomId(16),
      ]);
      db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at_ms', ?)", [
        String(Date.now()),
      ]);
    })();
    console.log(`[ledger] applied migration v1`);
  }
  if (current < 2) {
    // v2 migration: adds `interrupts` + `nutshell` tables; reuses `events` for all kinds.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE interrupts (
          id                TEXT PRIMARY KEY,
          from_agent        TEXT    NOT NULL,
          to_agent          TEXT    NOT NULL,
          text              TEXT    NOT NULL,
          status            TEXT    NOT NULL
                              CHECK(status IN ('pending','acknowledged')),
          created_at_ms     INTEGER NOT NULL,
          acknowledged_at_ms INTEGER,
          acknowledged_by   TEXT
        );
        CREATE INDEX idx_interrupts_status ON interrupts(status, created_at_ms);
        CREATE INDEX idx_interrupts_to     ON interrupts(to_agent, status);
        CREATE INDEX idx_interrupts_from   ON interrupts(from_agent, status);

        CREATE TABLE nutshell (
          id             INTEGER PRIMARY KEY CHECK(id = 0),
          text           TEXT    NOT NULL DEFAULT '',
          version        INTEGER NOT NULL DEFAULT 0,
          updated_at_ms  INTEGER NOT NULL,
          updated_by     TEXT
        );
      `);
      db.run(
        "INSERT OR IGNORE INTO nutshell (id, text, version, updated_at_ms, updated_by) VALUES (0, '', 0, ?, NULL)",
        [Date.now()],
      );
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')");
    })();
    console.log(`[ledger] applied migration v2`);
  }
  if (current < 3) {
    // v3 migration: claude-session capture keyed by (agent, cwd) for the spawn modal's restore flow.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE claude_sessions (
          agent          TEXT    NOT NULL,
          cwd            TEXT    NOT NULL,
          resume_flag    TEXT    NOT NULL,
          captured_at_ms INTEGER NOT NULL,
          PRIMARY KEY (agent, cwd)
        );
        CREATE INDEX idx_claude_sessions_agent ON claude_sessions(agent);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')");
    })();
    console.log(`[ledger] applied migration v3`);
  }
  if (current < 4) {
    // v4 migration: Claude Code permission-relay. Pending approvals re-enter the room.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE permissions (
          id              TEXT PRIMARY KEY,
          agent           TEXT    NOT NULL,
          tool_name       TEXT    NOT NULL,
          description     TEXT    NOT NULL,
          input_preview   TEXT    NOT NULL,
          status          TEXT    NOT NULL
                            CHECK(status IN ('pending','allowed','denied')),
          created_at_ms   INTEGER NOT NULL,
          resolved_at_ms  INTEGER,
          resolved_by     TEXT,
          behavior        TEXT CHECK(behavior IS NULL OR behavior IN ('allow','deny'))
        );
        CREATE INDEX idx_permissions_status ON permissions(status, created_at_ms);
        CREATE INDEX idx_permissions_agent  ON permissions(agent, status);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')");
    })();
    console.log(`[ledger] applied migration v4`);
  }
  if (current < 5) {
    // v5 migration: add 'dismissed' terminal state to permissions.status so users
    // can clear xterm-first ghost cards (claude answered the approval locally and
    // never notified the channel, so the row would otherwise stay pending forever).
    // SQLite can't ALTER a CHECK constraint in place — copy-drop-rename.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE permissions_new (
          id              TEXT PRIMARY KEY,
          agent           TEXT    NOT NULL,
          tool_name       TEXT    NOT NULL,
          description     TEXT    NOT NULL,
          input_preview   TEXT    NOT NULL,
          status          TEXT    NOT NULL
                            CHECK(status IN ('pending','allowed','denied','dismissed')),
          created_at_ms   INTEGER NOT NULL,
          resolved_at_ms  INTEGER,
          resolved_by     TEXT,
          behavior        TEXT CHECK(behavior IS NULL OR behavior IN ('allow','deny'))
        );
        INSERT INTO permissions_new SELECT * FROM permissions;
        DROP TABLE permissions;
        ALTER TABLE permissions_new RENAME TO permissions;
        CREATE INDEX idx_permissions_status ON permissions(status, created_at_ms);
        CREATE INDEX idx_permissions_agent  ON permissions(agent, status);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')");
    })();
    console.log(`[ledger] applied migration v5`);
  }
}

openLedger();

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
  // Nutshell proposals (task prefix "[nutshell]") apply context.patch in the same tx as accept.
  let nutshellSnapshot: NutshellSnapshot | null = null;
  const isNutshellEdit =
    loaded.row.task.startsWith("[nutshell]") &&
    loaded.row.to_agent === HUMAN_NAME &&
    loaded.row.context_json !== null;
  let nutshellPatch: string | null = null;
  if (isNutshellEdit) {
    try {
      const ctx = JSON.parse(loaded.row.context_json!);
      if (ctx && typeof ctx === "object" && typeof ctx.patch === "string") {
        nutshellPatch = ctx.patch;
      }
    } catch {
      // Malformed context — accept the handoff but skip the nutshell patch.
    }
  }
  db.transaction(() => {
    insertEvent(db, id, "handoff.accepted", by, { comment: comment ?? null }, now);
    db.run(
      "UPDATE handoffs SET status='accepted', comment=?, resolved_at_ms=? WHERE id=?",
      [comment ?? null, now, id],
    );
    if (nutshellPatch !== null) {
      nutshellSnapshot = writeNutshellInTx(db, nutshellPatch, loaded.row.from_agent);
    }
  })();
  const outcome: HandoffOutcome = { kind: "transition", snapshot: snapshotHandoff(id)! };
  if (nutshellSnapshot) {
    broadcastNutshell(nutshellSnapshot);
  }
  return outcome;
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
  params.push(limit);
  const rows = ledgerDb
    .query<HandoffRow, typeof params>(
      `SELECT * FROM handoffs ${where} ORDER BY created_at_ms DESC LIMIT ?`,
    )
    .all(...params);
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

type NutshellSnapshot = {
  text: string;
  version: number;
  updated_at_ms: number;
  updated_by: string | null;
};

type NutshellRow = {
  text: string;
  version: number;
  updated_at_ms: number;
  updated_by: string | null;
};

function readNutshell(): NutshellSnapshot {
  if (!ledgerDb) {
    return { text: "", version: 0, updated_at_ms: Date.now(), updated_by: null };
  }
  const row = ledgerDb
    .query<NutshellRow, []>("SELECT text, version, updated_at_ms, updated_by FROM nutshell WHERE id = 0")
    .get();
  if (!row) {
    // Shouldn't happen — v2 migration seeds a row. Fail open.
    return { text: "", version: 0, updated_at_ms: Date.now(), updated_by: null };
  }
  return {
    text: row.text,
    version: row.version,
    updated_at_ms: row.updated_at_ms,
    updated_by: row.updated_by,
  };
}

// Caller must wrap this in the same transaction as the triggering event (handoff accept).
function writeNutshellInTx(
  db: Database,
  newText: string,
  updatedBy: string,
): NutshellSnapshot {
  const now = Date.now();
  db.run(
    "UPDATE nutshell SET text = ?, version = version + 1, updated_at_ms = ?, updated_by = ? WHERE id = 0",
    [newText, now, updatedBy],
  );
  const row = db
    .query<NutshellRow, []>("SELECT text, version, updated_at_ms, updated_by FROM nutshell WHERE id = 0")
    .get();
  return {
    text: row?.text ?? newText,
    version: row?.version ?? 0,
    updated_at_ms: row?.updated_at_ms ?? now,
    updated_by: row?.updated_by ?? updatedBy,
  };
}

type InterruptStatus = "pending" | "acknowledged";

type InterruptSnapshot = {
  id: string;
  from_agent: string;
  to_agent: string;
  text: string;
  status: InterruptStatus;
  created_at_ms: number;
  acknowledged_at_ms: number | null;
  acknowledged_by: string | null;
  version: number;
};

type InterruptRow = {
  id: string;
  from_agent: string;
  to_agent: string;
  text: string;
  status: InterruptStatus;
  created_at_ms: number;
  acknowledged_at_ms: number | null;
  acknowledged_by: string | null;
};

const INTERRUPT_ID_RE = /^i_[0-9a-f]{16}$/;

function mintInterruptId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "i_";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

function interruptRowToSnapshot(row: InterruptRow, version: number): InterruptSnapshot {
  return {
    id: row.id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    text: row.text,
    status: row.status,
    created_at_ms: row.created_at_ms,
    acknowledged_at_ms: row.acknowledged_at_ms,
    acknowledged_by: row.acknowledged_by,
    version,
  };
}

function loadInterrupt(id: string): { row: InterruptRow; version: number } | null {
  if (!ledgerDb) return null;
  const row = ledgerDb
    .query<InterruptRow, [string]>("SELECT * FROM interrupts WHERE id = ?")
    .get(id);
  if (!row) return null;
  const verRow = ledgerDb
    .query<{ max_seq: number | null }, [string]>(
      "SELECT MAX(seq) AS max_seq FROM events WHERE handoff_id = ?",
    )
    .get(id);
  return { row, version: verRow?.max_seq ?? 0 };
}

function snapshotInterrupt(id: string): InterruptSnapshot | null {
  const loaded = loadInterrupt(id);
  return loaded ? interruptRowToSnapshot(loaded.row, loaded.version) : null;
}

type CreateInterruptInput = { from: string; to: string; text: string };

function createInterrupt(input: CreateInterruptInput): InterruptSnapshot {
  if (!ledgerDb) throw new Error("ledger disabled");
  const id = mintInterruptId();
  const now = Date.now();
  const db = ledgerDb;
  db.transaction(() => {
    insertEvent(db, id, "interrupt.new", input.from, { to: input.to, text: input.text }, now);
    db.run(
      `INSERT INTO interrupts (id, from_agent, to_agent, text, status, created_at_ms)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [id, input.from, input.to, input.text, now],
    );
  })();
  return snapshotInterrupt(id)!;
}

type InterruptOutcome =
  | { kind: "transition"; snapshot: InterruptSnapshot }
  | { kind: "idempotent"; snapshot: InterruptSnapshot }
  | { kind: "conflict"; current_status: InterruptStatus; snapshot: InterruptSnapshot }
  | { kind: "not_found" }
  | { kind: "forbidden"; reason: string };

function ackInterrupt(id: string, by: string): InterruptOutcome {
  if (!ledgerDb) throw new Error("ledger disabled");
  const loaded = loadInterrupt(id);
  if (!loaded) return { kind: "not_found" };
  // Recipient or human can ack — human may ack on behalf of a non-responding agent.
  if (loaded.row.to_agent !== by && by !== HUMAN_NAME) {
    return { kind: "forbidden", reason: "not the recipient" };
  }
  if (loaded.row.status === "acknowledged") {
    return { kind: "idempotent", snapshot: interruptRowToSnapshot(loaded.row, loaded.version) };
  }
  if (loaded.row.status !== "pending") {
    return {
      kind: "conflict",
      current_status: loaded.row.status,
      snapshot: interruptRowToSnapshot(loaded.row, loaded.version),
    };
  }
  const now = Date.now();
  const db = ledgerDb;
  db.transaction(() => {
    insertEvent(db, id, "interrupt.ack", by, {}, now);
    db.run(
      "UPDATE interrupts SET status = 'acknowledged', acknowledged_at_ms = ?, acknowledged_by = ? WHERE id = ?",
      [now, by, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotInterrupt(id)! };
}

type ListInterruptsFilter = {
  status?: InterruptStatus | "all";
  for?: string;
  limit?: number;
};

function listInterrupts(filter: ListInterruptsFilter = {}): InterruptSnapshot[] {
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
  params.push(limit);
  const rows = ledgerDb
    .query<InterruptRow, typeof params>(
      `SELECT * FROM interrupts ${where} ORDER BY created_at_ms DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map((row) => {
    const ver = ledgerDb!
      .query<{ max_seq: number | null }, [string]>(
        "SELECT MAX(seq) AS max_seq FROM events WHERE handoff_id = ?",
      )
      .get(row.id);
    return interruptRowToSnapshot(row, ver?.max_seq ?? 0);
  });
}

function pendingInterruptsFor(agent: string): InterruptSnapshot[] {
  return listInterrupts({ status: "pending", for: agent, limit: 1000 });
}

// -------- Permissions (Claude Code permission-relay) --------

type PermissionStatus = "pending" | "allowed" | "denied" | "dismissed";
type PermissionBehavior = "allow" | "deny";

type PermissionSnapshot = {
  id: string;
  agent: string;
  tool_name: string;
  description: string;
  input_preview: string;
  status: PermissionStatus;
  created_at_ms: number;
  resolved_at_ms: number | null;
  resolved_by: string | null;
  behavior: PermissionBehavior | null;
  version: number;
};

type PermissionRow = {
  id: string;
  agent: string;
  tool_name: string;
  description: string;
  input_preview: string;
  status: PermissionStatus;
  created_at_ms: number;
  resolved_at_ms: number | null;
  resolved_by: string | null;
  behavior: PermissionBehavior | null;
};

// claude emits request_ids as 5 lowercase letters a-z excluding 'l'.
const PERMISSION_ID_RE = /^[a-km-z]{5}$/i;
const PERMISSION_TOOL_NAME_MAX_CHARS = 120;
const PERMISSION_DESCRIPTION_MAX_CHARS = 2_000;
const PERMISSION_INPUT_PREVIEW_MAX_CHARS = 8_000;

function permissionRowToSnapshot(row: PermissionRow, version: number): PermissionSnapshot {
  return {
    id: row.id,
    agent: row.agent,
    tool_name: row.tool_name,
    description: row.description,
    input_preview: row.input_preview,
    status: row.status,
    created_at_ms: row.created_at_ms,
    resolved_at_ms: row.resolved_at_ms,
    resolved_by: row.resolved_by,
    behavior: row.behavior,
    version,
  };
}

function loadPermission(id: string): { row: PermissionRow; version: number } | null {
  if (!ledgerDb) return null;
  const row = ledgerDb
    .query<PermissionRow, [string]>("SELECT * FROM permissions WHERE id = ?")
    .get(id);
  if (!row) return null;
  const verRow = ledgerDb
    .query<{ max_seq: number | null }, [string]>(
      "SELECT MAX(seq) AS max_seq FROM events WHERE handoff_id = ?",
    )
    .get(id);
  return { row, version: verRow?.max_seq ?? 0 };
}

function snapshotPermission(id: string): PermissionSnapshot | null {
  const loaded = loadPermission(id);
  return loaded ? permissionRowToSnapshot(loaded.row, loaded.version) : null;
}

type CreatePermissionInput = {
  agent: string;
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
};

type PermissionCreateOutcome =
  | { kind: "created"; snapshot: PermissionSnapshot }
  | { kind: "idempotent"; snapshot: PermissionSnapshot }  // same-id replay while still pending
  | { kind: "conflict"; snapshot: PermissionSnapshot };   // id already resolved

function createPermission(input: CreatePermissionInput): PermissionCreateOutcome {
  if (!ledgerDb) throw new Error("ledger disabled");
  const existing = loadPermission(input.request_id);
  if (existing) {
    const snap = permissionRowToSnapshot(existing.row, existing.version);
    return existing.row.status === "pending"
      ? { kind: "idempotent", snapshot: snap }
      : { kind: "conflict", snapshot: snap };
  }
  const now = Date.now();
  const db = ledgerDb;
  db.transaction(() => {
    insertEvent(
      db,
      input.request_id,
      "permission.new",
      input.agent,
      {
        tool_name: input.tool_name,
        description: input.description,
        input_preview: input.input_preview,
      },
      now,
    );
    db.run(
      `INSERT INTO permissions
         (id, agent, tool_name, description, input_preview, status, created_at_ms)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [input.request_id, input.agent, input.tool_name, input.description, input.input_preview, now],
    );
  })();
  return { kind: "created", snapshot: snapshotPermission(input.request_id)! };
}

type PermissionOutcome =
  | { kind: "transition"; snapshot: PermissionSnapshot }
  | { kind: "idempotent"; snapshot: PermissionSnapshot }
  | { kind: "conflict"; current_status: PermissionStatus; snapshot: PermissionSnapshot }
  | { kind: "not_found" };

function resolvePermission(id: string, by: string, behavior: PermissionBehavior): PermissionOutcome {
  if (!ledgerDb) throw new Error("ledger disabled");
  const loaded = loadPermission(id);
  if (!loaded) return { kind: "not_found" };
  const targetStatus: PermissionStatus = behavior === "allow" ? "allowed" : "denied";
  if (loaded.row.status === targetStatus) {
    return { kind: "idempotent", snapshot: permissionRowToSnapshot(loaded.row, loaded.version) };
  }
  if (loaded.row.status !== "pending") {
    return {
      kind: "conflict",
      current_status: loaded.row.status,
      snapshot: permissionRowToSnapshot(loaded.row, loaded.version),
    };
  }
  const now = Date.now();
  const db = ledgerDb;
  db.transaction(() => {
    insertEvent(db, id, "permission.resolved", by, { behavior }, now);
    db.run(
      "UPDATE permissions SET status=?, behavior=?, resolved_at_ms=?, resolved_by=? WHERE id=?",
      [targetStatus, behavior, now, by, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotPermission(id)! };
}

type ListPermissionsFilter = {
  status?: PermissionStatus | "all";
  for?: string;
  limit?: number;
};

function listPermissions(filter: ListPermissionsFilter = {}): PermissionSnapshot[] {
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
    clauses.push("agent = ?");
    params.push(filter.for);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  const rows = ledgerDb
    .query<PermissionRow, typeof params>(
      `SELECT * FROM permissions ${where} ORDER BY created_at_ms DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map((row) => {
    const ver = ledgerDb!
      .query<{ max_seq: number | null }, [string]>(
        "SELECT MAX(seq) AS max_seq FROM events WHERE handoff_id = ?",
      )
      .get(row.id);
    return permissionRowToSnapshot(row, ver?.max_seq ?? 0);
  });
}

function pendingPermissionsFor(agent: string): PermissionSnapshot[] {
  return listPermissions({ status: "pending", for: agent, limit: 1000 });
}

function dismissPermission(id: string, by: string): PermissionOutcome {
  if (!ledgerDb) throw new Error("ledger disabled");
  const loaded = loadPermission(id);
  if (!loaded) return { kind: "not_found" };
  if (loaded.row.status === "dismissed") {
    return { kind: "idempotent", snapshot: permissionRowToSnapshot(loaded.row, loaded.version) };
  }
  if (loaded.row.status !== "pending") {
    return {
      kind: "conflict",
      current_status: loaded.row.status,
      snapshot: permissionRowToSnapshot(loaded.row, loaded.version),
    };
  }
  const now = Date.now();
  const db = ledgerDb;
  db.transaction(() => {
    insertEvent(db, id, "permission.dismissed", by, {}, now);
    db.run(
      "UPDATE permissions SET status='dismissed', resolved_at_ms=?, resolved_by=? WHERE id=?",
      [now, by, id],
    );
  })();
  return { kind: "transition", snapshot: snapshotPermission(id)! };
}

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

// Constant-time string comparison (length oracle is not a secret leak).
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
  // Re-brief connected agents so early-joiners learn about later-joining peers.
  broadcastBriefingsToConnectedAgents();
}

// Peer list excludes self. Tool list must stay in sync with channel.ts.
function buildBriefing(agent: string): Entry & {
  type: string;
  tools: string[];
  peers: Array<{ name: string; online: boolean }>;
  attachments_dir: string;
  human_name: string;
  nutshell: string | null;
} {
  const peers: Array<{ name: string; online: boolean }> = [];
  for (const name of knownAgents.keys()) {
    if (name === agent) continue;
    peers.push({
      name,
      online: permanentAgents.has(name)
        ? true
        : (agentConnections.get(name) ?? 0) > 0,
    });
  }
  const nutshell = ledgerEnabled ? readNutshell().text : "";
  return {
    type: "briefing",
    tools: [
      "post",
      "post_file",
      "send_handoff",
      "accept_handoff",
      "decline_handoff",
      "cancel_handoff",
      "send_interrupt",
      "ack_interrupt",
      "ack_permission",
    ],
    peers,
    attachments_dir: ATTACHMENTS_DIR,
    human_name: HUMAN_NAME,
    nutshell: nutshell || null,
    ts: ts(),
  };
}

function broadcastBriefingsToConnectedAgents(): void {
  for (const name of knownAgents.keys()) {
    if (permanentAgents.has(name)) continue;
    if ((agentConnections.get(name) ?? 0) <= 0) continue;
    const q = agentQueues.get(name);
    if (!q) continue;
    q.push(buildBriefing(name));
  }
}

function presenceSnapshot(): Entry {
  const agents: Record<string, boolean> = {};
  for (const name of knownAgents.keys()) {
    // Permanent members (e.g. human) have no channel-bin → force them online whenever the hub is up.
    agents[name] = permanentAgents.has(name)
      ? true
      : (agentConnections.get(name) ?? 0) > 0;
  }
  return { type: "presence", agents };
}

function broadcastPresence(): void {
  const snap = presenceSnapshot();
  for (const q of uiSubscribers) q.push(snap);
  // Do NOT re-brief here — presence flips are too frequent; briefings fan out on roster changes.
}

// Agents get disk paths (so they can Read the file directly); UI still gets URL form via /stream.
function imageUrlToPath(url: string): string {
  const segment = url.slice("/image/".length);
  return join(ATTACHMENTS_DIR, segment);
}

function agentEntry(entry: Entry): Entry {
  if (!entry.image) return entry;
  const absPath = ATTACHMENTS_DIR ? imageUrlToPath(entry.image) : entry.image;
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

// CORS for mutating routes. No-Origin requests (curl, sidecars) pass; cross-origin browsers are rejected.
const ALLOWED_ORIGINS = new Set<string>([
  "tauri://localhost",
  "http://tauri.localhost",
]);

// Bearer-token gate for mutating routes. Returns null on success or a 401/403 Response on failure.
function requireAuth(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: "forbidden origin" }, { status: 403 });
  }
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

// Read-route auth: Authorization header OR ?token=<token> for EventSource / <img>. Query-param
// tokens land in hub.log, which is 0600-locked to compensate.
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

// Call before req.json()/req.text(). Returns null on success or a 411/413 Response on failure.
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
    image?: string | null;
  };
  const frm = body.from;
  const rawTo = body.to ?? "you";
  const reserved = rawTo.toLowerCase();
  const text = (body.text ?? "").trim();
  const image = body.image || null;
  if (!frm || (!text && !image)) {
    return json({ error: "bad request" }, { status: 400 });
  }
  if (image && !IMAGE_URL_RE.test(image)) {
    return json({ error: "invalid image url" }, { status: 400 });
  }
  if (!ensureAgent(frm)) {
    return json({ error: `invalid from: ${frm}` }, { status: 400 });
  }

  let targets: string[];
  if (reserved === "you") {
    targets = [];
  } else if (reserved === "all") {
    targets = [...knownAgents.keys()].filter((a) => a !== frm);
  } else if (knownAgents.has(rawTo)) {
    targets = [rawTo];
  } else {
    return json({ error: `unknown to: ${rawTo}` }, { status: 400 });
  }

  const entry: Entry = { from: frm, to: rawTo, text, image, ts: ts() };
  broadcastUI(entry);
  // Peers get absolute paths (via agentEntry); UI already got URL form via broadcastUI above.
  const view = agentEntry(entry);
  for (const t of targets) enqueueTo(t, view);
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
  // Trust the filename extension, not browser-supplied MIME. Serve route has strict CSP + nosniff.
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
    // Tighten perms before publish — hub is the only legitimate disk reader.
    chmodSync(tmp, 0o600);
    await rename(tmp, target);
  } catch (e) {
    try { await unlink(tmp); } catch {}
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

    // Briefing lands before replay so it arrives first in the agent's context.
    if (!permanentAgents.has(agent)) {
      try {
        send(buildBriefing(agent));
      } catch (e) {
        console.error("[briefing]", e);
      }
    }

    // Replay pending handoffs + interrupts (as recipient OR originator). Chat is NOT replayed.
    if (ledgerEnabled) {
      try {
        for (const snapshot of pendingFor(agent)) {
          send(handoffEntry(snapshot, "handoff.new", /* replay */ true));
        }
        for (const snapshot of pendingInterruptsFor(agent)) {
          send(interruptEntry(snapshot, "interrupt.new", /* replay */ true));
        }
        // Permissions fan out to all peers (not recipient-scoped like handoffs),
        // so replay every currently-pending permission to the reconnecting agent.
        for (const snapshot of listPermissions({ status: "pending", limit: 1000 })) {
          send(permissionEntry(snapshot, "permission.new", /* replay */ true));
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
  broadcastUI(entry);
  const recipients: string[] =
    eventKind === "handoff.new"
      ? [snapshot.to_agent]
      : [snapshot.from_agent, snapshot.to_agent];
  for (const name of new Set(recipients)) {
    // Permanent members (human) already saw this via broadcastUI.
    if (permanentAgents.has(name)) continue;
    const q = agentQueues.get(name);
    if (!q) continue;
    // Agents don't need `snapshot` — `text` already carries the JSON; channel.ts forwards meta.
    const queueEntry = handoffEntry(snapshot, eventKind);
    q.push(queueEntry);
  }
}

function interruptEntry(
  snapshot: InterruptSnapshot,
  eventKind: "interrupt.new" | "interrupt.ack",
  replay = false,
): Entry & {
  kind: string;
  interrupt_id: string;
  version: number;
  replay: boolean;
  snapshot: InterruptSnapshot;
} {
  return {
    from: snapshot.from_agent,
    to: snapshot.to_agent,
    text: JSON.stringify(snapshot),
    ts: ts(),
    image: null,
    kind: eventKind,
    interrupt_id: snapshot.id,
    version: snapshot.version,
    replay,
    snapshot,
  };
}

function broadcastInterrupt(
  snapshot: InterruptSnapshot,
  eventKind: "interrupt.new" | "interrupt.ack",
): void {
  const entry = interruptEntry(snapshot, eventKind);
  broadcastUI(entry);
  const recipients: string[] =
    eventKind === "interrupt.new"
      ? [snapshot.to_agent]
      : [snapshot.from_agent, snapshot.to_agent];
  for (const name of new Set(recipients)) {
    if (permanentAgents.has(name)) continue;
    const q = agentQueues.get(name);
    if (!q) continue;
    q.push(interruptEntry(snapshot, eventKind));
  }
}

function permissionEntry(
  snapshot: PermissionSnapshot,
  eventKind: "permission.new" | "permission.resolved" | "permission.dismissed",
  replay = false,
): Entry & {
  kind: string;
  permission_id: string;
  version: number;
  replay: boolean;
  snapshot: PermissionSnapshot;
} {
  return {
    from: snapshot.agent,
    to: "all",
    text: JSON.stringify(snapshot),
    ts: ts(),
    image: null,
    kind: eventKind,
    permission_id: snapshot.id,
    version: snapshot.version,
    replay,
    snapshot,
  };
}

function broadcastPermission(
  snapshot: PermissionSnapshot,
  eventKind: "permission.new" | "permission.resolved" | "permission.dismissed",
): void {
  const entry = permissionEntry(snapshot, eventKind);
  broadcastUI(entry);
  // Fan out to every non-permanent agent queue so peers can autonomously ack
  // via `ack_permission`. The requesting agent's own chatbridge uses
  // `permission.resolved` to relay the verdict upstream back to claude, which
  // de-dupes by request_id, so re-echoing to the requester is harmless.
  for (const name of agentQueues.keys()) {
    if (permanentAgents.has(name)) continue;
    const q = agentQueues.get(name);
    if (!q) continue;
    q.push(permissionEntry(snapshot, eventKind));
  }
}

function nutshellEntry(snapshot: NutshellSnapshot): Entry & {
  type: string;
  snapshot: NutshellSnapshot;
} {
  return {
    type: "nutshell.updated",
    text: snapshot.text,
    ts: ts(),
    snapshot,
  } as Entry & { type: string; snapshot: NutshellSnapshot };
}

function broadcastNutshell(snapshot: NutshellSnapshot): void {
  // Nutshell is ambient context — UI-only; agents receive it via briefing on reconnect.
  const entry = nutshellEntry(snapshot);
  for (const q of uiSubscribers) q.push(entry);
}

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

  // Sender auto-registers; recipient must already be in the roster so typos 400 immediately.
  ensureAgent(from);
  if (!knownAgents.has(to)) {
    return json(
      { error: `unknown recipient: ${to} (must be a currently-registered agent or "${HUMAN_NAME}")` },
      { status: 400 },
    );
  }

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

const INTERRUPT_TEXT_MAX_CHARS = 500;

function interruptOutcomeResponse(outcome: InterruptOutcome): Response {
  switch (outcome.kind) {
    case "not_found":
      return json({ error: "not found" }, { status: 404 });
    case "forbidden":
      return json({ error: outcome.reason }, { status: 403 });
    case "conflict":
      return json(
        { error: `interrupt already ${outcome.current_status}`, snapshot: outcome.snapshot },
        { status: 409 },
      );
    case "idempotent":
      return json({ snapshot: outcome.snapshot, idempotent: true }, { status: 200 });
    case "transition":
      broadcastInterrupt(outcome.snapshot, "interrupt.ack");
      return json({ snapshot: outcome.snapshot }, { status: 200 });
  }
}

async function handleCreateInterrupt(req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as {
    from?: string;
    to?: string;
    text?: string;
  };
  const from = (body.from ?? "").trim();
  const to = (body.to ?? "").trim();
  const text = (body.text ?? "").trim();
  if (!validName(from)) return json({ error: "invalid from" }, { status: 400 });
  if (!validName(to)) return json({ error: "invalid to" }, { status: 400 });
  if (!text) return json({ error: "text required" }, { status: 400 });
  if (text.length > INTERRUPT_TEXT_MAX_CHARS) {
    return json({ error: `text too long (max ${INTERRUPT_TEXT_MAX_CHARS})` }, { status: 400 });
  }
  // Same phantom-prevention rule as handoffs.
  ensureAgent(from);
  if (!knownAgents.has(to)) {
    return json(
      { error: `unknown recipient: ${to} (must be a currently-registered agent or "${HUMAN_NAME}")` },
      { status: 400 },
    );
  }
  const snapshot = createInterrupt({ from, to, text });
  broadcastInterrupt(snapshot, "interrupt.new");
  return json({ id: snapshot.id }, { status: 201 });
}

async function handleAckInterrupt(id: string, req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  if (!INTERRUPT_ID_RE.test(id)) {
    return json({ error: "invalid interrupt id" }, { status: 400 });
  }
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as { by?: string };
  const by = (body.by ?? "").trim();
  if (!validName(by)) return json({ error: "invalid by" }, { status: 400 });
  return interruptOutcomeResponse(ackInterrupt(id, by));
}

function handleListInterrupts(req: Request): Response {
  const guard = ledgerGuard();
  if (guard) return guard;
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "pending";
  const forParam = url.searchParams.get("for") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 100;

  const validStatus = new Set(["pending", "acknowledged", "all"]);
  if (!validStatus.has(statusParam)) {
    return json({ error: `invalid status: ${statusParam}` }, { status: 400 });
  }
  if (forParam !== undefined && !validName(forParam)) {
    return json({ error: `invalid for: ${forParam}` }, { status: 400 });
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
    return json({ error: "invalid limit" }, { status: 400 });
  }
  return json(
    listInterrupts({ status: statusParam as InterruptStatus | "all", for: forParam, limit }),
  );
}

function handleGetNutshell(): Response {
  return json(readNutshell());
}

// -------- Permission routes --------

function permissionOutcomeResponse(outcome: PermissionOutcome): Response {
  switch (outcome.kind) {
    case "not_found":
      return json({ error: "not found" }, { status: 404 });
    case "conflict":
      return json(
        { error: `permission already ${outcome.current_status}`, snapshot: outcome.snapshot },
        { status: 409 },
      );
    case "idempotent":
      return json({ snapshot: outcome.snapshot, idempotent: true }, { status: 200 });
    case "transition":
      broadcastPermission(outcome.snapshot, "permission.resolved");
      return json({ snapshot: outcome.snapshot }, { status: 200 });
  }
}

async function handleCreatePermission(req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  const sizeCheck = requireJsonBody(req, PERMISSION_BODY_MAX);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as {
    agent?: string;
    request_id?: string;
    tool_name?: string;
    description?: string;
    input_preview?: string;
  };
  const agent = (body.agent ?? "").trim();
  const request_id = (body.request_id ?? "").trim();
  const tool_name = (body.tool_name ?? "").trim();
  const description = body.description ?? "";
  const input_preview = body.input_preview ?? "";

  if (!validName(agent)) return json({ error: "invalid agent" }, { status: 400 });
  if (!PERMISSION_ID_RE.test(request_id)) {
    return json({ error: "invalid request_id" }, { status: 400 });
  }
  if (!tool_name || tool_name.length > PERMISSION_TOOL_NAME_MAX_CHARS) {
    return json({ error: "invalid tool_name" }, { status: 400 });
  }
  if (typeof description !== "string" || description.length > PERMISSION_DESCRIPTION_MAX_CHARS) {
    return json({ error: "invalid description" }, { status: 400 });
  }
  if (typeof input_preview !== "string" || input_preview.length > PERMISSION_INPUT_PREVIEW_MAX_CHARS) {
    return json({ error: "invalid input_preview" }, { status: 400 });
  }
  // Requesting agent must be in the roster so orphan records can't accumulate.
  ensureAgent(agent);

  const outcome = createPermission({ agent, request_id, tool_name, description, input_preview });
  switch (outcome.kind) {
    case "created":
      broadcastPermission(outcome.snapshot, "permission.new");
      return json({ id: outcome.snapshot.id, snapshot: outcome.snapshot }, { status: 201 });
    case "idempotent":
      return json({ id: outcome.snapshot.id, snapshot: outcome.snapshot, idempotent: true }, { status: 200 });
    case "conflict":
      return json(
        { error: `permission already ${outcome.snapshot.status}`, snapshot: outcome.snapshot },
        { status: 409 },
      );
  }
}

async function handleResolvePermission(id: string, req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  if (!PERMISSION_ID_RE.test(id)) {
    return json({ error: "invalid request_id" }, { status: 400 });
  }
  const sizeCheck = requireJsonBody(req, PERMISSION_BODY_MAX);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as { by?: string; behavior?: string };
  const by = (body.by ?? "").trim();
  const behavior = (body.behavior ?? "").trim();
  if (!validName(by)) return json({ error: "invalid by" }, { status: 400 });
  if (behavior !== "allow" && behavior !== "deny") {
    return json({ error: "invalid behavior" }, { status: 400 });
  }
  return permissionOutcomeResponse(resolvePermission(id, by, behavior as PermissionBehavior));
}

async function handleDismissPermission(id: string, req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  if (!PERMISSION_ID_RE.test(id)) {
    return json({ error: "invalid request_id" }, { status: 400 });
  }
  const sizeCheck = requireJsonBody(req, PERMISSION_BODY_MAX);
  if (sizeCheck) return sizeCheck;

  const body = (await req.json().catch(() => ({}))) as { by?: string };
  const by = (body.by ?? "").trim();
  if (!validName(by)) return json({ error: "invalid by" }, { status: 400 });

  const outcome = dismissPermission(id, by);
  switch (outcome.kind) {
    case "not_found":
      return json({ error: "not found" }, { status: 404 });
    case "conflict":
      return json(
        { error: `permission already ${outcome.current_status}`, snapshot: outcome.snapshot },
        { status: 409 },
      );
    case "idempotent":
      return json({ snapshot: outcome.snapshot, idempotent: true }, { status: 200 });
    case "transition":
      broadcastPermission(outcome.snapshot, "permission.dismissed");
      return json({ snapshot: outcome.snapshot }, { status: 200 });
  }
}

function handleListPermissions(req: Request): Response {
  const guard = ledgerGuard();
  if (guard) return guard;
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "pending";
  const forParam = url.searchParams.get("for") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 100;

  const validStatus = new Set(["pending", "allowed", "denied", "dismissed", "all"]);
  if (!validStatus.has(statusParam)) {
    return json({ error: `invalid status: ${statusParam}` }, { status: 400 });
  }
  if (forParam !== undefined && !validName(forParam)) {
    return json({ error: `invalid for: ${forParam}` }, { status: 400 });
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
    return json({ error: "invalid limit" }, { status: 400 });
  }
  return json(
    listPermissions({ status: statusParam as PermissionStatus | "all", for: forParam, limit }),
  );
}

// PTY-side: UI POSTs { agent, cwd, resume_flag }; spawn modal GETs for restore prefill.
const RESUME_FLAG_RE = /^[A-Za-z0-9_.:/\-]{1,256}$/;

async function handleSaveSession(req: Request): Promise<Response> {
  const guard = ledgerGuard();
  if (guard) return guard;
  const sizeCheck = requireJsonBody(req);
  if (sizeCheck) return sizeCheck;
  const body = (await req.json().catch(() => ({}))) as {
    agent?: string; cwd?: string; resume_flag?: string;
  };
  const agent = (body.agent ?? "").trim();
  const cwd = (body.cwd ?? "").trim();
  const resume_flag = (body.resume_flag ?? "").trim();
  if (!validName(agent)) return json({ error: "invalid agent" }, { status: 400 });
  if (!cwd || cwd.length > 1024) return json({ error: "invalid cwd" }, { status: 400 });
  if (!RESUME_FLAG_RE.test(resume_flag)) {
    return json({ error: "invalid resume_flag" }, { status: 400 });
  }
  ledgerDb!
    .query(`
      INSERT INTO claude_sessions (agent, cwd, resume_flag, captured_at_ms)
        VALUES (?, ?, ?, ?)
      ON CONFLICT(agent, cwd) DO UPDATE SET
        resume_flag    = excluded.resume_flag,
        captured_at_ms = excluded.captured_at_ms
    `)
    .run(agent, cwd, resume_flag, Date.now());
  return json({ ok: true });
}

function handleGetSession(url: URL): Response {
  const guard = ledgerGuard();
  if (guard) return guard;
  const agent = (url.searchParams.get("agent") ?? "").trim();
  const cwd = (url.searchParams.get("cwd") ?? "").trim();
  if (!validName(agent)) return json({ error: "invalid agent" }, { status: 400 });
  if (!cwd) return json({ error: "cwd required" }, { status: 400 });
  const row = ledgerDb!
    .query<{ resume_flag: string; captured_at_ms: number }, [string, string]>(
      "SELECT resume_flag, captured_at_ms FROM claude_sessions WHERE agent = ? AND cwd = ?",
    )
    .get(agent, cwd);
  if (!row) return json(null);
  return json({ resume_flag: row.resume_flag, captured_at_ms: row.captured_at_ms });
}

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
      // Read endpoints: header OR ?token= for EventSource / <img>.
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
        const authFail = requireReadAuth(req, url);
        return authFail ?? handleListHandoffs(req);
      }
      if (req.method === "POST" && pathname === "/interrupts") {
        const authFail = requireAuth(req);
        return authFail ?? (await handleCreateInterrupt(req));
      }
      if (req.method === "POST" && pathname.startsWith("/interrupts/")) {
        const match = pathname.match(/^\/interrupts\/([^/]+)\/ack$/);
        if (match) {
          const authFail = requireAuth(req);
          if (authFail) return authFail;
          return await handleAckInterrupt(match[1], req);
        }
      }
      if (req.method === "GET" && pathname === "/interrupts") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? handleListInterrupts(req);
      }
      if (req.method === "POST" && pathname === "/permissions") {
        const authFail = requireAuth(req);
        return authFail ?? (await handleCreatePermission(req));
      }
      if (req.method === "POST" && pathname.startsWith("/permissions/")) {
        const verdictMatch = pathname.match(/^\/permissions\/([^/]+)\/verdict$/);
        if (verdictMatch) {
          const authFail = requireAuth(req);
          if (authFail) return authFail;
          return await handleResolvePermission(verdictMatch[1], req);
        }
        const dismissMatch = pathname.match(/^\/permissions\/([^/]+)\/dismiss$/);
        if (dismissMatch) {
          const authFail = requireAuth(req);
          if (authFail) return authFail;
          return await handleDismissPermission(dismissMatch[1], req);
        }
      }
      if (req.method === "GET" && pathname === "/permissions") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? handleListPermissions(req);
      }
      // Nutshell read; write path is /handoffs with task prefix "[nutshell]".
      if (req.method === "GET" && pathname === "/nutshell") {
        const authFail = requireReadAuth(req, url);
        return authFail ?? handleGetNutshell();
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
  permanentAgents.add(HUMAN_NAME);
  ensureAgent(HUMAN_NAME);
  console.log(`[hub] human registered as "${HUMAN_NAME}" (permanent)`);
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
