# Repo Cleanup Protocol

Purpose: keep local repo cleanup predictable after rebuilds without deleting artifacts that are intentionally preserved for this fork's workflow.

## Rebuild Protocol

- Rebuild from `packages/opencode` with the production command `OPENCODE_CHANNEL=latest bun run build --single` plus the required preview-version override for this fork.
- Never run the rebuild in the foreground.
- Start the rebuild in the background, preferably in `tmux`.
- Capture stdout/stderr to a log file and write the final exit code to a separate marker file.
- Poll for completion every 120 seconds until the exit marker appears.
- Keep the build production-targeted end to end; do not use dev servers, dev bundles, or any workflow that leaves the embedded web UI in a DEV build state.

## Keep

- Keep `packages/opencode/dist/`
- Keep `packages/opencode/bin/`
- Keep `~/.opencode/bin/opencode` as a symlink to the current `packages/opencode/dist/.../bin/opencode`
- Keep committed repo files, docs, and user-authored local edits unless explicitly asked to remove them
- Keep named stashes unless explicitly asked to drop them

## Safe To Remove

- Repo root `node_modules/`
- Package-local `node_modules/` such as `packages/opencode/node_modules/`
- Repo-local temporary directories such as `tmp/`
- Bun install cache via `bun pm cache rm`

## Do Not Remove By Default

- `packages/opencode/dist/` because the local built binary is expected to remain available after cleanup
- Any tracked files with local modifications
- `.git/`, branches, stashes, or other git state
- Files outside this repo unless the cleanup request explicitly includes them

## Cleanup Sequence

1. Inspect `git status --short` first and identify unrelated user changes.
2. Confirm the binary has already been rebuilt if the session required a rebuild.
3. Remove only allowed disposable caches.
4. Re-check `git status --short`.
5. If the rebuilt binary is expected to stay usable, verify:
   - `~/.opencode/bin/opencode --version`
   - `~/.opencode/bin/opencode --print-logs stats`

## Repo-Specific Note

For this fork, cleanup must preserve the current local CLI build output in `packages/opencode/dist/`. Removing `dist/` after a rebuild is considered drift unless the user explicitly asks for a full artifact purge.
