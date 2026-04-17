## Context

The hub is a Bun-compiled HTTP/SSE server bundled as a Tauri sidecar. It currently listens on a hardcoded `127.0.0.1:8011` known by four sites: the Rust shell (`HUB_PORT`), the hub sidecar (`PORT` default), the Tauri CSP, and every agent's `.mcp.json`. The app is macOS-only, local-first, and there is no authentication — the sole trust boundary is the loopback interface.

Two processes need to reach the hub at runtime:
1. **The webview**, loaded from disk by Tauri, runs inside the `.app` process.
2. **`channel-bin` instances**, spawned by external Claude Code sessions. They have no IPC relationship with the Tauri shell.

The in-app path (webview → hub) is trivially solvable with a Tauri command. The cross-process path (channel-bin → hub) is the interesting constraint: channel-bin is a child of Claude Code, its lifecycle is independent of the app's, and it must discover the hub URL without receiving it as a launch argument from us.

Bun has built-in filesystem APIs (`Bun.file`) and standard fs. SQLite is not involved. No new dependency is required.

## Goals / Non-Goals

**Goals:**
- Eliminate port collision as a startup failure mode: a fresh OS-assigned port avoids conflicts.
- Remove the hub URL from `.mcp.json`, so agent configs are portable across app rebuilds and port changes.
- Make startup order irrelevant: the app and Claude Code sessions can start in either order and converge.
- Preserve the existing `CHATBRIDGE_HUB` env var as an explicit override (escape hatch for debugging or advanced routing).

