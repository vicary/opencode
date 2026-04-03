# Instance and LSP Idle Cleanup Design

## Summary

This design adds an explicit idle lifetime to cached project instances and per-root LSP clients, and removes unconditional LSP warming from plain file reads.

The goal is to reduce retained memory in long-lived `opencode web` sessions without making active workspaces feel unstable or forcing aggressive cold starts after short pauses.

The selected scope is intentionally narrow:

- add idle disposal for cached instances in `packages/opencode/src/project/instance.ts`
- add per-root LSP client eviction inside `packages/opencode/src/lsp/index.ts`
- remove unconditional `LSP.touchFile(...)` warming from `packages/opencode/src/tool/read.ts`

## What An Instance Is

In this codebase, an `Instance` is the cached per-directory project context created by `Instance.provide(...)` in `packages/opencode/src/project/instance.ts`.

Each instance holds:

- `directory`
- `worktree`
- `project`
- per-instance state created through `State.create(...)`
- per-instance Effect services created through `InstanceState.make(...)`

`WorkspaceRouterMiddleware` in `packages/opencode/src/server/router.ts` reuses the cached instance for requests that target the same workspace directory.

One instance can own multiple LSP clients for different roots within that workspace. For example, a single project instance may retain one `tsserver` client for the workspace root and a separate `deno lsp` client for a nested Deno subtree.

## Problem

The current retention behavior is too open-ended for long-lived sessions:

- `Instance.provide(...)` caches instances indefinitely unless code explicitly calls `reload()` or `dispose()`.
- `WorkspaceRouterMiddleware` keeps routing requests through those cached instances, so ordinary request traffic can keep old workspaces alive forever.
- `LSP` clients are retained for the life of the instance. They are only shut down when the entire instance is disposed.
- `read.ts` currently warms LSP for every plain text read via `LSP.touchFile(filepath, false)`, even when the read operation itself does not need semantic data.

This means a plain file read can start a language server, and that language server can then remain resident for as long as the parent instance remains cached.

## Goals

- Give cached instances an automatic idle disposal path.
- Allow LSP clients to age out independently of whole-instance disposal.
- Stop plain file reads from implicitly spawning or warming LSP.
- Keep the implementation local to existing ownership boundaries.
- Preserve normal behavior for active workspaces and explicit semantic tools.

## Non-Goals

- Reworking workspace routing.
- Changing the external API for `Instance.provide(...)`.
- Refactoring LSP into a different service model.
- Persisting idle timestamps across process restarts.
- Broad changes to semantic tools beyond removing `read.ts`'s unconditional warm-up.

## Approach

### 1. Instance idle disposal

`packages/opencode/src/project/instance.ts` should keep explicit metadata alongside each cached instance instead of storing only `Promise<InstanceContext>`.

Each cached entry should track at least:

- the boot promise / resolved context handle already needed for reuse
- a `used` timestamp representing the most recent successful or in-flight access
- an `active` count for `Instance.provide(...)` calls currently executing within that instance

`Instance.provide(...)` should:

1. resolve the directory key
2. create the cache entry if missing
3. refresh `used`
4. increment `active` before running `input.fn()`
5. decrement `active` in a cleanup path after the function completes

Add one small module-local sweep loop in `instance.ts`. It should run on a fixed interval and inspect cached entries for idleness. When an entry has been idle past the instance timeout and `active === 0`, the sweeper should dispose that instance through the existing disposal path.

The sweep must confirm the entry is still current before disposing it. If a request refreshed or replaced the cache entry after the sweep decided it was idle, the dispose should be skipped.

This logic should be self-contained in `instance.ts` rather than built around a generic debounce helper. The problem is not just delayed execution; it is safe TTL-based expiry with race checks.

### 2. Per-root LSP client eviction

`packages/opencode/src/lsp/index.ts` should stop modeling clients as a forever-live list.

Each live client should have small metadata that includes:

- the `LSPClient.Info`
- a `used` timestamp for the most recent semantic operation
- the existing root/server identity used to deduplicate clients

All LSP operations that actually rely on semantic state should refresh `used`. This includes `touchFile()` and the request-based APIs such as hover, definition, references, implementation, document symbol, workspace symbol, and call hierarchy operations.

Add one per-instance idle sweep for LSP clients. When a client has been idle past the LSP timeout, the sweep should:

- verify the entry is still current
- shut the client down
- remove it from the in-memory client collection

The sweeper should only evict idle clients, not dispose the whole instance.

