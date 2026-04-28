// Integration tests for room transcript persistence: opt-in toggle, write-through,
// hub restart hydration, and clear-transcript semantics.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { postJson, registerAgent, authedFetch } from "../helpers/fetch";

async function putJson(
  hub: HubHandle,
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const r = await authedFetch(hub, path, { method: "PUT", body: JSON.stringify(body) });
  let j: unknown = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

async function spawnWithTranscripts(transcriptsDir: string): Promise<HubHandle> {
  const orig = process.env.A2A_TRANSCRIPTS_DIR;
  process.env.A2A_TRANSCRIPTS_DIR = transcriptsDir;
  try {
    return await spawnHub();
  } finally {
    if (orig === undefined) delete process.env.A2A_TRANSCRIPTS_DIR;
    else process.env.A2A_TRANSCRIPTS_DIR = orig;
  }
}

describe("room transcript persistence", () => {
  let transcriptsDir: string;
  let hub: HubHandle;

  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), "a2a-transcript-test-"));
    transcriptsDir = join(base, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    hub = await spawnWithTranscripts(transcriptsDir);
  });

  afterAll(async () => {
    await hub.kill();
  });

  test("room without settings row leaves transcripts dir empty after a post", async () => {
    const sender = await registerAgent(hub, "noptin1");
    await postJson(hub, "/post", {
      from: "noptin1", to: "human", text: "no opt-in", room: "noptin-room",
    });
    await new Promise((r) => setTimeout(r, 100));
    const files = readdirSync(transcriptsDir).filter((n) => n.endsWith(".jsonl"));
    expect(files.length).toBe(0);
    sender.close();
  });

  test("PUT /rooms/:room/settings flips persistence; subsequent posts create file", async () => {
    const room = "optin-room";
    const put = await putJson(hub, `/rooms/${room}/settings`, { persist_transcript: true });
    expect(put.status).toBe(200);
    const sender = await registerAgent(hub, "optin1", { room });
    await postJson(hub, "/post", {
      from: "optin1", to: "human", text: "first message", room,
    });
    await new Promise((r) => setTimeout(r, 100));
    const files = readdirSync(transcriptsDir).filter((n) => n.endsWith(".jsonl"));
    expect(files.some((n) => n.endsWith(`-${room.replace(/-/g, "-")}.jsonl`))).toBe(true);
    sender.close();
  });

  test("GET /rooms/:room/transcripts reports active stats", async () => {
    const room = "stats-room";
    await putJson(hub, `/rooms/${room}/settings`, { persist_transcript: true });
    const sender = await registerAgent(hub, "stats1", { room });
    for (let i = 0; i < 3; i++) {
      await postJson(hub, "/post", {
        from: "stats1", to: "human", text: `msg ${i}`, room,
      });
    }
    await new Promise((r) => setTimeout(r, 100));
    const r = await fetch(`${hub.url}/rooms/${room}/transcripts?token=${hub.token}`);
    expect(r.status).toBe(200);
    const data = await r.json() as { active: { lines: number }; chunks: unknown[]; totalBytes: number };
    expect(data.active.lines).toBeGreaterThanOrEqual(3);
    expect(data.chunks.length).toBe(0);
    expect(data.totalBytes).toBeGreaterThan(0);
    sender.close();
  });

  test("POST /rooms/:room/clear-transcript archives active to a chunk (non-destructive)", async () => {
    const room = "clear-room";
    await putJson(hub, `/rooms/${room}/settings`, { persist_transcript: true });
    const sender = await registerAgent(hub, "clear1", { room });
    await postJson(hub, "/post", { from: "clear1", to: "human", text: "to be archived", room });
    await new Promise((r) => setTimeout(r, 100));
    const before = readdirSync(transcriptsDir).filter((n) => n.includes(room.replace(/-/g, "-")));
    expect(before.length).toBe(1);
    expect(before.some((n) => /^[0-9a-f]{8}-clear-room\.jsonl$/.test(n))).toBe(true);
    const clear = await postJson(hub, `/rooms/${room}/clear-transcript`, {});
    expect(clear.status).toBe(200);
    const after = readdirSync(transcriptsDir).filter((n) => n.includes(room.replace(/-/g, "-")));
    // Active is gone (renamed); the rotated chunk now holds the archived data.
    expect(after.some((n) => /^[0-9a-f]{8}-clear-room\.jsonl$/.test(n))).toBe(false);
    expect(after.some((n) => /^[0-9a-f]{8}-clear-room\.\d{6}\.jsonl$/.test(n))).toBe(true);
    sender.close();
  });
});

