// redaction.ts — content-stripping primitive for sinks that persist or summarise
// chat entries. Today's only call site is `transcript.appendEntry` (Phase 2 of
// the room-memory work); Phase 3's semantic summariser will be the second
// caller. Centralising the parse rules here means the `<private>` syntax is
// defined in one place and both sinks behave consistently.
//
// Convention:
//   <private>...</private>   case-sensitive open + close tag pair
//   stripped from `entry.text` before persistence
//   in-memory chatLog and live SSE delivery are NOT redacted — agents and
//   the human see the private content during the session; only on-disk
//   storage and downstream summaries omit it.
//
// Edge cases (resolved deliberately):
//   - Unclosed `<private>` (no matching close) → NOT stripped. The tag must
//     be paired; an unclosed tag is treated as literal text. Avoids
//     accidentally redacting unbounded content if a typo eats the closer.
//   - Nested `<private><private>...</private></private>` → stripped greedy
//     to the first matching close. The inner pair becomes a stray closer,
//     which is left literal. Don't nest.
//   - Whitespace inside the tag (`<private  >`) → not matched. Tags are
//     literal exact-strings.
//   - Multi-line content inside the block → stripped (regex uses [\s\S]).

import type { Entry } from "./types";

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/g;

// Returns a redacted copy if entry.text contains private tags; returns the
// same reference when there's nothing to strip (zero-allocation fast path).
export function redactPrivate(entry: Entry): Entry {
  const text = entry.text;
  if (typeof text !== "string" || !text.includes("<private>")) return entry;
  const stripped = text.replace(PRIVATE_TAG_RE, "");
  if (stripped === text) return entry;
  return { ...entry, text: stripped };
}

// Convenience for callers that only have a string (e.g. summariser input
// builders). Same parse rules; preserved as a single primitive.
export function redactPrivateText(text: string): string {
  if (!text.includes("<private>")) return text;
  return text.replace(PRIVATE_TAG_RE, "");
}
