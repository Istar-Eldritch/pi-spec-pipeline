---
name: implement-pipeline
description: |
  Invoke the spec-pipeline implementation workflow. Use when a delivery-plan
  document is ready for coding and the user or another agent explicitly tells
  you to implement it. The pipeline handles plan generation, phased
  implementation, code review, and automated commits per phase.
---

# Implement Pipeline

Use when a delivery-plan document (a spec produced by the `spec-writer` agent,
which includes the phased delivery plan) is ready for implementation and the
user asks you to run it. The pipeline reads the document, extracts phases from
its `Phases (JSON)` block (legacy phase tables are still supported), and
processes each one: implement → review → commit.

## When to use

- A delivery-plan document exists and the user says "implement this", "start implementation", etc.
- Another agent delegates implementation work via /implement

## Usage

When the user asks to implement a delivery plan, tell them:

```
The delivery plan is ready. Run: /implement <delivery-plan-path>
```

Or, if both agents understand the protocol, call it with --auto:

```
/implement --auto docs/2606082331_delivery_plan_auth_flow.md
```

The `--auto` flag allows non-interactive (agent-driven) invocation, skipping
TTY confirmations and answering defaults automatically.

## Optional flags

- `--no-plan` — Skip plan generation (if the spec is already detailed enough)
- `--no-review` — Skip code review cycles
- `--auto` — Skip interactive confirmations (for agent-driven / non-TTY use)

## Worktree Isolation

Every `/implement` run creates a dedicated `git worktree` on a new
`impl/<shortName>-<timestamp>` branch forked from the current `HEAD`:

- **Results land in the worktree branch** — all commits go to
  `impl/<shortName>-<timestamp>`, not to the triggering checkout.
- **Main checkout is untouched** — uncommitted changes in the triggering
  checkout are preserved; only the committed HEAD is used as the base.
- **Worktree location** — `.pi/worktrees/<shortName>-<timestamp>/` by default
  (configurable via `worktree.basePath` in `.pi/spec-pipeline.json`).

### After the pipeline completes

The completion message shows the exact commands. Typical workflow:

```bash
# 1. Navigate to the worktree and inspect/test the changes
cd .pi/worktrees/<shortName>-<timestamp>
bun test   # or whatever the project's test command is

# 2. Merge or open a PR
git checkout main
git merge impl/<shortName>-<timestamp>
# or: gh pr create --head impl/<shortName>-<timestamp>

# 3. Clean up (manual in v1 — not automatic)
git worktree remove .pi/worktrees/<shortName>-<timestamp>
git branch -d impl/<shortName>-<timestamp>
```

### Resume

If the pipeline is interrupted, use `/implement-resume`:
- Reattaches to the existing worktree if it is still intact.
- Recreates the worktree from the branch if the directory was deleted
  (all prior commits are restored).
- Re-runs the setup script if it did not complete in the previous run.

## What the pipeline does

1. Resolves the project root (handles the case where cwd is inside a worktree)
2. Creates an isolated git worktree on a new `impl/` branch
3. Runs an optional setup script in the worktree (e.g. `npm ci`)
4. Parses the phases from the delivery-plan document — preferring the
   `Phases (JSON)` block, falling back to legacy phase-table formats
5. Per phase (inside the worktree):
   - Plans (or reads plan)
   - Implements code and runs tests
   - Reviews with an AI code reviewer
   - Commits with AI-generated message

## Configuration

Reads `.pi/spec-pipeline.json` in the project root for model selection, review
cycles, test commands, and worktree settings.

```json
{
  "testCommand": "bun test",
  "reviewCycles": 2,
  "worktree": {
    "basePath": ".pi/worktrees",
    "setupScript": "cd $PI_MAIN_REPO && npm ci && cp .env.example $PI_WORKTREE_PATH/.env"
  }
}
```

Setup script environment variables: `PI_WORKTREE_PATH`, `PI_WORKTREE_BRANCH`,
`PI_MAIN_REPO`, `PI_IMPL_ID`.
