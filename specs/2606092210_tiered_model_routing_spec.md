# Spec: Tiered Model Routing & Bounded Escalation for the /implement Pipeline

**Status**: approved
**Scope**: `/implement` pipeline only. The `/spec`, `/plan`, `/roadmap`, `/epic`, and
`/brainstorm` command families are slated for deprecation — do NOT modify their
behaviour. Shared code (`review.ts`) must remain backward compatible with them.

## Motivation

Split pipeline work into "thinking" (strong model) and "doing" (mid model) with
cheap models on mechanical edges. Concretely:

1. Plans are authored by a strong model and **written for a weaker reader**
   (explicit paths, signatures, error handling, do-nots).
2. Code review is a **strong-model verification pass**.
3. Implementation runs on a mid-tier model with **bounded retries**: hard
   failures escalate one tier instead of re-rolling; a second failed review
   cycle escalates the fixer ("mis-tiered task" signal).
4. **Difficulty routing**: phases the planner marks `hard` go straight to the
   strong tier.
5. **Every escalation is logged** so tiering can be tuned over time.

## Backward compatibility (hard requirements)

- **BC1**: With no `tiers` key in `.pi/spec-pipeline.json`, role model resolution
  must be byte-identical to today (explicit `models.<role>` → hardcoded
  `DEFAULT_MODEL_CONFIGS`).
- **BC2**: With no config file at all (the `$default` fallback), behaviour must be
  unchanged: no `--model`/`--thinking` flags, and **no escalation ever occurs**
  (escalation target resolution returns `undefined` for `$default` models).
- **BC3**: `runReview()` and `retryFailedOperation()` in `review.ts` are also called
  by the deprecated spec/hierarchy pipelines. All new parameters there MUST be
  optional, and behaviour with them absent must be unchanged.
- **BC4**: Do not rename or remove any existing config field, type, or exported
  function. Do not change existing state-file field semantics.
- **BC5**: All 413 existing tests must keep passing (`bun test`).

---

## Phase A — Foundation (types, config, escalation module, state)

**Difficulty**: standard. No behaviour change is observable after Phase A alone.

### R1. `types.ts` — schema & type additions

Insert after `ModelsConfigSchema` (around line 58):

```ts
// Model tiers: named capability levels that roles map onto (strong > mid > cheap).
export const TierNameSchema = Type.Union([
	Type.Literal("strong"),
	Type.Literal("mid"),
	Type.Literal("cheap"),
]);

export const TiersConfigSchema = Type.Object({
	strong: Type.Optional(ModelConfigSchema),
	mid: Type.Optional(ModelConfigSchema),
	cheap: Type.Optional(ModelConfigSchema),
});

// Escalation behaviour. `hardFailureRetries` is the number of retries allowed
// at the escalated tier after a hard failure (0 disables auto-retry).
export const EscalationConfigSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	hardFailureRetries: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
});
```

Add to `SpecPipelineConfigSchema` (after the `models` property):

```ts
	tiers: Type.Optional(TiersConfigSchema),
	escalation: Type.Optional(EscalationConfigSchema),
```

Add to the type exports section:

```ts
export type TierName = Static<typeof TierNameSchema>;
export type TiersConfig = Static<typeof TiersConfigSchema>;
export type EscalationConfig = Static<typeof EscalationConfigSchema>;
```

Add near `RoleName` (line ~234):

```ts
/** Why a role was escalated to a stronger model. */
export type EscalationReason =
	| "hard_failure" // agent run failed (non-zero exit, incomplete, limit hit, or failed validation)
	| "review_cycles" // a fix pass failed to earn approval — task likely mis-tiered
	| "difficulty_routing" // plan marked the phase `hard`; routed to strong tier up front
	| "resume_retry"; // /implement-resume retried a failed operation at a higher tier

export interface EscalationRecord {
	role: RoleName;
	phase?: number; // 1-indexed phase number
	cycle?: number; // review cycle, when applicable
	fromModel: string;
	toModel: string;
	reason: EscalationReason;
	timestamp: string; // ISO
}

/** Difficulty marker emitted by the planDrafter in each phase plan. */
export type PlanDifficulty = "standard" | "hard";
```

