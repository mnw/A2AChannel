import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, postJson, registerAgent } from "../helpers/fetch";

describe("permission lifecycle", () => {
  let hub: HubHandle;
  let alice: Awaited<ReturnType<typeof registerAgent>>;

  beforeAll(async () => {
    hub = await spawnHub();
    alice = await registerAgent(hub, "alice");
  });

  afterAll(async () => {
    alice.close();
    await hub.kill();
  });

  test("create → verdict allow → list allowed", async () => {
    const create = await postJson(hub, "/permissions", {
      agent: "alice",
      request_id: "abcde",
      tool_name: "Bash",
      description: "list files",
      input_preview: "ls -la /tmp",
    });
    expect(create.status).toBe(201);
    const id = (create.json as { snapshot: { id: string } }).snapshot.id;
    expect(id).toBe("abcde");

    const verdict = await postJson(hub, `/permissions/${id}/verdict`, {
      by: hub.humanName,
      behavior: "allow",
    });
    expect(verdict.status).toBe(200);
    const snap = (verdict.json as { snapshot: { status: string; behavior: string; resolved_by: string } }).snapshot;
    expect(snap.status).toBe("allowed");
    expect(snap.behavior).toBe("allow");
    expect(snap.resolved_by).toBe(hub.humanName);

    const listed = await getJson(hub, `/permissions?status=allowed&token=${hub.token}`);
    expect((listed.json as Array<{ id: string }>).some((p) => p.id === id)).toBe(true);
  });

  test("same-verdict retry is idempotent", async () => {
    await postJson(hub, "/permissions", {
      agent: "alice", request_id: "fghij", tool_name: "Read",
      description: "read file", input_preview: "/etc/hosts",
    });
    await postJson(hub, "/permissions/fghij/verdict", { by: hub.humanName, behavior: "allow" });
    const second = await postJson(hub, "/permissions/fghij/verdict", { by: hub.humanName, behavior: "allow" });
    expect(second.status).toBe(200);
    expect((second.json as { idempotent?: boolean }).idempotent).toBe(true);
  });

  test("409 conflict on different verdict", async () => {
    await postJson(hub, "/permissions", {
      agent: "alice", request_id: "kmnop", tool_name: "Read",
      description: "conflict test", input_preview: "x",
    });
    await postJson(hub, "/permissions/kmnop/verdict", { by: hub.humanName, behavior: "allow" });
    const conflict = await postJson(hub, "/permissions/kmnop/verdict", { by: hub.humanName, behavior: "deny" });
    expect(conflict.status).toBe(409);
  });

  test("dismiss clears a pending ghost", async () => {
    await postJson(hub, "/permissions", {
      agent: "alice", request_id: "qrstu", tool_name: "Bash",
      description: "ghost test", input_preview: "y",
    });
    const dismiss = await postJson(hub, "/permissions/qrstu/dismiss", { by: hub.humanName });
    expect(dismiss.status).toBe(200);
    const snap = (dismiss.json as { snapshot: { status: string; behavior: string | null } }).snapshot;
    expect(snap.status).toBe("dismissed");
    expect(snap.behavior).toBeNull();
  });

  test("409 on verdict after dismiss", async () => {
    await postJson(hub, "/permissions", {
      agent: "alice", request_id: "vwxyz", tool_name: "Bash",
      description: "post-dismiss test", input_preview: "z",
    });
    await postJson(hub, "/permissions/vwxyz/dismiss", { by: hub.humanName });
    const verdict = await postJson(hub, "/permissions/vwxyz/verdict", {
      by: hub.humanName, behavior: "allow",
    });
    expect(verdict.status).toBe(409);
  });

  test("idempotent dismiss", async () => {
    await postJson(hub, "/permissions", {
      agent: "alice", request_id: "bcdef", tool_name: "Read",
      description: "idempotent dismiss", input_preview: "q",
    });
    await postJson(hub, "/permissions/bcdef/dismiss", { by: hub.humanName });
    const second = await postJson(hub, "/permissions/bcdef/dismiss", { by: hub.humanName });
    expect(second.status).toBe(200);
    expect((second.json as { idempotent?: boolean }).idempotent).toBe(true);
  });

  test("400 on invalid request_id shape", async () => {
    // 'l' is excluded from the id charset
    const r = await postJson(hub, "/permissions", {
      agent: "alice", request_id: "abcle", tool_name: "Bash",
      description: "invalid id", input_preview: "x",
    });
    expect(r.status).toBe(400);
  });
});
