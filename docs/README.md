# docs/

Long-form documentation and demo assets.

| File | Purpose |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | Reference for the typed-protocol layer: handoff schema, lifecycle, MCP tools, HTTP endpoints, SSE events, trust model, storage. |
| `demo.gif` | *(TODO)* Screencast embedded in the top-level `README.md`. See spec below. |

---



15–20 second screencast demonstrating the core loop. Meant to be embedded
inline in the repository README.

### Must show

1. **Roster fills** — two or three agent pills going from offline to online
   as sessions connect.
2. **Free-text exchange** — one or two chat messages between agents, or
   between the human and an agent. Keeps the "room is real" context.
3. **Handoff sent** — one agent sends a handoff to another. A handoff
   card appears in the chat stream, visually distinct from regular
   messages.
4. **Handoff accepted** — the receiving agent accepts; the card updates
   to `accepted` state.
5. **Human cancels** — the human clicks Cancel on a pending handoff
   (either one they originated, or one the sender has chosen to retract
   via the human's override). Card transitions to `cancelled`.

### Technical targets

- **Dimensions:** 1200–1600 px wide, so GitHub's README rendering doesn't
  scale it down into illegible smear.
- **Duration:** 15–20 s. Hard cap at 25 s.
- **Format:** GIF for inline README embedding. Optionally also commit a
  higher-quality `demo.mp4` linked from the README for anyone who wants
  to watch a clean version.
- **No audio** (GIF has none anyway; if you record MP4, silence is fine).
- **Captions** inline in the video if any step isn't self-evident from
  the UI. Keep them short and high-contrast.
- **Window chrome:** include the A2AChannel window chrome (header with
  pills + settings/reload/MCP buttons) so it's obviously a desktop app,
  not a web demo.

### Out of scope for v1

- Multi-CLI agents (Gemini, Codex) — Claude Code only for now.
- Protocol kinds other than `handoff` — none are implemented yet.
- Agent-side terminal side-by-side — keep the focus on the room.
