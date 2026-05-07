// room-summariser.ts — owns the Room-summary lifecycle (Phase 3).
//
// Sealed invariants (Concerns A/D/E/F from the architecture review):
//   - Per-Room "lines since last L1" tracking via SQL query (single source of
//     truth: MAX(end_line) FROM room_summary WHERE room=? AND level=1).
//   - In-flight L1 generation cached as a Promise so concurrent triggers
//     don't double-fire (Concern A — same race-safety as RoomHydrator).
//   - L2 rollup decision is internal: when K=20 unrolled L1 entries exist,
//     consolidate.
//   - Backfill is fire-and-forget; never blocks the Briefing path (Concern F).
//   - Empty-summary detection is BULLET-COUNT, not magic-string match
//     (Concern D).
//   - Prompt template lives ONLY here (not in adapters) — Concern C.
//
// What's NOT in this module: model selection (the Summariser interface is
// passed in as an injected dependency), JSONL persistence (transcript.ts owns
// that), Briefing assembly (briefing.ts owns that). RoomSummariser only
// decides what to summarise, when, and how the prompt is shaped — then
// delegates to the Summariser adapter.

import type { Database } from "bun:sqlite";

import { tailActive, activePath, roomBasename } from "./transcript";
import { existsSync } from "node:fs";
import {
  type Summariser,
  SummariserCallError,
  SummariserUnavailableError,
} from "./summariser";
import { getRoomSettings } from "./ledger";
import { readNutshell } from "../nutshell";
import type { Entry } from "./types";

export const L1_LINES_PER_BLOCK_DEFAULT = 300; // tuned for Gemma 4 E2B / Qwen 3 1.7B
export const L2_ROLLUP_BATCH_SIZE_DEFAULT = 20;
export const PRIOR_L1_CONTEXT_HINT = 5; // last N L1 entries shown as "known state" alongside Nutshell
// Stop trying after N consecutive failures per Room. Resets on hub restart.
// Prevents log spam when the adapter is broken (auth, missing model, etc.).
export const FAILURE_THRESHOLD = 3;

export type RoomSummariserOptions = {
  db: Database;
  summariser: Summariser; // null-checked at construction; if null, RoomSummariser isn't built
  linesPerBlock?: number;
  rollupBatchSize?: number;
};

export type RoomSummariser = {
  // Idempotent. Called from transcript.appendEntry after a successful write;
  // checks if N more lines have accumulated since the last L1 in this Room
  // and triggers an L1 generation if so. Race-safe via per-Room in-flight
  // promise cache.
  maybeSummarise(room: string): Promise<void>;

  // Idempotent. Called fire-and-forget from the Briefing path on first
  // agent reconnect for a Room post-Hub-restart, and from setRoomSettings
  // when room_summary_enabled flips on. Generates L1 entries for any
  // line ranges in the active transcript that don't have an L1 yet.
  maybeBackfill(room: string): Promise<void>;

  // Read APIs used by Briefing assembly.
  listL2(room: string): SummaryRow[];
  listUnrolledL1(room: string): SummaryRow[];
};

export type SummaryRow = {
  rowid: number;
  room: string;
  level: 1 | 2;
  start_line: number;
  end_line: number;
  model: string;
  summary: string;
  rolled_up_into: number | null;
  generated_at_ms: number;
};

