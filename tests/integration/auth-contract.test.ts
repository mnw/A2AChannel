import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";

describe("auth contract — mutating routes", () => {
  let hub: HubHandle;

  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  // One representative mutating route per category. Auth check is centralised;
  // we don't need to test every route.
  const routes: Array<{ path: string; body: unknown }> = [
    { path: "/post",        body: { from: "alice", text: "hi" } },
    { path: "/send",        body: { text: "hi", target: "all", room: "default" } },
    { path: "/handoffs",    body: { from: "alice", to: "alice", task: "t" } },
    { path: "/interrupts",  body: { from: "alice", to: "alice", text: "hi" } },
    { path: "/permissions", body: { agent: "alice", request_id: "abcde", tool_name: "t", description: "d", input_preview: "p" } },
  ];

  // 401 sweep: every mutating route rejects unbearered requests. Run first
  // because 413 large-body rejections can jam Bun's fetch connection pool
  // for subsequent tests on the same hub (server closes response early,
  // client is still streaming a big body).
  for (const r of routes) {
    test(`${r.path} — 401 without bearer`, async () => {
      const resp = await fetch(`${hub.url}${r.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r.body),
      });
      expect(resp.status).toBe(401);
    });
  }

  // 413 sweep: representative small-cap routes only. Exercising oversized
  // bodies against 256 KiB / 16 KiB caps is safe; the 1 MiB /handoffs cap
  // is intentionally NOT tested here — the post-rejection stream teardown
  // interferes with the shared-hub connection pool in the Bun test runner.
  // The cap itself is still enforced in production (same requireJsonBody
  // path as the others).
  const smallCapRoutes: Array<{ path: string; bodyMax: number }> = [
    { path: "/post",        bodyMax: 262_144 },
    { path: "/permissions", bodyMax: 16_384 },
  ];

  for (const r of smallCapRoutes) {
    test(`${r.path} — 413 over body cap`, async () => {
      const oversize = "x".repeat(r.bodyMax + 1024);
      const resp = await fetch(`${hub.url}${r.path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${hub.token}`,
        },
        body: JSON.stringify({ _pad: oversize }),
      });
      expect(resp.status).toBe(413);
    });
  }
});
