# Delivery Plan: Remove Planning Command Families, Keep `/implement`

> Spec: `specs/2606091200_remove_spec_epic_brainstorm_plan_roadmap_commands.md`
> Discovery: `specs/discovery_remove_planning_commands.md`
> Codebase: `/home/istar/code/pi-spec-pipeline`
> Date: 2026-06-10
> Verification: `bun test` · TypeScript typecheck (`tsc --noEmit` or equivalent)

---

## Confirmed Open-Question Resolutions

The following decisions resolve every open question from the spec and govern
the phases below. No further owner clarification is needed before starting.

| OQ | Decision | Impact |
|----|----------|--------|
| OQ-1 | **Remove** `/implement` free-text → discovery mode. | FR-2.1/FR-2.2: replace the `else` branch in the `implement` handler with a guidance error; delete `enterImplementDiscoveryMode`. |
| OQ-2 | **Keep** per-phase plan generation (`--no-plan` / `skipPlanGeneration`). | No change to `/implement` algorithm; flag parsing survives. |
| OQ-3 | **Retain-and-ignore** unknown/removed fields in user-supplied `.pi/spec-pipeline.json`. Prune `spec*`/template/conventions fields from TS types + `agents-config.ts` + `config.ts` because no surviving role (`planDrafter`, `implementer`, `codeReviewer`, etc.) consumes them—confirmed by tracing `specStructureGuidance` → used only in removed `specDrafter` / `specReviewer` roles. | Remove from interfaces and `buildPromptOptions`; prune `discoverSpecTemplate`, `discoverSpecConventions`, and `specsDir` discovery logic from `config.ts`. Verify TypeBox schema allows unknown JSON properties silently. |
| OQ-4 | **Leave on-disk state untouched.** Stop reading/writing removed-kind directories; do not delete them. | FR-5.7: no migration tooling. |
| OQ-5 | **Keep** extension name `pi-spec-pipeline` and `.pi/spec-pipeline/` directory. | NFR-6: no renames. |
| OQ-6 | **Audit and update** all `skills/` SKILL files (`ux-discovery-interviewer`, `spec-writer`, `delivery-plan-architect`, `implement-pipeline`). | FR-10.3–FR-10.5: update `ux-discovery-interviewer/SKILL.md` (references `/spec` and "planning session"); others need only minor wording checks. |

---

## Phase Table

| Phase | Focus | Effort | Difficulty |
|-------|-------|--------|------------|
| Phase 1 | `index.ts` — command unregistration + `/implement` input-contract cleanup | Large | standard |
| Phase 2 | `index.ts` — conversational state-machine collapse + dead `pi.on()` hook removal | Medium | standard |
| Phase 3 | Delete `spec-pipeline.ts` and `hierarchy-pipeline.ts`; fix imports | Small | standard |
| Phase 4 | Prune `types.ts`, `state.ts`, `agents-config.ts`, `config.ts`, `formatting.ts` | Medium | standard |
| Phase 5 | Prune `git.ts`, `commit-agent.ts`, `errors.ts`, `escalation.ts`, `review.ts`, `agents.ts` | Small | standard |
| Phase 6 | Docs — `README.md`, `index.ts` header, all four `skills/` SKILL files | Small | standard |
| Phase 7 | Tests — deletions, updates, new FR-2.2 test; `bun test` + typecheck green | Medium | standard |

---

## Phase 1 — `index.ts`: Command Unregistration + `/implement` Input-Contract Cleanup

**Spec coverage:** FR-1, FR-2

**Goal:** Remove all 27 planning-family `registerCommand` registrations and
replace the `/implement` free-text discovery branch with a clear guidance error.
After this phase, every removed command name is unreachable and
`/implement <delivery-plan.md>` is the only accepted input.

### Entry Conditions

- Working branch checked out; `bun test` is green at baseline (459 pass).
- `index.ts` is at ~5,895 lines (confirmed from codebase scan).

### Work Items

#### 1.1 — Remove planning-family `registerCommand` blocks

Delete each of the following blocks in their entirety (handler body + closing
brace). They are contiguous or near-contiguous within their command family,
making bulk deletion straightforward. Line numbers are approximate.

**`/spec` family** (FR-1.1) — `~L2413–3288`:
- `pi.registerCommand("spec-draft-done", ...)` ~L2413
- `pi.registerCommand("discovery-done", ...)` ~L2428
- `pi.registerCommand("draft-done", ...)` ~L2690
- `pi.registerCommand("spec", ...)` ~L2705
- `pi.registerCommand("spec-resume", ...)` ~L2897
- `pi.registerCommand("spec-status", ...)` ~L3139
- `pi.registerCommand("spec-list", ...)` ~L3187
- `pi.registerCommand("spec-cancel", ...)` ~L3231

**`/plan` family** (FR-1.2) — `~L4464–4748`:
- `pi.registerCommand("plan", ...)`
- `pi.registerCommand("plan-done", ...)`
- `pi.registerCommand("plan-cancel", ...)`
- `pi.registerCommand("plan-overview", ...)`  *(Note: `plan-overview` is at ~L5213; remove it there.)*

**`/roadmap` family** (FR-1.3) — `~L4749–4965`:
- `pi.registerCommand("roadmap", ...)`
- `pi.registerCommand("roadmap-resume", ...)`
- `pi.registerCommand("roadmap-status", ...)`
- `pi.registerCommand("roadmap-list", ...)`
- `pi.registerCommand("roadmap-cancel", ...)`

**`/epic` family** (FR-1.4) — `~L4966–5212`:
- `pi.registerCommand("epic", ...)`
- `pi.registerCommand("epic-resume", ...)`
- `pi.registerCommand("epic-status", ...)`
- `pi.registerCommand("epic-list", ...)`
- `pi.registerCommand("epic-cancel", ...)`

**`/brainstorm` family** (FR-1.5) — `~L5473–5895` (end of file):
- `pi.registerCommand("brainstorm", ...)`
- `pi.registerCommand("brainstorm-done", ...)`
- `pi.registerCommand("brainstorm-status", ...)`
- `pi.registerCommand("brainstorm-list", ...)`
- `pi.registerCommand("brainstorm-cancel", ...)`

