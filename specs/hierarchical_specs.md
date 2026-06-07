# Hierarchical Specs: Roadmaps → Epics → Features

**Status**: Draft  
**Created**: 2026-02-07  
**Updated**: 2026-02-07

---

## PART I: WHAT & WHY (Requirements)

---

### Problem Statement

#### Business Context

The spec-pipeline currently operates at a single level: one feature description produces one spec, which gets implemented via phases. This works well for individual features, but breaks down when planning larger initiatives that span multiple features.

When building a significant product capability — say "warm machine pools" for a cloud platform — the work naturally decomposes into multiple independent features: pool configuration, provisioning logic, billing, monitoring, UI. Today, users must manually plan this decomposition outside the pipeline, then run `/spec` + `/implement` for each feature separately, with no tracking of the broader initiative.

#### Current State

- `/spec` creates a single feature-level specification
- `/implement` implements a single specification via phases
- No concept of parent-child relationships between specs
- No way to express that multiple features belong to one initiative
- No progress tracking across related features
- Users manually decompose large initiatives before entering the pipeline

#### Key Issues

1. **No structured decomposition**: Large initiatives require ad-hoc planning outside the tool, losing the benefits of discovery, drafting, and review
2. **No relationship tracking**: Related features have no formal connection — it's impossible to see the status of an initiative as a whole
3. **No dependency management**: Features often depend on each other, but there's no way to express or enforce ordering
4. **Lost context**: When decomposing manually, context from the high-level vision doesn't flow down to individual feature specs

---

### Requirements

#### New Document Types

- **R1: Roadmap Document Type**  
  Introduce a "roadmap" document type that describes a high-level initiative and decomposes it into epics. A roadmap follows the same quality lifecycle as a spec (discovery → drafting → review → approval) but produces a decomposition into epics rather than an implementation plan with phases.

- **R2: Epic Document Type**  
  Introduce an "epic" document type that describes a medium-level initiative and decomposes it into features. An epic follows the same quality lifecycle as a spec (discovery → drafting → review → approval) but produces a decomposition into features rather than an implementation plan with phases.

- **R3: Child Items Table**  
  Roadmaps and epics contain a child items table instead of a phase table. The table lists each child with: number, name, description, priority, and dependencies. Example:
  ```
  | # | Item | Description | Priority | Dependencies |
  |---|------|-------------|----------|--------------|
  | 1 | Pool configuration | API and UI for warm pool settings | High | - |
  | 2 | Provisioning engine | Background provisioning with retries | High | 1 |
  | 3 | Billing integration | Track warm machine hours | Medium | 1 |
  ```

- **R4: Existing Commands Unchanged**  
  The existing `/spec` and `/implement` commands continue to work exactly as they do today for standalone feature specs. This is purely additive.

#### Commands

- **R5: `/plan` — Unified Entry Point**  
  New command `/plan <description>` that acts as the single entry point for all hierarchy levels. Before starting any lifecycle, the agent performs a quick scope assessment:
  1. Reads the description and explores the codebase
  2. Asks the user a few scoping questions (e.g., how many distinct areas does this touch? Is this weeks or months of work? Does it decompose into independent deliverables?)
  3. Proposes a level: **roadmap** (multi-epic initiative), **epic** (multi-feature effort), or **feature** (single spec)
  4. The user confirms or overrides the recommendation
  
  Once the level is determined, the pipeline proceeds with the appropriate lifecycle. Supports `--quick` flag to skip discovery. Supports `--roadmap`, `--epic`, or `--feature` flags to skip the scoping assessment and go directly to that level.

- **R5a: `/roadmap` Command**  
  Direct command `/roadmap <description>` that skips the scoping assessment and creates a roadmap. Equivalent to `/plan --roadmap <description>`.

- **R6: `/epic` Command**  
  Direct command `/epic <description>` that skips the scoping assessment and creates an epic. Supports `--quick` flag. Optionally accepts `--roadmap <roadmap-id>` to link it as a child of an existing roadmap. Equivalent to `/plan --epic <description>`.

- **R7: Child Item Creation**  
  After a roadmap or epic is approved, the pipeline extracts the child items table and presents the list to the user. The user starts each child **one at a time** — they pick which child to create next, and that child enters its own pipeline lifecycle (epic for roadmaps, feature spec for epics). The agent may suggest starting the next child after one completes, but must not start it automatically.

- **R8: Status Commands**  
  `/roadmap-status [id]` and `/epic-status [id]` display hierarchical progress — the parent document status plus the status of all child items (how many completed, in progress, pending, etc.).

