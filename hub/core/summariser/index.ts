// Summariser dispatcher — picks the adapter named by `A2A_SUMMARISER`.
// v1 ships only the claude adapter; llama-cpp + ollama land in subsequent
// commits without changing this file's interface.

import { createClaudeSummariser } from "./claude";
import type { Summariser } from "./types";

export type { Summariser, SummariserOptions } from "./types";
export {
  SummariserCallError,
  SummariserUnavailableError,
} from "./types";

export type SummariserAdapterName = "claude" | "llama-cpp" | "ollama" | "disabled";

export type SummariserConfig = {
  adapter: SummariserAdapterName;
  // Overrides per adapter; ignored by adapters that don't use them.
  claudeBinPath?: string;
  claudeTimeoutMs?: number;
  // Reserved for llama-cpp / ollama wiring in subsequent commits.
};

// Returns null when adapter === "disabled" or when the configured adapter
// can't be constructed (e.g. unsupported name). Callers treat null as
// "summarisation off — Briefing falls back to Nutshell + active chunk only."
export function createSummariser(cfg: SummariserConfig): Summariser | null {
  switch (cfg.adapter) {
    case "claude":
      return createClaudeSummariser({
        binPath: cfg.claudeBinPath,
        timeoutMs: cfg.claudeTimeoutMs,
      });
    case "llama-cpp":
    case "ollama":
      console.warn(`[summariser] adapter "${cfg.adapter}" not yet implemented; summarisation disabled`);
      return null;
    case "disabled":
      return null;
    default:
      console.warn(`[summariser] unknown adapter "${cfg.adapter}"; summarisation disabled`);
      return null;
  }
}

export function readSummariserConfigFromEnv(): SummariserConfig {
  const raw = (process.env.A2A_SUMMARISER ?? "disabled").trim().toLowerCase();
  const adapter: SummariserAdapterName =
    raw === "claude" || raw === "llama-cpp" || raw === "ollama" || raw === "disabled"
      ? raw
      : "disabled";
  const cfg: SummariserConfig = { adapter };
  const bin = process.env.A2A_SUMMARISER_CLAUDE_BIN;
  if (bin) cfg.claudeBinPath = bin;
  const tRaw = process.env.A2A_SUMMARISER_CLAUDE_TIMEOUT_MS;
  if (tRaw) {
    const n = Number(tRaw);
    if (Number.isFinite(n) && n > 0) cfg.claudeTimeoutMs = n;
  }
  return cfg;
}
