// Claude-session capture. PTY-side: UI POSTs { agent, cwd, resume_flag } when
// a new claude process announces its session id on stdout; the spawn modal
// GETs this to prefill the resume flag on relaunch.
//
// Not a kind — no lifecycle, no broadcast. Single-row-per-(agent, cwd) document
// in the `claude_sessions` table (v3 migration).

import type { Database } from "bun:sqlite";
import { json } from "./core/auth";
import { validName } from "./core/ids";

const RESUME_FLAG_RE = /^[A-Za-z0-9_.:/\-]{1,256}$/;

export async function handleSaveSession(
  req: Request,
  db: Database,
): Promise<Response> {
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
  db
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

export function handleGetSession(url: URL, db: Database): Response {
  const agent = (url.searchParams.get("agent") ?? "").trim();
  const cwd = (url.searchParams.get("cwd") ?? "").trim();
  if (!validName(agent)) return json({ error: "invalid agent" }, { status: 400 });
  if (!cwd) return json({ error: "cwd required" }, { status: 400 });
  const row = db
    .query<{ resume_flag: string; captured_at_ms: number }, [string, string]>(
      "SELECT resume_flag, captured_at_ms FROM claude_sessions WHERE agent = ? AND cwd = ?",
    )
    .get(agent, cwd);
  if (!row) return json(null);
  return json({ resume_flag: row.resume_flag, captured_at_ms: row.captured_at_ms });
}
