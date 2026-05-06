// Claude subprocess adapter — spawns `claude --print "<prompt>"` and pipes
// `userContent` to stdin. Uses the user's existing Claude Code subscription
// (Pro/Max), no API key required. Auth is shared via macOS keychain (same
// process user as A2AChannel).
//
// CLAUDE.md hard rule note: Claude Code's --print flag and stdout shape are
// the contract. If a future Claude Code version changes the flag or output,
// update one place (this file). Same fragility class as the existing
// `--dangerously-load-development-channels` rule.

import { spawn } from "node:child_process";
import {
  type Summariser,
  type SummariserOptions,
  SummariserCallError,
  SummariserUnavailableError,
} from "./types";

const DEFAULT_TIMEOUT_MS = 90_000;

export type ClaudeSummariserOptions = {
  // Path to the `claude` binary. Defaults to "claude" (resolved via PATH).
  binPath?: string;
  // Hard timeout for the whole subprocess. Defaults to 90s.
  timeoutMs?: number;
  // Identifier written into room_summary.model. Defaults to "claude".
  modelId?: string;
};

export function createClaudeSummariser(opts: ClaudeSummariserOptions = {}): Summariser {
  const binPath = opts.binPath ?? "claude";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const modelId = opts.modelId ?? "claude";

  async function summarise(
    systemPrompt: string,
    userContent: string,
    _opts: SummariserOptions = {},
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // --print runs one-shot, --append-system-prompt prepends our instructions.
      // The chat content goes through stdin so prompt-injection from chat lines
      // can't reshape claude's own argv.
      const args = ["--print", "--append-system-prompt", systemPrompt];
      let child;
      try {
        child = spawn(binPath, args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        reject(
          new SummariserUnavailableError(
            `claude binary not found at "${binPath}": ${(e as Error).message}`,
          ),
        );
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        action();
      };

      const killer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        settle(() => reject(new SummariserCallError(`claude --print timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

      child.on("error", (e) => {
        settle(() => reject(new SummariserUnavailableError(`claude spawn error: ${e.message}`)));
      });
      child.on("close", (code) => {
        if (code === 0) {
          settle(() => resolve(stdout.trim()));
        } else {
          settle(() =>
            reject(new SummariserCallError(`claude --print exited ${code}: ${stderr.trim() || "(no stderr)"}`)),
          );
        }
      });

      try {
        child.stdin.end(userContent);
      } catch (e) {
        settle(() => reject(new SummariserCallError(`claude stdin write failed: ${(e as Error).message}`)));
      }
    });
  }

  return { modelId, summarise };
}
