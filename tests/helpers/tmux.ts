// Hermetic tmux test harness. Each call to tmuxSocket() mints a unique
// PID+counter-scoped socket path under /tmp/, resolves the tmux binary
// (bundled build preferred), and returns a teardown that kill-servers
// the socket. Intended for integration tests that verify tmux's contract
// with pty.rs — not driven through Tauri. See
// openspec/changes/v098-pty-refactor/design.md.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type Subprocess } from "bun";

const BUNDLED_TMUX = resolve(import.meta.dir, "../../src-tauri/resources/tmux");

let counter = 0;

export type TmuxHarness = {
  sock: string;
  tmux: string;
  run: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  spawnSession: (name: string, extraArgs?: string[]) => Promise<void>;
  attachReader: (name: string) => { proc: Subprocess; stdout: ReadableStream<Uint8Array> };
  teardown: () => Promise<void>;
};

export function resolveTmuxBin(): string {
  const override = process.env.A2A_TMUX?.trim();
  if (override && existsSync(override)) return override;
  if (existsSync(BUNDLED_TMUX)) return BUNDLED_TMUX;
  // system fallback — assumes tmux on PATH
  return "tmux";
}

export async function tmuxSocket(): Promise<TmuxHarness> {
  const tmux = resolveTmuxBin();
  const sock = `/tmp/a2achannel-test-${process.pid}-${counter++}.sock`;

  const run = async (args: string[]) => {
    const p = spawn([tmux, "-S", sock, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const exitCode = await p.exited;
    return { stdout, stderr, exitCode };
  };

  const spawnSession = async (name: string, extraArgs: string[] = []) => {
    const r = await run([
      "new-session",
      "-d",
      "-s", name,
      "-x", "80",
      "-y", "24",
      ...extraArgs,
    ]);
    if (r.exitCode !== 0) {
      throw new Error(`tmux new-session failed (exit ${r.exitCode}): ${r.stderr}`);
    }
  };

  const attachReader = (name: string) => {
    const proc = spawn([tmux, "-S", sock, "attach-session", "-t", name], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    return { proc, stdout: proc.stdout as unknown as ReadableStream<Uint8Array> };
  };

  const teardown = async () => {
    // kill-server ignores "no server running" (exit 1); we swallow that.
    await run(["kill-server"]).catch(() => {});
  };

  return { sock, tmux, run, spawnSession, attachReader, teardown };
}