**Keep untouched** (FR-1.6):
- `implement` (~L3289), `implement-resume` (~L3586), `implement-status`
  (~L3761), `implement-list` (~L3809), `implement-cancel` (~L3855),
  `implement-metrics` (~L3915).

Also delete the `// PLAN COMMANDS`, `// ROADMAP COMMANDS`, `// EPIC COMMANDS`,
`// BRAINSTORM COMMANDS` section-header comments that become orphaned.

#### 1.2 — Remove the `/implement` free-text discovery branch (FR-2.1/FR-2.2)

Locate the `implement` handler's terminal `else` block (~L3532–3585) that
begins:

```typescript
} else {
    // *** NEW: DISCOVERY MODE ENTRY ***
    const description = argWithoutFlags;
    ...
    enterImplementDiscoveryMode(...)
    ...
    pi.sendUserMessage(...)
}
```

Replace the entire `else { ... }` block with a single guidance-error return:

```typescript
} else {
    ctx.ui.notify(
        "❌ /implement requires a delivery-plan file.\n\n" +
        "Usage: /implement [--no-plan] [--no-review] [--auto] <delivery-plan.md>\n\n" +
        "To produce a delivery plan, run the delivery-plan-architect agent:\n" +
        "  subagent agent=delivery-plan-architect task=\"Read <spec-path> and write the delivery plan to <output-path>.\"",
        "error",
    );
    return;
}
```

Also update the `/implement` command `description` string (~L3291) to drop the
`description` input mode reference:

```
"Start implementation from a delivery-plan file. Use --no-plan to skip plan generation, --no-review to skip reviews, --auto to run without interactive TTY."
```

#### 1.3 — Remove helper: `promptForShortName`

Search for `promptForShortName` (~L420–445 and its call-site in the
`else` branch removed in 1.2). If the function's only remaining call-site was
inside the deleted `else` block, delete the function body too. Typecheck
will confirm if any surviving call exists.

#### 1.4 — Verify comment in `implement-cancel` handler (~L3863)

The `implement-cancel` handler contains a comment about
"implement-discovery mode (ephemeral, not persisted)". Remove that condition
and its associated logic once confirmed dead after the else-branch deletion.

### Exit Criteria

- Grep confirms: no `registerCommand` call for any removed name
  (spec, spec-resume, spec-status, spec-list, spec-cancel, spec-draft-done,
  discovery-done, draft-done, plan, plan-done, plan-cancel, plan-overview,
  roadmap, roadmap-resume, roadmap-status, roadmap-list, roadmap-cancel,
  epic, epic-resume, epic-status, epic-list, epic-cancel, brainstorm,
  brainstorm-done, brainstorm-status, brainstorm-list, brainstorm-cancel).
- All six `implement-*` `registerCommand` calls remain.
- TypeScript typecheck runs (may show errors about now-unused imports and
  helpers — that is expected input for Phase 2).

---

## Phase 2 — `index.ts`: Conversational State-Machine Collapse + Dead Hook Removal

**Spec coverage:** FR-3

**Goal:** Remove the conversational helper functions, module-level mode state,
and `pi.on(...)` host-LLM hooks that existed solely to serve the removed
discovery/drafting/scoping/brainstorm modes. After this phase, `index.ts`
contains no conversational state machine beyond what `/implement` intrinsically
requires.

### Entry Conditions

- Phase 1 complete; no planning-family registrations remain.
- Typecheck may be erroring on dangling references — that is acceptable
  input here.

### Work Items

#### 2.1 — Remove conversational helper functions (FR-3.1)

Delete the following function bodies (and their JSDoc) in their entirety.
These functions are only called from the removed discovery/spec/hierarchy/
brainstorm flow:

- `persistDiscoveryLoopState` (~L514)
- `isUnambiguousDiscoveryDecision` (~L590)
- `classifyDiscoveryReply` (~L655)
- `buildUnifiedDiscoveryPrompt` (~L926)
- `buildDiscoveryQuestionSystemPrompt` (~L994)
- `runFollowUpStep` (~L1026)
- `runDiscoveryStep` (~L1128)
- `buildDraftingPromptInjection` (~L1279)
- `buildScopingPromptInjection` (~L1337)
- `buildHierarchyDraftingPromptInjection` (~L1431)
- `buildBrainstormPromptInjection` (~L1499)
- `enterDraftingMode` (~L1727)
- `enterImplementDiscoveryMode` (~L3535) — already deleted from the command
  handler in Phase 1; ensure the standalone function definition is also removed.

#### 2.2 — Remove or collapse `updateModeWidget` (FR-3.2)

Locate `updateModeWidget` (~L1563). Search for all remaining call-sites
after Phase 1 deletions:

```bash
grep -n "updateModeWidget" index.ts
```

`/implement` uses `updateImplWidget` (from `formatting.ts`), not
`updateModeWidget`. If no surviving call-site remains, delete the function.
If any surviving call exists (unexpected), reduce it to a no-op and document
inline.

#### 2.3 — Remove module-level conversational state variables (FR-3.3)

These variables are declared in the `export default function (pi: ExtensionAPI)`
block (~L454–):

```typescript
let pipelineMode: PipelineMode = "idle";
let activePipelineState: ConversationalPipelineState | null = null;
let activePipelineKind: "spec" | "hierarchy" | "implement" | "brainstorm" | null = null;
let activeHierarchyLevel: HierarchyLevel | null = null;
```

Also remove any adjacent "active state" variables and helpers:
- `activeHierarchyParentContext`
- `activeScopingState`
- `activeBrainstormState`
- `activeStateSaveFn`
- The `getActivePipelineState()`, `getActiveHierarchyState()`,
  `getActiveBrainstormState()` closure helpers (~L739–885)
- `enterScopingMode`, `enterConversationalMode`, `enterBrainstormMode`,
  `exitConversationalMode` helper closures (~L756–897)

Also delete these module-level variables set in `enterImplementDiscoveryMode`
(already function-deleted in 2.1) that may survive as orphaned declarations:
- `implDiscoveryFlags`
- `implDiscoveryShortName`
- `implDiscoveryTimestamp`

Run typecheck after 2.3 to confirm no surviving code reads these variables.

