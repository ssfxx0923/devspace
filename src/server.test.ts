import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer, serverInstructions } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.equal("agentProviders" in firstStructured, false);
  assert.equal("agents" in firstStructured, false);
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const repeatedText = responseText(repeated);
  assert.match(repeatedText, /Workspace already open as/);
  assert.match(repeatedText, /same checkout previously opened/);
  assert.match(repeatedText, /Reuse this workspaceId for subsequent tool calls/);
  assert.match(repeatedText, /previously provided for this workspace/);
  assert.match(repeatedText, /not repeated here/);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.equal("agentProviders" in card, false);
  assert.equal("agents" in card, false);
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("new worktrees always receive a fresh workspace and complete worktree context", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const secondWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.notEqual(structuredContent(firstWorktree).workspaceId, structuredContent(secondWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  for (const result of [firstWorktree, secondWorktree]) {
    const structured = structuredContent(result);
    assert.equal(structured.mode, "worktree");
    assert.ok(Array.isArray(structured.agentsFiles));
    assert.ok(Array.isArray(structured.availableAgentsFiles));
    assert.ok(Array.isArray(structured.skills));
    assert.equal("agentProviders" in structured, false);
    assert.equal("agents" in structured, false);
    assert.ok(Array.isArray(structured.skillDiagnostics));
    assert.match(responseText(result), /Opened isolated worktree workspace/);
  }
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same checkout previously opened/);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same checkout previously opened/);
});

test("a host without conversation metadata receives normal explicit-workspace behavior", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.notEqual(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout reuse and context suppression survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
    assert.match(responseText(restored), /same checkout previously opened/);
  } finally {
    await closeRestored();
  }
});

test("the server exposes only the native coding runtime tool surface", async (t) => {
  const context = await fixture(t);
  const tools = await context.client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, [
    "apply_patch",
    "exec_command",
    "glob",
    "grep",
    "list_processes",
    "ls",
    "open_workspace",
    "read",
    "refresh_workspace_context",
    "terminate_process",
    "write_stdin",
  ]);
  for (const legacyName of ["bash", "write", "edit"]) {
    assert.equal(names.includes(legacyName), false);
  }

  const execCommand = tools.tools.find((tool) => tool.name === "exec_command");
  const refreshContext = tools.tools.find((tool) => tool.name === "refresh_workspace_context");
  const listProcesses = tools.tools.find((tool) => tool.name === "list_processes");
  const terminateProcess = tools.tools.find((tool) => tool.name === "terminate_process");
  assert.ok(execCommand?.description);
  assert.match(execCommand.description, /may create, modify, rename, move, or delete files/i);
  assert.match(execCommand.description, /rm, mv, cp, mkdir/i);
  assert.match(execCommand.description, /not an OS sandbox/i);
  assert.doesNotMatch(execCommand.description, /must not modify project files/i);
  assert.doesNotMatch(execCommand.description, /do not create or modify files/i);
  assert.equal(
    ((execCommand.outputSchema as { required?: string[] } | undefined)?.required ?? [])
      .includes("sessionId"),
    true,
  );
  assert.equal(refreshContext?.annotations?.readOnlyHint, false);
  assert.match(refreshContext?.description ?? "", /complete recoverable context snapshot/i);
  assert.match(listProcesses?.description ?? "", /five minutes/i);
  assert.equal(terminateProcess?.annotations?.idempotentHint, true);

  const instructions = serverInstructions(context.config);
  assert.match(instructions, /The MCP host is the coding agent/i);
  assert.match(instructions, /Shell commands may create, modify, rename, move, or delete project files/i);
  assert.match(instructions, /not an OS sandbox/i);
  assert.doesNotMatch(instructions, /all file modifications/i);
  assert.doesNotMatch(instructions, /Do not create or modify files/i);
});

