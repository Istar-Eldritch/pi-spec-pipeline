# Dirty Tree Support in Spec Pipeline

## Overview

Since the worktree-isolation feature, the **implementation pipeline no longer
requires a clean user checkout** at `/implement` start time.  Every `/implement`
run creates a dedicated `git worktree` on a new `impl/<name>-<timestamp>`
branch, forked from the triggering checkout's `HEAD`.  All code changes, commits,
stash operations, and error-recovery resets happen _inside that isolated
worktree_ — your working tree is never touched.

## Pipeline Types

### Documentation Pipelines ✅ Allow Dirty Tree
These pipelines can run with uncommitted changes in the triggering checkout:
- `/spec` — Create specifications
- `/spec-resume` — Resume spec creation
- `/roadmap` — Create roadmaps
- `/roadmap-resume` — Resume roadmap creation
- `/epic` — Create epics
- `/epic-resume` — Resume epic creation

**Why?** These pipelines only write a single document file.  Commits are
scoped to that file so unrelated dirty changes don't interfere.

### Implementation Pipeline ✅ Now Also Allows Dirty Tree
The implementation pipeline also runs with an uncommitted dirty tree:
- `/implement` — Start implementation (worktree isolation)
- `/implement-resume` — Resume implementation

**How?**  `/implement` warns you that uncommitted changes in the triggering
checkout will NOT be included (the worktree starts from the committed HEAD),
then proceeds.  Your dirty files remain in the triggering checkout unchanged.

**Clean-tree requirement for resume (worktree path):** `/implement-resume`
still requires the _worktree_ to be clean before resuming, because the worktree
is the active implementation surface.  The triggering checkout itself can
remain dirty.

**Legacy resume (states without worktree metadata):** Older pipeline state
files do not have worktree metadata.  For those, `/implement-resume` continues
to require a clean triggering checkout (pre-isolation behaviour) to avoid
accidentally discarding uncommitted user work.

## Worktree Isolation Details

### What happens at `/implement` time

1. Your working tree can have any uncommitted changes — they are noted with a
   warning but do not block the run.
2. A new branch `impl/<shortName>-<timestamp>` is created from `HEAD` and a
   fresh git worktree is checked out at `.pi/worktrees/<shortName>-<timestamp>`.
3. All pipeline work (code generation, commits, stash, reset) runs inside that
   worktree.  Your main checkout is completely untouched.

### Destructive operations run inside the worktree
The operations that previously required a clean user tree now run in the
isolated worktree:

| Operation | Location |
|-----------|----------|
| `git add -A` (agent commits) | worktree |
| `git reset --hard HEAD` (error recovery) | worktree |
| `git clean -fd` (error recovery) | worktree |
| `git stash push --include-untracked` (error recovery) | worktree |

State files (`.pi/spec-pipeline/`), session logs, the error log, and
escalations log are still written to the **main repo root** so they survive
worktree cleanup.

### Scoped Commits (Documentation Pipelines)
Documentation pipelines use **scoped commits** — they only stage and commit
their specific files, ignoring other changes in the working tree.

**Example:**
```
# Your working tree state
specs/my-spec.md       ← being drafted (will be committed)
src/main.ts            ← being implemented (will NOT be committed)
src/utils.ts           ← being implemented (will NOT be committed)

# When spec drafting completes:
git commit specs/my-spec.md  # Only commits the spec
# src/main.ts and src/utils.ts remain uncommitted
```

## Manual Cleanup After Implementation

After merging the implementation branch you should remove the worktree
and its branch to keep the repo tidy.  Cleanup is manual in v1 — the pipeline
provides the exact commands in the completion message:

```bash
# After merging
git worktree remove .pi/worktrees/<shortName>-<timestamp>
git branch -d impl/<shortName>-<timestamp>
```

## Best Practices

1. **`/implement` with a dirty tree** is now safe — the uncommitted changes
   are preserved; only the committed HEAD is used as the worktree base.
2. **`/implement-resume`** (worktree states) checks that the _worktree_ is
   clean.  You can fix code inside the worktree and then resume.
3. **State files don't need commits** — `.pi/spec-pipeline/` is gitignored
   and managed automatically.
4. **Parallel implementations** are supported — each run gets its own
   isolated worktree and branch.

## Implementation Details

### Modified Files Detection
Both implementation and scoped commits use the same file tracking:
- `git diff --name-only HEAD` — tracked file changes
- `git ls-files --others --exclude-standard` — untracked files

### Scoping Logic
When `scopeFiles` is provided to `createAgentCommit()`:
1. Get all modified files since HEAD
2. Intersect with scoped file list
3. Stage only the intersection
4. Commit with appropriate message
5. Ignore everything else

If the scoped file wasn't actually modified, the commit is skipped (nothing to
commit).

## Testing

Run all tests, including the worktree isolation regression:
```bash
bun test
```

The `worktree-isolation.test.ts` suite specifically verifies:
- Pipeline commits in the worktree do not advance the triggering checkout HEAD
- `handleAgentError` stash/reset cycles target the worktree only
- All pipeline commits land exclusively on the `impl/*` branch
- Error logs are written to the main repo, not the worktree
