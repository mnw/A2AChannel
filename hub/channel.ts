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
  { name: "chatbridge", version: "0.4.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      `You are "${AGENT}" in a shared chat room. Other participants ` +
      `(the human "you" and any other agents) may or may not be present. ` +
      `Inbound messages arrive as <channel source="chatbridge" from="..." to="..."> ` +
      `with to="${AGENT}" or to="all". Use the "post" tool to send messages. ` +
      `Always set from="${AGENT}". Set to="you" to address the human, ` +
      `to="<name>" to address another agent by name, or to="all" to broadcast. ` +
      `Keep messages concise; large artifacts belong in files. ` +
      `Messages may reference images as [image: <absolute-path>]; ` +
      `use the Read tool on that path to view the image. ` +
      `If Read fails with a permission error, tell the human to add ` +
      `the folder to ~/.claude/settings.json ` +
      `(permissions.additionalDirectories) or relaunch Claude Code ` +
      `with --add-dir <folder>.`,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "post",
      description: "Post a message to the shared chat room.",
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
  ],
}));

async function postMessage(
  hub: HubInfo,
  body: string,
): Promise<Response> {
  return fetch(`${hub.url}/post`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${hub.token}`,
    },
    body,
  });
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "post") {
    const { text, to } = req.params.arguments as { text: string; to: string };
    let hub = resolveHub();
    if (!hub) {
      throw new Error(
        `hub not found (need ${URL_PATH} and ${TOKEN_PATH}, or CHATBRIDGE_HUB env)`,
      );
    }
    const body = JSON.stringify({ from: AGENT, to, text });
    let r = await postMessage(hub, body);
    // If the token was rotated (app restart), re-read once and retry.
    if (r.status === 401) {
      const refreshed = resolveHub();
      if (refreshed && refreshed.token !== hub.token) {
        hub = refreshed;
        r = await postMessage(hub, body);
      }
    }
    if (!r.ok) {
      const errBody = await r.text();
      throw new Error(`hub /post failed: ${r.status} ${errBody}`);
    }
    return { content: [{ type: "text", text: "posted" }] };
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
      const url = `${hub.url}/agent-stream?agent=${encodeURIComponent(AGENT)}`;
      const r = await fetch(url);
      if (!r.ok || !r.body) {
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
          let evt: { from: string; to: string; text: string; ts: string };
          try {
            evt = JSON.parse(dataLine.slice(6));
          } catch (e) {
            console.error("[channel] SSE JSON parse failed:", e);
            continue;
          }
          try {
            await mcp.notification({
              method: "notifications/claude/channel",
              params: {
                content: evt.text,
                meta: { from: evt.from, to: evt.to, ts: evt.ts },
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