test("refresh_workspace_context recovers a stale workspace before commands resume", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-context-refresh");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const originalRevision = String(structuredContent(opened).contextRevision);
  assert.equal(structuredContent(opened).contextStatus, "current");

  await writeFile(join(context.project, "AGENTS.md"), "updated project instructions\n");
  const reopened = await callOpen(context.client, context.project, "chat-context-refresh");
  assert.equal(structuredContent(reopened).contextStatus, "refresh_required");
  const blocked = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      yieldTimeMs: 2_000,
    },
  });
  assert.equal(blocked.isError, true);
  assert.match(responseText(blocked), /workspace context is stale/i);
  assert.match(responseText(blocked), /refresh_workspace_context/i);

  const refreshed = await context.client.callTool({
    name: "refresh_workspace_context",
    arguments: { workspaceId },
  });
  assert.notEqual(structuredContent(refreshed).contextRevision, originalRevision);
  assert.equal(
    (structuredContent(refreshed).agentsFiles as Array<{ path: string; content: string }>)
      .some((file) => file.path === "AGENTS.md" && /updated project/.test(file.content)),
    true,
  );
  assert.equal(
    (structuredContent(refreshed).changes as Array<Record<string, unknown>>)
      .some((change) => change.path === "AGENTS.md" && change.kind === "modified"),
    true,
  );
  assert.equal(responseCard(refreshed).contextStatus, "current");
  assert.equal(responseCard(refreshed).contextRevision, structuredContent(refreshed).contextRevision);

  const retried = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "console.log('context-current')"`,
      yieldTimeMs: 2_000,
    },
  });
  assert.notEqual(retried.isError, true);
  assert.equal(typeof structuredContent(retried).sessionId, "number");
  assert.equal(structuredContent(retried).running, false);
  assert.match(responseText(retried), /context-current/);
});

test("nested instruction scope blocks patches until the instruction is read in full", async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.project, "nested"));
  await writeFile(join(context.project, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(context.project, "nested", "file.txt"), "old\n");
  const opened = await callOpen(context.client, context.project, "chat-nested-context");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const patch = [
    "*** Begin Patch",
    "*** Update File: nested/file.txt",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  const blocked = await context.client.callTool({
    name: "apply_patch",
    arguments: { workspaceId, patch },
  });
  assert.equal(blocked.isError, true);
  assert.match(responseText(blocked), /read the applicable instruction file/i);
  assert.match(responseText(blocked), /nested\/AGENTS\.md/);
  const blockedCommand = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      workingDirectory: "nested",
      yieldTimeMs: 2_000,
    },
  });
  assert.equal(blockedCommand.isError, true);
  assert.match(responseText(blockedCommand), /nested\/AGENTS\.md/);

  const partial = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "nested/AGENTS.md", limit: 1 },
  });
  assert.match(String(structuredContent(partial).result), /only read partially and is not active yet/i);
  const stillBlocked = await context.client.callTool({
    name: "apply_patch",
    arguments: { workspaceId, patch },
  });
  assert.equal(stillBlocked.isError, true);

  const complete = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "nested/AGENTS.md" },
  });
  assert.doesNotMatch(String(structuredContent(complete).result), /not active yet/i);
  const applied = await context.client.callTool({
    name: "apply_patch",
    arguments: { workspaceId, patch },
  });
  assert.notEqual(applied.isError, true);
  assert.equal(await readFile(join(context.project, "nested", "file.txt"), "utf8"), "new\n");
});

test("process tools rediscover, terminate, and retain workspace-owned sessions", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-processes");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);

  const foreground = await context.client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: `${node} -e "process.exit(0)"`, yieldTimeMs: 2_000 },
  });
  assert.equal(structuredContent(foreground).running, false);
  assert.equal(typeof structuredContent(foreground).sessionId, "number");

  const background = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${node} -e "setInterval(() => {}, 1000)"`,
      yieldTimeMs: 5,
    },
  });
  assert.equal(structuredContent(background).running, true);
  const sessionId = Number(structuredContent(background).sessionId);

  const listed = await context.client.callTool({
    name: "list_processes",
    arguments: { workspaceId },
  });
  const processes = structuredContent(listed).processes as Array<Record<string, unknown>>;
  assert.equal(processes.some((process) =>
    process.sessionId === sessionId && process.running === true), true);
  assert.equal(processes.some((process) =>
    process.sessionId === structuredContent(foreground).sessionId
    && process.running === false), true);

  const termination = await context.client.callTool({
    name: "terminate_process",
    arguments: { workspaceId, sessionId },
  });
  assert.match(responseText(termination), /termination requested/i);
  const completed = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, sessionId, yieldTimeMs: 2_000 },
  });
  assert.equal(structuredContent(completed).running, false);

  const repeated = await context.client.callTool({
    name: "terminate_process",
    arguments: { workspaceId, sessionId },
  });
  assert.equal(structuredContent(repeated).running, false);
  assert.match(responseText(repeated), /already completed/i);
});