Add to `interface ImplementationState` (after `errorStash?`):

```ts
	// Escalation audit trail for this run (also appended to .pi/spec-pipeline/escalations.log)
	escalations?: EscalationRecord[];
```

Add to `interface ImplementationMetrics` an optional field:

```ts
	escalations?: number;
```

Add to `interface ProjectConfig` (after `models`):

```ts
	tiers?: TiersConfig;
	escalation: { enabled: boolean; hardFailureRetries: number };
```

### R2. `config.ts` — tier resolution & escalation target

**R2a.** Export a static role→tier map (place near `DEFAULT_MODEL_CONFIGS`):

```ts
/**
 * Which tier each role belongs to by default. The plan and the review are the
 * leverage points (strong); implementation/fixes are well-constrained (mid);
 * commit messages are mechanical (cheap).
 */
export const ROLE_TIERS: Record<string, TierName> = {
	planDrafter: "strong",
	implementer: "mid",
	codeReviewer: "strong",
	addressReview: "mid",
	agentCommitMessageWriter: "cheap",
	roadmapDrafter: "strong",
	roadmapReviewer: "strong",
	epicDrafter: "strong",
	epicReviewer: "strong",
};
```

**R2b.** Change `mergeWithDefaults` to accept the user `tiers` object and insert
tier resolution between explicit role config and hardcoded defaults. New
signature (keep parameter order; add `userTiers` after `userModels`):

```ts
function mergeWithDefaults(
	userModels: ModelsConfig | undefined,
	userTiers: TiersConfig | undefined,
	userReviewCycles: ReviewCyclesConfig | undefined,
	projectStreamIdleTimeoutMs: number | undefined,
): { models: ProjectConfig["models"]; reviewCycles: ProjectConfig["reviewCycles"] }
```

Resolution per role becomes (example for `implementer`; same pattern for all):

```ts
implementer:
	userModels?.implementer ??
	userTiers?.[ROLE_TIERS.implementer] ??
	DEFAULT_MODEL_CONFIGS.implementer,
```

For the hierarchy roles keep the existing two-level fallback, with the tier
lookup inserted after it, e.g.:

```ts
roadmapDrafter:
	userModels?.roadmapDrafter ??
	userModels?.planDrafter ??
	userTiers?.[ROLE_TIERS.roadmapDrafter] ??
	DEFAULT_MODEL_CONFIGS.roadmapDrafter,
```

The existing `streamIdleTimeoutMs` back-fill loop already runs after resolution
and therefore covers tier-resolved configs — do not change it. Update the call
site of `mergeWithDefaults` (in `buildProjectConfig`) to pass `config.tiers`.

**R2c.** Normalize escalation config. Add:

```ts
export const DEFAULT_ESCALATION = { enabled: true, hardFailureRetries: 1 } as const;

function normalizeEscalation(
	userEscalation: EscalationConfig | undefined,
): ProjectConfig["escalation"] {
	return {
		enabled: userEscalation?.enabled ?? DEFAULT_ESCALATION.enabled,
		hardFailureRetries:
			userEscalation?.hardFailureRetries ?? DEFAULT_ESCALATION.hardFailureRetries,
	};
}
```

In `buildProjectConfig`, set `tiers: config.tiers` and
`escalation: normalizeEscalation(config.escalation)` on the returned object.
In the **no-config-file fallback path** (the block that overwrites every role
with `{ model: "$default", thinking: "off" }` and sets `usingDefaultModels`),
ensure the ProjectConfig also carries `escalation: { enabled: true, hardFailureRetries: 1 }`
and `tiers: undefined`. (Escalation still no-ops there per R2d step 7.)

**R2d.** Export the escalation target resolver:

