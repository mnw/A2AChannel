import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { postJson, registerAgent, openSSE } from "../helpers/fetch";

describe("SSE broadcast + replay", () => {
  let hub: HubHandle;

  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  test("handoff.new arrives on recipient's /agent-stream", async () => {
    // Register sender normally.
    const sender = await registerAgent(hub, "sender1");

    // For the recipient, open ONE /agent-stream tail and consume briefings
    // from that same tail — don't registerAgent twice; the hub fans events
    // out to the first puller on the queue, so a second tail would starve.
    const tail = openSSE(hub, `/agent-stream?agent=recipient1`);

    const handoffPromise = (async () => {
      for await (const e of tail.events) {
        if (e.kind === "handoff.new") return e;
      }
    })();

    // Wait a tick so the hub has registered recipient1 in the roster before
    // we try to create a handoff TO recipient1.
    await new Promise((r) => setTimeout(r, 100));

    const create = await postJson(hub, "/handoffs", {
      from: "sender1", to: "recipient1", task: "check this out", ttl_seconds: 60,
    });
    expect(create.status).toBe(201);

    const evt = await Promise.race([
      handoffPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for handoff.new")), 2000)),
    ]) as any;

    expect(evt.kind).toBe("handoff.new");
    expect(evt.handoff_id).toBe((create.json as { id: string }).id);

    tail.close();
    sender.close();
  });

  test("pending handoff replays on reconnect with replay=true", async () => {
    const sender = await registerAgent(hub, "sender2");
    const recipient = await registerAgent(hub, "recipient2");

    // Create a handoff while recipient2 is connected; then drop + reconnect.
    const create = await postJson(hub, "/handoffs", {
      from: "sender2", to: "recipient2", task: "pending at boot", ttl_seconds: 60,
    });
    const id = (create.json as { id: string }).id;

    // Drop recipient2's registration connection; wait for hub to flip it offline.
    recipient.close();
    await new Promise((r) => setTimeout(r, 100));
    const tail = openSSE(hub, `/agent-stream?agent=recipient2`);

    const replayPromise = (async () => {
      for await (const e of tail.events) {
        if (e.kind === "handoff.new" && e.handoff_id === id) return e;
      }
    })();

    const evt = await Promise.race([
      replayPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for replay")), 2000)),
    ]) as any;

    expect(evt.replay).toBe(true);

    tail.close();
    sender.close();
  });
});

describe("Rooms — same-room arrives, cross-room rejects", () => {
  let hub: HubHandle;

  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  test("same-room handoff succeeds", async () => {
    const a = await registerAgent(hub, "rm-alice", { room: "projectA" });
    const b = await registerAgent(hub, "rm-bob", { room: "projectA" });
    const r = await postJson(hub, "/handoffs", {
      from: "rm-alice", to: "rm-bob", task: "same-room", ttl_seconds: 60,
    });
    expect(r.status).toBe(201);
    a.close(); b.close();
  });

  test("cross-room handoff from non-human rejects with 403", async () => {
    const a = await registerAgent(hub, "rm-alice2", { room: "projectA" });
    const b = await registerAgent(hub, "rm-charlie", { room: "projectB" });
    const r = await postJson(hub, "/handoffs", {
      from: "rm-alice2", to: "rm-charlie", task: "cross-room", ttl_seconds: 60,
    });
    expect(r.status).toBe(403);
    a.close(); b.close();
  });

  test("human can cross rooms", async () => {
    const c = await registerAgent(hub, "rm-dave", { room: "projectC" });
    const r = await postJson(hub, "/handoffs", {
      from: hub.humanName, to: "rm-dave", task: "human cross-room", ttl_seconds: 60,
    });
    expect(r.status).toBe(201);
    c.close();
  });
});
