// ID minting + validation helpers. Pure functions, no state.

// Agent + room name charset: alphanumeric plus _, ., -, space (space cannot be
// leading/trailing, ≤64 chars). The regex covers both the single-char case and
// the multi-char case where internal spaces are allowed.
export const AGENT_NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;

// Reserved agent names — routing keywords that must not collide with a real agent.
export const RESERVED_NAMES = new Set(["you", "all", "system"]);

export function randomId(bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function mintHandoffId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "h_";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

export function mintInterruptId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "i_";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

// `HH:MM:SS` wall-clock, used for SSE entry `ts` fields.
export function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function colorFromName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 70%, 75%)`;
}

export function validName(name: string): boolean {
  return (
    !!name &&
    AGENT_NAME_RE.test(name) &&
    !RESERVED_NAMES.has(name.toLowerCase())
  );
}

// Room labels follow the same charset + length rules as agent names but are NOT
// limited by the reserved-name blocklist (reserved names are agent-side).
export function validRoomLabel(room: string): boolean {
  return !!room && AGENT_NAME_RE.test(room);
}
