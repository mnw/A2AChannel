// Unit tests for hub/core/permission-snapshots.ts. Uses A2A_PERMISSION_SNAPSHOTS_DIR
// env override so tests don't touch the user's real permission-snapshots dir.

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mod: typeof import("../../hub/core/permission-snapshots");

beforeAll(async () => {
  process.env.A2A_PERMISSION_SNAPSHOTS_DIR = mkdtempSync(join(tmpdir(), "a2a-snapshot-test-"));
  mod = await import("../../hub/core/permission-snapshots");
  mod.init();
});

afterEach(() => {
  // Clean up snapshot files between tests so prune-state doesn't leak.
  const all = mod.listSnapshots();
  for (const s of all) {
    try { (require("node:fs") as typeof import("node:fs")).unlinkSync(s.path); } catch { /* ignore */ }
  }
});

function uniqueId(prefix: string): string {
  // Permission IDs are 5 lowercase letters [a-km-z]; we synthesize matching
  // ones by mapping the random base36 segment.
  const seg = Math.random().toString(36).slice(2, 7).replace(/[0-9l]/g, "a");
  return `${prefix.charAt(0)}${seg}`.slice(0, 5);
}

describe("init + dir", () => {
  test("creates dir with mode 0700", () => {
    const dir = mod.snapshotsDir();
    expect(existsSync(dir)).toBe(true);
    const st = statSync(dir);
    expect(st.mode & 0o777).toBe(0o700);
  });
});

describe("writeSnapshot", () => {
  test("writes file with mode 0600 and returns path", () => {
    const id = uniqueId("w");
    const path = mod.writeSnapshot(id, "hello world");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("hello world");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("snapshotPath is stable per id", () => {
    const id = uniqueId("s");
    const a = mod.snapshotPath(id);
    const b = mod.snapshotPath(id);
    expect(a).toBe(b);
  });
});

describe("readSnapshot", () => {
  test("returns content for existing snapshot", () => {
    const id = uniqueId("r");
    mod.writeSnapshot(id, "snapshot content");
    expect(mod.readSnapshot(id)).toBe("snapshot content");
  });

  test("returns null for missing", () => {
    const id = uniqueId("m");
    expect(mod.readSnapshot(id)).toBeNull();
  });
});

describe("prune", () => {
  test("keeps only N most recent by mtime", () => {
    const dir = mod.snapshotsDir();
    // Synthesize 5 files with stepping mtimes (oldest first).
    const ids = [uniqueId("a"), uniqueId("b"), uniqueId("c"), uniqueId("d"), uniqueId("e")];
    const baseTime = Date.now() / 1000;
    for (let i = 0; i < ids.length; i++) {
      const path = mod.snapshotPath(ids[i]);
      writeFileSync(path, `data-${i}`);
      // i=0 is oldest, i=4 is newest.
      utimesSync(path, baseTime - (5 - i) * 60, baseTime - (5 - i) * 60);
    }
    expect(mod.listSnapshots().length).toBe(5);
    mod.prune(2);
    const remaining = mod.listSnapshots();
    expect(remaining.length).toBe(2);
    // Most recent two (indices 3, 4) survive.
    const names = remaining.map((s) => s.id).sort();
    expect(names).toContain(ids[3]);
    expect(names).toContain(ids[4]);
  });

  test("no-op when count below cap", () => {
    mod.writeSnapshot(uniqueId("n"), "x");
    mod.writeSnapshot(uniqueId("n"), "y");
    expect(mod.listSnapshots().length).toBe(2);
    mod.prune(10);
    expect(mod.listSnapshots().length).toBe(2);
  });
});

describe("listSnapshots", () => {
  test("ignores non-jsonl-like files", () => {
    const id = uniqueId("k");
    mod.writeSnapshot(id, "real");
    // Drop a non-.txt file in the dir; listSnapshots should skip it.
    writeFileSync(join(mod.snapshotsDir(), "stray.json"), "ignored");
    const all = mod.listSnapshots();
    expect(all.find((s) => s.id === id)).toBeDefined();
    expect(all.find((s) => s.path.endsWith("stray.json"))).toBeUndefined();
  });
});
