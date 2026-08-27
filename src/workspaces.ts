import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type {
  StoredActivatedSkill,
  StoredAgentFile,
  StoredWorkspaceContextState,
  WorkspaceConversationBinding,
  WorkspaceMode,
  WorkspaceStore,
} from "./workspace-store.js";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree } from "./git-worktrees.js";
import {
  AccessDeniedError,
  assertAllowedPath,
  isPathInsideRoot,
  resolveAllowedPath,
} from "./roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  activatedSkillDirs: Set<string>;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  workspaceReused: boolean;
  includeBootstrapContext: boolean;
}

export type WorkspaceContextChangeKind = "added" | "modified" | "deleted";
export type WorkspaceContextItemKind = "instruction" | "skill";

export interface WorkspaceContextChange {
  path: string;
  kind: WorkspaceContextChangeKind;
  contextKind: WorkspaceContextItemKind;
  active: boolean;
}

export interface WorkspaceContextSnapshot {
  workspace: Workspace;
  contextRevision: string;
  refreshedAt: string;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  skills: Array<{
    name: string;
    description: string;
    path: string;
    activated: boolean;
    content?: string;
  }>;
  changes: WorkspaceContextChange[];
}

interface AcceptedWorkspaceContext {
  files: StoredAgentFile[];
  activatedSkills: StoredActivatedSkill[];
  state: StoredWorkspaceContextState;
}

export class WorkspaceContextStaleError extends Error {
  constructor(public readonly paths: string[]) {
    super(
      `Workspace context is stale because active instructions or skills changed: ${paths.join(", ")}. `
        + "Call refresh_workspace_context, review the returned context, and retry.",
    );
    this.name = "WorkspaceContextStaleError";
  }
}

export class UnreadWorkspaceInstructionError extends Error {
  constructor(public readonly paths: string[]) {
    super(
      `Read the applicable instruction ${paths.length === 1 ? "file" : "files"} in full before modifying this path: ${paths.join(", ")}.`,
    );
    this.name = "UnreadWorkspaceInstructionError";
  }
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
}

export interface OpenWorkspaceOptions {
  conversationScopeId?: string;
}

