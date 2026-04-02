# Preview Plugin Version Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop preview CLI builds from resolving config-installed `@opencode-ai/plugin` to unpublished preview versions by mapping preview CLI versions to the previous stable patch release, with `latest` as the defensive fallback.

**Architecture:** Keep the fix inside `packages/opencode/src/config/config.ts`. Add one pure helper that resolves the plugin dependency target from explicit inputs, then wire both `installDependencies()` and `needsInstall()` through it so the write path and stale-check path stay aligned.

**Tech Stack:** TypeScript, Bun test runner, semver, existing config install and package registry logic

---

## File Map

- Modify: `packages/opencode/src/config/config.ts`
  Add the pure plugin target resolver and replace the direct `Installation.VERSION` usage in config dependency installation.
- Modify: `packages/opencode/test/config/config.test.ts`
  Add unit tests for resolver behavior and one narrow integration test proving config install wiring uses the resolved version.

## Implementation Notes

- Follow TDD strictly for each behavior change.
- Run tests from `packages/opencode`, never from repo root.
- Do not commit during execution unless the user explicitly asks.
- Keep the change scoped to `@opencode-ai/plugin` config dependency resolution only.

### Task 1: Pure Plugin Target Resolver

**Files:**
- Modify: `packages/opencode/src/config/config.ts`
- Modify: `packages/opencode/test/config/config.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Add focused unit tests in `packages/opencode/test/config/config.test.ts` for the new helper using explicit inputs, for example:

```ts
test("plugin target keeps stable versions", () => {
  expect(pluginTarget({ version: "1.3.7", local: false, kind: "install" })).toBe("1.3.7")
})

test("plugin target maps preview version to previous stable patch", () => {
  expect(pluginTarget({ version: "1.3.8-preview.202604021601", local: false, kind: "install" })).toBe("1.3.7")
})

test("plugin target falls back to latest for malformed preview", () => {
  expect(pluginTarget({ version: "broken-preview", local: false, kind: "install" })).toBe("latest")
})

test("plugin target preserves local install/check split", () => {
  expect(pluginTarget({ version: "1.3.8-preview.202604021601", local: true, kind: "install" })).toBe("*")
  expect(pluginTarget({ version: "1.3.8-preview.202604021601", local: true, kind: "check" })).toBe("latest")
})
```

Keep each test focused on one behavior. If the file already has a config-specific `describe`, place these nearby rather than adding a new sprawling test section.

- [ ] **Step 2: Run the config tests to verify RED**

Run: `bun test test/config/config.test.ts`

Expected: FAIL because the resolver helper does not exist yet.

- [ ] **Step 3: Write the minimal resolver implementation**

In `packages/opencode/src/config/config.ts`, add one small pure helper, for example:

```ts
function pluginTarget(input: { version: string; local: boolean; kind: "install" | "check" }) {
  if (input.local) return input.kind === "install" ? "*" : "latest"
  if (/^\d+\.\d+\.\d+$/.test(input.version)) return input.version
  // parse preview core, decrement patch, fallback to latest
  return "latest"
}
```

Use `semver` for the preview core parse/decrement rather than hand-rolled string math. If the version is `1.3.8-preview.<stamp>`, resolve `1.3.7`. If parsing fails or decrement would be invalid, return `latest`.

- [ ] **Step 4: Run the config tests to verify GREEN**

Run: `bun test test/config/config.test.ts`

Expected: PASS for the newly added resolver tests.

- [ ] **Step 5: Quick refactor pass**

Tighten naming and reduce duplication if needed. Keep the helper pure and local to `config.ts`.

### Task 2: Wire Config Install and Stale Check Through the Resolver

**Files:**
- Modify: `packages/opencode/src/config/config.ts`
- Modify: `packages/opencode/test/config/config.test.ts`

- [ ] **Step 1: Write the failing wiring test**

Add one narrow integration-style test in `packages/opencode/test/config/config.test.ts` proving config dependency writing uses the resolved target instead of the raw preview version. For example:

```ts
test("installs previous stable plugin version for preview CLI builds", async () => {
  // arrange writable config dir
  // force resolver inputs through a temporary spy or explicit seam
  // run Config.installDependencies(...)
  // assert generated package.json dependency is "1.3.7", not raw preview version
})
```

If you need a tiny seam to avoid mocking compile-time constants, add it in `config.ts` by routing `Installation.VERSION` and `Installation.isLocal()` through a very small internal function that the test can patch. Keep that seam minimal and file-local.

- [ ] **Step 2: Run the config tests to verify RED**

Run: `bun test test/config/config.test.ts`

Expected: FAIL because `installDependencies()` and `needsInstall()` still use raw `Installation.VERSION`.

- [ ] **Step 3: Write the minimal wiring change**

Update `packages/opencode/src/config/config.ts` so:

- `installDependencies()` uses `pluginTarget({ version: Installation.VERSION, local: Installation.isLocal(), kind: "install" })`
- `needsInstall()` uses `pluginTarget({ version: Installation.VERSION, local: Installation.isLocal(), kind: "check" })`

Keep the existing `latest` branch behavior in `needsInstall()` for outdated checks exactly as-is once the helper returns `latest`.

- [ ] **Step 4: Run the config tests to verify GREEN**

Run: `bun test test/config/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Quick refactor pass**

Make sure there is only one shared resolver and no duplicated preview-version logic remains in the file.

### Task 3: Final Verification

**Files:**
- Verify only; no new files required

- [ ] **Step 1: Run the full config test file**

Run: `bun test test/config/config.test.ts`

Expected: PASS.

- [ ] **Step 2: Run package typecheck**

Run: `bun typecheck`

Expected: PASS.

- [ ] **Step 3: Review behavior against the spec**

Confirm:

- stable CLI versions still pin exact plugin versions
- preview CLI versions map to the previous stable patch plugin version
- malformed preview versions fall back to `latest`
- local builds still use `*` for install writes and `latest` for stale checks
- `installDependencies()` and `needsInstall()` share the same resolver logic
