# Lazy per-Room transcript hydration on first agent reconnect

v0.10.2 deliberately removed transcript replay-on-startup after the user's directive that closing all agents should leave the chat empty. v0.11+ re-introduces it as **lazy per-Room hydration triggered on first agent reconnect**, not eager-on-Hub-startup. The trigger differentiates the two cases: agents survive a Hub-only restart → chat repopulates as they reconnect; agents are killed first → no reconnect → no hydration → room stays empty. The Hub can't see tmux state directly, so connection events are the only signal it has for "are the agents actually alive."

## Considered Options

- **Eager on Hub startup** — replays for every opted-in Room unconditionally. Rejected: violates the v0.10.2 directive when the user has killed agents and expects empty rooms.
- **Webview-driven** — Webview asks for replay when it loads. Rejected: webview can't tell which Rooms are live; would need another query path.
- **Lazy on agent reconnect** — chosen. The Hub's agent-stream connect is the natural "this Room has live agents again" signal.

## Consequences

- The `RoomHydrator` module (`hub/core/room-hydrator.ts`) seals the per-Room "hydrated this process" invariant. Concurrent same-Room agent reconnects share one cached promise; no duplicate replay.
- Replay is capped at `chat_history_limit` (default 1000) so the in-memory chatLog ring buffer doesn't overrun on a near-rotation 10k-line active chunk.
- Hydration is best-effort: a JSONL parse error logs once and resolves the cached promise. No mid-process retry. Hub restart re-attempts.
