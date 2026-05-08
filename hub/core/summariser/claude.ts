// Claude subprocess adapter — spawns `claude --print` and pipes content to
// stdin. Uses the user's existing Claude Code subscription (Pro/Max), no API
// key required. Auth is shared via macOS keychain (same process user as
// A2AChannel).
//
// Path resolution: macOS GUI apps inherit a sanitised $PATH from launchd that
// excludes user-installed npm bins. Relying on `claude` being in $PATH fails
// for the typical Anthropic-installer location. We resolve the binary at
// adapter-construction time by trying a fixed candidate list — same pattern
// the Rust shell uses for resolve_channel_bin in src-tauri/src/lib.rs.
//
// CLAUDE.md hard rule note: Claude Code's --print flag and stdout shape are
// the contract. If a future Claude Code version changes the flag or output,
// update this file in one place. Same fragility class as the existing
// `--dangerously-load-development-channels` rule.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Summariser,
  type SummariserOptions,
  SummariserCallError,
  SummariserUnavailableError,
} from "./types";

const DEFAULT_TIMEOUT_MS = 90_000;

export type ClaudeSummariserOptions = {
  // Explicit override path; if set, must exist or construction throws.
  binPath?: string;
  // Hard timeout for the whole subprocess. Defaults to 90s.
  timeoutMs?: number;
  // Identifier written into room_summary.model. Defaults to "claude" or
  // "claude:<model>" when modelAlias is set.
  modelId?: string;
  // Claude Code --model flag. Aliases (haiku, sonnet, opus) or full names
  // (claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-7). Unset → Claude
  // Code's session default (typically Sonnet).
  modelAlias?: string;
};

const FALLBACK_PATHS = [
  // Anthropic's `claude` installer (npm-based, current as of 2026-05).
  // homedir() is computed inline to keep the constant array literal-friendly.
  // The first existing path wins.
  join(homedir(), ".claude/local/node_modules/.bin/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
] as const;

// Returns null if no candidate exists. Caller decides whether to throw.
export function resolveClaudeBinPath(override?: string): string | null {
  if (override) {
    return existsSync(override) ? override : null;
  }
  for (const candidate of FALLBACK_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function createClaudeSummariser(opts: ClaudeSummariserOptions = {}): Summariser {
  const resolved = resolveClaudeBinPath(opts.binPath);
  if (!resolved) {
    const probed = opts.binPath
      ? `override "${opts.binPath}"`
      : FALLBACK_PATHS.join(", ");
    throw new SummariserUnavailableError(
      `claude binary not found (probed: ${probed}). ` +
        `Install Claude Code from https://claude.com/claude-code or set A2A_SUMMARISER_CLAUDE_BIN to the binary path.`,
    );
  }
  // Re-bind to a non-null const so TypeScript's flow analysis can narrow the
  // closure that builds the `summarise` Promise — without this, `binPath`
  // remains `string | null` inside the inner async fn and spawn() rejects.
  const binPath: string = resolved;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const modelAlias = opts.modelAlias?.trim() || null;
  const modelId = opts.modelId ?? (modelAlias ? `claude:${modelAlias}` : "claude");
  console.log(`[summariser:claude] resolved bin: ${binPath}${modelAlias ? ` model=${modelAlias}` : ""}`);

  async function summarise(
    systemPrompt: string,
    userContent: string,
    _opts: SummariserOptions = {},
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const args = ["--print", "--append-system-prompt", systemPrompt];
      if (modelAlias) args.push("--model", modelAlias);
      // Strip ANTHROPIC_API_KEY from the inherited env. Claude Code Pro/Max
      // sessions set this to a subscription token (e.g. "sk-cp-...") that is
      // NOT a valid Anthropic API key — `claude --print` picks it up first
      // and the API rejects it with "Invalid API key". Unsetting it lets
      // claude fall back to its keychain OAuth auth, which is what we want
      // for subscription-funded calls.
      const childEnv = { ...process.env };
      delete childEnv.ANTHROPIC_API_KEY;
      let child;
      try {
        child = spawn(binPath, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnv,
        });
      } catch (e) {
        reject(
          new SummariserCallError(
            `claude spawn failed at "${binPath}": ${(e as Error).message}`,
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

      // CRITICAL: register stdin 'error' BEFORE writing. Without this, an
      // EPIPE during stdin.end() (claude exited before draining the input)
      // becomes an unhandled error event and crashes the entire hub process.
      // The exit handler below still surfaces the non-zero close code so
      // the caller learns what went wrong.
      child.stdin.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code !== "EPIPE") {
          console.warn(`[summariser:claude] stdin error: ${e.message}`);
        }
      });

      child.on("error", (e) => {
        settle(() => reject(new SummariserCallError(`claude spawn error: ${e.message}`)));
      });
      child.on("close", (code) => {
        if (code === 0) {
          settle(() => resolve(stdout.trim()));
        } else {
          // Include stdout in the error: claude --print sometimes reports
          // errors there instead of stderr, and "exited 1: (no stderr)" is
          // useless for debugging without seeing stdout too.
          const so = stdout.trim().slice(0, 1000);
          const se = stderr.trim().slice(0, 1000);
          settle(() =>
            reject(new SummariserCallError(
              `claude --print exited ${code}: stderr=${se || "(empty)"} | stdout=${so || "(empty)"}`,
            )),
          );
        }
      });

      // Explicit write + close-after-flush. Using `child.stdin.end(userContent)`
      // for large payloads (chat blocks can be megabytes) doesn't reliably
      // flush before claude's 3s "no stdin data" timeout fires under Bun's
      // child_process compat layer — the data sits in the pipe buffer until
      // the next tick. Writing with a callback and closing inside it ensures
      // the bytes are drained to the underlying fd before EOF.
      child.stdin.write(userContent, "utf8", (err) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
            console.warn(`[summariser:claude] stdin write callback error: ${err.message}`);
          }
          return;
        }
        try { child.stdin.end(); } catch { /* close handler will surface exit code */ }
      });
    });
  }

  return { modelId, summarise };
}
