/**
 * Implementation pipeline execution logic
 *
 * Handles: Phase Extraction → Plan Generation → Plan Review → Implementation → Code Review
 *
 * Note: Plan files are stored in a temporary directory and cleaned up after implementation
 * completes to avoid polluting the repository. Only the final implementation code is committed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
	ImplementationState,
	ProjectConfig,
	PipelineUIContext,
	ImplementationMetrics,
	AgentCallMetrics,
	RoleName,
	PlanDifficulty,
} from "./types.ts";
import { saveImplState, getSessionLogDir } from "./state.ts";
import {
	createAgentCommit,
	createCommit,
	getChangedFilesSince,
	getCommitsSince,
	getHeadCommit,
	getModifiedFiles,
} from "./git.ts";
import { deriveShortName } from "./worktree.ts";
import { extractPhaseName, extractDocName } from "./commit-agent.ts";
import { handleAgentError } from "./errors.ts";
import {
	formatStepBanner,
	formatAgentSummary,
	updateImplWidget,
	clearPipelineWidget,
	formatDivider,
	formatKeyValue,
} from "./formatting.ts";
import { createProgressCallback } from "./agents.ts";
import { runReview } from "./review.ts";
import {
	runAgentWithEscalation,
	recordEscalation,
	parsePlanDifficulty,
} from "./escalation.ts";
import { getEscalatedModelConfig } from "./config.ts";
import { createSystemPrompts, buildPromptOptions } from "./agents-config.ts";

// ============================================
// Pipeline Roots
// ============================================

/**
 * The two roots a pipeline run operates against.
 *
 * - `projectRoot`: main repo root — state files, session logs, review logs,
 *   escalation log, error log, metrics, config loading.
 * - `workRoot`: the worktree — agent subprocess cwd, all git mutations
 *   (add/commit/stash/reset/clean), test execution, modified-file detection.
 *
 * In legacy mode (no worktree) both are equal to the triggering `ctx.cwd`.
 */
export interface PipelineRoots {
	projectRoot: string;
	workRoot: string;
}

// ============================================
// Phase Name Helpers
// ============================================

/** Stop words to skip when generating phase directory names from descriptions */
const PHASE_STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"for",
	"of",
	"in",
	"on",
	"to",
	"with",
	"is",
	"are",
	"be",
	"its",
	"this",
	"that",
	"from",
	"by",
	"at",
]);

/** Sanitize a phase focus description into a filesystem-safe slug (max 4 words) */
function sanitizePhaseDescription(description: string): string {
	return (
		description
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, "")
			.trim()
			.split(/\s+/)
			.filter((w) => w.length > 1 && !PHASE_STOP_WORDS.has(w))
			.slice(0, 4)
			.join("_") || "phase"
	);
}

// ============================================
// Metrics Helpers
// ============================================

function initializeImplMetrics(
	skipPlanGeneration: boolean,
): ImplementationMetrics {
	return {
		pipelineStartTime: new Date().toISOString(),
		agentCalls: [],
		codeReviewCycles: 0,
		codeReviewFirstPassRate: 0,
		skipPlanGeneration,
	};
}

function recordAgentCall(
	metrics: ImplementationMetrics,
	role: RoleName,
	model: string,
	thinking: string,
	startTime: Date,
	exitCode: number,
	phase?: number,
	cycle?: number,
	usage?: AgentCallMetrics["usage"],
): void {
	const endTime = new Date();
	const call: AgentCallMetrics = {
		role,
		model,
		thinking: thinking as AgentCallMetrics["thinking"],
		startTime: startTime.toISOString(),
		endTime: endTime.toISOString(),
		durationMs: endTime.getTime() - startTime.getTime(),
		exitCode,
		phase,
		cycle,
		usage,
	};
	metrics.agentCalls.push(call);
}

// ============================================
// Review Output Logging
// ============================================

/**
 * Persist the verbatim reviewer output for one cycle to disk.
 *
 * The implementation state only retains `previousReview` (cleared between
 * phases). When a reviewer surprisingly returns APPROVED on a clearly-broken
 * change — or vice versa — these logs let us see exactly what text the
 * verdict was parsed from.
 *
 * Path: <cwd>/.pi/spec-pipeline/reviews/<implId>/phase<N>_cycle<M>_<role>.md
 * Best-effort: failures are logged but never block the pipeline.
 */
function writeReviewLog(
	cwd: string,
	implId: string,
	info: {
		role: RoleName;
		phase?: number;
		cycle: number;
		verdict: string;
		output: string;
	},
	notify?: (
		msg: string,
		type: "info" | "error" | "success" | "warning",
	) => void,
): void {
	try {
		const dir = path.join(cwd, ".pi/spec-pipeline/reviews", implId);
		fs.mkdirSync(dir, { recursive: true });
		const phaseLabel =
			info.phase !== undefined ? `phase${info.phase}` : "no_phase";
		const file = path.join(
			dir,
			`${phaseLabel}_cycle${info.cycle}_${info.role}.md`,
		);
		const header = [
			`# Review log`,
			``,
			`- Role: ${info.role}`,
			`- Phase: ${info.phase ?? "n/a"}`,
			`- Cycle: ${info.cycle}`,
			`- Parsed verdict: ${info.verdict}`,
			`- Captured at: ${new Date().toISOString()}`,
			``,
			`---`,
			``,
		].join("\n");
		fs.writeFileSync(file, header + info.output, "utf-8");
	} catch (err) {
		notify?.(
			`Failed to write review log: ${err instanceof Error ? err.message : String(err)}`,
			"warning",
		);
	}
}