```ts
const TIER_LADDER: Record<TierName, TierName | undefined> = {
	cheap: "mid",
	mid: "strong",
	strong: undefined,
};

/**
 * Resolve the model config to escalate `role` to, or undefined when escalation
 * is impossible/pointless. Walks the tier ladder upward from the role's static
 * tier (ROLE_TIERS). When no `tiers` are configured, falls back to the
 * planDrafter config (by convention the strongest configured role) for
 * mid/cheap roles.
 */
export function getEscalatedModelConfig(
	projectConfig: ProjectConfig,
	role: RoleName,
): ModelConfig | undefined
```

Algorithm (implement exactly; return `undefined` at any failed step):

1. If `!projectConfig.escalation.enabled` → `undefined`.
2. Map `role` to a `projectConfig.models` key: `"commitMessageWriter"` →
   `"agentCommitMessageWriter"`; `"brainstormAgent"` → return `undefined`;
   otherwise the role name itself. Let `current = projectConfig.models[key]`;
   if missing → `undefined`.
3. `tier = ROLE_TIERS[key] ?? "mid"`.
4. Walk the ladder: `next = TIER_LADDER[tier]`; while `next` is defined, if
   `projectConfig.tiers?.[next]` exists take it as `candidate` and stop,
   else `next = TIER_LADDER[next]`.
5. If no candidate and `tier !== "strong"`: `candidate = projectConfig.models.planDrafter`.
6. If still no candidate → `undefined`.
7. If `candidate.model === "$default"` or `current.model === "$default"` → `undefined`.
8. If `candidate.model === current.model && candidate.thinking === current.thinking`
   → `undefined` (escalating to the same model is pointless).
9. Return `candidate`.

### R3. New file `escalation.ts`

Module header comment: "Bounded escalation: hard failures retry one tier up
instead of re-rolling the same model; every escalation is recorded."

**R3a.** Difficulty parsing:

```ts
/** Parse the planDrafter's difficulty marker. Defaults to "standard". */
export function parsePlanDifficulty(plan: string): PlanDifficulty
```

Match the FIRST occurrence of `Difficulty: <value>` with optional `**` bolding
on the label, case-insensitive: regex
`/(?:\*\*\s*)?Difficulty(?:\s*\*\*)?\s*:\s*(standard|hard)\b/i`.
Return `"hard"` only when the captured group is `hard` (case-insensitive),
otherwise `"standard"`.

**R3b.** Escalation recording:

```ts
export const ESCALATION_LOG_RELATIVE_PATH = ".pi/spec-pipeline/escalations.log";

/**
 * Record an escalation on the implementation state AND append a JSONL line to
 * the cross-run log. Logging must never throw — swallow fs errors.
 */
export function recordEscalation(
	cwd: string,
	state: ImplementationState,
	record: Omit<EscalationRecord, "timestamp">,
	save: () => void,
	notify?: (msg: string, type: "info" | "error" | "success" | "warning") => void,
): EscalationRecord
```

Behaviour:
1. Build the full record with `timestamp: new Date().toISOString()`.
2. `state.escalations ??= []`, push, `save()`.
3. Append `JSON.stringify({ pipelineId: state.id, specPath: state.specPath, ...full }) + "\n"`
   to `path.join(cwd, ESCALATION_LOG_RELATIVE_PATH)`; `fs.mkdirSync(dirname, { recursive: true })`
   first; wrap the whole fs block in try/catch and ignore errors.
4. `notify?.(`⬆️ Escalated ${record.role}: ${record.fromModel} → ${record.toModel} (${record.reason})`, "warning")`.
5. Return the full record.

**R3c.** Escalating agent runner:

