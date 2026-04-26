// slash-discovery.js — discovers slash commands available across the agents
// in the currently-selected room. Combines a hardcoded built-in list (claude
// version-bound) with a per-agent filesystem scan via the Tauri command
// `slash_discover_for_agent`. Tier 2 of index.html.
//
// Depends on (declared earlier):
//   from state.js — ROSTER, SELECTED_ROOM, ROOM_ALL, presenceState, tauriInvoke
//
// Exposes:
//   BUILTIN_SLASH_COMMANDS, DESTRUCTIVE_SLASH_COMMANDS,
//   discoverCommandsForAgent, discoverCommandsForRoom,
//   commandUnion, commandAvailability

// Built-in claude-code slash commands. REVIEW ON EACH CLAUDE CODE RELEASE —
// claude adds and renames built-ins between versions, and this list is the
// only source the picker has for commands that don't live on disk. The
// filesystem scan handles custom commands and skills automatically.
const BUILTIN_SLASH_COMMANDS = [
  '/clear',
  '/compact',
  '/context',
  '/usage',
  '/cost',
  '/model',
  '/help',
  '/mcp',
];

// Destructive built-ins that wipe context per agent. The composer requires a
// confirm modal when a command in this set targets more than one agent.
// REVIEW ON EACH CLAUDE CODE RELEASE in lockstep with BUILTIN_SLASH_COMMANDS.
const DESTRUCTIVE_SLASH_COMMANDS = new Set(['/clear', '/compact']);

async function discoverCommandsForAgent(agent) {
  const set = new Set(BUILTIN_SLASH_COMMANDS);
  try {
    const names = await tauriInvoke('slash_discover_for_agent', { agent });
    if (Array.isArray(names)) {
      for (const n of names) set.add('/' + n);
    }
  } catch {
    // Best-effort: if the Tauri call fails (agent not in registry, tmux
    // missing, etc.) we still return the built-ins so the picker is useful.
  }
  return set;
}

async function discoverCommandsForRoom(roomName) {
  // Live = agent has presence AND its tab is in `live` state. Discovery only
  // works for agents whose PTY we own, so external/dead/launching are skipped.
  const inRoom = ROSTER.filter((a) => {
    if (a.room === null) return false;             // human is never an agent
    if (roomName !== ROOM_ALL && a.room !== roomName) return false;
    return !!presenceState[a.name];
  });
  const result = new Map();
  await Promise.all(
    inRoom.map(async (a) => {
      const cmds = await discoverCommandsForAgent(a.name);
      result.set(a.name, cmds);
    })
  );
  return result;
}

function commandUnion(roomMap) {
  const u = new Set();
  for (const set of roomMap.values()) {
    for (const c of set) u.add(c);
  }
  return u;
}

function commandAvailability(commandName, roomMap) {
  const total = roomMap.size;
  let available = 0;
  const missingFrom = [];
  for (const [agent, set] of roomMap.entries()) {
    if (set.has(commandName)) available++;
    else missingFrom.push(agent);
  }
  return { available, total, missingFrom };
}
