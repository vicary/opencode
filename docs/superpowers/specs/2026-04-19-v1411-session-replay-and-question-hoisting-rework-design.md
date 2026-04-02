# v1.4.11 Session Replay and Question Hoisting Rework Design

## Goal

Rework two branch-local fixes so they follow the correct architecture introduced in `v1.4.11` instead of preserving carried-forward `1.2.x` patch structure.

The rework keeps only the intended behavior of each historical fix:

- `70ac2649b3bc97e5bf83f35cd7d817ee9a741657` (`fix(session): skip pending tool stubs on replay`)
- `65fbbf3e3e673d25487e4a42374787aff66a8927` (`fix(question): hoist nested prompts to root session`)
- `3199383eef4cc2ac4ca086f9485b071061dcff70` (`fix: finalize interrupted bash via tool result path (#21724)`)

It must preserve upstream contracts and conventions, allow necessary related call-site adjustments, and finish with a rebuilt CLI binary that embeds the web UI.

## Reference Architecture

`v1.4.11` is the source of truth for architecture and control flow.

This means:

- preserve the flat top-level module shape and current self-reexport conventions
- preserve the `v1.4.11` replay/message assembly structure in `session/message-v2`
- preserve the Effect-based service structure and event contract in `question/index`
- re-apply behavioral intent as a small semantic delta on top of that structure rather than carrying forward branch-local reshuffles

## Scope

The scope is restricted by upstream contract and commit intention, not by file list.

Included work:

- rework replay serialization where the pending-vs-running tool state behavior belongs
- rework question hoisting where root-session resolution belongs
- rework interrupted-session cleanup where stale open assistant turns are normalized after a later user turn
- update direct tests and any required contract-adjacent code that must change to keep the `v1.4.11` architecture coherent
- rebuild `packages/opencode` with embedded web UI enabled
- verify installed binary version and shared DB channel behavior

Excluded work:

- unrelated replay/session refactors
- broad question UI redesign
- behavior changes beyond the intent of the two historical fixes

## Rework 1: Session Replay

### Intent To Preserve

Preserve only the valid semantic change from `70ac2649b3bc97e5bf83f35cd7d817ee9a741657` (`fix(session): skip pending tool stubs on replay`):

- omit `pending` tool-input stubs from replay context
- continue converting interrupted `running` tool calls into interrupted error results

### Architecture To Preserve

Use the `v1.4.11` replay structure as the baseline:

- assistant message assembly happens once per assistant message
- synthetic attachment injection happens once after assistant message assembly
- `reasoning` remains a normal assistant-part branch, not nested under tool handling
- `convertToModelMessages` input is built from the same post-assembly result filtering pattern

### Required Behavior

- `completed` tool states continue to serialize normally
- `error` tool states continue to serialize normally, including interrupted output recovery when upstream logic already supports it
- `pending` tool states do not emit replay tool calls or replay tool results
- `running` tool states emit interrupted error results so downstream providers do not see dangling tool calls
- provider metadata and synthetic attachment behavior stay compatible with the `v1.4.11` contract

### Non-Goals

- no broader replay pipeline rewrite
- no opportunistic changes to unrelated part types

## Rework 2: Question Hoisting

### Intent To Preserve

Preserve only the valid semantic change from `65fbbf3e3e673d25487e4a42374787aff66a8927` (`fix(question): hoist nested prompts to root session`):

- questions asked from nested sessions should be associated with the root session

### Architecture To Preserve

Use the current upstream Effect-service conventions introduced after `v1.4.11` without carrying forward broken branch-local usage:

- question hoisting remains inside the question service boundary
- session ancestry lookup uses the session service contract
- error handling uses valid Effect v4 composition, not invalid method-style chaining on yielded values
- asked/replied/rejected events keep a coherent root-session-scoped contract

### Required Behavior

- a question asked from a child session resolves its root session before request storage and event publication
- if a session lookup fails while walking ancestry, the fallback behavior remains safe and deterministic instead of crashing on invalid Effect usage
- reply and reject continue to operate on the stored pending request without changing caller-facing answer semantics
- UI/state consumers continue to observe questions under the root session they are meant to surface in

