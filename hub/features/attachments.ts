// File upload + serve. Allowlist + max size are env-resolved at hub startup and captured in closure.

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
