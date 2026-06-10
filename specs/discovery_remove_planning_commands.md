# Discovery: Remove the Planning Command Pipeline

> Discovery input for spec-writer. Captures problem, current state, goals,
> scope, and open questions for removing the upstream planning commands from
> the `pi-spec-pipeline` extension, leaving `/implement` as the survivor.

## Problem Statement

The `pi-spec-pipeline` extension currently bundles a large, conversational
"planning pipeline" (idea → scope → spec/epic/roadmap → implement). The owner
wants to **remove the entire upstream planning surface** and reduce the
extension to a single execution command, `/implement`, which will now consume
a **delivery-plan document produced by the `delivery-plan-architect` agent**
(`agents/delivery-plan-architect.md`) instead of an internally-generated spec.

The planning commands have grown into a maintenance burden and overlap with the
agent-based workflow. The goal is a leaner extension: agents (e.g.
`ux-discovery-interviewer`, `spec-writer`, `delivery-plan-architect`) handle
upstream thinking and document production; the extension only orchestrates
implementation from a finished delivery plan.

## Commands to Remove (full removal)

All command families below, including every sub-command and conversational
helper, are to be removed:

1. **`/spec` family**: `spec`, `spec-resume`, `spec-status`, `spec-list`,
   `spec-cancel`, plus conversational helpers `spec-draft-done`,
   `discovery-done`.
2. **`/epic` family**: `epic`, `epic-resume`, `epic-status`, `epic-list`,
   `epic-cancel`.
3. **`/brainstorm` family**: `brainstorm`, `brainstorm-done`,
   `brainstorm-status`, `brainstorm-list`, `brainstorm-cancel`.
4. **`/plan` family** (added to scope): `plan`, `plan-done`, `plan-cancel`,
   `plan-overview`.
5. **`/roadmap` family** (added to scope): `roadmap`, `roadmap-resume`,
   `roadmap-status`, `roadmap-list`, `roadmap-cancel`.
6. **Shared conversational helper** `draft-done` (used by hierarchy drafting for
   roadmap/epic) — removed with the hierarchy pipeline.

## Command to KEEP

- **`/implement` family**: `implement`, `implement-resume`, `implement-status`,
  `implement-list`, `implement-cancel`, `implement-metrics`.
  - New input contract: `/implement <delivery-plan-file>` where the file is a
    delivery plan authored by the `delivery-plan-architect` agent.

## Current State / Technical Findings

Single-file command registration lives in `index.ts` (~5,900 lines) via
`pi.registerCommand(...)`. Supporting modules:

- `index.ts` — command registrations; conversational state machine
  (`pipelineMode`, `activePipelineKind`, `activeHierarchyLevel`); discovery,
  drafting, scoping, and brainstorm "modes"; system-prompt injection for the
  host LLM; mode widgets.
- `spec-pipeline.ts` — spec completion logic.
- `hierarchy-pipeline.ts` — shared roadmap + epic post-approval logic
  (child extraction → completion).
- `implement-pipeline.ts` — phase extraction → per-phase plan generation →
  review → implementation → code review.
- `state.ts` — per-kind CRUD: Spec/Epic/Roadmap/Brainstorm/Implementation
  states; state dirs under `.pi/spec-pipeline/`.
- `types.ts` — `SpecState`, `EpicState`, `RoadmapState`, `HierarchyState`,
  `BrainstormState`, `ConversationalPipelineState`, scoping state,
  `PipelineMode`/`PipelineKind` enums, config schema fields
  (`roadmapDrafter`, `roadmapReviewer`, `epicDrafter`, `epicReviewer`,
  `specTemplate`, `specConventions`, `specFormat`, etc.), role enums
  (`brainstormAgent`, `roadmapDrafter`, `epicDrafter`, ...).
- `config.ts`, `agents-config.ts`, `git.ts`, `commit-agent.ts`,
  `formatting.ts` — all reference spec/epic/roadmap/brainstorm kinds.
- `templates/spec-template.md`, `skills/`, `README.md`, and the large header
  doc-comment in `index.ts` document the commands.
- Test files: `state.test.ts`, `config.test.ts`, `formatting.test.ts`,
  `agents.test.ts`, `discovery-loop.test.ts`, `escalation.test.ts`,
  `pipeline-resume.test.ts`, `implement-discovery.test.ts`, etc. reference the
  removed kinds.

### Key Entanglements (the hard part)