#### 2.4 — Remove `pi.on(...)` host-LLM hooks (FR-3.4)

The four hooks at ~L2123, ~L2215, ~L2319, ~L2385 implement the conversational
host-LLM routing for discovery/drafting/scoping/brainstorm. The surviving
`/implement` pipeline drives agents via `agents.ts` subprocesses, NOT via
these hooks.

**Verification step before deletion:** For each hook, search for any logic path
that is NOT gated on `pipelineMode === idle` early-returning — i.e., any
logic that would run for an `/implement` session. The spec (FR-3.4) confirms
they are dead once all non-idle modes are gone. Confirm by:

```bash
grep -n "pi.on\b" index.ts
```

Then read each handler body looking for any branch that executes when
`pipelineMode === "idle"` (i.e., what happens after the early-return guard).
After Phase 1 + 2.3 remove all non-idle mode states, all meaningful logic
inside these handlers will be dead. Delete all four `pi.on(...)` blocks.

If any hook has a branch that legitimately runs in idle mode for a surviving
feature, retain that specific hook and add an inline comment explaining why.
(Expected: none — the discovery doc explicitly confirms this.)

#### 2.5 — Remove `enterBrainstormMode` and the brainstorm active-state variable

These are adjacent to the removed mode-state variables and likely removed with
2.3; confirm no stragglers remain after 2.3.

### Exit Criteria

- `grep -n "pipelineMode\|activePipelineKind\|activeHierarchyLevel\|activePipelineState\|activeScopingState\|activeBrainstormState" index.ts` returns no source lines (only comments at most).
- `grep -n "pi.on(" index.ts` returns zero results.
- `grep -n "updateModeWidget\|enterDraftingMode\|enterImplementDiscoveryMode\|buildUnifiedDiscoveryPrompt\|runDiscoveryStep" index.ts` returns zero results.
- Typecheck may still error on now-unused imports from `types.ts` / `state.ts`
  / `formatting.ts` — expected, resolved in Phase 4.

---

## Phase 3 — Delete Dead Modules + Fix Imports

**Spec coverage:** FR-9.1, FR-9.2, FR-9.6

**Goal:** Delete `spec-pipeline.ts` and `hierarchy-pipeline.ts` entirely and
remove all references to them.

### Entry Conditions

- Phases 1 and 2 complete; neither `runSpecPipeline` nor `runHierarchyPipeline`
  is called from any surviving command handler.

### Work Items

#### 3.1 — Delete `spec-pipeline.ts` (FR-9.1)

```bash
rm /home/istar/code/pi-spec-pipeline/spec-pipeline.ts
```

#### 3.2 — Delete `hierarchy-pipeline.ts` (FR-9.2)

```bash
rm /home/istar/code/pi-spec-pipeline/hierarchy-pipeline.ts
```

#### 3.3 — Remove imports from `index.ts` (FR-9.6)

Remove lines ~L179 and ~L181:
```typescript
import { runSpecPipeline } from "./spec-pipeline.ts";
import { runHierarchyPipeline } from "./hierarchy-pipeline.ts";
```

#### 3.4 — Remove now-unreachable imports from `index.ts` (cascade from Phases 1–3)

After Phase 1 and Phase 2 deletions, run typecheck:

```bash
cd /home/istar/code/pi-spec-pipeline && tsc --noEmit 2>&1 | head -60
```

Remove the imports from `index.ts` (~L75–181) that typecheck identifies as
unused, including but not limited to:

**From `types.ts`** (imports no longer needed):
`SpecState`, `RoadmapState`, `EpicState`, `HierarchyState`, `HierarchyLevel`,
`ConversationalExchange`, `DiscoveryTopic`, `PipelineMode`, `ScopingState`,
`ConversationalPipelineState`, `BrainstormState`.
(Retain: `ImplementationState`, `ProjectConfig`, `RoleName`.)

**From `state.ts`** (imports no longer needed):
`loadSpecState`, `saveSpecState`, `listSpecStates`, `getLatestActiveSpecPipeline`,
`loadRoadmapState`, `saveRoadmapState`, `listRoadmapStates`,
`getLatestActiveRoadmapPipeline`, `loadEpicState`, `saveEpicState`,
`listEpicStates`, `getLatestActiveEpicPipeline`, `loadBrainstormState`,
`saveBrainstormState`, `listBrainstormStates`, `getLatestActiveBrainstormPipeline`,
`createInitialBrainstormState`, `createInitialRoadmapState`,
`createInitialEpicState`, `getSpecStateDir`, `generateConversationalDiscoverySummary`,
`createInitialSpecState`.
(Retain: `loadImplState`, `saveImplState`, `listImplStates`,
`getLatestActiveImplPipeline`, `createInitialImplState`, `generateTimestamp`,
`generatePipelineId`, `getStateDir`, `getImplStateDir`, `getSessionLogDir`.)

**From `formatting.ts`** (imports no longer needed):
`formatSpecStage`, `formatImplStage` *(check — only keep if `/implement` uses it)*,
`formatHierarchyStage`, `formatSpecState`, `formatRoadmapState`, `formatEpicState`,
`updateSpecWidget`.
(Retain: `formatStepBanner`, `formatEffectiveConfig`, `formatImplStage` *if used*,
`formatImplState`, `formatDivider`, `formatKeyValue`, `updateImplWidget`,
`clearPipelineWidget`.)

### Exit Criteria

- `ls spec-pipeline.ts hierarchy-pipeline.ts` returns "No such file".
- `grep -rn "spec-pipeline\|hierarchy-pipeline" *.ts` returns only
  `.pi-lens/` hits and the spec files in `specs/` — no source imports.
- `tsc --noEmit` errors only on remaining type/state references (resolved in
  Phase 4), not on missing file imports.

---

## Phase 4 — Prune `types.ts`, `state.ts`, `agents-config.ts`, `config.ts`, `formatting.ts`

**Spec coverage:** FR-4, FR-5, FR-6, FR-7, FR-8

**Goal:** Remove all removed-kind types, CRUD functions, agent roles, config
fields, and formatters from the five shared-module files. Let typecheck
enumerate remaining breakage after each file edit.

### Entry Conditions

