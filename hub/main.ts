#!/usr/bin/env bun
/**
 * Unified A2AChannel sidecar. One binary, two modes.
 *
 *   A2A_MODE=hub      → start the HTTP/SSE hub (listens on PORT env)
 *   A2A_MODE=channel  → run as MCP channel (stdio; reads CHATBRIDGE_AGENT etc.)
 *
 * The Rust shell sets A2A_MODE=hub when spawning the hub sidecar.
 * The generated .mcp.json sets A2A_MODE=channel for Claude Code.
 */

const mode = process.env.A2A_MODE ?? "";

if (mode === "hub") {
  await import("./hub.ts");
} else if (mode === "channel") {
  await import("./channel.ts");
} else {
  console.error(
    `a2a-bin: unknown mode ${JSON.stringify(mode)} — set A2A_MODE=hub or A2A_MODE=channel`,
  );
  process.exit(1);
}
