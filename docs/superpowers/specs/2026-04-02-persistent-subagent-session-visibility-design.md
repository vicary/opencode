# Persistent Subagent Session Visibility Design

## Summary

Task-created subagent sessions should remain readable after completion so the TUI and web UI can inspect their message timelines through `metadata.sessionId`.

The recent change in `packages/opencode/src/tool/task.ts` schedules `Session.remove(session.id)` as a cleanup step after task execution. That breaks UI observability because the child session is deleted before or immediately as the TUI/web tries to sync and read it.

This change rolls back that deletion behavior and keeps task-created child sessions as normal child sessions under their parent session.

## Problem

`TaskTool` currently returns:

- `metadata.sessionId`
- `task_id`

TUI uses that child session ID directly to fetch and display the subagent conversation after the task finishes. The web UI reads child sessions through normal session/message sync once the child session remains available; it does not need a separate hidden-session mechanism for this fix.

Examples in the current tree:

- TUI: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
  - calls `sync.session.sync(props.metadata.sessionId)`
  - reads `sync.data.message[sessionId]`
- Web: `packages/app/src/pages/session.tsx`
  - syncs sessions by route/session ID
  - reads `sync.data.message[id]`

When `TaskTool` removes the child session on scope exit, the UI loses the underlying session messages and can no longer inspect the completed or failed subagent timeline.

## Goals

- Keep task-created child sessions readable after completion.
- Preserve `metadata.sessionId` as a valid way for TUI/web to load the child conversation.
- Keep subagent sessions out of top-level browsing surfaces using existing `parentID` behavior.
- Restore task resume behavior so a completed child `task_id` still refers to the same session.

## Non-Goals

- Adding a new hidden or ephemeral session state.
- Changing session schema or database shape.
- Changing top-level TUI/web filtering behavior.
- Adding a new cleanup policy for child sessions in this pass.

## Approach

### 1. Remove task child-session deletion

`packages/opencode/src/tool/task.ts` should stop scheduling `Session.remove(session.id)` after task execution.

That means removing the current `await using _child = defer(async () => { await Session.remove(session.id) })` cleanup block entirely, not replacing it with a no-op deferred cleanup.

The child session should remain in storage and sync state like any other child session created with `parentID: ctx.sessionID`.

This also matters because `Session.remove(...)` is recursive. If a task-created child session ever accumulates nested children, the current cleanup would delete those too. Removing the cleanup avoids that entire recursive deletion path.

### 2. Preserve the existing session model

The current session model already gives the desired UI behavior:

- child sessions are linked by `parentID`
- top-level session lists generally filter to sessions without `parentID`
- direct navigation and sync by child session ID still work

That means a new hidden or archived concept is unnecessary for this fix.

### 3. Restore resume semantics

If a caller passes `task_id` for a previously completed task-created child session, `TaskTool` should keep reusing that same child session.

This is a deliberate rollback of the recent ephemeral-session behavior. Observability and inspectability take priority here.

## Data Flow

### Successful task

- `TaskTool` creates or reuses a child session
- subagent writes messages and parts into that child session
- `TaskTool` returns `metadata.sessionId` and `task_id`
- TUI/web sync the child session by ID
- child session messages remain readable after completion

### Failed or cancelled task

- child session retains partial messages, tool state, and failure context
- TUI/web can still inspect the child session after the task ends in error or cancellation

### Top-level browsing

- root session lists remain unchanged because existing UI logic already filters top-level sessions by `!parentID`
- child sessions remain available when navigating within a parent session context

## Error Handling

- do not add a replacement cleanup path in this pass
- task failure and cancellation should still preserve the child session for inspection
- if task execution fails before the child session produces output, the session should still remain available if it was created

## Testing Strategy

Follow TDD.

Rewrite the current TaskTool cleanup regression tests in `packages/opencode/test/tool/task.test.ts` so they stop asserting deletion and instead assert persistence.

Specifically, the existing tests that currently encode the wrong behavior and should be rewritten are:

- `task tool removes completed child session after building result`
- `task tool removes child session when prompt fails`
- `task_id after cleanup starts a fresh child session`

The replacement regression tests should assert:

- completed task child session still exists after tool completion
- failed task child session still exists after tool failure
- reusing `task_id` resumes the same child session instead of creating a fresh one

For the resume test, the assertion direction should be explicit: the reused session ID should stay the same rather than changing to a newly created child session.

Keep the tests focused on `TaskTool`. No UI tests are needed because the regression is caused by backend session deletion, while the UI already correctly reads child sessions by ID.

## Risks

- task-created child sessions will accumulate again over time
- the earlier memory-footprint improvement from deleting child sessions is intentionally rolled back

## Mitigations

- rely on existing `parentID`-based filtering so child sessions do not clutter top-level session lists
- keep this rollback narrowly scoped to `TaskTool`
- revisit memory cleanup later with a design that preserves readability instead of deleting inspectable session state

## Expected Outcome

- TUI can continue showing completed subagent conversations from `metadata.sessionId`
- web UI can continue syncing and rendering child-session timelines after task completion
- completed and failed task sessions remain inspectable
- top-level session lists remain unchanged

## Notes

This design intentionally favors session observability over the recent automatic child-session cleanup behavior.