type PathStats = Stats;
type DirectoryOps = {
  stat: (path: string) => Promise<PathStats>;
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly pendingCheckoutOpens = new Map<string, Promise<WorkspaceContext>>();
  private readonly acceptedContexts = new Map<string, AcceptedWorkspaceContext>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(
    input: string | OpenWorkspaceInput,
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceContext> {
    const workspaceInput = typeof input === "string" ? { path: input } : input;
    const conversationScopeId = openOptions.conversationScopeId;
    if (!conversationScopeId || !this.store) {
      return this.openNewWorkspace(workspaceInput);
    }

    const projectKey = await this.conversationProjectKey(workspaceInput);
    const mode = workspaceInput.mode ?? "checkout";
    if (mode === "worktree") {
      const context = await this.openWorktreeWorkspace(workspaceInput.path, workspaceInput.baseRef);
      return {
        ...context,
        // A new worktree always has its own workspace-specific context.
        includeBootstrapContext: true,
      };
    }

    const targetKey = this.conversationCheckoutTargetKey(projectKey);
    const operationKey = JSON.stringify([conversationScopeId, targetKey]);
    const pending = this.pendingCheckoutOpens.get(operationKey);
    if (pending) {
      const context = await pending;
      return {
        ...context,
        workspaceReused: true,
        includeBootstrapContext: false,
      };
    }

    const open = this.openConversationCheckout(
      workspaceInput,
      conversationScopeId,
      targetKey,
    );
    this.pendingCheckoutOpens.set(operationKey, open);

    try {
      return await open;
    } finally {
      if (this.pendingCheckoutOpens.get(operationKey) === open) {
        this.pendingCheckoutOpens.delete(operationKey);
      }
    }
  }

  private async openNewWorkspace(options: OpenWorkspaceInput): Promise<WorkspaceContext> {
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(options.path, options.baseRef);
    }

    return this.openCheckoutWorkspace(options.path);
  }

  private async openConversationCheckout(
    input: OpenWorkspaceInput,
    conversationScopeId: string,
    targetKey: string,
  ): Promise<WorkspaceContext> {
    const binding = this.store?.getConversationBinding(conversationScopeId, targetKey);
    if (binding) {
      const reusableWorkspace = await this.findReusableCheckoutWorkspace(binding);

      if (reusableWorkspace) {
        const context = await this.reusedWorkspaceContext(reusableWorkspace);
        this.store?.touchConversationBinding(conversationScopeId, targetKey);
        return {
          ...context,
          includeBootstrapContext: false,
        };
      }

      this.workspaces.delete(binding.workspaceSessionId);
      this.store?.deleteConversationBinding(conversationScopeId, targetKey);
    }

    const context = await this.openCheckoutWorkspace(input.path);
    this.store?.setConversationBinding({
      conversationScopeId,
      targetKey,
      workspaceSessionId: context.workspace.id,
    });
    return {
      ...context,
      includeBootstrapContext: true,
    };
  }

  private async findReusableCheckoutWorkspace(
    binding: WorkspaceConversationBinding,
  ): Promise<Workspace | undefined> {
    const session = this.store?.getSession(binding.workspaceSessionId);
    if (!session || session.status !== "active" || session.mode !== "checkout") {
      return undefined;
    }

    let root: string;
    try {
      root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
      const rootStats = await stat(root);
      if (!rootStats.isDirectory()) return undefined;
    } catch (error) {
      if (
        error instanceof AccessDeniedError ||
        (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      ) {
        return undefined;
      }

      throw error;
    }

    const workspace = this.getWorkspace(binding.workspaceSessionId);
    if (workspace.mode !== "checkout" || workspace.root !== root) return undefined;
    return workspace;
  }

  private async conversationProjectKey(input: OpenWorkspaceInput): Promise<string> {
    const path = assertAllowedPath(input.path, this.config.allowedRoots);
    return canonicalPath(path);
  }

  private conversationCheckoutTargetKey(projectKey: string): string {
    return JSON.stringify(["checkout", projectKey, null]);
  }

  private async reusedWorkspaceContext(workspace: Workspace): Promise<WorkspaceContext> {
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: true,
      includeBootstrapContext: true,
    };
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session) {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
      activatedSkillDirs: new Set(
        this.store?.getActivatedSkills(workspaceId).map((skill) => skill.baseDir) ?? [],
      ),
    };
    this.loadAcceptedContext(restoredWorkspace.id);
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);

    return restoredWorkspace;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) throw workspaceError;

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }
  }

  async markReadPathLoaded(
    workspace: Workspace,
    readPath: WorkspaceReadPath,
    complete: boolean,
  ): Promise<{ requiresFullRead: boolean }> {
    const isInstruction = isWorkspaceInstructionPath(readPath.absolutePath, workspace.root);
    const isSkillFile = readPath.skillRead?.isSkillFile === true;
    if ((!isInstruction && !isSkillFile) || !complete) {
      return { requiresFullRead: (isInstruction || isSkillFile) && !complete };
    }

    const accepted = this.acceptedContext(workspace.id);
    if (!accepted) return { requiresFullRead: true };

    const previousFiles = accepted.files;
    const previouslyActivated = readPath.skillRead
      ? workspace.activatedSkillDirs.has(resolve(readPath.skillRead.skill.baseDir))
      : false;
    if (isSkillFile && readPath.skillRead) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    } else if (isInstruction) {
      const content = await readFile(readPath.absolutePath, "utf8");
      const now = new Date().toISOString();
      const existing = accepted.files.find((file) => file.path === readPath.absolutePath);
      accepted.files = [
        ...accepted.files.filter((file) => file.path !== readPath.absolutePath),
        {
          path: readPath.absolutePath,
          content,
          contentHash: contentHash(content),
          loadedAt: existing?.loadedAt ?? now,
          lastSeenAt: now,
        },
      ];
    }

    try {
      await this.refreshWorkspaceContext(workspace.id);
    } catch (error) {
      accepted.files = previousFiles;
      if (readPath.skillRead && !previouslyActivated) {
        workspace.activatedSkillDirs.delete(resolve(readPath.skillRead.skill.baseDir));
      }
      throw error;
    }
    return { requiresFullRead: false };
  }

  async initializeWorkspaceContext(context: WorkspaceContext): Promise<void> {
    const now = new Date().toISOString();
    const files = context.agentsFiles.map((file) => storedAgentFile(file, now));
    const available = context.availableAgentsFiles.map((file) => resolve(file.path));
    const skills = skillMetadata(context.workspace);
    const state: StoredWorkspaceContextState = {
      revision: contextRevision(files, [], available, skills),
      availableAgentFiles: available,
      skills,
      refreshedAt: now,
    };
    const accepted = { files, activatedSkills: [], state };
    this.persistAcceptedContext(context.workspace.id, accepted);
    this.acceptedContexts.set(context.workspace.id, accepted);
  }

  async refreshWorkspaceContext(workspaceId: string): Promise<WorkspaceContextSnapshot> {
    const workspace = this.getWorkspace(workspaceId);
    const previous = this.acceptedContext(workspace.id);
    const previousSkills = workspace.skills;
    const previousSkillDiagnostics = workspace.skillDiagnostics;
    const previousActivatedSkillDirs = workspace.activatedSkillDirs;
    const now = new Date().toISOString();
    const loadedSkills = this.loadSkillsForWorkspace(workspace.root);
    workspace.skills = loadedSkills.skills;
    workspace.skillDiagnostics = loadedSkills.skillDiagnostics;
    const initialFiles = await this.loadInitialAgentsFiles(workspace.root);
    const initialPaths = new Set(initialFiles.map((file) => resolve(file.path)));
    const files = initialFiles.map((file) => {
      const existing = previous?.files.find((stored) => stored.path === resolve(file.path));
      return storedAgentFile(file, now, existing?.loadedAt);
    });

    for (const stored of previous?.files ?? []) {
      if (initialPaths.has(stored.path)) continue;
      const current = await readWorkspaceInstruction(stored.path, workspace.root);
      if (!current) continue;
      files.push({
        path: stored.path,
        content: current,
        contentHash: contentHash(current),
        loadedAt: stored.loadedAt,
        lastSeenAt: now,
      });
    }

    const activatedPaths = new Set([
      ...(previous?.activatedSkills.map((skill) => skill.path) ?? []),
      ...workspace.skills
        .filter((skill) => workspace.activatedSkillDirs.has(resolve(skill.baseDir)))
        .map((skill) => resolve(skill.filePath)),
    ]);
    const activatedSkills: StoredActivatedSkill[] = [];
    for (const skill of workspace.skills) {
      const path = resolve(skill.filePath);
      if (!activatedPaths.has(path)) continue;
      const content = await tryReadFile(path);
      if (content === undefined) continue;
      const existing = previous?.activatedSkills.find((stored) => stored.path === path);
      activatedSkills.push({
        path,
        baseDir: resolve(skill.baseDir),
        content,
        contentHash: contentHash(content),
        activatedAt: existing?.activatedAt ?? now,
        lastSeenAt: now,
      });
    }
    workspace.activatedSkillDirs = new Set(activatedSkills.map((skill) => skill.baseDir));

    const loadedFiles = files.map((file) => ({ path: file.path, content: file.content }));
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, loadedFiles);
    const available = availableAgentsFiles.map((file) => resolve(file.path));
    const skills = skillMetadata(workspace);
    const changes = contextChanges(previous, files, activatedSkills, available, skills);
    const state: StoredWorkspaceContextState = {
      revision: contextRevision(files, activatedSkills, available, skills),
      availableAgentFiles: available,
      skills,
      refreshedAt: now,
    };
    const accepted = { files, activatedSkills, state };
    try {
      this.persistAcceptedContext(workspace.id, accepted);
    } catch (error) {
      workspace.skills = previousSkills;
      workspace.skillDiagnostics = previousSkillDiagnostics;
      workspace.activatedSkillDirs = previousActivatedSkillDirs;
      throw error;
    }
    this.acceptedContexts.set(workspace.id, accepted);

    return {
      workspace,
      contextRevision: state.revision,
      refreshedAt: now,
      agentsFiles: loadedFiles,
      availableAgentsFiles,
      skills: workspace.skills.filter((skill) => !skill.disableModelInvocation).map((skill) => {
        const activated = activatedSkills.find((stored) => stored.path === resolve(skill.filePath));
        return {
          name: skill.name,
          description: skill.description,
          path: resolve(skill.filePath),
          activated: activated !== undefined,
          content: activated?.content,
        };
      }),
      changes,
    };
  }

  async assertWorkspaceContextCurrent(
    workspace: Workspace,
    targetPaths: string[] = [],
  ): Promise<void> {
    const accepted = this.acceptedContext(workspace.id);
    if (!accepted) throw new WorkspaceContextStaleError(["context baseline missing"]);

    const changed = new Set<string>();
    const currentInitial = await this.loadInitialAgentsFiles(workspace.root);
    const acceptedInitial = accepted.files.filter((file) =>
      isInitialAgentsFilePath(file.path, workspace.root, this.config.agentDir));
    compareFileSets(acceptedInitial, currentInitial, changed);

    for (const file of accepted.files) {
      if (acceptedInitial.some((initial) => initial.path === file.path)) continue;
      const current = await readWorkspaceInstruction(file.path, workspace.root);
      if (current === undefined || contentHash(current) !== file.contentHash) changed.add(file.path);
    }
    for (const skill of accepted.activatedSkills) {
      const current = await tryReadFile(skill.path);
      if (current === undefined || contentHash(current) !== skill.contentHash) changed.add(skill.path);
    }
    if (changed.size > 0) {
      throw new WorkspaceContextStaleError([...changed].map((path) => formatAgentsPath(path, workspace.root)));
    }

    if (targetPaths.length === 0) return;
    const activeFiles = accepted.files.map((file) => ({ path: file.path, content: file.content }));
    const available = await this.findAvailableAgentsFiles(workspace.root, activeFiles);
    const unread = available
      .map((file) => resolve(file.path))
      .filter((instruction) => targetPaths.some((target) =>
        isPathInsideRoot(resolve(target), dirname(instruction))))
      .map((path) => formatAgentsPath(path, workspace.root));
    if (unread.length > 0) throw new UnreadWorkspaceInstructionError(unread);
  }

  contextState(workspaceId: string): StoredWorkspaceContextState | undefined {
    return this.acceptedContext(workspaceId)?.state;
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const rootStats = await ensureCheckoutWorkspaceRoot(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    return this.createWorkspaceContext({ root, mode: "checkout" });
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomBytes(5).toString("hex")}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      activatedSkillDirs: new Set(),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
    });
    this.workspaces.set(workspace.id, workspace);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);
    const context = {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: false,
      includeBootstrapContext: true,
    };
    await this.initializeWorkspaceContext(context);
    return context;
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }

    return assertAllowedPath(root, this.config.allowedRoots);
  }

  private async loadInitialAgentsFiles(root: string): Promise<LoadedAgentsFile[]> {
    const agentDir = resolve(this.config.agentDir);
    const resolvedRoot = (await tryRealpath(root)) ?? root;
    const resolvedAgentDir = (await tryRealpath(agentDir)) ?? agentDir;
    const loadedFiles: LoadedAgentsFile[] = [];

    for (const file of loadProjectContextFiles({ cwd: root, agentDir })) {
      const path = resolve(file.path);
      if (!isInitialAgentsFilePath(path, root, agentDir)) continue;
      const content = await readResolvedContextFile(
        path,
        file.content,
        resolvedRoot,
        resolvedAgentDir,
      );
      if (content === undefined) continue;

      loadedFiles.push({
        path,
        content,
      });
    }

    return loadedFiles;
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const loadedRealPaths = new Set<string>();
    for (const file of loadedFiles) {
      const realPath = await tryRealpath(file.path);
      if (realPath) loadedRealPaths.add(realPath);
    }
    const discovered: AvailableAgentsFile[] = [];

    await walkWorkspace(root, async (path, entry) => {
      if (!entry.isFile()) return;
      if (!CONTEXT_FILE_NAMES.has(entry.name)) return;
      if (loadedPaths.has(path)) return;
      const realPath = await tryRealpath(path);
      if (realPath && loadedRealPaths.has(realPath)) return;

      discovered.push({ path });
    });

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }

  private acceptedContext(workspaceId: string): AcceptedWorkspaceContext | undefined {
    return this.acceptedContexts.get(workspaceId) ?? this.loadAcceptedContext(workspaceId);
  }

  private loadAcceptedContext(workspaceId: string): AcceptedWorkspaceContext | undefined {
    const state = this.store?.getContextState(workspaceId);
    if (!state) return undefined;
    const accepted = {
      files: this.store?.getLoadedAgentFiles(workspaceId) ?? [],
      activatedSkills: this.store?.getActivatedSkills(workspaceId) ?? [],
      state,
    };
    this.acceptedContexts.set(workspaceId, accepted);
    return accepted;
  }

  private persistAcceptedContext(workspaceId: string, context: AcceptedWorkspaceContext): void {
    this.store?.replaceWorkspaceContext(workspaceId, context);
  }
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function storedAgentFile(
  file: LoadedAgentsFile,
  now: string,
  loadedAt = now,
): StoredAgentFile {
  return {
    path: resolve(file.path),
    content: file.content,
    contentHash: contentHash(file.content),
    loadedAt,
    lastSeenAt: now,
  };
}