test("stale context blocks process input but still permits polling and Ctrl-C", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-stale-process");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const running = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "process.stdin.resume(); setInterval(() => {}, 1000)"`,
      yieldTimeMs: 5,
    },
  });
  const sessionId = Number(structuredContent(running).sessionId);
  assert.equal(structuredContent(running).running, true);

  await writeFile(join(context.project, "AGENTS.md"), "stale while running\n");
  const polled = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, sessionId, yieldTimeMs: 1 },
  });
  assert.notEqual(polled.isError, true);
  assert.equal(structuredContent(polled).running, true);

  const blockedInput = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, sessionId, chars: "unsafe input\n", yieldTimeMs: 1 },
  });
  assert.equal(blockedInput.isError, true);
  assert.match(responseText(blockedInput), /workspace context is stale/i);

  const interrupted = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, sessionId, chars: "\u0003", yieldTimeMs: 2_000 },
  });
  assert.notEqual(interrupted.isError, true);
  assert.equal(structuredContent(interrupted).running, false);
});

test("changes widget mode keeps ordinary tools data-only and reserves UI for checkpoints", async (t) => {
  const context = await fixture(t, { git: true, widgets: "changes" });
  const tools = await context.client.listTools();
  const openWorkspace = tools.tools.find((tool) => tool.name === "open_workspace");
  const refreshContext = tools.tools.find((tool) => tool.name === "refresh_workspace_context");
  const read = tools.tools.find((tool) => tool.name === "read");
  const execCommand = tools.tools.find((tool) => tool.name === "exec_command");
  const showChanges = tools.tools.find((tool) => tool.name === "show_changes");

  assert.ok(widgetResourceUri(openWorkspace));
  assert.ok(widgetResourceUri(refreshContext));
  assert.ok(widgetResourceUri(showChanges));
  assert.equal(widgetResourceUri(read), undefined);
  assert.equal(widgetResourceUri(execCommand), undefined);

  const opened = await callOpen(context.client, context.project, "chat-checkpoint-ui");
  const workspaceId = String(structuredContent(opened).workspaceId);
  assert.ok(responseCardOptional(opened));

  const readResult = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
  });
  assert.equal(responseCardOptional(readResult), undefined);

  const checkpoint = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  assert.ok(responseCardOptional(checkpoint));
});

test("configured file sharing exposes share_file and instructs the host to use returned URLs", async (t) => {
  const context = await fixture(t, { fileShare: true });
  const tools = await context.client.listTools();
  const shareFile = tools.tools.find((tool) => tool.name === "share_file");
  const openWorkspace = tools.tools.find((tool) => tool.name === "open_workspace");

  assert.ok(shareFile);
  assert.match(shareFile.description ?? "", /arbitrary binary files/i);
  assert.match(shareFile.description ?? "", /returned URL is public/i);
  assert.match(openWorkspace?.description ?? "", /use share_file/i);

  const instructions = serverInstructions(context.config);
  assert.match(instructions, /use share_file/i);
  assert.match(instructions, /images, PDFs, archives, media, or arbitrary binary files/i);
  assert.match(instructions, /returned public URL/i);

  const opened = await callOpen(context.client, context.project, "chat-file-share");
  assert.match(String(structuredContent(opened).instruction ?? ""), /use share_file/i);
  assert.match(String(structuredContent(opened).instruction ?? ""), /Do not use read, base64/i);
});

test("file sharing stays absent when it is not configured", async (t) => {
  const context = await fixture(t);
  const tools = await context.client.listTools();

  assert.equal(tools.tools.some((tool) => tool.name === "share_file"), false);
  assert.doesNotMatch(serverInstructions(context.config), /use share_file/i);
});

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  close: () => Promise<void>;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    widgets?: "off" | "changes" | "full";
    fileShare?: boolean;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: options.widgets ?? "full",
    ...(options.fileShare
      ? {
          DEVSPACE_FILE_SHARE_BUCKET: "devspace-transfer",
          DEVSPACE_FILE_SHARE_BASE_URL: "https://public.example.r2.dev",
          DEVSPACE_FILE_SHARE_WRANGLER_AUTH: "oauth",
        }
      : {}),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, close };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const card = responseCardOptional(result);
  assert.ok(card);
  return card;
}

function responseCardOptional(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> | undefined {
  const metadata = result._meta;
  if (!metadata || typeof metadata !== "object") return undefined;
  const card = (metadata as Record<string, unknown>).card;
  return card && typeof card === "object" ? card as Record<string, unknown> : undefined;
}

function widgetResourceUri(tool: { _meta?: unknown } | undefined): string | undefined {
  if (!tool?._meta || typeof tool._meta !== "object") return undefined;
  const ui = (tool._meta as Record<string, unknown>).ui;
  if (!ui || typeof ui !== "object") return undefined;
  const resourceUri = (ui as Record<string, unknown>).resourceUri;
  return typeof resourceUri === "string" ? resourceUri : undefined;
}
