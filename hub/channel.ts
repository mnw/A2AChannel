#!/usr/bin/env bun
/**
 * Chatbridge channel — one subprocess per Claude Code session.
 *
 * Entry point only. The behavior lives in hub/channel/*:
 *   - instructions.json        — structured system prompt (human-editable)
 *   - instructions.ts          — loads + templates the JSON at boot
 *   - tools.ts                 — MCP tool registry: schema + handler paired per tool
 *   - hub-client.ts            — authedPost/authedUpload/resolveHub (token rotation)
 *   - permission-relay.ts      — notifications/claude/channel/permission_request handler
 *   - tail.ts                  — /agent-stream tail + event forwarding + room gate
 *
 * Env:
 *   CHATBRIDGE_AGENT   this session's identity (required)
 *   CHATBRIDGE_ROOM    room label (optional; defaults to "default")
 *   CHATBRIDGE_HUB     pin the hub URL (optional; debug escape hatch)
 *
 * Discovery: ~/Library/Application Support/A2AChannel/hub.url + hub.token
 * (both re-read on each retry so stale values self-heal after app restart).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { buildInstructions } from "./channel/instructions";
import { findTool, listToolsForMcp } from "./channel/tools";
import { PermissionRequestSchema, handlePermissionRequest } from "./channel/permission-relay";
import { tailHub } from "./channel/tail";

const AGENT = process.env.CHATBRIDGE_AGENT ?? process.argv[2] ?? "";
const HUB_ENV = (process.env.CHATBRIDGE_HUB ?? "").trim();
// Room is set at spawn time via the per-agent MCP config env; external-spawn
// agents lacking the env fall back to "default".
const ROOM = (process.env.CHATBRIDGE_ROOM ?? "default").trim() || "default";

if (!AGENT) {
  console.error("CHATBRIDGE_AGENT env var is required");
  process.exit(1);
}

const mcp = new Server(
  { name: "chatbridge", version: "0.9.5" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        // Claude Code 2.1.81+ forwards permission prompts to channels that
        // declare this. Pre-2.1.81 ignores it — feature is additive. Gated on
        // hub bearer-token auth; see CLAUDE.md hard rule.
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: buildInstructions({ agent: AGENT, room: ROOM }),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: listToolsForMcp(),
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = findTool(req.params.name);
  if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  return tool.handler({ agent: AGENT, hubEnv: HUB_ENV }, args);
});

mcp.setNotificationHandler(
  PermissionRequestSchema,
  handlePermissionRequest({ agent: AGENT, hubEnv: HUB_ENV }),
);

// Cold-start mitigation for F9: empirically, notifications sent via
// `notifications/claude/channel` in the first ~10s of a fresh Claude session
// do NOT surface in the agent's context — not just kind-bearing frames, but
// briefings too. The MCP `initialized` handshake fires early (well before
// notifications are routable), so oninitialized alone is insufficient.
// Hard-delaying the SSE tail start until Claude is verifiably warm is the
// pragmatic fix until the Claude Code side grows a "ready for channel frames"
// signal. 10s covers the warm-up observed in T10/T11 cold-starts; re-tune if
// future Claude versions speed this up.
const COLD_START_DELAY_MS = 10_000;

await mcp.connect(new StdioServerTransport());
await new Promise<void>((resolve) => {
  mcp.oninitialized = () => setTimeout(resolve, COLD_START_DELAY_MS);
  // Fallback: if oninitialized never fires (pre-2.x), still wait the full delay.
  setTimeout(resolve, COLD_START_DELAY_MS + 2_000);
});

tailHub({ mcp, agent: AGENT, room: ROOM, hubEnv: HUB_ENV });