function skillMetadata(
  workspace: Workspace,
): Array<{ name: string; description: string; path: string }> {
  return workspace.skills.filter((skill) => !skill.disableModelInvocation).map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: resolve(skill.filePath),
  })).sort((a, b) => a.path.localeCompare(b.path));
}

function contextRevision(
  files: StoredAgentFile[],
  activatedSkills: StoredActivatedSkill[],
  available: string[],
  skills: Array<{ name: string; description: string; path: string }>,
): string {
  const payload = {
    files: files.map((file) => [file.path, file.contentHash]).sort(),
    activatedSkills: activatedSkills.map((skill) => [skill.path, skill.contentHash]).sort(),
    available: [...available].sort(),
    skills,
  };
  return `ctx_${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20)}`;
}

function contextChanges(
  previous: AcceptedWorkspaceContext | undefined,
  files: StoredAgentFile[],
  activatedSkills: StoredActivatedSkill[],
  available: string[],
  skills: Array<{ name: string; description: string; path: string }>,
): WorkspaceContextChange[] {
  const changes: WorkspaceContextChange[] = [];
  compareContextItems(
    previous?.files ?? [],
    files,
    "instruction",
    true,
    changes,
    (item) => item.contentHash,
  );
  compareContextItems(
    previous?.activatedSkills ?? [],
    activatedSkills,
    "skill",
    true,
    changes,
    (item) => item.contentHash,
  );
  compareContextItems(
    (previous?.state.availableAgentFiles ?? []).map((path) => ({ path })),
    available.map((path) => ({ path })),
    "instruction",
    false,
    changes,
    () => "",
  );
  compareContextItems(
    previous?.state.skills ?? [],
    skills,
    "skill",
    false,
    changes,
    (item) => JSON.stringify(item),
  );
  return changes.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}

