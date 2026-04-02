# Session Streaming Re-render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce streaming-induced excessive re-renders in the `packages/app` session composer path without changing visible behavior.

**Architecture:** Narrow the reactive graph at the source instead of patching the todo dock locally. Split `createSessionComposerState()` so todo dock state, blocked state, and streaming state do not transitively invalidate each other, then apply the same split-by-concern rule to the adjacent todo refresh effect in `session.tsx`. Verification focuses on reactive boundary tests, not snapshot output.

**Tech Stack:** SolidJS, Bun test, TypeScript, existing session composer helpers in `packages/app`

**Test commands in this plan:** Run all `bun test` and `bun typecheck` commands with `Workdir: packages/app`. `happydom.ts` provides the DOM environment needed by these SolidJS tests.

---

## File Map

- Modify: `packages/app/src/pages/session/composer/session-composer-state.ts`
  Purpose: split entangled composer derivations so dock-related state no longer reacts to unrelated streaming updates.
- Modify: `packages/app/src/pages/session/composer/session-composer-region.tsx`
  Purpose: consume the narrower composer-state shape if needed, while preserving current UI behavior.
- Modify: `packages/app/src/pages/session.tsx`
  Purpose: split the todo refresh effect so unrelated streaming updates do not re-run todo work.
- Modify: `packages/app/src/pages/session/composer/session-composer-state.test.ts`
  Purpose: add reactive boundary regression tests around `createSessionComposerState()` and related helpers.
- Create: `packages/app/src/pages/session/todo-refresh.ts`
  Purpose: expose the pure todo refresh decision helper early so TDD red-stage tests fail on assertions rather than import errors.
- Create: `packages/app/src/pages/session/todo-refresh.test.ts`
  Purpose: cover the extracted todo refresh helper with focused tests instead of relying on broad page-level coverage.
- Optional modify: `packages/app/src/pages/session/composer/index.ts`
  Purpose: export any small helper needed for testing only if the existing file structure becomes too cramped. Avoid this unless necessary.
- Read-only dependency: `packages/app/src/pages/session/composer/session-request-tree.ts`
  Purpose: understand the blocked-state chain that feeds `createSessionComposerState()`.

## Task 1: Add failing reactive boundary tests for composer state

**Files:**
- Modify: `packages/app/src/pages/session/composer/session-composer-state.test.ts`
- Test: `packages/app/src/pages/session/composer/session-composer-state.test.ts`

- [ ] **Step 1: Add a failing test for status-only churn not dirtying todo-focused derivations**

First extract the dock-transition reactive core into a small helper in `session-composer-state.ts` with the current behavior intact. Then write a failing test against that helper instead of the full context-heavy `createSessionComposerState()` entrypoint.

`createSessionComposerState()` depends on context hooks (`useParams()`, `useSDK()`, `useSync()`, `useGlobalSync()`, `useLanguage()`, `usePermission()`). Do not build a large provider tree for the first regression tests. Test the extracted helper directly with `createRoot` and simple signals. Give that helper separate inputs for:

- todos
- active
- blocked
- closeMs
- clear callback

Keep `createSessionComposerState()` as the thin wiring layer that feeds real contexts into the helper.

The test driver override (`test.on`, `test.live`, `composerDriver`, `composerEvent`) stays in `createSessionComposerState()` and is not part of the extracted helper.

Cover this case:

```ts
test("status-only updates do not dirty todo-focused composer state", () => {
  // create root
  // seed todos for a session
  // observe dock-focused accessor/effect count
  // change only busy/status input
  // expect todo-focused count to stay stable
})
```

- [ ] **Step 2: Add a failing positive-path test for status-driven state still updating where required**

Add a second test proving the refactor does not accidentally swallow legitimate stream-state updates.

Cover this case:

```ts
test("status-driven state still updates the streaming branch", () => {
  // create root
  // observe the status-focused accessor count/value
  // change only busy/status input
  // expect the status-focused branch to update
})
```

- [ ] **Step 3: Add a failing test for the adjacent todo refresh dependency split**

Extract the smallest helper from the `session.tsx` todo refresh effect if needed and add a failing test in `packages/app/src/pages/session/todo-refresh.test.ts` first.

Target that helper at the decision boundary, not the whole page. It should accept the small set of inputs that currently drive the refresh effect and make it possible to prove:

- status-driven inputs can be tested independently from blocked-driven inputs
- status-only churn does not force unrelated todo refresh work when the blocked path is unchanged
- legitimate refresh cases still return the expected schedule decision

- [ ] **Step 4: Run the targeted test file and verify failure**

Run: `bun test --preload ./happydom.ts ./src/pages/session/composer/session-composer-state.test.ts`

Workdir: `packages/app`

Expected: existing tests in the file still pass, and only the new reactive boundary tests fail.

If a test depends on deferred effects, flush once with `await Promise.resolve()` before asserting counts. Keep the test synchronous otherwise.

Run: `bun test --preload ./happydom.ts ./src/pages/session/todo-refresh.test.ts`

Workdir: `packages/app`

Expected: FAIL because the current mixed todo refresh decision still couples status and blocked concerns.

## Task 2: Split composer-state derivations by concern

**Files:**
- Modify: `packages/app/src/pages/session/composer/session-composer-state.ts`
- Test: `packages/app/src/pages/session/composer/session-composer-state.test.ts`

- [ ] **Step 1: Refactor the current `live()` dependency chain minimally**

Change `createSessionComposerState()` so the todo dock transition logic no longer transitively depends on a broad `live()` memo that bridges status and blocked state together.

Target shape:

- todo-focused derivations depend on todo data plus only the specific non-todo signal they actually need
- blocked-focused derivations depend on question and permission state
- status-focused derivations depend on `session_status`

