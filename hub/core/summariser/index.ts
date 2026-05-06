// Summariser dispatcher — picks the adapter named by `A2A_SUMMARISER`.
// v1 ships only the claude adapter; llama-cpp + ollama land in subsequent
// commits without changing this file's interface.

import { createClaudeSummariser } from "./claude";
import { createOllamaSummariser } from "./ollama";
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
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  ollamaTimeoutMs?: number;
  // Reserved for llama-cpp wiring in a subsequent commit.
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
    case "ollama":
      return createOllamaSummariser({
        baseUrl: cfg.ollamaBaseUrl,
        model: cfg.ollamaModel,
        timeoutMs: cfg.ollamaTimeoutMs,
      });
    case "llama-cpp":
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

  const claudeBin = process.env.A2A_SUMMARISER_CLAUDE_BIN;
  if (claudeBin) cfg.claudeBinPath = claudeBin;
  const claudeT = process.env.A2A_SUMMARISER_CLAUDE_TIMEOUT_MS;
  if (claudeT) {
    const n = Number(claudeT);
    if (Number.isFinite(n) && n > 0) cfg.claudeTimeoutMs = n;
  }

  const ollamaUrl = process.env.A2A_SUMMARISER_OLLAMA_URL;
  if (ollamaUrl) cfg.ollamaBaseUrl = ollamaUrl;
  const ollamaModel = process.env.A2A_SUMMARISER_OLLAMA_MODEL;
  if (ollamaModel) cfg.ollamaModel = ollamaModel;
  const ollamaT = process.env.A2A_SUMMARISER_OLLAMA_TIMEOUT_MS;
  if (ollamaT) {
    const n = Number(ollamaT);
    if (Number.isFinite(n) && n > 0) cfg.ollamaTimeoutMs = n;
  }

  return cfg;
}
