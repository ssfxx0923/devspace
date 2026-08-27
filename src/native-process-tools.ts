import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { commandPreview, logEvent } from "./logger.js";
import type { McpToolRegistrationContext } from "./mcp-tool-context.js";
import type { ProcessSnapshot } from "./process-sessions.js";

type ToolContent = { type: "text"; text: string };

const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return { result: z.string(), ...extra };
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): { lines: number; characters: number } {
  const text = content.map((item) => item.text).join("\n");
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function toolWidgetDescriptorMeta(config: ServerConfig) {
  if (config.widgets !== "full") return { _meta: {} };
  return { _meta: { ui: { resourceUri: "ui://devspace/workspace-app.html", visibility: ["model"] as ["model"] } } };
}

function toolResultCardMeta(
  config: ServerConfig,
  tool: string,
  card: Record<string, unknown>,
) {
  if (config.widgets !== "full") return {};
  return { _meta: { tool, card } };
}

function logToolCall(
  config: ServerConfig,
  fields: Record<string, unknown> & { success: boolean; command?: string },
): void {
  if (!config.logging.toolCalls) return;
  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().int().positive(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processToolResponse(
  config: ServerConfig,
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    ...toolResultCardMeta(config, tool, {
      workspaceId,
      summary: { ...summary, ...outputSummary },
      payload: { content },
    }),
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
}

export function registerNativeProcessTools(
  context: McpToolRegistrationContext,
): void {
  const { server, config, workspaces, processSessions } = context;
  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a normal local development shell command from an open workspace. Commands may create, modify, rename, move, or delete files and may use rm, mv, cp, mkdir, git, package managers, generators, formatters, tests, builds, compilers, interpreters, Docker, and project scripts. Returns output when the command exits during the yield window; otherwise returns a sessionId for write_stdin. Shell execution has the authority of the local operating-system user and is not an OS sandbox. Workspace containment applies to structured filesystem tools, not arbitrary shell commands. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      await workspaces.assertWorkspaceContextCurrent(workspace, [cwd]);
      const snapshot = await processSessions.start({
        workspaceId,
        command: cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse(config, "exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().int().positive().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const writableChars = (chars ?? "").replaceAll("\u0003", "");
      if (writableChars.length > 0) {
        const process = processSessions.getInfo(workspaceId, sessionId);
        const cwd = workspaces.resolveWorkingDirectory(workspace, process.workingDirectory);
        await workspaces.assertWorkspaceContextCurrent(workspace, [cwd]);
      }
      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse(config, "write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerAppTool(
    server,
    "list_processes",
    {
      title: "List workspace processes",
      description:
        "List running and recently completed process sessions for an open workspace. Completed sessions remain available for five minutes. Output is not included; use write_stdin with a sessionId to retrieve buffered output.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: resultOutputSchema({
        processes: z.array(z.object({
          sessionId: z.number().int().positive(),
          command: z.string(),
          workingDirectory: z.string(),
          tty: z.boolean(),
          running: z.boolean(),
          startedAt: z.string(),
          finishedAt: z.string().optional(),
          exitCode: z.number().int().optional(),
          signal: z.string().optional(),
          wallTimeMs: z.number().nonnegative(),
        })),
      }),
      ...toolWidgetDescriptorMeta(config),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const processes = processSessions.list(workspaceId);
      const result = processes.length === 0
        ? "No running or recently completed processes for this workspace."
        : processes.map((process) => {
            const status = process.running
              ? "running"
              : process.signal
                ? `signal ${process.signal}`
                : `exit ${process.exitCode ?? "unknown"}`;
            return `#${process.sessionId} ${status}: ${process.command}`;
          }).join("\n");
      const content = [textBlock(result)];
      logToolCall(config, {
        tool: "list_processes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content,
        ...toolResultCardMeta(config, "list_processes", {
          workspaceId,
          summary: { processes: processes.length },
          payload: { content },
        }),
        structuredContent: { result, processes },
      };
    },
  );

  registerAppTool(
    server,
    "terminate_process",
    {
      title: "Terminate process",
      description:
        "Request SIGTERM for one process session owned by an open workspace. Repeating the call for a recently completed process is safe.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        sessionId: z.number().int().positive().describe("Process session identifier returned by exec_command."),
      },
      outputSchema: resultOutputSchema({
        sessionId: z.number().int().positive(),
        running: z.boolean(),
      }),
      ...toolWidgetDescriptorMeta(config),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, sessionId }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const before = processSessions.getInfo(workspaceId, sessionId);
      const process = processSessions.terminate(workspaceId, sessionId);
      const result = before.running
        ? `Termination requested for process session ${sessionId}.`
        : `Process session ${sessionId} has already completed.`;
      const content = [textBlock(result)];
      logToolCall(config, {
        tool: "terminate_process",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content,
        ...toolResultCardMeta(config, "terminate_process", {
          workspaceId,
          summary: {
            sessionId,
            running: process.running,
            exitCode: process.exitCode,
            signal: process.signal,
          },
          payload: { content },
        }),
        structuredContent: { result, sessionId, running: process.running },
      };
    },
  );
}