```ts
export interface EscalatingAgentRun {
	result: AgentResult;
	config: ModelConfig; // the config of the FINAL attempt
	escalated: boolean; // true when the final attempt used escalatedConfig
	failureDescription?: string; // set when the final attempt still failed
}

export async function runAgentWithEscalation(opts: {
	baseConfig: ModelConfig;
	escalatedConfig?: ModelConfig; // from getEscalatedModelConfig(); undefined disables escalation
	maxEscalatedRetries: number; // projectConfig.escalation.hardFailureRetries
	role: RoleName;
	task: string;
	cwd: string;
	systemPrompt: string;
	signal?: AbortSignal;
	onOutput?: (event: AgentOutputEvent) => void;
	sessionDir?: string;
	/** Extra failure detection on a "successful" result (e.g. empty output). Return a description to treat as failure. */
	validate?: (result: AgentResult) => Promise<string | undefined> | string | undefined;
	/** Called after EVERY attempt — use to record per-attempt metrics with the attempt's config. */
	onAttempt?: (info: { config: ModelConfig; startTime: Date; result: AgentResult; attempt: number }) => void;
	/** Called ONCE, when transitioning from base to escalated config. */
	onEscalate?: (info: { fromModel: string; toModel: string }) => void;
	notify?: (msg: string, type: "info" | "error" | "success" | "warning") => void;
	/** Injectable for tests; defaults to runAgentWithConfig from agents.ts. */
	runner?: typeof runAgentWithConfig;
}): Promise<EscalatingAgentRun>
```

Behaviour (implement exactly):

1. `totalAttempts = 1 + (opts.escalatedConfig ? Math.max(0, opts.maxEscalatedRetries) : 0)`.
2. For `attempt` in `1..totalAttempts`:
   a. `config = attempt === 1 ? baseConfig : escalatedConfig`.
   b. `startTime = new Date()`; run
      `runner(config, task, cwd, systemPrompt, signal, onOutput, role, sessionDir)`.
   c. `onAttempt?.({ config, startTime, result, attempt })`.
   d. Failure check: hard failure when `result.exitCode !== 0 || result.completed === false || result.limitHit`;
      set `failureDescription = result.error ?? "agent run failed (exit ${exitCode})"`.
      Otherwise, if `validate` is provided, `failureDescription = await validate(result)`
      (undefined means success).
   e. No failure → return `{ result, config, escalated: attempt > 1 }`.
   f. Failure with attempts remaining: if `attempt === 1` call
      `onEscalate?.({ fromModel: baseConfig.model, toModel: escalatedConfig.model })` and
      `notify?.(`⬆️ ${role} failed (${failureDescription}) — retrying with ${escalatedConfig.model}`, "warning")`.
      Continue loop.
3. After the loop return the LAST attempt's
   `{ result, config, escalated: totalAttempts > 1, failureDescription }`.

Import `runAgentWithConfig` from `./agents.ts` as the default `runner`.

### R4. `state.ts` — migration

In `loadImplState`, follow the existing `checkpoints` migration pattern: if
`state.escalations` is missing, set it to `[]` and mark `needsSave = true`.

### R5. Phase A tests

**R5a.** New file `escalation.test.ts` covering:
- `parsePlanDifficulty`: `**Difficulty**: hard` → hard; `Difficulty: hard` → hard;
  `difficulty: HARD` → hard; `**Difficulty**: standard` → standard; absent marker →
  standard; marker inside a larger plan document → detected.
- `recordEscalation` (use `fs.mkdtempSync(path.join(os.tmpdir(), ...))` as cwd):
  pushes onto `state.escalations` (including when initially undefined), calls
  `save`, appends a parseable JSONL line containing `pipelineId`, `specPath`,
  `role`, `fromModel`, `toModel`, `reason`, `timestamp`; two calls append two lines.
- `runAgentWithEscalation` with an injected fake `runner` (no real subprocesses):
  - success on attempt 1 → one runner call, `escalated: false`.
  - hard failure (exitCode 1) then success → two runner calls, second uses
    `escalatedConfig`, `onEscalate` fired exactly once, `escalated: true`.
  - hard failure with `escalatedConfig: undefined` → one call, `failureDescription` set.
  - hard failure with `maxEscalatedRetries: 0` → one call only.
  - `validate` returning a description on attempt 1 → triggers escalation even
    though exitCode is 0; `validate` passing on attempt 2 → success.
  - both attempts fail → `failureDescription` set, result is the last attempt's.
  - `onAttempt` is called once per attempt with the attempt's config.