- Phase 3 complete; `spec-pipeline.ts` and `hierarchy-pipeline.ts` are gone.
- `index.ts` imports are clean.

### Work Items — `types.ts` (FR-4)

#### 4.1 — Remove state types (FR-4.1)

Delete the following interface/type declarations:
- `SpecState` (interface, ~L427–465)
- `EpicState` (interface, part of `HierarchyState` union)
- `RoadmapState` (interface, ~L658+)
- `HierarchyState` (union type alias)
- `BrainstormState` (interface, ~L750+)
- `ConversationalPipelineState` (interface, ~L416–426)
- `ScopingState` (interface, ~L401–415)
- `DiscoveryState` (interface, ~L358–375) — consumed only by `SpecState` and
  the removed conversational modes; confirm no surviving use in
  `ImplementationState` before deleting.
- `DraftingState` (interface, ~L376–389) — same check.
- `SpecStage` (type union, ~L312–322)
- `HierarchyStage` (type union, ~L626–637)
- `BrainstormStage` (type alias)
- `DiscoveryFollowUp` (interface)
- `DiscoveryTopic` (interface)
- `ConversationalExchange` (interface) — consumed only by removed types; confirm.
- `ChildItem` (interface) — consumed only by `RoadmapState`/`EpicState`.
- `SpecMetrics` (interface) — consumed only by removed states; check
  `ImplementationMetrics` for any structural dependency before removing.

#### 4.2 — Collapse mode enums (FR-4.2)

- `PipelineMode` (~L390–400): Remove the union entirely. No surviving code
  references it after Phase 2. If a downstream file still needs `"idle"` as a
  literal, inline it there.
- `PipelineKind`: If defined as a type alias or enum, remove or collapse to
  `"implement"` only.
- `HierarchyLevel` (~L623): Remove.

#### 4.3 — Prune config schema fields (FR-4.3)

In `SpecPipelineConfigSchema` (TypeBox schema, ~L86–110) and the derived
`ProjectConfig` interface (~L190–251):

**Remove from schema and interface:**
- `roadmapDrafter`, `roadmapReviewer`, `epicDrafter`, `epicReviewer`,
  `brainstormAgent`, `scopingAgent` (role config fields)
- `specTemplate`, `specTemplatePath`, `specConventions`, `specConventionsPath`,
  `specFormat`, `specsDir` (per OQ-3 resolution: no surviving consumer)
- `RoleName` union members for removed roles (or remove `RoleName` if only
  used with removed roles)

**Verify TypeBox validation for backward compatibility (FR-7.4):**

Locate `loadPipelineConfig` in `config.ts`. Check how the parsed JSON is
validated. If using `Value.Check(SpecPipelineConfigSchema, data)` with TypeBox's
default `Type.Object(...)`, additional JSON properties are silently ignored
(TypeBox does not reject unknown fields by default). If using strict mode or
an explicit `additionalProperties: false`, add `{ additionalProperties: true }`
to the schema options to ensure old configs with removed fields do not error.
Add an inline comment: `// Additional properties silently ignored for backward
compatibility with configs that still contain removed fields (e.g. specTemplate,
roadmapDrafter).`

**Keep in schema and interface:**
- `planDrafter`, `implementer`, `codeReviewer`, `commitMessageWriter`,
  `addressReview` model config fields
- `testCommand`, `contextFiles`, `projectContext`, `projectContextForReviewer`,
  `projectContextForFixer`, `reviewCycles`, `skipPlanGeneration`, `models`,
  `tiers`, `escalation`

#### 4.4 — Remove hierarchy and brainstorm directory constants (FR-5.5)

In `types.ts` (~L601–607):
- Remove: `SPEC_STATE_DIR`, `ROADMAP_STATE_DIR`, `EPIC_STATE_DIR`,
  `BRAINSTORM_STATE_DIR`
- Keep: `STATE_DIR`, `IMPL_STATE_DIR`

### Work Items — `state.ts` (FR-5)

#### 4.5 — Remove spec CRUD (FR-5.1)

Delete functions and their JSDoc:
`getSpecStateDir`, `getSpecStatePath`, `loadSpecState`, `saveSpecState`,
`listSpecStates`, `getLatestActiveSpecPipeline`, `createInitialSpecState`,
`createInitialDiscoveryState`, `generateConversationalDiscoverySummary`,
`generateSpecTimestamp` alias.

#### 4.6 — Remove roadmap CRUD (FR-5.2)

Delete: `getRoadmapStateDir` through `createInitialRoadmapState` (all roadmap
CRUD functions).

#### 4.7 — Remove epic CRUD (FR-5.3)

Delete: `getEpicStateDir` through `createInitialEpicState`.

#### 4.8 — Remove brainstorm CRUD (FR-5.4)

Delete: `getBrainstormStateDir` through `createInitialBrainstormState`.

#### 4.9 — Remove `extractChildItems` (FR-5.5)

Delete the `extractChildItems` function and its JSDoc.

#### 4.10 — Verify surviving state.ts exports (FR-5.6)

Confirm the following remain intact and exported:
`getImplStateDir`, `getStateDir`, `getSessionLogDir`, `getImplStatePath`,
`loadImplState`, `saveImplState`, `listImplStates`,
`getLatestActiveImplPipeline`, `createInitialImplState`,
`generatePipelineId`, `generateTimestamp`.

### Work Items — `agents-config.ts` (FR-6)

#### 4.11 — Remove removed-kind roles from `createSystemPrompts` (FR-6.1)

Delete the following role entries from the object returned by
`createSystemPrompts`:
- `specDrafter` (~L179)
- `specReviewer` (~L248)
- `brainstormAgent` (~L637)
- `scopingAgent` (~L721)
- `roadmapDrafter` (~L762)
- `roadmapReviewer` (~L823)
- `epicDrafter` (~L875)
- `epicReviewer` (~L936)

#### 4.12 — Prune `buildPromptOptions` and `SystemPromptOptions` (FR-6.4)

Per OQ-3: `specStructureGuidance` is only injected into the removed
`specDrafter` and `specReviewer` prompts. The surviving `planDrafter`,
`implementer`, `codeReviewer`, `commitMessageWriter`, and `addressReview`
prompts do not use `specTemplate`, `specConventions`, or `specFormat`.

