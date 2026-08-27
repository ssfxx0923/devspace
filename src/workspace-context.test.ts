import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import {
  UnreadWorkspaceInstructionError,
  WorkspaceContextStaleError,
  WorkspaceRegistry,
} from "./workspaces.js";

test("workspace context must be refreshed after active instructions change", async (t) => {
  const fixture = await contextFixture(t);
  const store = new SqliteWorkspaceStore(fixture.stateDir);
  t.after(() => store.close());
  const registry = new WorkspaceRegistry(fixture.config, store);
  const opened = await registry.openWorkspace(fixture.project);
  const workspace = opened.workspace;
  const originalRevision = registry.contextState(workspace.id)?.revision;

  assert.match(originalRevision ?? "", /^ctx_[a-f0-9]{20}$/);
  await registry.assertWorkspaceContextCurrent(workspace, [fixture.project]);

  await writeFile(join(fixture.project, "AGENTS.md"), "updated root instructions\n");
  await assert.rejects(
    () => registry.assertWorkspaceContextCurrent(workspace, [fixture.project]),
    (error: unknown) =>
      error instanceof WorkspaceContextStaleError
      && error.paths.includes("AGENTS.md"),
  );

  const refreshed = await registry.refreshWorkspaceContext(workspace.id);
  assert.notEqual(refreshed.contextRevision, originalRevision);
  assert.equal(
    refreshed.changes.some((change) =>
      change.path === join(fixture.project, "AGENTS.md")
      && change.kind === "modified"
      && change.contextKind === "instruction"
      && change.active),
    true,
  );
  await registry.assertWorkspaceContextCurrent(workspace, [fixture.project]);

  const addedSkillDir = join(fixture.root, "skills", "added-after-open");
  await mkdir(addedSkillDir);
  const addedSkillPath = join(addedSkillDir, "SKILL.md");
  await writeFile(addedSkillPath, skillContent("Discovered during refresh.", "added-after-open"));
  const skillsRefreshed = await registry.refreshWorkspaceContext(workspace.id);
  assert.equal(
    skillsRefreshed.skills.some((skill) => skill.name === "added-after-open"),
    true,
  );
  assert.equal(
    skillsRefreshed.changes.some((change) =>
      change.path === addedSkillPath
      && change.kind === "added"
      && change.contextKind === "skill"
      && !change.active),
    true,
  );
});

test("nested instructions require a full read and remain part of the accepted context", async (t) => {
  const fixture = await contextFixture(t);
  const store = new SqliteWorkspaceStore(fixture.stateDir);
  t.after(() => store.close());
  const registry = new WorkspaceRegistry(fixture.config, store);
  const { workspace } = await registry.openWorkspace(fixture.project);
  const nestedTarget = join(fixture.project, "nested", "file.txt");
  const instruction = registry.resolveReadPath(workspace, "nested/AGENTS.md");

  await assert.rejects(
    () => registry.assertWorkspaceContextCurrent(workspace, [nestedTarget]),
    (error: unknown) => error instanceof UnreadWorkspaceInstructionError,
  );

  assert.deepEqual(
    await registry.markReadPathLoaded(workspace, instruction, false),
    { requiresFullRead: true },
  );
  await assert.rejects(
    () => registry.assertWorkspaceContextCurrent(workspace, [nestedTarget]),
    (error: unknown) => error instanceof UnreadWorkspaceInstructionError,
  );

  assert.deepEqual(
    await registry.markReadPathLoaded(workspace, instruction, true),
    { requiresFullRead: false },
  );
  await registry.assertWorkspaceContextCurrent(workspace, [nestedTarget]);

  await writeFile(join(fixture.project, "nested", "AGENTS.md"), "changed nested instructions\n");
  await assert.rejects(
    () => registry.assertWorkspaceContextCurrent(workspace, [nestedTarget]),
    (error: unknown) =>
      error instanceof WorkspaceContextStaleError
      && error.paths.includes("nested/AGENTS.md"),
  );
});

test("activated skills and accepted context survive a registry restart", async (t) => {
  const fixture = await contextFixture(t);
  const firstStore = new SqliteWorkspaceStore(fixture.stateDir);
  const firstRegistry = new WorkspaceRegistry(fixture.config, firstStore);
  const { workspace } = await firstRegistry.openWorkspace(fixture.project);
  const skill = workspace.skills.find((candidate) => candidate.name === "context-test");
  assert.ok(skill);

  const skillRead = firstRegistry.resolveReadPath(workspace, skill.filePath);
  await firstRegistry.markReadPathLoaded(workspace, skillRead, true);
  assert.equal(workspace.activatedSkillDirs.has(skill.baseDir), true);
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(fixture.stateDir);
  t.after(() => secondStore.close());
  const restoredRegistry = new WorkspaceRegistry(fixture.config, secondStore);
  const restored = restoredRegistry.getWorkspace(workspace.id);
  assert.equal(restored.activatedSkillDirs.has(skill.baseDir), true);
  await restoredRegistry.assertWorkspaceContextCurrent(restored, [fixture.project]);

  await writeFile(skill.filePath, skillContent("Updated skill instructions."));
  await assert.rejects(
    () => restoredRegistry.assertWorkspaceContextCurrent(restored, [fixture.project]),
    (error: unknown) =>
      error instanceof WorkspaceContextStaleError
      && error.paths.includes(skill.filePath),
  );

  const refreshed = await restoredRegistry.refreshWorkspaceContext(restored.id);
  const refreshedSkill = refreshed.skills.find((candidate) => candidate.name === "context-test");
  assert.equal(refreshedSkill?.activated, true);
  assert.match(refreshedSkill?.content ?? "", /Updated skill instructions/);
  assert.equal(
    refreshed.changes.some((change) =>
      change.path === skill.filePath
      && change.kind === "modified"
      && change.contextKind === "skill"
      && change.active),
    true,
  );
});

test("a restored legacy workspace without a context baseline must refresh before mutation", async (t) => {
  const fixture = await contextFixture(t);
  const store = new SqliteWorkspaceStore(fixture.stateDir);
  t.after(() => store.close());
  store.createSession({ id: "ws_legacy", root: fixture.project, mode: "checkout" });
  const registry = new WorkspaceRegistry(fixture.config, store);
  const workspace = registry.getWorkspace("ws_legacy");

  assert.equal(registry.contextState(workspace.id), undefined);
  await assert.rejects(
    () => registry.assertWorkspaceContextCurrent(workspace, [fixture.project]),
    (error: unknown) =>
      error instanceof WorkspaceContextStaleError
      && error.paths.includes("context baseline missing"),
  );

  const refreshed = await registry.refreshWorkspaceContext(workspace.id);
  assert.match(refreshed.contextRevision, /^ctx_[a-f0-9]{20}$/);
  await registry.assertWorkspaceContextCurrent(workspace, [fixture.project]);
});

async function contextFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-context-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const skillDir = join(root, "skills", "context-test");
  const stateDir = join(root, ".state");
  await mkdir(join(project, "nested"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "root instructions\n");
  await writeFile(join(project, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(project, "nested", "file.txt"), "old\n");
  await writeFile(join(skillDir, "SKILL.md"), skillContent("Initial skill instructions."));

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: join(root, "skills"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });

  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, project, agentDir, stateDir, config };
}

function skillContent(instructions: string, name = "context-test"): string {
  return [
    "---",
    `name: ${name}`,
    "description: Test context persistence.",
    "---",
    "",
    instructions,
    "",
  ].join("\n");
}
