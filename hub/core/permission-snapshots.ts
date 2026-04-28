// permission-snapshots.ts — sidecar files capturing the agent's pane bytes
// at the moment the scraper auto-dismissed a permission card. Forensic
// audit surface; never the source of truth (the ledger row owns that).
// Bounded by 100-file LRU on every write so disk growth stays small.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEEP_RECENT = 100;
let _dir: string | null = null;

export function snapshotsDir(): string {
  if (_dir) return _dir;
  const override = process.env.A2A_PERMISSION_SNAPSHOTS_DIR;
  _dir = override && override.length
    ? override
    : join(homedir(), "Library", "Application Support", "A2AChannel", "permission-snapshots");
  return _dir;
}

export function init(): void {
  const dir = snapshotsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }
}

export function snapshotPath(id: string): string {
  // Filename = permission id verbatim. Permission ids are 5 lowercase letters
  // a-km-z (regex enforced at creation), so no sanitization needed.
  return join(snapshotsDir(), `${id}.txt`);
}

export function writeSnapshot(id: string, bytes: string): string {
  init();
  const path = snapshotPath(id);
  writeFileSync(path, bytes);
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  prune(KEEP_RECENT);
  return path;
}

export function readSnapshot(id: string): string | null {
  const path = snapshotPath(id);
  if (!existsSync(path)) return null;
  try { return readFileSync(path, "utf8"); }
  catch { return null; }
}

export function listSnapshots(): { id: string; path: string; sizeBytes: number; mtimeMs: number }[] {
  const dir = snapshotsDir();
  if (!existsSync(dir)) return [];
  const out: { id: string; path: string; sizeBytes: number; mtimeMs: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".txt")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      out.push({ id: name.slice(0, -4), path, sizeBytes: st.size, mtimeMs: st.mtimeMs });
    } catch { /* ignore */ }
  }
  return out;
}

export function prune(keep: number): void {
  const all = listSnapshots();
  if (all.length <= keep) return;
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const old of all.slice(keep)) {
    try { unlinkSync(old.path); }
    catch (e) { console.error(`[snapshots] unlink ${old.path}:`, e); }
  }
}