**R5b.** `config.test.ts` additions (follow the file's existing test style for
building configs — read it first):
- `tiers.mid` is used for `implementer` when `models.implementer` is absent.
- explicit `models.implementer` wins over `tiers.mid`.
- no `tiers` → hardcoded defaults (assert `implementer` is `gpt-5.5`, unchanged).
- `getEscalatedModelConfig`:
  - implementer with `tiers.strong` configured → returns the strong config.
  - implementer with NO tiers → returns planDrafter's config (fallback).
  - implementer with no tiers AND planDrafter identical to implementer → undefined.
  - codeReviewer (strong tier) with no tiers → undefined (nowhere to go).
  - escalation disabled (`escalation.enabled: false` in ProjectConfig) → undefined.
  - `$default` models (usingDefaultModels path) → undefined.
  - cheap role (`commitMessageWriter` → agentCommitMessageWriter) walks to `tiers.mid`,
    and to `tiers.strong` when only `strong` is configured.
- `escalation` config normalization: absent → `{ enabled: true, hardFailureRetries: 1 }`;
  explicit values respected.

**R5c.** `state.test.ts` addition: a saved impl state without `escalations`
loads with `escalations: []`.

### Phase A acceptance

- `bun test` green (all existing + new tests).
- No diagnostics errors in changed files.
- `git diff` contains NO changes to `implement-pipeline.ts`, `review.ts`,
  `agents-config.ts`, `index.ts`, `formatting.ts`.

---

## Phase B — Pipeline wiring (`review.ts`, `implement-pipeline.ts`)

**Difficulty**: hard (control-flow surgery on shared code paths).

### R6. `review.ts` — optional escalation support in `runReview`

**R6a.** Extend `ReviewContext` with one optional field (BC3 — everything optional):

```ts
	/**
	 * Escalation hooks for the implementation pipeline. When absent, behaviour
	 * is identical to before (single tier, no auto-retry).
	 */
	escalation?: {
		/** Config to run fix passes with from review cycle 2 onward (mis-tier signal). */
		addressReviewEscalated?: ModelConfig;
		/** Escalated config for reviewer hard failures. */
		codeReviewerEscalated?: ModelConfig;
		/** Retries at the escalated tier after a hard failure (default 0). */
		hardFailureRetries?: number;
		/** Invoked whenever an escalation actually happens. */
		onEscalate?: (info: {
			role: RoleName;
			cycle: number;
			fromModel: string;
			toModel: string;
			reason: EscalationReason;
		}) => void;
	};
```

**R6b.** Reviewer run: replace the direct `runAgentWithConfig(reviewerConfig, ...)`
call with `runAgentWithEscalation` from `./escalation.ts`:

- `baseConfig: reviewerConfig`, `escalatedConfig: ctx.escalation?.codeReviewerEscalated`,
  `maxEscalatedRetries: ctx.escalation?.hardFailureRetries ?? 0`.
- `onAttempt` → existing `recordCall?.(...)` per attempt, passing the attempt's
  `config` as `modelConfig` (metrics must reflect the model actually used).
  Remove the old single `recordCall` for the reviewer.
- `onEscalate` → `ctx.escalation?.onEscalate?.({ role, cycle, fromModel, toModel, reason: "hard_failure" })`.
- `notify` passed through.
- On final failure (`failureDescription` set): keep the existing
  `handleAgentError(...)` call and early return, but pass the FINAL attempt's
  result and `config.model`.

**R6c.** Fix pass (addressReview): choose the base config per cycle:

```ts
const escalatedFix = ctx.escalation?.addressReviewEscalated;
const fixBase = cycle >= 2 && escalatedFix ? escalatedFix : addressReviewConfig;
```

Track a `let misTierEscalated = false` above the cycle loop; on the FIRST cycle
where `fixBase !== addressReviewConfig`, fire
`ctx.escalation?.onEscalate?.({ role: "addressReview", cycle, fromModel: addressReviewConfig.model, toModel: escalatedFix.model, reason: "review_cycles" })`
and set the flag (fire exactly once per runReview call).

Run the fix with `runAgentWithEscalation`:
- `baseConfig: fixBase`;
- `escalatedConfig: escalatedFix && fixBase !== escalatedFix ? escalatedFix : undefined`
  (no point escalating to itself);
