# Plugin Error Modal Design

## Summary

Plugin install, load, and init failures already reach the app as `session.error` events, but the web UI does not surface them with the existing global dialog system.

The current result is easy to miss:

- the backend publishes the failure
- the app stores an unseen error notification
- the sidebar may show a red dot
- an OS notification may appear if enabled

There is no in-app modal or toast for these plugin failures, even when the failure is severe enough to block plugin behavior entirely.

This design keeps the backend behavior unchanged and reuses the existing app-level dialog path so plugin-related `session.error` events open the normal global modal immediately.

## Problem

The backend already emits plugin failures through `Session.Event.Error` in `packages/opencode/src/plugin/index.ts`.

That includes:

- failed plugin install
- failed plugin resolution / load
- failed plugin initialization

Examples of current emitted messages include:

- `Failed to install plugin broken-plugin@9.9.9: ...`
- `Plugin <spec> skipped: ...`
- `Failed to load plugin <spec>: ...`

On the web side, `packages/app/src/context/notification.tsx` listens for `session.error` and only:

- persists the error into the notification store
- tracks unseen counts and error flags
- optionally sends an OS notification

The web app does not open any in-app modal from that error path.

The existing plugins status surface in `packages/app/src/components/status-popover-body.tsx` also does not help here. It only lists configured plugin names and always renders them with a success-colored dot. It does not read plugin failure state or error text.

This means a user can trigger a plugin failure such as a nonexistent package version and receive no reliable in-app explanation, even though the backend already provided one.

## Goals

- Surface plugin-related failures in the web UI immediately.
- Reuse the existing global dialog system already used elsewhere in the app.
- Avoid introducing a new plugin-specific modal framework, inbox, or notification surface.
- Keep the backend plugin error publication path unchanged.
- Cover all plugin-related failures that already arrive as app-visible error events, not just install failures.

## Non-Goals

- Changing how plugin failures are emitted in the backend.
- Building a general-purpose notification history UI.
- Redesigning the plugins tab in the status popover.
- Adding new navigation requirements tied to the originating project or session.
- Replacing the existing red-dot/unseen notification behavior.

## Approach

### 1. Reuse the existing global dialog path

`packages/app/src/app.tsx` already mounts a top-level `DialogProvider`, and app-level pages and components call `useDialog()` plus `dialog.show(...)` to open global overlays.

This design should use that same mechanism.

Do not introduce:

- a new plugin dialog manager
- a separate modal service
- plugin-specific page state just to open the modal

The new behavior should call the same dialog utility/helper path the app already uses for global dialogs.

### 2. Add plugin error detection in the app-level event flow

The correct place for this behavior is the existing top-level event handling path that already receives cross-project events.

The app already consumes these global events in layout-level code and the notification context. Plugin failures should be detected there rather than in a project-specific screen.

This design recommends `packages/app/src/context/notification.tsx` as the owner for the new detection and modal trigger because it already subscribes to `session.error` globally and already centralizes error-notification persistence for those events.

The detection rule should stay narrow and factual:

- only react to `session.error`
- only react when the server-provided error message is clearly plugin-related

This design intentionally keeps the plugin classification lightweight and message-based because the backend event shape already exists and the user requested reuse of current code paths rather than inventing a broader new mechanism.

The implementation should account for the actual event payload shape already reaching the app. Plugin failures are emitted as structured error objects, not raw strings, so the detection step should extract the message from the existing error object shape before applying plugin-specific matching.

For the current backend emission path, plugin failures arrive as `UnknownError`, so the useful text should be read from `error.data.message` rather than assuming `error.message` or a top-level string payload.

The matching rule should explicitly cover the current plugin-generated message forms:

- `Failed to install plugin ...`
- `Failed to load plugin ...`
- `Plugin ... skipped: ...`

The matching rule should also stay strict enough to avoid false positives from other `session.error` publishers that share the same channel but are not plugin failures, such as config parsing failures and other startup errors.

### 3. Open the modal immediately and globally

