// Pi runtime adapter — the chatbridge as a pi.dev extension.
//
// Same role as channel.ts (the MCP sidecar) for the other runtime: it registers
// the chatbridge tools and tails /agent-stream into the agent's context. Pi has
// no MCP support by design, so tools are registered in-process instead.
//
// Tool definitions are NOT duplicated: this imports the same CHATBRIDGE_TOOLS
// registry and hub-client that channel.ts uses. Only the transport differs.
//
// Shipped as a bundled single file (resources/pi-extension.js, built by
// scripts/build-sidecars.sh) and loaded via `pi -e <path>`; pty.rs passes
// CHATBRIDGE_AGENT / CHATBRIDGE_ROOM as env on the tmux session.

import { CHATBRIDGE_TOOLS } from "./tools";
import { buildInstructions } from "./instructions";
import { resolveHub, URL_PATH, TOKEN_PATH } from "./hub-client";

const AGENT = (process.env.CHATBRIDGE_AGENT ?? "").trim();
const ROOM = (process.env.CHATBRIDGE_ROOM ?? "default").trim() || "default";
const HUB_ENV = (process.env.CHATBRIDGE_HUB ?? "").trim();
const BUF_MAX = 1 << 20;
const RETRY_MS = 2000;

type ChannelEvent = {
  type?: string; from?: string; to?: string; text?: string; ts?: string;
  room?: string | null; kind?: string; replay?: boolean;
  handoff_id?: string; interrupt_id?: string; permission_id?: string;
  version?: number; status?: string; expires_at_ms?: number;
  nutshell?: string | null; human_name?: string; attachments_dir?: string;
  tools?: string[]; peers?: Array<{ name: string; online: boolean }>;
};

// Pi's delivery modes let each kind say how urgently it wants the agent's
// attention — the MCP channel has one undifferentiated notification instead.
// sendUserMessage ALWAYS triggers a turn; deliverAs only applies mid-stream.
function deliveryFor(evt: ChannelEvent): "steer" | "followUp" {
  return evt.kind === "interrupt.new" ? "steer" : "followUp";
}

function renderMeta(evt: ChannelEvent): string {
  const bits: string[] = [];
  if (evt.kind) bits.push(evt.kind);
  if (evt.from) bits.push(`from ${evt.from}`);
  for (const id of [evt.handoff_id, evt.interrupt_id, evt.permission_id]) {
    if (id) bits.push(id);
  }
  if (evt.status) bits.push(evt.status);
  if (evt.replay) bits.push("catchup");
  return bits.length ? `[${bits.join(" · ")}]\n` : "";
}

// ponytail: briefing prose is written here rather than shared with tail.ts, to
// keep this change off the working MCP path. If the two ever drift in content
// (not just delivery), extract a formatter from tail.ts and import it in both.
function renderBriefing(evt: ChannelEvent): string {
  const parts = [`[A2AChannel briefing] You are "${AGENT}" in room "${ROOM}".`];
  if (evt.human_name) parts.push(`The human's name is "${evt.human_name}".`);
  const online = (evt.peers ?? []).filter((p) => p.online).map((p) => p.name);
  const offline = (evt.peers ?? []).filter((p) => !p.online).map((p) => p.name);
  if (online.length) parts.push(`Online peers in your room: ${online.join(", ")}.`);
  if (offline.length) parts.push(`Known but offline peers: ${offline.join(", ")}.`);
  if (evt.tools?.length) parts.push(`Available chatbridge tools: ${evt.tools.join(", ")}.`);
  if (evt.attachments_dir) {
    parts.push(
      `Attachments dir: ${evt.attachments_dir}. Incoming files arrive as [attachment: <path>] suffixes you can Read directly.`,
    );
  }
  if (evt.nutshell?.trim()) {
    parts.push(`Current project summary (nutshell for room "${ROOM}"):\n${evt.nutshell.trim()}`);
  }
  return parts.join("\n\n");
}

