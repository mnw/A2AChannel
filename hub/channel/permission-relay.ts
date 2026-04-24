// Claude Code permission-relay — forwards `notifications/claude/channel/permission_request`
// notifications to the hub's /permissions route. The hub broadcasts permission.new
// events, which the tail handler sees and surfaces to the room; ack_permission
// closes the loop by POSTing a verdict back. Claude Code 2.1.81+ recognizes the
// claude/channel/permission capability advertised at Server construction.

import { z } from "zod";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { authedPost } from "./hub-client";

export const PermissionRequestSchema = NotificationSchema.extend({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z
    .object({
      request_id: z.string().regex(/^[a-km-z]{5}$/i),
      tool_name: z.string().min(1).max(120),
      description: z.string().max(2_000),
      input_preview: z.string().max(8_000),
    })
    .passthrough(),
});

export type PermissionRelayContext = {
  agent: string;
  hubEnv: string;
};

// Build the notification handler. Wiring happens in hub/channel.ts via
// mcp.setNotificationHandler(PermissionRequestSchema, handlePermissionRequest(ctx)).
export function handlePermissionRequest(ctx: PermissionRelayContext) {
  return async (notification: z.infer<typeof PermissionRequestSchema>): Promise<void> => {
    const { request_id, tool_name, description, input_preview } = notification.params;
    try {
      const resp = await authedPost(ctx.hubEnv, "/permissions", {
        agent: ctx.agent,
        request_id,
        tool_name,
        description: description ?? "",
        input_preview: input_preview ?? "",
      });
      if (resp.status < 200 || resp.status >= 300) {
        // Don't retry — upstream keeps the local dialog open, human can still answer there.
        console.error(
          `[channel] permission_request ${request_id} POST failed: ${resp.status} ${resp.body}`,
        );
      }
    } catch (e) {
      console.error(`[channel] permission_request ${request_id} relay error:`, e);
    }
  };
}