export function createRoomSummariser(opts: RoomSummariserOptions): RoomSummariser {
  const { db, summariser } = opts;
  const linesPerBlock = opts.linesPerBlock ?? L1_LINES_PER_BLOCK_DEFAULT;
  const rollupBatchSize = opts.rollupBatchSize ?? L2_ROLLUP_BATCH_SIZE_DEFAULT;

  // Per-Room in-flight promise caches (Concern A race-safety).
  const summariseInFlight = new Map<string, Promise<void>>();
  const backfillInFlight = new Map<string, Promise<void>>();
  // Per-Room consecutive-failure counter. Once >= FAILURE_THRESHOLD, all
  // subsequent generateL1 calls bail silently for that Room until the hub
  // restarts. Counter resets on first successful L1 store.
  const roomFailures = new Map<string, number>();

  function lastSummarisedLine(room: string): number {
    const row = db
      .query<{ max_end: number | null }, [string]>(
        "SELECT MAX(end_line) AS max_end FROM room_summary WHERE room = ? AND level = 1",
      )
      .get(room);
    return row?.max_end ?? 0;
  }

  function activeLineCount(room: string): number {
    const path = activePath(room);
    if (!existsSync(path)) return 0;
    // tailActive parses; for line counting we don't need parsing, but reusing
    // the same code keeps version handling consistent (skips v>1 lines).
    // For large active files we'd want a streaming count; the chat_history_limit
    // cap is small enough that reading all of it is acceptable.
    try {
      const all = tailActive(room, Number.MAX_SAFE_INTEGER);
      return all.length;
    } catch (e) {
      console.error(`[summariser] read failed for ${room}:`, e);
      return 0;
    }
  }

  function maybeSummarise(room: string): Promise<void> {
    // Synchronous bail checks live OUTSIDE the IIFE/cache. If we put them
    // inside, the IIFE finishes synchronously on bail and the finally clause
    // runs before backfillInFlight.set(...), so the .set() poisons the cache
    // with an already-resolved promise — every subsequent call short-circuits
    // through the cache and never does work.
    const settings = getRoomSettings(db, room);
    if (!settings?.room_summary_enabled) return Promise.resolve();

    const lastLine = lastSummarisedLine(room);
    const totalLines = activeLineCount(room);
    if (totalLines - lastLine < linesPerBlock) return Promise.resolve();

    const cached = summariseInFlight.get(room);
    if (cached) return cached;

    const startLine = lastLine + 1;
    const endLine = lastLine + linesPerBlock;
    const p = (async () => {
      try {
        await generateL1(room, startLine, endLine);
        // After a successful L1, check whether we have enough unrolled L1s
        // to trigger a rollup. Single pass — if rollup itself produces yet
        // another batch worth of L1s (impossible in practice; would mean
        // 20× the per-block lines have accumulated), the next maybeSummarise
        // tick handles it.
        await maybeRollup(room);
      } finally {
        summariseInFlight.delete(room);
      }
    })();
    summariseInFlight.set(room, p);
    return p;
  }

  async function generateL1(
    room: string,
    startLine: number,
    endLine: number,
  ): Promise<void> {
    // Failure-threshold guard: if this Room's adapter has failed
    // FAILURE_THRESHOLD times in a row, stop trying. Resets on hub restart
    // (the in-memory map dies with the process) or on first success.
    if ((roomFailures.get(room) ?? 0) >= FAILURE_THRESHOLD) return;

    // Read the line range from the active JSONL.
    const allEntries = tailActive(room, Number.MAX_SAFE_INTEGER);
    const slice = allEntries.slice(startLine - 1, endLine);
    if (!slice.length) return;

    const nutshellSnapshot = readNutshell(db, room);
    const priorL2s = listL2(room);
    const recentL1s = listUnrolledL1(room).slice(-PRIOR_L1_CONTEXT_HINT);

    const systemPrompt = buildL1SystemPrompt();
    const userContent = buildL1UserContent(
      nutshellSnapshot.text,
      priorL2s,
      recentL1s,
      slice,
    );

    let raw: string;
    try {
      raw = await summariser.summarise(systemPrompt, userContent, {
        maxOutputTokens: 800,
        temperature: 0.2,
      });
    } catch (e) {
      const fails = (roomFailures.get(room) ?? 0) + 1;
      roomFailures.set(room, fails);
      if (fails === FAILURE_THRESHOLD) {
        console.warn(
          `[summariser] room=${room} disabled after ${FAILURE_THRESHOLD} consecutive failures; ` +
            `next attempt requires hub restart`,
        );
      }
      // Log the first FAILURE_THRESHOLD attempts (so the user sees what's
      // wrong) but suppress everything after.
      if (fails <= FAILURE_THRESHOLD) {
        if (e instanceof SummariserUnavailableError) {
          console.warn(`[summariser] adapter unavailable for room=${room}: ${e.message}`);
        } else if (e instanceof SummariserCallError) {
          console.error(`[summariser] call failed for room=${room}: ${e.message}`);
        } else {
          console.error(`[summariser] unexpected error for room=${room}:`, e);
        }
      }
      return;
    }

    // Concern D: bullet-count detection rather than magic-string match.
    if (countBullets(raw) === 0) {
      console.log(`[summariser] room=${room} L1 [${startLine}-${endLine}] empty (no bullets); skipping store`);
      return;
    }

    db.run(
      `INSERT OR REPLACE INTO room_summary
         (room, level, start_line, end_line, model, summary, rolled_up_into, generated_at_ms)
       VALUES (?, 1, ?, ?, ?, ?, NULL, ?)`,
      [room, startLine, endLine, summariser.modelId, raw.trim(), Date.now()],
    );
    // Reset the failure counter on first successful store.
    roomFailures.delete(room);
    console.log(`[summariser] room=${room} L1 [${startLine}-${endLine}] stored (${raw.length} chars, ${countBullets(raw)} bullets)`);
  }

  async function maybeRollup(room: string): Promise<void> {
    const unrolled = listUnrolledL1(room);
    if (unrolled.length < rollupBatchSize) return;

    const batch = unrolled.slice(0, rollupBatchSize);
    const startLine = batch[0].start_line;
    const endLine = batch[batch.length - 1].end_line;

    const nutshellSnapshot = readNutshell(db, room);
    const priorL2s = listL2(room);

    const systemPrompt = buildL2SystemPrompt();
    const userContent = buildL2UserContent(nutshellSnapshot.text, priorL2s, batch);

    let raw: string;
    try {
      raw = await summariser.summarise(systemPrompt, userContent, {
        maxOutputTokens: 600,
        temperature: 0.2,
      });
    } catch (e) {
      console.error(`[summariser] rollup failed for room=${room}:`, e);
      return;
    }
    if (countBullets(raw) === 0) {
      console.log(`[summariser] room=${room} L2 rollup empty; skipping`);
      return;
    }

    // Atomic: insert L2, mark the L1s as rolled-up.
    db.transaction(() => {
      const result = db.run(
        `INSERT INTO room_summary
           (room, level, start_line, end_line, model, summary, rolled_up_into, generated_at_ms)
         VALUES (?, 2, ?, ?, ?, ?, NULL, ?)`,
        [room, startLine, endLine, summariser.modelId, raw.trim(), Date.now()],
      );
      const l2RowId = Number(result.lastInsertRowid);
      const placeholders = batch.map(() => "?").join(",");
      db.run(
        `UPDATE room_summary SET rolled_up_into = ? WHERE rowid IN (${placeholders})`,
        [l2RowId, ...batch.map((b) => b.rowid)],
      );
    })();
    console.log(`[summariser] room=${room} L2 rolled up ${batch.length} L1s into [${startLine}-${endLine}]`);
  }

  function maybeBackfill(room: string): Promise<void> {
    // Same cache-poison fix as maybeSummarise: synchronous bail checks must
    // not touch the in-flight cache. See the comment there for the full
    // explanation.
    const settings = getRoomSettings(db, room);
    if (!settings?.room_summary_enabled) return Promise.resolve();

    const lastLine = lastSummarisedLine(room);
    const totalLines = activeLineCount(room);
    if (totalLines - lastLine < linesPerBlock) return Promise.resolve();

    const cached = backfillInFlight.get(room);
    if (cached) return cached;

    const p = (async () => {
      try {
        // Backfill processes whole blocks only; partial trailing block is
        // picked up by the next maybeSummarise after more chat lands.
        let cursor = lastLine;
        while (totalLines - cursor >= linesPerBlock) {
          const start = cursor + 1;
          const end = cursor + linesPerBlock;
          await generateL1(room, start, end);
          await maybeRollup(room);
          cursor = end;
        }
      } finally {
        backfillInFlight.delete(room);
      }
    })();
    backfillInFlight.set(room, p);
    return p;
  }

  function listL2(room: string): SummaryRow[] {
    return db
      .query<SummaryRow & { rowid: number }, [string]>(
        `SELECT rowid, room, level, start_line, end_line, model, summary, rolled_up_into, generated_at_ms
           FROM room_summary
          WHERE room = ? AND level = 2
          ORDER BY start_line ASC`,
      )
      .all(room) as SummaryRow[];
  }

  function listUnrolledL1(room: string): SummaryRow[] {
    return db
      .query<SummaryRow & { rowid: number }, [string]>(
        `SELECT rowid, room, level, start_line, end_line, model, summary, rolled_up_into, generated_at_ms
           FROM room_summary
          WHERE room = ? AND level = 1 AND rolled_up_into IS NULL
          ORDER BY start_line ASC`,
      )
      .all(room) as SummaryRow[];
  }

  return { maybeSummarise, maybeBackfill, listL2, listUnrolledL1 };
}

