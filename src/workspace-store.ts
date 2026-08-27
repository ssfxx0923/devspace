import { and, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  activatedSkills,
  loadedAgentFiles,
  workspaceConversationBindings,
  workspaceContextStates,
  workspaceSessions,
  type ActivatedSkillRow,
  type LoadedAgentFileRow,
  type WorkspaceContextStateRow,
  type WorkspaceConversationBindingRow,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceConversationBinding {
  conversationScopeId: string;
  targetKey: string;
  workspaceSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface StoredAgentFile {
  path: string;
  contentHash: string;
  content: string;
  loadedAt: string;
  lastSeenAt: string;
}

export interface StoredActivatedSkill {
  path: string;
  baseDir: string;
  contentHash: string;
  content: string;
  activatedAt: string;
  lastSeenAt: string;
}

export interface StoredWorkspaceContextState {
  revision: string;
  availableAgentFiles: string[];
  skills: Array<{ name: string; description: string; path: string }>;
  refreshedAt: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined;
  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding;
  touchConversationBinding(conversationScopeId: string, targetKey: string): void;
  deleteConversationBinding(conversationScopeId: string, targetKey: string): void;
  getLoadedAgentFiles(workspaceSessionId: string): StoredAgentFile[];
  getActivatedSkills(workspaceSessionId: string): StoredActivatedSkill[];
  getContextState(workspaceSessionId: string): StoredWorkspaceContextState | undefined;
  replaceWorkspaceContext(
    workspaceSessionId: string,
    context: {
      files: StoredAgentFile[];
      activatedSkills: StoredActivatedSkill[];
      state: StoredWorkspaceContextState;
    },
  ): void;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined {
    const row = this.database.db
      .select()
      .from(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .get();

    return row ? rowToWorkspaceConversationBinding(row) : undefined;
  }

  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding {
    const now = new Date().toISOString();
    const row = this.database.db
      .insert(workspaceConversationBindings)
      .values({
        conversationScopeId: input.conversationScopeId,
        targetKey: input.targetKey,
        workspaceSessionId: input.workspaceSessionId,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceConversationBindings.conversationScopeId,
          workspaceConversationBindings.targetKey,
        ],
        set: {
          workspaceSessionId: input.workspaceSessionId,
          lastUsedAt: now,
        },
      })
      .returning()
      .get();

    if (!row) {
      throw new Error("Conversation workspace binding upsert returned no row.");
    }

    return rowToWorkspaceConversationBinding(row);
  }

  touchConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .update(workspaceConversationBindings)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  deleteConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .delete(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  getLoadedAgentFiles(workspaceSessionId: string): StoredAgentFile[] {
    return this.database.db
      .select()
      .from(loadedAgentFiles)
      .where(eq(loadedAgentFiles.workspaceSessionId, workspaceSessionId))
      .all()
      .map(rowToStoredAgentFile);
  }

  getActivatedSkills(workspaceSessionId: string): StoredActivatedSkill[] {
    return this.database.db
      .select()
      .from(activatedSkills)
      .where(eq(activatedSkills.workspaceSessionId, workspaceSessionId))
      .all()
      .map(rowToStoredActivatedSkill);
  }

  getContextState(workspaceSessionId: string): StoredWorkspaceContextState | undefined {
    const row = this.database.db
      .select()
      .from(workspaceContextStates)
      .where(eq(workspaceContextStates.workspaceSessionId, workspaceSessionId))
      .get();
    return row ? rowToStoredWorkspaceContextState(row) : undefined;
  }

  replaceWorkspaceContext(
    workspaceSessionId: string,
    context: {
      files: StoredAgentFile[];
      activatedSkills: StoredActivatedSkill[];
      state: StoredWorkspaceContextState;
    },
  ): void {
    this.database.sqlite.transaction(() => {
      this.database.db
        .delete(loadedAgentFiles)
        .where(eq(loadedAgentFiles.workspaceSessionId, workspaceSessionId))
        .run();
      for (const file of context.files) {
        this.database.db.insert(loadedAgentFiles).values({
          workspaceSessionId,
          path: file.path,
          contentHash: file.contentHash,
          content: file.content,
          loadedAt: file.loadedAt,
          lastSeenAt: file.lastSeenAt,
        }).run();
      }

      this.database.db
        .delete(activatedSkills)
        .where(eq(activatedSkills.workspaceSessionId, workspaceSessionId))
        .run();
      for (const skill of context.activatedSkills) {
        this.database.db.insert(activatedSkills).values({
          workspaceSessionId,
          path: skill.path,
          baseDir: skill.baseDir,
          contentHash: skill.contentHash,
          content: skill.content,
          activatedAt: skill.activatedAt,
          lastSeenAt: skill.lastSeenAt,
        }).run();
      }

      this.database.db.insert(workspaceContextStates).values({
        workspaceSessionId,
        revision: context.state.revision,
        availableAgentFilesJson: JSON.stringify(context.state.availableAgentFiles),
        skillsJson: JSON.stringify(context.state.skills),
        refreshedAt: context.state.refreshedAt,
      }).onConflictDoUpdate({
        target: workspaceContextStates.workspaceSessionId,
        set: {
          revision: context.state.revision,
          availableAgentFilesJson: JSON.stringify(context.state.availableAgentFiles),
          skillsJson: JSON.stringify(context.state.skills),
          refreshedAt: context.state.refreshedAt,
        },
      }).run();
    })();
  }

  close(): void {
    this.database.close();
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToWorkspaceConversationBinding(
  row: WorkspaceConversationBindingRow,
): WorkspaceConversationBinding {
  return {
    conversationScopeId: row.conversationScopeId,
    targetKey: row.targetKey,
    workspaceSessionId: row.workspaceSessionId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToStoredAgentFile(row: LoadedAgentFileRow): StoredAgentFile {
  return {
    path: row.path,
    contentHash: row.contentHash,
    content: row.content,
    loadedAt: row.loadedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function rowToStoredActivatedSkill(row: ActivatedSkillRow): StoredActivatedSkill {
  return {
    path: row.path,
    baseDir: row.baseDir,
    contentHash: row.contentHash,
    content: row.content,
    activatedAt: row.activatedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function rowToStoredWorkspaceContextState(
  row: WorkspaceContextStateRow,
): StoredWorkspaceContextState {
  return {
    revision: row.revision,
    availableAgentFiles: parseJsonArray(row.availableAgentFilesJson),
    skills: parseJsonArray(row.skillsJson),
    refreshedAt: row.refreshedAt,
  };
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}