1. **`/implement` has TWO current input paths:**
   - A **file path** (spec/`.md`/`.typ`) → `extractPhases` parses a phase table
     and runs the implementation pipeline. **This is the path that survives**,
     redirected at delivery-plan documents.
   - A **text description → "implement-discovery mode"** (explicitly "the same
     discovery process as /spec") via `enterImplementDiscoveryMode`. This shares
     the discovery state machine being removed and should be removed too.
2. **Phase-table compatibility (low risk):** the `delivery-plan-architect`
   agent emits a table `| Phase | Focus | Effort | Difficulty |` in *exactly*
   the format `extractPhases` in `implement-pipeline.ts` already parses,
   including the `standard`/`hard` difficulty routing. The handoff is therefore
   naturally compatible.
3. **`/implement`'s internal per-phase plan generation** (`skipPlanGeneration`,
   `--no-plan`) is distinct from the high-level delivery plan and is a candidate
   to keep (see open questions).
4. **Shared state machine in `index.ts`:** `pipelineMode` supports
   `idle | scoping | discovery | drafting | brainstorm`; `activePipelineKind`
   supports `spec | hierarchy | implement | brainstorm`. Removing planning kinds
   means the only surviving non-idle mode is `implement` discovery (which is
   itself being removed), so the conversational mode machinery collapses
   substantially.
5. **Cross-references in prose:** many notify/usage strings and the header
   doc-comment refer to removed commands and must be updated.
6. **Naming:** the extension, its state directory (`.pi/spec-pipeline/`), and
   internal "spec" terminology are pervasive. Renaming is out of scope unless
   trivially required; the spec should call out whether the `.pi/spec-pipeline/`
   state dir and extension name remain as-is.

## Goals / Desired Outcomes

- The five planning command families (and the `draft-done` helper) are fully
  unregistered and their dead code/types/config/state removed.
- `/implement` remains fully functional, taking a delivery-plan file produced by
  `delivery-plan-architect`.
- No dangling references: prose, README, header doc-comment, skills, and config
  schema reflect the reduced surface.
- The build/typecheck passes and the test suite is updated (planning-specific
  tests removed or rewritten; implement tests retained/adjusted).
- No regression in the surviving `/implement` pipeline behavior (phase
  extraction, per-phase plan/review/implement, resume/status/list/cancel/
  metrics, git checks, auto-mode).

## Constraints

- Single large `index.ts`; edits must preserve the surviving `/implement`
  registrations and the host-LLM hooks that `/implement` discovery used (only if
  those hooks are still needed by surviving features).
- TypeScript types in `types.ts` are shared; removals must not break
  `implement-pipeline.ts`, `state.ts`, `config.ts`.
- The `.pi/spec-pipeline.json` config file schema is user-facing; removed fields
  should be handled gracefully (ignored, not error) for existing configs.
- Tests are the safety net; keep `bun test` green.

## Scope Boundaries

In scope:
- Removing the 5 planning command families + `draft-done`.
- Removing the conversational discovery/drafting/scoping/brainstorm machinery
  that exclusively served the removed commands.
- Removing `/implement`'s text → discovery-mode path.
- Pruning shared types/state/config/agents-config/git/formatting/commit-agent
  code paths exclusive to removed kinds.
- Updating docs (README, header comment, skills index) and tests.

Out of scope (unless required for a clean build):
- Renaming the extension or the `.pi/spec-pipeline/` state directory.
- Changing the `delivery-plan-architect` agent itself.
- Changing the surviving `/implement` algorithm beyond input-contract cleanup.

## Open Questions / Risks for the Spec

1. **`/implement` discovery mode**: confirmed for removal? (It is the same
   conversational discovery as `/spec`.) Assume YES unless told otherwise; if
   removed, `/implement <free text>` should produce a clear error directing the
   user to supply a delivery-plan file.
2. **Per-phase plan generation in `/implement`**: keep `--no-plan` /
   `skipPlanGeneration`? Recommended KEEP (distinct from delivery-plan).
3. **Config schema**: delete removed fields outright, or retain-and-ignore for
   backward compatibility with existing `.pi/spec-pipeline.json` files?
4. **State directory cleanup**: leave existing on-disk
   `.pi/spec-pipeline/specs|epics|roadmaps|brainstorms` data untouched, or
   provide migration/cleanup? Recommended: leave untouched, stop writing.
5. **Extension/state-dir naming**: keep `spec-pipeline` name despite "spec"
   command removal? Recommended: keep (rename is a separate effort).
6. **Skills**: `skills/spec-writer`, `skills/ux-discovery-interviewer`,
   `skills/delivery-plan-architect` describe an agent-based flow; verify they
   don't instruct users to run removed slash commands; update any that do.

## Detailed Technical Findings (pre-investigated — do not re-investigate)

These concrete references were gathered from the codebase. Use them directly to
write traceable requirements; you do NOT need to re-scan the repo.

