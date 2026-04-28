// usage.ts — derive 5h block + 7d totals from ~/.claude/projects JSONL transcripts.
// Claude Code has no programmatic usage API; transcripts cover every claude on the machine.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const BLOCK_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// 2026-04 pricing. Cache: 5m=1.25× input, 1h=2× input, read=0.10× input. Verify on table changes.
type ModelPricing = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

const PRICING_PER_MTOK: Record<string, ModelPricing> = {
  "claude-opus-4-7":   { input: 15,    output: 75,    cacheWrite5m: 18.75,  cacheWrite1h: 30,   cacheRead: 1.50 },
  "claude-opus-4-6":   { input: 15,    output: 75,    cacheWrite5m: 18.75,  cacheWrite1h: 30,   cacheRead: 1.50 },
  "claude-opus-4-5":   { input: 15,    output: 75,    cacheWrite5m: 18.75,  cacheWrite1h: 30,   cacheRead: 1.50 },
  "claude-opus-4":     { input: 15,    output: 75,    cacheWrite5m: 18.75,  cacheWrite1h: 30,   cacheRead: 1.50 },
  "claude-sonnet-4-7": { input:  3,    output: 15,    cacheWrite5m:  3.75,  cacheWrite1h:  6,   cacheRead: 0.30 },
  "claude-sonnet-4-6": { input:  3,    output: 15,    cacheWrite5m:  3.75,  cacheWrite1h:  6,   cacheRead: 0.30 },
  "claude-sonnet-4-5": { input:  3,    output: 15,    cacheWrite5m:  3.75,  cacheWrite1h:  6,   cacheRead: 0.30 },
  "claude-sonnet-4":   { input:  3,    output: 15,    cacheWrite5m:  3.75,  cacheWrite1h:  6,   cacheRead: 0.30 },
  "claude-haiku-4-5":  { input:  1,    output:  5,    cacheWrite5m:  1.25,  cacheWrite1h:  2,   cacheRead: 0.10 },
  "claude-haiku-4":    { input:  1,    output:  5,    cacheWrite5m:  1.25,  cacheWrite1h:  2,   cacheRead: 0.10 },
};
// Sonnet-rate fallback so unknown models don't zero out cost.
const FALLBACK_PRICING: ModelPricing = { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.30 };

function pricingFor(model: string): ModelPricing {
  if (model in PRICING_PER_MTOK) return PRICING_PER_MTOK[model];
  // Variant ids like "claude-opus-4-7-20260101" → match by prefix.
  for (const k of Object.keys(PRICING_PER_MTOK)) {
    if (model.startsWith(k)) return PRICING_PER_MTOK[k];
  }
  if (model.includes("opus"))   return PRICING_PER_MTOK["claude-opus-4-7"];
  if (model.includes("haiku"))  return PRICING_PER_MTOK["claude-haiku-4-5"];
  return FALLBACK_PRICING;
}

type UsageEntry = {
  tsMs: number;
  tokens: number;     // input + output (matches session-limit warning semantics)
  costUsd: number;
  model: string;
};

export type ModelBreakdown = Record<string, { tokens: number; costUsd: number }>;

export type UsageSnapshot = {
  capturedAtMs: number;
  session: {
    blockStartMs: number | null;
    blockEndMs: number | null;
    totalTokens: number;
    totalCostUsd: number;
    active: boolean;
    byModel: ModelBreakdown;
  };
  weekly: {
    windowStartMs: number;
    totalTokens: number;
    totalCostUsd: number;
    byModel: ModelBreakdown;
  };
};