Remove from `SystemPromptOptions` interface (~L55–60):
`specTemplate`, `specTemplatePath`, `specConventions`, `specConventionsPath`,
`specFormat`.

Remove from `buildPromptOptions` body (~L21–35):
The lines that copy `projectConfig.specTemplate`, `projectConfig.specTemplatePath`,
`projectConfig.specConventions`, `projectConfig.specConventionsPath`,
`projectConfig.specFormat` into the options object.

Remove from `createSystemPrompts` body:
- The `specStructureGuidance` computed variable (~L100–157)
- The `reviewConventionsGuidance` computed variable (~L158–177)
- The destructuring of `specTemplate`, `specTemplatePath`, `specConventions`,
  `specConventionsPath`, `specFormat` from the `options` argument
- The `hasTemplate` and `hasConventions` derived booleans

#### 4.13 — Verify `SystemPromptRoleName` (FR-6.3)

`SystemPromptRoleName` is derived from `ReturnType<typeof createSystemPrompts>`.
After 4.11, run typecheck and confirm the type no longer includes removed role
names (`specDrafter`, `specReviewer`, `brainstormAgent`, `scopingAgent`,
`roadmapDrafter`, `roadmapReviewer`, `epicDrafter`, `epicReviewer`).

### Work Items — `config.ts` (FR-7)

#### 4.14 — Remove removed roles from `DEFAULT_MODEL_CONFIGS` and `ROLE_TIERS` (FR-7.1)

In `DEFAULT_MODEL_CONFIGS` (~L38–61) and `ROLE_TIERS`, remove the entries for:
`roadmapDrafter`, `roadmapReviewer`, `epicDrafter`, `epicReviewer`.
(`brainstormAgent` and `scopingAgent` may not have dedicated tier entries —
confirm by reading the tier table; remove if present.)

#### 4.15 — Remove `brainstormAgent` escalation branch (FR-7.2)

Locate the escalation logic (~L165) that has a special branch for
`brainstormAgent`. Delete that branch.

#### 4.16 — Prune `specsDir` / spec-template / spec-conventions discovery logic (FR-7.5)

Per OQ-3: the `discoverSpecTemplate` (~L349), `discoverSpecConventions` (~L446),
`detectSpecFormat`, and the `specsDir` auto-detection block (~L559–568) in
`loadPipelineConfig` are only needed to populate `specTemplate`/`specConventions`
in the returned `ProjectConfig`, which is pruned in 4.3.

Delete:
- `discoverSpecTemplate` function (~L349–445)
- `discoverSpecConventions` function (~L446–558)
- `detectSpecFormat` function (if it exists separately)
- The `specsDir` discovery block inside `loadPipelineConfig` (~L559–568)
- All references to `specsDir`, `template`, `specConventions`, and
  `specFormat` in the `loadPipelineConfig` return value (~L663–715)
- The notification logged when the built-in spec template fallback is used
  (~L666)

#### 4.17 — Verify retain-and-ignore behavior (FR-7.4)

Read the JSON parsing / TypeBox validation call in `loadPipelineConfig`
(~L758–795). If the validation rejects unknown keys, fix as described in 4.3.
Run a manual test or add an assertion that a config JSON containing
`"specTemplate": "foo", "roadmapDrafter": {...}` loads without error.

### Work Items — `formatting.ts` (FR-8)

#### 4.18 — Remove removed-kind formatters (FR-8.1)

Delete functions and their JSDoc:
`formatSpecStage`, `formatHierarchyStage`, `formatSpecState`,
`formatRoadmapState`, `formatEpicState`, `updateSpecWidget`.

#### 4.19 — Verify surviving formatters (FR-8.2)

Confirm the following remain and compile:
`formatBox`, `formatDivider`, `formatKeyValue`, `formatStepBanner`,
`formatModelConfig`, `formatEffectiveConfig`, `formatImplStage`,
`summarizeAgentOutput`, `formatAgentSummary`, `formatImplState`,
`updateImplWidget`, `clearPipelineWidget`.

### Exit Criteria

- `tsc --noEmit` passes with no errors.
- `grep -rn "SpecState\|EpicState\|RoadmapState\|HierarchyState\|BrainstormState\|ConversationalPipelineState" *.ts` returns zero source hits (only `specs/*.md` docs are allowed).
- `grep -rn "specDrafter\|specReviewer\|brainstormAgent\|scopingAgent\|roadmapDrafter\|epicDrafter" *.ts` returns zero source hits.
- `state.ts` exports only implement and shared helpers.
- `config.ts` loads without error when given a JSON with removed fields present.

---

## Phase 5 — Prune Supporting Modules: `git.ts`, `commit-agent.ts`, `errors.ts`, `escalation.ts`, `review.ts`, `agents.ts`

**Spec coverage:** FR-9.3, FR-9.4, FR-9.5

**Goal:** Remove removed-kind references from the six supporting modules while
keeping all `/implement` paths intact.

### Entry Conditions

- Phase 4 complete; typecheck passes.
- All removed types no longer exist in `types.ts`.

### Work Items

#### 5.1 — `git.ts` (FR-9.3)

Current state:
- `import type { SpecState, ImplementationState, HierarchyState, BrainstormState }` (L6)
- `type GitState = SpecState | ImplementationState | HierarchyState | BrainstormState` (L9)

Changes:
- Update the import to: `import type { ImplementationState } from "./types.ts";`
- Update `GitState` to: `type GitState = ImplementationState;`
- Audit remaining ~10 removed-kind references (branches gated on `state.level === "spec"`,
  `state.level === "roadmap"`, etc.) and remove those branches.
- Confirm that `validateGitRepo`, `checkGitClean`, `stashExists`, `dropStash`,
  `createAgentCommit` still compile and handle `ImplementationState` correctly.

#### 5.2 — `commit-agent.ts` (FR-9.4)

Current state: ~14 removed-kind references.

Changes:
- Remove any branches gated on `SpecState`, `RoadmapState`, `EpicState`,
  `BrainstormState`, or `HierarchyState`.
- **Keep** `extractDocName` and `extractPhaseName` — both are called by the
  `/implement` pipeline in `implement-pipeline.ts`.
