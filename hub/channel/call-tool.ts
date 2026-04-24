// Dispatcher for MCP tool invocations. Each branch translates a tool call
// into an authenticated POST to the hub, then returns a minimal acknowledgement
// to claude. Errors from the hub bubble up via toolError() with the hub's own
// message — the tool caller sees the same text that would render in the chat UI.

import { authedPost, authedUpload, toolError } from "./hub-client";

export type CallToolContext = {
  agent: string;
  hubEnv: string;
};

export async function callTool(
  ctx: CallToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { agent, hubEnv } = ctx;

  if (name === "post") {
    const text = String(args.text ?? "");
    const to = String(args.to ?? "");
    const resp = await authedPost(hubEnv, "/post", { from: agent, to, text });
    if (resp.status < 200 || resp.status >= 300) toolError(resp, "post");
    return { content: [{ type: "text", text: "posted" }] };
  }

  if (name === "post_file") {
    const path = String(args.path ?? "").trim();
    if (!path) throw new Error("post_file: path is required");
    const to = String(args.to ?? "all");
    const caption = args.caption !== undefined ? String(args.caption) : "";

    const up = await authedUpload(hubEnv, path);
    if (up.status < 200 || up.status >= 300) toolError(up, "post_file upload");
    const upJson = (up.json ?? {}) as { url?: string; path?: string };
    const url = upJson.url ?? "";
    const fsPath = upJson.path ?? "";
    if (!url) throw new Error("post_file: hub returned no url");

    const send = await authedPost(hubEnv, "/post", {
      from: agent,
      to,
      text: caption,
      image: url,
    });
    if (send.status < 200 || send.status >= 300) toolError(send, "post_file send");
    // Return the absolute filesystem path (what the recipient sees via the
    // [attachment: ...] suffix). The virtual /image/ URL is for the UI viewer.
    return { content: [{ type: "text", text: `posted ${fsPath || url}` }] };
  }

  if (name === "send_handoff") {
    const body: Record<string, unknown> = {
      from: agent,
      to: args.to,
      task: args.task,
    };
    if (args.context !== undefined) body.context = args.context;
    if (args.ttl_seconds !== undefined) body.ttl_seconds = args.ttl_seconds;
    const resp = await authedPost(hubEnv, "/handoffs", body);
    if (resp.status !== 201) toolError(resp, "send_handoff");
    const id =
      resp.json && typeof resp.json === "object" && "id" in resp.json
        ? String((resp.json as { id: string }).id)
        : "";
    return { content: [{ type: "text", text: `handoff_id=${id}` }] };
  }

  if (name === "accept_handoff") {
    const id = String(args.handoff_id ?? "");
    const body: Record<string, unknown> = { by: agent };
    if (args.comment !== undefined) body.comment = args.comment;
    const resp = await authedPost(hubEnv, `/handoffs/${id}/accept`, body);
    if (resp.status !== 200) toolError(resp, "accept_handoff");
    return { content: [{ type: "text", text: "accepted" }] };
  }

  if (name === "decline_handoff") {
    const id = String(args.handoff_id ?? "");
    const reason = String(args.reason ?? "");
    const resp = await authedPost(hubEnv, `/handoffs/${id}/decline`, { by: agent, reason });
    if (resp.status !== 200) toolError(resp, "decline_handoff");
    return { content: [{ type: "text", text: "declined" }] };
  }

  if (name === "cancel_handoff") {
    const id = String(args.handoff_id ?? "");
    const body: Record<string, unknown> = { by: agent };
    if (args.reason !== undefined) body.reason = args.reason;
    const resp = await authedPost(hubEnv, `/handoffs/${id}/cancel`, body);
    if (resp.status !== 200) toolError(resp, "cancel_handoff");
    return { content: [{ type: "text", text: "cancelled" }] };
  }

  if (name === "send_interrupt") {
    const to = String(args.to ?? "");
    const text = String(args.text ?? "");
    const resp = await authedPost(hubEnv, "/interrupts", { from: agent, to, text });
    if (resp.status !== 201) toolError(resp, "send_interrupt");
    const id =
      resp.json && typeof resp.json === "object" && "id" in resp.json
        ? String((resp.json as { id: string }).id)
        : "";
    return { content: [{ type: "text", text: `interrupt_id=${id}` }] };
  }

  if (name === "ack_interrupt") {
    const id = String(args.interrupt_id ?? "");
    const resp = await authedPost(hubEnv, `/interrupts/${id}/ack`, { by: agent });
    if (resp.status !== 200) toolError(resp, "ack_interrupt");
    return { content: [{ type: "text", text: "acknowledged" }] };
  }

  if (name === "ack_permission") {
    const id = String(args.request_id ?? "");
    const behavior = String(args.behavior ?? "");
    if (!/^[a-km-z]{5}$/i.test(id)) throw new Error("ack_permission: invalid request_id");
    if (behavior !== "allow" && behavior !== "deny") {
      throw new Error("ack_permission: behavior must be 'allow' or 'deny'");
    }
    const resp = await authedPost(hubEnv, `/permissions/${id}/verdict`, { by: agent, behavior });
    if (resp.status !== 200) toolError(resp, "ack_permission");
    // Distinguish "my verdict won" from "already resolved by peer/human".
    // Hub returns { snapshot, idempotent?: true }. If idempotent, resolved_by
    // is whoever got there first; if absent, this caller transitioned the state.
    const body = (resp.json ?? {}) as {
      snapshot?: { resolved_by?: string | null; behavior?: string | null; status?: string };
      idempotent?: boolean;
    };
    const snap = body.snapshot ?? {};
    const resolvedBy = snap.resolved_by ?? "unknown";
    const finalBehavior = snap.behavior ?? behavior;
    const yourVerdictWon = !body.idempotent && resolvedBy === agent;
    const text = yourVerdictWon
      ? `verdict_applied=${finalBehavior} resolved_by=${resolvedBy} your_verdict_won=true`
      : `verdict_applied=${finalBehavior} resolved_by=${resolvedBy} your_verdict_won=false already_resolved=true`;
    return { content: [{ type: "text", text }] };
  }

  throw new Error(`unknown tool: ${name}`);
}
