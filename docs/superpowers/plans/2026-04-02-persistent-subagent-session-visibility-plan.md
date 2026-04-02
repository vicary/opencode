# Persistent Subagent Session Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep task-created subagent sessions readable after completion by removing the automatic child-session deletion in `TaskTool` and aligning the task-tool regression tests with persistent child-session behavior.

**Architecture:** Keep the rollback narrowly scoped to `packages/opencode/src/tool/task.ts` and `packages/opencode/test/tool/task.test.ts`. Child sessions already stay out of top-level browsing surfaces through existing `parentID` filtering, so the implementation should simply stop deleting them and restore same-session reuse for completed `task_id` resumes.

**Tech Stack:** TypeScript, Bun test runner, existing session and task-tool infrastructure

---

## File Map

- Modify: `packages/opencode/src/tool/task.ts`
  Remove the deferred child-session deletion so task-created subagent sessions persist after completion and failure.
- Modify: `packages/opencode/test/tool/task.test.ts`
  Rewrite the existing cleanup regression tests so they assert persistent child-session observability and same-session reuse.

## Implementation Notes

- Follow TDD strictly.
- Run tests from `packages/opencode`, never from repo root.
- Do not add new schema, sync, or UI behavior in this pass.
- Do not commit during execution unless the user explicitly asks.

### Task 1: Rewrite TaskTool Persistence Regressions

**Files:**
- Modify: `packages/opencode/test/tool/task.test.ts`

- [ ] **Step 1: Rewrite the failing tests first**

Rewrite these existing tests in place:

- `task tool removes completed child session after building result`
- `task tool removes child session when prompt fails`
- `task_id after cleanup starts a fresh child session`

New behavior to assert:

```ts
test("task tool keeps completed child session readable after completion", async () => {
  // execute task tool successfully
  // assert metadata.sessionId exists
  // assert Session.get(sessionId) succeeds
})

test("task tool keeps failed child session readable after prompt failure", async () => {
  // execute task tool with SessionPrompt.prompt rejecting
  // assert metadata.sessionId exists
  // assert Session.get(sessionId) succeeds
})

test("task_id reuses the same child session after completion", async () => {
  // execute task once and capture metadata.sessionId
  // execute again with task_id equal to the first child session id
  // assert second metadata.sessionId equals the first one
})
```

Keep the existing typed `SessionPrompt` spies and `seed(...)` helper pattern. Do not add UI tests.

- [ ] **Step 2: Run the task tests to verify RED**

Run: `bun test test/tool/task.test.ts`

Expected: FAIL because `TaskTool` still deletes child sessions and the new persistence assertions should fail.

- [ ] **Step 3: Quick refactor pass on tests only if needed**

If the rewritten tests duplicate setup heavily, extract the smallest shared local helper inside the test file. Keep it narrow.

### Task 2: Remove Deferred Child-Session Deletion

**Files:**
- Modify: `packages/opencode/src/tool/task.ts`
- Modify: `packages/opencode/test/tool/task.test.ts`

- [ ] **Step 1: Write the minimal implementation**

In `packages/opencode/src/tool/task.ts`, remove this cleanup block entirely:

```ts
await using _child = defer(async () => {
  await Session.remove(session.id)
})
```

Do not replace it with a no-op deferred cleanup. Do not add a substitute cleanup path.

After this change:

- successful tasks keep their child session
- failed tasks keep their child session
- `task_id` reuse continues to find and reuse the same existing child session

- [ ] **Step 2: Run the task tests to verify GREEN**

Run: `bun test test/tool/task.test.ts`

Expected: PASS.

- [ ] **Step 3: Quick refactor pass**

Remove any now-unused imports from `task.ts` and keep the change minimal.

### Task 3: Final Verification

**Files:**
- Verify only; no new files required

- [ ] **Step 1: Run the full task-tool test file**

Run: `bun test test/tool/task.test.ts`

Expected: PASS.

- [ ] **Step 2: Run package typecheck**

Run: `bun typecheck`

Expected: PASS.

- [ ] **Step 3: Review behavior against the spec**

Confirm:

- completed child sessions remain readable
- failed child sessions remain readable
- `task_id` resumes the same completed child session
- no new hidden or ephemeral session state was added
- top-level session filtering remains unchanged because it still relies on `parentID`
