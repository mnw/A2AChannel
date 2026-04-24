// Attachment upload + serve. Extension allowlist is the single gate — no MIME
// sniff, no magic-byte check. Serve route applies a strict CSP (default-src
// 'none'; sandbox) + X-Content-Type-Options: nosniff so even mis-uploaded
// HTML/JS/SVG cannot execute in the viewer.
//
// Files persist at <ATTACHMENTS_DIR>/<id>.<ext> with mode 0600. Tmp-and-rename
// on write so partial files never get served. Symlinks are NOT followed —
// post_file agents pass absolute paths; the serve route always resolves to a
// file inside ATTACHMENTS_DIR.

import { chmodSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { json, corsHeaders, IMAGE_MAX_BYTES } from "./auth";
import { randomId } from "./ids";

export const DEFAULT_ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "pdf", "md"];

// Unknown-but-allowed extensions serve as octet-stream; the strict CSP blocks execution.
export const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  html: "text/html; charset=utf-8",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  log: "text/plain; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
};

export const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
export const IMAGE_URL_RE = /^\/image\/[A-Za-z0-9_-]+\.[a-z0-9]{1,10}$/i;
export const IMAGE_PATH_SEGMENT_RE = /^[A-Za-z0-9_-]+\.[a-z0-9]{1,10}$/i;

// Build the runtime allowlist from A2A_ALLOWED_EXTENSIONS env; falls back to the
// defaults. Validation mirrors the Rust shell's (lowercase alnum, ≤10 chars, no dots).
export function buildAllowedExtensions(envValue: string | undefined): Set<string> {
  const fromEnv = (envValue ?? "").split(",")
    .map((e) => e.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean)
    .filter((e) => /^[a-z0-9]{1,10}$/.test(e));
  const set = new Set<string>(fromEnv);
  if (set.size === 0) {
    for (const e of DEFAULT_ALLOWED_EXTENSIONS) set.add(e);
  }
  return set;
}

export async function handleUpload(
  req: Request,
  attachmentsDir: string,
  allowed: Set<string>,
): Promise<Response> {
  if (!attachmentsDir) {
    return json({ error: "attachments dir not configured" }, { status: 500 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return json({ error: "invalid form" }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "no file" }, { status: 400 });
  if (file.size > IMAGE_MAX_BYTES) {
    return json({ error: "file too large" }, { status: 413 });
  }
  // Trust the filename extension, not browser-supplied MIME. Serve route has strict CSP + nosniff.
  const rawName = (file.name ?? "").trim();
  const dot = rawName.lastIndexOf(".");
  const ext = dot >= 0 ? rawName.slice(dot + 1).toLowerCase() : "";
  if (!ext || !allowed.has(ext)) {
    return json(
      {
        error: `extension '${ext || "(none)"}' not in allowlist (${[...allowed].sort().join(", ")})`,
      },
      { status: 400 },
    );
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  const id = randomId();
  const filename = `${id}.${ext}`;
  const target = join(attachmentsDir, filename);
  const tmp = join(attachmentsDir, `.${filename}.tmp`);
  try {
    await Bun.write(tmp, buf);
    chmodSync(tmp, 0o600);
    await rename(tmp, target);
  } catch (e) {
    try { await unlink(tmp); } catch {}
    console.error("[hub] upload write failed:", e);
    return json({ error: "failed to persist image" }, { status: 500 });
  }
  return json({ url: `/image/${filename}`, id, path: target });
}

export async function handleImage(
  segment: string,
  attachmentsDir: string,
): Promise<Response> {
  if (!attachmentsDir) {
    return json({ error: "attachments dir not configured" }, { status: 500 });
  }
  if (!IMAGE_PATH_SEGMENT_RE.test(segment)) {
    return json({ error: "invalid attachment path" }, { status: 400 });
  }
  const absPath = join(attachmentsDir, segment);
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    return json({ error: "not found" }, { status: 404 });
  }
  const dot = segment.lastIndexOf(".");
  const ext = segment.slice(dot + 1).toLowerCase();
  const ctype = EXT_TO_MIME[ext] ?? "application/octet-stream";
  return new Response(file, {
    headers: {
      "Content-Type": ctype,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=3600",
      ...corsHeaders,
    },
  });
}

// Rewrite an incoming `image` URL (e.g. "/image/abc.png") into the absolute
// path an agent should Read from disk. Kept here because it's the inverse of
// the upload/serve pair.
export function imageUrlToPath(url: string, attachmentsDir: string): string {
  const segment = url.slice("/image/".length);
  return join(attachmentsDir, segment);
}
