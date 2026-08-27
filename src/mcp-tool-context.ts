import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import type { IncomingArtifactAdapter } from "./incoming-artifacts.js";
import type { ProcessSessionManager } from "./process-sessions.js";
import type { createReviewCheckpointManager } from "./review-checkpoints.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export interface McpToolRegistrationContext {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>;
  processSessions: ProcessSessionManager;
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[];
}
