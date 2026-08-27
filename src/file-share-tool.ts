import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { shareFileToR2 } from "./file-share.js";
import { logEvent } from "./logger.js";
import type { McpToolRegistrationContext } from "./mcp-tool-context.js";

const FILE_SHARE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export function registerFileShareTool(
  context: McpToolRegistrationContext,
): void {
  const { server, config, workspaces } = context;
  const fileShare = config.fileShare;
  if (!fileShare) return;

  registerAppTool(
    server,
    "share_file",
    {
      title: "Share file",
      description:
        "Upload a regular file from an open workspace to the configured temporary public file-sharing store and return a URL that the MCP host or ChatGPT can fetch. Use this for images, PDFs, archives, media, and arbitrary binary files when a local path is not directly accessible to the host. The file must resolve inside the workspace root. The returned URL is public until the remote storage removes it.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("Path to the local file, relative to the workspace root or an absolute path inside it."),
        contentType: z
          .string()
          .optional()
          .describe("Optional MIME type override. By default DevSpace infers a MIME type from the filename."),
      },
      outputSchema: {
        result: z.string(),
        url: z.string().url(),
        key: z.string(),
        path: z.string(),
        bytes: z.number().int().nonnegative(),
        mimeType: z.string(),
      },
      _meta: {},
      annotations: FILE_SHARE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, path, contentType }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const absolutePath = workspaces.resolvePath(workspace, path);
      const shared = await shareFileToR2({
        config: fileShare,
        workspaceRoot: workspace.root,
        absolutePath,
        contentType,
      });
      const result = [
        `Shared ${path} (${shared.bytes} bytes, ${shared.mimeType}).`,
        shared.url,
      ].join("\n");

      if (config.logging.toolCalls) {
        logEvent(config.logging, "info", "tool_call", {
          tool: "share_file",
          workspaceId,
          path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }

      return {
        content: [{ type: "text" as const, text: result }],
        structuredContent: {
          result,
          url: shared.url,
          key: shared.key,
          path,
          bytes: shared.bytes,
          mimeType: shared.mimeType,
        },
      };
    },
  );
}
