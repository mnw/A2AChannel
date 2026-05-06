// Summariser interface + adapter dispatcher. The Phase 3 Room-summary
// feature delegates the model call through this seam; three adapters are
// planned (claude subprocess, bundled llama-cpp, ollama HTTP). v1 ships
// claude only; the seam is shaped for the others to land without churn.
//
// IMPORTANT (per ADR-0002): the prompt template lives in the CALLER (RoomSummariser),
// not the adapter. Adapters take the prompt as a string and pass it to the
// model. This keeps prompt iteration to one file across all adapters.

export type SummariserOptions = {
  // Soft cap on output tokens; adapters translate to whatever the model accepts.
  maxOutputTokens?: number;
  // Soft cap on context-window usage (input prompt + content). Adapters reject
  // (or warn) if the combined input clearly exceeds the model's context.
  maxInputTokens?: number;
  // Generation temperature; defaults to 0.2 for summary fidelity.
  temperature?: number;
};

export type Summariser = {
  // Identifier for the underlying model — written into room_summary.model so
  // mixed-model corpora can be re-rolled-up later if a user upgrades.
  readonly modelId: string;

  // Single inference call. Adapters never construct the prompt; the caller
  // passes the fully-assembled `systemPrompt` (instructions + format) and
  // `userContent` (the chat to summarise + Nutshell + prior summaries).
  summarise(
    systemPrompt: string,
    userContent: string,
    opts?: SummariserOptions,
  ): Promise<string>;
};

// Errors adapters throw — caller decides whether to skip the L1 row, retry, or fail loud.
export class SummariserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummariserUnavailableError";
  }
}
export class SummariserCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummariserCallError";
  }
}
