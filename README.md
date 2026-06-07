# Spec Pipeline Extension

A comprehensive workflow automation extension for [pi](https://github.com/mariozechner/pi-coding-agent) that takes projects from idea to implementation with AI-assisted specification, planning, review, and coding.

## Overview

The spec pipeline automates the complete software development lifecycle with a quality-first, conversational approach:

1. **Discovery** (optional) - Conversational requirements gathering where the AI explores your codebase and proposes assumptions for you to confirm
2. **Drafting** - Conversational spec/document writing where you guide the AI to create the specification
3. **Implementation** - Interleaved planning and coding with automated testing and git commits
4. **Commits** - Automatic git commits with AI-generated messages after each phase

### Key Features

- **Fully Conversational** - All discovery and drafting phases are natural conversations with the AI, not batch operations
- **Conversational Scoping** - `/plan` command lets AI assess scope and recommend roadmap/epic/feature level before starting
- **Hierarchical Planning** - Break down large initiatives: roadmaps → epics → features
- **Git Integration** - Automatic branching, commits, checkpoints, and error recovery
- **Dirty Tree Support** - Write specs while implementation runs (documentation pipelines only)
- **Fully Configurable** - Customize models, thinking levels, and context files per project

## Quick Start

### Basic Workflow

```bash
# 1. Create a spec (enters conversational mode)
/spec "Add user authentication system"
# AI explores codebase and proposes assumptions
# You confirm or correct naturally
# When ready, type /discovery-done
# Then guide the AI to draft the spec
# When satisfied, type /spec-draft-done and approve

# 2. Implement the spec
/implement specs/2602101200_auth_system_spec.md
# AI plans and implements each phase
# Automatic git commits after each phase

# 3. Check status anytime
/spec-status
/implement-status
```

### Skip Discovery

```bash
# Skip discovery for simple changes
/spec --quick "Fix null pointer in user service"
# Goes straight to drafting mode
```

### Discovery-to-Implementation (Fast Path)

```bash
# Skip formal spec creation - go straight from discovery to code
/implement "Add rate limiting middleware"
# AI explores codebase and proposes assumptions
# You confirm or correct naturally
# When ready, type /discovery-done
# AI writes discovery summary and starts implementation
```

### Hierarchical Planning

```bash
# Let AI assess scope and recommend level
/plan "Add machine warm pools to the platform"
# AI explores codebase, asks scoping questions
# Recommends: roadmap, epic, or feature
# Type /plan-done to proceed with recommendation

# Or directly specify the level
/plan --roadmap "Platform warm pools initiative"
/plan --epic "Billing system overhaul"
/plan --feature "Add auth middleware"

# Or use direct shortcuts
/roadmap "Platform warm pools initiative"
/epic "Billing system overhaul"

# View the full hierarchy
/plan-overview
```

## Commands

### Spec Creation

| Command | Description |
|---------|-------------|
| `/spec [--quick] <description>` | Start spec pipeline. Enters conversational discovery, then drafting |
| `/spec-resume` | Resume the last spec pipeline (continues from where it left off) |
| `/discovery-done` | End discovery and proceed to next phase (works for spec, hierarchy, and implement) |
| `/spec-draft-done` or `/draft-done` | Finalize the draft and proceed to approval |
| `/spec-status` | Show current spec pipeline status |
| `/spec-list` | List all specs with their status |
| `/spec-cancel` | Cancel the current spec pipeline |

**Note:** During discovery/drafting, you chat naturally with the AI. Use the done commands when ready to proceed.

### Implementation

| Command | Description |
|---------|-------------|
| `/implement [--no-plan] [--no-review] <spec-path\|description>` | Start implementation from file or discovery mode |
| `/implement-resume` | Resume the last active implementation |
| `/implement-status` | Show current implementation status |
| `/implement-list` | List all implementations with their status |
| `/implement-cancel` | Cancel the current implementation |
| `/implement-metrics [id]` | Export metrics JSON for analysis |

### Hierarchical Planning

| Command | Description |
|---------|-------------|
| `/plan [--quick] [--roadmap\|--epic\|--feature] <desc>` | Conversational scoping - AI recommends level |
| `/plan-done` | Accept the scoping recommendation and proceed |
| `/plan-cancel` | Cancel the scoping session |
| `/roadmap [--quick] <description>` | Create a roadmap (conversational discovery → drafting) |
| `/roadmap-resume` | Resume roadmap pipeline |
| `/roadmap-status [id]` | Show roadmap status and child progress |
| `/roadmap-list` | List all roadmaps |
| `/roadmap-cancel` | Cancel roadmap pipeline |
| `/epic [--quick] [--roadmap <id>] <desc>` | Create an epic (optionally link to parent roadmap) |
| `/epic-resume` | Resume epic pipeline |
| `/epic-status [id]` | Show epic status and child progress |
| `/epic-list` | List all epics |
| `/epic-cancel` | Cancel epic pipeline |
| `/plan-overview [id]` | Show full hierarchy tree (roadmaps → epics → features) |

**Note:** All hierarchy creation (roadmap/epic) is conversational, just like `/spec`.

## How It Works

### Conversational Discovery (Optional)

The AI explores your codebase and proposes assumptions one at a time for you to confirm:

- **One assumption at a time** - AI explores codebase, finds patterns, proposes most likely solution
- **Natural conversation** - You respond naturally to confirm or correct
- **Codebase exploration** - AI uses `read`, `bash`, `grep`, `find` to understand your project
- **User controlled** - Type `/discovery-done` when ready to proceed
- **Skippable** - Use `--quick` flag to go straight to drafting

**Example interaction:**
```
User: /spec "Add user authentication system"

AI: I'm exploring your codebase to understand the existing patterns...
    
    Looking at your project structure, I see you're using Express with TypeScript.
    I noticed you have a middleware/ directory.
    
    My assumption: We should create an auth middleware that validates JWT tokens
    and attaches user info to req.user. Does that match your vision?

User: Yes, JWT is right. But we need refresh tokens too.

AI: Got it - JWT access tokens with refresh tokens. Let me check your database
    setup... I see you're using PostgreSQL with TypeORM entities.
    
    Assumption: We should create a RefreshToken entity to store refresh tokens
    with user_id, token hash, and expiry. Sound good?

User: Perfect

AI: Excellent. One more thing - I see you have an existing users table with
    password_hash. Should the new auth system integrate with this existing
    user table, or create a separate auth table?

User: Use the existing users table

AI: Great! I have enough context now. Type /discovery-done to move to spec drafting.
```

### Conversational Drafting

You guide the AI to write the specification:

- **Full tool access** - AI can read files, explore code, edit and write
- **Conversational guidance** - Tell the AI what to focus on, what sections to add/remove
- **Template-based** - Uses project-specific templates (auto-detected from existing specs)
- **Iterative** - Refine the spec through conversation until satisfied
- **User controlled** - Type `/spec-draft-done` or `/draft-done` when ready for approval

**Example interaction:**
```
User: /discovery-done

AI: Great! I'll draft the spec now. Give me a moment to write it...
    
    [AI writes initial draft to specs/2602101200_auth_system_spec.md]
    
    I've created the initial spec with these sections:
    - Problem Statement
    - Requirements (JWT + refresh tokens)
    - Implementation Approach (middleware + entities)
    - Security Considerations
    - Testing Strategy
    
    What would you like me to adjust?

User: Add a section on token rotation strategy

AI: Good call. I'll add that now...
    
    [AI edits the spec file]
    
    Added a "Token Rotation" section describing how refresh tokens will be
    rotated on each use. Anything else?

User: Looks good, we're done

AI: Perfect! Type /spec-draft-done to proceed to approval.
```

After `/spec-draft-done`, you'll be asked to approve or request revisions.

### Discovery-to-Implementation (Fast Path)

For small-to-medium changes where a full formal spec is overkill, use `/implement` with a description instead of a file path:

```bash
/implement "Add rate limiting to the API"
```

This enters the same conversational discovery mode as `/spec`, but proceeds directly to implementation instead of spec drafting:

1. **Discovery conversation** - AI explores codebase, proposes assumptions
2. **Type `/discovery-done`** - When ready to proceed
3. **Summary written** - AI writes discovery summary to `specsDir/{timestamp}_discovery_{shortname}.md`
4. **Implementation starts** - AI plans and implements phases (same as normal `/implement`)

**Example interaction:**
```
User: /implement "Add rate limiting to the API"

AI: I'm exploring your API routes... I see you're using Express with middleware
    in src/middleware/. 
    
    Assumption: We should create a rate-limit middleware using the 'express-rate-limit'
    package and apply it globally to all routes. Does that match your vision?

User: Yes, but only apply it to public routes, not admin routes

AI: Got it - public routes only. I see your route definitions in src/routes/...
    Should the rate limit be 100 requests per 15 minutes per IP?

User: Make it 50 per 10 minutes

AI: Perfect. I have enough context. Type /discovery-done to proceed to implementation.

User: /discovery-done

[AI writes summary to docs/2602111400_discovery_rate_limiting_api.md]
[Implementation pipeline starts - planning and coding phases]
```

**Flags work the same:**
```bash
/implement --no-plan "Fix null pointer in auth service"
/implement --no-review "Add logging to user endpoints"
/implement --no-plan --no-review "Quick bug fix"
```

**When to use:**
- Small bug fixes that need codebase exploration
- Medium features where formal spec is overkill
- When you want to iterate quickly with AI before committing to a spec

**When NOT to use:**
- Large features (use `/spec` or `/plan` → `/epic` → `/spec`)
- When you need stakeholder review of requirements
- When the spec will be referenced by multiple implementations

### Implementation Stage

The AI implements the spec (or discovery summary) with interleaved planning, coding, and review:

**For each phase:**
1. **Plan Drafting** - AI drafts implementation plan
2. **Implementation** - AI writes code
3. **Code Review** - Single configured reviewer model checks the implementation
4. **Testing** - Runs test command (auto-detected: npm test, cargo test, etc.)
5. **Commit** - Automatic git commit with AI-generated message

**Code Review:**
- `codeReviewer` reviews for up to `reviewCycles` cycles
- If NEEDS_CHANGES, `addressReview` agent applies fixes automatically
- Set `reviewCycles` to `0` to skip code review

**Error Recovery:**
- Automatic git checkpoints before each agent operation
- Stashing on failures
- Resume with `/implement-resume` to continue from checkpoint

**Optional planning skip:**
- Use `/implement --no-plan` to skip plan generation
- Or set `skipPlanGeneration: true` in config
- Useful for simple implementations where planning overhead isn't needed

**Note:** Unlike spec/roadmap/epic creation, implementation is NOT conversational - it runs autonomously once started.

### Git Workflow

```
main
 ├─ spec/2602101200-auth-system     [Spec branch]
 │   └─ specs/2602101200_auth_system_spec.md
 │
 └─ spec/2602101200-auth-system-impl-2602101215  [Implementation branch]
     ├─ Phase 1 commit: Database schema
     ├─ Phase 2 commit: Authentication service
     └─ Phase 3 commit: Integration tests
```

**Discovery-to-implementation branches:**
```
main
 └─ spec/2602111400-rate-limiting-impl-2602111405  [Implementation branch]
     ├─ docs/2602111400_discovery_rate_limiting.md  [Discovery summary]
     ├─ Phase 1 commit: Rate limiting middleware
     └─ Phase 2 commit: Integration tests
```

Discovery summaries are committed on the implementation branch, not a separate spec branch.

### Choosing Your Workflow

| Workflow | Use When | Result |
|----------|----------|--------|
| `/spec` → `/implement` | Large features, need formal spec, stakeholder review | Full spec document → implementation |
| `/spec --quick` → `/implement` | Medium features, skip discovery, want spec doc | Spec document (no discovery) → implementation |
| `/implement <description>` | Small-medium changes, need discovery, no spec doc needed | Discovery summary → direct implementation |
| `/implement --no-plan <description>` | Simple changes, need discovery, skip planning | Discovery summary → direct coding |
| `/implement <file>` | Spec already exists | Implement existing spec |

**Tip:** The discovery experience is identical across `/spec` and `/implement` - the only difference is what happens after `/discovery-done`.

## Configuration

### Location

Create `.pi/spec-pipeline.json` in your project root:

```json
{
  "specsDir": "docs/specs",
  "testCommand": "npm test",
  "contextFiles": ["CONTRIBUTING.md", "docs/architecture.md"],
  "models": {
    "implementer": { "model": "gpt-5.5", "thinking": "high" }
  },
  "reviewCycles": 3
}
```

### Configuration Options

#### Basic Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `specsDir` | string | `"docs"` | Directory for spec files |
| `testCommand` | string | auto-detected | Command to run tests (npm test, cargo test, etc.) |
| `contextFiles` | string[] | `[]` | Additional files to include as context (docs, architecture, etc.) |
| `specTemplatePath` | string | auto-detected | Path to spec template file |
| `specConventionsPath` | string | auto-detected | Path to spec conventions file |
| `specFormat` | string | `"md"` | Output format for specs (md, typ, etc.) |

#### Discovery Behavior

Discovery is controlled only by the `--quick` flag on commands:
- `/spec "description"` - Runs discovery conversation before drafting
- `/spec --quick "description"` - Skips discovery, goes straight to drafting
- Same applies to `/roadmap` and `/epic` commands

Discovery is fully conversational and continues until you type `/discovery-done`. There are no configuration settings for discovery behavior.

#### Experimental Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `skipPlanGeneration` | boolean | `false` | Skip plan generation in `/implement` (go straight to coding) |

### Model Configuration

Configure models per-role to optimize cost and quality:

```json
{
  "models": {
    "planDrafter": { "model": "claude-native/opus", "thinking": "low" },
    "implementer": { "model": "claude-native/opus", "thinking": "low" },
    "codeReviewer": { "model": "claude-native/opus", "thinking": "low" },
    "addressReview": { "model": "openai-codex/gpt-5.5", "thinking": "low" },
    "agentCommitMessageWriter": { "model": "claude-native/opus", "thinking": "low" }
  },
  "reviewCycles": 5
}
```

#### Available Roles

**Implementation Roles (used in `/implement`):**

| Role | Default Model | Default Thinking | Purpose |
|------|---------------|------------------|---------|
| `planDrafter` | gpt-5.5 | high | Draft implementation plan for each phase |
| `implementer` | gpt-5.5 | high | Write code for each phase |
| `addressReview` | gpt-5.4 | medium | Apply fixes based on review feedback |
| `agentCommitMessageWriter` | gpt-5.4-mini | off | Generate commit messages |

**Review Roles (used in `/implement`):**

| Role | Default Model | Default Thinking | Purpose |
|------|---------------|------------------|---------|
| `codeReviewer` | gpt-5.4 | medium | Review code changes |

#### Model Options

**Available models:**

The `model` field accepts any model identifier supported by the pi CLI. Use the same model names you would pass to `pi --model`. For example:
- `gpt-5.5` - most capable, most expensive
- `gpt-5.4` - balanced capability/cost
- `gpt-5.4-mini` - fast, cheap

Any model supported by pi can be used (e.g., `gpt-5.1-codex`, `gemini-2.5-pro`, etc.).

**Thinking levels:**
- `high` - Extended reasoning (best quality)
- `medium` - Balanced reasoning
- `low` - Minimal reasoning
- `minimal` - Very little reasoning
- `off` - No reasoning (fastest)

### Review Cycles Configuration

Control code review cycles during `/implement`:

```json
{
  "reviewCycles": 2
}
```

**How review works:**

1. `codeReviewer` reviews the implementation and returns APPROVED or NEEDS_CHANGES.
2. If NEEDS_CHANGES, `addressReview` applies fixes.
3. The loop repeats until APPROVED or `reviewCycles` is reached.
4. Setting `reviewCycles` to `0` skips code review entirely.

**Setting cycles to 0:**
```json
{
  "reviewCycles": 0
}
```

**Note:** Review cycles only apply to `/implement`. Specs/roadmaps/epics don't use automated review - you approve them conversationally.

## Dirty Tree Support

Documentation pipelines (specs, roadmaps, epics) can run with uncommitted changes, enabling **parallel workflows**:

### ✅ Allows Dirty Tree

- `/spec` and `/spec-resume` - Create specifications
- `/roadmap` and `/roadmap-resume` - Create roadmaps  
- `/epic` and `/epic-resume` - Create epics

These pipelines use **scoped commits** - they only stage and commit their specific document file, ignoring other changes.

**Example:**
```bash
# Terminal 1: Implementation in progress (dirty tree)
$ /implement specs/auth-spec.md
🚀 Phase 1 implementing...
# src/auth.ts and src/user.ts have uncommitted changes

# Terminal 2: Write a new spec (works fine!)
$ /spec "Add password reset feature"
📝 Drafting spec...
✅ Spec committed to specs/2602101300_password_reset_spec.md
# Only the spec file is committed, implementation changes untouched
```

### ⚠️ Requires Clean Tree

- `/implement` with a **file path** - checked at invocation
- `/implement` with a **description** - checked at `/discovery-done` (deferred)
- `/implement-resume` - checked at resume time

Implementation requires a clean tree because it uses destructive git operations (`git add -A`, `git reset --hard`) during error recovery.

**Note:** When using `/implement <description>`, the git clean check happens at `/discovery-done` time (not at `/implement` invocation). This allows you to chat naturally during discovery, then commit/stash changes before proceeding.

**Why?** To prevent accidental data loss during error recovery.

See [DIRTY_TREE_SUPPORT.md](./DIRTY_TREE_SUPPORT.md) for full details.

## Hierarchical Planning

For large initiatives spanning multiple features, use the hierarchy system:

### Levels

1. **Roadmap** - High-level initiative decomposed into epics (weeks to months)
2. **Epic** - Medium-level effort decomposed into features (days to weeks)
3. **Feature** - Single specification with implementation phases (hours to days)

### Workflow

```bash
# 1. Start with /plan - AI assesses scope
$ /plan "Add machine warm pools to the platform"

AI: This initiative touches multiple subsystems and will require
    several independent deliverables. I recommend creating a ROADMAP
    that decomposes into epics for:
    - Pool configuration and management
    - Provisioning engine
    - Billing integration
    - Monitoring and alerting
    
User confirms → Enters roadmap pipeline (discovery → draft → review → approval)

# 2. After roadmap approval, create children one by one
AI: The roadmap is approved. Here are the child epics:
    1. Pool configuration [High priority]
    2. Provisioning engine [High priority, depends on #1]
    3. Billing integration [Medium priority, depends on #1]
    
Which would you like to start? (or type /skip to start later)

$ 1

AI: Starting epic for "Pool configuration"...
# Enters epic pipeline (discovery → draft → review → approval)

# 3. After epic approval, create feature specs
AI: The epic is approved. Here are the child features:
    1. API endpoints for pool CRUD [High priority]
    2. UI for pool management [High priority, depends on #1]
    3. Pool monitoring dashboard [Medium priority, depends on #1]

Which would you like to spec? 

$ 1

AI: Starting feature spec for "API endpoints for pool CRUD"...
# Enters spec pipeline (discovery → draft → review → approval)

# 4. Implement the spec
$ /implement specs/2602101400_pool_crud_api_spec.md
```

### Status Tracking

```bash
# View full hierarchy
$ /plan-overview

📋 Active Planning Hierarchies

🗺️ ROADMAP: Platform warm pools initiative
   Status: In Progress (1/3 epics completed)
   
   📦 Epic 1: Pool configuration [COMPLETED]
      ✅ Feature 1.1: API endpoints [IMPLEMENTED]
      ✅ Feature 1.2: UI components [IMPLEMENTED]
      
   📦 Epic 2: Provisioning engine [IN PROGRESS]
      ✅ Feature 2.1: Background worker [IMPLEMENTED]
      🔄 Feature 2.2: Retry logic [IN PROGRESS]
      ⏳ Feature 2.3: Health checks [PENDING]
      
   📦 Epic 3: Billing integration [PENDING - blocked by Epic 2]
```

### Child Items Table

Roadmaps and epics contain a child items table in their documents:

```markdown
## Child Epics

| # | Epic | Description | Priority | Dependencies |
|---|------|-------------|----------|--------------|
| 1 | Pool configuration | API and UI for managing warm pools | High | - |
| 2 | Provisioning engine | Background provisioning with retries | High | 1 |
| 3 | Billing integration | Track warm machine usage hours | Medium | 1 |
```

The pipeline automatically extracts this table after approval and prompts you to create each child.

## Templates and Conventions

The pipeline auto-detects spec templates and conventions from your project:

### Auto-Detection

1. Looks for existing specs in `specsDir` to detect format and style
2. Searches for template files: `spec-template.md`, `SPEC_TEMPLATE.md`, etc.
3. Searches for conventions: `spec-conventions.md`, `SPEC_CONVENTIONS.md`, etc.

### Custom Templates

Override auto-detection in config:

```json
{
  "specTemplatePath": "docs/templates/feature-spec.md",
  "specConventionsPath": "docs/templates/spec-guidelines.md",
  "specFormat": "md"
}
```

Set to `null` to disable template/conventions:

```json
{
  "specTemplatePath": null,
  "specConventionsPath": null
}
```

### Template Variables

Templates can use these variables (automatically replaced):

- `{{FEATURE_NAME}}` - Name of the feature
- `{{DATE}}` - Current date
- `{{AUTHOR}}` - Git user name
- `{{TIMESTAMP}}` - YYMMDDhhmm format

## Error Handling

The pipeline has robust error handling with automatic recovery:

### Error Types

- **Rate Limits** - Automatic retry with exponential backoff
- **Timeouts** - Stash changes, allow user intervention
- **Validation Errors** - Clear error messages with suggestions
- **Network Issues** - Retry with fallback options

### Recovery Flow

1. **Error detected** - Pipeline pauses, shows error details
2. **Changes stashed** - Uncommitted work saved to git stash
3. **State persisted** - Pipeline state saved to `.pi/spec-pipeline/`
4. **User intervention** - Fix issues, adjust context, update config
5. **Resume** - Run `/spec-resume` or `/implement-resume`
6. **Recovery** - Pipeline restores stashed changes and continues

### Error State

Errors are tracked in state with full context:

```json
{
  "lastError": {
    "timestamp": "2026-02-10T10:30:00Z",
    "agent": "gpt-5.5",
    "role": "implementer",
    "phase": 2,
    "exitCode": 1,
    "errorType": "VALIDATION",
    "stderr": "Syntax error in auth.ts:42...",
    "agentTask": "Implement authentication service..."
  }
}
```

## Metrics and Analysis

The pipeline tracks detailed metrics for optimization:

### Spec Metrics

```json
{
  "metrics": {
    "pipelineStartTime": "2026-02-10T10:00:00Z",
    "pipelineEndTime": "2026-02-10T10:45:00Z",
    "totalDurationMs": 2700000,
    "discoveryDurationMs": 900000,
    "specDraftingDurationMs": 1800000,
    "discoverySkipped": false,
    "specIterations": 2,
    "specReviewCycles": 0,
    "agentCalls": [
      {
        "role": "planDrafter",
        "model": "gpt-5.5",
        "thinking": "high",
        "startTime": "2026-02-10T10:00:00Z",
        "endTime": "2026-02-10T10:15:00Z",
        "durationMs": 900000,
        "exitCode": 0
      }
      // ... more calls
    ]
  }
}
```

### Implementation Metrics

```json
{
  "metrics": {
    "totalDurationMs": 3600000,
    "planGenerationDurationMs": 600000,
    "implementationDurationMs": 3000000,
    "skipPlanGeneration": false,
    "codeReviewFirstPassRate": 0.67,
    "codeReviewCycles": 3,
    "agentCalls": [ /* ... */ ]
  }
}
```

Use metrics to:
- Optimize review cycle counts
- Identify bottlenecks
- Compare model configurations
- A/B test `skipPlanGeneration` effectiveness

## State Management

Pipeline state is stored in `.pi/spec-pipeline/`:

```
.pi/spec-pipeline/
├── specs/
│   └── <spec-id>/
│       └── state.json
├── implementations/
│   └── <impl-id>/
│       └── state.json
├── roadmaps/
│   └── <roadmap-id>/
│       └── state.json
└── epics/
    └── <epic-id>/
        └── state.json
```

**Note:** This directory is gitignored - state files are local to your machine.

### State Persistence

- **Automatic saving** - After every significant operation
- **Crash recovery** - Resume from last saved state
- **Parallel pipelines** - Each pipeline has independent state
- **No conflicts** - State files never committed to git

## Testing

The extension includes comprehensive test coverage:

```bash
# Run all tests
npm test extensions/spec-pipeline/

# Run specific test suites
npm test extensions/spec-pipeline/config.test.ts
npm test extensions/spec-pipeline/review.test.ts
npm test extensions/spec-pipeline/git.test.ts

# Run with coverage
npm test -- --coverage extensions/spec-pipeline/
```

**Test coverage:**
- Configuration validation and defaults
- Code review loop logic
- Git operations and scoped commits
- Error handling and recovery
- State management
- Metrics tracking

## Architecture

### Key Files

- **index.ts** - Extension entry point, command registration
- **spec-pipeline.ts** - Main pipeline orchestration
- **implement-pipeline.ts** - Implementation phase execution
- **hierarchy-pipeline.ts** - Roadmap/epic workflow
- **review.ts** - Code review loop
- **git.ts** - Git operations and error recovery
- **config.ts** - Configuration loading and validation
- **state.ts** - State persistence and management
- **agents.ts** - Agent invocation and prompt management
- **agents-config.ts** - Agent role and model configuration
- **types.ts** - TypeScript type definitions

### Extension API

The extension uses pi's Extension API:

```typescript
export default function (api: ExtensionAPI) {
  api.addCommand({
    name: "spec",
    description: "Create a technical specification",
    execute: async (args, context) => {
      // Command implementation
    }
  });
}
```

## Best Practices

### 1. Discovery First

Don't skip discovery for complex features - conversational exploration saves rework:

```bash
# Good: Let AI explore and propose assumptions
/spec "Add real-time notifications"
# AI explores codebase, proposes solutions, you confirm

# Skip only for tiny changes
/spec --quick "Fix typo in error message"
```

### 2. Context Files

Add relevant documentation as context so the AI can understand conventions:

```json
{
  "contextFiles": [
    "CONTRIBUTING.md",
    "docs/architecture.md",
    "docs/api-conventions.md",
    "docs/testing-strategy.md"
  ]
}
```

### 3. Conversational Guidance

During discovery and drafting, guide the AI naturally:

```bash
# During discovery
"Yes, use JWT. But we also need refresh tokens with rotation."
"Actually, integrate with the existing users table, don't create a new one."

# During drafting  
"Add a section on error handling"
"The security section needs more detail on token storage"
"Remove the caching section, we're not doing that yet"
```

### 4. Use `/plan` for Scoping

When unsure about scope, let the AI help:

```bash
/plan "Redesign the billing system"
# AI explores codebase
# Asks: "How many subsystems will this touch?"
# Asks: "Is this a rewrite or incremental changes?"
# Recommends: roadmap (multi-epic) vs epic (multi-feature) vs feature (single spec)
# You type /plan-done to proceed
```

### 5. Hierarchical Planning

Break down large work using the hierarchy:

- **Roadmap** - Large initiative → decomposes into epics
- **Epic** - Medium effort → decomposes into features (specs)
- **Feature** - Single spec → implemented via `/implement`

Create parent, approve it, then create children one-by-one.

### 6. Parallel Workflows

Take advantage of dirty tree support:

```bash
# Terminal 1: Implementation running
/implement specs/auth-spec.md

# Terminal 2: Write a new spec (works!)
/spec "Add password reset"
# Only the spec file is committed, implementation untouched
```

### 7. Clean Trees for Implementation

Always start `/implement` with a clean tree:

```bash
# Commit or stash first
git stash
/implement specs/my-spec.md

# Or commit
git add .
git commit -m "WIP: Preparing for implementation"
/implement specs/my-spec.md
```

## Troubleshooting

### "Dirty tree not allowed for implementation"

**Problem:** Trying to proceed with implementation when you have uncommitted changes.

**When it happens:**
- Running `/implement <file-path>` with dirty tree (checked immediately)
- Running `/discovery-done` during implement-discovery with dirty tree (deferred check)

**Solution:** Commit or stash changes before proceeding:
```bash
# If you see the error during /discovery-done:
# Your discovery session remains active - just clean up and retry
git stash
/discovery-done  # Discovery session continues from where it was

# OR if you see it at /implement invocation with a file:
git stash
/implement specs/my-spec.md
```

### Pipeline stuck in conversational mode

**Problem:** You're in discovery or drafting mode and want to exit.

**Solution:** 
- During discovery: type `/discovery-done`
- During drafting: type `/spec-draft-done` or `/draft-done`
- Or cancel: `/spec-cancel`, `/roadmap-cancel`, `/epic-cancel`

### How do I edit the spec after drafting?

**Problem:** You approved a spec but want to change it.

**Solution:**
1. Manually edit the spec file with your text editor
2. Then run `/implement` with the edited spec
3. Or start a new spec: `/spec "revised version of..."`

### Tests failing during implementation

**Problem:** Pipeline fails because tests don't pass.

**Solution:**
1. Fix test failures manually
2. Run `/implement-resume` to continue
3. Or update `testCommand` if tests need different invocation

### Template not detected

**Problem:** AI not using your project's spec format during drafting.

**Solution:** 
1. Add explicit paths in config:
```json
{
  "specTemplatePath": "docs/templates/spec.md",
  "specConventionsPath": "docs/templates/conventions.md"
}
```
2. During drafting, tell the AI: "Use the template in docs/templates/spec.md"

### AI isn't following my guidance during drafting

**Problem:** The AI ignores your conversational instructions.

**Solution:**
- Be specific: "Add a Security section after Implementation" instead of "add security"
- Check the spec file yourself: use `read` or open in your editor
- If the AI makes mistakes, tell it explicitly: "You forgot to add X, please add it now"

## Contributing

See the main repository's [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

### Development Setup

```bash
# Install dependencies
npm install

# Run tests
npm test extensions/spec-pipeline/

# Run type checking
npm run type-check

# Run linter
npm run lint
```

### Adding Features

1. Update types in `types.ts`
2. Add tests in `*.test.ts` files
3. Implement feature
4. Update this README
5. Add example config to documentation

## License

MIT - See [LICENSE](../../LICENSE) for details.

## Related Documentation

- [DIRTY_TREE_SUPPORT.md](./DIRTY_TREE_SUPPORT.md) - Parallel workflow details
- [specs/hierarchical_specs.md](./specs/hierarchical_specs.md) - Hierarchy system design
- [specs/implement_optimizations.md](./specs/implement_optimizations.md) - Plan generation experiments
- Main [README.md](../../README.md) - Overview of all extensions and skills
