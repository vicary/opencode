# Plugin Error Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface plugin install, load, and compatibility failures in the web UI by reusing the existing global dialog path when plugin-related `session.error` events arrive.

**Architecture:** Keep the change local to `packages/app/src/context/notification.tsx`, which already owns global `session.error` notification handling. Add one small message-extraction helper, one narrow plugin-message matcher, and one existing-dialog-based modal trigger while preserving the current notification persistence and OS-notification behavior.

**Tech Stack:** TypeScript, SolidJS, Bun test runner, existing app dialog provider, existing notification context

---

## File Map

- Create: `packages/app/src/context/notification-plugin.ts`
  Hold the small exported pure helpers for extracting plugin error text and matching plugin-related error messages.
- Modify: `packages/app/src/context/notification.tsx`
  Add plugin error message extraction, plugin error classification, dialog triggering, and duplicate suppression while keeping the existing notification store behavior intact.
- Create: `packages/app/src/context/notification.test.tsx`
  Add focused integration-style tests around `NotificationProvider` with the real dialog provider, `createRoot`, and direct DOM assertions.
- Create: `packages/app/src/context/notification-plugin.test.ts`
  Add narrow unit tests for the exported pure helpers without any provider setup.

## Implementation Notes

- Follow TDD strictly for each behavior change.
- Run tests from `packages/app`, never from repo root.
- Do not commit during execution unless the user explicitly asks.
- Reuse the existing dialog path only: `useDialog()` plus `dialog.show(...)`.
- Keep the change local; do not redesign the plugins tab, add a new modal manager, or remove current notification persistence.
- Plugin failures currently arrive as structured `UnknownError` payloads. Read the message from `error.data.message`.

### Task 1: Extract and Classify Plugin Error Messages

**Files:**
- Create: `packages/app/src/context/notification-plugin.ts`
- Create: `packages/app/src/context/notification-plugin.test.ts`
- Modify: `packages/app/src/context/notification.tsx`

- [ ] **Step 1: Write the failing helper tests**

Create `packages/app/src/context/notification-plugin.test.ts` with focused tests for two small exported helpers in `packages/app/src/context/notification-plugin.ts`:

```ts
test("reads plugin message from UnknownError payload", () => {
  expect(message({ name: "UnknownError", data: { message: "Failed to install plugin demo@9.9.9: boom" } })).toBe(
    "Failed to install plugin demo@9.9.9: boom",
  )
})

test("matches install, load, and skipped plugin errors only", () => {
  expect(isPlugin("Failed to install plugin demo@9.9.9: boom")).toBe(true)
  expect(isPlugin("Failed to load plugin demo: explode")).toBe(true)
  expect(isPlugin("Plugin demo skipped: incompatible")).toBe(true)
  expect(isPlugin("Failed to parse command foo")).toBe(false)
})
```

Keep the tests narrow and use real helper behavior rather than mocks.

- [ ] **Step 2: Run the new notification tests to verify RED**

Run: `bun test --preload ./happydom.ts ./src/context/notification-plugin.test.ts`

Expected: FAIL because the test file and helpers do not exist yet.

- [ ] **Step 3: Write the minimal helper implementation**

In `packages/app/src/context/notification-plugin.ts`:

- add a small `message(...)` helper that returns `error.data.message` for the current `UnknownError` shape and `undefined` otherwise
- add a small `isPlugin(...)` helper that matches only the current plugin message prefixes:
  - `Failed to install plugin `
  - `Failed to load plugin `
  - `Plugin ` combined with ` skipped: `

Then import and use those helpers from `packages/app/src/context/notification.tsx`.

Keep the helper module tiny and narrowly scoped. Avoid broad regexes when simple prefix checks are clearer.
When reading the SDK error union, narrow on `error.name === "UnknownError"` before accessing `error.data.message`.

- [ ] **Step 4: Run the notification tests to verify GREEN**

Run: `bun test --preload ./happydom.ts ./src/context/notification-plugin.test.ts`

Expected: PASS for the helper tests.

- [ ] **Step 5: Quick refactor pass**

Keep names short, remove duplication, and make sure non-plugin error messages remain untouched.

### Task 2: Trigger the Existing Global Dialog for Plugin Errors

**Files:**
- Modify: `packages/app/src/context/notification.tsx`
- Modify: `packages/app/src/context/notification.test.tsx`

- [ ] **Step 1: Write the failing modal behavior test**

Extend `packages/app/src/context/notification.test.tsx` with an integration-style provider test that:

