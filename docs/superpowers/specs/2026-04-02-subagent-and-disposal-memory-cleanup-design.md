# Subagent and Disposal Memory Cleanup Design

## Summary

This design pulls a focused subset of `anomalyco/opencode#16695` into the current tree to reduce retained memory from long-lived service subscriptions, queued timers, pending transports, and finished task subagent sessions.

The selected scope is intentionally narrow:

- add explicit lifecycle cleanup to `packages/opencode/src/share/share-next.ts`
- close superseded pending MCP OAuth transports in `packages/opencode/src/mcp/index.ts`
- clear the process-wide models refresh interval in `packages/opencode/src/provider/models.ts`
- remove finished task-created subagent sessions after their result has been captured in `packages/opencode/src/tool/task.ts`

The current SSE routes in `packages/opencode/src/server/routes/event.ts` and `packages/opencode/src/server/routes/global.ts` already contain the idempotent abort, unsubscribe, heartbeat, and queue shutdown behavior that the stale PR added, so SSE route changes are out of scope for this pass.

## Problem

Several code paths still retain memory longer than necessary:

- `ShareNext.init()` installs persistent bus subscriptions without a paired disposal path, so repeated initialization can stack listeners if the initializer is called more than once. In the current tree this is defensive hardening around an unguarded initializer, not necessarily evidence of a frequently hit runtime path.
- `ShareNext` also keeps queued sync timers and payload maps alive until they fire naturally, even when the share subsystem should be torn down.
- the MCP pending OAuth transport map can replace or delete entries without explicitly closing the underlying transport first.
- the models refresh timer is process-global and never explicitly cleared.
- task-created subagent sessions can remain in memory after the parent task has already persisted their result into the parent session.

Each item is small by itself, but together they keep listeners, closures, transport objects, timers, session state, messages, and parts reachable longer than needed.

## Goals

- Prevent `ShareNext` from stacking subscriptions across repeated initialization.
- Add explicit disposal for `ShareNext` queued timers and subscriptions.
- Ensure replaced or discarded pending MCP OAuth transports are closed.
- Ensure the models refresh interval is explicitly cleared on process exit.
- Treat task-created subagent sessions as ephemeral execution artifacts and remove them after completion.
- Keep the implementation small and aligned with current code structure.

## Non-Goals

- Reworking the current SSE route implementation.
- Broad session cleanup across every session-removal caller.
- Changing the semantics of ordinary user sessions.
- Refactoring unrelated services that only appeared in the stale PR.

## Approach

### 1. ShareNext lifecycle ownership

`packages/opencode/src/share/share-next.ts` should own all resources it creates.

`init()` becomes idempotent. It should either no-op when already initialized or tear down existing subscriptions before re-subscribing. The implementation should store the unsubscribe handles returned by the four `Bus.subscribe(...)` calls and keep them in module-local state.

Add `dispose()` that:

- unsubscribes all tracked listeners
- clears every queued sync timeout
- removes queued entries from the `queue` map
- resets the tracked initialization state

This cleanup should be best-effort and idempotent. Calling `dispose()` twice should be harmless.

### 2. MCP pending OAuth transport cleanup

`packages/opencode/src/mcp/index.ts` already tracks pending OAuth transports. The missing piece is explicit transport closure when ownership changes.

When storing a new pending transport for an existing key:

- close `pendingOAuthTransports.get(key)` first
- replace the map entry afterward

When removing auth or otherwise deleting the pending transport entry:

- close the transport first
- then delete the map entry

The goal is single-owner transport lifetime. A replaced transport should not survive just because its map slot changed.

### 3. Models refresh interval cleanup

`packages/opencode/src/provider/models.ts` should keep the `setInterval(...)` handle instead of discarding it immediately.

On process shutdown, clear that interval explicitly through a small process hook in the same module. This remains hygiene work because the timer is already `unref()`'d, so the main value is explicit ownership and predictable teardown rather than a large runtime memory win.

### 4. Task-created subagent session cleanup

`packages/opencode/src/tool/task.ts` should remove completed subagent sessions after the parent task result has been captured.

The cleanup order matters:

1. run the subagent session to completion or handled failure
2. persist the result, output, and attachments needed by the parent task tool response
3. remove the subagent session through the normal session-removal path

This keeps the visible parent behavior intact while freeing the child session's retained state.

