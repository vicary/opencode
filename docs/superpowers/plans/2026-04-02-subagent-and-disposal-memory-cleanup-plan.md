# Subagent and Disposal Memory Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce retained memory by cleaning up share subscriptions and timers, closing superseded pending MCP OAuth transports, explicitly owning the models refresh timer, and removing finished task-created subagent sessions after their results are captured.

**Architecture:** Keep the change narrow and local to current ownership boundaries. `share-next.ts` owns its subscriptions and timeout queue, `mcp/index.ts` owns pending OAuth transport lifetime, `models.ts` owns the process-global refresh timer, and `tool/task.ts` owns the lifetime of task-created child sessions after their result has been folded back into the parent tool response.

**Tech Stack:** TypeScript, Bun test runner, Effect services, existing session and MCP infrastructure

---

## File Map

- Modify: `packages/opencode/src/share/share-next.ts`
  Add idempotent init/dispose lifecycle for bus subscriptions and queued sync timers.
- Modify: `packages/opencode/test/share/share-next.test.ts`
  Add regression coverage for repeated init and dispose cleanup.
- Modify: `packages/opencode/src/mcp/index.ts`
  Close old pending OAuth transports before replacement or removal.
- Modify: `packages/opencode/test/mcp/oauth-browser.test.ts`
  Add auth-flow regression coverage around pending OAuth transport replacement/removal.
- Modify: `packages/opencode/src/provider/models.ts`
  Keep the refresh interval handle and clear it via a small process-shutdown hook.
- Create: `packages/opencode/test/provider/models.test.ts`
  Add focused coverage for interval ownership and cleanup behavior if existing tests do not cover it cleanly.
- Modify: `packages/opencode/src/tool/task.ts`
  Remove completed task-created child sessions after parent output is fully constructed.
- Modify: `packages/opencode/test/tool/task.test.ts`
  Add regression coverage for child-session cleanup and resumed `task_id` creating fresh state after cleanup.

## Implementation Notes

- Follow TDD strictly: write the failing test first, run it and watch it fail for the expected reason, then implement the minimal fix.
- Run tests from `packages/opencode`, never from repo root.
- Do not commit during execution unless the user explicitly asks.

### Task 1: ShareNext Lifecycle Ownership

**Files:**
- Modify: `packages/opencode/src/share/share-next.ts`
- Modify: `packages/opencode/test/share/share-next.test.ts`

- [ ] **Step 1: Write the failing tests**

Add two tests in `packages/opencode/test/share/share-next.test.ts`:

```ts
test("ShareNext.init does not stack subscriptions", async () => {
  // patch Bus.subscribe to capture unsubscribe handles and count registrations
  // call init() twice
  // assert only 4 subscriptions are registered total
})

test("ShareNext.dispose clears queued sync state", async () => {
  // patch Bus.subscribe to capture the Session.Event.Updated handler
  // patch Session.get, request/fetch, and timeout APIs just enough to enqueue sync work
  // call dispose()
  // assert the queued timer clear path ran and all unsubscribe handles were called
})
```

Prefer the existing direct patching style already used in this test file (`Account.active = mock(...)`) over building a full `Instance.provide` integration harness for these two tests.

- [ ] **Step 2: Run the share tests to verify RED**

Run: `bun test test/share/share-next.test.ts`

Expected: FAIL because `ShareNext` currently has no tracked init/dispose lifecycle and repeated init can stack subscriptions.

- [ ] **Step 3: Write the minimal implementation**

In `packages/opencode/src/share/share-next.ts`:

```ts
const unsubs = new Set<() => void>()
let started = false

export async function init() {
  if (disabled || started) return
  started = true
  unsubs.add(Bus.subscribe(...))
}

export function dispose() {
  for (const unsub of unsubs) unsub()
  unsubs.clear()
  for (const item of queue.values()) clearTimeout(item.timeout)
  queue.clear()
  started = false
}
```

Keep names short and the implementation local. Reuse the existing `queue` map instead of introducing a second timer registry.

- [ ] **Step 4: Run the share tests to verify GREEN**

Run: `bun test test/share/share-next.test.ts`

Expected: PASS.

- [ ] **Step 5: Quick refactor pass**

Tighten any duplicated listener registration/cleanup code without changing behavior. Keep cleanup idempotent.

### Task 2: MCP Pending OAuth Transport Cleanup

**Files:**
- Modify: `packages/opencode/src/mcp/index.ts`
- Modify: `packages/opencode/test/mcp/oauth-browser.test.ts`

- [ ] **Step 1: Write the failing tests**

Add focused tests in `packages/opencode/test/mcp/oauth-browser.test.ts`:

```ts
test("pending OAuth transport replacement closes old transport", async () => {
  // run MCP.authenticate(name) twice for the same remote MCP server
  // track close calls on the mocked StreamableHTTP transport
  // assert the first pending transport is closed before the second is stored
})

test("removeAuth closes pending OAuth transport before deleting it", async () => {
  // run MCP.authenticate(name) once to create pending auth transport
  // call MCP.removeAuth(name)
  // assert the mocked pending transport close path ran
})
```

Use the existing mocked OAuth transport classes in `oauth-browser.test.ts`. Add a close counter or per-instance `closed` flag directly to those mocks instead of introducing a new harness.

- [ ] **Step 2: Run the MCP OAuth tests to verify RED**

Run: `bun test test/mcp/oauth-browser.test.ts`

Expected: FAIL because pending OAuth transports are currently replaced/deleted without explicit close.

- [ ] **Step 3: Write the minimal implementation**