### Command registrations in `index.ts` (`pi.registerCommand(...)`)
- REMOVE — spec family: `spec-draft-done` (~L2413), `discovery-done` (~L2428),
  `draft-done` (~L2690), `spec` (~L2705), `spec-resume` (~L2897),
  `spec-status` (~L3139), `spec-list` (~L3187), `spec-cancel` (~L3231).
- KEEP — implement family: `implement` (~L3289), `implement-resume` (~L3586),
  `implement-status` (~L3761), `implement-list` (~L3809),
  `implement-cancel` (~L3855), `implement-metrics` (~L3915).
- REMOVE — plan family: `plan` (~L4464), `plan-done` (~L4580),
  `plan-cancel` (~L4733), `plan-overview` (~L5213).
- REMOVE — roadmap family: `roadmap` (~L4749), `roadmap-resume` (~L4799),
  `roadmap-status` (~L4814), `roadmap-list` (~L4865), `roadmap-cancel` (~L4910).
- REMOVE — epic family: `epic` (~L4966), `epic-resume` (~L5048),
  `epic-status` (~L5063), `epic-list` (~L5110), `epic-cancel` (~L5157).
- REMOVE — brainstorm family: `brainstorm` (~L5473), `brainstorm-done` (~L5588),
  `brainstorm-status` (~L5716), `brainstorm-list` (~L5795),
  `brainstorm-cancel` (~L5841).

### Conversational state-machine helpers in `index.ts` (remove; served only the
removed discovery/drafting/scoping/brainstorm modes)
- `persistDiscoveryLoopState` (~L514), `isUnambiguousDiscoveryDecision` (~L590),
  `classifyDiscoveryReply` (~L655), `buildUnifiedDiscoveryPrompt` (~L926),
  `buildDiscoveryQuestionSystemPrompt` (~L994), `runFollowUpStep` (~L1026),
  `runDiscoveryStep` (~L1128), `buildDraftingPromptInjection` (~L1279),
  `buildScopingPromptInjection` (~L1337),
  `buildHierarchyDraftingPromptInjection` (~L1431),
  `buildBrainstormPromptInjection` (~L1499), `enterDraftingMode` (~L1727),
  `updateModeWidget` (~L1563, simplify or remove with mode collapse).
- The `pi.on(...)` host-LLM hooks (`before_agent_start`, `input`, `agent_end`,
  `context`) early-return when `pipelineMode === idle`. The surviving
  `/implement` pipeline runs agents via subprocess (`agents.ts`), NOT via these
  host-LLM hooks, so once all non-idle modes are removed these hooks become dead
  code and can be removed.
- `/implement`'s text→discovery branch calls `enterImplementDiscoveryMode`
  (~L3535) and `pi.sendUserMessage(...)`; remove this branch so a free-text arg
  errors with guidance to pass a delivery-plan file.

### `state.ts` — remove CRUD/dirs for removed kinds; KEEP Impl + shared helpers
- REMOVE: `getSpecStateDir`, `getSpecStatePath`, `loadSpecState`,
  `saveSpecState`, `listSpecStates`, `getLatestActiveSpecPipeline`,
  `createInitialSpecState`, `createInitialDiscoveryState`,
  `generateConversationalDiscoverySummary`, `generateSpecTimestamp` alias;
  all Roadmap CRUD (`getRoadmapStateDir`..`createInitialRoadmapState`), all Epic
  CRUD (`getEpicStateDir`..`createInitialEpicState`), all Brainstorm CRUD
  (`getBrainstormStateDir`..`createInitialBrainstormState`), `extractChildItems`.
  Remove dir consts `SPEC_STATE_DIR`, `ROADMAP_STATE_DIR`, `EPIC_STATE_DIR`,
  `BRAINSTORM_STATE_DIR`.
- KEEP: `getImplStateDir`, `getStateDir`, `getSessionLogDir`, `getImplStatePath`,
  `loadImplState`, `saveImplState`, `listImplStates`,
  `getLatestActiveImplPipeline`, `createInitialImplState`,
  `generatePipelineId`, `generateTimestamp`, `IMPL_STATE_DIR`, `STATE_DIR`.

### `agents-config.ts` — `createSystemPrompts` role keys
- REMOVE roles: `brainstormAgent` (~L637), `scopingAgent` (~L721),
  `roadmapDrafter` (~L762), `roadmapReviewer` (~L823), `epicDrafter` (~L875),
  `epicReviewer` (~L936).
- KEEP roles: `planDrafter` (~L321, per-phase impl plan), `implementer` (~L437),
  `codeReviewer` (~L494), `commitMessageWriter` (~L563), `addressReview`
  (~L603).
