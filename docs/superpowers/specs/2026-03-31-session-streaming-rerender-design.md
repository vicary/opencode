# Session Streaming Re-render Design

## Summary

The `packages/app` session page currently mixes several reactive concerns in shared top-level derivations. During active LLM streaming, updates to `sync.data.session_status`, session messages, and blocking-related session data can invalidate broader UI branches than necessary. The todo dock exposes the problem most clearly because it is sensitive to parent churn, but the underlying issue is a more general streaming-induced over-render pattern across the session composer path.

This design splits the reactive graph by concern so streaming updates stay local to the branches that actually need them.

## Problem

The current session composer state combines these concerns in one reactive path:

- todo data and dock open/close state
- question and permission blocking state
- busy or live session state derived from `session_status`
- request-derived blocking state that depends on session, question, and permission data

In `createSessionComposerState()`, `live()` depends on both `busy()` and `blocked()`. `busy()` depends on `sync.data.session_status[id]`, while `blocked()` depends on `permissionRequest()` and `questionRequest()`, which in turn derive from session, permission, and question state. That means stream-status churn and request-tree churn can both propagate through the composer state even when the change is irrelevant to todo content or dock visibility. The composer region then passes broad derived state into multiple dock branches, so unrelated streaming updates can re-run work in the todo dock and nearby composer subtree.

One concrete adjacent example is the todo refresh effect in `session.tsx`, which currently combines `session_status`, `composer.blocked()`, and todo refresh triggering in one effect. That makes it a direct candidate for the same split-by-concern rule. The scope of this design is limited to that composer path and immediately adjacent session-page derivations that mix `session_status`, `todo`, and blocked state in the same reactive unit.

## Goals

- Reduce streaming-induced excessive re-renders on the session page.
- Prevent the visible todo list from being disturbed by unrelated streaming-induced parent churn.
- Keep existing composer, dock, and streaming behavior unchanged from the user's perspective.
- Fix the general invalidation pattern, not just the todo dock symptom.
- Make it verifiable that `session_status`-only changes do not force todo-focused composer branches to re-execute.

## Non-Goals

- Full session page architecture rewrite.
- Visual or interaction changes to the composer docks.
- New caching layer or persistent UI state system.

## Approach

### 1. Split composer state by concern

Refactor `createSessionComposerState()` so it no longer exposes a broad reactive bundle where todo visibility, blocked state, and live or busy state are tied together through shared derivations.

Instead, derive separate narrow accessors for:

- todo data
- todo dock visibility state
- question or permission blocked state
- stream activity state used only where live status matters

This keeps `session_status` subscriptions out of branches that do not need to react to every streaming tick.

### 2. Narrow subscriptions at `SessionComposerRegion`

Keep `SessionComposerRegion` consumption fine-grained, but focus the refactor on the derivations exposed by `createSessionComposerState()`. The main problem is not that the JSX reads a broad props object. The problem is that the composer-state memos and effects currently entangle independent concerns before `SessionComposerRegion` consumes them.

Examples:

- `SessionTodoDock` should depend on isolated todo data and dock-progress state, not composer-state derivations whose internal effect graph is dirtied by unrelated stream activity.
- permission and question docks should depend on their own request state and response state.
- prompt input visibility should depend on blocked state, not on todo or stream state unless required.

The concrete target here is to narrow the internal `createSessionComposerState()` dependency graph so the dock-related effect and related memos do not react when only `session_status` changes and todo or blocked inputs are unchanged.

### 3. Apply the same rule to adjacent session-page derivations

Review only the immediate session page path for other broad memos or effects that mix independent concerns. The in-scope non-composer example is the todo refresh effect in `session.tsx` that currently reacts to `session_status` and `composer.blocked()` together. Where the change is low-risk, split those derivations so:

- message timeline concerns stay tied to message and stream state
- todo concerns stay tied to todo state
- composer blocking concerns stay tied to question and permission state

This is intentionally local to the session page path. It does not authorize a broad refactor of unrelated session-page state. The goal is to remove the specific anti-pattern where one reactive source invalidates unrelated UI branches in the composer and todo-refresh path.

In scope:

- `createSessionComposerState()` derivations that currently tie together todo, blocked, and live or busy state
- the todo refresh effect in `session.tsx`

Out of scope:

- message timeline rendering and staging logic
- diff refresh and review-panel effects
- general session sync effects that do not participate in composer or todo invalidation

## Expected Outcome

- Streaming responses continue updating the timeline and stream indicators.
- Composer subtrees that do not depend on the current streaming tick stop re-running unnecessarily.
- The todo list remains stable because unrelated parent invalidation is reduced rather than patched around locally.
- Subagent-heavy sessions no longer amplify needless rerenders in the composer region.
- A `session_status` change on its own, with todo data and blocked state unchanged, does not trigger todo-focused composer derivations or tests that model those boundaries.

## Testing Strategy

Follow TDD for the refactor:

1. Add a failing regression test around the new composer-state derivation boundaries.
2. Add at least one reactive test for `createSessionComposerState()` itself, because the current tests do not exercise its dependency boundaries.
3. Verify streaming-status churn does not change todo-derived outputs when todo, blocked, and dock inputs are unchanged.
4. Verify the split session-page todo refresh path does not re-run todo work when only unrelated streaming state changes.
5. Run the relevant `packages/app` session composer tests and update them only where the refactor intentionally changes derivation boundaries.

Use focused reactive tests rather than UI snapshot-style coverage. The point is to prove dependency isolation, not just output equality.

The reactive tests should use the normal SolidJS test pattern for this codebase: create a root, instantiate `createSessionComposerState()`, attach `createEffect` or `createComputed` counters to the derived accessors under test, then mutate only one concern domain at a time and assert the unrelated counters do not advance. Reuse the existing session-composer test harness where it helps control test inputs, but add explicit computation-count assertions because the current tests do not cover `createSessionComposerState()` itself.

## Risks

- It is easy to preserve the same values while accidentally keeping the same subscription shape. The implementation should verify the actual dependency boundaries, not just returned values.
- Some current behavior may implicitly rely on shared recomputation timing. The refactor should preserve behavior while narrowing dependencies.
- Over-correcting into too many layers of helpers would add complexity without much gain. Prefer a minimal split that makes dependencies explicit.
- The visible symptom may come from repeated parent churn rather than literal component remounts. Verification should focus on dependency isolation and stable behavior rather than assuming a specific remount mechanism.
- `SessionComposerState` is a consumed shape, so narrowing it may require coordinated updates where that return type is used.

## Verification

Before claiming completion:

- run the targeted composer or session tests in `packages/app`
- confirm the new regression test fails before the refactor and passes after it
- confirm no unrelated session tests regress
- confirm the new reactive tests prove `session_status`-only changes do not dirty todo-focused derivations