When the app receives a plugin-related `session.error`, it should open the existing global dialog immediately.

This should not depend on:

- the currently selected project
- the currently selected session
- whether the user manually opens the plugins tab

That matches the current dialog architecture: dialogs are global app overlays, not project-scoped panels.

Implementation detail: capture the existing dialog handle through the normal synchronous dialog context path and reuse that handle when the async error callback resolves. Do not depend on calling dialog context hooks from inside an arbitrary promise continuation.

Plugin failures from this backend path do not include `sessionID`, so any existing lookup helper will resolve immediately with no session match. The implementation can take advantage of that and open the modal from the same event handling branch without adding any project-selection requirement.

### 4. Keep modal content simple

The modal should present:

- a short failure title
- the raw server-provided error text

It should not attempt to infer extra remediation steps in this pass.

The failure text already contains the useful details, for example the plugin spec and the underlying package or load error.

This keeps the change small and avoids inventing plugin-specific copy logic on top of the backend message.

### 5. Preserve existing notification behavior

The existing notification store and unread/error badge behavior should remain unchanged.

That means plugin failures will still:

- be stored in the notification history
- contribute to unseen/error badge state
- continue using the existing notification plumbing

The dialog is additive. It fills the current immediate-visibility gap without replacing the notification model.

## Data Flow

### Plugin failure

- backend plugin code publishes `session.error` with a plugin-related error message
- web app top-level event handling receives that event
- existing notification handling continues to persist the error
- plugin-specific detection in the app-level flow recognizes the message as plugin-related
- existing global dialog helper/path opens a modal immediately
- modal shows the title and raw error text

### Non-plugin session errors

- backend publishes `session.error`
- existing notification behavior continues unchanged
- no new modal is opened unless the error matches the plugin-related rule

## Error Handling

- If the plugin error event lacks a usable message, fall back to the existing generic request-failed text used elsewhere in the app.
- If multiple identical plugin failure events arrive in a burst, implementation should avoid opening stacked duplicate dialogs for the same failure burst.
- If dialog code cannot be loaded because the component tree is already disposing, skip opening the modal rather than throwing from the event handler.
- If another dialog is already open, opening the plugin error modal will replace it because the current dialog system is single-active-dialog. This pass should accept that existing behavior rather than inventing dialog stacking.

## Testing Strategy

Follow TDD.

### 1. Detection coverage

- add tests for plugin-related error message detection
- add tests proving non-plugin `session.error` messages do not open the modal
- add tests covering all current plugin message variants, including compatibility messages of the form `Plugin ... skipped: ...`

### 2. Modal trigger coverage

- add app-level coverage proving plugin-related `session.error` causes the existing dialog path to open
- verify the modal does not require the originating project or session to be selected
- prefer integration-style coverage with the real dialog provider tree rather than isolated dialog mocks unless a smaller seam is already established in the package

### 3. Regression coverage

- verify existing notification persistence / unseen behavior is not removed by the modal addition
- verify the plugins tab behavior remains unchanged in this pass

### 4. Verification

Run targeted app tests and `bun typecheck` from `packages/app`.

## Risks

- message-based plugin detection could miss a future plugin error string that no longer contains a recognizable plugin prefix
- duplicate backend error emissions could create repeated modals if the app does not coalesce them
- opening a modal for every plugin-related error could feel noisy if a broken config produces several failures in sequence
- the single-dialog architecture means a plugin failure modal can replace an unrelated dialog the user already had open

## Mitigations

- keep detection tied to the current server-emitted plugin error wording and cover it with regression tests
- coalesce duplicate dialogs within a short local window
- keep the first pass narrowly scoped to plugin-related failures only
- accept the current single-dialog replacement behavior in this pass instead of introducing modal stacking or queuing

## Expected Outcome

- a failed plugin install such as a nonexistent version produces an immediate in-app modal in the web UI
- plugin load/init failures are surfaced the same way
- users do not need to inspect local storage, red dots, or OS notifications to understand what happened
- the app stays on the existing global dialog path rather than introducing a new UI mechanism
