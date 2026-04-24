// HTTP framework primitives: body-size caps, CORS, JSON responses, bearer-token auth.
// Consumers compose these via the `makeAuthHelpers(token)` factory so AUTH_TOKEN
// stays owned by the hub entry point, not scattered as a module-level global here.

export const JSON_BODY_MAX = 262_144;         // 256 KiB (default for JSON routes)
export const HANDOFF_BODY_MAX = 1_048_576;    // 1 MiB (POST /handoffs — accommodates context payloads)
export const PERMISSION_BODY_MAX = 16_384;    // 16 KiB (POST /permissions — bounded fields)
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// CORS origin allowlist for mutating routes. No-Origin requests (curl, sidecars) pass;
// cross-origin browsers are rejected.
export const ALLOWED_ORIGINS = new Set<string>([
  "tauri://localhost",
  "http://tauri.localhost",
]);

export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...(init?.headers ?? {}),
    },
  });
}

// Constant-time string comparison (length oracle is not a secret leak).
export function ctEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export type AuthHelpers = {
  requireAuth: (req: Request) => Response | null;
  requireReadAuth: (req: Request, url: URL) => Response | null;
  requireJsonBody: (req: Request, max?: number) => Response | null;
};

// Factory so the hub entry point retains ownership of AUTH_TOKEN. Closures over
// `authToken` avoid re-reading env, and tests can inject a known token.
export function makeAuthHelpers(authToken: string): AuthHelpers {
  function requireAuth(req: Request): Response | null {
    const origin = req.headers.get("origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "forbidden origin" }, { status: 403 });
    }
    if (!authToken) {
      return json({ error: "hub misconfigured: no token" }, { status: 500 });
    }
    const header = req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match || !ctEquals(match[1].trim(), authToken)) {
      return json({ error: "unauthorized" }, { status: 401 });
    }
    return null;
  }

  function requireReadAuth(req: Request, url: URL): Response | null {
    if (!authToken) {
      return json({ error: "hub misconfigured: no token" }, { status: 500 });
    }
    const header = req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1].trim() : (url.searchParams.get("token") ?? "").trim();
    if (!token || !ctEquals(token, authToken)) {
      return json({ error: "unauthorized" }, { status: 401 });
    }
    return null;
  }

  function requireJsonBody(req: Request, max = JSON_BODY_MAX): Response | null {
    const lenRaw = req.headers.get("content-length");
    if (lenRaw === null) {
      return json({ error: "length required" }, { status: 411 });
    }
    const len = Number(lenRaw);
    if (!Number.isFinite(len) || len < 0) {
      return json({ error: "invalid content-length" }, { status: 400 });
    }
    if (len > max) {
      return json({ error: "payload too large" }, { status: 413 });
    }
    return null;
  }

  return { requireAuth, requireReadAuth, requireJsonBody };
}
