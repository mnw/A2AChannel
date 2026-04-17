#!/usr/bin/env bun
/**
 * Chatbridge channel — one subprocess per Claude Code session.
 *
 * The hub's roster is dynamic: any agent name connects and registers
 * itself. No startup validation; the post tool accepts a freeform `to`.
 *
 * Env:
 *   CHATBRIDGE_AGENT   this session's identity (required)
 *   CHATBRIDGE_HUB     URL of hub (default http://127.0.0.1:8011)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const AGENT = process.env.CHATBRIDGE_AGENT ?? process.argv[2] ?? "";
const HUB = process.env.CHATBRIDGE_HUB ?? "http://127.0.0.1:8011";

if (!AGENT) {
  console.error("CHATBRIDGE_AGENT env var is required");
  process.exit(1);
}

const mcp = new Server(
  { name: "chatbridge", version: "0.3.0" },
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
      `Keep messages concise; large artifacts belong in files.`,
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

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "post") {
    const { text, to } = req.params.arguments as { text: string; to: string };
    const r = await fetch(`${HUB}/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: AGENT, to, text }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`hub /post failed: ${r.status} ${body}`);
    }
    return { content: [{ type: "text", text: "posted" }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

await mcp.connect(new StdioServerTransport());

const BUF_MAX = 1 << 20;

async function tailHub(): Promise<void> {
  const url = `${HUB}/agent-stream?agent=${encodeURIComponent(AGENT)}`;
  while (true) {
    try {
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
          } catch {
            continue;
          }
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: evt.text,
              meta: { from: evt.from, to: evt.to, ts: evt.ts },
            },
          });
        }
      }
    } catch {
      // fall through to backoff
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
}

tailHub();