// =============================================================================
// PROMPT TEMPLATES — single source of truth (Concern C).
// =============================================================================

function buildL1SystemPrompt(): string {
  return [
    "You summarise recent chat from a multi-agent room.",
    "",
    "Extract only what a new agent joining the room would need to know IN ADDITION to the KNOWN STATE and PRIOR SUMMARIES the user provides. If both are empty, treat the chat as fully novel.",
    "",
    "Capture: decisions made in chat, blockers discovered (with resolutions if found), state changes (work landed/broke/deployed/reverted), constraints uncovered, agent-to-agent contracts (asks + responses), file paths / function names / IDs that anchor concrete work.",
    "",
    "Skip: acknowledgements, status pings, repeated explanations of things already in KNOWN STATE, auto-resolved errors, pleasantries.",
    "",
    "If nothing of substance happened, output an empty list (no bullets at all).",
    "",
    "Output: bullet list (lines starting with `- `), max 10 items, one short line each. No preamble, no header, no closing remarks. Just bullets, or nothing.",
  ].join("\n");
}

function buildL1UserContent(
  nutshellText: string,
  priorL2s: SummaryRow[],
  recentL1s: SummaryRow[],
  chatSlice: Entry[],
): string {
  const sections: string[] = [];

  sections.push("## KNOWN STATE (do not re-summarise)");
  sections.push(nutshellText.trim() || "(no curated state)");
  sections.push("");

  sections.push("## PRIOR SUMMARIES OF THIS ROOM (do not re-summarise)");
  if (priorL2s.length === 0 && recentL1s.length === 0) {
    sections.push("(none yet)");
  } else {
    for (const r of priorL2s) {
      sections.push(`### Rollup [lines ${r.start_line}-${r.end_line}]`);
      sections.push(r.summary);
    }
    for (const r of recentL1s) {
      sections.push(`### Recent block [lines ${r.start_line}-${r.end_line}]`);
      sections.push(r.summary);
    }
  }
  sections.push("");

  sections.push("## RECENT CHAT TO SUMMARISE");
  for (const e of chatSlice) {
    sections.push(formatEntryForPrompt(e));
  }

  return sections.join("\n");
}

