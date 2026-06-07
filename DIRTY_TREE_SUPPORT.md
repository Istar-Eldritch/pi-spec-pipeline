# Dirty Tree Support in Spec Pipeline

## Overview

As of version with commit `e7dcfbb`, the spec pipeline extension allows documentation pipelines (specs, roadmaps, epics) to run with a dirty git working tree. This enables true parallel workflows where you can write specifications while an implementation is running.

## Pipeline Types

### Documentation Pipelines ✅ Allow Dirty Tree
These pipelines can run with uncommitted changes:
- `/spec` - Create specifications
- `/spec-resume` - Resume spec creation
- `/roadmap` - Create roadmaps
- `/roadmap-resume` - Resume roadmap creation
- `/epic` - Create epics
- `/epic-resume` - Resume epic creation

**Why?** These pipelines are conversational and only write a single document file (spec or roadmap/epic). The commits are scoped to just that file, so unrelated dirty changes in your working tree don't interfere.

### Implementation Pipeline ⚠️ Requires Clean Tree
This pipeline still requires a clean working tree:
- `/implement` - Start implementation
- `/implement-resume` - Resume implementation

**Why?** The implementation pipeline has destructive git operations:
- `git add -A` - stages everything
- `git reset --hard HEAD` + `git clean -fd` - discards all uncommitted changes during error recovery

A dirty tree here could result in losing unrelated work accidentally.

## How It Works

### Scoped Commits
Documentation pipelines use **scoped commits** — they only stage and commit their specific files, ignoring other changes in the working tree.

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

This is implemented via an optional `scopeFiles` parameter in `createAgentCommit()`:

```typescript
// Commit only the spec file, ignoring other dirty files
await createAgentCommit(
  cwd, state,
  { role: "specDrafter", modelConfig: specDrafterConfig },
  agentConfig,
  saveFn,
  notify,
  [state.specPath]  // ← scoped to just this file
);
```

## Workflow Example

### Parallel Spec Writing + Implementation

Terminal 1 - Writing a spec:
```bash
$ /spec "Add user authentication system"
📝 Drafting Mode
...
/spec-draft-done
✅ Spec completed
```

Terminal 2 - Implementation in progress:
```bash
$ /implement specs/auth-spec.md
🚀 Starting implementation...
[Phase 1] Implementing...
```

The spec writing in Terminal 1 works fine — it commits just the spec file, even though Terminal 2 has uncommitted code changes.

## Git State Management

### What Gets Committed?
- **For specs**: Only `specs/<timestamp>_<name>_spec.md`
- **For roadmaps**: Only `specs/<timestamp>_<name>_roadmap.md`
- **For epics**: Only `specs/<timestamp>_<name>_epic.md`
- **For implementations**: All modified files (requires clean tree first)

### What Doesn't Get Committed?
- `.pi/spec-pipeline/` state files (gitignored)
- Unrelated changes in your working tree
- State files are persisted locally but not committed to git

## Error Recovery

### Documentation Pipelines
On error, dirty files are **preserved** — the failing operation is stashed, but other work remains untouched.

### Implementation Pipeline
On error, dirty files are **stashed and reset** to ensure a clean state for retry. This is one reason why a clean tree is required at `/implement` start time.

## Best Practices

1. **Before starting `/implement`**: commit or stash all unrelated changes
   - This prevents accidental data loss during error recovery

2. **Parallel work is safe**: write specs while implementation runs
   - Each uses scoped commits, so they don't interfere
   - Each maintains its own checkpoint/state file

3. **State files don't need commits**: `.pi/spec-pipeline/` is gitignored
   - These are implementation details, not source code
   - They're automatically managed by the pipeline

## Implementation Details

### Modified Files Detection
Both implementation and scoped commits use the same file tracking:
- `git diff --name-only HEAD` - tracked file changes
- `git ls-files --others --exclude-standard` - untracked files

### Scoping Logic
When `scopeFiles` is provided to `createAgentCommit()`:
1. Get all modified files since HEAD
2. Intersect with scoped file list
3. Stage only the intersection
4. Commit with appropriate message
5. Ignore everything else

If the scoped file wasn't actually modified, the commit is skipped (nothing to commit).

## Testing

Three new tests verify scoped commit behavior:
- `commits only scoped files while leaving other dirty files untouched`
- `skips commit when scoped file is not in modified files`
- `handles multiple scoped files`

Run tests:
```bash
npm run test -- extensions/spec-pipeline/git.test.ts
```

All 315 tests pass, including the 53 git-related tests.