This is an intentional behavior choice: task-created subagent sessions are treated as ephemeral execution artifacts, not durable history.

The current `task_id` behavior matters here. Today, if a caller passes `task_id` and that session no longer exists, `tool/task.ts` silently creates a fresh child session instead of surfacing a missing-session error. This pass should preserve that behavior and document it clearly: once a finished task-created session has been removed, a later resume attempt with that `task_id` starts a fresh child session with no prior context.

### 5. Session removal path

If `tool/task.ts` already has access to the correct session-removal API, use it directly. If not, thread cleanup through the existing session removal entry point rather than adding a task-local deletion shortcut.

The implementation should stay narrow: only task-created subagent sessions are auto-removed in this pass.

The existing `Session.remove()` path is recursive and already handles child-session removal, unshare, deleted sync events, and sync-store removal. It does not clean every side store from the stale PR, so this design should not overstate what session deletion currently guarantees.

## Data Flow

### ShareNext

- `init()` records unsubscribe handles in module-local state.
- `sync()` continues to coalesce payloads per session in the queue map.
- `dispose()` clears the queue map and unsubscribes listeners.
- repeated `init()` calls do not multiply bus subscribers.

### MCP

- a pending transport key points to at most one live transport.
- replacement closes the old transport before adopting the new one.
- removal closes the tracked transport before deleting its entry.

### Task subagents

- parent task runs subagent work and receives its final result.
- parent persists the result it needs.
- parent triggers child session removal.
- child session memory is not retained after result capture.
- a later `task_id` resume for that deleted child creates a fresh session rather than reviving the old one.

## Error Handling

- `ShareNext.dispose()` should never fail because a timeout or unsubscribe handle was already consumed.
- MCP transport cleanup should tolerate already-closed transports.
- subagent cleanup should run in a `finally`-style path after result capture so success, handled error, and cancellation all attempt cleanup.
- if child session removal fails after result capture, log the failure but do not convert a successful parent tool result into a task failure.
- do not remove the child before the parent tool has finished building its own return payload.

## Testing Strategy

Follow TDD for each file touched.

### 1. ShareNext

- add a regression test showing repeated `init()` does not stack subscribers
- add a regression test showing `dispose()` clears queued sync timers and tracked state

### 2. MCP

- add a test proving pending OAuth transport replacement closes the old transport
- add a test proving auth removal closes the tracked pending transport

Because the repo prefers avoiding mocks, the test strategy should stay lightweight and explicit. Prefer a narrow seam around the stored transport object so the test can exercise a minimal closeable object without needing a full networked OAuth flow.

### 3. Task subagents

- add a regression test proving a task-created subagent session is removed after the parent records the final task result
- verify the test fails before implementation and passes after it
- verify the test also documents the resumed-`task_id` behavior after cleanup: deleted child sessions are not revived and a later resume starts fresh

### 4. Verification

Run targeted tests and `bun typecheck` from `packages/opencode`.

## Risks

- removing subagent sessions too early would break result capture or attachment persistence
- some debugging workflows may implicitly expect finished subagent sessions to remain inspectable
- removing the child session while the parent task tool is still returning could surprise any consumer still observing child-session events
- MCP cleanup must avoid throwing during normal auth replacement flows
- `ShareNext` cleanup must remain safe if initialization and disposal happen more than once

## Mitigations

- only remove subagent sessions after the parent has persisted the result it needs and built the return payload it will hand back to the caller
- keep subagent cleanup scoped to task-created child sessions only
- make all new cleanup paths idempotent
- prefer the existing session-removal API over bespoke task-local deletion logic

## Expected Outcome

- repeated `ShareNext` initialization no longer stacks listeners
- queued share sync payloads and timers are released promptly on disposal
- stale pending MCP OAuth transports do not linger after replacement or removal
- the models refresh interval has an explicit cleanup path
- finished task subagent sessions no longer accumulate in memory after their result is folded into the parent

## Verification

Before claiming completion:

- confirm the new `ShareNext` regression tests fail before the change and pass after it
- confirm the MCP transport cleanup tests fail before the change and pass after it
- confirm the subagent cleanup regression test fails before the change and passes after it
- run targeted tests from `packages/opencode`
- run `bun typecheck` from `packages/opencode`

## Notes

This spec intentionally does not include a git commit step. The current repository instructions prohibit git operations unless explicitly requested.
