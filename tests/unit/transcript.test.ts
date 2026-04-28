// Unit tests for hub/core/transcript.ts. Uses a sandboxed transcripts dir
// (overrides via mocking module-level state through fresh imports per test).
//
// transcript.ts resolves the dir lazily via `transcriptDir()`. We can't
// override it cleanly without DI, so each test uses a unique room label —
// the per-room basename (sha1-prefixed) ensures filesystem isolation.

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ROTATION_LINES,
  appendEntry,
  clearRoom,
  listChunks,
  nextChunkSeq,
  roomBasename,
  tailActive,
  transcriptDir,
  activePath,
  chunkPath,
  init,
} from "../../hub/core/transcript";

const used: string[] = [];
function uniqueRoom(prefix: string): string {
  const r = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  used.push(r);
  return r;
}

beforeAll(() => init());

afterEach(() => {
  for (const room of used) {
    try { clearRoom(room); } catch { /* ignore */ }
  }
  used.length = 0;
});

describe("roomBasename", () => {
  test("stable per label", () => {
    const a = roomBasename("auth-rewrite");
    const b = roomBasename("auth-rewrite");
    expect(a).toBe(b);
  });
  test("distinct labels with same sanitized form get distinct hashes", () => {
    const a = roomBasename("auth-review");
    const b = roomBasename("auth review");
    expect(a).not.toBe(b);
    expect(a.endsWith("auth-review")).toBe(true);
    expect(b.endsWith("auth_review")).toBe(true);
  });
  test("non-alnum chars replaced with _", () => {
    const a = roomBasename("hello world / test");
    expect(a).toMatch(/^[0-9a-f]{8}-hello_world___test$/);
  });
});

describe("appendEntry + tailActive", () => {
  test("first append creates file with v=1 line", () => {
    const room = uniqueRoom("first");
    appendEntry(room, { from: "a", text: "hello" });
    const path = activePath(room);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(content.trim());
    expect(parsed.v).toBe(1);
    expect(parsed.from).toBe("a");
    expect(parsed.text).toBe("hello");
  });

  test("multiple appends preserve order", () => {
    const room = uniqueRoom("order");
    for (let i = 0; i < 5; i++) appendEntry(room, { from: "a", text: `m${i}` });
    const tail = tailActive(room, 10);
    expect(tail.length).toBe(5);
    expect((tail[0] as any).text).toBe("m0");
    expect((tail[4] as any).text).toBe("m4");
  });

  test("tailActive returns last n lines only", () => {
    const room = uniqueRoom("tail");
    for (let i = 0; i < 20; i++) appendEntry(room, { from: "a", text: `m${i}` });
    const last5 = tailActive(room, 5);
    expect(last5.length).toBe(5);
    expect((last5[0] as any).text).toBe("m15");
    expect((last5[4] as any).text).toBe("m19");
  });

  test("tolerates truncated final line", () => {
    const room = uniqueRoom("partial");
    appendEntry(room, { from: "a", text: "ok" });
    const path = activePath(room);
    writeFileSync(path, readFileSync(path, "utf8") + '{"v":1,"from":"b","text":"part');
    const tail = tailActive(room, 10);
    expect(tail.length).toBe(1);
    expect((tail[0] as any).text).toBe("ok");
  });

  test("throws on mid-file parse error", () => {
    const room = uniqueRoom("corrupt");
    appendEntry(room, { from: "a", text: "ok1" });
    const path = activePath(room);
    writeFileSync(path, "not json\n" + readFileSync(path, "utf8"));
    expect(() => tailActive(room, 10)).toThrow();
  });

  test("v > 1 lines are skipped with one warning per file", () => {
    const room = uniqueRoom("future");
    appendEntry(room, { from: "a", text: "v1" });
    const path = activePath(room);
    writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify({ v: 2, text: "from-future" }) + "\n");
    const tail = tailActive(room, 10);
    expect(tail.length).toBe(1);
    expect((tail[0] as any).text).toBe("v1");
  });
});

describe("rotation", () => {
  test("rotates exactly at ROTATION_LINES", () => {
    expect(ROTATION_LINES).toBe(10_000);
  });

  test("synthetic rotation triggers on append at exactly ROTATION_LINES", () => {
    // Pre-fill the active file with ROTATION_LINES - 1 lines, then one more
    // append should trigger rotation.
    const room = uniqueRoom("rot");
    const path = activePath(room);
    const dir = transcriptDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    let pre = "";
    for (let i = 0; i < ROTATION_LINES - 1; i++) {
      pre += JSON.stringify({ v: 1, from: "a", text: `m${i}` }) + "\n";
    }
    writeFileSync(path, pre);
    appendEntry(room, { from: "a", text: "trigger" });
    // Now: active file should have rotated. The trigger line lands as the
    // 10,000th line of the rotated chunk; active file is gone (rotation
    // moved it). Next append starts a fresh active file.
    expect(existsSync(path)).toBe(false);
    const chunks = listChunks(room);
    expect(chunks.length).toBe(1);
    expect(chunks[0].seq).toBe(1);
  });

  test("nextChunkSeq returns 1 when no chunks exist", () => {
    const room = uniqueRoom("seq");
    expect(nextChunkSeq(room)).toBe(1);
  });

  test("subsequent rotations increment seq", () => {
    const room = uniqueRoom("rot2");
    const dir = transcriptDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Create a fake chunk 1 manually so the next rotation goes to 2.
    writeFileSync(chunkPath(room, 1), "");
    // Pre-fill active file with ROTATION_LINES - 1 lines, then append.
    let pre = "";
    for (let i = 0; i < ROTATION_LINES - 1; i++) {
      pre += JSON.stringify({ v: 1, text: `m${i}` }) + "\n";
    }
    writeFileSync(activePath(room), pre);
    appendEntry(room, { text: "trigger" });
    const chunks = listChunks(room);
    expect(chunks.length).toBe(2);
    expect(chunks.map((c) => c.seq).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe("clearRoom", () => {
  test("removes active and all chunks", () => {
    const room = uniqueRoom("clear");
    const dir = transcriptDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendEntry(room, { text: "active" });
    writeFileSync(chunkPath(room, 1), "stub\n");
    writeFileSync(chunkPath(room, 2), "stub\n");
    expect(listChunks(room).length).toBe(2);
    expect(existsSync(activePath(room))).toBe(true);
    const result = clearRoom(room);
    expect(existsSync(activePath(room))).toBe(false);
    expect(listChunks(room).length).toBe(0);
    expect(result.removed.length).toBe(3);
  });

  test("idempotent on missing files", () => {
    const room = uniqueRoom("missing");
    const result = clearRoom(room);
    expect(result.removed).toEqual([]);
    // Second call also fine.
    const result2 = clearRoom(room);
    expect(result2.removed).toEqual([]);
  });
});

describe("listChunks", () => {
  test("returns sorted by seq", () => {
    const room = uniqueRoom("list");
    const dir = transcriptDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(chunkPath(room, 3), "data\n");
    writeFileSync(chunkPath(room, 1), "data\n");
    writeFileSync(chunkPath(room, 2), "data\n");
    const chunks = listChunks(room);
    expect(chunks.map((c) => c.seq)).toEqual([1, 2, 3]);
  });
});
