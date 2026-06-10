# Technical Spec: Remove Planning Command Families, Keep `/implement`

> Source discovery: `specs/discovery_remove_planning_commands.md`.
> Scope: FULL REMOVAL of the `/spec`, `/epic`, `/brainstorm`, `/plan`, and
> `/roadmap` command families (including all sub-commands and conversational
> helpers) from the `pi-spec-pipeline` extension. The `/implement` family
> survives and is redirected to consume a delivery-plan document produced by
> the `delivery-plan-architect` agent. All file/function/line references are
> drawn from the discovery doc's "Detailed Technical Findings" section and are
> approximate (the `index.ts` file is ~5,900 lines and shifts as code is
> removed).

---

## 1. Problem Statement

The `pi-spec-pipeline` extension bundles a large conversational "planning
pipeline" (idea → scope → spec/epic/roadmap → implement) built around five
command families and a host-LLM-driven conversational state machine. This
surface has become a maintenance burden and overlaps with the agent-based
workflow now preferred by the owner: agents (`ux-discovery-interviewer`,
`spec-writer`, `delivery-plan-architect`) handle upstream thinking and document
production, and the extension should only orchestrate implementation from a
finished delivery plan.

The goal is a leaner extension reduced to a single execution command,
`/implement`, which consumes a delivery-plan document authored by the
`delivery-plan-architect` agent (`agents/delivery-plan-architect.md`) instead of
an internally generated spec. The delivery-plan agent already emits a phase
table in exactly the format `extractPhases` (`implement-pipeline.ts` ~L236)
parses, so the handoff is naturally compatible and requires no parser change.

---

## 2. Scope & Boundaries

### 2.1 In Scope

- Unregistering the five planning command families and all conversational
  helpers (FR-1).
- Cleaning up `/implement`'s input contract: removing the free-text →
  "implement-discovery mode" path so `/implement` only accepts a delivery-plan
  file (FR-2).
- Collapsing the conversational state machine (`pipelineMode`,
  `activePipelineKind`, discovery/drafting/scoping/brainstorm helpers) and
  removing the now-dead `pi.on(...)` host-LLM hooks (FR-3).
- Pruning shared `types.ts` (FR-4), `state.ts` CRUD (FR-5),
  `agents-config.ts` role keys (FR-6), `config.ts` role defaults and validation
  (FR-7), and `formatting.ts` formatters (FR-8) of all removed-kind code paths.
- Pruning removed-kind branches from supporting modules and **deleting**
  `spec-pipeline.ts` and `hierarchy-pipeline.ts` entirely (FR-9).
- Updating docs: `README.md`, the `index.ts` header doc-comment, and the
  `skills/` SKILL files (FR-10).
- Updating or deleting tests so `bun test` stays green (FR-11).

### 2.2 Out of Scope (unless required for a clean build)