async function handleEvent(pi: any, evt: ChannelEvent): Promise<void> {
  // Defense-in-depth room gate, mirroring tail.ts: a routing regression must
  // surface as drop-log noise, not silent context pollution.
  if (evt.room !== undefined && evt.room !== null && evt.room !== ROOM) {
    console.error(
      `[channel] dropped cross-room event: mine=${ROOM} theirs=${evt.room} kind=${evt.kind ?? evt.type ?? "?"}`,
    );
    return;
  }

  // Briefing and nutshell are context, not requests — deliver without waking the
  // agent. The MCP channel cannot express this distinction.
  if (evt.type === "briefing" || evt.type === "nutshell.updated") {
    const content =
      evt.type === "briefing"
        ? renderBriefing(evt)
        : `[A2AChannel nutshell update]\n${evt.text ?? ""}`;
    await pi.sendMessage(
      {
        customType: `chatbridge.${evt.type}`,
        content,
        display: evt.type === "briefing" ? "Briefing" : "Nutshell",
        details: null,
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    return;
  }

  await pi.sendUserMessage(renderMeta(evt) + (evt.text ?? ""), {
    deliverAs: deliveryFor(evt),
  });
}

async function tail(pi: any, signal: AbortSignal): Promise<void> {
  let loggedMissingOnce = false;
  while (!signal.aborted) {
    const hub = resolveHub(HUB_ENV);
    if (!hub) {
      if (!loggedMissingOnce) {
        console.error(
          `[channel] hub not found; waiting for A2AChannel.app (expects ${URL_PATH} and ${TOKEN_PATH})`,
        );
        loggedMissingOnce = true;
      }
      await new Promise((s) => setTimeout(s, RETRY_MS));
      continue;
    }
    loggedMissingOnce = false;
    try {
      // ?token= because EventSource-shaped reads can't set headers; never log this URL.
      const url =
        `${hub.url}/agent-stream` +
        `?agent=${encodeURIComponent(AGENT)}` +
        `&room=${encodeURIComponent(ROOM)}` +
        `&token=${encodeURIComponent(hub.token)}`;
      const r = await fetch(url, { signal });
      if (!r.ok || !r.body) {
        // 401 → next iteration re-reads discovery files and picks up a rotated token.
        await new Promise((s) => setTimeout(s, RETRY_MS));
        continue;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.length > BUF_MAX) buf = buf.slice(-BUF_MAX);
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          let evt: ChannelEvent;
          try {
            evt = JSON.parse(dataLine.slice(6));
          } catch (e) {
            console.error("[channel] SSE JSON parse failed:", e);
            continue;
          }
          try {
            await handleEvent(pi, evt);
          } catch (e) {
            console.error("[channel] delivery failed:", e);
          }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      console.error("[channel] tail error:", (e as Error).message ?? e);
    }
    await new Promise((s) => setTimeout(s, RETRY_MS));
  }
}

function firstSentence(text: string): string {
  const cut = text.indexOf(". ");
  return (cut === -1 ? text : text.slice(0, cut + 1)).trim();
}

// The one behaviour a channel agent must not get wrong: terminal output is
// private. Only `post` is visible to the room.
const POST_GUIDELINES = [
  "Your terminal output is visible to NOBODY. Writing a reply as ordinary prose does not communicate it — the room never sees it.",
  "To say anything to the human or another agent you MUST call the `post` tool. Narrating that you have posted is not posting.",
  "Reply via `post` whenever a message is addressed to you, even to acknowledge or decline.",
];

export default function (pi: any): void {
  if (!AGENT) {
    console.error("[channel] CHATBRIDGE_AGENT not set — chatbridge inactive");
    return;
  }

  for (const t of CHATBRIDGE_TOOLS) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: t.description,
      // Without promptSnippet pi OMITS custom tools from the system prompt's
      // "Available tools" section entirely — the model then has no standing
      // reason to reach for them. First sentence of the description is enough.
      promptSnippet: `${t.name} — ${firstSentence(t.description)}`,
      promptGuidelines: t.name === "post" ? POST_GUIDELINES : undefined,
      // Pi accepts the same JSON Schema the MCP path advertises — no conversion.
      parameters: t.inputSchema,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const r = await t.handler({ agent: AGENT, hubEnv: HUB_ENV }, params ?? {});
        return { content: r.content, details: null };
      },
    });
  }

  // Pi's docs name session_start/session_shutdown as the place for background
  // resources; a reload fires session_start again, so abort the previous tail.
  // MCP passes `instructions` to the Server constructor; pi's equivalent is to
  // append to the rendered system prompt each turn. Same source of truth
  // (instructions.json) so the two harnesses cannot drift.
  const CHANNEL_INSTRUCTIONS = buildInstructions({ agent: AGENT, room: ROOM });
  pi.on("before_agent_start", (event: { systemPrompt: string }) => ({
    systemPrompt: `${event.systemPrompt}\n\n${CHANNEL_INSTRUCTIONS}`,
  }));

  let ac: AbortController | null = null;
  pi.on("session_start", () => {
    ac?.abort();
    ac = new AbortController();
    void tail(pi, ac.signal);
  });
  pi.on("session_shutdown", () => {
    ac?.abort();
    ac = null;
  });
}
