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

// Built-in claude-code slash commands with one-line descriptions. REVIEW ON
// EACH CLAUDE CODE RELEASE — claude adds and renames built-ins between
// versions, and this Map is the only source the picker has for commands
// that don't live on disk. The filesystem scan handles custom commands
// and skills automatically.
const BUILTIN_SLASH_COMMANDS = new Map([
  ['/add-dir',           'Add a working directory the agent is allowed to read'],
  ['/advisor',           'Open advisor mode for guided decisions'],
  ['/agents',            'List, create, or edit subagents'],
  ['/bug',               'File a bug report against Claude Code'],
  ['/clear',             'Wipe the conversation context (irreversible)'],
  ['/compact',           'Summarize older messages to free context'],
  ['/context',           'Show current context size + token budget'],
  ['/cost',              'Show estimated cost of the current session'],
  ['/doctor',            'Diagnose Claude Code installation health'],
  ['/editor',            'Open the configured editor at the current cwd'],
  ['/export',            'Export the current session transcript'],
  ['/help',              'List available slash commands'],
  ['/hooks',             'Manage hooks (PreToolUse, PostToolUse, …)'],
  ['/init',              'Create a CLAUDE.md from the current project'],
  ['/login',             'Sign in to Anthropic'],
  ['/logout',            'Sign out of Anthropic'],
  ['/mcp',               'List or invoke MCP servers'],
  ['/memory',            'View or edit the agent\'s memory file'],
  ['/model',             'Switch the active claude model'],
  ['/permissions',       'Manage tool-use permissions for this session'],
  ['/privacy',           'Privacy settings + telemetry controls'],
  ['/release-notes',     'Show release notes for the installed claude version'],
  ['/resume',            'Resume a prior session'],
  ['/review',            'Review a pull request'],
  ['/security-review',   'Run a security review of pending changes'],
  ['/settings',          'Open the settings panel'],
  ['/status',            'Show session status (model, tokens, mode)'],
  ['/terminal-setup',    'Configure terminal integration'],
  ['/usage',             'Show 5-hour and weekly usage stats'],
  ['/vim',               'Toggle vim editing mode in the input'],
]);

// Destructive built-ins that wipe context per agent. The composer requires a
// confirm modal when a command in this set targets more than one agent.
// REVIEW ON EACH CLAUDE CODE RELEASE in lockstep with BUILTIN_SLASH_COMMANDS.
const DESTRUCTIVE_SLASH_COMMANDS = new Set(['/clear', '/compact']);

// Returns Map<command, description|''>. Built-ins seed the map with their
// hardcoded descriptions; the filesystem scan adds custom commands/skills
// with descriptions parsed from .md frontmatter (when present).
async function discoverCommandsForAgent(agent) {
  const map = new Map(BUILTIN_SLASH_COMMANDS);  // clone so callers don't mutate
  try {
    const items = await tauriInvoke('slash_discover_for_agent', { agent });
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item === 'string') {
          map.set('/' + item, '');
        } else if (item && typeof item.name === 'string') {
          map.set('/' + item.name, item.description || '');
        }
      }
    }
  } catch {
    // Best-effort: if the Tauri call fails (agent not in registry, tmux
    // missing, etc.) we still return the built-ins so the picker is useful.
  }
  return map;
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

// Union returns a Map<command, description> across all agents. Description
// is taken from the first agent that supplies a non-empty one (built-ins
// always win since they're seeded first per agent).
function commandUnion(roomMap) {
  const u = new Map();
  for (const cmds of roomMap.values()) {
    for (const [cmd, desc] of cmds.entries()) {
      const prev = u.get(cmd);
      if (prev === undefined || (!prev && desc)) u.set(cmd, desc || '');
    }
  }
  return u;
}

function commandAvailability(commandName, roomMap) {
  const total = roomMap.size;
  let available = 0;
  const missingFrom = [];
  for (const [agent, cmds] of roomMap.entries()) {
    if (cmds.has(commandName)) available++;
    else missingFrom.push(agent);
  }
  return { available, total, missingFrom };
}
