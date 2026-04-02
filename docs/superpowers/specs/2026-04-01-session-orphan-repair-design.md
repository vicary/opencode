# Session Orphan Repair Design

## Goal

Repair all stale unfinished assistant messages for a session whenever the session is explicitly stopped or when the next prompt begins after a process interruption.

## Context

Assistant messages are persisted in session storage, and the UI loading state is derived from both session status and unfinished assistant messages. If the process dies mid-stream, assistant messages can remain without `time.completed`, leaving the session looking active forever.

The current recovery logic only repairs the most recent unfinished assistant. That is too narrow because multiple unfinished assistant messages can exist in the same session, especially when nested work or prior interrupted runs leave more than one orphan behind.

## Desired Behavior

- `SessionPrompt.cancel(sessionID)` repairs every unfinished assistant message in the session.
- The next `SessionPrompt.prompt(...)` startup recovery path repairs every unfinished assistant message in the session before creating the new user message.
- An unfinished assistant message is any assistant message whose `time.completed` is missing.
- For each repaired assistant message:
  - set `time.completed`
  - preserve any existing `error`
  - otherwise set `MessageAbortedError`
- After the batch repair completes, set session status to `idle` once.

## Non-Goals

- No schema changes.
- No UI-only workaround.
- No new persistent recovery metadata.
- No change to the definition of a completed assistant message.

## Implementation Shape

Keep recovery logic private to `packages/opencode/src/session/prompt.ts` and shared by both recovery entry points:

- `cancel(sessionID)`
- the start of `prompt(...)`

The helper should read session messages through `Session.messages({ sessionID })`, filter to assistant messages whose `time.completed` is missing, and repair each matching message. Replace the current single-message `findLast(...)` behavior with this batch repair logic.

The helper should continue to skip orphan repair when there is active in-memory state for that session.

The `cancel()` path must preserve the single-idle invariant. If `cancel()` keeps responsibility for setting `idle`, the shared repair helper must not also emit `idle` for the same recovery call. If the helper becomes the sole idle-setter, remove the redundant idle update from `cancel()`.

## Testing Strategy

Extend `packages/opencode/test/session/prompt.test.ts` with regressions that prove:

- `cancel()` repairs multiple unfinished assistant messages.
- startup recovery repairs multiple unfinished assistant messages before the next run proceeds.
- existing errors are preserved for each repaired assistant.
- already-completed assistants remain unchanged.
- idle notification behavior remains single-shot per recovery path, not per repaired message.

## Risks

- Repairing all unfinished assistants broadens behavior from the previous implementation, so tests need to document the intended scope clearly.
- The helper should set session status once after the batch instead of once per message to avoid duplicate idle events.