### Non-Goals

- no new question routing model
- no UI-specific state changes except those required to honor the service contract

## Rework 3: Interrupted Session Cleanup

### Intent To Preserve

Preserve the valid semantic change from `3199383eef4cc2ac4ca086f9485b071061dcff70` (`fix: finalize interrupted bash via tool result path (#21724)`):

- when an earlier assistant turn was interrupted during tool calls and a later user message starts a new turn, the older interrupted turn must be normalized so it no longer leaves the session stuck in a loading state

### Architecture To Preserve

Use the `v1.4.11` prompt/session lifecycle as the baseline:

- session loop completion is still driven by assistant message finish state and tool-call state
- interrupted tool execution remains represented through normal message and part contracts rather than UI-only overrides
- loading state remains derived from canonical session/message state, not from ad hoc front-end patches
- preserve the canonical interrupted-tool-result path introduced by `3199383eef4cc2ac4ca086f9485b071061dcff70`, with any prerequisite output-preservation behavior from `c29392d0857f11208753bd95be76c6069c070289` (`fix: preserve interrupted bash output in tool results (#21598)`) only if required by that contract

### Required Behavior

- if an assistant turn is interrupted while still effectively open, and the user sends a new message, the prior interrupted turn is finalized through the canonical session/tool result path
- unfinished tool-call state from the older turn must no longer cause the session to appear loading after the later turn completes
- the cleanup must preserve any interrupted tool output that upstream behavior already records
- the cleanup must follow the same upstream contract used to represent interrupted tool execution, rather than inventing a separate recovery shape

### Evidence To Preserve In Tests

- a session with an aborted assistant turn followed by a later user turn should end with the newer completed turn clearing loading state
- interrupted exec/shell-style tool calls must not strand the session in an open `tool-calls` state once recovery has happened

### Non-Goals

- no manual database repair path in product logic
- no UI-only workaround that leaves canonical session state inconsistent

## Implementation Strategy

1. Start from the current codebase, but use `v1.4.11` as the structural reference.
2. Rework the replay logic to match the `v1.4.11` control-flow layout.
3. Re-apply only the pending-vs-running tool behavior delta.
4. Rework root-session question hoisting to valid Effect v4 composition.
5. Rework interrupted-session cleanup so prior aborted tool-call turns are normalized through the canonical session lifecycle.
6. Update tests to express intent directly rather than preserve branch-local implementation shape.
7. Rebuild `packages/opencode` with embedded web UI enabled.

## Validation

Targeted verification:

- replay/session tests covering pending, running, completed, error, reasoning, and attachment paths
- question tests covering nested-session hoisting and root-session visibility behavior
- prompt/session tests covering interrupted tool-call turns followed by a later user turn, including the stale-loading regression shape from `ses_2600d39ceffe0HzKysM4UcjBmR`

Build verification:

- run `OPENCODE_CHANNEL=latest OPENCODE_VERSION=1.4.12-preview.202604191200 bun run build --single` from `packages/opencode`
- do not use `--skip-embed-web-ui`
- verify `~/.opencode/bin/opencode --version`
- verify `~/.opencode/bin/opencode --print-logs stats`

## Risks

- replay logic has coupled behavior around tool parts, reasoning parts, and synthetic media injection, so structure-preserving rework matters more than line-for-line patching
- question hoisting spans service and UI-observed behavior, so tests must validate contract-level outcomes rather than local implementation details
- interrupted-session cleanup crosses prompt loop state, tool result finalization, and derived loading behavior, so the fix must land at the canonical session state boundary rather than in view code

## Success Criteria

- the replay rework preserves the `v1.4.11` structure and only keeps the intended pending-vs-running semantic change
- the question-hoisting rework preserves root-session behavior without invalid Effect usage
- interrupted sessions with unfinished tool-call turns are automatically repaired by later user turns so loading clears after the new turn completes
- related tests pass
- the embedded-web-ui CLI build passes and installed-binary checks pass
