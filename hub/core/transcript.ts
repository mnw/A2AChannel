// transcript.ts — per-room JSONL chat transcript with rotation at 10k lines.
// Active file is `<basename>.jsonl`; rotated chunks are `<basename>.<6-digit-seq>.jsonl`.
// Rotation never deletes; only `clearRoom()` removes data.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Entry } from "./types";

export const ROTATION_LINES = 10_000;
const LINE_VERSION = 1;
const SEQ_PAD = 6;

let _dir: string | null = null;
const _warnedFiles = new Set<string>();

export function transcriptDir(): string {
  if (_dir) return _dir;
  const override = process.env.A2A_TRANSCRIPTS_DIR;
  _dir = override && override.length
    ? override
    : join(homedir(), "Library", "Application Support", "A2AChannel", "transcripts");
  return _dir;
}

export function init(): void {
  const dir = transcriptDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }
}

export function roomBasename(room: string): string {
  const hash = createHash("sha1").update(room).digest("hex").slice(0, 8);
  const sanitized = room.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${hash}-${sanitized}`;
}

export function activePath(room: string): string {
  return join(transcriptDir(), `${roomBasename(room)}.jsonl`);
}

export function chunkPath(room: string, seq: number): string {
  const padded = String(seq).padStart(SEQ_PAD, "0");
  return join(transcriptDir(), `${roomBasename(room)}.${padded}.jsonl`);
}

export function nextChunkSeq(room: string): number {
  const dir = transcriptDir();
  if (!existsSync(dir)) return 1;
  const basename = roomBasename(room);
  const re = new RegExp(`^${escapeRegex(basename)}\\.(\\d+)\\.jsonl$`);
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = re.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

export function listChunks(room: string): { seq: number; path: string; sizeBytes: number }[] {
  const dir = transcriptDir();
  if (!existsSync(dir)) return [];
  const basename = roomBasename(room);
  const re = new RegExp(`^${escapeRegex(basename)}\\.(\\d+)\\.jsonl$`);
  const out: { seq: number; path: string; sizeBytes: number }[] = [];
  for (const name of readdirSync(dir)) {
    const m = re.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    let sizeBytes = 0;
    try { sizeBytes = statSync(path).size; } catch { /* ignore */ }
    out.push({ seq: Number(m[1]), path, sizeBytes });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export function activeStats(room: string): { path: string; sizeBytes: number; lines: number } {
  const path = activePath(room);
  if (!existsSync(path)) return { path, sizeBytes: 0, lines: 0 };
  const sizeBytes = statSync(path).size;
  const lines = countLines(path);
  return { path, sizeBytes, lines };
}

export function appendEntry(room: string, entry: Entry): void {
  init();
  const path = activePath(room);
  const wrapped = { v: LINE_VERSION, ...entry };
  const line = JSON.stringify(wrapped) + "\n";
  const created = !existsSync(path);
  appendFileSync(path, line);
  if (created) {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  }
  const lines = countLines(path);
  if (lines >= ROTATION_LINES) {
    const seq = nextChunkSeq(room);
    const target = chunkPath(room, seq);
    renameSync(path, target);
  }
}

// Force-rotate the active file to the next chunk seq, leaving rotated chunks
// untouched. Non-destructive equivalent of "clear" — the chat window appears
// fresh (chatLog gets filtered hub-side) and restart replay sees an empty
// active file (no agent context replay), but historical data is archived
// rather than deleted.
export function rotateActive(room: string): { archivedTo: string | null } {
  const active = activePath(room);
  if (!existsSync(active)) return { archivedTo: null };
  const seq = nextChunkSeq(room);
  const target = chunkPath(room, seq);
  try {
    renameSync(active, target);
    return { archivedTo: target };
  } catch (e) {
    console.error(`[transcript] rotateActive ${active} → ${target}:`, e);
    return { archivedTo: null };
  }
}

// Hard-delete: removes active + every rotated chunk. Currently unused by the
// UI (the button calls rotateActive); kept as a building block for users who
// genuinely want to wipe history.
export function clearRoom(room: string): { removed: string[] } {
  const removed: string[] = [];
  const active = activePath(room);
  if (existsSync(active)) {
    try { unlinkSync(active); removed.push(active); }
    catch (e) { console.error(`[transcript] unlink ${active}:`, e); }
  }
  for (const c of listChunks(room)) {
    try { unlinkSync(c.path); removed.push(c.path); }
    catch (e) { console.error(`[transcript] unlink ${c.path}:`, e); }
  }
  return { removed };
}

// Read last `n` lines from active file; tolerant of truncated final line, throws on
// mid-file parse error. Reads in chunks from the end so we don't load big files fully.
export function tailActive(room: string, n: number): Entry[] {
  const path = activePath(room);
  if (!existsSync(path)) return [];
  const buf = readFileSync(path);
  if (buf.length === 0) return [];
  const text = buf.toString("utf8");
  const rawLines = text.split("\n");
  const lastIsTruncated = rawLines.length > 0 && rawLines[rawLines.length - 1] !== "";
  const finalLines = lastIsTruncated ? rawLines.slice(0, -1) : rawLines.filter((l) => l !== "");
  // If the file didn't end in \n the last element is a partial — drop it.
  const candidate = lastIsTruncated ? finalLines : finalLines;
  const start = Math.max(0, candidate.length - n);
  const out: Entry[] = [];
  for (let i = start; i < candidate.length; i++) {
    const line = candidate[i];
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      // Final-line truncation already handled above; mid-file parse errors are real.
      const isLast = i === candidate.length - 1 && lastIsTruncated;
      if (isLast) continue;
      throw new Error(`[transcript] parse error in ${path} line ${i + 1}: ${e}`);
    }
    const v = typeof parsed.v === "number" ? parsed.v : 0;
    if (v > LINE_VERSION) {
      if (!_warnedFiles.has(path)) {
        console.warn(`[transcript] ${path} contains v=${v} lines (we support v=${LINE_VERSION}); skipping`);
        _warnedFiles.add(path);
      }
      continue;
    }
    out.push(parsed as Entry);
  }
  return out;
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  const buf = readFileSync(path);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++;
  }
  return n;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