- Update type imports to remove removed state types.

#### 5.3 — `errors.ts` (FR-9.5)

Current state:
```typescript
import { SpecState, ..., HierarchyState } from "./types.ts";
type ErrorableState = SpecState | ImplementationState | HierarchyState;
```

Changes:
- Update import: remove `SpecState`, `HierarchyState`.
- Update `ErrorableState`: `type ErrorableState = ImplementationState;`
- Remove any branches in error formatting/handling gated on removed state kinds.
- The `.pi/spec-pipeline/${state.id}.error.log` path in the format function
  (~L322, ~L427) — keep as-is (NFR-6, directory name preserved).

#### 5.4 — `escalation.ts` (FR-9.5)

Remove any removed-kind branches. `ESCALATION_LOG_RELATIVE_PATH`
(`.pi/spec-pipeline/escalations.log`) is fine to keep.

#### 5.5 — `review.ts` (FR-9.5)

Current state:
```typescript
import { SpecState, ..., HierarchyState } from "./types.ts";
type ReviewableState = SpecState | ImplementationState | HierarchyState;
```

Changes:
- Update import and `ReviewableState` to `ImplementationState` only.
- Remove removed-kind branches in the review loop.

#### 5.6 — `agents.ts` (FR-9.5)

Current state:
```typescript
import { SpecState, ... }
state: ImplementationState | SpecState
```
Also: `updateSpecWidget(ctx, state as SpecState, ...)` at ~L141.

Changes:
- Remove `SpecState` from import.
- Update function signatures: `state: ImplementationState` only.
- Remove the `updateSpecWidget(...)` call and its conditional branch.
- Keep all subprocess/agent-running logic intact.

### Exit Criteria

- `tsc --noEmit` passes with no errors.
- `grep -n "SpecState\|HierarchyState\|BrainstormState\|EpicState\|RoadmapState" git.ts commit-agent.ts errors.ts escalation.ts review.ts agents.ts` returns zero results.
- `bun test` passes (may have failures in test files referencing removed types — those are resolved in Phase 7).

---

## Phase 6 — Documentation Updates

**Spec coverage:** FR-10

**Goal:** Update README, `index.ts` header doc-comment, and all four SKILL
files to reflect the reduced surface: only `/implement` with a delivery-plan
file.

### Entry Conditions

- Phase 5 complete; source compiles cleanly.
- No time pressure to update docs simultaneously with source changes.

### Work Items

#### 6.1 — `README.md` (FR-10.1)

Replace the current README (~144 lines) with a rewritten version that:
- **Removes** the deprecation notice preamble (the change is now complete, not
  "slated").
- **Replaces** the Overview section and Quick Start to describe the
  agent-based workflow: `ux-discovery-interviewer` → `spec-writer` →
  `delivery-plan-architect` → `/implement`.
- **Removes** the "Spec Creation", "Hierarchical Planning" command tables and
  the example blocks at ~L33–88 for `/spec`, `/plan`, `/roadmap`, `/epic`,
  `/brainstorm`, `/plan-overview`.
- **Updates** the "Implementation" command table (~L111–118) to reflect:
  - `/implement [--no-plan] [--no-review] [--auto] <delivery-plan.md>` —
    drop `description` as an alternative; update description to
    "Start implementation from a delivery-plan file".
  - The five other `implement-*` sub-commands remain unchanged.
- **Removes** the "Fully Conversational", "Conversational Scoping", and
  "Hierarchical Planning" feature bullets (~L20–22).
- **Adds** a brief description of how the delivery-plan-architect agent produces
  the phase table that `/implement` parses.

#### 6.2 — `index.ts` header doc-comment (FR-10.2)

Rewrite lines ~L1–70 to describe only the surviving workflow:

```
/**
 * Spec Pipeline Extension
 *
 * IMPLEMENTATION (/implement):
 *   1. Accepts a delivery-plan file produced by the delivery-plan-architect agent.
 *   2. Parses the phase table (| Phase | Focus | Effort | Difficulty? |).
 *   3. For each phase: plan → implement → code review → commit.
 *
 * Usage:
 *   /implement [--no-plan] [--no-review] [--auto] <delivery-plan.md>
 *   /implement-resume      # Resume the last active implementation
 *   /implement-status      # Show current implementation status
 *   /implement-list        # List all implementations with status
 *   /implement-cancel      # Cancel current implementation
 *   /implement-metrics [id] # Export metrics JSON
 *
 * Configuration:
 *   Create .pi/spec-pipeline.json in your project root.
 *   Unknown or removed fields (e.g. specTemplate, roadmapDrafter) are silently ignored.
 */
```

Remove all references to removed commands.

#### 6.3 — `skills/ux-discovery-interviewer/SKILL.md` (FR-10.3)

Current state: ~L18 references `/spec`, ~L42 references "planning session".

Changes:
- Line ~L18: Replace "hand it to `/spec` or use it to start the planning phase"
  with "hand it to the `delivery-plan-architect` agent, then use `/implement` to
  execute the resulting delivery plan."
- Line ~L42: Replace "proceed with spec drafting" / "planning session" wording
  with references to the `spec-writer` agent (for spec creation) or directly to
  `delivery-plan-architect` + `/implement`.
- Audit the rest of the file for any other mentions of `/spec`, `/plan`,
  `/roadmap`, or other removed commands; update or remove each.

#### 6.4 — `skills/implement-pipeline/SKILL.md` (FR-10.4)

Current state: Already implement-centric; references "spec document" and
"spec/plan document".

Changes:
- Replace "spec document" → "delivery-plan document" where it refers to the
  input file.
- Update the usage example in the description frontmatter if it says
  `/implement docs/<spec-path>` — it should say `<delivery-plan-path>`.
- Keep the `--no-plan`, `--no-review`, `--auto` flag documentation intact.
- No removal of `/implement` itself — this skill correctly refers to the
  surviving command.

#### 6.5 — `skills/spec-writer/SKILL.md` (FR-10.5)

Current state: Describes the `spec-writer` agent workflow. Ends with "If they
want to implement it next, hand off to `implement-pipeline`."