- Renaming the extension or the `.pi/spec-pipeline/` state directory (kept
  as-is per Open Question #5).
- Changing the `delivery-plan-architect` agent itself.
- Changing the surviving `/implement` algorithm beyond input-contract cleanup
  (phase extraction, per-phase plan/review/implement, resume/status/list/
  cancel/metrics, git checks, auto-mode all remain behaviorally unchanged).
- On-disk migration/cleanup of existing
  `.pi/spec-pipeline/specs|epics|roadmaps|brainstorms` data (left untouched per
  Open Question #4).

---

## 3. Functional Requirements

### Area A — Command Unregistration (`index.ts`)

**FR-1.** Remove the following `pi.registerCommand(...)` registrations from
`index.ts`. After removal there must be no `registerCommand` call for any of
these command names, and no helper function that exists solely to support them.

- **FR-1.1 — `/spec` family + helpers:** `spec-draft-done` (~L2413),
  `discovery-done` (~L2428), `draft-done` (~L2690), `spec` (~L2705),
  `spec-resume` (~L2897), `spec-status` (~L3139), `spec-list` (~L3187),
  `spec-cancel` (~L3231).
- **FR-1.2 — `/plan` family:** `plan` (~L4464), `plan-done` (~L4580),
  `plan-cancel` (~L4733), `plan-overview` (~L5213).
- **FR-1.3 — `/roadmap` family:** `roadmap` (~L4749), `roadmap-resume`
  (~L4799), `roadmap-status` (~L4814), `roadmap-list` (~L4865),
  `roadmap-cancel` (~L4910).
- **FR-1.4 — `/epic` family:** `epic` (~L4966), `epic-resume` (~L5048),
  `epic-status` (~L5063), `epic-list` (~L5110), `epic-cancel` (~L5157).
- **FR-1.5 — `/brainstorm` family:** `brainstorm` (~L5473), `brainstorm-done`
  (~L5588), `brainstorm-status` (~L5716), `brainstorm-list` (~L5795),
  `brainstorm-cancel` (~L5841).

**FR-1.6 — Keep `/implement` family registrations** intact and functional:
`implement` (~L3289), `implement-resume` (~L3586), `implement-status` (~L3761),
`implement-list` (~L3809), `implement-cancel` (~L3855), `implement-metrics`
(~L3915). These must continue to be registered and work end-to-end.

### Area B — `/implement` Input-Contract Cleanup (`index.ts`)

**FR-2.** The surviving `implement` command (~L3289) currently accepts two
input paths: (a) a file path (spec/`.md`/`.typ`) parsed by `extractPhases`, and
(b) a free-text description routed into "implement-discovery mode" via
`enterImplementDiscoveryMode` (~L3535) + `pi.sendUserMessage(...)`.

- **FR-2.1.** Remove the free-text → discovery branch entirely (the
  `enterImplementDiscoveryMode` call at ~L3535 and its surrounding branch).
- **FR-2.2.** When `/implement` is invoked with a free-text argument that is not
  a readable delivery-plan file, it must return a clear error directing the user
  to supply a delivery-plan file (e.g. a `.md`/`.typ` file produced by the
  `delivery-plan-architect` agent). It must NOT enter any conversational mode.
- **FR-2.3.** The surviving file-path branch (delivery-plan file →
  `extractPhases` → implementation pipeline) must be preserved unchanged.
  `extractPhases` (`implement-pipeline.ts` ~L236) parses
  `| Phase N | Focus | Effort | Difficulty? |` with case-insensitive
  `standard`|`hard` routing, matching the table emitted by
  `delivery-plan-architect.md` (~L57-66). No parser changes are permitted.

### Area C — Conversational State-Machine Collapse + Dead Hook Removal (`index.ts`)

**FR-3.** The conversational state machine existed only to serve the removed
discovery/drafting/scoping/brainstorm modes. With all non-idle modes gone, it
collapses.

- **FR-3.1.** Remove the conversational helper functions that served only
  removed modes: `persistDiscoveryLoopState` (~L514),
  `isUnambiguousDiscoveryDecision` (~L590), `classifyDiscoveryReply` (~L655),
  `buildUnifiedDiscoveryPrompt` (~L926), `buildDiscoveryQuestionSystemPrompt`
  (~L994), `runFollowUpStep` (~L1026), `runDiscoveryStep` (~L1128),
  `buildDraftingPromptInjection` (~L1279), `buildScopingPromptInjection`
  (~L1337), `buildHierarchyDraftingPromptInjection` (~L1431),
  `buildBrainstormPromptInjection` (~L1499), `enterDraftingMode` (~L1727), and
  `enterImplementDiscoveryMode` (~L3535).
- **FR-3.2.** Remove or reduce `updateModeWidget` (~L1563) consistent with the
  mode collapse. If no surviving caller exists, delete it; otherwise reduce it
  to only what `/implement` widgets require (note: `/implement` uses
  `updateImplWidget` from `formatting.ts`, so `updateModeWidget` is expected to
  be deletable).
- **FR-3.3.** Remove the module-level conversational state (`pipelineMode`,
  `activePipelineKind`, `activeHierarchyLevel` and any related per-session
  mode state) once no surviving code reads or writes it.
- **FR-3.4.** Remove the `pi.on(...)` host-LLM hooks
  (`before_agent_start`, `input`, `agent_end`, `context`) that early-return when
  `pipelineMode === idle`. Per findings, the surviving `/implement` pipeline runs
  agents via subprocess (`agents.ts`), NOT via these host-LLM hooks, so once all
  non-idle modes are removed these hooks are dead code. Confirm no surviving
  `/implement` feature depends on them before removal; if any single hook is
  still required, retain only that hook and document why.

### Area D — Types Pruning (`types.ts`)

**FR-4.** Prune the shared type surface:

- **FR-4.1 — Remove:** `SpecState`, `EpicState`, `RoadmapState`,
  `HierarchyState`, `BrainstormState`, `ConversationalPipelineState`, the
  scoping state types, and the `SpecStage`/`HierarchyStage` types.
- **FR-4.2 — Collapse mode enums:** reduce `PipelineMode` so only `idle` remains
  (or remove the union entirely if no surviving code references it), and
  collapse `PipelineKind` to `implement` only.
- **FR-4.3 — Prune config fields:** remove removed-kind config schema fields
  (`roadmapDrafter`, `roadmapReviewer`, `epicDrafter`, `epicReviewer`,
  `brainstormAgent`, `scopingAgent`, and role-enum members for removed kinds).
  The disposition of `specTemplate`/`specConventions`/`specFormat` fields is
  governed by FR-6.4 / Open Question #3.
- **FR-4.4 — Keep:** `ImplementationState`, `ImplementationStage`,
  `ModelConfig`, `PlanDifficulty`, and the config interface minus removed
  fields.

### Area E — `state.ts` CRUD Pruning

**FR-5.** Remove per-kind CRUD and directory constants for removed kinds; keep
the implementation and shared helpers.

- **FR-5.1 — Remove (spec):** `getSpecStateDir`, `getSpecStatePath`,
  `loadSpecState`, `saveSpecState`, `listSpecStates`,
  `getLatestActiveSpecPipeline`, `createInitialSpecState`,
  `createInitialDiscoveryState`, `generateConversationalDiscoverySummary`, and
  the `generateSpecTimestamp` alias.
- **FR-5.2 — Remove (roadmap):** all roadmap CRUD from `getRoadmapStateDir`
  through `createInitialRoadmapState`.
- **FR-5.3 — Remove (epic):** all epic CRUD from `getEpicStateDir` through
  `createInitialEpicState`.
- **FR-5.4 — Remove (brainstorm):** all brainstorm CRUD from
  `getBrainstormStateDir` through `createInitialBrainstormState`.
- **FR-5.5 — Remove:** `extractChildItems`, and the directory constants
  `SPEC_STATE_DIR`, `ROADMAP_STATE_DIR`, `EPIC_STATE_DIR`,
  `BRAINSTORM_STATE_DIR`.
- **FR-5.6 — Keep:** `getImplStateDir`, `getStateDir`, `getSessionLogDir`,
  `getImplStatePath`, `loadImplState`, `saveImplState`, `listImplStates`,
  `getLatestActiveImplPipeline`, `createInitialImplState`, `generatePipelineId`,
  `generateTimestamp`, and the constants `IMPL_STATE_DIR`, `STATE_DIR`.
- **FR-5.7.** Per Open Question #4 default: do not delete or migrate existing
  on-disk `.pi/spec-pipeline/specs|epics|roadmaps|brainstorms` data — simply
  stop reading/writing it.

### Area F — `agents-config.ts` Role Pruning

**FR-6.** In `createSystemPrompts`:

- **FR-6.1 — Remove roles:** `brainstormAgent` (~L637), `scopingAgent` (~L721),
  `roadmapDrafter` (~L762), `roadmapReviewer` (~L823), `epicDrafter` (~L875),
  `epicReviewer` (~L936).
- **FR-6.2 — Keep roles:** `planDrafter` (~L321, per-phase impl plan),
  `implementer` (~L437), `codeReviewer` (~L494), `commitMessageWriter` (~L563),
  `addressReview` (~L603).
- **FR-6.3.** `SystemPromptRoleName` is derived from the return type of
  `createSystemPrompts`, so it updates automatically — verify it no longer
  includes removed role names after the change.
- **FR-6.4.** Decide per Open Question #3 whether `buildPromptOptions` /
  `SystemPromptOptions` fields `specTemplate`, `specTemplatePath`,
  `specConventions`, `specConventionsPath`, `specFormat` are pruned or retained.
  Recommended default: **retain** any field still consumed by the surviving
  per-phase `implementer`/`planDrafter` prompt; prune fields with no remaining
  reader. Document the decision inline.

### Area G — `config.ts` Role/Validation Pruning

**FR-7.** In `config.ts`:

- **FR-7.1 — Remove** `roadmapDrafter`, `roadmapReviewer`, `epicDrafter`,
  `epicReviewer` from `DEFAULT_MODEL_CONFIGS` and `ROLE_TIERS` (~L38-61).
- **FR-7.2 — Remove** the `brainstormAgent` branch in the escalation logic
  (~L165).
- **FR-7.3 — Keep** `planDrafter`, `implementer`, `codeReviewer`, etc.
- **FR-7.4.** Per Open Question #3 default (graceful backward compatibility):
  unknown/removed fields in an existing `.pi/spec-pipeline.json` config must be
  ignored, NOT cause a validation error.
- **FR-7.5.** Evaluate the `specsDir` / `specTemplatePath` /
  `specConventionsPath` discovery logic (~L349-666): if the surviving
  implementer prompt no longer needs a template/conventions, prune it;
  otherwise retain. Tie this decision to FR-6.4.

### Area H — `formatting.ts` Pruning

**FR-8.** In `formatting.ts`:

- **FR-8.1 — Remove:** `formatSpecStage`, `formatHierarchyStage`,
  `formatSpecState`, `formatRoadmapState`, `formatEpicState`, `updateSpecWidget`.
- **FR-8.2 — Keep:** `formatBox`, `formatDivider`, `formatKeyValue`,
  `formatStepBanner`, `formatModelConfig`, `formatEffectiveConfig`,
  `formatImplStage`, `summarizeAgentOutput`, `formatAgentSummary`,
  `formatImplState`, `updateImplWidget`, `clearPipelineWidget`.

### Area I — Supporting-Module Pruning + File Deletions

**FR-9.** Prune removed-kind references from supporting modules and delete the
two modules that serve only removed pipelines.

- **FR-9.1 — DELETE** `spec-pipeline.ts` entirely (spec completion logic) and
  remove all imports of it.
- **FR-9.2 — DELETE** `hierarchy-pipeline.ts` entirely (shared roadmap + epic
  post-approval logic) and remove all imports of it.
- **FR-9.3 — `git.ts` (~10 refs):** remove removed-kind branches; the
  implement git path must still compile and behave unchanged.
- **FR-9.4 — `commit-agent.ts` (~14 refs):** prune removed-kind references but
  **keep** `extractDocName` / `extractPhaseName`, which are used by `/implement`.
- **FR-9.5 — `errors.ts`, `escalation.ts`, `review.ts`, `agents.ts`:** remove
  only removed-kind branches; verify each still compiles and the implement path
  is intact.
- **FR-9.6.** After deletions, there must be no remaining import of
  `spec-pipeline` or `hierarchy-pipeline` anywhere in the codebase.

### Area J — Docs Updates

**FR-10.** Update documentation to reflect the reduced surface:

- **FR-10.1 — `README.md`:** remove the command rows for spec/plan/roadmap/epic/
  brainstorm (~L97-103 etc.), the example blocks (~L33-88), and the
  conversational-scoping bullet (~L21). Update the `/implement` row (~L111) to
  drop the free-text `description` input mode and point at delivery-plan files
  produced by `delivery-plan-architect`. The existing deprecation notice
  (~L5-6) may be replaced by the finalized reduced-surface description.
- **FR-10.2 — `index.ts` header doc-comment (~L6-70):** rewrite to describe only
  `/implement` consuming an agent-produced delivery plan. No references to
  removed commands may remain.
- **FR-10.3 — `skills/ux-discovery-interviewer/SKILL.md` (~L18, L42):** update
  references to `/spec` and "planning session" to hand off to the
  `delivery-plan-architect` agent / `/implement`.
- **FR-10.4 — `skills/implement-pipeline/SKILL.md` (~L26-56):** adjust "spec"
  wording to "delivery plan".
- **FR-10.5 — Per Open Question #6:** audit all `skills/` SKILL files
  (`spec-writer`, `ux-discovery-interviewer`, `delivery-plan-architect`,
  `implement-pipeline`) to confirm none instruct users to run a removed slash
  command; update any that do.
- **FR-10.6 — `templates/spec-template.md`:** remove or repurpose per Open
  Question disposition (default: keep only if still consumed by a surviving
  prompt per FR-6.4/FR-7.5; otherwise delete).

### Area K — Tests Updates/Deletions

**FR-11.** Keep `bun test` green by updating/deleting tests in lockstep with
code removal.

- **FR-11.1 — DELETE (planning-only):** `discovery-loop.test.ts` (118 refs),
  `implement-discovery.test.ts` (59 refs — covers the removed `/implement`
  discovery mode). Delete `pipeline-resume.test.ts` (56 refs) if it only resumes
  removed kinds; otherwise reduce it to implement-only resume cases.
- **FR-11.2 — HEAVILY UPDATE:** `state.test.ts` (161 refs), `config.test.ts`
  (68 refs), `formatting.test.ts` (38 refs) — strip removed-kind cases, keep
  implementation cases.
- **FR-11.3 — LIGHTLY UPDATE:** `git.test.ts` (16), `commit-agent.test.ts` (11),
  `errors.test.ts` (5), `agents.test.ts` (4), `escalation.test.ts` (3),
  `implement-pipeline.test.ts` (7) — remove removed-kind assertions only.
- **FR-11.4 — UNAFFECTED:** `review.test.ts` (0 refs) — no changes expected.
- **FR-11.5.** Add/retain at least one test asserting FR-2.2: `/implement` with a
  free-text (non-file) argument returns the guidance error and enters no
  conversational mode.

---

## 4. Non-Functional Requirements

- **NFR-1 — Type safety:** `tsc`/typecheck must pass with no errors after all
  removals. Removed types must not leave dangling references in
  `implement-pipeline.ts`, `state.ts`, `config.ts`, `agents-config.ts`, or
  `formatting.ts`.
- **NFR-2 — Test suite:** `bun test` must be green.
- **NFR-3 — Backward compatibility:** existing user `.pi/spec-pipeline.json`
  configs containing removed fields must load without error (fields ignored, per
  FR-7.4). Existing on-disk state under `.pi/spec-pipeline/` must not be
  deleted or corrupted (FR-5.7).
- **NFR-4 — No behavioral regression** in the surviving `/implement` pipeline:
  phase extraction, per-phase plan/review/implement, resume/status/list/cancel/
  metrics, git checks, and auto-mode all behave as before.
- **NFR-5 — No dead code / no dangling references:** no `registerCommand` calls,
  imports, helper functions, type members, config roles, formatters, or prose
  referencing the removed command families or removed pipeline kinds remain.
- **NFR-6 — Naming preserved:** the extension name and the `.pi/spec-pipeline/`
  state directory remain unchanged (Open Question #5).

---

## 5. Observable Success Criteria

1. **SC-1.** Typecheck passes (`tsc --noEmit` or the project's typecheck script
   exits 0).
2. **SC-2.** `bun test` passes (all retained/updated tests green; deleted tests
   removed cleanly).
3. **SC-3.** No `pi.registerCommand` call exists for any of: `spec`,
   `spec-resume`, `spec-status`, `spec-list`, `spec-cancel`, `spec-draft-done`,
   `discovery-done`, `draft-done`, `plan`, `plan-done`, `plan-cancel`,
   `plan-overview`, `roadmap`, `roadmap-resume`, `roadmap-status`,
   `roadmap-list`, `roadmap-cancel`, `epic`, `epic-resume`, `epic-status`,
   `epic-list`, `epic-cancel`, `brainstorm`, `brainstorm-done`,
   `brainstorm-status`, `brainstorm-list`, `brainstorm-cancel`. (Verifiable by
   grep.)
4. **SC-4.** Grep for removed type/kind identifiers (`SpecState`, `EpicState`,
   `RoadmapState`, `HierarchyState`, `BrainstormState`,
   `ConversationalPipelineState`) returns no references in source.
5. **SC-5.** `spec-pipeline.ts` and `hierarchy-pipeline.ts` no longer exist and
   are not imported anywhere.
6. **SC-6.** The six `/implement` commands remain registered and work
   end-to-end: given a delivery-plan file authored by `delivery-plan-architect`,
   `/implement <delivery-plan.md>` extracts phases via `extractPhases`, runs
   per-phase plan/review/implement, and `implement-resume`/`-status`/`-list`/
   `-cancel`/`-metrics` all function.
7. **SC-7.** `/implement <free text>` (non-file argument) returns a clear error
   directing the user to supply a delivery-plan file, and does NOT enter any
   conversational mode (FR-2.2).
8. **SC-8.** README, `index.ts` header doc-comment, and SKILL files contain no
   references to the removed slash commands.

---

## 6. Advisory Solution Approach

This is advisory, not prescriptive; the implementer may choose an equivalent
ordering.

1. **Remove command registrations first (FR-1).** Delete the planning-family
   `registerCommand` blocks in `index.ts`. This immediately surfaces (via
   typecheck) which helper functions become unreferenced.
2. **Cut the `/implement` free-text branch (FR-2).** Remove the
   `enterImplementDiscoveryMode` branch and replace it with the guidance error.
3. **Collapse the state machine (FR-3).** Remove the discovery/drafting/scoping/
   brainstorm helpers, then the module-level mode state, then the now-dead
   `pi.on(...)` hooks. Verify each `pi.on` handler is genuinely unused by
   `/implement` before deleting; the implement pipeline drives agents via
   `agents.ts` subprocesses, so the hooks should be safe to remove.
4. **Delete the two dead modules (FR-9.1, FR-9.2)** and fix the resulting import
   errors.
5. **Prune types (FR-4), then state (FR-5), then agents-config (FR-6), config
   (FR-7), formatting (FR-8)** — let typecheck guide each step. Resolve Open
   Question #3 early since it determines whether the `spec*` template/conventions
   fields and `specsDir` discovery survive.
6. **Prune the remaining supporting modules (FR-9.3–FR-9.6)** by following
   typecheck errors; keep `extractDocName`/`extractPhaseName`.
7. **Update docs (FR-10)** and **tests (FR-11)** last; run `bun test` and
   typecheck iteratively until green.
8. **Final sweep:** grep for every removed command name and kind identifier
   (SC-3, SC-4) to confirm no dangling references.

Work iteratively with typecheck as the primary guide — the single large
`index.ts` makes incremental compile-checking the safest path.

---

## 7. Open Questions & Risks

The six open questions from discovery are carried forward with recommended
defaults. Unless overridden, the implementer should proceed with the
recommended default.

- **OQ-1 — `/implement` discovery mode removal.** Confirmed for removal? It is
  the same conversational discovery as `/spec`. **Recommended default: YES,
  remove.** `/implement <free text>` should error with guidance to supply a
  delivery-plan file (FR-2.2).
- **OQ-2 — Per-phase plan generation (`--no-plan` / `skipPlanGeneration`).**
  Keep it? **Recommended default: KEEP** — it is distinct from the high-level
  delivery plan and is part of the surviving `/implement` algorithm.
- **OQ-3 — Config schema for removed fields.** Delete outright, or
  retain-and-ignore for backward compatibility? **Recommended default:
  retain-and-ignore** (do not error on unknown/removed fields in existing
  `.pi/spec-pipeline.json`; FR-7.4). Separately, the `spec*` template/conventions
  fields (FR-6.4/FR-7.5) should be retained only if a surviving prompt still
  consumes them.
- **OQ-4 — On-disk state cleanup.** Migrate/clean or leave? **Recommended
  default: leave untouched, stop writing** (FR-5.7). No migration tooling.
- **OQ-5 — Extension/state-dir naming.** Keep `spec-pipeline` name and
  `.pi/spec-pipeline/` directory despite spec command removal? **Recommended
  default: KEEP** — renaming is a separate effort (NFR-6).
- **OQ-6 — Skills referencing removed commands.** Verify SKILL files do not
  instruct users to run removed slash commands. **Recommended default: audit and
  update** `skills/ux-discovery-interviewer`, `skills/spec-writer`,
  `skills/delivery-plan-architect`, `skills/implement-pipeline`; rewrite any that
  reference removed commands to point at the agent flow / `/implement`
  (FR-10.3–FR-10.5).

### Risks

- **R-1 — Hidden coupling in `index.ts`.** A surviving `/implement` path could
  unexpectedly depend on a `pi.on` hook or a "shared" helper slated for removal.
  *Mitigation:* remove incrementally and rely on typecheck + `bun test`;
  confirm each `pi.on` handler is unused before deletion (FR-3.4).
- **R-2 — Shared-type fan-out.** Removing `types.ts` members may break
  `implement-pipeline.ts`/`state.ts`/`config.ts` in non-obvious places.
  *Mitigation:* prune types after registrations are gone and let typecheck
  enumerate the breakage.
- **R-3 — Config backward compatibility.** Users with existing
  `.pi/spec-pipeline.json` files containing removed fields must not hit
  validation errors. *Mitigation:* FR-7.4 retain-and-ignore behavior + a test.
- **R-4 — `spec*` template/conventions ambiguity.** Whether the implementer
  prompt still needs `specTemplate`/`specConventions`/`specFormat` is uncertain
  and gates FR-6.4/FR-7.5. *Mitigation:* resolve OQ-3 early; trace consumers of
  these fields in the surviving `implementer`/`planDrafter` prompt before
  pruning.
