// Claude Code usage snapshot, derived from the JSONL transcripts the CLI
// writes at ~/.claude/projects/<slug>/<session>.jsonl.
//
// Why this module exists: Claude Code exposes no programmatic usage API.
// The /cost banner scrape in ui/terminal.js only sees claudes running in
// A2AChannel's embedded panes — warnings in the user's own terminal never
// reach the hub. Parsing the transcripts covers every claude on the machine.
//
// What the transcripts give us: per-assistant-message `usage` blocks with
// input/output/cache token counts and an ISO timestamp. That's enough to
// compute rolling 5-hour blocks (matches claude's session-limit window) and
// a rolling 7-day window. It is NOT enough to compute % of plan (the plan
// tier is not in the transcripts, and the per-tier token caps aren't public).
// The pill shows absolute tokens + reset deltas instead.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const BLOCK_MS = 5 * 60 * 60 * 1000;   // session-limit window
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type UsageEntry = {
  tsMs: number;
  tokens: number;
};

export type UsageSnapshot = {
  capturedAtMs: number;
  session: {
    blockStartMs: number | null;
    blockEndMs: number | null;
    totalTokens: number;
    active: boolean;
  };
  weekly: {
    windowStartMs: number;
    totalTokens: number;
  };
};

const EMPTY: UsageSnapshot = {
  capturedAtMs: 0,
  session: { blockStartMs: null, blockEndMs: null, totalTokens: 0, active: false },
  weekly: { windowStartMs: 0, totalTokens: 0 },
};

async function listRecentTranscripts(sinceMs: number): Promise<string[]> {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const p of projects) {
    const dir = join(CLAUDE_PROJECTS_DIR, p);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      try {
        const st = await stat(path);
        if (st.mtimeMs >= sinceMs) out.push(path);
      } catch {}
    }
  }
  return out;
}

async function readEntries(path: string, sinceMs: number): Promise<UsageEntry[]> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return [];
  }
  const out: UsageEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let j: { type?: string; timestamp?: string; message?: { usage?: Record<string, unknown> } };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type !== "assistant") continue;
    const u = j.message?.usage;
    if (!u || typeof u !== "object") continue;
    const ts = Date.parse(j.timestamp ?? "");
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    // Pill counts input + output only — cache_read is rate-discounted and
    // cache_creation is a per-message overhead, neither is comparable to the
    // "% of session limit" warnings claude prints (those are input+output).
    const tokens = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
    if (tokens <= 0) continue;
    out.push({ tsMs: ts, tokens });
  }
  return out;
}

// Session blocks are fixed 5-hour windows. A new block starts whenever a
// message falls after the previous block's end (i.e. `blockStart + 5h`).
// We want the block the most recent message landed in — that's "the current
// block" whether or not activity is ongoing right this second.
function computeSession(sorted: UsageEntry[], now: number): UsageSnapshot["session"] {
  if (sorted.length === 0) {
    return { blockStartMs: null, blockEndMs: null, totalTokens: 0, active: false };
  }
  // Walk oldest-to-newest, rolling the block forward whenever a message
  // arrives past the current window's end.
  let blockStartMs = sorted[0].tsMs;
  let blockEndMs = blockStartMs + BLOCK_MS;
  let totalTokens = 0;
  for (const e of sorted) {
    if (e.tsMs >= blockEndMs) {
      blockStartMs = e.tsMs;
      blockEndMs = blockStartMs + BLOCK_MS;
      totalTokens = 0;
    }
    totalTokens += e.tokens;
  }
  // "active" = the current wall clock is still inside this block. The last
  // message might be minutes or hours inside the block; either way the block
  // is open until blockEndMs.
  return { blockStartMs, blockEndMs, totalTokens, active: now < blockEndMs };
}

export async function readUsageSnapshot(): Promise<UsageSnapshot> {
  const now = Date.now();
  const weekStart = now - WEEK_MS;
  const files = await listRecentTranscripts(weekStart);
  if (files.length === 0) return { ...EMPTY, capturedAtMs: now, weekly: { windowStartMs: weekStart, totalTokens: 0 } };

  const all: UsageEntry[] = [];
  for (const f of files) {
    const entries = await readEntries(f, weekStart);
    if (entries.length) all.push(...entries);
  }
  all.sort((a, b) => a.tsMs - b.tsMs);

  const session = computeSession(all, now);
  const weeklyTotal = all.reduce((s, e) => s + e.tokens, 0);

  return {
    capturedAtMs: now,
    session,
    weekly: { windowStartMs: weekStart, totalTokens: weeklyTotal },
  };
}
