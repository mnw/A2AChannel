import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "./hub";
import { getJson, postJson } from "./fetch";

describe("test harness", () => {
  let hub: HubHandle;

  beforeAll(async () => {
    hub = await spawnHub();
  });

  afterAll(async () => {
    await hub.kill();
  });

  test("hub boots and serves /agents with just the human", async () => {
    const { status, json } = await getJson(hub, `/agents?token=${hub.token}`);
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    // The human is registered as a permanent roster member at startup.
    expect((json as Array<{ name: string }>).some((a) => a.name === hub.humanName)).toBe(true);
  });

  test("mutating route rejects unauthenticated requests", async () => {
    const r = await fetch(`${hub.url}/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "alice", text: "hi" }),
    });
    expect(r.status).toBe(401);
  });

  test("mutating route accepts bearer token", async () => {
    // /post is authed but also auto-registers the sender
    const { status } = await postJson(hub, "/post", { from: "alice", text: "hi" });
    expect([200, 201]).toContain(status);
  });
});