describe("room transcript persistence: hub restart hydration", () => {
  test("entries replay through /stream after hub restart", async () => {
    const base = mkdtempSync(join(tmpdir(), "a2a-hydrate-test-"));
    const transcriptsDir = join(base, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });

    // Phase 1: opt in, post entries, kill hub.
    const ledgerPath = join(base, "ledger.db");
    const attachmentsDir = join(base, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    const token = `hyd-${Math.random().toString(36).slice(2, 10)}`;

    async function spawn(): Promise<HubHandle> {
      const proc = Bun.spawn(["bun", "run", "hub/hub.ts"], {
        env: {
          ...process.env,
          PORT: "0",
          A2A_TOKEN: token,
          A2A_LEDGER_DB: ledgerPath,
          A2A_ATTACHMENTS_DIR: attachmentsDir,
          A2A_HUMAN_NAME: "human",
          A2A_DEFAULT_ROOM: "default",
          A2A_TRANSCRIPTS_DIR: transcriptsDir,
          A2A_ALLOWED_EXTENSIONS: "jpg,jpeg,png,pdf,md,txt,json",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Wait for "listening on http://127.0.0.1:<port>"
      const decoder = new TextDecoder();
      const reader = proc.stdout.getReader();
      let buf = "";
      let url = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
        if (m) { url = m[1]; break; }
      }
      reader.releaseLock();
      if (!url) {
        proc.kill();
        throw new Error("hub didn't announce port");
      }
      return {
        url, token, ledgerPath, attachmentsDir, humanName: "human",
        kill: async () => { proc.kill(); await proc.exited; },
      };
    }

    let hub = await spawn();
    const room = "hydrate-room";
    await putJson(hub, `/rooms/${room}/settings`, { persist_transcript: true });
    const sender = await registerAgent(hub, "hyd1", { room });
    for (let i = 0; i < 5; i++) {
      await postJson(hub, "/post", { from: "hyd1", to: "human", text: `msg ${i}`, room });
    }
    await new Promise((r) => setTimeout(r, 200));
    sender.close();
    await hub.kill();

    // Phase 2: respawn hub, connect to /stream, expect replay.
    hub = await spawn();
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetch(`${hub.url}/stream?token=${token}&lastSeenId=0`, {
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.timeout(2000),
    });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let chunk = "";
    const deadline = Date.now() + 1500;
    const seen: string[] = [];
    while (Date.now() < deadline && seen.length < 5) {
      try {
        const { value, done } = await reader.read();
        if (done) break;
        chunk += decoder.decode(value);
        for (const line of chunk.split("\n\n")) {
          const m = /^data: (.+)$/m.exec(line);
          if (!m) continue;
          try {
            const evt = JSON.parse(m[1]) as { text?: string; from?: string };
            if (evt.from === "hyd1" && evt.text?.startsWith("msg ")) seen.push(evt.text);
          } catch { /* ignore non-JSON lines */ }
        }
        chunk = chunk.split("\n\n").pop() ?? "";
      } catch {
        break;
      }
    }
    reader.cancel().catch(() => {});
    expect(seen.length).toBe(5);
    expect(seen).toEqual(["msg 0", "msg 1", "msg 2", "msg 3", "msg 4"]);

    await hub.kill();
  });
});