In `packages/opencode/src/mcp/index.ts`, add a tiny helper near `pendingOAuthTransports`:

```ts
function closePending(key: string) {
  const item = pendingOAuthTransports.get(key)
  if (!item) return Effect.void
  return Effect.tryPromise(() => item.close()).pipe(Effect.ignore)
}
```

Then apply it before:

- `pendingOAuthTransports.set(key, transport)` in remote auth setup
- `pendingOAuthTransports.set(mcpName, transport)` in browser auth setup
- `pendingOAuthTransports.delete(mcpName)` in `removeAuth`

Also change the finalizer path that currently does `pendingOAuthTransports.clear()` so it first closes every stored transport, then clears the map.

- [ ] **Step 4: Run the MCP OAuth tests to verify GREEN**

Run: `bun test test/mcp/oauth-browser.test.ts`

Expected: PASS.

- [ ] **Step 5: Quick refactor pass**

Consolidate repeated close-and-delete code into one tiny helper if it reduces duplication. Do not broaden MCP auth behavior beyond cleanup.

### Task 3: Models Refresh Timer Ownership

**Files:**
- Modify: `packages/opencode/src/provider/models.ts`
- Create: `packages/opencode/test/provider/models.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/opencode/test/provider/models.test.ts` with a focused ownership test, for example:

```ts
test("models refresh timer can be cleared by shutdown hook", async () => {
  // import module through isolated setup if needed
  // assert timer handle is created and cleanup function clears it
})
```

If the module shape makes this hard to test directly, expose a tiny internal helper for timer creation and cleanup rather than forcing a brittle module-reset strategy.

- [ ] **Step 2: Run the models test to verify RED**

Run: `bun test test/provider/models.test.ts`

Expected: FAIL because the current module discards the interval handle and has no explicit cleanup hook.

- [ ] **Step 3: Write the minimal implementation**

In `packages/opencode/src/provider/models.ts`:

```ts
let timer: Timer | undefined

function stop() {
  if (!timer) return
  clearInterval(timer)
  timer = undefined
}
```

Store the interval handle, call `.unref()` on it, and register one small `process.once("exit", stop)` hook in the same module. If you need to avoid duplicate hook registration in tests, guard it with a module-local boolean. Keep this as hygiene work; do not restructure the module into a service.

- [ ] **Step 4: Run the models test to verify GREEN**

Run: `bun test test/provider/models.test.ts`

Expected: PASS.

- [ ] **Step 5: Quick refactor pass**

Keep the hook registration and timer helper minimal. Avoid multiple process handlers if one suffices.

### Task 4: Task-Created Subagent Session Cleanup

**Files:**
- Modify: `packages/opencode/src/tool/task.ts`
- Modify: `packages/opencode/test/tool/task.test.ts`

- [ ] **Step 1: Write the failing tests**

Add two regression tests in `packages/opencode/test/tool/task.test.ts`:

```ts
test("task tool removes completed child session after building result", async () => {
  // execute task tool
  // capture returned task_id from metadata/output
  // assert Session.get(childID) fails after completion
})

test("task_id after cleanup starts a fresh child session", async () => {
  // execute task once and capture childID
  // execute again with task_id: childID
  // assert a new child session is created instead of reviving the old one
})
```

Use the existing `tmpdir`, `Instance.provide`, and session helpers in this file. Keep the test narrow and avoid adding unrelated agent scaffolding.

- [ ] **Step 2: Run the task-tool tests to verify RED**

Run: `bun test test/tool/task.test.ts`

Expected: FAIL because child sessions currently remain available after task completion.

- [ ] **Step 3: Write the minimal implementation**

In `packages/opencode/src/tool/task.ts`:

```ts
const output = [
  `task_id: ${session.id} (for resuming to continue this task if needed)`,
  "",
  "<task_result>",
  text,
  "</task_result>",
].join("\n")

using _child = defer(() => {
  void Session.remove(session.id).then(undefined, () => {})
})

return { title: params.description, metadata: { sessionId: session.id, model }, output }
```

Use the existing `defer` pattern already present in this file rather than a new `try`/`finally` block. `Session.remove(session.id)` is the exported async session-removal entry point here, so schedule it only after `output` and metadata are fully built. Keep the existing resume semantics: if a later call uses that deleted `task_id`, `Session.get()` will miss and the current code path will create a fresh child session.

- [ ] **Step 4: Run the task-tool tests to verify GREEN**

Run: `bun test test/tool/task.test.ts`

Expected: PASS.

- [ ] **Step 5: Quick refactor pass**

If needed, isolate the child-session cleanup into a tiny local helper inside `execute()` to avoid repeating remove-on-success/remove-on-error logic. Keep everything in the same function unless a helper clearly improves clarity.

### Task 5: Final Verification

**Files:**
- Verify only; no new files required

- [ ] **Step 1: Run the targeted regression tests**

Run: `bun test test/share/share-next.test.ts test/mcp/oauth-browser.test.ts test/provider/models.test.ts test/tool/task.test.ts`

Expected: PASS.

- [ ] **Step 2: Run package typecheck**

Run: `bun typecheck`

Expected: PASS.

- [ ] **Step 3: Review behavior against the spec**

Confirm:

- `ShareNext.init()` is idempotent
- `ShareNext.dispose()` clears listeners and queued timers
- pending OAuth transports are closed on replacement/removal
- the models timer has explicit ownership and shutdown cleanup
- finished task-created child sessions are removed only after parent result construction
- resumed `task_id` after cleanup starts fresh rather than reviving deleted state
