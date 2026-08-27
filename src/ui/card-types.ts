import type { App } from "@modelcontextprotocol/ext-apps";

export type ToolName =
  | "open_workspace"
  | "refresh_workspace_context"
  | "show_changes"
  | "apply_patch"
  | "exec_command"
  | "write_stdin"
  | "list_processes"
  | "terminate_process"
  | "read"
  | "grep"
  | "glob"
  | "ls";

export type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

export type PatchOperation = "add" | "update" | "delete" | "move";
export type ReviewFileType =
  | "change"
  | "rename-pure"
  | "rename-changed"
  | "new"
  | "deleted";

export interface ToolResultCard {
  tool: ToolName;
  workspaceId?: string;
  path?: string;
  root?: string;
  workspaceReused?: boolean;
  includeBootstrapContext?: boolean;
  mode?: "checkout" | "worktree";
  sourceRoot?: string;
  worktree?: {
    path?: string;
    baseRef?: string;
    baseSha?: string;
    dirtySource?: boolean;
    detached?: boolean;
    managed?: boolean;
  };
  status?: string;
  contextRevision?: string;
  contextStatus?: "current" | "refresh_required";
  refreshedAt?: string;
  summary?: Record<string, unknown>;
  files?: Array<{
    path?: string;
    previousPath?: string;
    operation?: PatchOperation;
    type?: ReviewFileType;
    additions?: number;
    removals?: number;
  }>;
  payload?: ToolPayload;
  agentsFiles?: Array<{
    path?: string;
    content?: string;
  }>;
  availableAgentsFiles?: Array<{
    path?: string;
  }>;
  skills?: Array<{
    name?: string;
    description?: string;
    path?: string;
    activated?: boolean;
    content?: string;
  }>;
  changes?: Array<{
    path?: string;
    kind?: "added" | "modified" | "deleted";
    contextKind?: "instruction" | "skill";
    active?: boolean;
  }>;
  instruction?: string;
}

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolPayload {
  content?: ToolContent[];
  diff?: string;
  patch?: string;
}

export function isToolName(value: unknown): value is ToolName {
  return (
    value === "open_workspace" ||
    value === "refresh_workspace_context" ||
    value === "show_changes" ||
    value === "apply_patch" ||
    value === "exec_command" ||
    value === "write_stdin" ||
    value === "list_processes" ||
    value === "terminate_process" ||
    value === "read" ||
    value === "grep" ||
    value === "glob" ||
    value === "ls"
  );
}

export function isReadTool(tool: ToolName): boolean {
  return tool === "read";
}

export function isPatchTool(tool: ToolName): boolean {
  return tool === "apply_patch";
}

export function isSearchTool(tool: ToolName): boolean {
  return tool === "grep" || tool === "glob";
}

export function isShellTool(tool: ToolName): boolean {
  return tool === "exec_command" || tool === "write_stdin";
}

export function isReviewTool(tool: ToolName): boolean {
  return tool === "show_changes";
}

export function isWorkspaceTool(tool: ToolName): boolean {
  return tool === "open_workspace" || tool === "refresh_workspace_context";
}

export function isToolResultCard(value: unknown): value is Omit<ToolResultCard, "tool"> {
  return Boolean(value && typeof value === "object");
}

export function payloadText(payload: ToolPayload | undefined): string {
  return (
    payload?.content
      ?.map((item) => {
        if (item.type === "text") return item.text ?? "";
        return `[${item.mimeType ?? "image"} image payload]`;
      })
      .filter(Boolean)
      .join("\n\n") ?? ""
  );
}

export function summaryNumber(
  summary: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isExpandableCard(card: ToolResultCard): boolean {
  if (isWorkspaceTool(card.tool)) {
    return (
      Number(card.summary?.agentsFiles ?? 0) > 0 ||
      Number(card.summary?.skills ?? 0) > 0 ||
      Boolean(card.agentsFiles?.length) ||
      Boolean(card.availableAgentsFiles?.length) ||
      Boolean(card.skills?.length) ||
      Boolean(card.worktree) ||
      Boolean(card.contextRevision) ||
      Boolean(card.contextStatus) ||
      Boolean(card.changes?.length) ||
      Boolean(card.instruction)
    );
  }

  if (isReviewTool(card.tool)) return Boolean(card.files?.length || card.payload?.patch);
  if (isPatchTool(card.tool)) return Boolean(card.payload?.patch);

  return Boolean(card.payload);
}

export function isInitiallyExpandedCard(card: ToolResultCard): boolean {
  if (isWorkspaceTool(card.tool)) return isExpandableCard(card);
  if (isReviewTool(card.tool)) return isExpandableCard(card);
  if (isPatchTool(card.tool)) {
    return card.files?.length === 1 && isExpandableCard(card);
  }
  return false;
}