- **R9: List Commands**  
  `/roadmap-list` and `/epic-list` list all roadmaps and epics respectively, with summary information.

- **R10: Plan Overview Command**  
  `/plan-overview [id]` displays the full hierarchy tree from any level. Given a roadmap ID, it shows the roadmap → all epics → all features. Given an epic ID, it navigates up to the parent roadmap (if any) and shows the full tree. Given no ID, it shows all active hierarchies. This provides a birds-eye view of all planned and in-progress work.

- **R11: Cancel and Resume**  
  `/roadmap-cancel`, `/roadmap-resume`, `/epic-cancel`, `/epic-resume` follow the same patterns as existing `/spec-cancel` and `/spec-resume`.

#### State & Hierarchy

- **R12: Hierarchy State**  
  New state types for roadmaps and epics that track:
  - The parent document lifecycle (same fields as SpecState for discovery/drafting/review)
  - A list of child item references with: name, description, priority, dependencies, and a reference to the child pipeline ID once created
  - Overall progress summary

- **R13: Parent-Child Links**  
  Child specs/epics carry a reference back to their parent (parentId, parentType). This enables navigation up and down the hierarchy.

- **R14: State Storage**  
  Roadmap state stored in `.pi/spec-pipeline/roadmaps/<id>.json`. Epic state stored in `.pi/spec-pipeline/epics/<id>.json`. Feature specs remain in `.pi/spec-pipeline/specs/<id>.json`.

- **R15: Dependency Tracking**  
  Dependencies between child items are tracked by item number within the parent. The status display shows which items are blocked (dependencies not yet completed) vs. ready to start.

#### Agent Roles & Prompts

- **R16: Scoping Agent Prompt**  
  A new system prompt for the scoping assessment in `/plan`. The agent evaluates the description against the codebase and asks 2-3 targeted questions to determine scope. It then recommends a level with a brief justification. The prompt guides the agent to consider:
  - How many distinct functional areas does this touch?
  - Can this be delivered as a single coherent change, or does it need independent deliverables?
  - Estimated total effort (days vs. weeks vs. months)
  - Does it require coordination across multiple teams or subsystems?

- **R17: Decomposition-Focused Prompts**  
  New system prompts for roadmap and epic drafting/reviewing that focus on decomposition quality:
  - Are the child items well-scoped and independent?
  - Are dependencies correctly identified?
  - Is the priority ordering sensible?
  - Does each child have enough context to be specced independently?

- **R18: Context Propagation**  
  When creating a child spec/epic from a parent, the parent's document content and discovery context are passed down as additional context to the child's discovery and drafting phases.

- **R19: Agent Config**  
  New optional model configuration entries in `.pi/spec-pipeline.json` for `roadmapDrafter`, `roadmapReviewer`, `epicDrafter`, `epicReviewer`. These default to the same configs as `specDrafter` and `specReviewer` when not specified.

#### Git Integration

- **R20: Branch Per Document**  
  Each roadmap, epic, and feature spec gets its own git branch following the existing pattern:
  - Roadmaps: `roadmap/<timestamp>-<short-name>`
  - Epics: `epic/<timestamp>-<short-name>`
  - Features: `spec/<timestamp>-<short-name>` (unchanged)

---

### Success Criteria

- [ ] `/plan <description>` performs scoping assessment and recommends the right level (roadmap/epic/feature)
- [ ] User can confirm or override the recommended level
- [ ] `/plan --roadmap`, `/plan --epic`, `/plan --feature` skip scoping and go directly to that level
- [ ] `/roadmap` and `/epic` work as direct shortcuts
- [ ] `/roadmap <description>` creates a roadmap through discovery → drafting → review → approval
- [ ] Approved roadmaps present child items; user creates them one at a time as epics
- [ ] `/epic <description>` creates an epic through discovery → drafting → review → approval
- [ ] Approved epics present child items; user creates them one at a time as feature specs
- [ ] Created child specs work with existing `/implement` command unchanged
- [ ] `/roadmap-status` shows hierarchical progress across epics and their features
- [ ] `/epic-status` shows progress across child features
- [ ] `/plan-overview` shows the full hierarchy tree from any level
- [ ] Parent context (discovery findings, document content) propagates to children
- [ ] Dependencies between children are visible in status displays
- [ ] Existing `/spec` and `/implement` commands work unchanged
- [ ] Config supports new agent roles with fallback defaults
- [ ] All existing tests continue to pass

