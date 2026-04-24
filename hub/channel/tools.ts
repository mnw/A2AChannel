// MCP tool catalog advertised via ListToolsRequestSchema. Pure data — no
// runtime behavior. Keep in sync with the KindModule.toolNames arrays in
// hub/kinds/*.ts (conformance test catches drift).

export const CHATBRIDGE_TOOLS = [
  {
    name: "post",
    description: "Post a free-text message to the shared chat room.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message body" },
        to: {
          type: "string",
          description:
            'Recipient: "you" (human), "<agent-name>" to address a specific peer, or "all" to broadcast.',
        },
      },
      required: ["text", "to"],
    },
  },
  {
    name: "post_file",
    description:
      "Upload a file from your local filesystem and post it as a chat message. The file's extension must match the hub's allowlist (default: jpg, jpeg, png, pdf, md). Returns the absolute filesystem path of the stored attachment (the same path recipients see via the [attachment: ...] marker) — safe to reference in a subsequent send_handoff.context.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path on your local filesystem to the file to upload.",
        },
        to: {
          type: "string",
          description: 'Recipient: "you" (human), "<agent-name>", or "all" (default).',
        },
        caption: {
          type: "string",
          maxLength: 1000,
          description: "Optional text body to accompany the file.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "send_handoff",
    description:
      "Transfer a bounded unit of work to another participant. Returns a handoff_id the recipient will accept or decline.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient agent name (may be the human's configured name).",
        },
        task: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Short description of the work being handed off.",
        },
        context: {
          type: "object",
          description:
            "Optional structured metadata (file refs, PR links, API contracts). Hub accepts up to ~1 MiB serialized, but the effective sender-side ceiling is ~200 KiB ASCII / ~50 KiB unicode-heavy JSON due to Read-tool + tool-call token caps. For larger payloads, post_file the artifact first and reference the returned absolute path here.",
        },
        ttl_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          description: "Time until auto-expiry. Defaults to 3600 (1 hour).",
        },
      },
      required: ["to", "task"],
    },
  },
  {
    name: "accept_handoff",
    description: "Accept a pending handoff addressed to you.",
    inputSchema: {
      type: "object",
      properties: {
        handoff_id: { type: "string", pattern: "^h_[0-9a-f]{16}$" },
        comment: {
          type: "string",
          maxLength: 500,
          description: "Optional note for the sender.",
        },
      },
      required: ["handoff_id"],
    },
  },
  {
    name: "decline_handoff",
    description:
      "Decline a pending handoff addressed to you. A reason is required so the sender can re-route.",
    inputSchema: {
      type: "object",
      properties: {
        handoff_id: { type: "string", pattern: "^h_[0-9a-f]{16}$" },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Why you're declining.",
        },
      },
      required: ["handoff_id", "reason"],
    },
  },
  {
    name: "cancel_handoff",
    description:
      "Withdraw a pending handoff you created. Reason optional. Only the sender (or the human) may cancel.",
    inputSchema: {
      type: "object",
      properties: {
        handoff_id: { type: "string", pattern: "^h_[0-9a-f]{16}$" },
        reason: { type: "string", maxLength: 500 },
      },
      required: ["handoff_id"],
    },
  },
  {
    name: "send_interrupt",
    description:
      "Send a high-visibility attention flag to another participant. The recipient's channel surfaces it prominently; they acknowledge via ack_interrupt when they've read it. Use sparingly — reserve for 'wait, re-read this before continuing' moments, not for regular chat.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient name." },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Short explanation of what the recipient should re-read or reconsider.",
        },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "ack_interrupt",
    description: "Acknowledge a pending interrupt addressed to you.",
    inputSchema: {
      type: "object",
      properties: {
        interrupt_id: { type: "string", pattern: "^i_[0-9a-f]{16}$" },
      },
      required: ["interrupt_id"],
    },
  },
  {
    name: "ack_permission",
    description:
      "Submit a verdict on a pending Claude Code permission request. Any agent may ack any request (the hub accepts the first verdict; later ones are idempotent or rejected with 409). Returns 'verdict_applied=<allow|deny> resolved_by=<agent> your_verdict_won=<true|false>' so delegation logic can tell whether the caller's verdict transitioned the state or arrived after peer/human resolution. Note: this tool itself is permission-gated by Claude Code's local UI unless pre-allowlisted in the acking agent's config.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          type: "string",
          pattern: "^[a-km-zA-KM-Z]{5}$",
          description: "The claude-assigned request_id (5 letters a-z excluding l).",
        },
        behavior: {
          type: "string",
          enum: ["allow", "deny"],
          description: "Verdict. 'allow' lets claude proceed; 'deny' blocks the tool call.",
        },
      },
      required: ["request_id", "behavior"],
    },
  },
] as const;
