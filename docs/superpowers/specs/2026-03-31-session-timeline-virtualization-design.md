# Session Timeline Virtualization Design

## Summary

The session message timeline in `packages/app/src/pages/session/message-timeline.tsx` currently renders every turn in the visible history window as a mounted DOM node.
`createSessionHistoryWindow()` in `session.tsx` bounds the initial data set and backfills older turns in batches.
`createTimelineStaging()` exists in `message-timeline.tsx`, but today it does not drive the `<For>` loop that renders turns; its staged message subset is effectively unused for row rendering.
Each row uses `content-visibility: auto` with `contain-intrinsic-size` to defer layout cost, but the browser still retains the full subtree.

This design adds true row virtualization inside `MessageTimeline` so only the visible slice of turns (plus overscan) is mounted at any time.

## Problem

In long sessions (50+ turns), every `SessionTurn` component remains mounted after staging completes.
Each turn carries markdown rendering, tool-call parts, code blocks, and nested scrollable regions.
The cumulative DOM weight causes:

- increasing memory consumption as the session grows
- slower scroll-driven layout recalculations
- longer time-to-interactive when switching to a session with deep history

`content-visibility: auto` helps skip paint for off-screen rows, but the component trees, reactive subscriptions, and associated closures remain alive.
True virtualization would unmount rows that leave the visible band and remount them on demand.

## Goals

- Mount only the visible turns plus a configurable overscan band.
- Unmount turns that scroll out of the overscan band, freeing their component trees.
- Preserve existing autoscroll, upward backfill, hash/message anchoring, and the "Load earlier" action.
- Preserve scroll position when measured heights change or rows mount above the viewport.
- Keep the active streaming turn mounted even if it falls just outside the visible band, so live updates remain stable.
- Keep the implementation scoped to the session timeline path on the session page, without introducing a generic virtualizer primitive in `packages/ui`.

## Non-Goals

- A reusable virtualized list component in `packages/ui`.
- Virtualizing anything outside the session message timeline (e.g. file trees, command palettes).
- Pixel-perfect scroll position restoration across page navigations or session switches.
- Smooth-scroll animations during virtualization jumps.

## Approach

### 1. Visible-range computation

Add a reactive primitive (e.g. `createVirtualRange`) inside the session timeline path that derives the visible row range from:

- `scrollTop` of the scroll viewport
- viewport `clientHeight`
- a cumulative height map keyed by `messageID`
- a configurable overscan count (start generous, e.g. 3-5 rows above and below)

The output is a `{ start, end }` index pair into the full rendered ID list.
Only the visible slice is passed to `<For>`.

Use one reactive source for:

- the visible slice
- the top spacer height
- the bottom spacer height

That keeps spacer updates and `<For>` reconciliation in the same synchronous Solid pass.

### 2. Height measurement

Maintain a `Map<string, number>` of measured row heights, keyed by `messageID`.

- Use one shared `ResizeObserver` for mounted rows.
- When a row mounts, observe it and write the measured height into the map.
- On row cleanup, unobserve it so virtualized-away rows do not leak observers.
- Use a single estimated default height of `500px` for rows that have not been measured yet. This matches the current `contain-intrinsic-size` fallback and reduces initial spacer error.
- When a row is remounted after being virtualized away, its last measured height is used as the initial estimate until the observer fires again.

The cumulative offset array is derived from this map and the current rendered message list.
It must be recomputed when the message list changes or any height entry updates.
Clear the height map when the active session changes so measurements from the prior session do not bleed into the next one.

### 3. Spacer elements

Replace the current flat `<For>` with a structure like:

```
<div style="height: {topSpacerPx}px" />
<For each={visibleSlice()}>
  {(messageID) => <TurnRow ... />}
</For>
<div style="height: {bottomSpacerPx}px" />
```

The top spacer height equals the sum of estimated/measured heights for all rows before the visible start index.
The bottom spacer equals the sum for all rows after the visible end index.

### 4. Scroll anchor preservation

