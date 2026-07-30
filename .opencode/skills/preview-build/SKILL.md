---
name: preview-build
description: Rebuild this fork's local preview CLI in the background and verify the result
---

# Preview Build

Use this when the fork needs a fresh local CLI binary after code changes or a rebase.

## Intent

- Keep the build operational and fork-local.
- Run the build from `packages/opencode`.
- Set `OPENCODE_CHANNEL` and `OPENCODE_VERSION` explicitly so the preview binary and embedded web UI report the intended preview version.
- Run the build in a detached `tmux` session so the terminal stays usable.
- Keep `~/.opencode/bin/opencode` pointed at the base checkout. A build from an isolated worktree must never update, replace, or repoint that symlink.

## Recommended workflow

1. Start from the repo root with a clean worktree.
2. Pick the exact preview version string you want to test. Use an explicit semver preview such as `<target>-preview.<utcstamp>`.
3. Start the build in `tmux`:

```bash
stamp="$(date -u +%Y%m%d%H%M%S)"
version="<target>-preview.${stamp}"
log="/tmp/opencode-preview-build-${stamp}.log"
tmux new-session -d -s opencode-preview-build \
  "cd $(pwd)/packages/opencode && OPENCODE_CHANNEL=dev OPENCODE_VERSION=${version} ./script/build.ts --single >${log} 2>&1"
```

4. Poll progress without blocking your shell:

```bash
tmux capture-pane -pt opencode-preview-build
```

5. When the build finishes, inspect the current-platform binary under `packages/opencode/dist/opencode-<platform>/bin/opencode`.

## Launcher boundary

- The global launcher `~/.opencode/bin/opencode` belongs to the base checkout.
- Never point that symlink at an isolated rebase worktree, even temporarily.
- While validating an isolated-worktree build, execute its `packages/opencode/dist/opencode-<platform>/bin/opencode` binary directly.
- Update the global launcher only after the rebased branch has been promoted into the base checkout, and only point it at the base checkout's `packages/opencode/dist/.../bin/opencode` path.

## Verification

Run the built binary directly first:

```bash
./packages/opencode/dist/opencode-<platform>/bin/opencode --version
```

Confirm the reported version matches the explicit `OPENCODE_VERSION` you chose.

For a base-checkout build, verify `~/.opencode/bin/opencode` too instead of relying on plain `opencode`, because `PATH` can still resolve a different install. Do not use that symlink to validate an isolated-worktree build.

## Notes

- `packages/opencode/script/build.ts` already passes `VITE_OPENCODE_VERSION=${Script.version}` into the embedded app build, so explicit preview versions flow through both the CLI and embedded UI.
- Clean up the tmux session after the build if it is still running: `tmux kill-session -t opencode-preview-build`.
