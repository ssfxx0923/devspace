# ChatGPT Coding Workflow

DevSpace gives ChatGPT and other MCP hosts a direct local coding runtime:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

ChatGPT may support automatic checkout recovery through optional host
conversation metadata. This is an OpenAI-host adapter detail, not a standard MCP
conversation field. When that optional context is available, opening the same
checkout project again in the same conversation can continue in the existing
workspace, and the context already provided for that reused checkout is not
repeated. The portable workflow remains the same: keep using the `workspaceId`
returned by `open_workspace` for later operations. Hosts without supported
conversation context receive a normal new workspace and continue with that
explicit `workspaceId` workflow.
The model receives actionable workspace instructions; automatic-reuse
bookkeeping is not a model-facing choice.

Worktree mode is deliberately different: every call creates a new managed
worktree and a new workspace session with complete context, even for the same
path and base ref.

The first successful open of a checkout provides complete instructions and
coding context. A repeated open that reuses the same checkout workspace does
not repeat the model-visible context, but the workspace UI continues to show the
complete details. Every new worktree establishes and returns its own complete
context, even when the same project was already opened in checkout or another
worktree. Opening checkout after a worktree therefore provides the checkout's
own context.

Do not call `open_workspace` again for the same checkout folder unless:

- the `workspaceId` is rejected as unknown
- work moves to a different project folder
- work switches between checkout and worktree mode
- the user asks for a new isolated worktree

## Checkout Mode

Checkout mode is the default. DevSpace opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Each worktree-mode call creates a new managed worktree and returns a new
`workspaceId`. Reuse that ID for work inside that worktree; call
`open_workspace` in worktree mode again only when another isolated worktree is
actually required.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, DevSpace loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `availableAgentsFiles`. The model
should read the relevant nested file before working under that directory.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

### Context revisions and refresh

Each workspace has an accepted context revision persisted in DevSpace's SQLite
state. The revision covers the loaded global and root instructions, nested
instructions that were read in full, activated skills, and the currently
advertised instruction and skill inventory.

Before `apply_patch`, artifact download, or a new `exec_command`, DevSpace
checks that active instruction and skill content has not changed. It also
checks whether the operation's target path or command working directory is
covered by an unread nested instruction. If the context is stale, the operation
fails without performing the mutation and tells the host to call:

```json
{
  "workspaceId": "ws_example"
}
```

with `refresh_workspace_context`. The refresh result is a complete recoverable
snapshot: the new `contextRevision`, current instruction content, available
nested instructions, current skills, activated skill content, diagnostics, and
the added, modified, or deleted items since the previous accepted revision.
Review that snapshot, then retry the blocked operation.

Nested instruction and `SKILL.md` reads activate context only when `read` is
called without `offset` or `limit`. Partial reads remain useful for inspection,
but do not satisfy the context guard. Accepted nested instructions and activated
skills survive a DevSpace server restart.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

Skill paths may be outside the workspace. DevSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output.

## Tool Names

Native mode is the default and exposes:

- `open_workspace`
- `refresh_workspace_context`
- `read`
- `grep`
- `glob`
- `ls`
- `apply_patch`
- `exec_command`
- `write_stdin`
- `list_processes`
- `terminate_process`

Use `apply_patch` when a structured patch is the clearest way to edit source.
Use `exec_command` naturally for shell operations, including file mutations,
Git, package managers, generators, formatters, tests, builds, Docker, and
project scripts. Every command returns a process session ID, including a command
that completed within the initial yield window. Use `write_stdin` to poll it,
send input, resize a PTY, or send Ctrl-C. Use `list_processes` to recover running
and recently completed session IDs, and `terminate_process` to request SIGTERM
for one workspace-owned session.

Completed sessions remain addressable for five minutes. Process sessions are
held in the running DevSpace process and do not survive a server restart. One
tool call waits at most 30 seconds; longer commands continue in a session and
can be polled with later calls.

DevSpace exposes this native tool surface for every client. The former
`minimal` and `full` modes and the legacy `write`, `edit`, and `bash` tools are
no longer available. Remove `DEVSPACE_TOOL_MODE` and
`DEVSPACE_MINIMAL_TOOLS` from older configurations before upgrading.

Shell commands run with the authority of the local user running DevSpace and
are not an OS sandbox. Workspace containment applies to structured filesystem
tools, not arbitrary shell commands.

## Show Changes

By default, `DEVSPACE_WIDGETS=changes`.

In that mode, ordinary coding tools remain data-only. DevSpace attaches widget
UI only to `open_workspace`, `refresh_workspace_context`, and the aggregate
`show_changes` checkpoint tool.
This avoids creating a new iframe-backed app card for every `read`, search,
edit, or shell call in long ChatGPT conversations.

Use `DEVSPACE_WIDGETS=off` to disable widget UI entirely. Use
`DEVSPACE_WIDGETS=full` only when per-tool cards are intentionally useful for
debugging or UI development.

When `show_changes` is exposed, call it exactly once after the final file
modification in any turn that changes files. It shows the combined changes for
that turn and advances the review point automatically. Reusing a workspace does
not change this workflow.

## Shell Use

The native shell supports normal local development operations, including:

- file creation, modification, movement, renaming, and deletion
- Git and worktree operations
- package managers, generators, and project scripts
- formatters, linters, tests, and builds
- compilers, interpreters, Docker, and long-running processes

Use `apply_patch` when it is convenient for precise source edits. Shell
redirection, scripts, and other normal command-line file operations are allowed.

`exec_command` applies nested-instruction scope to its selected
`workingDirectory`. DevSpace does not parse arbitrary shell syntax to infer
every path a command might touch, and shell execution remains outside the
structured filesystem containment boundary.

If active context changes while a process is running, `write_stdin` still
allows polling, PTY resize, and Ctrl-C so the host can inspect or safely stop the
process. Ordinary input is blocked until the workspace context is refreshed.