When measured heights change for rows above the current `scrollTop`, or when backfill inserts rows above the viewport, adjust `scrollTop` by the delta to prevent visible content from jumping.

This is similar to the existing `preserveScroll` pattern in `createSessionHistoryWindow`, but ownership should be explicit.
The virtualizer becomes the single owner of scroll-anchor correction for the session turn list, including backfill and measured-height updates inside the virtualized region.
`createSessionHistoryWindow` may still decide when to reveal older turns, but it should stop applying its own `scrollTop` correction once virtualization is active.

- Before a height-map update that affects rows above the viewport, snapshot `scrollTop`.
- After the update, compute the cumulative height delta for affected rows and apply it.
- Batch those adjustments inside `requestAnimationFrame` so multiple height changes in one frame produce one correction.

### 5. Streaming turn pinning

The active streaming turn (identified by `activeMessageID()`) must remain mounted even if it falls just outside the computed visible band.
Extend the visible range to include the active turn's index when it is within a fixed small index margin of the mounted band (start with `2` rows beyond the overscan-expanded range, independent of the overscan setting).
This prevents unmount/remount churn during streaming, which would interrupt incremental rendering.

Example: if the strict visible range is `[5, 15]` and overscan is `3`, the mounted band is `[2, 18]`.
If the active turn is at index `19` or `20`, extend the mounted band to include it.
If it is at index `21` or beyond, do not force-include it.

### 6. Integration with existing systems

- **`createSessionHistoryWindow`**: unchanged as the data-window owner. It continues to control which turns are in the history window. The virtualizer operates on the output of `renderedUserMessages`, but anchor correction for that list moves to the virtualizer. Concretely, remove the `preserveScroll` wrapper from the `setTurnStart` call sites that reveal or prepend turns, and let the virtualizer apply the resulting scroll correction from its own height and offset model.
- **`createTimelineStaging`**: do not integrate it into virtualization in the first pass. It does not currently drive row rendering, so the virtualizer should ignore it unless a later change explicitly revives staging as a row-render input.
- **Autoscroll**: the existing autoscroll logic pins `scrollTop` to the bottom. The virtualizer naturally keeps the bottom rows mounted when `scrollTop` is at max.
- **Hash/message anchoring**: `useSessionHashScroll` currently seeks a DOM element by anchor ID. That is no longer sufficient once rows can be unmounted. The session timeline path must expose a virtualizer handle from `MessageTimeline` to `session.tsx`, and `useSessionHashScroll` must call `ensureVisible(messageID)` before attempting DOM-based anchor scroll. `ensureVisible` should return a promise that resolves after the target row is mounted, so the hook can await that signal before running its DOM lookup path.
- **"Load earlier" button**: remains above the turn list, outside the virtualized region.
- **Scroll events**: visible-range recomputation should track live `scrollTop` changes without debouncing so fast scrolling does not show blank bands.
- **DOM-scanned active cursor**: `session.tsx` currently has DOM-based logic that scans `[data-message-id]` elements to infer the current message near the viewport. After virtualization it will only see mounted rows. Verify that this remains acceptable for its current use, or switch that lookup to the virtualizer's range and offset data.

This means the implementation is still session-local, but it is not confined to one file. `message-timeline.tsx`, `session.tsx`, and `use-session-hash-scroll.ts` are all in scope.

### 7. Phasing

Start minimal:

1. One fixed estimated row height, generous overscan, no dynamic overscan tuning.
2. Basic `ResizeObserver` measurement, no debouncing or batching beyond what the browser provides.
3. Anchor preservation for height changes and upward backfill.
4. Streaming turn pinning.
5. Remove the row-level `content-visibility` and `contain-intrinsic-size` styles once virtualization is active.

Optimize later if needed:

- Adaptive estimated height based on measured average.
- Hybrid approach where recently-measured rows keep their height and only truly unknown rows use the estimate.
- Reduced overscan once measurement accuracy is validated.

## Expected Outcome

