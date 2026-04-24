import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, postJson, registerAgent } from "../helpers/fetch";

describe("interrupt lifecycle", () => {
  let hub: HubHandle;
  let alice: Awaited<ReturnType<typeof registerAgent>>;
  let bob: Awaited<ReturnType<typeof registerAgent>>;

  beforeAll(async () => {
    hub = await spawnHub();
    alice = await registerAgent(hub, "alice");
    bob = await registerAgent(hub, "bob");
  });

  afterAll(async () => {
    alice.close();
    bob.close();
    await hub.kill();
  });

  test("create → list pending → ack → list acknowledged", async () => {
    const create = await postJson(hub, "/interrupts", {
      from: "alice",
      to: "bob",
      text: "stop and re-read the PR comments before merging",
    });
    expect(create.status).toBe(201);
    const id = (create.json as { id: string }).id;
    expect(id).toMatch(/^i_[0-9a-f]{16}$/);

    const pending = await getJson(hub, `/interrupts?status=pending&for=bob&token=${hub.token}`);
    expect((pending.json as Array<{ id: string }>).some((i) => i.id === id)).toBe(true);

    const ack = await postJson(hub, `/interrupts/${id}/ack`, { by: "bob" });
    expect(ack.status).toBe(200);
    expect((ack.json as { snapshot: { status: string } }).snapshot.status).toBe("acknowledged");
  });

  test("idempotent ack by the same recipient", async () => {
    const create = await postJson(hub, "/interrupts", {
      from: "alice", to: "bob", text: "idempotent test",
    });
    const id = (create.json as { id: string }).id;

    await postJson(hub, `/interrupts/${id}/ack`, { by: "bob" });
    const second = await postJson(hub, `/interrupts/${id}/ack`, { by: "bob" });
    expect(second.status).toBe(200);
    expect((second.json as { idempotent?: boolean }).idempotent).toBe(true);
  });

  test("human can ack on behalf of recipient", async () => {
    const create = await postJson(hub, "/interrupts", {
      from: "alice", to: "bob", text: "bob might be afk",
    });
    const id = (create.json as { id: string }).id;

    const ack = await postJson(hub, `/interrupts/${id}/ack`, { by: hub.humanName });
    expect(ack.status).toBe(200);
    expect((ack.json as { snapshot: { acknowledged_by: string } }).snapshot.acknowledged_by).toBe(hub.humanName);
  });

  test("403 on ack by non-recipient non-human", async () => {
    const create = await postJson(hub, "/interrupts", {
      from: "alice", to: "bob", text: "forbidden test",
    });
    const id = (create.json as { id: string }).id;

    // alice is the sender, not the recipient
    const ack = await postJson(hub, `/interrupts/${id}/ack`, { by: "alice" });
    expect(ack.status).toBe(403);
  });

  test("400 on text > 500 chars", async () => {
    const create = await postJson(hub, "/interrupts", {
      from: "alice", to: "bob", text: "x".repeat(501),
    });
    expect(create.status).toBe(400);
  });
});
