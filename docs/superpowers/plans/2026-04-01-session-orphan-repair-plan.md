# Session Orphan Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair all stale unfinished assistant messages on explicit stop/cancel and on next-prompt startup recovery so sessions cannot retain orphaned loading state.

**Architecture:** Keep recovery logic inside `SessionPrompt` as one shared private helper that scans persisted session messages, repairs every unfinished assistant, and sets session status to `idle` once after the batch. Cover the expanded behavior with targeted regression tests before changing implementation.

**Tech Stack:** Bun, TypeScript, existing session/message persistence, Bun test

---

## File Map

- Modify: `packages/opencode/src/session/prompt.ts`
  Purpose: replace single-message orphan repair with batch repair shared by `cancel()` and prompt startup recovery.
- Modify: `packages/opencode/test/session/prompt.test.ts`
  Purpose: add regression coverage for multiple unfinished assistants, preserved errors, unchanged completed assistants, and single idle-event emission.
- Reference: `packages/opencode/src/session/status.ts`
  Purpose: confirm idle event semantics while designing assertions.

### Task 1: Add Failing Regression Coverage For Batch Repair

**Files:**
- Modify: `packages/opencode/test/session/prompt.test.ts`
- Reference: `packages/opencode/src/session/prompt.ts`
- Reference: `packages/opencode/src/session/status.ts`

- [ ] **Step 1: Write the failing cancel-path regression for multiple unfinished assistants**

Add a test that creates one session with:
- one user message
- two unfinished assistant messages
- optionally one already-completed assistant message as a control

Assert after `SessionPrompt.cancel(session.id)` that:
- both unfinished assistants now have `time.completed`
- both unfinished assistants have `MessageAbortedError` if they had no prior error
- the completed assistant still has its original `time.completed`

- [ ] **Step 2: Run the focused test to verify it fails for the expected reason**

Run: `bun test ./test/session/prompt.test.ts`
Expected: FAIL because only one unfinished assistant is currently repaired.

- [ ] **Step 3: Write the failing startup-recovery regression for multiple unfinished assistants**

Add a test that:
- creates two unfinished assistant messages in the same session
- starts a new prompt
- waits until the new run has begun by observing the new assistant run start, not via a blind timeout
- asserts both stale assistants were repaired before the new run completes

- [ ] **Step 4: Run the focused test file again to verify the new startup test also fails correctly**

Run: `bun test ./test/session/prompt.test.ts`
Expected: FAIL because startup recovery currently repairs only the last unfinished assistant.

- [ ] **Step 5: Extend coverage for preserved errors and single idle emission across batch repair**

Add or update tests so the batch-repair path proves:
- existing errors remain unchanged for repaired assistants
- idle event count is `1` per recovery path even when multiple assistants are repaired

- [ ] **Step 6: Run the focused test file once more to confirm failures are still only from missing batch behavior**

Run: `bun test ./test/session/prompt.test.ts`
Expected: FAIL in the new batch-repair assertions, not from test setup errors.

### Task 2: Implement Batch Repair In SessionPrompt

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts`
- Reference: `packages/opencode/src/session/status.ts`
- Test: `packages/opencode/test/session/prompt.test.ts`

- [ ] **Step 1: Replace single-message orphan lookup with batch selection**

Update the shared repair helper so it collects all assistant messages where `time.completed` is missing instead of using `findLast(...)`.

- [ ] **Step 2: Apply the minimal batch repair logic**

Use `Session.messages({ sessionID })` as the source of truth, iterate each returned message wrapper whose `msg.info.role === "assistant"` and whose `msg.info.time.completed` is missing, and for each unfinished assistant:
- set `time.completed` to a shared recovery timestamp or per-message `Date.now()`
- preserve `msg.info.error` when present
- otherwise assign `new MessageV2.AbortedError({ message }).toObject()`
- persist the updated message with `Session.updateMessage(...)`

Do not modify already-completed assistants.

- [ ] **Step 3: Keep the active-run guard intact**

Preserve the existing in-memory-state guard so the helper still skips orphan repair when `state()[sessionID]` exists.

- [ ] **Step 4: Set session status to idle once after the batch**

Keep idle status publication outside the per-message update loop so the bus only emits one idle notification for each recovery call. Account for the existing `cancel()` flow as part of this step: either make the shared helper the sole idle-setter and remove the redundant idle update from `cancel()`, or keep idle-setting in `cancel()` and ensure the helper does not emit a second idle event for the same recovery path.

- [ ] **Step 5: Re-run the focused regression file to verify it passes**

Run: `bun test ./test/session/prompt.test.ts`
Expected: PASS

### Task 3: Verify No Regressions

**Files:**
- Test: `packages/opencode/test/session/prompt.test.ts`
- Test: `packages/opencode/test/session/processor-effect.test.ts`
- Modify if needed: `packages/opencode/src/session/prompt.ts`

- [ ] **Step 1: Run the adjacent processor regression suite**

Run: `bun test ./test/session/processor-effect.test.ts`
Expected: PASS

- [ ] **Step 2: Run package typecheck**

Run: `bun typecheck`
Expected: success with no type errors

- [ ] **Step 3: If any verification fails, fix the smallest root cause and re-run the same command**

Keep fixes scoped to the batch repair feature. Do not refactor unrelated session logic.

- [ ] **Step 4: Re-run the full verification set after fixes**

Run:
- `bun test ./test/session/prompt.test.ts`
- `bun test ./test/session/processor-effect.test.ts`
- `bun typecheck`

Expected: all pass

### Task 4: End-To-End Recovery Verification

**Files:**
- Modify if needed: `packages/opencode/src/session/prompt.ts`
- Reference: `packages/app/src/pages/session/message-timeline.tsx`

- [ ] **Step 1: Validate the repaired state shape after batch recovery**

After automated tests pass, inspect the resulting session/message state through the existing test assertions or an equivalent targeted reproduction to confirm there are no remaining unfinished assistant messages in the repaired session.

- [ ] **Step 2: Confirm the recovery semantics match the UI contract**

Read `packages/app/src/pages/session/message-timeline.tsx` and confirm the repaired message shape now satisfies the UI contract: no stale unfinished assistant remains that could keep the loading marker active.