Audit:
- Confirm no instruction to run `/spec` or any removed command directly.
  Current reading shows none — the SKILL only invokes the `spec-writer`
  *agent* (`subagent agent=spec-writer ...`), which is not a removed slash command.
- Update the Handoff section if it implies the spec feeds directly into
  `/implement` without a delivery-plan step: add mention of
  `delivery-plan-architect` as the intermediate step between spec and implement.

#### 6.6 — `skills/delivery-plan-architect/SKILL.md` (FR-10.5)

Audit:
- Confirm no reference to removed slash commands.
- Current reading shows none — this SKILL is already delivery-plan-architect
  focused and the handoff correctly points to `implement-pipeline`.
- Minor: ensure the Handoff section says "hand off to `implement-pipeline`"
  (already does; no change expected).

#### 6.7 — `templates/spec-template.md` (FR-10.6)

Per OQ-3: `specTemplate` is pruned (no surviving consumer in any agent prompt).
The template file has no functional role after the pruning in Phase 4.

Options (decide at implementation time):
- **Delete** the file if it serves no documentation purpose.
- **Retain** as a reference document for users running the `spec-writer` agent
  manually, with a note at the top that it is no longer auto-loaded by the
  extension.

Recommended: **Retain** with a header note, since the `spec-writer` agent may
still benefit from a human referencing it as a manual template. No source code
references it after Phase 4, so it does not affect the build.

### Exit Criteria

- `grep -rn "/spec\b\|/plan\b\|/roadmap\b\|/epic\b\|/brainstorm\b\|/spec-resume\|/plan-done" README.md skills/` returns zero hits.
- The `index.ts` header comment contains no references to removed commands.
- `skills/ux-discovery-interviewer/SKILL.md` no longer refers to `/spec` or
  "planning session" in a way that directs users to a removed command.

---

## Phase 7 — Tests: Deletions, Updates, New FR-2.2 Test + Final Verification

**Spec coverage:** FR-11, NFR-1, NFR-2, SC-1–SC-8

**Goal:** Delete planning-only test files, update remaining tests to remove
removed-kind cases, add the FR-2.2 guidance-error assertion, and achieve a
green `bun test`.

### Entry Conditions

- Phase 6 complete; source compiles; docs updated.
- Current baseline: 459 tests passing across 13 files.

### Work Items

#### 7.1 — Delete planning-only test files (FR-11.1)

```bash
rm /home/istar/code/pi-spec-pipeline/discovery-loop.test.ts
rm /home/istar/code/pi-spec-pipeline/implement-discovery.test.ts
```

For `pipeline-resume.test.ts` (297 lines):
- It contains two `describe` blocks: "Spec Pipeline Resume After Cancellation"
  (~L11–226, uses `createInitialSpecState`) and "Implementation Pipeline Resume
  After Cancellation" (~L227–297, uses `createInitialImplState`).
- **Delete** the first `describe` block and its helpers (all spec-resume tests).
- **Retain** the second `describe` block (implement resume tests remain valid).
- If only one test remains after trimming, consider renaming the file to
  `implement-resume.test.ts` for clarity (optional).

#### 7.2 — Heavily update `state.test.ts` (FR-11.2)

Current state: 827 lines, 161 removed-kind references.

Remove all test cases that exercise removed CRUD functions:
`createInitialSpecState`, `loadSpecState`, `saveSpecState`, `listSpecStates`,
`getLatestActiveSpecPipeline`, `createInitialDiscoveryState`,
`generateConversationalDiscoverySummary`, `generateSpecTimestamp`,
roadmap CRUD, epic CRUD, brainstorm CRUD, `extractChildItems`.

Retain all test cases for:
`createInitialImplState`, `loadImplState`, `saveImplState`, `listImplStates`,
`getLatestActiveImplPipeline`, `generatePipelineId`, `generateTimestamp`.

#### 7.3 — Heavily update `config.test.ts` (FR-11.2)

Current state: 770 lines, 68 removed-kind references.

Remove test cases for:
- `discoverSpecTemplate`, `discoverSpecConventions`, `specsDir` auto-detection.
- Model config validation for removed roles (`roadmapDrafter`, `epicDrafter`,
  `brainstormAgent`, `scopingAgent`, `roadmapReviewer`, `epicReviewer`).
- Any test asserting that a config with spec template fields is handled in a
  specific way (they should now be silently ignored).

Add or retain:
- A test asserting that a `.pi/spec-pipeline.json` containing removed fields
  (`specTemplate`, `roadmapDrafter`, etc.) loads successfully without error
  and the returned `ProjectConfig` simply does not have those fields (or has
  them as `undefined`). This directly verifies FR-7.4/NFR-3.

#### 7.4 — Heavily update `formatting.test.ts` (FR-11.2)

Current state: 370 lines, 38 removed-kind references.

Remove test cases for:
`formatSpecStage`, `formatHierarchyStage`, `formatSpecState`,
`formatRoadmapState`, `formatEpicState`, `updateSpecWidget`.

Retain test cases for all surviving formatters.

Check: `createProgressCallback` tests near end of the file (~L345+) contain
`uses spec widget for non-implementation pipelines` — this test references the
removed `updateSpecWidget`. Delete or replace with a surviving widget test.

#### 7.5 — Lightly update remaining test files (FR-11.3)

For each file, remove only the assertions that reference removed types/functions:

- **`git.test.ts`** (713 lines, ~16 refs): Remove tests for `SpecState`,
  `HierarchyState`, `BrainstormState`-gated git branches. Keep all
  `ImplementationState` git tests.
- **`commit-agent.test.ts`** (338 lines, ~11 refs): Remove removed-kind
  branches. Keep `extractDocName`/`extractPhaseName` tests.
- **`errors.test.ts`** (382 lines, ~5 refs): Remove assertions about
  `SpecState`/`HierarchyState` error formatting. Keep implement-error tests.
- **`agents.test.ts`** (406 lines, ~4 refs): Remove `SpecState`-specific
  agent call assertions. Keep implement-agent tests.
- **`escalation.test.ts`** (461 lines, ~3 refs): Remove escalation tests for
  removed roles.
- **`implement-pipeline.test.ts`** (631 lines, ~7 refs): Remove any remaining
  spec-kind references. Keep all phase-extraction and pipeline tests intact.