function compareContextItems<T extends { path: string }>(
  previous: T[],
  current: T[],
  contextKind: WorkspaceContextItemKind,
  active: boolean,
  changes: WorkspaceContextChange[],
  fingerprint: (item: T) => string,
): void {
  const previousByPath = new Map(previous.map((item) => [item.path, item]));
  const currentByPath = new Map(current.map((item) => [item.path, item]));
  for (const [path, item] of currentByPath) {
    const old = previousByPath.get(path);
    if (!old) changes.push({ path, kind: "added", contextKind, active });
    else if (fingerprint(old) !== fingerprint(item)) {
      changes.push({ path, kind: "modified", contextKind, active });
    }
  }
  for (const path of previousByPath.keys()) {
    if (!currentByPath.has(path)) changes.push({ path, kind: "deleted", contextKind, active });
  }
}

function compareFileSets(
  accepted: StoredAgentFile[],
  current: LoadedAgentsFile[],
  changed: Set<string>,
): void {
  const acceptedByPath = new Map(accepted.map((file) => [resolve(file.path), file]));
  const currentByPath = new Map(current.map((file) => [resolve(file.path), file]));
  for (const [path, file] of currentByPath) {
    const stored = acceptedByPath.get(path);
    if (!stored || contentHash(file.content) !== stored.contentHash) changed.add(path);
  }
  for (const path of acceptedByPath.keys()) {
    if (!currentByPath.has(path)) changed.add(path);
  }
}