function emptySnapshot(now: number, weekStart: number): UsageSnapshot {
  return {
    capturedAtMs: now,
    session: {
      blockStartMs: null, blockEndMs: null, totalTokens: 0, totalCostUsd: 0,
      active: false, byModel: {},
    },
    weekly: {
      windowStartMs: weekStart, totalTokens: 0, totalCostUsd: 0, byModel: {},
    },
  };
}

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
    let j: { type?: string; timestamp?: string; message?: { model?: string; usage?: Record<string, unknown> } };
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
    const model = j.message?.model ?? "";
    const inputTok  = Number(u.input_tokens) || 0;
    const outputTok = Number(u.output_tokens) || 0;
    const cacheReadTok = Number(u.cache_read_input_tokens) || 0;
    // Tiered split when present; legacy aggregate otherwise.
    const cc = (u.cache_creation && typeof u.cache_creation === "object")
      ? u.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
      : null;
    const cache5mTok = Number(cc?.ephemeral_5m_input_tokens) || 0;
    const cache1hTok = Number(cc?.ephemeral_1h_input_tokens) || 0;
    const cacheCreateLegacyTok = Number(u.cache_creation_input_tokens) || 0;
    // Prefer tiered when present; legacy otherwise (avoids double-count).
    const cache5m = cc ? cache5mTok : 0;
    const cache1h = cc ? cache1hTok : 0;
    const cacheCreateOther = cc ? 0 : cacheCreateLegacyTok;

    const tokens = inputTok + outputTok;
    if (tokens <= 0 && cacheReadTok <= 0 && cache5m <= 0 && cache1h <= 0 && cacheCreateOther <= 0) continue;

    const p = pricingFor(model);
    const costUsd =
      (inputTok      * p.input        +
       outputTok     * p.output       +
       cacheReadTok  * p.cacheRead    +
       cache5m       * p.cacheWrite5m +
       cache1h       * p.cacheWrite1h +
       cacheCreateOther * p.cacheWrite5m  // legacy: assume 5m tier
      ) / 1_000_000;

    out.push({ tsMs: ts, tokens, costUsd, model });
  }
  return out;
}

function accumulate(
  entries: UsageEntry[],
): { tokens: number; costUsd: number; byModel: ModelBreakdown } {
  let tokens = 0;
  let costUsd = 0;
  const byModel: ModelBreakdown = {};
  for (const e of entries) {
    tokens += e.tokens;
    costUsd += e.costUsd;
    const k = e.model || "unknown";
    if (!byModel[k]) byModel[k] = { tokens: 0, costUsd: 0 };
    byModel[k].tokens += e.tokens;
    byModel[k].costUsd += e.costUsd;
  }
  return { tokens, costUsd, byModel };
}

// Fixed 5h windows; current block is whichever the most recent message landed in.
function computeSession(sorted: UsageEntry[], now: number): UsageSnapshot["session"] {
  if (sorted.length === 0) {
    return { blockStartMs: null, blockEndMs: null, totalTokens: 0, totalCostUsd: 0, active: false, byModel: {} };
  }
  let blockStartMs = sorted[0].tsMs;
  let blockEndMs = blockStartMs + BLOCK_MS;
  let inBlock: UsageEntry[] = [];
  for (const e of sorted) {
    if (e.tsMs >= blockEndMs) {
      blockStartMs = e.tsMs;
      blockEndMs = blockStartMs + BLOCK_MS;
      inBlock = [];
    }
    inBlock.push(e);
  }
  const { tokens, costUsd, byModel } = accumulate(inBlock);
  return {
    blockStartMs,
    blockEndMs,
    totalTokens: tokens,
    totalCostUsd: costUsd,
    active: now < blockEndMs,
    byModel,
  };
}

export async function readUsageSnapshot(): Promise<UsageSnapshot> {
  const now = Date.now();
  const weekStart = now - WEEK_MS;
  const files = await listRecentTranscripts(weekStart);
  if (files.length === 0) return emptySnapshot(now, weekStart);

  const all: UsageEntry[] = [];
  for (const f of files) {
    const entries = await readEntries(f, weekStart);
    if (entries.length) all.push(...entries);
  }
  all.sort((a, b) => a.tsMs - b.tsMs);

  const session = computeSession(all, now);
  const weekly = accumulate(all);

  return {
    capturedAtMs: now,
    session,
    weekly: {
      windowStartMs: weekStart,
      totalTokens: weekly.tokens,
      totalCostUsd: weekly.costUsd,
      byModel: weekly.byModel,
    },
  };
}