- `buildPromptOptions`/`SystemPromptOptions` carry `specTemplate`,
  `specTemplatePath`, `specConventions`, `specConventionsPath`, `specFormat`.
  Decide per Open Question #3 whether these stay (still used to format the
  per-phase implementer prompt?) or are pruned. `SystemPromptRoleName` is
  derived from the return type, so it updates automatically.

### `config.ts` — model role defaults & validation
- REMOVE from `DEFAULT_MODEL_CONFIGS`/`ROLE_TIERS`: `roadmapDrafter`,
  `roadmapReviewer`, `epicDrafter`, `epicReviewer` (~L38-61), and the
  `brainstormAgent` branch in escalation logic (~L165).
- KEEP: `planDrafter`, `implementer`, `codeReviewer`, etc. The `specsDir`,
  `specTemplatePath`, `specConventionsPath` discovery logic (~L349-666) is tied
  to spec authoring — evaluate whether the surviving implementer prompt still
  needs a template/conventions; if not, prune.

### `formatting.ts`
- REMOVE: `formatSpecStage`, `formatHierarchyStage`, `formatSpecState`,
  `formatRoadmapState`, `formatEpicState`, `updateSpecWidget`. (Brainstorm has
  no dedicated formatter beyond state.)
- KEEP: `formatBox`, `formatDivider`, `formatKeyValue`, `formatStepBanner`,
  `formatModelConfig`, `formatEffectiveConfig`, `formatImplStage`,
  `summarizeAgentOutput`, `formatAgentSummary`, `formatImplState`,
  `updateImplWidget`, `clearPipelineWidget`.

### Other modules with removed-kind references (prune, keep impl paths)
- `git.ts` (~10 refs), `commit-agent.ts` (~14 refs — `extractDocName`/
  `extractPhaseName` are used by implement, keep), `spec-pipeline.ts` (DELETE
  whole file), `hierarchy-pipeline.ts` (DELETE whole file), `errors.ts`,
  `escalation.ts`, `review.ts`, `agents.ts` — verify each only loses
  removed-kind branches and the implement path still compiles.

### `types.ts`
- REMOVE: `SpecState`, `EpicState`, `RoadmapState`, `HierarchyState`,
  `BrainstormState`, `ConversationalPipelineState`, scoping state types,
  `SpecStage`/`HierarchyStage`, and `PipelineMode`/`PipelineKind` members for
  removed modes (collapse `PipelineMode` so only `idle` remains or remove the
  union entirely; collapse `PipelineKind` to `implement`).
- KEEP: `ImplementationState`, `ImplementationStage`, `ModelConfig`,
  `PlanDifficulty`, config interface (minus removed fields).

### `extractPhases` ↔ delivery-plan-architect compatibility (verified)
- `extractPhases` (`implement-pipeline.ts` ~L236) parses
  `| Phase N | Focus | Effort | Difficulty? |` with case-insensitive
  `standard`|`hard` difficulty routing. The `delivery-plan-architect` agent
  (`agents/delivery-plan-architect.md` ~L57-66) emits EXACTLY this table. No
  parser change required; the surviving `/implement <delivery-plan.md>` path
  works unchanged.

### Docs to update
- `README.md`: already has a deprecation notice (~L5-6); remove the command rows
  for spec/plan/roadmap/epic/brainstorm (~L97-103 etc.), the example blocks
  (~L33-88), and the conversational-scoping bullet (~L21). Update the
  `/implement` row (~L111) to drop the `description` input mode and point at
  delivery-plan files.
- Large header doc-comment in `index.ts` (~L6-70): rewrite to describe only
  `/implement` + agent-produced delivery plans.
- `skills/ux-discovery-interviewer/SKILL.md` (~L18, L42) references `/spec` and
  "planning session" — update to hand off to the `delivery-plan-architect`
  agent / `/implement`.
- `skills/implement-pipeline/SKILL.md` (~L26-56): already implement-centric;
  adjust "spec" wording to "delivery plan".
- `templates/spec-template.md`: remove or repurpose (decide per Open Question).

### Tests (counts of removed-kind references; update or delete)
- DELETE (planning-only): `discovery-loop.test.ts` (118),
  `implement-discovery.test.ts` (59) — covers the removed `/implement` discovery
  mode, `pipeline-resume.test.ts` (56) if it resumes removed kinds.
- HEAVILY UPDATE: `state.test.ts` (161), `config.test.ts` (68),
  `formatting.test.ts` (38) — strip removed-kind cases, keep impl cases.
- LIGHTLY UPDATE: `git.test.ts` (16), `commit-agent.test.ts` (11),
  `errors.test.ts` (5), `agents.test.ts` (4), `escalation.test.ts` (3),
  `implement-pipeline.test.ts` (7).
- UNAFFECTED: `review.test.ts` (0).
