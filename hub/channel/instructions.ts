// Builds the MCP `instructions` system prompt from the structured JSON config
// at hub/channel/instructions.json. The JSON is imported statically so Bun
// --compile inlines it into the a2a-bin binary; no runtime file I/O.
//
// Sections join with a blank line. Each section's `body` is either a single
// string or an array (lines joined with newlines — use arrays for bullet lists
// and titled blocks to keep the JSON readable).
//
// Placeholders: {agent} → CHATBRIDGE_AGENT, {room} → CHATBRIDGE_ROOM.
// Add more vars via the `vars` object.

import config from "./instructions.json";

type Section = {
  id: string;
  title?: string;
  body: string | string[];
};

export type InstructionVars = {
  agent: string;
  room: string;
};

function substitute(text: string, vars: InstructionVars): string {
  return text
    .replaceAll("{agent}", vars.agent)
    .replaceAll("{room}", vars.room);
}

export function buildInstructions(vars: InstructionVars): string {
  const parts: string[] = [];
  for (const s of (config.sections as Section[])) {
    const body = Array.isArray(s.body) ? s.body.join("\n") : s.body;
    const rendered = substitute(body, vars);
    if (s.title) {
      parts.push(`${substitute(s.title, vars)}:\n${rendered}`);
    } else {
      parts.push(rendered);
    }
  }
  return parts.join("\n\n");
}