- `maxEscalatedRetries: ctx.escalation?.hardFailureRetries ?? 0`;
- `onAttempt` → `recordCall` per attempt with the attempt's config;
- `onEscalate` → `ctx.escalation?.onEscalate?.({ role: "addressReview", cycle, fromModel, toModel, reason: "hard_failure" })`;
- on final failure keep the existing `handleAgentError` + early-return shape with
  the final config's model.

Update the two notify strings and `createAgentCommit`'s `modelConfig` to use the
config actually used for the fix (the wrapper's returned `config`).

**R6d.** `retryFailedOperation`: add one optional trailing parameter:

```ts
	escalation?: {
		config?: ModelConfig;
		onEscalate?: (info: { role: RoleName; fromModel: string; toModel: string; reason: "resume_retry" }) => void;
	},
```

After the existing `modelConfig` resolution: when `escalation?.config` exists and
differs from `modelConfig` (model or thinking), call `onEscalate`, notify
`🔄 Retrying ${role} with escalated model ${config.model}...`, and use it as
`modelConfig`. Everything else unchanged.

### R7. `implement-pipeline.ts` — wiring

Imports: `runAgentWithEscalation`, `recordEscalation`, `parsePlanDifficulty`
from `./escalation.ts`; `getEscalatedModelConfig` from `./config.ts`.

**R7a. planDrafter (STEP 1).** Replace the direct `runAgentWithConfig` call:

- `baseConfig: planDrafterConfig`,
  `escalatedConfig: getEscalatedModelConfig(projectConfig, "planDrafter")`,
  `maxEscalatedRetries: projectConfig.escalation.hardFailureRetries`.
- `validate: (result) => (result.output ?? "").trim().length < 50
   ? \`Plan drafter returned empty/too-short output (${(result.output ?? "").trim().length} chars)\`
   : undefined` — this SUBSUMES the existing post-hoc `< 50` check; delete that block.
- `onAttempt` → `recordAgentCall(metrics, "planDrafter", config.model, config.thinking, startTime, result.exitCode, phaseIdx + 1, undefined, result.usage)` then `save()`.
- `onEscalate` → `recordEscalation(cwd, state, { role: "planDrafter", phase: phaseIdx + 1, fromModel, toModel, reason: "hard_failure" }, save, ctx.ui.notify.bind(ctx.ui))`.
- Final failure handling: if `failureDescription` is set, call `handleAgentError`
  with the final result and final config's model exactly as the current
  exit-code path does, BUT when the failure came only from `validate`
  (`result.exitCode === 0 && result.completed !== false && !result.limitHit`)
  wrap the result first, following the existing silent-failure-guard pattern:
  `{ ...result, error: failureDescription, completed: false }`. Then
  `clearPipelineWidget(ctx); return;`.
- Success path unchanged (`formatAgentSummary` should show the final config's model).

**R7b. Difficulty routing (between STEP 2 and STEP 3).** After `phasePlan` is
assigned:

```ts
const phaseDifficulty: PlanDifficulty = effectiveSkipPlanGeneration
	? "standard"
	: parsePlanDifficulty(phasePlan);
```

In STEP 3 (inside `if (!resumingMidPhase)`), replace
`const implementerConfig = projectConfig.models.implementer;` with:

```ts
let implementerConfig = projectConfig.models.implementer;
const implementerEscalated = getEscalatedModelConfig(projectConfig, "implementer");
const alreadyRouted = state.escalations?.some(
	(e) => e.reason === "difficulty_routing" && e.phase === phaseIdx + 1,
);
if (phaseDifficulty === "hard" && implementerEscalated) {
	if (!alreadyRouted) {
		recordEscalation(
			cwd, state,
			{ role: "implementer", phase: phaseIdx + 1, fromModel: implementerConfig.model, toModel: implementerEscalated.model, reason: "difficulty_routing" },
			save, ctx.ui.notify.bind(ctx.ui),
		);
	}
	implementerConfig = implementerEscalated;
}
```

**R7c. Implementer run.** Replace the direct `runAgentWithConfig` call with
`runAgentWithEscalation`:

- `baseConfig: implementerConfig`;
- `escalatedConfig: phaseDifficulty === "hard" ? undefined : implementerEscalated`
  (already escalated when hard);
- `maxEscalatedRetries: projectConfig.escalation.hardFailureRetries`;
- `validate`: async — `const modified = await getModifiedFiles(cwd); const out = (result.output ?? "").trim(); return modified.length === 0 && out.length < MIN_IMPLEMENTER_OUTPUT_CHARS ? "Implementer exited without clear completion evidence: no file changes and minimal output" : undefined;`
  — this SUBSUMES the existing silent-failure guard block; delete that block.
- `onAttempt` → `recordAgentCall(metrics, "implementer", config.model, config.thinking, startTime, result.exitCode, phaseIdx + 1, undefined, result.usage)` then `save()`.
- `onEscalate` → `recordEscalation(cwd, state, { role: "implementer", phase: phaseIdx + 1, fromModel, toModel, reason: "hard_failure" }, save, ctx.ui.notify.bind(ctx.ui))`.
- Final failure: same wrapping rule as R7a (validate-only failure → `{ ...result, error: failureDescription, completed: false }`), then the existing `handleAgentError(..., phaseIdx + 1, 1, ...)` + `clearPipelineWidget(ctx); return;`.
- `createAgentCommit`'s `modelConfig` and `formatAgentSummary`'s model must use
  the wrapper's returned final `config`.

**R7d. Code review context.** In the `runReview` call's context object add:

```ts
escalation: {
	addressReviewEscalated: getEscalatedModelConfig(projectConfig, "addressReview"),
	codeReviewerEscalated: getEscalatedModelConfig(projectConfig, "codeReviewer"),
	hardFailureRetries: projectConfig.escalation.hardFailureRetries,
	onEscalate: ({ role, cycle, fromModel, toModel, reason }) =>
		recordEscalation(
			cwd, state,
			{ role, phase: phaseIdx + 1, cycle, fromModel, toModel, reason },
			save, ctx.ui.notify.bind(ctx.ui),
		),
},
```

**R7e. Completion.** Immediately before `finalizeImplMetrics(...)`:
`metrics.escalations = state.escalations?.length ?? 0;`

### Phase B acceptance

- `bun test` green.
- No diagnostics errors in changed files.
- `grep -c runAgentWithConfig implement-pipeline.ts` → only the import remains
  unused or removed (prefer removing it from the import list if unused).
- Behaviour with `escalation.enabled: false` or no tiers: identical control
  flow to before (verify by reading: every new branch must be a no-op when
  `getEscalatedModelConfig` returns undefined).

---

## Phase C — Prompts, surfacing, resume, docs

**Difficulty**: standard (localized text/wiring edits).

### R8. `agents-config.ts` — prompt changes

**R8a. planDrafter** (template string starting line ~321):

1. In the "Plan Format" markdown template, directly under
   `**Estimated Effort**: X days`, add:

```
**Difficulty**: standard | hard
```

2. After the "## Files Summary" section of the template (before
   "## Completion Checklist"), add a new template section:

```
## Out of Scope

- Explicitly list what this phase must NOT do (deferred work, files not to touch,
  behaviours not to change).
```

3. Append to the "## Specificity Requirements" list:

```
- **Function signatures**: Spell out exact signatures for new/changed functions
- **Error handling**: State the expected behaviour for failure paths — do not leave it implied
- **Do-nots**: List the things the implementer must NOT do (the implementer resolves ambiguity worse than you do)
```

4. After the Specificity Requirements section add a short block:

```
## Difficulty Marker

Set **Difficulty** to \`hard\` only when the phase involves genuinely gnarly work:
concurrency, data migrations, security-sensitive surfaces, cross-cutting refactors,
or ambiguous integration points. Otherwise use \`standard\`. The pipeline routes
\`hard\` phases to a stronger implementation model.

## Audience

Your plan will be executed by a smaller, cheaper model than you. It will follow
instructions literally and resolve ambiguity poorly. Anything you leave implicit
may be implemented wrong — resolve all ambiguity NOW, in the plan.
```

**R8b. implementer** (template string starting line ~415): replace the sentence

```
If tests continue to fail after multiple attempts, report the specific failures in your summary so they can be addressed.
```

with:

```
## Iteration Budget

You have a budget of 3 attempts to make the test suite pass. If tests still fail
after 3 distinct fix attempts, STOP — do not keep iterating. Instead report:
- What you tried (each attempt, briefly)
- What still fails (exact test names and errors)
- Your best hypothesis for the root cause

A precise failure report is valuable input for an escalated retry; endless
thrashing is not.
```

**R8c. addressReview** (template string starting line ~572): in its
"## Testing" section, replace

```
- Tests PASS: Review fixes complete
- Tests FAIL: Fix and re-run until passing
```

with:

```
- Tests PASS: Review fixes complete
- Tests FAIL: You have a budget of 2 fix attempts. If tests still fail after 2
  attempts, STOP and report what you tried, what still fails, and your hypothesis.
```

### R9. `formatting.ts` — surface escalations in `formatImplState`

Where `formatImplState` renders the state summary, append (only when
`state.escalations` is non-empty):

```
Escalations: <N>
  ⬆️ phase <phase>[ cycle <cycle>]: <role> <fromModel> → <toModel> (<reason>)
```

One bullet per record; omit ` cycle <cycle>` when `cycle` is undefined. Follow
the file's existing formatting helpers/style.

### R10. `index.ts` — resume escalation + metrics surfacing

**R10a.** The `/implement-resume` handler's `retryFailedOperation` call
(line ~3721 — the IMPLEMENT one; do NOT touch the spec-resume call at ~3026):
pass the new optional `escalation` argument:

```ts
{
	config: getEscalatedModelConfig(projectConfig, state.lastError.role as RoleName),
	onEscalate: ({ role, fromModel, toModel, reason }) =>
		recordEscalation(
			cwd, state,
			{ role, phase: errPhase, cycle: errCycle, fromModel, toModel, reason },
			() => saveImplState(cwd, state), (msg, type) => ctx.ui.notify(msg, type),
		),
}
```

where `errPhase`/`errCycle` come from the structured `state.lastError` (guard:
only when `lastError` is an object). Import `getEscalatedModelConfig` and
`recordEscalation` accordingly. Match the surrounding handler's actual variable
names — read the call site first.

**R10b.** The `/implement-metrics` handler: after the existing metrics output,
when `state.escalations` is non-empty add a section:

```
## Escalations (<N>)
- phase <phase>[ cycle <cycle>]: <role> <fromModel> → <toModel> (<reason>) at <timestamp>
```

### R11. `README.md` — document the feature

In the configuration section add a subsection "Model tiers & escalation"
documenting: the `tiers` config shape with a JSON example, role→tier defaults
(plan/review = strong, implement/fix = mid, commit messages = cheap), resolution
precedence (`models.<role>` > `tiers.<tier>` > built-in defaults), `escalation`
config (`enabled`, `hardFailureRetries`), the three runtime escalation triggers
(hard failure, second failed review cycle, `hard` difficulty marker), the
resume-retry escalation, and the escalation log at
`.pi/spec-pipeline/escalations.log` (JSONL). Keep it concise (~40 lines).

Also add a short "Deprecation notice" near the top: `/spec`, `/plan`,
`/roadmap`, `/epic`, and `/brainstorm` are slated for deprecation in favour of
skills + subagents; `/implement` is the supported core.

### Phase C acceptance

- `bun test` green.
- No diagnostics errors in changed files.
- `/implement-status` output unchanged when there are no escalations.

---

## Out of scope (do NOT do)

- Do NOT remove or modify the deprecated command families' behaviour.
- Do NOT change `commit-agent.ts`, `git.ts`, `errors.ts`, `agents.ts` (except:
  no changes needed there at all).
- Do NOT add escalation to the spec/roadmap/epic/brainstorm pipelines.
- Do NOT introduce new dependencies.
- Do NOT change the verdict parser, checkpoint logic, or commit flow.
- Do NOT make `tiers` required or change behaviour when it is absent.
