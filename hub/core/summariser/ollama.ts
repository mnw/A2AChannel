// Ollama HTTP adapter — talks to a local ollama service over HTTP.
// User runs `ollama serve` separately (or via brew services); A2AChannel
// detects via A2A_SUMMARISER=ollama. No binary bundling, no auth surface
// (loopback only), no API key.
//
// API contract: ollama's /api/chat endpoint accepts a chat-message array
// with role + content. We pass the systemPrompt as role=system and the
// userContent as role=user. The non-streaming response carries the full
// completion in a single message.

import {
  type Summariser,
  type SummariserOptions,
  SummariserCallError,
  SummariserUnavailableError,
} from "./types";

export type OllamaSummariserOptions = {
  // Default: http://127.0.0.1:11434 (ollama's standard).
  baseUrl?: string;
  // Default: gemma4:e2b. User overrides via A2A_SUMMARISER_MODEL.
  model?: string;
  // Hard timeout per call. Default: 120s (cold-start + generation budget).
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "gemma4:e2b";
const DEFAULT_TIMEOUT_MS = 120_000;

export function createOllamaSummariser(opts: OllamaSummariserOptions = {}): Summariser {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function summarise(
    systemPrompt: string,
    userContent: string,
    sopts: SummariserOptions = {},
  ): Promise<string> {
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          options: {
            temperature: sopts.temperature ?? 0.2,
            // ollama uses num_predict for max output tokens.
            num_predict: sopts.maxOutputTokens ?? 800,
          },
        }),
      });
    } catch (e) {
      clearTimeout(killer);
      const msg = (e as Error).message ?? String(e);
      if (ac.signal.aborted) {
        throw new SummariserCallError(`ollama timed out after ${timeoutMs}ms`);
      }
      // Connection refused → service not running. Distinguishable from
      // mid-call failure so the caller can log "summariser unavailable" once
      // and not retry.
      if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        throw new SummariserUnavailableError(
          `ollama service not reachable at ${baseUrl}: ${msg}`,
        );
      }
      throw new SummariserCallError(`ollama fetch error: ${msg}`);
    }
    clearTimeout(killer);

    if (resp.status === 404) {
      // Model not pulled. Distinct from "service down" — actionable error message.
      const body = await resp.text().catch(() => "");
      throw new SummariserUnavailableError(
        `ollama model "${model}" not pulled: ${body || "404"}. Run \`ollama pull ${model}\`.`,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new SummariserCallError(`ollama HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch (e) {
      throw new SummariserCallError(`ollama response not JSON: ${(e as Error).message}`);
    }
    const content =
      json && typeof json === "object" && "message" in json
        ? ((json as { message?: { content?: string } }).message?.content ?? "")
        : "";
    if (!content) {
      throw new SummariserCallError(`ollama returned empty content`);
    }
    return content.trim();
  }

  return { modelId: `ollama:${model}`, summarise };
}
