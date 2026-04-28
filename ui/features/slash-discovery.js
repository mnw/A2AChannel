// slash-discovery.js — built-in slash list + per-agent filesystem scan via Tauri.

// REVIEW ON EACH CLAUDE CODE RELEASE — built-ins drift between versions; this is the only source.
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

// Wipes context per agent; composer asks confirm when targeting >1 agent. Review per Claude Code release.
const DESTRUCTIVE_SLASH_COMMANDS = new Set(['/clear', '/compact']);

async function discoverCommandsForAgent(agent) {
  const map = new Map(BUILTIN_SLASH_COMMANDS);
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
    // Best-effort: built-ins still returned on Tauri-call failure.
  }
  return map;
}

async function discoverCommandsForRoom(roomName) {
  // Discovery requires PTY ownership; external/dead/launching skipped.
  const inRoom = ROSTER.filter((a) => {
    if (a.room === null) return false;
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

// Description from the first agent supplying a non-empty one (built-ins always win).
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
