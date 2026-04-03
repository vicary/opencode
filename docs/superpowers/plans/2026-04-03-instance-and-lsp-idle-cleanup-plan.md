# Instance and LSP Idle Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add idle disposal for cached instances, evict idle per-root LSP clients, and stop plain file reads from warming LSP.

**Architecture:** Keep ownership local to the existing modules. `project/instance.ts` owns cached instance lifetime, `lsp/index.ts` owns per-root client lifetime inside an instance, and `tool/read.ts` stays a pure filesystem read path. The implementation should use small module-local idle metadata and sweep logic rather than generic debounce helpers.

**Tech Stack:** TypeScript, Bun test runner, Effect `InstanceState`, existing LSP and tool infrastructure

---

## File Map

- Modify: `packages/opencode/src/project/instance.ts`
  Add cache entry metadata, active-use tracking, and idle disposal sweep logic.
- Modify: `packages/opencode/test/project/state.test.ts`
  Add timer-driven regression coverage for idle disposal and active-use safety.
- Modify: `packages/opencode/src/lsp/index.ts`
  Add per-client idle metadata, eviction logic, and client collection updates.
- Modify: `packages/opencode/test/lsp/index.test.ts`
  Add regression coverage for per-root eviction and idle refresh behavior.
- Modify: `packages/opencode/src/tool/read.ts`
  Remove unconditional `LSP.touchFile(...)` from plain text reads.
- Modify: `packages/opencode/test/tool/read.test.ts`
  Add regression coverage proving plain reads no longer warm LSP.

## Implementation Notes

- Follow TDD strictly: write the failing test first, run it and watch it fail for the expected reason, then implement the minimal fix.
- Run tests from `packages/opencode`, never from repo root.
- Keep new names short and local.
- Do not introduce a generic debounce or expiry utility unless implementation proves the local logic is duplicated enough to justify it.
- Do not commit during execution unless the user explicitly asks.

### Task 1: Instance Idle Disposal

**Files:**
- Modify: `packages/opencode/src/project/instance.ts`
- Modify: `packages/opencode/test/project/state.test.ts`

- [ ] **Step 1: Write the failing tests**

Add timer-driven tests in `packages/opencode/test/project/state.test.ts` that cover:

```ts
test("idle instance is disposed after timeout", async () => {
  // create one instance-scoped state with a dispose callback
  // access it once through Instance.provide(...)
  // advance fake timers past the idle threshold and sweep interval
  // assert the dispose callback ran
})

test("recently reused instance is retained", async () => {
  // access the same directory
  // advance timers to just before expiry, touch it again, then advance more
  // assert it was not disposed on the old schedule
})

test("active provide call is not disposed mid-flight", async () => {
  // keep Instance.provide(...) blocked on a promise
  // advance timers past idle threshold while active
  // assert dispose has not run yet
  // release the promise, advance again, assert dispose then runs
})
```

Prefer using the existing `Instance.state(...)` disposal callback seam instead of introducing a new test-only API. If fake timers are needed, use Bun's timer controls in this file rather than sleeping in real time.

- [ ] **Step 2: Run the instance tests to verify RED**

Run: `bun test test/project/state.test.ts`

Expected: FAIL because cached instances currently have no idle metadata or automatic disposal path.

- [ ] **Step 3: Write the minimal implementation**

In `packages/opencode/src/project/instance.ts`, replace the raw cache value with a small entry object, for example:

```ts
type Entry = {
  ctx: Promise<InstanceContext>
  used: number
  active: number
}
```

Then:

- refresh `used` on each `provide(...)`
- increment `active` before `input.fn()`
- decrement `active` in cleanup after `input.fn()` completes
- add one small module-local sweep timer that scans idle entries
- only dispose an entry when it is still current in the map, `active === 0`, and older than the timeout

Keep the actual teardown on the existing `State.dispose(...)` + `disposeInstance(...)` path. Avoid changing `WorkspaceRouterMiddleware`.

- [ ] **Step 4: Run the instance tests to verify GREEN**

Run: `bun test test/project/state.test.ts`

Expected: PASS.

- [ ] **Step 5: Quick refactor pass**

Tighten any duplicated dispose-or-skip checks. Keep all logic in `instance.ts` unless a tiny helper clearly improves readability.

### Task 2: Per-Root LSP Idle Eviction

