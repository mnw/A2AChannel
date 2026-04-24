// Free-text chat routes — /send (human → agents) and /post (agent → anyone).
// Not a kind: no ledger persistence beyond the in-memory chatLog, no lifecycle,
// no replay. The only truly non-kind message surface the hub owns.

import { json } from "./core/auth";
import { ts, validRoomLabel } from "./core/ids";
import type { Entry } from "./core/types";
import type { AgentRegistry } from "./core/agents";
import { IMAGE_URL_RE } from "./core/attachments";

export type ChatDeps = {
  agents: AgentRegistry;
  broadcastUI: (entry: Entry) => void;
  agentEntry: (entry: Entry) => Entry;
  enqueueTo: (name: string, entry: Entry) => void;
};

export async function handleSend(req: Request, deps: ChatDeps): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    text?: string;
    image?: string | null;
    target?: string;
    targets?: string[];
    // Human's UI-selected room. Required when `target`/`targets` includes "all"
    // (otherwise "all" is ambiguous — every room, or the current view?). For
    // explicit peer targets the field is ignored.
    room?: string;
  };
  const text = (body.text ?? "").trim();
  const image = body.image || null;
  if (!text && !image) return json({ error: "empty" }, { status: 400 });
  if (image && !IMAGE_URL_RE.test(image)) {
    return json({ error: "invalid image url" }, { status: 400 });
  }

  const { knownAgents } = deps.agents;
  const scopeRoom = body.room && validRoomLabel(body.room) ? body.room : null;
  const agentsInRoom = (room: string): string[] =>
    [...knownAgents.values()].filter((a) => a.room === room).map((a) => a.name);

  let targets: string[];
  let broadcast = false;

  if (Array.isArray(body.targets) && body.targets.length) {
    for (const t of body.targets) {
      if (t === "all") continue;
      if (!knownAgents.has(t)) {
        return json({ error: `unknown target: ${t}` }, { status: 400 });
      }
    }
    const resolved: string[] = [];
    for (const t of body.targets) {
      if (t === "all") {
        if (!scopeRoom) {
          return json({ error: "room required when targets include 'all'" }, { status: 400 });
        }
        for (const name of agentsInRoom(scopeRoom)) {
          if (!resolved.includes(name)) resolved.push(name);
        }
        broadcast = true;
        break;
      }
      if (!resolved.includes(t)) resolved.push(t);
    }
    targets = resolved;
  } else if (!body.target || body.target === "all") {
    if (!scopeRoom) {
      return json({ error: "room required for broadcast to 'all'" }, { status: 400 });
    }
    targets = agentsInRoom(scopeRoom);
    broadcast = true;
  } else if (knownAgents.has(body.target)) {
    targets = [body.target];
  } else {
    return json({ error: `unknown target: ${body.target}` }, { status: 400 });
  }

  if (!targets.length && !broadcast) {
    return json({ error: "no targets" }, { status: 400 });
  }

  const toLabel = broadcast
    ? "all"
    : targets.length === 1
      ? targets[0]
      : targets.join(",");

  const entryRoom =
    scopeRoom ??
    (targets.length === 1 ? knownAgents.get(targets[0])?.room ?? null : null);

  const entry: Entry = {
    from: "you",
    to: toLabel,
    text,
    image,
    ts: ts(),
    room: entryRoom,
  };
  deps.broadcastUI(entry);
  const view = deps.agentEntry(entry);
  for (const t of targets) deps.enqueueTo(t, view);
  return json({ ok: true });
}

export async function handlePost(req: Request, deps: ChatDeps): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    from?: string;
    to?: string;
    text?: string;
    image?: string | null;
  };
  const frm = body.from;
  const rawTo = body.to ?? "you";
  const reserved = rawTo.toLowerCase();
  const text = (body.text ?? "").trim();
  const image = body.image || null;
  if (!frm || (!text && !image)) {
    return json({ error: "bad request" }, { status: 400 });
  }
  if (image && !IMAGE_URL_RE.test(image)) {
    return json({ error: "invalid image url" }, { status: 400 });
  }
  if (!deps.agents.ensure(frm)) {
    return json({ error: `invalid from: ${frm}` }, { status: 400 });
  }
  const sender = deps.agents.knownAgents.get(frm)!;
  const senderRoom = sender.room;  // null = human super-user (rare for /post but possible)

  let targets: string[];
  if (reserved === "you") {
    targets = [];
  } else if (reserved === "all") {
    // Broadcast from an agent scopes to its own room. Human reads via /stream.
    targets = [...deps.agents.knownAgents.values()]
      .filter((a) => a.name !== frm && !deps.agents.permanentAgents.has(a.name))
      .filter((a) => senderRoom === null || a.room === senderRoom)
      .map((a) => a.name);
  } else if (deps.agents.knownAgents.has(rawTo)) {
    targets = [rawTo];
  } else {
    return json({ error: `unknown to: ${rawTo}` }, { status: 400 });
  }

  const entry: Entry = {
    from: frm,
    to: rawTo,
    text,
    image,
    ts: ts(),
    room: senderRoom,
  };
  deps.broadcastUI(entry);
  const view = deps.agentEntry(entry);
  for (const t of targets) deps.enqueueTo(t, view);
  return json({ ok: true });
}