function isWorkspaceInstructionPath(path: string, root: string): boolean {
  const absolute = resolve(path);
  return isPathInsideRoot(absolute, root)
    && dirname(absolute) !== resolve(root)
    && CONTEXT_FILE_NAMES.has(basename(absolute));
}

async function readWorkspaceInstruction(path: string, root: string): Promise<string | undefined> {
  if (!CONTEXT_FILE_NAMES.has(basename(path))) return undefined;
  try {
    const resolvedPath = await realpath(path);
    if (!isPathInsideRoot(resolvedPath, root)) return undefined;
    return await readFile(resolvedPath, "utf8");
  } catch {
    return undefined;
  }
}

async function tryReadFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function canonicalPath(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }

      const parent = dirname(candidate);
      if (parent === candidate) return path;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function ensureCheckoutWorkspaceRoot(
  path: string,
  ops: DirectoryOps = { stat },
): Promise<PathStats> {
  try {
    return await ops.stat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  throw new Error(`Workspace root does not exist: ${path}`);
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

function isInitialAgentsFilePath(path: string, root: string, agentDir: string): boolean {
  if (isPathInsideRoot(path, agentDir)) return true;
  return isPathInsideRoot(path, root) && dirname(path) === root;
}

async function readResolvedContextFile(
  path: string,
  fallbackContent: string,
  root: string,
  agentDir: string,
): Promise<string | undefined> {
  try {
    const resolvedPath = await realpath(path);
    if (!isInitialAgentsFilePath(resolvedPath, root, agentDir)) return undefined;
    return await readFile(resolvedPath, "utf8");
  } catch {
    return fallbackContent;
  }
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
): Promise<void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        await walkWorkspace(path, visit);
      }
      continue;
    }

    await visit(path, entry);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