function finalizeImplMetrics(
	metrics: ImplementationMetrics,
	phasesCount: number,
	phasesApprovedFirstPass: number,
): void {
	metrics.pipelineEndTime = new Date().toISOString();
	const startTime = new Date(metrics.pipelineStartTime).getTime();
	const endTime = new Date(metrics.pipelineEndTime).getTime();
	metrics.totalDurationMs = endTime - startTime;
	metrics.codeReviewFirstPassRate =
		phasesCount > 0
			? Math.round((phasesApprovedFirstPass / phasesCount) * 100)
			: 0;
}

// ============================================
// Phase Extraction
// ============================================

/**
 * Normalize a raw difficulty cell value. Only an exact (case-insensitive)
 * "hard" routes up — anything else (absent, "standard", effort values,
 * unrelated columns) is "standard".
 */
function normalizeDifficulty(raw: string | undefined): PlanDifficulty {
	return raw?.trim().toLowerCase() === "hard" ? "hard" : "standard";
}

/** A validated phase entry from the machine-readable JSON phases block. */
interface JsonPhaseEntry {
	phase: number;
	focus: string;
	difficulty: PlanDifficulty;
}

/**
 * Try to parse the contents of a fenced ```json block as a phases payload:
 *
 *   { "phases": [ { "phase": 1, "focus": "...", "effort": "M", "difficulty": "hard" } ] }
 *
 * Returns null if the block is not valid JSON or does not match the expected
 * shape (every entry needs a positive integer `phase` and a non-empty string
 * `focus`). Unknown extra keys (e.g. `effort`, `title`) are ignored, so the
 * spec-writer agent can enrich entries without breaking the parser.
 */
function tryParsePhasesJson(raw: string): JsonPhaseEntry[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const phases = (parsed as { phases?: unknown }).phases;
	if (!Array.isArray(phases) || phases.length === 0) return null;

	const entries: JsonPhaseEntry[] = [];
	for (const item of phases) {
		if (typeof item !== "object" || item === null) return null;
		const { phase, focus, difficulty } = item as Record<string, unknown>;
		if (typeof phase !== "number" || !Number.isInteger(phase) || phase < 1) {
			return null;
		}
		if (typeof focus !== "string" || focus.trim() === "") return null;
		entries.push({
			phase,
			focus: focus.trim(),
			difficulty: normalizeDifficulty(
				typeof difficulty === "string" ? difficulty : undefined,
			),
		});
	}
	entries.sort((a, b) => a.phase - b.phase);
	return entries;
}

/**
 * Extract phases from a spec document.
 *
 * Supports five formats, tried in order:
 * 1. JSON phases block (preferred): a fenced ```json block containing
 *    { "phases": [ { "phase": 1, "focus": "...", "difficulty": "hard" } ] }
 *    — emitted by the spec-writer agent at the end of the spec
 * 2. Table format without links: | Phase 1 | Focus description | Effort | Difficulty? |
 * 3. Table format with links (legacy): | Phase 1 | Focus | Effort | [name](./path/phase1.md) |
 * 4. Typst table format: [Phase 1], [Focus description], [Effort], [Difficulty]?,
 * 5. Inline format (fallback): ### Phase 1: Name (hard)  (also accepts — – - as separator)
 *
 * Difficulty (`standard` | `hard`, case-insensitive) routes `hard` phases to
 * the escalated implementer tier — including when plan generation is skipped.
 * Absent or unrecognized values mean "standard".
 */