**Files:**
- Modify: `packages/opencode/src/lsp/index.ts`
- Modify: `packages/opencode/test/lsp/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add focused regression tests in `packages/opencode/test/lsp/index.test.ts` that cover:

```ts
test("idle lsp client is evicted without disposing the instance", async () => {
  // stub one builtin server spawn and one mock client shutdown
  // trigger a semantic request to create the client
  // advance fake timers past the LSP idle threshold
  // assert shutdown ran and a later request spawns again
})

test("active lsp use refreshes idle lifetime", async () => {
  // create one client
  // advance close to expiry, perform another semantic call
  // advance past the original expiry boundary
  // assert client survives that sweep and is only evicted after the refreshed boundary
})

test("one stale root is evicted while another active root remains", async () => {
  // create two distinct root/server clients under one instance
  // refresh one and leave the other idle
  // advance timers and assert only the stale client is shut down
})
```

Use `LSPServer` root/spawn seams and minimal mocked `LSPClient.Info` shutdown behavior already implied by this file's current style. Avoid building a broad integration harness.

- [ ] **Step 2: Run the LSP tests to verify RED**

Run: `bun test test/lsp/index.test.ts`

Expected: FAIL because LSP clients currently remain alive until full instance disposal.

- [ ] **Step 3: Write the minimal implementation**

In `packages/opencode/src/lsp/index.ts`, replace the forever-live client list with small metadata entries, for example:

```ts
type Client = {
  info: LSPClient.Info
  used: number
}
```

Then:

- store clients by root/server identity while preserving the existing dedupe behavior
- refresh `used` whenever a semantic API uses that client
- add one per-instance sweep that shuts down only idle clients
- remove evicted clients from the in-memory collection
- keep `spawning` and `broken` behavior intact

If `status()` or `runAll()` currently assume a flat `LSPClient.Info[]`, update them to read from the new client metadata without changing their outward behavior.

- [ ] **Step 4: Run the LSP tests to verify GREEN**

Run: `bun test test/lsp/index.test.ts`

Expected: PASS.

- [ ] **Step 5: Quick refactor pass**

Consolidate repeated keying or touch logic into tiny locals if it reduces duplication. Do not broaden the service surface area.

### Task 3: Remove Plain Read LSP Warming

**Files:**
- Modify: `packages/opencode/src/tool/read.ts`
- Modify: `packages/opencode/test/tool/read.test.ts`

- [ ] **Step 1: Write the failing test**

Add a regression test in `packages/opencode/test/tool/read.test.ts`:

```ts
test("plain text read does not warm lsp", async () => {
  // write a normal text file
  // spy on LSP.touchFile
  // execute ReadTool on that file
  // assert the file content is returned and LSP.touchFile was not called
})
```

Keep the assertion narrow: this test is about plain text `read`, not semantic tools.

- [ ] **Step 2: Run the read tests to verify RED**

Run: `bun test test/tool/read.test.ts`

Expected: FAIL because `read.ts` currently calls `LSP.touchFile(filepath, false)` for plain text reads.

- [ ] **Step 3: Write the minimal implementation**

In `packages/opencode/src/tool/read.ts`, remove:

```ts
LSP.touchFile(filepath, false)
```

from the plain text path. Leave `FileTime.read(...)` and instruction loading unchanged.

If that removal leaves the `LSP` import unused, delete the unused import and nothing more.

- [ ] **Step 4: Run the read tests to verify GREEN**

Run: `bun test test/tool/read.test.ts`

Expected: PASS.

- [ ] **Step 5: Quick refactor pass**

Ensure `read.ts` still reads as a pure filesystem tool and does not retain any LSP-specific comments or dead code.

### Task 4: Focused Verification

**Files:**
- Verify only; no new files required

- [ ] **Step 1: Run targeted regression tests**

Run: `bun test test/project/state.test.ts test/lsp/index.test.ts test/tool/read.test.ts`

Expected: PASS.

- [ ] **Step 2: Run package typecheck**

Run: `bun typecheck`

Expected: PASS.

- [ ] **Step 3: Review behavior against the spec**

Confirm:

- cached instances dispose only after idle timeout and never while active
- per-root LSP clients can be evicted without whole-instance disposal
- a refreshed LSP client survives the earlier eviction boundary
- one stale root can be evicted while another active root in the same instance remains alive
- plain `read` no longer triggers LSP startup