- Long sessions mount a bounded number of `SessionTurn` components regardless of total turn count.
- Memory usage scales with visible turns, not total history.
- Scroll performance remains smooth because off-screen component trees are fully unmounted.
- Existing user-facing behavior (autoscroll, backfill, anchoring, streaming) is preserved.
- The `content-visibility` / `contain-intrinsic-size` hints on individual rows can be removed once virtualization is active, since off-screen rows are no longer in the DOM.
- The existing session streaming rerender spec remains complementary because it explicitly leaves message timeline rendering out of scope.

## Testing Strategy

Follow TDD for the implementation.
Tests live in `packages/app` and run from that directory.

### 1. Visible-range math

Unit-test the range computation function in isolation:

- Given a list of heights, a `scrollTop`, and a viewport height, assert the returned `{ start, end }` range.
- Test edge cases: empty list, single row taller than viewport, `scrollTop` at 0, `scrollTop` at max.
- Test overscan: the range extends beyond the strictly visible rows by the configured overscan count.

### 2. Anchor preservation on height changes

Test that when a measured height changes for a row above the viewport, the computed scroll adjustment equals the height delta.
This can be a pure-function test against the anchor-preservation logic without requiring a real DOM.

### 3. Streaming turn pinning

Test that when the active `messageID` falls just outside the computed visible range, the range is extended to include it.
Test that when the active `messageID` is far outside the range (e.g. user scrolled away), it is not force-included.

### 4. Regression: bounded mount count

Add a test that creates a session with a large number of turns (e.g. 100) and asserts that the number of mounted `SessionTurn` components at any given time is bounded by the visible count plus overscan, not the total turn count.
This is the key regression guard against reverting to the current mount-everything behavior.

### 5. Integration with hash scrolling

Verify that a hash target outside the current visible band can still be revealed and scrolled to through the virtualizer handle.

### 6. Backfill anchor handoff

Verify that upward backfill results in exactly one scroll-position correction after virtualization owns anchor preservation.
The session history window must no longer apply a second correction through `preserveScroll`.

## Risks

- **Height estimation inaccuracy**: if the default estimated height is far from actual heights, spacer sizes will be wrong and scrollbar thumb position will jump as rows are measured. Mitigation: start with `500px`, matching the current fallback, and only tune later if measurements show a better baseline.
- **Scroll anchor drift**: rapid height changes during streaming could cause small cumulative drift if anchor adjustments are not frame-synchronized. Mitigation: batch anchor adjustments within `requestAnimationFrame`.
- **Hash scroll to unmounted rows**: if `useSessionHashScroll` fires before the virtualizer has expanded the range to include the target, the anchor element will not exist. Mitigation: the virtualizer must expose an `ensureVisible(messageID)` method that `useSessionHashScroll` calls before relying on the element being in the DOM.
- **Interaction with `content-visibility`**: during the transition, rows inside the visible band should not have `content-visibility: auto` since they are already guaranteed visible. Rows outside the band are unmounted entirely. The existing `content-visibility` style can be removed from virtualized rows.
- **Complexity budget**: the virtualizer adds a new reactive layer. Keeping it scoped to `message-timeline.tsx` and avoiding a generic abstraction limits the blast radius, but the height-map and anchor logic still need careful testing.
- **Scrollbar wobble**: total virtual height will shift as unknown rows are measured, so the browser thumb can change size or position slightly during exploration of new areas. This is expected for a dynamic-height virtualizer.
- **Hash-scroll timing**: a heavy target row may take longer than a few animation frames to mount and settle. Mitigation: `ensureVisible` should be the readiness signal, not a fixed retry budget.

## Verification

Before claiming completion:

- Run the targeted session and timeline tests in `packages/app`.
- Confirm the bounded-mount-count regression test fails before the change and passes after.
- Confirm the visible-range math tests cover edge cases and overscan.
- Confirm anchor preservation tests pass for both height-change and backfill scenarios.
- Confirm streaming turn pinning works: the active turn stays mounted during streaming even when near the edge of the visible band.
- Confirm hash/message anchoring works for turns outside the initial visible range.
- Confirm no unrelated session tests regress.