function buildL2SystemPrompt(): string {
  return [
    "You consolidate block summaries from a multi-agent room into one rollup.",
    "",
    "The user provides KNOWN STATE, EARLIER ROLLUPS, and a batch of BLOCK SUMMARIES. Merge the BLOCK SUMMARIES into a single bullet list capturing the most material items across them. Drop redundancy with KNOWN STATE and EARLIER ROLLUPS.",
    "",
    "Output: bullet list (lines starting with `- `), max 8 items, one short line each. No preamble, no header. Just bullets, or nothing if everything was already covered.",
  ].join("\n");
}

function buildL2UserContent(
  nutshellText: string,
  priorL2s: SummaryRow[],
  batch: SummaryRow[],
): string {
  const sections: string[] = [];

  sections.push("## KNOWN STATE");
  sections.push(nutshellText.trim() || "(no curated state)");
  sections.push("");

  sections.push("## EARLIER ROLLUPS");
  if (priorL2s.length === 0) {
    sections.push("(none yet)");
  } else {
    for (const r of priorL2s) {
      sections.push(`### Rollup [lines ${r.start_line}-${r.end_line}]`);
      sections.push(r.summary);
    }
  }
  sections.push("");

  sections.push(`## BLOCK SUMMARIES TO CONSOLIDATE (${batch.length})`);
  for (const r of batch) {
    sections.push(`### Block [lines ${r.start_line}-${r.end_line}]`);
    sections.push(r.summary);
  }

  return sections.join("\n");
}

function formatEntryForPrompt(e: Entry): string {
  // One-line per chat entry; redact already happened at persist time so
  // <private> blocks are gone. system entries (slash audits) are kept —
  // they're rare and sometimes informative.
  const from = (e.from as string | undefined) ?? "?";
  const to = (e.to as string | undefined) ?? "?";
  const ts = (e.ts as string | undefined) ?? "";
  const text = ((e.text as string | undefined) ?? "").replace(/\n/g, " ").trim();
  return `[${ts}] ${from} → ${to}: ${text}`;
}

// =============================================================================
// EMPTY-SUMMARY DETECTION (Concern D — bullet count, not magic string).
// =============================================================================

function countBullets(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("- ") || t.startsWith("* ") || t.startsWith("• ")) count++;
  }
  return count;
}
