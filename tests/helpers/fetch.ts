// Thin wrapper around fetch() that injects the hub's bearer token and
// JSON headers. Mirrors the ui/main.js authedFetch pattern.

import type { HubHandle } from "./hub";

export async function authedFetch(
  hub: HubHandle,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${hub.url}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${hub.token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

export async function postJson(
  hub: HubHandle,
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const r = await authedFetch(hub, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  let j: unknown = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

export async function getJson(
  hub: HubHandle,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const r = await authedFetch(hub, path);
  let j: unknown = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

// Register an agent by opening an /agent-stream connection. Returns a closer
// that drops the connection (which may or may not remove the agent, subject
// to the hub's 15s stale-cleanup window — fine for tests).
export async function registerAgent(
  hub: HubHandle,
  name: string,
  opts?: { room?: string },
): Promise<{ close: () => void; firstEvent: Promise<any> }> {
  const q = opts?.room ? `&room=${encodeURIComponent(opts.room)}` : "";
  const sse = openSSE(hub, `/agent-stream?agent=${encodeURIComponent(name)}${q}`);
  // Wait for the first event (briefing) to confirm registration landed.
  const firstEvent = (async () => {
    for await (const e of sse.events) return e;
    return null;
  })();
  // Give the hub a tick to add the name to the roster.
  await firstEvent;
  return { close: sse.close, firstEvent };
}

// SSE tail — opens /agent-stream or /stream and yields each `data: ...` event
// as a parsed object. Caller abort()s the returned controller to close.
export function openSSE(
  hub: HubHandle,
  path: string,
): { events: AsyncGenerator<any, void, void>; close: () => void } {
  const url = `${hub.url}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(hub.token)}`;
  const ac = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  async function* gen(): AsyncGenerator<any, void, void> {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok || !r.body) throw new Error(`SSE open failed: ${r.status}`);
    reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice(6));
        } catch { /* ignore parse errors */ }
      }
    }
  }

  return {
    events: gen(),
    close: () => {
      ac.abort();
      try { reader?.cancel(); } catch {}
    },
  };
}