- mounts `NotificationProvider` under the real `DialogProvider`
- provides a small fake `Platform`, `GlobalSDK`, `GlobalSync`, `Settings`, and `Language` context setup
- emits a `session.error` event whose payload is `{ name: "UnknownError", data: { message: "Failed to install plugin demo@9.9.9: boom" } }`
- asserts a dialog is opened through the normal dialog rendering path
- asserts the dialog does not require a selected project or session route

Use the repo's existing test style:

- `createRoot(...)` for provider lifetime
- direct `document.body` assertions rather than testing-library helpers
- real `DialogProvider`

Prefer checking rendered dialog content over spying on a mocked dialog helper.

Because `NotificationProvider` has deep transitive context dependencies, prefer pragmatic module-level mocking for `useGlobalSDK`, `useGlobalSync`, and router params over assembling the entire production provider tree. Keep `DialogProvider` real so the dialog rendering path itself stays real.

Example target assertion shape:

```ts
expect(document.body.textContent).toContain("Failed to install plugin demo@9.9.9: boom")
```

- [ ] **Step 2: Run the notification tests to verify RED**

Run: `bun test --preload ./happydom.ts ./src/context/notification.test.tsx`

Expected: FAIL because plugin errors still only persist notifications and optionally call `platform.notify(...)`.

- [ ] **Step 3: Write the minimal dialog implementation**

In `packages/app/src/context/notification.tsx`:

- add the existing `useDialog` import and capture `dialog` once during provider init
- add one small duplicate-suppression seam local to the file, keyed by the extracted plugin error message, using a concrete short window such as `5000ms`
- in `handleSessionError(...)`, call the existing dialog path when `isPlugin(message)` is true
- keep the `meta.disposed` guard in front of async side effects and use the captured `dialog` handle inside the existing async continuation
- keep the dialog content minimal by rendering the existing `Dialog` component from `@opencode-ai/ui/dialog` inside `dialog.show(() => <Dialog ...>...</Dialog>)`, with a short title and the raw message body

Use the existing global dialog utilities already used elsewhere in the app. Do not add a new shared modal service.

- [ ] **Step 4: Run the notification tests to verify GREEN**

Run: `bun test --preload ./happydom.ts ./src/context/notification.test.tsx`

Expected: PASS, with the plugin error dialog rendered.

- [ ] **Step 5: Quick refactor pass**

Keep the dialog path local and small. Make sure non-plugin errors still avoid the modal.

### Task 3: Preserve Existing Notification Behavior

**Files:**
- Modify: `packages/app/src/context/notification.test.tsx`
- Modify: `packages/app/src/context/notification.tsx` if needed

- [ ] **Step 1: Write the failing regression tests**

Add tests proving the old behavior still remains alongside the new modal:

- plugin `session.error` is still appended to the notification store
- project unseen/error state still updates for the directory
- `platform.notify(...)` still follows the existing `settings.notifications.errors()` gate
- a non-plugin `session.error` does not open the plugin modal
- repeated identical plugin error events in a short burst do not stack duplicate dialogs

- [ ] **Step 2: Run the notification tests to verify RED**

Run: `bun test --preload ./happydom.ts ./src/context/notification.test.tsx`

Expected: FAIL until duplicate suppression and coexistence behavior are correct.

- [ ] **Step 3: Write the minimal regression fixups**

Adjust `packages/app/src/context/notification.tsx` only as needed so:

- append/store behavior stays unchanged
- `platform.notify(...)` keeps its current gate and arguments
- plugin dialog dedup is limited to a short local window
- non-plugin errors continue through the old path without a modal

- [ ] **Step 4: Run the notification tests to verify GREEN**

Run: `bun test --preload ./happydom.ts ./src/context/notification.test.tsx`

Expected: PASS.

- [ ] **Step 5: Review edge cases against the spec**

Confirm:

- plugin errors without `sessionID` still render the modal
- all three current plugin message forms trigger the modal
- config parse failures do not trigger the modal
- one open dialog is replaced by the plugin error dialog under the existing single-dialog behavior

### Task 4: Final Verification

**Files:**
- Verify only; no new files required

- [ ] **Step 1: Run the focused notification test file**

Run: `bun test --preload ./happydom.ts ./src/context/notification.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run the pure helper test file**

Run: `bun test --preload ./happydom.ts ./src/context/notification-plugin.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the full app unit suite**

Run: `bun test --preload ./happydom.ts ./src`

Expected: PASS.

- [ ] **Step 4: Run package typecheck**

Run: `bun typecheck`

Expected: PASS.

- [ ] **Step 5: Review behavior against the spec**

Confirm:

- plugin install/load/compatibility failures open a global modal
- the modal uses the existing dialog system
- the notification store still records the error
- OS notifications still respect current settings and focus rules
- no new plugin-specific notification surface was introduced
