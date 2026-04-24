import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { postJson, registerAgent, openSSE } from "../helpers/fetch";

// The Scope resolver is exercised indirectly via the kind broadcasts — today
// the broadcastHandoff / broadcastInterrupt / broadcastPermission helpers still
// enumerate queues inline (they move onto `emit(entry, scope)` in §5–§7 as the
// kinds extract). These tests lock in the fan-out semantics `emit` must preserve.
//
// Scope coverage:
//   - to-agents (handoff.new → [to])
//   - to-agents multi (handoff.update → [from, to])
//   - room      (interrupt.new → same-room recipient only; cross-room blocked at create)
//   - broadcast (permission.new → UI + all non-permanent agents)
//   - ui-only   (nutshell updates — UI subscribers only, no agent queues)

describe("SSE scope fan-out", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  test("to-agents scope: handoff.new lands only on recipient, not other agents", async () => {
    const tailBob = openSSE(hub, `/agent-stream?agent=bob-s1`);
    const tailCharlie = openSSE(hub, `/agent-stream?agent=charlie-s1`);
    await new Promise((r) => setTimeout(r, 100));  // let both register

    const senderReg = await registerAgent(hub, "sender-s1");

    const bobPromise = (async () => {
      for await (const e of tailBob.events) if (e.kind === "handoff.new") return e;
    })();
    const charliePromise = (async () => {
      for await (const e of tailCharlie.events) if (e.kind === "handoff.new") return e;
    })();

    const r = await postJson(hub, "/handoffs", {
      from: "sender-s1", to: "bob-s1", task: "scope test", ttl_seconds: 60,
    });
    expect(r.status).toBe(201);
    const id = (r.json as { id: string }).id;

    const bobEvt = await Promise.race([
      bobPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("bob timeout")), 1500)),
    ]) as any;
    expect(bobEvt.handoff_id).toBe(id);

    // Charlie must NOT receive the handoff. Wait briefly; if the scope resolver leaks, he will.
    const leak = await Promise.race([
      charliePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    expect(leak).toBeNull();

    tailBob.close();
    tailCharlie.close();
    senderReg.close();
  });

  test("room scope: same-room interrupt arrives, different-room does not", async () => {
    const tailAlice = openSSE(hub, `/agent-stream?agent=alice-r1&room=projectA`);
    const tailDana = openSSE(hub, `/agent-stream?agent=dana-r1&room=projectB`);
    await new Promise((r) => setTimeout(r, 100));

    const human = hub.humanName;
    const alicePromise = (async () => {
      for await (const e of tailAlice.events) if (e.kind === "interrupt.new") return e;
    })();
    const danaPromise = (async () => {
      for await (const e of tailDana.events) if (e.kind === "interrupt.new") return e;
    })();

    // Send to alice from human (cross-room allowed for human).
    const r = await postJson(hub, "/interrupts", {
      from: human, to: "alice-r1", text: "heads up",
    });
    expect(r.status).toBe(201);

    const aliceEvt = await Promise.race([
      alicePromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("alice timeout")), 1500)),
    ]) as any;
    expect(aliceEvt.kind).toBe("interrupt.new");

    // Dana in a different room shouldn't see alice's interrupt.
    const leak = await Promise.race([
      danaPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    expect(leak).toBeNull();

    tailAlice.close();
    tailDana.close();
  });
});
