# Spec Pipeline Extension

A workflow automation extension for [pi](https://github.com/mariozechner/pi-coding-agent) that takes projects from idea to implementation with AI-assisted discovery, specification, planning, code review, and automated commits.

## Overview

The spec pipeline implements a three-stage, agent-driven development workflow:

1. **Discovery** — The `ux-discovery-interviewer` agent conducts a structured problem-space interview before any spec or code is written.
2. **Spec Writing & Delivery Planning** — The `spec-writer` agent translates the discovery output into a numbered, traceable technical specification with a phased delivery plan, ending in a machine-readable JSON phases block.
3. **Implementation** — `/implement` executes each phase: plan → code → review → commit.

### Key Features

- **Phased Delivery Plans** — The `spec-writer` agent ends every spec with a `Phases (JSON)` block that `/implement` parses to sequence the work automatically (legacy `Phase | Focus | Effort | Difficulty` tables remain supported).
- **Per-Phase Planning** — Each phase gets an AI-drafted implementation plan before coding begins (skip with `--no-plan`).
- **Code Review Loop** — Automated review and fix cycles after every phase (skip with `--no-review`).
- **Git Integration** — Automatic branching, commits, checkpoints, and error recovery.
- **Fully Configurable** — Customize models, thinking levels, review cycles, and context files per project.

## Quick Start

```bash
# 1. Run the discovery interview (optional but recommended)
subagent agent=ux-discovery-interviewer task="<initial feature context>"

# 2. Write the spec (includes the phased delivery plan)
subagent agent=spec-writer task="Read <discovery-path> and write the spec to <output-path>."

# 3. Implement
/implement <spec-path>
```

## Commands

### Implementation

| Command | Description |
|---------|-------------|
| `/implement [--no-plan] [--no-review] [--auto] <delivery-plan.md>` | Start implementation from a delivery-plan file |
| `/implement-resume` | Resume the last active implementation |
| `/implement-status` | Show current implementation status |
| `/implement-list` | List all implementations with their status |
| `/implement-cancel` | Cancel the current implementation |
| `/implement-metrics [id]` | Export metrics JSON for analysis |

## How It Works

### Delivery Plans

The `spec-writer` agent reads a discovery document and produces a technical specification that ends with a phased delivery plan and a machine-readable `Phases (JSON)` block. `/implement` parses this block to sequence the phases:

````markdown
## Phases (JSON)

```json
{
  "phases": [
    { "phase": 1, "focus": "Backend API", "effort": "M", "difficulty": "standard" },
    { "phase": 2, "focus": "Auth migration", "effort": "S", "difficulty": "hard" }
  ]
}
```
````

Phases marked `hard` are automatically routed to the strongest configured model tier.

Legacy formats are still parsed as fallbacks: markdown phase tables (`| Phase 1 | Focus | Effort | Difficulty |`), Typst tables, and inline `### Phase 1: Name` headings.

### Implementation Stage

For each phase, the pipeline:

1. **Plan Drafting** — AI drafts an implementation plan for the phase.
2. **Implementation** — AI writes code according to the plan.
3. **Code Review** — The `codeReviewer` model checks the implementation for up to `reviewCycles` cycles. If NEEDS_CHANGES, the `addressReview` agent applies fixes automatically.
4. **Testing** — Runs the configured test command.
5. **Commit** — Automatic git commit with AI-generated message.

**Flags:**
- `--no-plan` — Skip plan generation (go straight to coding for each phase).
- `--no-review` — Skip code review cycles entirely.
- `--auto` — Run without interactive TTY confirmations (for agent-driven invocation).

### Git Workflow

```
main  (your checkout — untouched during the run)
 │
 └─ impl/<shortName>-<timestamp>  [Isolated worktree branch]
     ├─ Phase 1 commit: Database schema
     ├─ Phase 2 commit: Authentication service
     └─ Phase 3 commit: Integration tests
```

Every `/implement` run creates a dedicated `git worktree` on a new
`impl/<shortName>-<timestamp>` branch forked from your current `HEAD`. All
code changes, commits, and error-recovery operations happen _inside_ that
worktree — your main checkout is never modified.

**Dirty tree is fine at `/implement` time.** Uncommitted changes in the
triggering checkout will not be included (only the committed HEAD is the
worktree base). The pipeline warns you and then proceeds.

**Manual cleanup.** The worktree and branch are kept after the run so you
can inspect, test, and merge at your own pace. The completion message shows
the exact commands:

```bash
# After reviewing and merging
git worktree remove .pi/worktrees/<shortName>-<timestamp>
git branch -d impl/<shortName>-<timestamp>
```

### Error Recovery

1. **Error detected** — Pipeline pauses and shows error details.
2. **Changes stashed** — Uncommitted work is saved to git stash.
3. **State persisted** — Pipeline state is saved to `.pi/spec-pipeline/`.
4. **User intervention** — Fix the issue, adjust context, or update config.
5. **Resume** — Run `/implement-resume` to continue from the last checkpoint.

## Configuration

### Location

Create `.pi/spec-pipeline.json` in your project root:

```json
{
  "testCommand": "bun test",
  "contextFiles": ["CONTRIBUTING.md", "docs/architecture.md"],
  "models": {
    "implementer": { "model": "claude-native/opus", "thinking": "high" }
  },
  "reviewCycles": 2
}
```

Unknown or removed fields (e.g. `specTemplate`, `roadmapDrafter`) in existing
config files are silently ignored for backward compatibility.

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `testCommand` | string | auto-detected | Command to run tests |
| `contextFiles` | string[] | `[]` | Additional files to include as context |
| `reviewCycles` | number | `3` | Code review cycles per phase (`0` = skip review) |
| `skipPlanGeneration` | boolean | `false` | Skip plan generation (equivalent to `--no-plan`) |
| `worktree.basePath` | string | `.pi/worktrees` | Directory where implementation worktrees are created. Relative paths resolve against the project root. |
| `worktree.setupScript` | string | — | Optional shell script run after worktree creation and before the pipeline starts (`cwd` = the new worktree). Non-zero exit aborts the run. |

### Model Configuration

Configure models per-role to optimise cost and quality:

```json
{
  "models": {
    "planDrafter": { "model": "claude-native/opus", "thinking": "high" },
    "implementer": { "model": "claude-native/opus", "thinking": "high" },
    "codeReviewer": { "model": "claude-native/opus", "thinking": "medium" },
    "addressReview": { "model": "openai-codex/gpt-5.5", "thinking": "medium" },
    "agentCommitMessageWriter": { "model": "claude-native/opus", "thinking": "off" }
  }
}
```

#### Available Roles

| Role | Default Tier | Purpose |
|------|-------------|---------|
| `planDrafter` | strong | Draft implementation plan for each phase |
| `implementer` | mid | Write code for each phase |
| `codeReviewer` | strong | Review code changes |
| `addressReview` | mid | Apply fixes based on review feedback |
| `agentCommitMessageWriter` | cheap | Generate commit messages |

#### Thinking Levels

- `high` — Extended reasoning (best quality)
- `medium` — Balanced reasoning
- `low` — Minimal reasoning
- `off` — No reasoning (fastest)

### Model Tiers & Escalation

Use tiers to assign model strength by role category:

```json
{
  "tiers": {
    "strong": { "model": "gpt-5.5", "thinking": "high" },
    "mid":    { "model": "gpt-5.4", "thinking": "medium" },
    "cheap":  { "model": "gpt-5.4-mini", "thinking": "off" }
  }
}
```

Resolution precedence: `models.<role>` (explicit) > `tiers.<tier>` > built-in defaults.

#### Escalation

```json
{
  "escalation": {
    "enabled": true,
    "hardFailureRetries": 1
  }
}
```

Escalation triggers:
1. **Hard failure** — agent exits non-zero, hits context limit, or produces no output.
2. **Second failed review cycle** — `addressReview` fails to earn approval twice.
3. **`hard` difficulty marker** — the implementer is routed to the strong tier up front.

Every escalation is appended as a JSONL line to `.pi/spec-pipeline/escalations.log`.

### Worktree Configuration

Every `/implement` run is isolated in a dedicated git worktree. Two optional
settings control this behaviour:

```json
{
  "worktree": {
    "basePath": ".pi/worktrees",
    "setupScript": "cd $PI_MAIN_REPO && npm ci && cp .env.example $PI_WORKTREE_PATH/.env"
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `basePath` | `.pi/worktrees` | Parent directory for all worktrees created by this project. Relative paths resolve against the project root; absolute paths are used as-is. Cannot be the project root itself or inside `.git`. |
| `setupScript` | (none) | Shell command (`bash -c`) run in the new worktree before the pipeline starts. Use it to install dependencies, copy secrets, or run any per-worktree setup. |

#### Setup Script Environment Variables

| Variable | Value |
|----------|-------|
| `PI_WORKTREE_PATH` | Absolute path to the new worktree |
| `PI_WORKTREE_BRANCH` | Branch name, e.g. `impl/myfeature-2606101218` |
| `PI_MAIN_REPO` | Absolute path to the main repo root |
| `PI_IMPL_ID` | Implementation pipeline ID |

A non-zero exit code aborts the run and leaves the worktree in place for
debugging. `/implement-resume` re-runs the setup script automatically if it
did not complete successfully.

#### Worktree Lifecycle

```
/implement         → worktree created at .pi/worktrees/<shortName>-<ts>
                     branch impl/<shortName>-<ts> forked from HEAD
(pipeline runs)    → commits land on impl/ branch only
/implement-resume  → re-attaches or recreates the worktree
                     (re-runs setup script if it never completed)
(pipeline done)    → worktree and branch kept for manual review

# Cleanup after merge (manual, v1)
git worktree remove .pi/worktrees/<shortName>-<ts>
git branch -d impl/<shortName>-<ts>
```

The `.pi/worktrees/` directory itself is protected by an auto-generated
`.gitignore` (`*`) so worktree directories are never accidentally tracked.

## State Management

Pipeline state is stored in `.pi/spec-pipeline/`:

```
.pi/spec-pipeline/
└── implementations/
    └── <impl-id>/
        └── state.json
```

State files are gitignored and local to your machine.

## Metrics

Use `/implement-metrics [id]` to export metrics JSON:

```json
{
  "metrics": {
    "totalDurationMs": 3600000,
    "planGenerationDurationMs": 600000,
    "implementationDurationMs": 3000000,
    "codeReviewFirstPassRate": 0.67,
    "codeReviewCycles": 3,
    "agentCalls": [ /* ... */ ]
  }
}
```

Use metrics to optimise review cycle counts, identify bottlenecks, and compare model configurations.

## Testing

```bash
# Run all tests
bun test

# Run with coverage
bun test --coverage
```

## Architecture

### Key Files

- **index.ts** — Extension entry point, command registration
- **implement-pipeline.ts** — Phase-by-phase implementation execution
- **worktree.ts** — Git worktree creation, setup-script runner, and resume helpers
- **review.ts** — Code review loop
- **git.ts** — Git operations and error recovery
- **config.ts** — Configuration loading and validation
- **state.ts** — State persistence and management
- **agents.ts** — Agent invocation and subprocess management
- **agents-config.ts** — Agent role and model configuration
- **types.ts** — TypeScript type definitions

## Related Documentation

- [DIRTY_TREE_SUPPORT.md](./DIRTY_TREE_SUPPORT.md) — Dirty-tree support and worktree isolation details
- [specs/implement_optimizations.md](./specs/implement_optimizations.md) — Plan generation experiments