This also remains self-baked local logic, not a wrapper around `@std/async` debounce helpers. Debouncing can schedule a later callback, but it does not model a collection of independently expiring root/server clients with current-entry checks and explicit shutdown semantics.

### 3. Narrow `read.ts` behavior

`packages/opencode/src/tool/read.ts` should no longer warm LSP during ordinary plain text reads.

Specifically, remove the unconditional:

```ts
LSP.touchFile(filepath, false)
```

from the normal text-file read path.

This design intentionally uses the stronger condition discussed during brainstorming:

- do not merely skip reads outside the active working directory
- instead, stop warming LSP from plain reads entirely

Skipping only external-directory reads would help the cross-workspace spawn case, but it would still allow ordinary in-workspace reads to start and retain `tsserver`, `deno lsp`, and other clients. That would reduce some accidental churn but would not address the core issue that read-only filesystem inspection is currently coupled to semantic server startup.

LSP warm-up should remain the responsibility of tools that actually need semantic behavior.

## Data Flow

### Instance lifecycle

- router request enters `WorkspaceRouterMiddleware`
- middleware calls `Instance.provide(...)`
- cached instance entry is created or reused
- entry `used` timestamp is refreshed
- entry `active` count increments while request work is executing
- instance sweeper later disposes only entries that remain idle and inactive long enough

### LSP lifecycle

- semantic tool requests LSP work for a file
- LSP resolves or creates the root/server client for that file
- client metadata `used` timestamp is refreshed
- per-instance LSP sweeper later shuts down only clients that remain idle past the LSP timeout

### Read tool

- plain text `read` reads from the filesystem only
- no LSP warm-up occurs from `read`
- later semantic operations still create or reuse LSP clients on demand

## Error Handling

- If an idle instance disposal race is detected because the cache entry changed or became active again, skip disposal.
- If instance disposal fails during sweeping, log it and leave the entry to be retried later rather than crashing request handling.
- If LSP shutdown fails during client eviction, log it and continue cleanup best-effort.
- A failed idle sweep must not surface as a user-facing request failure.

## Configuration

This design expects two small internal idle thresholds:

- one for cached instances
- one for per-root LSP clients

The exact values should be chosen in implementation, but the intended balance is moderate rather than aggressive: long enough to avoid frequent cold starts after short pauses, short enough to stop stale workspaces and roots from living forever.

This pass does not require exposing new user-facing config unless implementation pressure makes that necessary.

## Testing Strategy

Follow TDD for each file touched. Timer-heavy tests are expected and appropriate here.

### 1. Instance idle disposal

- add tests proving idle cached instances are disposed after the timeout
- add tests proving recently reused instances are retained
- add tests proving an active `Instance.provide(...)` call is not disposed mid-flight

These tests should use fake timers or controlled timer seams rather than long real waits.

### 2. Per-root LSP eviction

- add tests proving idle clients are evicted without disposing the whole instance
- add tests proving active semantic operations refresh the client idle timestamp
- add tests proving one stale root can be evicted while another active root in the same instance remains alive

### 3. Read tool

- add regression coverage proving plain text reads no longer call `LSP.touchFile(...)`
- confirm semantic tools still initialize or reuse LSP through their own code paths

### 4. Verification

Run targeted tests and `bun typecheck` from `packages/opencode`.

## Risks

- too-short timeouts would create noticeable restart churn for users who pause briefly and resume work
- disposing an instance while a request is still using it would be a correctness bug
- evicting LSP clients too aggressively would increase latency for semantic tools
- removing `read.ts` warming could expose tools that were accidentally depending on `read` side effects instead of explicit LSP setup

## Mitigations

- use moderate idle thresholds rather than aggressive ones
- track `active` request usage for instances and never dispose while active
- perform current-entry checks before disposal or eviction
- keep semantic tools responsible for their own LSP startup paths
- cover the behavior with timer-driven regression tests

## Expected Outcome

- cached project instances no longer live forever after they go idle
- stale `deno lsp`, `tsserver`, and similar clients can age out without requiring whole-instance disposal
- plain file reads stop triggering accidental LSP startup
- active workspaces still behave normally, with semantic tools warming LSP only when needed

## Verification

Before claiming completion:

- confirm the new instance idle disposal tests fail before the change and pass after it
- confirm the new LSP eviction tests fail before the change and pass after it
- confirm the read-tool regression test fails before the change and passes after it
- run targeted tests from `packages/opencode`
- run `bun typecheck` from `packages/opencode`

## Notes

This spec intentionally does not include a git commit step. The current repository instructions prohibit git operations unless explicitly requested.
