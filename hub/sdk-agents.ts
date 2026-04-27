// SDK-pivot orchestrator. Manages the parallel "sdk agent" type that runs
// chat turns via the Anthropic Agent SDK in-process, instead of via the
// tmux+claude+channel-bin sidecar model.
//
// Coexistence: this module lives alongside the existing tmux/channel-bin
// path. Agents registered here are the "sdk" type; they share the same
// AgentRegistry (so they appear in the roster and rooms) but their queues
// are never tailed by a sidecar — chat dispatch routes through
// dispatchToSdkAgent() instead of enqueueTo().
//
// Spike scope (intentionally minimal):
//   - eager-init at registration: a one-time briefing query seeds the
//     session file so sessionId is captured before the first user turn
//   - per-turn subprocess spawn (no startup() warmup yet)
//   - serialized queues per agent (one turn at a time; subsequent inputs
//     wait their turn, no overlap)
//   - in-process MCP tools for handoff/interrupt (created per query;
//     reuses the existing kind state machines via direct function calls)
//   - permissions in spike v1: bypassPermissions mode for read-only tools
//     and Bash; canUseTool integration with permission cards lands later
//   - assistant text → chat as an Entry from the agent's name
//   - tool_use blocks → small system note in chat (transparency)
//
// Out of spike scope (revisit when validated):
//   - startup() warm subprocess to avoid per-turn cold start
//   - canUseTool wired to permission cards
//   - Streaming token-by-token (currently per-turn buffered)
//   - sdk-agent removal cleans up running queries
//   - cross-agent @mention parsing in assistant text → handoffs

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Database } from "bun:sqlite";

import type { Entry } from "./core/types";
import type { AgentRegistry } from "./core/agents";
import { ts } from "./core/ids";
import {
  createHandoff,
  snapshotHandoff,
  handoffEntry,
} from "./kinds/handoff";

export type SdkAgent = {
  name: string;
  room: string;
  cwd: string;
  sessionId?: string;
  busy: boolean;
  pending: Array<{ prompt: string }>;
};

export type SdkOrchestratorDeps = {
  db: Database;
  agents: AgentRegistry;
  // How chat messages from this orchestrator land in the chat log + UI.
  broadcastUI: (entry: Entry) => void;
  agentEntry: (entry: Entry) => Entry;
  // Resolved claude binary path (from config.yml claude_path or default).
  claudePath: string;
  // Optional: ANTHROPIC_API_KEY for SDK billing in API-key mode. When unset,
  // the SDK falls back to whatever auth the bundled/configured claude
  // binary picks up on disk (Max subscription token, etc.).
  anthropicApiKey?: string;
};

const SDK_AGENT_TYPE = "sdk" as const;
const sdkAgents = new Map<string, SdkAgent>();

export function isSdkAgent(name: string): boolean {
  return sdkAgents.has(name);
}

export function listSdkAgents(): SdkAgent[] {
  return [...sdkAgents.values()];
}

export function getSdkAgent(name: string): SdkAgent | undefined {
  return sdkAgents.get(name);
}

// Register a new sdk-agent. Side effect: also calls into the shared
// AgentRegistry so the agent appears in the roster + presence broadcasts.
// Marked permanent so the stale-removal timer doesn't reap it (it has no
// SSE connection counter to keep alive).
export function registerSdkAgent(
  opts: { name: string; room: string; cwd: string },
  deps: SdkOrchestratorDeps,
): SdkAgent {
  if (sdkAgents.has(opts.name)) {
    throw new Error(`sdk-agent already exists: ${opts.name}`);
  }
  const ensured = deps.agents.ensure(opts.name, opts.room);
  if (!ensured) {
    throw new Error(`invalid agent name: ${opts.name}`);
  }
  // SDK agents never connect via SSE; mark permanent so the stale timer
  // (which fires when SSE connections drop to 0) doesn't reap them.
  deps.agents.markPermanent(opts.name);
  const agent: SdkAgent = {
    name: opts.name,
    room: opts.room,
    cwd: opts.cwd,
    busy: false,
    pending: [],
  };
  sdkAgents.set(opts.name, agent);
  console.log(`[sdk] agent registered: ${opts.name} cwd=${opts.cwd} room=${opts.room}`);
  return agent;
}

export function unregisterSdkAgent(name: string, deps: SdkOrchestratorDeps): boolean {
  const agent = sdkAgents.get(name);
  if (!agent) return false;
  sdkAgents.delete(name);
  deps.agents.remove(name, "sdk-agent unregistered");
  console.log(`[sdk] agent unregistered: ${name}`);
  return true;
}

