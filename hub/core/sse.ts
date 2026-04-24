// SSE infrastructure: bounded queue with drop-oldest semantics and the
// ReadableStream-backed response wrapper with a 15s heartbeat.

import { corsHeaders } from "./auth";

export const HEARTBEAT_MS = 15_000;

// Drop-oldest queue — when full, the oldest item is evicted instead of blocking
// the producer. Prevents a slow subscriber from growing hub memory indefinitely.
export class DropQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T) => void> = [];
  constructor(private readonly max: number) {}

  push(v: T): void {
    const w = this.waiters.shift();
    if (w) {
      w(v);
      return;
    }
    if (this.items.length >= this.max) this.items.shift();
    this.items.push(v);
  }

  async pull(signal?: AbortSignal): Promise<T> {
    if (this.items.length) return this.items.shift()!;
    return new Promise<T>((resolve, reject) => {
      const waiter = (v: T) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new DOMException("aborted", "AbortError"));
      };
      this.waiters.push(waiter);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

export type SSESend = (obj: unknown, id?: number | string) => void;

export function makeSSE(
  setup: (send: SSESend, signal: AbortSignal) => void | Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const ac = new AbortController();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: SSESend = (obj, id) => {
        if (closed) return;
        try {
          const idLine = id !== undefined ? `id: ${id}\n` : "";
          controller.enqueue(
            encoder.encode(`${idLine}data: ${JSON.stringify(obj)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      try {
        controller.enqueue(encoder.encode(": connected\n\n"));
      } catch {}

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: hb ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);
      ac.signal.addEventListener("abort", () => clearInterval(heartbeat), {
        once: true,
      });

      try {
        await setup(send, ac.signal);
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.error("[sse]", e);
      } finally {
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      closed = true;
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      ...corsHeaders,
    },
  });
}
