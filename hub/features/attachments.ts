// Attachments feature — file upload + serve.
// Carved out of hub.ts inline routes in architecture-cycle-2a §4.
//
// Upload extension allowlist + max size are env-resolved at hub startup; the factory
// captures them in closure so handlers don't re-derive them per request.

import type { HubFeature } from "../core/types";
import { handleUpload, handleImage } from "../core/attachments";

export type AttachmentsDeps = {
  attachmentsDir: string;
  allowedExtensions: Set<string>;
  imageMaxBytes: number;
};

export function createAttachmentsFeature(deps: AttachmentsDeps): HubFeature {
  return {
    routes: [
      {
        method: "POST",
        path: "/upload",
        auth: "mutating",
        bodyMax: deps.imageMaxBytes + 64 * 1024,
        handler: (req) => handleUpload(req, deps.attachmentsDir, deps.allowedExtensions),
      },
      {
        method: "GET",
        path: /^\/image\/(.+)$/,
        auth: "read",
        handler: (_req, _cap, params) => handleImage(params.id, deps.attachmentsDir),
      },
    ],
  };
}
