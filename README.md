# Spec Pipeline Extension

A workflow automation extension for [pi](https://github.com/mariozechner/pi-coding-agent) that takes projects from idea to implementation with AI-assisted discovery, specification, planning, code review, and automated commits.

## Overview

The spec pipeline implements a four-stage, agent-driven development workflow:

1. **Discovery** — The `ux-discovery-interviewer` agent conducts a structured problem-space interview before any spec or code is written.
2. **Spec Writing** — The `spec-writer` agent translates the discovery output into a numbered, traceable technical specification.
3. **Delivery Planning** — The `delivery-plan-architect` agent reads the spec and produces a phased delivery plan that `/implement` uses to drive execution.
4. **Implementation** — `/implement` executes each phase: plan → code → review → commit.

### Key Features

- **Phased Delivery Plans** — The `delivery-plan-architect` agent produces a phase table (`Phase | Focus | Effort | Difficulty`) that `/implement` parses to sequence the work automatically.
- **Per-Phase Planning** — Each phase gets an AI-drafted implementation plan before coding begins (skip with `--no-plan`).
- **Code Review Loop** — Automated review and fix cycles after every phase (skip with `--no-review`).
- **Git Integration** — Automatic branching, commits, checkpoints, and error recovery.
- **Fully Configurable** — Customize models, thinking levels, review cycles, and context files per project.

## Quick Start

```bash
# 1. Run the discovery interview (optional but recommended)
subagent agent=ux-discovery-interviewer task="<initial feature context>"

# 2. Write the spec
subagent agent=spec-writer task="Read <discovery-path> and write the spec to <output-path>."

# 3. Create the delivery plan
subagent agent=delivery-plan-architect task="Read <spec-path> and write the delivery plan to <output-path>."

# 4. Implement
/implement <delivery-plan-path>
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

The `delivery-plan-architect` agent reads a technical specification and produces a structured delivery plan containing a phase table. `/implement` parses this table to sequence the phases:

```markdown
| Phase | Focus | Effort | Difficulty |
|-------|-------|--------|------------|
| Phase 1 | Backend API | 2 days | standard |
| Phase 2 | Auth migration | 1 day | hard |
```

Phases marked `hard` are automatically routed to the strongest configured model tier.

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
main
 └─ spec/2602101200-auth-system-impl-2602101215  [Implementation branch]
     ├─ Phase 1 commit: Database schema
     ├─ Phase 2 commit: Authentication service
     └─ Phase 3 commit: Integration tests
```

**Requires clean tree.** Implementation uses destructive git operations (`git add -A`,
`git reset --hard`) during error recovery, so a clean working tree is required at
`/implement` invocation.

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
- **review.ts** — Code review loop
- **git.ts** — Git operations and error recovery
- **config.ts** — Configuration loading and validation
- **state.ts** — State persistence and management
- **agents.ts** — Agent invocation and subprocess management
- **agents-config.ts** — Agent role and model configuration
- **types.ts** — TypeScript type definitions

## Related Documentation

- [DIRTY_TREE_SUPPORT.md](./DIRTY_TREE_SUPPORT.md) — Git clean-tree requirements
- [specs/implement_optimizations.md](./specs/implement_optimizations.md) — Plan generation experiments
