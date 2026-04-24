import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function bootHubAgainstLedger(ledgerPath: string, baseDir: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "hub/hub.ts"], {
    env: {
      ...process.env,
      PORT: "0",
      A2A_TOKEN: "testmig",
      A2A_LEDGER_DB: ledgerPath,
      A2A_ATTACHMENTS_DIR: baseDir,
      A2A_HUMAN_NAME: "human",
      A2A_DEFAULT_ROOM: "default",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for "listening on" log line confirming boot + migrations complete.
  const reader = proc.stdout!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (/listening on /.test(buf)) break;
  }
  if (!/listening on /.test(buf)) {
    try { proc.kill(); } catch {}
    const errReader = proc.stderr?.getReader();
    let errBuf = "";
    if (errReader) {
      try {
        const { value } = await errReader.read();
        if (value) errBuf = dec.decode(value);
      } catch {}
    }
    throw new Error(`hub failed to boot. stdout:\n${buf}\nstderr:\n${errBuf}`);
  }
  // Let migrations settle fully before tearing down.
  await new Promise((r) => setTimeout(r, 150));
  proc.kill();
  await proc.exited;
}

describe("ledger migration forward-compat", () => {
  test("fresh ledger migrates from scratch to current version", async () => {
    const base = mkdtempSync(join(tmpdir(), "a2a-mig-fresh-"));
    const path = join(base, "ledger.db");

    await bootHubAgainstLedger(path, base);

    const db = new Database(path, { readonly: true });
    const ver = (db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value;
    // v0.9.5 §2 bumps schema to v7 (renames events.handoff_id → events.entity_id).
    expect(Number(ver)).toBeGreaterThanOrEqual(7);

    // v7 rename: events table has `entity_id`, not `handoff_id`.
    const eventsCols = (db.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(eventsCols).toContain("entity_id");
    expect(eventsCols).not.toContain("handoff_id");

    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain("events");
    expect(tables).toContain("handoffs");
    expect(tables).toContain("interrupts");
    expect(tables).toContain("permissions");
    expect(tables).toContain("nutshell");
    expect(tables).toContain("meta");

    // v6 added room columns and restructured nutshell.
    expect((db.query("PRAGMA table_info(handoffs)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("room");
    expect((db.query("PRAGMA table_info(nutshell)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("room");

    db.close();
  });

  test("v5 ledger (pre-rooms) migrates to v6 preserving rows", async () => {
    // Seed by letting the hub build a full v5 ledger. Easiest way: boot a
    // current hub once to get v6, then manually rewind schema_version to 5
    // and re-drop the room columns + nutshell key. That's fragile; cleaner
    // to directly seed v5 schema by hand.
    const base = mkdtempSync(join(tmpdir(), "a2a-mig-v5-"));
    const path = join(base, "ledger.db");

    // Construct a v5 ledger: full tables from v1–v5, no room columns, nutshell with id=0.
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        handoff_id TEXT NOT NULL,
        kind TEXT NOT NULL, actor TEXT NOT NULL,
        payload_json TEXT NOT NULL, at_ms INTEGER NOT NULL
      );
      CREATE INDEX idx_events_handoff ON events(handoff_id, seq);

      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        task TEXT NOT NULL, context_json TEXT,
        status TEXT NOT NULL, decline_reason TEXT, comment TEXT,
        cancel_reason TEXT, cancelled_by TEXT,
        created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER
      );

      CREATE TABLE interrupts (
        id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        acknowledged_at_ms INTEGER, acknowledged_by TEXT
      );

      CREATE TABLE nutshell (
        id INTEGER PRIMARY KEY CHECK(id = 0),
        text TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL, updated_by TEXT
      );
      INSERT INTO nutshell VALUES (0, 'legacy summary', 3, 1000, 'alice');

      CREATE TABLE claude_sessions (
        agent TEXT NOT NULL, cwd TEXT NOT NULL,
        resume_flag TEXT NOT NULL, captured_at_ms INTEGER NOT NULL,
        PRIMARY KEY (agent, cwd)
      );

      CREATE TABLE permissions (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, tool_name TEXT NOT NULL,
        description TEXT NOT NULL, input_preview TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('pending','allowed','denied','dismissed')),
        created_at_ms INTEGER NOT NULL, resolved_at_ms INTEGER,
        resolved_by TEXT,
        behavior TEXT CHECK(behavior IS NULL OR behavior IN ('allow','deny'))
      );

      -- Seed a legacy handoff row to verify preservation.
      INSERT INTO handoffs (id, from_agent, to_agent, task, status, created_at_ms, expires_at_ms)
        VALUES ('h_legacy000000001', 'alice', 'bob', 'legacy task', 'pending', 1000, 99999999999);
    `);
    db.run("INSERT INTO meta VALUES ('schema_version', '5')");
    db.run("INSERT INTO meta VALUES ('ledger_id', 'deadbeef')");
    db.close();

    await bootHubAgainstLedger(path, base);

    const check = new Database(path, { readonly: true });
    const ver = Number((check.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value);
    expect(ver).toBeGreaterThanOrEqual(7);

    // v7 rename: events.handoff_id → events.entity_id.
    const eventsCols = (check.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(eventsCols).toContain("entity_id");
    expect(eventsCols).not.toContain("handoff_id");

    // Legacy handoff still there.
    const h = check.query("SELECT id, status, room FROM handoffs WHERE id=?").get("h_legacy000000001") as { id: string; status: string; room: string } | undefined;
    expect(h?.status).toBe("pending");
    expect(h?.room).toBe("default");

    // Nutshell migrated to per-room.
    const nut = check.query("SELECT room, text FROM nutshell WHERE room=?").get("default") as { room: string; text: string } | undefined;
    expect(nut?.text).toBe("legacy summary");

    // Ledger_id preserved.
    const lid = (check.query("SELECT value FROM meta WHERE key='ledger_id'").get() as { value: string }).value;
    expect(lid).toBe("deadbeef");

    check.close();
  });
});