export function extractPhases(
	specContent: string,
	specTimestamp: string,
	shortName: string,
): { paths: string[]; isInline: boolean; difficulties: PlanDifficulty[] } {
	// Format 1 (preferred): machine-readable JSON phases block. Scan every
	// fenced ```json block and use the first one that validates as a phases
	// payload — other JSON blocks (config examples, etc.) are skipped.
	const jsonFenceRegex = /```json[^\n]*\n([\s\S]*?)```/g;
	let fenceMatch;
	while ((fenceMatch = jsonFenceRegex.exec(specContent)) !== null) {
		const entries = tryParsePhasesJson(fenceMatch[1]);
		if (entries) {
			return {
				paths: entries.map(
					(e) =>
						`${specTimestamp}_${shortName}/phase${e.phase}_${sanitizePhaseDescription(e.focus)}.md`,
				),
				isInline: false,
				difficulties: entries.map((e) => e.difficulty),
			};
		}
	}

	// Next try table format with links (legacy support; no difficulty column)
	const linkedPhases: string[] = [];
	const linkedRegex =
		/\|\s*Phase\s*\d+\s*\|[^|]+\|[^|]+\|\s*\[([^\]]+)\]\(([^)]+)\)/g;
	let match;
	while ((match = linkedRegex.exec(specContent)) !== null) {
		linkedPhases.push(match[2]);
	}

	if (linkedPhases.length > 0) {
		return {
			paths: linkedPhases,
			isInline: false,
			difficulties: linkedPhases.map(() => "standard" as PlanDifficulty),
		};
	}

	// Try new table format without links: | Phase N | Focus | Effort | Difficulty? |
	// The optional 4th cell is line-bound ([^|\n]) so it can never swallow the
	// next row when the table only has 3 columns.
	const tablePhases: string[] = [];
	const tableDifficulties: PlanDifficulty[] = [];
	const tableRegex =
		/\|\s*Phase\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*[^|]+?\s*\|(?:[ \t]*([^|\n]+?)[ \t]*\|)?/g;
	while ((match = tableRegex.exec(specContent)) !== null) {
		const phaseNum = match[1];
		const focusDescription = match[2].trim();

		// Generate phase name from focus description (first 4 words, sanitized)
		const phaseName = sanitizePhaseDescription(focusDescription);

		tablePhases.push(
			`${specTimestamp}_${shortName}/phase${phaseNum}_${phaseName}.md`,
		);
		tableDifficulties.push(normalizeDifficulty(match[3]));
	}

	if (tablePhases.length > 0) {
		return {
			paths: tablePhases,
			isInline: false,
			difficulties: tableDifficulties,
		};
	}

	// Try Typst table format: [Phase N], [Focus], [Effort], [Difficulty]?,
	// Optional cells are line-bound ([ \t] only) so they can never consume the
	// next row's [Phase N] cell.
	const typstPhases: string[] = [];
	const typstDifficulties: PlanDifficulty[] = [];
	const typstRegex =
		/\[Phase\s+(\d+)\],\s*\[([^\]]+)\](?:,[ \t]*\[([^\]\n]*)\])?(?:,[ \t]*\[([^\]\n]*)\])?/g;
	while ((match = typstRegex.exec(specContent)) !== null) {
		const phaseNum = match[1];
		const focusDescription = match[2].trim();

		// Generate phase name from focus description (first 4 words, sanitized)
		const phaseName = sanitizePhaseDescription(focusDescription);

		typstPhases.push(
			`${specTimestamp}_${shortName}/phase${phaseNum}_${phaseName}.md`,
		);
		typstDifficulties.push(normalizeDifficulty(match[4]));
	}

	if (typstPhases.length > 0) {
		return {
			paths: typstPhases,
			isInline: false,
			difficulties: typstDifficulties,
		};
	}

	// Fallback: detect inline phases. A trailing parenthetical of exactly
	// "(hard)" marks the phase hard; other parentheticals are ignored.
	const inlinePhases: string[] = [];
	const inlineDifficulties: PlanDifficulty[] = [];
	const inlineRegex =
		/^###\s*Phase\s*(\d+)\s*[:\-\u2013\u2014]\s*(.+?)(?:\s*\(([^)]*)\))?\s*$/gm;
	while ((match = inlineRegex.exec(specContent)) !== null) {
		const phaseNum = match[1];
		const phaseName = sanitizePhaseDescription(match[2]);
		inlinePhases.push(
			`${specTimestamp}_${shortName}/phase${phaseNum}_${phaseName}.md`,
		);
		inlineDifficulties.push(normalizeDifficulty(match[3]));
	}

	return {
		paths: inlinePhases,
		isInline: true,
		difficulties: inlineDifficulties,
	};
}

// ============================================
// Main Implementation Pipeline Execution
// ============================================

/**
 * Run the implementation pipeline
 */
