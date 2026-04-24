// Test harness: boot the real hub (`bun run hub/hub.ts`) on an OS-assigned port
// against a temp ledger. Tests interact via HTTP + SSE exactly like the UI and
// channel-bin do in production — no mocks, no in-process imports.

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type HubHandle = {
  url: string;
  token: string;
  ledgerPath: string;
  attachmentsDir: string;
  humanName: string;
  kill: () => Promise<void>;
};

export async function spawnHub(opts?: {
  humanName?: string;
  defaultRoom?: string;
  token?: string;
  allowedExtensions?: string;
}): Promise<HubHandle> {
  const base = mkdtempSync(join(tmpdir(), "a2a-hub-test-"));
  const ledgerPath = join(base, "ledger.db");
  const attachmentsDir = join(base, "attachments");
  mkdirSync(attachmentsDir, { recursive: true });

  const token = opts?.token ?? `tst-${Math.random().toString(36).slice(2, 10)}`;
  const humanName = opts?.humanName ?? "human";
  const defaultRoom = opts?.defaultRoom ?? "default";

  const proc = Bun.spawn(["bun", "run", "hub/hub.ts"], {
    env: {
      ...process.env,
      PORT: "0",
      A2A_TOKEN: token,
      A2A_LEDGER_DB: ledgerPath,
      A2A_ATTACHMENTS_DIR: attachmentsDir,
      A2A_HUMAN_NAME: humanName,
      A2A_DEFAULT_ROOM: defaultRoom,
      A2A_ALLOWED_EXTENSIONS: opts?.allowedExtensions ?? "jpg,jpeg,png,pdf,md,txt,json",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Tail stdout until the "listening on http://127.0.0.1:<port>" line appears,
  // then extract the port. 5-second wall-clock limit — if boot is slower than
  // that something is wrong.
  const url = await waitForListening(proc, 5000);

  return {
    url,
    token,
    ledgerPath,
    attachmentsDir,
    humanName,
    kill: async () => {
      try { proc.kill(); } catch {}
      await proc.exited;
    },
  };
}

async function waitForListening(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<string> {
  if (!proc.stdout) throw new Error("hub stdout unavailable");
  const decoder = new TextDecoder();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const deadline = Date.now() + timeoutMs;
  let buf = "";
  const listenRe = /listening on (http:\/\/[^\s]+)/;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const race = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (race.done) break;
    buf += decoder.decode(race.value, { stream: true });
    const match = buf.match(listenRe);
    if (match) {
      // Drain remaining output in background so the pipe doesn't fill.
      void drainRest(reader);
      return match[1];
    }
  }
  try { proc.kill(); } catch {}
  throw new Error(`hub failed to boot within ${timeoutMs}ms. partial stdout:\n${buf}`);
}

async function drainRest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {}
}
