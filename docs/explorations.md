# Explorations report — chat-driven slash commands

> **Date:** 2026-04-27
> **Conclusion:** Slash commands stay in the terminal pane. Two attempts to bring them into the chat composer were tried; both shipped working code and both surfaced architectural reasons not to keep them. Branches preserved on GitHub for documentation.

## Background

A2AChannel today has three input surfaces per agent: chat (free-text + structured kinds — works), the embedded xterm tab (where the human types slash commands like `/clear`, `/usage`, `/opsx:explore` directly into claude — works), and nothing in between. The question explored: **could we drive an agent's slash commands from the chat composer instead of switching to its terminal tab?**

Two architectural attempts. Both deferred to the terminal in the end.

## Attempt 1 — chat → PTY raw-byte injection

**Branch:** `commands` (commit `25830ed`, originally shipped as v0.9.13)

The composer detected a leading `/`, opened a picker of available slash commands (filesystem-discovered from each agent's `.claude/commands/` and `.claude/skills/` plus a hardcoded built-in list), required explicit `@agent` or `@all` targeting, and on send wrote the raw bytes (`/cmd\r`) directly to the agent's tmux PTY master via the existing `pty_write` Tauri command. Chat-side audit row recorded each send.

The first half worked cleanly: picker, targeting, destructive-confirm modal for `/clear @all`, room-scoping guardrails. The fragile half was the **response capture** — piping claude's TUI panel back into the chat as a code block:

| Layer | Failure mode |
|---|---|
| Quiescence detection (1.5–6 s window) | Network-bound commands like `/usage` make API calls with multi-second pauses; the window closed before claude finished rendering. |
| ANSI strip from raw byte stream | Claude's panels paint with cursor positioning, not spaces. After ANSI strip, columns collapse into runs of jammed words. |
| Visible-buffer snapshot | The xterm only holds the visible viewport; tall panels scroll off the top. |
| Alt-buffer snapshot (xterm.js) | Capped at viewport rows. Claude paints 80-row panels into a 30-row alt buffer; the top 50 rows scroll out of memory. |
| Per-capture headless oversized xterm (200×200) | State leakage between captures; `/context` came back with `/usage`'s previous panel half-overwritten under the new content. Per-capture term creation fixed leakage but the typed-command anchor (used to slice "everything after `/cmd`") didn't survive prompt re-render — claude clears the typed line on send, so the anchor disappeared and the slicer dumped the entire scrollback. |

Each fix solved the previous failure mode and surfaced a new one. The root cause is structural: **claude's slash-command output is a TUI presentation, not a data stream.** It uses cursor positioning, alt buffers, scroll regions, animation, paced API calls, and rendering tricks specific to the terminal it was rendered for. We were trying to scrape a UI that was designed to be looked at.

The send half is genuinely useful (`/clear @all` to four agents in one keystroke; audit trail; destructive-confirm). The capture half is the fragile part. Neither shipped to main.

## Attempt 2 — Anthropic Agent SDK pivot

**Branch:** `sdk-pivot` (HEAD at `e6a3911`, version `1.0.0-alpha.0`)

If scraping a TUI is the wrong tool, the right tool would be a structured-output API. The Anthropic Agent SDK exposes exactly that: spawn claude in headless mode via `query({ prompt, options: { cwd, resume, mcpServers, ... } })`, get back typed messages (`system.init`, `assistant`, `user`, `result`) with structured fields. Slash commands run; their output comes back as `assistant.text` blocks ready to forward into chat verbatim. Tools render as `assistant.tool_use` blocks. Permissions surface as `canUseTool` callbacks. Multi-turn via `resume: sessionId`.

The spike built a full coexistence model on the branch: a parallel "sdk agent" type alongside existing tmux agents. New `+ SDK` button in the header opens a stripped-down spawn modal (just name + cwd + room — no PTY, no session-mode radio). Hub-side orchestrator (`hub/sdk-agents.ts`) intercepts chat dispatch via `enqueueTo()`: if the target is an sdk-agent, it runs an SDK query in that agent's cwd, captures `session_id` on first turn, streams `assistant` messages back to chat as messages from the agent. In-process MCP server defines `send_handoff` (more tools planned). The architecture worked: the hub-side orchestrator + UI + Tauri env plumbing all wired up correctly, slash commands like `/context` and `/usage` returned data cleanly into chat.

**Where it failed:** the licensing wall.

```
Architect_1 → You
Invalid API key · Fix external API key

System
[sdk-agent Architect_1] turn failed: Claude Code returned an error result:
Invalid API key · Fix external API key
```

Slash commands that are local data lookups (`/context`, `/usage`) succeeded — they don't call the Anthropic API. The moment claude needed to generate a conversational response (i.e., made an actual API call), it failed with "Invalid API key."

The cause is policy-enforced. A2AChannel's Max-subscription model relies on the interactive `claude` CLI authenticating via macOS Keychain and propagating an `sk-cp-…` OAuth token to its child processes (which is how the existing `channel-bin` MCP sidecar inherits auth). The SDK runs claude in **headless mode**, which doesn't go through that auth flow. Anthropic's documented position: SDK consumers use `ANTHROPIC_API_KEY` (pay-per-token), and *"third-party developers should not offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."* The subscription token is for the interactive CLI; SDK is API-key territory.

We considered extracting the OAuth token from Keychain and injecting it as `ANTHROPIC_API_KEY` for SDK queries. Rejected — using a subscription token from a non-CLI context is the kind of pattern Anthropic's anti-abuse systems are designed to flag, and the downside (account suspension) is much worse than the upside (one-spike validation).

The architecture is technically sound. The commercial model isn't compatible with how A2AChannel currently positions itself: install the app, run on your existing Max plan. SDK mode would require a separate `ANTHROPIC_API_KEY` per user, turning a free-with-Max tool into a pay-per-token tool. That's a different product.

## Decision

Slash commands stay in the terminal. The xterm tab next to each agent is the canonical surface for `/`-prefixed input. The chat-side picker / response capture / SDK orchestrator lines of work are not being developed further.

What survives from the exploration:

- **Both branches preserved on GitHub** — `commands` and `sdk-pivot` — as documented dead-ends with working code anyone can read or rerun.
- **Architectural map** of what an SDK-native A2AChannel would look like (smaller codebase, terminal-quality back-and-forth in chat, clean structured tool-call rendering) — kept on `sdk-pivot` for the day Anthropic ships subscription auth for the SDK.
- **Hard-won knowledge** that the chatbridge MCP sidecar + tmux + PTY model isn't accidental — it's the *only* path that uses the user's existing Max subscription without commercial repackaging. The complexity buys the auth model.

What lives on `main` after PR #2 was merged:

- **v0.9.13 chat→PTY send capability** is shipped — the composer recognizes `/`-prefixed messages and writes them to the agent's PTY with explicit `@target` routing. Useful for multi-agent broadcast (`/clear @all`) and for the audit trail of what was sent. Keep using it.
- **The capture-iteration code from the `commands` branch** also landed in PR #2 (markdown rendering, headless terminal capture, ANSI strip refinements). This is the part that proved fragile and should not be relied on for slash-command output rendering — the terminal pane is where you see the actual response.
- **No SDK orchestrator** — `sdk-pivot` is not merged and won't be unless the auth-model story changes upstream.

The split: chat is the *send* surface (with multi-target broadcast and audit), terminal is the *response* surface (full fidelity, lossless, no scraping).