export async function runImplementPipeline(
	state: ImplementationState,
	roots: PipelineRoots,
	projectConfig: ProjectConfig,
	ctx: PipelineUIContext,
): Promise<void> {
	// Pass the worktree path so every role prompt is anchored to it (prevents the
	// agent from cd-ing back to the canonical main checkout and writing work there).
	const SYSTEM_PROMPTS = createSystemPrompts(
		buildPromptOptions(projectConfig, roots.workRoot),
	);

	// Helper to save state (always in the main repo)
	const save = () => saveImplState(roots.projectRoot, state);

	// Create temporary directory for spec and plan files
	const pipelineTmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "spec-pipeline-"),
	);
	const specTmpPath = path.join(pipelineTmpDir, "spec.md");
	const plansTmpDir = path.join(pipelineTmpDir, "plans");
	fs.mkdirSync(plansTmpDir, { recursive: true });
	fs.writeFileSync(specTmpPath, state.specContent, "utf-8");
	const specFileRef = `Read the full specification from this file: ${specTmpPath}`;

	// Cleanup helper for temp directory
	const cleanupTmpDir = () => {
		try {
			fs.rmSync(pipelineTmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	};

	try {
		return await _runImplementPipelineInner(
			state,
			roots,
			projectConfig,
			ctx,
			plansTmpDir,
			SYSTEM_PROMPTS,
			save,
			specTmpPath,
			specFileRef,
		);
	} finally {
		cleanupTmpDir();
	}
}

/** Inner implementation — separated so we can wrap with try/finally for temp file cleanup */
async function _runImplementPipelineInner(
	state: ImplementationState,
	roots: PipelineRoots,
	projectConfig: ProjectConfig,
	ctx: PipelineUIContext,
	plansTmpDir: string,
	SYSTEM_PROMPTS: ReturnType<typeof createSystemPrompts>,
	save: () => void,
	specTmpPath: string,
	specFileRef: string,
): Promise<void> {
	const { projectRoot, workRoot } = roots;
	const sessionDir = getSessionLogDir(projectRoot, state.id);

	// Initialize or restore metrics
	if (!state.metrics) {
		state.metrics = initializeImplMetrics(state.skipPlanGeneration ?? false);
		save();
	}
	const metrics = state.metrics;

	// Extract doc name from spec path for commit message scoping
	const docName = extractDocName(state.specPath) ?? undefined;

	const effectiveSkipPlanGeneration =
		state.skipPlanGeneration || projectConfig.skipPlanGeneration;

	// ============================================
	// PHASE EXTRACTION (if phases not yet extracted)
	// ============================================
	if (state.phases.length === 0) {
		const specContent = state.specContent;

		// Derive short name from spec path
		const shortName = deriveShortName(state.specPath);

		// Try to extract timestamp from spec filename, otherwise use implTimestamp
		const specBasename = path.basename(
			state.specPath,
			path.extname(state.specPath),
		);
		const timestampMatch = specBasename.match(/^(\d{10})/);
		const specTimestamp = timestampMatch
			? timestampMatch[1]
			: state.implTimestamp;

		const phaseResult = extractPhases(specContent, specTimestamp, shortName);
		state.phases = phaseResult.paths;
		state.phaseDifficulties = phaseResult.difficulties;

		if (phaseResult.isInline && state.phases.length > 0) {
			ctx.ui.notify(
				`⚠️ Detected ${state.phases.length} inline phases (table format preferred)`,
				"warning",
			);
		}

		if (state.phases.length === 0) {
			ctx.ui.notify(
				"No phases found in spec - using single implementation phase",
				"info",
			);
			state.phases.push(
				`${specTimestamp}_${shortName}/phase1_implementation.md`,
			);
			state.phaseDifficulties = ["standard"];
		} else {
			ctx.ui.notify(`Found ${state.phases.length} phases to implement`, "info");
		}

		state.phasesGenerated = new Array(state.phases.length).fill(false);
		state.phaseCommits = state.phases.map(() => []);
		save();
	}

	// ============================================
	// PER-PHASE PIPELINE: Plan → Implement (interleaved)
	// ============================================
	if (effectiveSkipPlanGeneration) {
		ctx.ui.notify(
			formatStepBanner(
				"PLAN GENERATION SKIPPED",
				"Direct implementation mode (skipPlanGeneration=true)",
				"⏭️",
			),
			"info",
		);

		state.phasesGenerated = state.phases.map(() => true);
		save();
	}

	state.stage = "implementation";
	save();

	ctx.ui.notify(
		formatStepBanner(
			"IMPLEMENTATION",
			`Processing ${state.phases.length} phase(s) — plan + implement per phase`,
			"🚀",
		),
		"info",
	);

	for (
		let phaseIdx = state.currentPhaseIndex;
		phaseIdx < state.phases.length;
		phaseIdx++
	) {
		state.currentPhaseIndex = phaseIdx;

		const resumingMidPhase = state.implementerCompletedForPhase === true;

		if (!resumingMidPhase) {
			state.reviewCyclesCompleted = 0;
			state.implementerCompletedForPhase = false;
			// Snapshot HEAD at phase start so STEP 5 can record the real commits an
			// agent makes during the phase (including self-commits that leave a
			// clean working tree), and so the implementer validator can recognize
			// an already-complete phase. Persisted for resume-safety.
			state.phaseStartHead = await getHeadCommit(workRoot);
		}
		save();

		const phasePath = state.phases[phaseIdx];
		// Store plan files in temp directory instead of repository
		const fullPhasePath = path.join(plansTmpDir, path.basename(phasePath));
		const phaseName = extractPhaseName(phasePath);

		ctx.ui.notify(
			formatStepBanner(
				`Phase ${phaseIdx + 1}/${state.phases.length}`,
				phasePath.split("/").pop() || "implementation",
				"🔨",
			),
			"info",
		);

		// ========================================
		// STEP 1: Plan Generation (per phase)
		// ========================================
		if (
			!effectiveSkipPlanGeneration &&
			(!state.phasesGenerated[phaseIdx] || !fs.existsSync(fullPhasePath))
		) {
			if (state.phasesGenerated[phaseIdx]) {
				ctx.ui.notify(
					`Plan file missing from temp dir (${fullPhasePath}); regenerating`,
					"info",
				);
				state.phasesGenerated[phaseIdx] = false;
				save();
			}
			updateImplWidget(
				ctx,
				state,
				`Generating plan for phase ${phaseIdx + 1}/${state.phases.length}`,
			);

			ctx.ui.notify(
				formatStepBanner(
					`Phase ${phaseIdx + 1}/${state.phases.length} Plan`,
					`Creating detailed implementation plan`,
					"📝",
				),
				"info",
			);

			const planDrafterConfig = projectConfig.models.planDrafter;
			ctx.ui.notify(
				`📋 ${planDrafterConfig.model} drafting implementation plan...`,
				"info",
			);

			const planTask = `Create a detailed implementation plan for Phase ${phaseIdx + 1}.

${specFileRef}

You have READ-ONLY tools. Do NOT modify any source files; the implementer agent
will do that in the next step from your plan.

Explore the codebase first (read, ls, grep, find, bash with read-only commands):
- Project structure and conventions
- Similar existing implementations
- Test patterns used

Then output the plan markdown as your final assistant message. The pipeline will
capture it and save it for the implementer. Do NOT call write/edit tools.`;

			// Create progress callback for plan drafting (R17)
			const planPhaseInfo = `Phase ${phaseIdx + 1}/${state.phases.length} Plan`;
			const planProgressCallback = createProgressCallback(
				ctx,
				state,
				planPhaseInfo,
				true, // isImplPipeline
			);

			const planRun = await runAgentWithEscalation({
				baseConfig: planDrafterConfig,
				escalatedConfig: getEscalatedModelConfig(projectConfig, "planDrafter"),
				maxEscalatedRetries: projectConfig.escalation.hardFailureRetries,
				role: "planDrafter",
				task: planTask,
				cwd: workRoot,
				systemPrompt: SYSTEM_PROMPTS.planDrafter,
				onOutput: planProgressCallback, // ← Pass callback (R17)
				sessionDir,
				validate: (result) =>
					(result.output ?? "").trim().length < 50
						? `Plan drafter returned empty/too-short output (${(result.output ?? "").trim().length} chars)`
						: undefined,
				onAttempt: ({ config, startTime, result }) => {
					recordAgentCall(
						metrics,
						"planDrafter",
						config.model,
						config.thinking,
						startTime,
						result.exitCode,
						phaseIdx + 1,
						undefined,
						result.usage,
					);
					save();
				},
				onEscalate: ({ fromModel, toModel }) => {
					recordEscalation(
						projectRoot,
						state,
						{
							role: "planDrafter",
							phase: phaseIdx + 1,
							fromModel,
							toModel,
							reason: "hard_failure",
						},
						save,
						ctx.ui.notify.bind(ctx.ui),
					);
				},
				notify: ctx.ui.notify.bind(ctx.ui),
			});
			const planDraftResult = planRun.result;
			const planDrafterFinalConfig = planRun.config;

			if (planRun.failureDescription) {
				const validateOnly =
					planDraftResult.exitCode === 0 &&
					planDraftResult.completed !== false &&
					!planDraftResult.limitHit;
				await handleAgentError(
					projectRoot,
					workRoot,
					state,
					validateOnly
						? {
								...planDraftResult,
								error: planRun.failureDescription,
								completed: false,
							}
						: planDraftResult,
					planDrafterFinalConfig.model,
					"planDrafter",
					planTask,
					undefined,
					undefined,
					ctx.ui.notify.bind(ctx.ui),
					save,
				);
				clearPipelineWidget(ctx);
				return;
			}

			ctx.ui.notify(
				formatAgentSummary(
					"planDrafter",
					planDrafterFinalConfig.model,
					planDraftResult.output,
					"✅",
					phaseIdx + 1,
				),
				"info",
			);

			const agentOutput = (planDraftResult.output || "").trim();
			fs.mkdirSync(path.dirname(fullPhasePath), { recursive: true });
			fs.writeFileSync(fullPhasePath, agentOutput, "utf-8");

			state.phasesGenerated[phaseIdx] = true;
			save();
			ctx.ui.notify(
				`Phase ${phaseIdx + 1} plan saved to ${phasePath}`,
				"success",
			);
		}

		// ========================================
		// STEP 2: Read Phase Plan
		// ========================================
		let phasePlan: string;
		if (effectiveSkipPlanGeneration) {
			phasePlan = `## Direct Implementation from Spec (No Plan File)

This is Phase ${phaseIdx + 1} of ${state.phases.length}.
Expected phase file: ${phasePath}

${specFileRef}

## Instructions

Implement this phase according to the specification above. 
Focus on Phase ${phaseIdx + 1} requirements.
Explore the codebase to understand existing patterns before making changes.`;
		} else if (fs.existsSync(fullPhasePath)) {
			phasePlan = fs.readFileSync(fullPhasePath, "utf-8");
		} else {
			ctx.ui.notify(
				`⚠️ Plan file not found: ${fullPhasePath}, using spec`,
				"warning",
			);
			phasePlan = `## Implementation from Spec (Plan File Missing)

${specFileRef}`;
		}

		// Difficulty routing: a `hard` marker routes the implementer to the strong
		// tier. Two sources, hard wins if either says so:
		// 1. The spec phase table's optional Difficulty column (state.phaseDifficulties)
		//    — works even when plan generation is skipped.
		// 2. The planner's `Difficulty:` marker in the generated phase plan.
		const phaseDifficulty: PlanDifficulty =
			state.phaseDifficulties?.[phaseIdx] === "hard"
				? "hard"
				: effectiveSkipPlanGeneration
					? "standard"
					: parsePlanDifficulty(phasePlan);

		// ========================================
		// STEP 3: Implementation
		// ========================================
		let implementationSummary: string;

		if (!resumingMidPhase) {
			let implementerConfig = projectConfig.models.implementer;
			const implementerEscalated = getEscalatedModelConfig(
				projectConfig,
				"implementer",
			);
			const alreadyRouted = state.escalations?.some(
				(e) => e.reason === "difficulty_routing" && e.phase === phaseIdx + 1,
			);
			if (phaseDifficulty === "hard" && implementerEscalated) {
				if (!alreadyRouted) {
					recordEscalation(
						projectRoot,
						state,
						{
							role: "implementer",
							phase: phaseIdx + 1,
							fromModel: implementerConfig.model,
							toModel: implementerEscalated.model,
							reason: "difficulty_routing",
						},
						save,
						ctx.ui.notify.bind(ctx.ui),
					);
				}
				implementerConfig = implementerEscalated;
			}

			updateImplWidget(
				ctx,
				state,
				`Implementing phase ${phaseIdx + 1}/${state.phases.length} (${implementerConfig.model})...`,
			);

			ctx.ui.notify(
				`🔵 ${implementerConfig.model} implementing phase ${phaseIdx + 1}...`,
				"info",
			);

			const implementTask =
				state.previousReview === ""
					? `Implement this phase according to the plan:

${phasePlan}

${projectConfig.testCommand ? `Run tests with: ${projectConfig.testCommand}` : ""}

Make the code changes as specified. Use read, write, edit, and bash tools.`
					: `Continue implementation, addressing the review feedback.

Original plan:
${phasePlan}

Previous review feedback:
${state.previousReview}

${projectConfig.testCommand ? `Run tests with: ${projectConfig.testCommand}` : ""}

Address all issues raised in the review.`;

			// Create progress callback for implementation (R18)
			const implPhaseInfo = `Phase ${phaseIdx + 1}/${state.phases.length}`;
			const implProgressCallback = createProgressCallback(
				ctx,
				state,
				implPhaseInfo,
				true, // isImplPipeline
			);

			// Snapshot HEAD before the implementer runs so validation can detect
			// work even when the agent commits its own changes (some agents follow
			// the target repo's commit conventions and `git commit` as they go,
			// leaving a clean working tree). undefined when HEAD is unresolvable
			// (unborn branch) — validation then falls back to working-tree-only.
			const preImplementationHead = await getHeadCommit(workRoot);

			const implementRun = await runAgentWithEscalation({
				baseConfig: implementerConfig,
				// Already escalated when the phase is hard; otherwise allow a
				// hard-failure escalation to the implementer's escalated tier.
				escalatedConfig:
					phaseDifficulty === "hard" ? undefined : implementerEscalated,
				maxEscalatedRetries: projectConfig.escalation.hardFailureRetries,
				role: "implementer",
				task: implementTask,
				cwd: workRoot,
				systemPrompt: SYSTEM_PROMPTS.implementer,
				onOutput: implProgressCallback, // ← Pass callback (R18)
				sessionDir,
				validate: async (result) => {
					// Did THIS run make changes (committed or uncommitted)? Measure
					// against the HEAD captured just before the implementer ran, so a
					// self-committing implementer (clean tree, new commits) still passes.
					const modifiedThisRun = preImplementationHead
						? await getChangedFilesSince(workRoot, preImplementationHead)
						: await getModifiedFiles(workRoot);
					if (modifiedThisRun.length > 0) {
						return undefined;
					}

					// No changes this run. Is the phase already done — i.e. did an
					// earlier step in THIS phase (a prior implementer attempt, or
					// an addressReview fix) already commit work since the phase
					// started? If so, a no-op implementer run is a correct
					// verification, not a failure. This is the guard that prevents an
					// already-complete phase from looping forever on "made no changes".
					// This also subsumes the orphaned-commit case (a user manually
					// committing a dirty worktree left by a crashed implementer between
					// pipeline runs): any such commit lands between phaseStartHead and
					// now and is picked up here.
					const phaseStartHead = state.phaseStartHead;
					if (phaseStartHead) {
						const priorPhaseCommits = await getCommitsSince(
							workRoot,
							phaseStartHead,
						);
						if (priorPhaseCommits.length > 0) {
							ctx.ui.notify(
								`Phase ${phaseIdx + 1} already implemented — ` +
									`${priorPhaseCommits.length} commit(s) since phase start; ` +
									`implementer made no new changes (treated as complete).`,
								"info",
							);
							return undefined;
						}
					}

					// Legacy resume fallback: if commits were already recorded for this
					// phase (e.g. a pre-`phaseStartHead` state resumed mid-phase), the
					// phase is already done — accept the no-op.
					if ((state.phaseCommits[phaseIdx] ?? []).length > 0) {
						ctx.ui.notify(
							`Phase ${phaseIdx + 1} already committed in a prior run ` +
								`(recorded ${(state.phaseCommits[phaseIdx] ?? []).length} commit(s)); ` +
								`implementer made no new changes (treated as complete).`,
							"info",
						);
						return undefined;
					}

					// Genuine no-op: nothing this run AND nothing committed this phase.
					// This means the implementer either did nothing or operated on a
					// different directory and its work was silently lost.
					return (
						`Implementer made no file changes in the worktree (${workRoot}) — ` +
						`no commits since ${preImplementationHead ?? "start"} and no uncommitted ` +
						`changes, and no prior commits since phase start ` +
						`(${phaseStartHead ?? "unknown"}). Every implementation must edit files ` +
						`inside this directory. Verify the agent ran its commands here and did ` +
						`not cd to another checkout.`
					);
				},
				onAttempt: ({ config, startTime, result }) => {
					recordAgentCall(
						metrics,
						"implementer",
						config.model,
						config.thinking,
						startTime,
						result.exitCode,
						phaseIdx + 1,
						undefined,
						result.usage,
					);
					save();
				},
				onEscalate: ({ fromModel, toModel }) => {
					recordEscalation(
						projectRoot,
						state,
						{
							role: "implementer",
							phase: phaseIdx + 1,
							fromModel,
							toModel,
							reason: "hard_failure",
						},
						save,
						ctx.ui.notify.bind(ctx.ui),
					);
				},
				notify: ctx.ui.notify.bind(ctx.ui),
			});
			const implementResult = implementRun.result;
			const implementerFinalConfig = implementRun.config;

			if (implementRun.failureDescription) {
				const validateOnly =
					implementResult.exitCode === 0 &&
					implementResult.completed !== false &&
					!implementResult.limitHit;
				await handleAgentError(
					projectRoot,
					workRoot,
					state,
					validateOnly
						? {
								...implementResult,
								error: implementRun.failureDescription,
								completed: false,
							}
						: implementResult,
					implementerFinalConfig.model,
					"implementer",
					implementTask,
					phaseIdx + 1,
					1,
					ctx.ui.notify.bind(ctx.ui),
					save,
				);
				clearPipelineWidget(ctx);
				return;
			}

			ctx.ui.notify(
				formatAgentSummary(
					"implementer",
					implementerFinalConfig.model,
					implementResult.output,
					"✅",
					phaseIdx + 1,
				),
				"info",
			);

			const implementOutput = implementResult.output || "";
			implementationSummary = implementOutput.slice(0, 1500);

			// Create commit after implementation
			const commitResult = await createAgentCommit(
				workRoot,
				state,
				{
					role: "implementer",
					modelConfig: implementerFinalConfig,
					phase: phaseIdx + 1,
					phaseName,
					docName,
					cycle: 1,
				},
				projectConfig.models.agentCommitMessageWriter,
				save,
				ctx.ui.notify.bind(ctx.ui),
			);

			if (!commitResult.success) {
				if (commitResult.usedFallback) {
					state.lastError = "Commit message generation failed - fallback used";
					save();
					clearPipelineWidget(ctx);
					return;
				} else {
					state.lastError = undefined;
					save();
					clearPipelineWidget(ctx);
					ctx.ui.notify("Failed to create agent commit", "error");
					return;
				}
			}

			state.implementerCompletedForPhase = true;
			save();
		} else {
			ctx.ui.notify(
				`🔄 Resuming phase ${phaseIdx + 1} (skipping implementation step)`,
				"info",
			);
			const planPreview = phasePlan || "";
			implementationSummary = `(Resumed from previous run)\n\nImplementation plan:\n${planPreview.slice(0, 1200)}`;
		}

		// ========================================
		// STEP 4: Code Review
		// ========================================
		updateImplWidget(ctx, state, "Running code review...");

		ctx.ui.notify(
			formatStepBanner(
				`Code Review - Phase ${phaseIdx + 1}`,
				"Running code review",
				"💻",
			),
			"info",
		);

		// Create progress callback for code review (R19, R20)
		const codeReviewPhaseInfo = `Phase ${phaseIdx + 1}/${state.phases.length} Code Review`;
		const codeReviewProgressCallback = createProgressCallback(
			ctx,
			state,
			codeReviewPhaseInfo,
			true, // isImplPipeline
		);

		const codeReviewResult = await runReview(
			{
				projectRoot,
				workRoot,
				projectConfig,
				systemPrompts: SYSTEM_PROMPTS,
				state,
				saveFn: save,
				phaseIndex: phaseIdx + 1,
				phaseName,
				docName,
				notify: ctx.ui.notify.bind(ctx.ui),
				onOutput: codeReviewProgressCallback, // ← Add callback (R19, R20)
				sessionDir,
				recordCall: ({
					role,
					modelConfig,
					startTime,
					exitCode,
					phase,
					cycle,
					usage,
				}) => {
					recordAgentCall(
						metrics,
						role,
						modelConfig.model,
						modelConfig.thinking,
						startTime,
						exitCode,
						phase,
						cycle,
						usage,
					);
					save();
				},
				recordReviewOutput: ({ role, phase, cycle, verdict, output }) => {
					writeReviewLog(
						projectRoot,
						state.id,
						{ role, phase, cycle, verdict, output },
						ctx.ui.notify.bind(ctx.ui),
					);
				},
				escalation: {
					addressReviewEscalated: getEscalatedModelConfig(
						projectConfig,
						"addressReview",
					),
					codeReviewerEscalated: getEscalatedModelConfig(
						projectConfig,
						"codeReviewer",
					),
					hardFailureRetries: projectConfig.escalation.hardFailureRetries,
					onEscalate: ({ role, cycle, fromModel, toModel, reason }) =>
						recordEscalation(
							projectRoot,
							state,
							{ role, phase: phaseIdx + 1, cycle, fromModel, toModel, reason },
							save,
							ctx.ui.notify.bind(ctx.ui),
						),
				},
			},
			{
				role: "codeReviewer",
				reviewTask: `Review the implementation for Phase ${phaseIdx + 1}.

Implementation plan:
${phasePlan}

Check if the implementation matches the plan and follows project conventions.
${projectConfig.testCommand ? `Verify tests pass with: ${projectConfig.testCommand}` : ""}`,
				fixTask: (reviewOutput) => `Address these code review findings for Phase ${phaseIdx + 1} (${phaseName}):

${reviewOutput}

${projectConfig.testCommand ? `Run tests with: ${projectConfig.testCommand}` : ""}

Make the necessary fixes. Stay within the scope of Phase ${phaseIdx + 1} (${phaseName}) — do NOT implement deliverables that belong to later phases; each later phase has its own implementation step. If a finding requires future-phase work, note it as a recommendation for that phase instead of implementing it now.`,
				runAddressReviewOnSignificantIssues: true,
			},
		);

		if (codeReviewResult.hadError) {
			clearPipelineWidget(ctx);
			return;
		}

		metrics.codeReviewCycles += codeReviewResult.cyclesCompleted;
		save();

		ctx.ui.notify(
			formatAgentSummary(
				"codeReviewer",
				projectConfig.models.codeReviewer.model,
				codeReviewResult.lastReviewOutput,
				codeReviewResult.verdict === "APPROVED" ? "✅" : "🔄",
				phaseIdx + 1,
				`(cycles: ${codeReviewResult.cyclesCompleted})`,
			),
			"info",
		);

		state.previousReview = codeReviewResult.lastReviewOutput;
		state.reviewCyclesCompleted = codeReviewResult.cyclesCompleted;
		save();

		// ========================================
		// STEP 5: Record commits for this phase, then commit any remainder
		// ========================================
		// Capture every commit made since the phase started — including commits
		// an agent self-made (implementer / addressReview) that left a clean
		// working tree. Previously only the uncommitted tree was inspected, so
		// self-commits were silently lost and phaseCommits stayed empty.
		const phaseStartHead = state.phaseStartHead;
		const agentCommits = await getCommitsSince(workRoot, phaseStartHead);
		if (!state.phaseCommits[phaseIdx]) {
			state.phaseCommits[phaseIdx] = [];
		}
		for (const hash of agentCommits) {
			if (!state.phaseCommits[phaseIdx].includes(hash)) {
				state.phaseCommits[phaseIdx].push(hash);
			}
		}

		const remainingChanges = await getModifiedFiles(workRoot);
		if (remainingChanges.length > 0) {
			updateImplWidget(ctx, state, "Creating commit...");
			ctx.ui.notify(`💾 Creating commit for phase ${phaseIdx + 1}...`, "info");

			const phaseCommitMsg = `feat(phase-${phaseIdx + 1}): complete phase ${phaseIdx + 1} implementation`;
			const committed = await createCommit(workRoot, phaseCommitMsg);
			if (committed) {
				const pipelineCommit = await getHeadCommit(workRoot);
				if (
					pipelineCommit &&
					!state.phaseCommits[phaseIdx].includes(pipelineCommit)
				) {
					state.phaseCommits[phaseIdx].push(pipelineCommit);
				}
				save();
				ctx.ui.notify(`Phase ${phaseIdx + 1} committed`, "success");
			}
		} else if (agentCommits.length > 0) {
			ctx.ui.notify(
				`Phase ${phaseIdx + 1}: ${agentCommits.length} agent commit(s) recorded, no uncommitted changes`,
				"info",
			);
			save();
		} else {
			ctx.ui.notify(`No uncommitted changes — skipping phase commit`, "info");
		}

		// Reset for next phase
		state.currentReviewCycle = 1;
		state.previousReview = "";
		state.reviewCyclesCompleted = 0;
		state.implementerCompletedForPhase = false;
		state.lastError = undefined;
		save();

		ctx.ui.notify(
			formatStepBanner(
				`Phase ${phaseIdx + 1}/${state.phases.length} Complete`,
				phaseIdx + 1 < state.phases.length
					? `Moving to phase ${phaseIdx + 2}...`
					: "All phases complete!",
				"✅",
			),
			"success",
		);
	}

	// ============================================
	// COMPLETION
	// ============================================

	// Finalize metrics
	let phasesApprovedFirstPass = 0;
	const avgReviewCyclesPerPhase =
		state.phases.length > 0
			? metrics.codeReviewCycles / state.phases.length
			: 0;
	if (avgReviewCyclesPerPhase <= 1.5) {
		phasesApprovedFirstPass = Math.round(state.phases.length * 0.8);
	} else if (avgReviewCyclesPerPhase <= 2) {
		phasesApprovedFirstPass = Math.round(state.phases.length * 0.5);
	}

	metrics.escalations = state.escalations?.length ?? 0;
	finalizeImplMetrics(metrics, state.phases.length, phasesApprovedFirstPass);
	state.stage = "completed";
	save();

	clearPipelineWidget(ctx);

	// Completion message
	const completionLines: string[] = [];
	completionLines.push("");
	completionLines.push(formatDivider(50));
	completionLines.push("  🎉 Implementation Complete!");
	completionLines.push(formatDivider(50));
	completionLines.push("");
	completionLines.push(formatKeyValue("  Pipeline ID", state.id));
	completionLines.push(formatKeyValue("  Spec Path", state.specPath));
	completionLines.push(formatKeyValue("  Phases", String(state.phases.length)));
	if (state.checkpoints && state.checkpoints.length > 0) {
		completionLines.push(
			formatKeyValue("  Checkpoints", String(state.checkpoints.length)),
		);
	}

	if (metrics.totalDurationMs) {
		const durationMins = Math.round(metrics.totalDurationMs / 60000);
		completionLines.push(formatKeyValue("  Duration", `${durationMins} min`));
	}
	completionLines.push(
		formatKeyValue("  Agent Calls", String(metrics.agentCalls.length)),
	);
	completionLines.push(
		formatKeyValue(
			"  Plan Generation",
			metrics.skipPlanGeneration ? "Skipped" : "Enabled",
		),
	);
	completionLines.push(
		formatKeyValue("  Code Review Cycles", String(metrics.codeReviewCycles)),
	);

	// Token totals — surfaces cache effectiveness in the run summary.
	const usageTotals = metrics.agentCalls.reduce(
		(acc, c) => {
			if (!c.usage) return acc;
			acc.input += c.usage.input;
			acc.output += c.usage.output;
			acc.cacheRead += c.usage.cacheRead;
			acc.cacheWrite += c.usage.cacheWrite;
			acc.totalTokens += c.usage.totalTokens;
			acc.callsWithUsage += 1;
			return acc;
		},
		{
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			callsWithUsage: 0,
		},
	);
	if (usageTotals.callsWithUsage > 0) {
		const fmt = (n: number) => n.toLocaleString();
		const cacheableInput =
			usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite;
		const hitRate =
			cacheableInput > 0
				? `${Math.round((usageTotals.cacheRead / cacheableInput) * 100)}%`
				: "n/a";
		completionLines.push(
			formatKeyValue(
				"  Tokens (in/out)",
				`${fmt(usageTotals.input)} / ${fmt(usageTotals.output)}`,
			),
		);
		completionLines.push(
			formatKeyValue(
				"  Cache (read/write)",
				`${fmt(usageTotals.cacheRead)} / ${fmt(usageTotals.cacheWrite)} (hit ${hitRate})`,
			),
		);
	}

	if (state.worktree) {
		completionLines.push("");
		completionLines.push("  🌿 Worktree:");
		completionLines.push(formatKeyValue("  Branch", state.worktree.branch));
		completionLines.push(formatKeyValue("  Worktree", state.worktree.path));
	}

	completionLines.push("");
	completionLines.push("  📋 Next Steps:");
	if (state.worktree) {
		completionLines.push("     • cd " + state.worktree.path);
		completionLines.push("     • Review the implementation changes");
		if (projectConfig.testCommand) {
			completionLines.push("     • Run tests: " + projectConfig.testCommand);
		} else {
			completionLines.push("     • Run your project's test suite");
		}
		completionLines.push(
			"     • Merge: git merge " + state.worktree.branch + " (or open a PR)",
		);
		completionLines.push(
			"     • Cleanup: git worktree remove " + state.worktree.path,
		);
		completionLines.push(
			"     •           git branch -d " + state.worktree.branch,
		);
	} else {
		completionLines.push("     • Review the implementation changes");
		if (projectConfig.testCommand) {
			completionLines.push("     • Run tests: " + projectConfig.testCommand);
		} else {
			completionLines.push("     • Run your project's test suite");
		}
		completionLines.push(
			"     • Run /implement-metrics to export comparison data",
		);
	}
	completionLines.push("");
	completionLines.push(formatDivider(50));

	ctx.ui.notify(completionLines.join("\n"), "success");
}
