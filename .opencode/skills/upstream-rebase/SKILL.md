---
name: upstream-rebase
description: Rebase this fork onto a newer upstream tag in an isolated worktree and replay only still-needed fork intent
---

# Upstream Rebase

Use this when moving the fork onto a newer upstream tag.

## Intent

- Start every rebase from the base checkout.
- Do the replay in an isolated `.worktrees/rebase-v<target>` checkout.
- Treat fork commits as intent to replay, not patches to apply mechanically.
- Drop commits that upstream already covers.
- Rebuild the fork after the rebase completes.
- Never update, replace, or repoint `~/.opencode/bin/opencode` during rebase work. The global launcher remains owned by the base checkout.

## Recommended workflow

1. Start in the clean base checkout on the fork branch. Do not begin from a pre-existing isolated worktree.
2. Update upstream tags if needed.
3. From the base checkout, create a dedicated rebase worktree and the target fork branch:

```bash
git worktree add -b fix/vicary-v<target> .worktrees/rebase-v<target> <fork-branch>
```

4. In the rebase worktree, move the fork branch onto the new upstream tag.
5. Replay the fork commit-by-commit in original order:
   - inspect each commit's intent first
   - if upstream already implements that behavior, drop it
   - if the intent is still needed, reimplement it against the current file layout and architecture
   - keep each replacement commit scoped to the original behavior only

## Review rules while replaying

- Prefer `git status`, `git diff`, and `git log --oneline` to keep the worktree auditable.
- When a fork change is operational only, keep it in repo-local metadata like `.opencode/skills/*` instead of product code.
- Use current repo conventions while rewriting: `packages/opencode` for the CLI package, `.worktrees/...` for isolated rebases, and `dev` as the default branch name.
- If a commit conflicts with current upstream architecture, adapt the implementation to current files instead of forcing the old hunk layout.

## Finish

1. Verify the rebase worktree is clean.
2. Rebuild the forked CLI with the `preview-build` skill, validating the worktree binary directly.
3. Verify the rebuilt binary reports the intended preview version before using it for further testing.
4. Do not touch `~/.opencode/bin/opencode` during this worktree phase. Only after the branch is promoted into the base checkout may the base checkout update its own launcher target.
