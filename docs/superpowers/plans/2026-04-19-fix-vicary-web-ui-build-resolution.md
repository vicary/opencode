# Fix Vicary Web UI Build Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `packages/opencode` preview binary builds on `fix/vicary` by fixing the app workspace-module resolution failure without skipping embedded web UI generation.

**Architecture:** Keep the fix limited to app/workspace resolution so the existing `packages/opencode/script/build.ts` flow can continue building and embedding the web UI unchanged. Preserve the branch-specific requirement that embedded web UI builds are mandatory on `fix/vicary`, and do not use `--skip-embed-web-ui`.

**Tech Stack:** Bun, Vite, SolidJS, workspace package exports

---

### Task 1: Confirm the failing workspace resolution boundary

**Files:**
- Modify: `packages/app/vite.js`
- Test: `packages/app` build command

- [ ] **Step 1: Reproduce the failure**

Run: `bun run build`
Expected: FAIL with unresolved import for `@opencode-ai/shared/util/path`

- [ ] **Step 2: Compare app resolver config against the workspace import shape**

Check:
- `packages/app/vite.js`
- `packages/app/tsconfig.json`
- `packages/shared/package.json`

Expected: the package export exists, but app build config does not resolve it correctly during Vite bundling.

### Task 2: Apply the minimal resolver fix

**Files:**
- Modify: `packages/app/vite.js`

- [ ] **Step 1: Add the smallest config change needed for Vite to resolve workspace shared imports**

Keep the fix in Vite config only. Do not rewrite app imports and do not change `packages/opencode/script/build.ts` to skip embedded web UI generation.

- [ ] **Step 2: Re-run the app build**

Run: `bun run build`
Expected: PASS

### Task 3: Rebuild and verify the CLI binary

**Files:**
- Verify: `packages/opencode/script/build.ts`

- [ ] **Step 1: Rebuild the single-platform preview binary with embedded web UI enabled**

Run: `OPENCODE_CHANNEL=latest OPENCODE_VERSION=1.4.12-preview.202604191200 bun run build --single`
Expected: PASS

Constraint: do not use `--skip-embed-web-ui` on `fix/vicary`.

- [ ] **Step 2: Verify installed binary version**

Run: `~/.opencode/bin/opencode --version`
Expected: `1.4.12-preview.202604191200`

- [ ] **Step 3: Verify shared DB channel path**

Run: `~/.opencode/bin/opencode --print-logs stats`
Expected: log line opening `.../opencode.db`, not a channel-specific DB filename.