**Non-Goals:**
- Network / LAN exposure. Hub stays bound to `127.0.0.1`.
- Multiple concurrent A2AChannel instances as a supported feature (nothing prevents it structurally, but the discovery file's single-writer semantics mean the last writer wins).
- Authentication, TLS, or signed discovery files. Same trust model as today.
- Windows/Linux/Intel-Mac support. macOS arm64 only.
- Agent-side history replay or persistence (separate explorations, already decided against).

## Decisions

### 1. Rust binds the port, not the Bun sidecar

The Rust shell binds a `TcpListener` on `127.0.0.1:0`, reads the assigned port, then **releases the socket** before spawning `hub-bin`. The sidecar is given the port via the `PORT` env var and binds it itself.

**Why this over letting Bun bind `0` directly:**
- The Rust shell needs the port value before the sidecar is alive (to write the discovery file, to answer `get_hub_url()` if the UI asks early).
- If Bun bound `0`, we'd have to parse the port out of its stdout, adding a race: the UI might `invoke('get_hub_url')` before Bun has printed and we've parsed.
- A tiny TOCTOU window exists between closing the Rust listener and Bun reopening it. In practice the OS keeps the port assigned to the calling process momentarily, and we haven't observed conflicts in Bun. If it ever bites, switch to `SO_REUSEPORT` or ask Bun's side to retry with jitter.

**Alternative considered:** a proper port-handoff via fd-passing. Too much machinery for a loopback-only app.

### 2. Discovery file at `~/Library/Application Support/A2AChannel/hub.url`

Single-line file containing the full URL (`http://127.0.0.1:61234\n`). Chosen over a richer JSON format for bootstrapping simplicity — we can upgrade later without breaking the single-line reader.

**Write path (Rust):**
1. Resolve the path.
2. `create_dir_all` on the parent.
3. Write the URL to `hub.url.tmp` in the same directory.
4. `rename("hub.url.tmp", "hub.url")` — atomic on macOS APFS.

**Why atomic write:** channel-bin may read while Rust writes. Without atomicity, a reader could see a half-written URL. `rename` is atomic at the filesystem level, so the reader always sees the old or new content, never a partial.

**Alternative considered:** a JSON file `{url, started_at, pid}`. Rejected as YAGNI — the URL is enough. If we need metadata later, we swap formats and bump a `channel-bin` version check.

**Alternative considered:** a Unix domain socket path or abstract socket. Neither helps: the webview can't reach Unix sockets, and channel-bin using Unix would mean the hub exposes two transports. Not worth it.

### 3. channel-bin lookup priority

```
fn resolveHubUrl():
  1. if process.env.CHATBRIDGE_HUB is non-empty:
       return that value
  2. read ~/Library/Application Support/A2AChannel/hub.url:
       if exists and valid URL:
         return its contents
  3. return null
```

On connection failure (`fetch` rejects, non-2xx, or no body), the loop re-runs `resolveHubUrl` — so a stale URL from a crashed app auto-heals the next time the app restarts with a new port.

**Why re-resolve on every retry, not just on startup:** the app might restart between retries. If channel-bin cached the URL in memory it'd be stuck connecting to a dead port. Re-reading on each backoff cycle is cheap (tiny file) and makes the system self-healing.

### 4. CSP widens to `http://127.0.0.1:*`

`connect-src` and `img-src` entries that currently include `http://127.0.0.1:8011` become `http://127.0.0.1:*`. Other directives (`script-src`, `style-src`, etc.) unchanged.

**Threat model:** the webview renders only our bundled HTML/CSS/JS. User-supplied content (chat messages) is rendered via `escHtml` before insertion; agent-supplied content is escaped identically. There is no path by which an attacker can cause the webview to issue a fetch to an attacker-chosen port — and even if they could, everything on `127.0.0.1:*` is also under the user's control. The CSP widening does not materially change the attack surface.

**Alternative considered:** reading the chosen port back from Rust and rewriting the CSP at startup. Tauri CSP is a static string in `tauri.conf.json` baked into the app at build time. Dynamic CSP requires either rebuilding the webview HTML at launch or using Tauri's runtime CSP APIs (not stable in v2). Wildcard is simpler and safe enough.

### 5. UI startup: invoke before SSE

```
async function bootstrap() {
  const hubUrl = await window.__TAURI__.core.invoke('get_hub_url');
  BUS = hubUrl;                // replaces the current global constant
  await loadRoster();
  connect();                   // opens EventSource against BUS
}
```

Every `fetch(BUS + ...)` and `new EventSource(BUS + ...)` call already uses the `BUS` variable. Changing `BUS` from a top-level `const` to a `let` set by `bootstrap` is a one-liner.

**Race note:** `bootstrap` is async and must complete before any UI interaction that calls the hub. The existing `loadRoster().then(connect)` chain already serializes, we just prepend the `invoke`.

### 6. MCP template drops `CHATBRIDGE_HUB`

The `get_mcp_template()` Rust command currently embeds `http://127.0.0.1:8011` in the returned JSON. After this change, the `env` block contains only `CHATBRIDGE_AGENT`. If someone pastes this config into a project, channel-bin will discover the hub via the file.

Modal UX: no change visible to the user, other than the JSON template being one line shorter.

## Risks / Trade-offs

- **Stale discovery file after a crash** → channel-bin re-reads on every retry. Worst case: users see ECONNREFUSED in agent logs until A2AChannel restarts. Acceptable.

- **Two A2AChannel instances** → second overwrites the discovery file; the first's agents reconnect to the second. Discouraged but not prevented. If this becomes a real scenario, a PID check or file lock could be added later.

- **TOCTOU between Rust port-bind and sidecar port-bind** → Unlikely on a cooperating-processes loopback scenario. Mitigation path exists (retry with jitter in the sidecar) if ever observed.

- **Agents with explicit `CHATBRIDGE_HUB=http://127.0.0.1:8011` in their old `.mcp.json`** → After the change, the hub binds a random port. These agents keep trying 8011 and fail. Fix: remove the env var. Messaging: README and modal explicitly flag this.

- **CSP wildcard broadens local attack surface** → Discussed above. Acceptable for a local-first app with a trusted codebase. Document in CLAUDE.md so future contributors don't tighten it back without thinking.

- **Discovery file location is macOS-specific** → Hardcoded to `~/Library/Application Support/A2AChannel/`. Matches the existing macOS-only stance. If we ever port to Linux/Windows, `dirs::data_dir()` already abstracts this in Rust and `os.homedir()` + platform detection would do it in Bun.

## Migration Plan

Single-machine, single-user migration:

1. Rebuild and reinstall via `./scripts/install.sh`.
2. On first launch, Rust creates the discovery file.
3. For each existing agent project with a `.mcp.json` containing `CHATBRIDGE_HUB`:
   - Either rewrite via the updated MCP modal (Copy → paste over `.mcp.json`), removing the env entry.
   - Or leave the env entry and accept that the agent will only work when the hub happens to land on the hardcoded port (unlikely; functionally broken).
4. Restart each Claude Code session after swapping its `.mcp.json`.

No rollback beyond reverting the commit and rebuilding. State migration is trivial: no persistent state is affected.

## Open Questions

- Should the discovery file be deleted on clean app shutdown? **Lean: no.** Stale-file-with-retry is already the steady-state behavior, and adding a cleanup path introduces a new failure mode (what if cleanup fails and leaves a partial file?). Leaving it means channel-bin always gracefully handles "file exists but hub doesn't."
- Should we emit a structured `hub.url.json` now to future-proof? **Lean: no.** YAGNI. Single-line is faster to read, trivially compatible with shell tooling (`cat`, `curl $(cat hub.url)/agents`). Upgrade path exists if needed.
- Should channel-bin's retry backoff be tuned given the new frequent re-reads? **Lean: no.** Existing 2s backoff is fine; filesystem reads are sub-millisecond.
