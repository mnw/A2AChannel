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
} from "@modelcontextprotocol/sdk/types.js";

const AGENT = process.env.CHATBRIDGE_AGENT ?? process.argv[2] ?? "";
let lastRoom = "general";
const HUB_ENV = (process.env.CHATBRIDGE_HUB ?? "").trim();
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

// Resolve both hub URL and auth token. An explicit CHATBRIDGE_HUB env
// pins the URL (escape hatch for debugging); the token always comes
// from disk. Returns null if any required piece is missing so the
// outer loop retries.
function resolveHub(): HubInfo | null {
  const url = HUB_ENV || readTrimmed(URL_PATH);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = readTrimmed(TOKEN_PATH);
  if (!token) return null;
  return { url, token };
}

const mcp = new Server(
  { name: "chatbridge", version: "0.5.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      `You are "${AGENT}" in a shared chat room. Other participants ` +
      `(the human and any other agents) may or may not be present. ` +
      `Inbound messages arrive as <channel source="chatbridge" from="..." to="..."> ` +
      `with to="${AGENT}" or to="all".\n\n` +
      `Use "post" for free-text conversation: set from="${AGENT}", ` +
      `to="you" to address the human, to="<name>" for a peer, or to="all" to broadcast. ` +
      `Messages are scoped to rooms — you only receive messages from rooms you belong to. ` +
      `The room is auto-tracked from inbound messages, but you can override it with the room parameter.\n\n` +
      `Use the structured-handoff tools when you're transferring bounded work ` +
      `to another participant:\n` +
      `- "send_handoff": hand a task to another participant. Returns a handoff_id.\n` +
      `- "accept_handoff": confirm you've taken a pending handoff addressed to you.\n` +
      `- "decline_handoff": refuse a pending handoff addressed to you. A reason is required.\n` +
      `- "cancel_handoff": withdraw a pending handoff you created (or that the human created).\n\n` +
      `Handoff events arrive as <channel kind="handoff.new" ...> or <channel kind="handoff.update" ...> ` +
      `with the handoff snapshot in the body. The meta attribute replay="true" means the event is ` +
      `a reconnect catch-up, not new news.\n\n` +
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
          room: {
            type: "string",
            description:
              'Room to post in. Defaults to "general". Use a room id from the hub.',
          },
        },
        required: ["text", "to"],
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
  ],
}));

// Auth'd POST helper with automatic token-rotation retry on 401.
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
    const room = args.room ? String(args.room) : lastRoom;
    const body: Record<string, unknown> = { from: AGENT, to, text, room };
    const resp = await authedPost("/post", body);
    if (resp.status < 200 || resp.status >= 300) toolError(resp, "post");
    return { content: [{ type: "text", text: "posted" }] };
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

  throw new Error(`unknown tool: ${req.params.name}`);
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
      // /agent-stream now requires auth. Authorization header would work
      // here (we're using fetch, not EventSource), but pass the token via
      // ?token= for symmetry with the UI and so server access logs see
      // the same shape from every reader.
      const url =
        `${hub.url}/agent-stream` +
        `?agent=${encodeURIComponent(AGENT)}` +
        `&token=${encodeURIComponent(hub.token)}`;
      const r = await fetch(url);
      if (!r.ok || !r.body) {
        // 401 here means our cached token is stale (app restarted, new
        // token minted). The next loop iteration re-reads the discovery
        // file and picks up the rotated value.
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
            from: string;
            to: string;
            text: string;
            ts: string;
            room?: string;
            kind?: string;
            handoff_id?: string;
            version?: number;
            expires_at_ms?: number;
            status?: string;
            replay?: boolean;
          };
          try {
            evt = JSON.parse(dataLine.slice(6));
          } catch (e) {
            console.error("[channel] SSE JSON parse failed:", e);
            continue;
          }
          try {
            const meta: Record<string, string> = {
              from: evt.from,
              to: evt.to,
              ts: evt.ts,
            };
            if (evt.room) {
              meta.room = evt.room;
              lastRoom = evt.room;
            }
            if (evt.kind) {
              // Forward structured events with their protocol metadata as channel attributes.
              meta.kind = evt.kind;
              if (evt.handoff_id) meta.handoff_id = evt.handoff_id;
              if (evt.version !== undefined) meta.version = String(evt.version);
              if (evt.expires_at_ms !== undefined) meta.expires_at_ms = String(evt.expires_at_ms);
              if (evt.status) meta.status = evt.status;
              if (evt.replay !== undefined) meta.replay = String(evt.replay);
            }
            await mcp.notification({
              method: "notifications/claude/channel",
              params: {
                content: evt.text,
                meta,
              },
            });
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