Avoid a broad rewrite. Keep behavior the same.

Use this dependency sketch as the guardrail:

```ts
// Before
// dock transition effect -> [todos, done, live]
// live -> busy || blocked
// busy -> session_status
// blocked -> permissionRequest || questionRequest

// After
// dock transition effect -> [todos, done, active, blocked]
// active -> busy boolean only
// the effect tracks active and blocked separately
// the helper may still compute live = active || blocked internally for todoState()
// busy/live state for non-todo consumers stays available separately
```

`done` remains derived from `todos`. It is listed separately here because the current effect already tracks it as a distinct signal.

Concrete rule:

- `live()` is internal to `createSessionComposerState()` and has no external consumers in the current return shape
- remove that internal broad `live()` memo
- stop feeding the dock transition effect through that broad memo
- let the extracted dock helper receive `active()` and `blocked()` as separate inputs so tests can prove which one caused a recomputation

Do not collapse blocked semantics into status semantics or vice versa.

The initial `dock` store value currently depends on `live()`. Keep the effect non-deferred so the synchronous effect pass immediately corrects any stale initial state. Do not introduce a deferred first run here.

- [ ] **Step 2: Preserve the returned state shape unless a narrower API is clearly needed**

If `SessionComposerRegion` can keep using the current shape, prefer that. Only change the outward API if the internal split cannot be expressed cleanly otherwise.

- [ ] **Step 3: Run the targeted composer-state test file**

Run: `bun test --preload ./happydom.ts ./src/pages/session/composer/session-composer-state.test.ts`

Workdir: `packages/app`

Expected: the new reactive boundary tests pass.

## Task 3: Split the adjacent todo refresh effect in `session.tsx`

**Files:**
- Modify: `packages/app/src/pages/session.tsx`
- Create: `packages/app/src/pages/session/todo-refresh.ts`
- Create: `packages/app/src/pages/session/todo-refresh.test.ts`

- [ ] **Step 1: Identify the smallest split for the todo refresh effect**

Start by creating `todo-refresh.ts` with a stub `shouldRefresh()` export so the new test file can import it during the red stage. Then refactor the effect around the tracked tuple that currently mixes:

- `sdk.directory`
- session id
- `session_status`
- `composer.blocked()`

Target shape:

- extract a tiny helper if needed so the scheduling decision is testable without rendering `Page()`
- keep one effect in `session.tsx`, but narrow its tracked inputs to the smallest stable values needed by the refresh decision
- move the pure refresh predicate into `todo-refresh.ts` so tests can prove the mixed decision boundary independently
- keep the effect local to `session.tsx`; do not refactor unrelated session effects

Concrete target:

```ts
shouldRefresh({ active, blocked })
```

where `active` is the smallest status-derived boolean needed by the effect rather than a broader status object or broader reactive path.

`shouldRefresh()` only covers the trigger predicate. Cached-vs-forced refresh behavior and the `id` or `directory` guards stay in `session.tsx`.

- [ ] **Step 2: Keep refresh semantics unchanged**

Preserve:

- refresh still happens when it should during active turns
- cached vs forced refresh logic remains intact
- session and directory guards remain intact

- [ ] **Step 3: Run the narrow test coverage for this effect**

Run: `bun test --preload ./happydom.ts ./src/pages/session/todo-refresh.test.ts`

Workdir: `packages/app`

Expected: PASS.

## Task 4: Update the composer region only if the state split requires it

**Files:**
- Modify: `packages/app/src/pages/session/composer/session-composer-region.tsx`
- Optional modify: `packages/app/src/pages/session/composer/index.ts`
- Test: `packages/app/src/pages/session/composer/session-composer-state.test.ts`

- [ ] **Step 1: Adjust `SessionComposerRegion` for any narrowed accessors**

Only make the smallest required changes so the region reads the new state shape correctly and preserves existing dock behavior.

- [ ] **Step 2: Avoid incidental UI refactors**

Do not change layout, animation timing, or dock ordering unless required by the reactive split.

- [ ] **Step 3: Rerun targeted tests after the wiring change**

Run: `bun test --preload ./happydom.ts ./src/pages/session/composer/session-composer-state.test.ts`

Workdir: `packages/app`

Expected: PASS.

## Task 5: Verify the session page remains stable

**Files:**
- Modify: none unless failures require a small follow-up fix in one of the files above
- Test: nearby session tests in `packages/app/src/pages/session/**/*.test.ts*`

- [ ] **Step 1: Run focused session tests likely to cover the touched path**

Run:

`bun test --preload ./happydom.ts ./src/pages/session/`

Workdir: `packages/app`

Expected: PASS.

- [ ] **Step 2: Run package typecheck**

Run: `bun typecheck`

Workdir: `packages/app`

Expected: PASS.

- [ ] **Step 3: Review for accidental broadening**

Confirm the final diff only touches:

- composer-state derivations
- the adjacent todo refresh effect
- any minimal region wiring required by the state split
- targeted tests

## Task 6: Final verification and handoff

**Files:**
- Modify: none

- [ ] **Step 1: Re-run the exact targeted regression test command**

Run: `bun test --preload ./happydom.ts ./src/pages/session/composer/session-composer-state.test.ts`

Workdir: `packages/app`

Expected: PASS.

- [ ] **Step 2: Re-run the package verification commands**

Run:

- `bun test --preload ./happydom.ts ./src/pages/session/`
- `bun typecheck`

Workdir: `packages/app`

Expected: PASS.

- [ ] **Step 3: Summarize the behavior-level result**

Document:

- which dependency chains were split
- which tests prove status-only streaming churn no longer dirties todo-focused work
- which branch still reacts to legitimate streaming state
