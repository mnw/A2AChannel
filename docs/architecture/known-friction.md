# Known architectural friction (filed, not actioned)

Audit-surfaced findings that don't meet the threshold for opening an architectural cycle. See `openspec/changes/architecture-cycle-2b/design.md` § "Closing — last planned architectural cycle" for the threshold rule.

The rule, abbreviated: a finding becomes a cycle only if it (a) addresses a CLAUDE.md hard rule currently convention-enforced, (b) eliminates a real production bug class, or (c) closes a structural test-coverage gap. LOC reductions, test-surface improvements, and organizational-locality cleanups DO NOT trigger cycles — they live here and get opportunistically addressed when a feature reason already touches the relevant file.

---

## F-001 — `lib.rs` config resolution: 16 shallow `resolve_*` helpers

**Filed:** 2026-05-11 (post-2a code audit, finding #3).

**Sketch:** `src-tauri/src/lib.rs:125–442` has ~16 functions (`resolve_attachment_extensions`, `resolve_attachments_dir_and_seed`, `resolve_chat_history_limit`, `resolve_human_name`, `resolve_theme`, `resolve_font_scale`, `resolve_fonts`, plus matching `default_*`). Each re-calls `load_config()` independently. `reload_settings` at `lib.rs:867` triggers the load chain six times for one user-initiated reload.

**Why not actioned:** Pure LOC-reduction + locality cleanup. No CLAUDE.md hard rule is at risk. No production bug class. Test-surface improvement is real (`AppConfig::from_yaml(text)` would become a pure-computation test seam) but currently no tests are blocked on the current shape.

**Opportunistic fix trigger:** If you're already adding a new config field (e.g., the planned RoomSummary block) and would otherwise add a new `resolve_X` helper, instead create an `AppConfig` struct and migrate the existing resolvers in the same patch. The new field is the load-bearing reason; the cleanup rides along.

**Sketch of intended shape:** `struct AppConfig { attachment_exts, attachments_dir, chat_history_limit, human_name, theme, font_scale, fonts, ... }` with `impl Default for AppConfig` holding the defaults, `AppConfig::load() -> Result<AppConfig, ConfigError>` loading + validating once, `AppConfig::from_yaml(text)` for tests. Three call sites (`setup`, `reload_settings`, `get_ui_settings`) each call `load()` once.

---

## F-002 — Filesystem layout policy scattered between `lib.rs` and `pty.rs`

**Filed:** 2026-05-11 (post-2a code audit, finding #2).

**Sketch:** Persistent state under `~/Library/Application Support/A2AChannel/` is split between `lib.rs` (attachments, transcripts, hub.url, hub.token) and `pty.rs` (mcp-configs, settings, tmux.sock). Ephemeral state under `/tmp/a2a/<agent>/` is implicit in `pty.rs`'s capture and signals helpers. Tests in `tests/helpers/hub.ts:24–27` hardcode their own temp dirs because there's no path-resolution Module to override.

**Why not actioned:** Pure organizational-locality cleanup. No CLAUDE.md hard rule at risk. No production bug class. Test-surface improvement is real (single path-override point for hermetic test runs) but currently the per-test temp-dir dance works.

**Opportunistic fix trigger:** If you're adding a new persistent directory (e.g., a Room summary GGUF cache, a per-agent log cache, anything that needs to land alongside the existing ~/Library/Application Support/A2AChannel/ structure), create `src-tauri/src/paths.rs` for that new entry and migrate at least the closest existing entries (the ones in the same conceptual cluster) in the same patch.

**Sketch of intended shape:** `src-tauri/src/paths.rs` exporting `persistent_app_data_dir()`, `persistent_mcp_configs_dir()`, `persistent_agent_settings_dir()`, `persistent_attachments_dir(config)`, `persistent_transcripts_dir(config)`, `ephemeral_agent_captures_dir(agent)`, `ephemeral_agent_signals_dir(agent)`, `discovery_url_path()`, `discovery_token_path()`. `lib.rs` and `pty.rs` import from it; tests can stub the persistent root for hermetic runs.

---

## How to add a new entry to this file

When a future audit surfaces a finding that doesn't meet the cycle threshold:

1. Confirm the finding doesn't qualify as a cycle trigger (no hard-rule risk, no bug class, no test-gap that per-helper rule was designed to prevent).
2. Add a `## F-NNN — <one-line summary>` entry below the last one.
3. Include: **Filed** (date + source), **Sketch** (the actual problem), **Why not actioned** (which trigger it fails), **Opportunistic fix trigger** (when to fold into other work), **Sketch of intended shape** (the design as understood today; explicitly NOT a binding spec — re-grill when the work actually starts).

Don't open a refactor branch for entries here. Don't write an OpenSpec change for them. The discipline is: file it, move on, fix it when you're already touching the file for a real reason.
