#!/usr/bin/env bun
/**
 * Chatbridge channel — one subprocess per Claude Code session.
 *
 * The hub's roster is dynamic: any agent name connects and registers
 * itself. No startup validation; the post tool accepts a freeform `to`.
 *
 * Env:
 *   CHATBRIDGE_AGENT   this session's identity (required)
 *   CHATBRIDGE_HUB     (optional) pin to a specific hub URL
 *
 * If CHATBRIDGE_HUB is unset or empty, the hub URL and token are read
 * from discovery files written by A2AChannel.app:
 *   ~/Library/Application Support/A2AChannel/hub.url
 *   ~/Library/Application Support/A2AChannel/hub.token
 *
 * Both files are re-read on each retry so stale values self-heal when
 * the app restarts (which mints a new URL/port and a new token).
 *
 * The hub requires Bearer-token auth on POST /post. GET /agent-stream
 * is unauthenticated (EventSource cannot send custom headers), so the
 * token is attached only to outbound POSTs.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  NotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const AGENT = process.env.CHATBRIDGE_AGENT ?? process.argv[2] ?? "";
const HUB_ENV = (process.env.CHATBRIDGE_HUB ?? "").trim();
// Room is set at spawn time via the per-agent MCP config env; external-spawn agents
// lacking the env fall back to "default" (the hub's A2A_DEFAULT_ROOM is informational,
// channel-bin doesn't fetch it at startup — spawn-modal users always get an explicit env).
const ROOM = (process.env.CHATBRIDGE_ROOM ?? "default").trim() || "default";
const DISCOVERY_DIR = join(
  homedir(),
  "Library/Application Support/A2AChannel",
);
const URL_PATH = join(DISCOVERY_DIR, "hub.url");
const TOKEN_PATH = join(DISCOVERY_DIR, "hub.token");

if (!AGENT) {
  console.error("CHATBRIDGE_AGENT env var is required");
  process.exit(1);
}

type HubInfo = { url: string; token: string };

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
function resolveHub(): HubInfo | null {
  const url = HUB_ENV || readTrimmed(URL_PATH);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = readTrimmed(TOKEN_PATH);
  if (!token) return null;
  return { url, token };
}

const mcp = new Server(
  { name: "chatbridge", version: "0.9.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        // Claude Code 2.1.81+ forwards permission prompts to channels that declare this.
        // Pre-2.1.81 ignores the capability — feature is additive.
        // Declaring this is gated on hub bearer-token auth; see CLAUDE.md hard rule.
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions:
      `You are "${AGENT}" in room "${ROOM}" of a shared A2AChannel coordination room. ` +
      `Other participants (the human and any other agents) may or may not be present. ` +
      `Inbound messages arrive as <channel source="chatbridge" from="..." to="..." room="..."> ` +
      `with to="${AGENT}" or to="all".\n\n` +
      `Room scoping (enforced by the hub):\n` +
      `- You are in room "${ROOM}". Your broadcasts to to="all" reach only agents in ` +
      `room "${ROOM}" plus the human — NOT agents in other rooms.\n` +
      `- To address an agent in another room, use their explicit name in to="<name>". ` +
      `Cross-room handoffs from non-human senders are rejected (403).\n` +
      `- The room="..." attribute on every incoming <channel> tag is set by the hub ` +
      `and can be trusted. channel-bin re-validates it and drops any cross-room event ` +
      `before you see it — but you shouldn't need to filter in-context, it won't arrive.\n\n` +
      `Use "post" for free-text conversation: set from="${AGENT}", ` +
      `to="you" to address the human, to="<name>" for a peer, or to="all" to broadcast.\n\n` +
      `Use "post_file" to share a file from your filesystem: give an absolute path, ` +
      `an optional caption, and a recipient. The hub enforces an extension allowlist ` +
      `(default: jpg, jpeg, png, pdf, md) and an 8 MiB cap. On success, peers receive ` +
      `the file as [attachment: <absolute path>] — same convention as human uploads.\n\n` +
      `Use the structured-handoff tools when you're transferring bounded work ` +
      `to another participant:\n` +
      `- "send_handoff": hand a task to another participant. Returns a handoff_id.\n` +
      `- "accept_handoff": confirm you've taken a pending handoff addressed to you.\n` +
      `- "decline_handoff": refuse a pending handoff addressed to you. A reason is required.\n` +
      `- "cancel_handoff": withdraw a pending handoff you created (or that the human created).\n\n` +
      `Handoff events arrive as <channel kind="handoff.new" ...> or <channel kind="handoff.update" ...> ` +
      `with the handoff snapshot in the body. The meta attribute replay="true" means the event is ` +
      `a reconnect catch-up, not new news.\n\n` +
      `When you need to flag a peer's attention urgently (e.g. "stop and re-read this before continuing"), ` +
      `use "send_interrupt". Interrupts arrive as <channel kind="interrupt.new" ...> and stay visible to the ` +
      `recipient until acknowledged via "ack_interrupt". Reserve them for genuine "pause everything" moments ` +
      `— regular discussion belongs in post.\n\n` +
      `To propose an edit to the shared project summary (the "nutshell" that describes the current reference ` +
      `point), use "send_handoff" targeting the human (see the briefing for their name), task starting with "[nutshell]", ` +
      `and context={ "patch": "<new full text>" }. The human accepts or declines; accepted edits update the nutshell ` +
      `atomically and broadcast to all participants.\n\n` +
      `When Claude Code asks for tool-use approval (Bash, Write, Edit, …), the hub ` +
      `broadcasts a <channel kind="permission.new" ...> event. Anyone in the room can ` +
      `relay a verdict using "ack_permission" with the request_id and behavior ("allow" ` +
      `or "deny"). First verdict wins; later ones are either idempotent or rejected. ` +
      `Acking another agent's permission is valid — useful for reviewer-style flows.\n\n` +
      `Keep free-text messages concise; large artifacts belong in files. ` +
      `Attachments arrive as [attachment: <absolute-path>] — inspect the file's ` +
      `extension to choose your tool: Read for text/markdown/code/JSON, Read with pages= ` +
      `for PDFs, image vision for .png/.jpg/.jpeg/.gif/.webp. The default allowlist is ` +
      `images + pdf + md; the human can extend it via the app's config.json. ` +
      `If Read fails with a permission error, tell the human to add the folder to ` +
      `~/.claude/settings.json (permissions.additionalDirectories) or relaunch with --add-dir <folder>.`,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
              'Recipient: "you" (human), "<agent-name>" to address a specific ' +
              'peer, or "all" to broadcast.',
          },
        },
        required: ["text", "to"],
      },
    },
    {
      name: "post_file",
      description:
        "Upload a file from your local filesystem and post it as a chat message. The file's extension must match the hub's allowlist (default: jpg, jpeg, png, pdf, md).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute path on your local filesystem to the file to upload.",
          },
          to: {
            type: "string",
            description:
              'Recipient: "you" (human), "<agent-name>", or "all" (default).',
          },
          caption: {
            type: "string",
            maxLength: 1000,
            description: "Optional text body to accompany the file.",
          },
        },
        required: ["path"],
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
              "Optional structured metadata (file refs, PR links, API contracts). Up to ~1 MiB when serialized.",
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
    },
    {
      name: "ack_permission",
      description:
        "Submit a verdict on a pending Claude Code permission request. Any agent may ack any request (the hub accepts the first verdict; later ones are idempotent or rejected with 409).",
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
    },
  ],
}));

// Auto-retries once with a fresh token on 401.
async function authedPost(
  path: string,
  body: unknown,
): Promise<{ status: number; body: string; json: unknown }> {
  let hub = resolveHub();
  if (!hub) {
    throw new Error(
      `hub not found (need ${URL_PATH} and ${TOKEN_PATH}, or CHATBRIDGE_HUB env)`,
    );
  }
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const send = (h: HubInfo) =>
    fetch(`${h.url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.token}`,
      },
      body: bodyStr,
    });
  let r = await send(hub);
  if (r.status === 401) {
    const refreshed = resolveHub();
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

async function authedUpload(
  filePath: string,
): Promise<{ status: number; body: string; json: unknown }> {
  let hub = resolveHub();
  if (!hub) {
    throw new Error(
      `hub not found (need ${URL_PATH} and ${TOKEN_PATH}, or CHATBRIDGE_HUB env)`,
    );
  }
  const { readFileSync, statSync } = await import("node:fs");
  const { basename } = await import("node:path");
  const filename = basename(filePath);
  // stat() before read() so a huge file can't OOM the sidecar just to be rejected.
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
  let bytes: Uint8Array;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error(`${filePath} is not a regular file`);
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `file too large: ${stat.size} bytes (max ${MAX_UPLOAD_BYTES})`,
      );
    }
    bytes = new Uint8Array(readFileSync(filePath));
  } catch (e) {
    throw new Error(`could not read ${filePath}: ${(e as Error).message ?? e}`);
  }
  const send = async (h: HubInfo) => {
    const form = new FormData();
    form.append("file", new Blob([bytes as unknown as BlobPart]), filename);
    return fetch(`${h.url}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.token}` },
      body: form,
    });
  };
  let r = await send(hub);
  if (r.status === 401) {
    const refreshed = resolveHub();
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

function toolError(resp: { status: number; body: string; json: unknown }, action: string): never {
  const msg =
    resp.json &&
    typeof resp.json === "object" &&
    "error" in resp.json &&
    typeof (resp.json as { error: unknown }).error === "string"
      ? (resp.json as { error: string }).error
      : resp.body || `HTTP ${resp.status}`;
  throw new Error(`${action} failed: ${resp.status} ${msg}`);
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  if (req.params.name === "post") {
    const text = String(args.text ?? "");
    const to = String(args.to ?? "");
    const resp = await authedPost("/post", { from: AGENT, to, text });
    if (resp.status < 200 || resp.status >= 300) toolError(resp, "post");
    return { content: [{ type: "text", text: "posted" }] };
  }

  if (req.params.name === "post_file") {
    const path = String(args.path ?? "").trim();
    if (!path) throw new Error("post_file: path is required");
    const to = String(args.to ?? "all");
    const caption = args.caption !== undefined ? String(args.caption) : "";

    const up = await authedUpload(path);
    if (up.status < 200 || up.status >= 300) toolError(up, "post_file upload");
    const url =
      up.json && typeof up.json === "object" && "url" in up.json
        ? String((up.json as { url: string }).url)
        : "";
    if (!url) throw new Error("post_file: hub returned no url");

    const send = await authedPost("/post", {
      from: AGENT,
      to,
      text: caption,
      image: url,
    });
    if (send.status < 200 || send.status >= 300) toolError(send, "post_file send");
    return { content: [{ type: "text", text: `posted ${url}` }] };
  }

  if (req.params.name === "send_handoff") {
    const body: Record<string, unknown> = {
      from: AGENT,
      to: args.to,
      task: args.task,
    };
    if (args.context !== undefined) body.context = args.context;
    if (args.ttl_seconds !== undefined) body.ttl_seconds = args.ttl_seconds;
    const resp = await authedPost("/handoffs", body);
    if (resp.status !== 201) toolError(resp, "send_handoff");
    const id =
      resp.json && typeof resp.json === "object" && "id" in resp.json
        ? String((resp.json as { id: string }).id)
        : "";
    return { content: [{ type: "text", text: `handoff_id=${id}` }] };
  }

  if (req.params.name === "accept_handoff") {
    const id = String(args.handoff_id ?? "");
    const body: Record<string, unknown> = { by: AGENT };
    if (args.comment !== undefined) body.comment = args.comment;
    const resp = await authedPost(`/handoffs/${id}/accept`, body);
    if (resp.status !== 200) toolError(resp, "accept_handoff");
    return { content: [{ type: "text", text: "accepted" }] };
  }

  if (req.params.name === "decline_handoff") {
    const id = String(args.handoff_id ?? "");
    const reason = String(args.reason ?? "");
    const resp = await authedPost(`/handoffs/${id}/decline`, { by: AGENT, reason });
    if (resp.status !== 200) toolError(resp, "decline_handoff");
    return { content: [{ type: "text", text: "declined" }] };
  }

  if (req.params.name === "cancel_handoff") {
    const id = String(args.handoff_id ?? "");
    const body: Record<string, unknown> = { by: AGENT };
    if (args.reason !== undefined) body.reason = args.reason;
    const resp = await authedPost(`/handoffs/${id}/cancel`, body);
    if (resp.status !== 200) toolError(resp, "cancel_handoff");
    return { content: [{ type: "text", text: "cancelled" }] };
  }

  if (req.params.name === "send_interrupt") {
    const to = String(args.to ?? "");
    const text = String(args.text ?? "");
    const resp = await authedPost("/interrupts", { from: AGENT, to, text });
    if (resp.status !== 201) toolError(resp, "send_interrupt");
    const id =
      resp.json && typeof resp.json === "object" && "id" in resp.json
        ? String((resp.json as { id: string }).id)
        : "";
    return { content: [{ type: "text", text: `interrupt_id=${id}` }] };
  }

  if (req.params.name === "ack_interrupt") {
    const id = String(args.interrupt_id ?? "");
    const resp = await authedPost(`/interrupts/${id}/ack`, { by: AGENT });
    if (resp.status !== 200) toolError(resp, "ack_interrupt");
    return { content: [{ type: "text", text: "acknowledged" }] };
  }

  if (req.params.name === "ack_permission") {
    const id = String(args.request_id ?? "");
    const behavior = String(args.behavior ?? "");
    if (!/^[a-km-z]{5}$/i.test(id)) throw new Error("ack_permission: invalid request_id");
    if (behavior !== "allow" && behavior !== "deny") {
      throw new Error("ack_permission: behavior must be 'allow' or 'deny'");
    }
    const resp = await authedPost(`/permissions/${id}/verdict`, { by: AGENT, behavior });
    if (resp.status !== 200) toolError(resp, "ack_permission");
    return { content: [{ type: "text", text: `${behavior}ed` }] };
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

// -------- Claude Code permission-relay: forward permission_request to hub --------

const PermissionRequestSchema = NotificationSchema.extend({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string().regex(/^[a-km-z]{5}$/i),
    tool_name: z.string().min(1).max(120),
    description: z.string().max(2_000),
    input_preview: z.string().max(8_000),
  }).passthrough(),
});

mcp.setNotificationHandler(PermissionRequestSchema, async (notification) => {
  const { request_id, tool_name, description, input_preview } = notification.params;
  try {
    const resp = await authedPost("/permissions", {
      agent: AGENT,
      request_id,
      tool_name,
      description: description ?? "",
      input_preview: input_preview ?? "",
    });
    if (resp.status < 200 || resp.status >= 300) {
      // Don't retry — upstream keeps the local dialog open, human can still answer there.
      console.error(
        `[channel] permission_request ${request_id} POST failed: ${resp.status} ${resp.body}`,
      );
    }
  } catch (e) {
    console.error(`[channel] permission_request ${request_id} relay error:`, e);
  }
});

await mcp.connect(new StdioServerTransport());

const BUF_MAX = 1 << 20;

async function tailHub(): Promise<void> {
  let loggedMissingOnce = false;
  while (true) {
    const hub = resolveHub();
    if (!hub) {
      if (!loggedMissingOnce) {
        console.error(
          `[channel] hub not found; waiting for A2AChannel.app to start (expects ${URL_PATH} and ${TOKEN_PATH})`,
        );
        loggedMissingOnce = true;
      }
      await new Promise((s) => setTimeout(s, 2000));
      continue;
    }
    loggedMissingOnce = false;

    try {
      // Use ?token= for symmetry with the UI (EventSource can't send headers).
      const url =
        `${hub.url}/agent-stream` +
        `?agent=${encodeURIComponent(AGENT)}` +
        `&room=${encodeURIComponent(ROOM)}` +
        `&token=${encodeURIComponent(hub.token)}`;
      const r = await fetch(url);
      if (!r.ok || !r.body) {
        // On 401 the next iteration re-reads the discovery file and picks up the rotated token.
        await new Promise((s) => setTimeout(s, 2000));
        continue;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.length > BUF_MAX) buf = buf.slice(-BUF_MAX);
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          let evt: {
            type?: string;
            from?: string;
            to?: string;
            text?: string;
            ts?: string;
            room?: string | null;
            kind?: string;
            handoff_id?: string;
            interrupt_id?: string;
            permission_id?: string;
            version?: number;
            expires_at_ms?: number;
            status?: string;
            replay?: boolean;
            snapshot?: {
              id?: string;
              behavior?: "allow" | "deny" | null;
              status?: string;
            };
            tools?: string[];
            peers?: Array<{ name: string; online: boolean; room?: string | null }>;
            attachments_dir?: string;
            human_name?: string;
            nutshell?: string | null;
          };
          try {
            evt = JSON.parse(dataLine.slice(6));
          } catch (e) {
            console.error("[channel] SSE JSON parse failed:", e);
            continue;
          }
          try {
            // Defense-in-depth room gate (mirrors the upstream "Gate inbound messages"
            // pattern in channels-reference). The hub already scopes broadcasts, but we
            // re-check here so any routing bug can't leak cross-room chatter into this
            // agent's context. evt.room==null means a system/global event (presence,
            // roster snapshots, human-originated messages with no room context) — let
            // through. evt.room==ROOM matches. Anything else drops with a log.
            if (evt.room !== undefined && evt.room !== null && evt.room !== ROOM) {
              console.error(
                `[channel] dropped cross-room event: mine=${ROOM} theirs=${evt.room} kind=${evt.kind ?? evt.type ?? "?"}`,
              );
              continue;
            }
            // Ship briefings as regular chat notifications — Claude Code's channel client
            // silently drops unknown kinds. Recognizable prose prefix lets the model match on it.
            if (evt.type === "briefing") {
              const parts: string[] = [
                `[A2AChannel briefing] You are "${AGENT}" in room "${ROOM}".`,
              ];
              if (evt.human_name) parts.push(`The human's name is "${evt.human_name}".`);
              if (evt.peers?.length) {
                const onlinePeers = evt.peers.filter((p) => p.online).map((p) => p.name);
                const offlinePeers = evt.peers.filter((p) => !p.online).map((p) => p.name);
                if (onlinePeers.length) parts.push(`Online peers in your room: ${onlinePeers.join(", ")}.`);
                if (offlinePeers.length) parts.push(`Known but offline peers: ${offlinePeers.join(", ")}.`);
              }
              if (evt.tools?.length) {
                parts.push(`Available chatbridge tools: ${evt.tools.join(", ")}.`);
              }
              if (evt.attachments_dir) {
                parts.push(
                  `Attachments dir: ${evt.attachments_dir}. Incoming files arrive as [attachment: <path>] suffixes you can Read directly.`,
                );
              }
              if (evt.nutshell && evt.nutshell.trim()) {
                parts.push(`Current project summary (nutshell for room "${ROOM}"):\n${evt.nutshell.trim()}`);
              }
              const content = parts.join("\n\n");
              await mcp.notification({
                method: "notifications/claude/channel",
                params: {
                  content,
                  meta: { from: "system", to: AGENT, ts: evt.ts ?? "", room: ROOM },
                },
              });
              continue;
            }
            if (evt.type === "nutshell.updated") {
              const text = evt.text ?? "";
              await mcp.notification({
                method: "notifications/claude/channel",
                params: {
                  content: `[A2AChannel nutshell update]\n${text}`,
                  meta: { from: "system", to: AGENT, ts: evt.ts ?? "" },
                },
              });
              continue;
            }
            const meta: Record<string, string> = {
              from: evt.from ?? "",
              to: evt.to ?? "",
              ts: evt.ts ?? "",
              // Always surface room so claude's reasoning can trust the <channel room=...> attr.
              room: (evt.room ?? ROOM) as string,
            };
            if (evt.kind) {
              meta.kind = evt.kind;
              if (evt.handoff_id) meta.handoff_id = evt.handoff_id;
              if (evt.interrupt_id) meta.interrupt_id = evt.interrupt_id;
              if (evt.permission_id) meta.permission_id = evt.permission_id;
              if (evt.version !== undefined) meta.version = String(evt.version);
              if (evt.expires_at_ms !== undefined) meta.expires_at_ms = String(evt.expires_at_ms);
              if (evt.status) meta.status = evt.status;
              if (evt.replay !== undefined) meta.replay = String(evt.replay);
            }
            await mcp.notification({
              method: "notifications/claude/channel",
              params: {
                content: evt.text ?? "",
                meta,
              },
            });
            // Relay permission verdicts back upstream so claude's local dialog closes.
            // Claude dedupes by request_id, so re-emitting after a local-first answer is safe.
            if (evt.kind === "permission.resolved" && evt.permission_id) {
              const behavior = evt.snapshot?.behavior;
              if (behavior === "allow" || behavior === "deny") {
                try {
                  await mcp.notification({
                    method: "notifications/claude/channel/permission",
                    params: {
                      request_id: evt.permission_id,
                      behavior,
                    },
                  });
                } catch (e) {
                  console.error("[channel] permission verdict upstream failed:", e);
                }
              }
            }
          } catch (e) {
            console.error("[channel] notification failed:", e);
          }
        }
      }
    } catch (e) {
      console.error("[channel] tail error:", (e as Error).message ?? e);
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
}

tailHub();
