# Hierarchical L1 + L2 Room summary with prompt-driven selectivity

A Room's transcript chunk (10k lines) tokenises to far more than any 128K-context model can consume in a single call, and Briefing token cost has to stay bounded as Rooms accumulate hundreds of thousands of lines over time. We solve both with **two-level hierarchical summarisation**: L1 entries cover line-range blocks sized to the chosen model's context (~300 lines for Gemma 4 E2B), and L2 entries roll up batches of K=20 L1 entries into a single compressed summary. Briefing replays all L2 rollups + recently-unrolled L1 entries + the existing Nutshell + the active chunk via lazy hydration — a four-layer stack where each layer has the right granularity.

## Considered Options

- **Single-pass map-reduce within one chunk.** Rejected: forces a complex sub-chunking pipeline inside a single summary call, and the storage stays flat. Hierarchical L1/L2 gets the same quality result with simpler call shape (each call sees one coherent block) and gives us bounded Briefing cost as a side effect.
- **No hierarchy — flat L1 entries forever.** Rejected: Briefing payload grows linearly with Room age. A 100k-line Room with 300-line blocks would have ~330 L1 summaries; pasting all of them into Briefing blows the model's context.
- **L3+ rollups (rollup of rollups of rollups).** Rejected: realistic Room sizes don't justify it. With K=20, a 200k-line Room consolidates to ~33 L2 entries — still trivial for Briefing.
- **Heuristic / classifier pre-filter for what's "valuable" before summarising.** Rejected: adds complexity (which heuristics? per-message-type? agent-vs-human?). Modern small models handle "extract substance, ignore filler" well when the prompt is right. The prompt does the work.

## Consequences

- **Selectivity is prompt-driven, not pipeline-driven.** The summariser receives the Nutshell + prior summaries as "known state"; it extracts only what's NEW relative to that. Empty-Nutshell Rooms degrade gracefully — first L1 is dense, subsequent L1s self-bootstrap against earlier L1/L2 entries.
- **Empty summaries are skipped, not stored.** If the model returns "[no new substance]", no L1 row is written. Idle Rooms don't pollute Briefing.
- **Storage shape is `(room, level, start_line, end_line, model, summary, rolled_up_into)`.** Rolled-up L1 entries are kept on disk (small rows; useful for re-rollup if the user later upgrades the model) — `rolled_up_into` flags them so default Briefing skips them.
- **Backfill on opt-in is lazy.** Toggling `room_summary_enabled` on a Room with existing chat doesn't immediately summarise everything; the next Briefing-time check fills in missing L1/L2 entries for the existing line range.
