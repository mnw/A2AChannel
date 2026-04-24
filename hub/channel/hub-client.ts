// HTTP client for the hub's /post, /handoffs, /interrupts, /permissions, /upload
// routes. Handles auth token rotation (on 401, re-reads the discovery file and
// retries once with the fresh token). Per-retry resolve keeps us in sync with
// A2AChannel.app restarts that mint new URL/port + new token pairs.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DISCOVERY_DIR = join(
  homedir(),
  "Library/Application Support/A2AChannel",
);
export const URL_PATH = join(DISCOVERY_DIR, "hub.url");
export const TOKEN_PATH = join(DISCOVERY_DIR, "hub.token");

export type HubInfo = { url: string; token: string };

export type HubResponse = { status: number; body: string; json: unknown };

function readTrimmed(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

// CHATBRIDGE_HUB env pins the URL (debug escape hatch); token always comes from disk.
export function resolveHub(hubEnv: string): HubInfo | null {
  const url = hubEnv || readTrimmed(URL_PATH);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = readTrimmed(TOKEN_PATH);
  if (!token) return null;
  return { url, token };
}

// Shared auth shell: resolve hub → call buildRequest → retry once on 401 after
// re-reading the token → parse response. `buildRequest` returns a per-call
// fetch init minus the Authorization header (which this helper injects).
async function authedRequest(
  hubEnv: string,
  path: string,
  buildRequest: () => RequestInit,
): Promise<HubResponse> {
  let hub = resolveHub(hubEnv);
  if (!hub) {
    throw new Error(
      `hub not found (need ${URL_PATH} and ${TOKEN_PATH}, or CHATBRIDGE_HUB env)`,
    );
  }
  const send = (h: HubInfo) => {
    const init = buildRequest();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${h.token}`);
    return fetch(`${h.url}${path}`, { ...init, headers });
  };
  let r = await send(hub);
  if (r.status === 401) {
    const refreshed = resolveHub(hubEnv);
    if (refreshed && refreshed.token !== hub.token) {
      hub = refreshed;
      r = await send(hub);
    }
  }
  const text = await r.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, body: text, json: parsed };
}

// Auto-retries once with a fresh token on 401.
export function authedPost(
  hubEnv: string,
  path: string,
  body: unknown,
): Promise<HubResponse> {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return authedRequest(hubEnv, path, () => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyStr,
  }));
}

export async function authedUpload(
  hubEnv: string,
  filePath: string,
): Promise<HubResponse> {
  const { readFileSync: readBytes, statSync } = await import("node:fs");
  const { basename } = await import("node:path");
  const filename = basename(filePath);
  // stat() before read() so a huge file can't OOM the sidecar just to be rejected.
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
  let bytes: Uint8Array;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error(`${filePath} is not a regular file`);
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new Error(`file too large: ${stat.size} bytes (max ${MAX_UPLOAD_BYTES})`);
    }
    bytes = new Uint8Array(readBytes(filePath));
  } catch (e) {
    throw new Error(`could not read ${filePath}: ${(e as Error).message ?? e}`);
  }
  return authedRequest(hubEnv, "/upload", () => {
    const form = new FormData();
    form.append("file", new Blob([bytes as unknown as BlobPart]), filename);
    return { method: "POST", body: form };
  });
}

// Map an error response from the hub into an Error with the hub-side message.
// Used by every tool handler — never returns (throws).
export function toolError(resp: HubResponse, action: string): never {
  const msg =
    resp.json &&
    typeof resp.json === "object" &&
    "error" in resp.json &&
    typeof (resp.json as { error: unknown }).error === "string"
      ? (resp.json as { error: string }).error
      : resp.body || `HTTP ${resp.status}`;
  throw new Error(`${action} failed: ${resp.status} ${msg}`);
}
