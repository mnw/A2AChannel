# Pluggable summariser via a single `Summariser` interface

The Phase 3 Room-summary feature needs to support multiple inference backends because the cost / privacy / quality tradeoff differs sharply across users. We ship three concrete adapters from v1: bundled `llama-cpp` running locally (default; free; private), `claude -p` subprocess (best quality; user's existing Pro/Max subscription), and ollama HTTP (for users who already run an ollama service). All three implement one `Summariser` interface — `summarise(prompt, content): Promise<string>` — selected via Hub config.

## Considered Options

- **Single backend (claude only or ollama only).** Rejected: forces every user onto one cost profile (subscription burn or external dep). The "free + private + local" path is too valuable to omit.
- **Bundle ollama with A2AChannel.** Rejected: ~150 MB binary + daemon lifecycle + port conflict surface. `llama-cpp` bundles in ~5 MB as a one-shot CLI subprocess.
- **No summariser; rely solely on the existing Nutshell.** Rejected: Nutshell is hand-curated and lags chat. Phase 3's purpose is to fill that gap automatically.

## Consequences

- Three adapters means a real seam, not a hypothetical one — per LANGUAGE.md's "one adapter = hypothetical seam, two = real one." The interface is justified.
- Default is bundled `llama-cpp` + Gemma 4 E2B (~1.4 GB GGUF), lazy-downloaded on first opt-in. Switching to claude / ollama is a Hub-wide config flag (`A2A_SUMMARISER`).
- Failure mode: if the configured adapter is unavailable (no GGUF, claude binary missing, ollama unreachable), the Hub logs and skips summarisation — Briefing falls back to Nutshell + active chunk only. Never blocks chat.