// Dispatch a chat message to an sdk-agent. Serialized: if the agent is
// already running a turn, queue the prompt and return immediately. The
// in-flight turn drains the queue when it completes.
export async function dispatchToSdkAgent(
  name: string,
  prompt: string,
  deps: SdkOrchestratorDeps,
): Promise<void> {
  const agent = sdkAgents.get(name);
  if (!agent) throw new Error(`unknown sdk-agent: ${name}`);
  if (agent.busy) {
    agent.pending.push({ prompt });
    console.log(`[sdk] ${name} busy, queued (${agent.pending.length} pending)`);
    return;
  }
  // Fire-and-forget — the caller (chat handler) returns 200 immediately;
  // assistant messages stream back as chat entries.
  runOneTurn(agent, prompt, deps).catch((err) => {
    console.error(`[sdk] turn failed for ${name}:`, err);
    deps.broadcastUI({
      from: "system",
      to: "you",
      text: `[sdk-agent ${name}] turn failed: ${err?.message ?? err}`,
      ts: ts(),
      room: agent.room,
    });
  });
}

async function runOneTurn(
  agent: SdkAgent,
  prompt: string,
  deps: SdkOrchestratorDeps,
): Promise<void> {
  agent.busy = true;
  try {
    const tools = createA2aTools(agent, deps);
    const env: Record<string, string | undefined> = {
      ...process.env,
      CHATBRIDGE_AGENT: agent.name,
      CHATBRIDGE_ROOM: agent.room,
    };
    if (deps.anthropicApiKey) {
      env.ANTHROPIC_API_KEY = deps.anthropicApiKey;
    }

    const queryOpts: Parameters<typeof query>[0]["options"] = {
      cwd: agent.cwd,
      env,
      mcpServers: { "a2a-tools": tools },
      // Spike v1: bypassPermissions to keep the loop simple. Wire to UI
      // permission cards via canUseTool callback in a follow-up.
      permissionMode: "bypassPermissions",
      pathToClaudeCodeExecutable: deps.claudePath,
      ...(agent.sessionId ? { resume: agent.sessionId } : {}),
    };

    for await (const msg of query({ prompt, options: queryOpts })) {
      handleSdkMessage(agent, msg, deps);
    }
  } finally {
    agent.busy = false;
    const next = agent.pending.shift();
    if (next) {
      // Drain the next queued turn. Recurse — no await so the current
      // promise can resolve.
      runOneTurn(agent, next.prompt, deps).catch((err) => {
        console.error(`[sdk] queued turn failed for ${agent.name}:`, err);
      });
    }
  }
}

function handleSdkMessage(
  agent: SdkAgent,
  msg: unknown,
  deps: SdkOrchestratorDeps,
): void {
  const m = msg as Record<string, unknown>;
  const type = m?.type as string | undefined;
  if (type === "system") {
    const subtype = m.subtype as string | undefined;
    if (subtype === "init") {
      const sid = m.session_id as string | undefined;
      if (sid && !agent.sessionId) {
        agent.sessionId = sid;
        console.log(`[sdk] ${agent.name} sessionId captured: ${sid}`);
      }
    }
    return;
  }
  if (type === "assistant") {
    const message = m.message as { content?: Array<Record<string, unknown>> } | undefined;
    const content = message?.content ?? [];
    for (const block of content) {
      const btype = block.type as string | undefined;
      if (btype === "text") {
        const text = block.text as string | undefined;
        if (text && text.trim()) {
          deps.broadcastUI({
            from: agent.name,
            to: "you",
            text,
            ts: ts(),
            room: agent.room,
          });
        }
      } else if (btype === "tool_use") {
        const toolName = block.name as string | undefined;
        if (toolName) {
          deps.broadcastUI({
            from: "system",
            to: "you",
            text: `${agent.name} → ${toolName}`,
            ts: ts(),
            room: agent.room,
          });
        }
      }
    }
    return;
  }
  // result, user (tool result echoes), and others — ignored for spike v1.
}

// In-process MCP server exposing the cross-agent action primitives. Each
// tool is a thin wrapper around the existing kind module's state machine
// — no HTTP roundtrip, no separate process.
//
// Note: `post` is intentionally NOT here. In SDK mode every assistant text
// block is a chat post by definition (we forward it via broadcastUI),
// removing the need for an explicit tool. Agent-to-agent free-text is
// reachable via send_handoff (structured) or by the orchestrator parsing
// @mentions out of assistant text in a follow-up.
function createA2aTools(agent: SdkAgent, deps: SdkOrchestratorDeps) {
  return createSdkMcpServer({
    name: "a2a-tools",
    version: "1.0.0",
    tools: [
      tool(
        "send_handoff",
        "Hand off a unit of work to another agent in the room. Recipient accepts or declines; declines require a reason.",
        {
          to: z.string(),
          task: z.string(),
          context: z.any().optional(),
          ttl_seconds: z.number().optional(),
        },
        async (args) => {
          const snapshot = createHandoff(deps.db, {
            from: agent.name,
            to: args.to,
            task: args.task,
            context: args.context ?? null,
            ttl_seconds: args.ttl_seconds ?? 3600,
            room: agent.room,
          });
          const entry = handoffEntry(snapshot, "handoff.new");
          deps.broadcastUI(entry);
          return {
            content: [
              {
                type: "text",
                text: `Handoff created: ${snapshot.id} (status: ${snapshot.status})`,
              },
            ],
          };
        },
      ),
    ],
  });
}
