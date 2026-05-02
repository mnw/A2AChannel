// MCP tool registry — schema + handler paired per tool. Each entry is the
// single source of truth for one tool: the JSON schema advertised via
// ListToolsRequestSchema AND the dispatcher branch invoked via
// CallToolRequestSchema. Adding a tool is one entry in this file; channel.ts
// stays kind-agnostic.
//
// Permission relay is intentionally NOT in this registry — it's a notification
// handler (mcp.setNotificationHandler), not a tool (mcp.setRequestHandler), so
// it has a different MCP wiring shape. See permission-relay.ts.

import { authedPost, authedUpload, toolError } from "./hub-client";

export type ToolContext = {
  agent: string;
  hubEnv: string;
};

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

export type ToolHandler = (
  ctx: ToolContext,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

export type ToolDef = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly handler: ToolHandler;
};

export const CHATBRIDGE_TOOLS: readonly ToolDef[] = [
  {
    name: "post",
    description: "Post a free-text message to the shared chat room.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message body" },
        to: {
          type: "string",
          description:
            'Recipient: "you" (human), "<agent-name>" to address a specific peer, or "all" to broadcast.',
        },
      },
      required: ["text", "to"],
    },
    handler: async (ctx, args) => {
      const text = String(args.text ?? "");
      const to = String(args.to ?? "");
      const resp = await authedPost(ctx.hubEnv, "/post", { from: ctx.agent, to, text });
      if (resp.status < 200 || resp.status >= 300) toolError(resp, "post");
      return { content: [{ type: "text", text: "posted" }] };
    },
  },
  {
    name: "post_file",
    description:
      "Upload a file from your local filesystem and post it as a chat message. The file's extension must match the hub's allowlist (default: jpg, jpeg, png, pdf, md). Returns the absolute filesystem path of the stored attachment (the same path recipients see via the [attachment: ...] marker) — safe to reference in a subsequent send_handoff.context.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path on your local filesystem to the file to upload.",
        },
        to: {
          type: "string",
          description: 'Recipient: "you" (human), "<agent-name>", or "all" (default).',
        },
        caption: {
          type: "string",
          maxLength: 1000,
          description: "Optional text body to accompany the file.",
        },
      },
      required: ["path"],
    },
    handler: async (ctx, args) => {
      const path = String(args.path ?? "").trim();
      if (!path) throw new Error("post_file: path is required");
      const to = String(args.to ?? "all");
      const caption = args.caption !== undefined ? String(args.caption) : "";

      const up = await authedUpload(ctx.hubEnv, path);
      if (up.status < 200 || up.status >= 300) toolError(up, "post_file upload");
      const upJson = (up.json ?? {}) as { url?: string; path?: string };
      const url = upJson.url ?? "";
      const fsPath = upJson.path ?? "";
      if (!url) throw new Error("post_file: hub returned no url");

      const send = await authedPost(ctx.hubEnv, "/post", {
        from: ctx.agent,
        to,
        text: caption,
        image: url,
      });
      if (send.status < 200 || send.status >= 300) toolError(send, "post_file send");
      // Return the absolute filesystem path (what the recipient sees via the
      // [attachment: ...] suffix). The virtual /image/ URL is for the UI viewer.
      return { content: [{ type: "text", text: `posted ${fsPath || url}` }] };
    },
  },
  {
    name: "send_handoff",
    description:
      "Transfer a bounded unit of work to another participant. Returns a handoff_id the recipient will accept or decline.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient agent name (may be the human's configured name).",
        },
        task: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Short description of the work being handed off.",
        },
        context: {
          type: "object",
          description:
            "Optional structured metadata (file refs, PR links, API contracts). Hub accepts up to ~1 MiB serialized, but the effective sender-side ceiling is ~200 KiB ASCII / ~50 KiB unicode-heavy JSON due to Read-tool + tool-call token caps. For larger payloads, post_file the artifact first and reference the returned absolute path here.",
        },
        ttl_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          description: "Time until auto-expiry. Defaults to 3600 (1 hour).",
        },
      },
      required: ["to", "task"],
    },
    handler: async (ctx, args) => {
      const body: Record<string, unknown> = {
        from: ctx.agent,
        to: args.to,
        task: args.task,
      };
      if (args.context !== undefined) body.context = args.context;
      if (args.ttl_seconds !== undefined) body.ttl_seconds = args.ttl_seconds;
      const resp = await authedPost(ctx.hubEnv, "/handoffs", body);
      if (resp.status !== 201) toolError(resp, "send_handoff");
      const id =
        resp.json && typeof resp.json === "object" && "id" in resp.json
          ? String((resp.json as { id: string }).id)
          : "";
      return { content: [{ type: "text", text: `handoff_id=${id}` }] };
    },
  },
  {
    name: "accept_handoff",
    description: "Accept a pending handoff addressed to you.",
    inputSchema: {
      type: "object",
      properties: {
        handoff_id: { type: "string", pattern: "^h_[0-9a-f]{16}$" },
        comment: {
          type: "string",
          maxLength: 500,
          description: "Optional note for the sender.",
        },
      },
      required: ["handoff_id"],
    },
    handler: async (ctx, args) => {
      const id = String(args.handoff_id ?? "");
      const body: Record<string, unknown> = { by: ctx.agent };
      if (args.comment !== undefined) body.comment = args.comment;
      const resp = await authedPost(ctx.hubEnv, `/handoffs/${id}/accept`, body);
      if (resp.status !== 200) toolError(resp, "accept_handoff");
      return { content: [{ type: "text", text: "accepted" }] };
    },
  },
  {
    name: "decline_handoff",
    description:
      "Decline a pending handoff addressed to you. A reason is required so the sender can re-route.",
    inputSchema: {
      type: "object",
      properties: {
        handoff_id: { type: "string", pattern: "^h_[0-9a-f]{16}$" },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Why you're declining.",
        },
      },
      required: ["handoff_id", "reason"],
    },
    handler: async (ctx, args) => {
      const id = String(args.handoff_id ?? "");
      const reason = String(args.reason ?? "");
      const resp = await authedPost(ctx.hubEnv, `/handoffs/${id}/decline`, { by: ctx.agent, reason });
      if (resp.status !== 200) toolError(resp, "decline_handoff");
      return { content: [{ type: "text", text: "declined" }] };
    },
  },
  {
    name: "cancel_handoff",
    description:
      "Withdraw a pending handoff you created. Reason optional. Only the sender (or the human) may cancel.",
    inputSchema: {
      type: "object",
      properties: {
        handoff_id: { type: "string", pattern: "^h_[0-9a-f]{16}$" },
        reason: { type: "string", maxLength: 500 },
      },
      required: ["handoff_id"],
    },
    handler: async (ctx, args) => {
      const id = String(args.handoff_id ?? "");
      const body: Record<string, unknown> = { by: ctx.agent };
      if (args.reason !== undefined) body.reason = args.reason;
      const resp = await authedPost(ctx.hubEnv, `/handoffs/${id}/cancel`, body);
      if (resp.status !== 200) toolError(resp, "cancel_handoff");
      return { content: [{ type: "text", text: "cancelled" }] };
    },
  },
  {
    name: "send_interrupt",
    description:
      "Send a high-visibility attention flag to another participant. The recipient's channel surfaces it prominently; they acknowledge via ack_interrupt when they've read it. Use sparingly — reserve for 'wait, re-read this before continuing' moments, not for regular chat.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient name." },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Short explanation of what the recipient should re-read or reconsider.",
        },
      },
      required: ["to", "text"],
    },
    handler: async (ctx, args) => {
      const to = String(args.to ?? "");
      const text = String(args.text ?? "");
      const resp = await authedPost(ctx.hubEnv, "/interrupts", { from: ctx.agent, to, text });
      if (resp.status !== 201) toolError(resp, "send_interrupt");
      const id =
        resp.json && typeof resp.json === "object" && "id" in resp.json
          ? String((resp.json as { id: string }).id)
          : "";
      return { content: [{ type: "text", text: `interrupt_id=${id}` }] };
    },
  },
  {
    name: "ack_interrupt",
    description: "Acknowledge a pending interrupt addressed to you.",
    inputSchema: {
      type: "object",
      properties: {
        interrupt_id: { type: "string", pattern: "^i_[0-9a-f]{16}$" },
      },
      required: ["interrupt_id"],
    },
    handler: async (ctx, args) => {
      const id = String(args.interrupt_id ?? "");
      const resp = await authedPost(ctx.hubEnv, `/interrupts/${id}/ack`, { by: ctx.agent });
      if (resp.status !== 200) toolError(resp, "ack_interrupt");
      return { content: [{ type: "text", text: "acknowledged" }] };
    },
  },
  {
    name: "ack_permission",
    description:
      "Submit a verdict on a pending Claude Code permission request. Any agent may ack any request (the hub accepts the first verdict; later ones are idempotent or rejected with 409). Returns 'verdict_applied=<allow|deny> resolved_by=<agent> your_verdict_won=<true|false>' so delegation logic can tell whether the caller's verdict transitioned the state or arrived after peer/human resolution. Note: this tool itself is permission-gated by Claude Code's local UI unless pre-allowlisted in the acking agent's config.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          type: "string",
          pattern: "^[a-km-zA-KM-Z]{5}$",
          description: "The claude-assigned request_id (5 letters a-z excluding l).",
        },
        behavior: {
          type: "string",
          enum: ["allow", "deny"],
          description: "Verdict. 'allow' lets claude proceed; 'deny' blocks the tool call.",
        },
      },
      required: ["request_id", "behavior"],
    },
    handler: async (ctx, args) => {
      const id = String(args.request_id ?? "");
      const behavior = String(args.behavior ?? "");
      if (!/^[a-km-z]{5}$/i.test(id)) throw new Error("ack_permission: invalid request_id");
      if (behavior !== "allow" && behavior !== "deny") {
        throw new Error("ack_permission: behavior must be 'allow' or 'deny'");
      }
      const resp = await authedPost(ctx.hubEnv, `/permissions/${id}/verdict`, { by: ctx.agent, behavior });
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
      const yourVerdictWon = !body.idempotent && resolvedBy === ctx.agent;
      const text = yourVerdictWon
        ? `verdict_applied=${finalBehavior} resolved_by=${resolvedBy} your_verdict_won=true`
        : `verdict_applied=${finalBehavior} resolved_by=${resolvedBy} your_verdict_won=false already_resolved=true`;
      return { content: [{ type: "text", text }] };
    },
  },
] as const;

// O(1) lookup; built once at module load.
const _byName = new Map<string, ToolDef>(CHATBRIDGE_TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolDef | null {
  return _byName.get(name) ?? null;
}

// MCP `ListToolsRequestSchema` advertises name + description + inputSchema only;
// strips the handler so the catalog is pure data over the wire.
export function listToolsForMcp(): Array<{
  name: string;
  description: string;
  inputSchema: object;
}> {
  return CHATBRIDGE_TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}