---

### Out of Scope

- **Automatic implementation orchestration**: The system does not automatically run `/implement` on child features. Users decide when to implement each feature.
- **Cross-project roadmaps**: Roadmaps are scoped to a single project (one `.pi/spec-pipeline.json`).
- **Real-time dependency enforcement**: The system shows dependency status but does not block users from starting work on dependent items.
- **Roadmap/epic templates**: No custom templates for roadmap or epic documents in v1. May be added later following the existing spec template pattern.
- **Migration of existing specs**: No automatic conversion of existing standalone specs into hierarchy members.
- **Visual dependency graphs**: Status displays are text-based, not graphical.

---

### Open Questions

1. ~~Should we use new commands or flags on `/spec`?~~ → **Resolved**: New commands (`/roadmap`, `/epic`) for clarity
2. ~~Where should hierarchy state be stored?~~ → **Resolved**: Separate directories per type
3. ~~Should there be a command that shows the full hierarchy tree?~~ → **Resolved**: Yes, `/plan-overview` command. (`/tree` is already taken by pi's session branching feature.)
4. ~~Should child items be creatable in bulk or one at a time?~~ → **Resolved**: One at a time. User starts each child individually.
5. ~~Should the system automatically start the next child after approval?~~ → **Resolved**: No automatic start. The agent may suggest starting the next step, but the user must explicitly initiate it.

---

## PART II: HOW & WHEN (Implementation Plan)

---

### Estimated Effort

14-18 days across 6 phases

### Phase Table

| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | State model, types, and hierarchy tracking | 2 days |
| Phase 2 | `/plan` unified entry point — scoping assessment, level recommendation, routing | 2-3 days |
| Phase 3 | Roadmap pipeline — commands, prompts, child extraction, child creation | 3-4 days |
| Phase 4 | Epic pipeline — commands, prompts, child extraction, feature spec creation | 3-4 days |
| Phase 5 | Progress tracking, status commands, and `/plan-overview` | 2-3 days |
| Phase 6 | Config, agent role additions, and integration testing | 2 days |

### Phase Dependencies

Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6

Phase 1 establishes the state model that all other phases depend on. Phase 2 builds the unified entry point that routes to the appropriate lifecycle. Phases 3 and 4 could potentially be parallelized since roadmaps and epics follow the same patterns, but sequential development allows Phase 4 to reuse patterns established in Phase 3. Phase 5 requires children to exist for status display. Phase 6 ties everything together.

### Design Decisions

**Decision 1: Reuse the spec lifecycle machinery**

The roadmap and epic lifecycles (discovery → drafting → review → approval) are structurally identical to the spec lifecycle. Rather than creating entirely new pipelines, we extend the existing conversational mode infrastructure with new system prompt injections and a post-approval decomposition step.

*Alternative considered*: Completely separate pipeline files for roadmaps and epics. Rejected because it would duplicate the core lifecycle logic (event handlers, mode management, review, git operations).

**Decision 2: Child items extracted from document, not separate data**

Child items are defined within the roadmap/epic document as a table, then extracted programmatically after approval (similar to how phases are extracted from specs). This keeps the document as the single source of truth.

*Alternative considered*: Separate data entry for children via UI prompts. Rejected because it loses the benefits of agent-assisted drafting and review of the decomposition.

**Decision 3: Flat child references, not nested state**

The parent state holds references (IDs) to child pipelines, not embedded child state. Each child is a fully independent pipeline with its own state file. The parent just tracks which children exist and can query their status.

*Rationale*: Keeps state management simple. Children can be resumed, cancelled, and managed independently. Avoids deeply nested state objects.

---

## Dependencies

### Internal Dependencies

- Existing spec pipeline conversational mode infrastructure (event handlers, mode management)
- Existing state management (save/load patterns)
- Existing git branch management
- Existing tiered review system
- Existing agent execution infrastructure

### External Dependencies

None. All required infrastructure is already in place.

---

## Future Enhancements

- **Visual hierarchy view**: A tree visualization command showing the full hierarchy
- **Dependency graph**: Graphical dependency visualization
- **Roadmap/epic templates**: Custom templates for different project types
- **Auto-implement orchestration**: Automatically queue `/implement` for features in dependency order
- **Cross-project roadmaps**: Span multiple projects
- **Progress metrics export**: Export hierarchy completion metrics for project tracking
- **Plane.so integration**: Sync roadmap/epic/feature hierarchy with Plane modules and work items