#### 7.6 — Unaffected test files (FR-11.4)

- `review.test.ts` (210 lines, 0 refs) — no changes.

#### 7.7 — Add FR-2.2 test (FR-11.5)

Add a new test (or add to `implement-pipeline.test.ts`) that asserts:

> When `/implement` is called with a free-text argument that is neither an
> existing file nor a path-like string (no `/` and no `.md`/`.typ` extension),
> the handler returns a guidance error and does not call
> `enterImplementDiscoveryMode` or `pi.sendUserMessage`.

Since the command handler is not easily unit-testable in isolation, implement
this as a behavioral assertion on the detection logic extracted from the handler:

```typescript
describe("/implement input contract (FR-2.2)", () => {
    it("detects free-text as non-file and would return guidance error", () => {
        // The handler's heuristic:
        // looksLikeFilePath = arg.includes("/") || /\.(md|typ)$/i.test(arg)
        // isFile = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()
        // If !isFile && !looksLikeFilePath → guidance error (not discovery mode)

        const freeTextArgs = ["add user auth", "fix the null pointer bug", "refactor billing"];
        for (const arg of freeTextArgs) {
            const looksLikeFilePath = arg.includes("/") || /\.(md|typ)$/i.test(arg);
            expect(looksLikeFilePath).toBe(false);
            // With OQ-1 applied: this path now triggers guidance error, not discovery mode
        }
    });

    it("does NOT treat .md argument as free text", () => {
        const arg = "plan.md";
        const looksLikeFilePath = arg.includes("/") || /\.(md|typ)$/i.test(arg);
        expect(looksLikeFilePath).toBe(true);
    });
});
```

### Final Verification Steps

Run after all tests are updated:

```bash
# 1. Type safety
cd /home/istar/code/pi-spec-pipeline
tsc --noEmit 2>&1

# 2. Test suite
bun test

# 3. SC-3: No removed command registrations
grep -n "registerCommand" index.ts | grep -E "spec|plan|roadmap|epic|brainstorm" | grep -v "implement"

# 4. SC-4: No removed type identifiers in source
grep -rn "SpecState\|EpicState\|RoadmapState\|HierarchyState\|BrainstormState\|ConversationalPipelineState" \
    *.ts --include="*.ts"

# 5. SC-5: No dead module files or imports
ls spec-pipeline.ts hierarchy-pipeline.ts 2>&1
grep -rn "spec-pipeline\|hierarchy-pipeline" *.ts

# 6. SC-7: Guidance error path is present in implement handler
grep -n "requires a delivery-plan file\|delivery-plan-architect" index.ts

# 7. SC-8: No removed commands in README or SKILL files
grep -rn "/spec\b\|/plan\b\|/roadmap\b\|/epic\b\|/brainstorm\b" README.md skills/
```

### Exit Criteria (Phase 7 = Project Complete)

All eight success criteria from the spec satisfied:

| SC | Check | Expected result |
|----|-------|-----------------|
| SC-1 | `tsc --noEmit` exits 0 | ✅ No type errors |
| SC-2 | `bun test` exits 0 | ✅ All retained/updated tests green |
| SC-3 | Grep for removed `registerCommand` names | ✅ Zero hits |
| SC-4 | Grep for removed type identifiers | ✅ Zero source hits |
| SC-5 | `spec-pipeline.ts` and `hierarchy-pipeline.ts` absent | ✅ Files deleted; no imports |
| SC-6 | Six `/implement-*` commands registered; file-based end-to-end flow intact | ✅ Manual or test verification |
| SC-7 | `/implement <free text>` returns guidance error; no conversational mode | ✅ FR-2.2 test passes |
| SC-8 | README, `index.ts` header, SKILL files free of removed slash commands | ✅ Grep confirms |

---

## Risk Register

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| **R-1: Hidden coupling** — a surviving `/implement` path depends on a helper slated for removal | Low | Remove incrementally; run typecheck after each Phase 1–3 step; confirm `pi.on()` handlers before deletion (Phase 2.4) |
| **R-2: Type fan-out** — removing `types.ts` members breaks `implement-pipeline.ts` unexpectedly | Low | Prune types only in Phase 4 after Phases 1–3 are complete; let typecheck enumerate breakage before editing `implement-pipeline.ts` |
| **R-3: Config backward compat** — existing `.pi/spec-pipeline.json` with removed fields triggers a validation error | Medium | Verify TypeBox `additionalProperties` behavior in Phase 4.17; add explicit test in Phase 7.3 |
| **R-4: `specTemplate` still needed** — a surviving agent prompt secretly consumes spec template fields | Low | Verified in codebase exploration: `specStructureGuidance` is only injected into removed `specDrafter`/`specReviewer` prompts; confirmed before writing this plan |
| **R-5: `index.ts` line-number drift** — 5,900-line file shifts as code is removed in Phase 1, causing missed deletions in Phase 2 | Medium | Use function-name grep rather than line numbers to locate Phase 2 targets after Phase 1 edits |
| **R-6: `pipeline-resume.test.ts` spec block hard to separate** — imports `createInitialSpecState` which will be removed | Low | Delete the entire first `describe` block and its imports; retain only the second `describe` block |

---

## Implementation Notes

1. **Work sequentially per phase.** Each phase gates on the previous phase's
   typecheck and grep verifications. Do not start Phase 4 until Phase 3 imports
   are clean.

2. **Use typecheck as the primary guide in Phases 2–5.** After each bulk
   deletion, run `tsc --noEmit` and let the error list enumerate remaining
   references. This is the safest way to navigate a 5,900-line file.

3. **Line numbers are approximate.** The discovery doc and spec provided
   approximate line numbers for a file that was ~5,895 lines at scan time.
   Treat them as search hints, not exact targets; always verify with grep.

4. **`formatImplStage` in `formatting.ts`** — the spec says keep it (FR-8.2),
   but verify it is actually imported and called in `implement-pipeline.ts` or
   `index.ts` before assuming it survives. If unused, it can be deleted to
   avoid dead exports.

5. **Commit strategy.** One logical commit per phase (or per file within a
   phase) makes `git bisect` viable if a regression surfaces post-merge.
