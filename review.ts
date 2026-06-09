/*
 * Review system for the spec pipeline - verdict parsing and single-model review.
 */

import type {
	ReviewVerdict,
	ReviewResult,
	ReviewerRole,
	ProjectConfig,
	SpecState,
	ImplementationState,
	HierarchyState,
	ModelConfig,
	AgentCallUsage,
	AgentOutputEvent,
	RoleName,
	EscalationReason,
} from "./types.ts";
import { runAgentWithConfig, createProgressCallback } from "./agents.ts";
import { runAgentWithEscalation } from "./escalation.ts";
import { getSessionLogDir } from "./state.ts";
import { createCheckpointAndSave, createAgentCommit } from "./git.ts";
import { handleAgentError } from "./errors.ts";

// Union type for states that have review-related fields
type ReviewableState = SpecState | ImplementationState | HierarchyState;

// ============================================
// Verdict Parsing
// ============================================

/**
 * Parse verdict from review output (R12, R13)
 * Returns NEEDS_CHANGES if no clear verdict is found (conservative behavior).
 *
 * Strategy:
 * 1. Anchor to an explicit verdict marker line (**Verdict**:, **Status**:, Verdict:, Status:).
 *    This avoids false positives when the body uses words like "approved" or
 *    "needs changes" in prose ("after fixing X, this would be APPROVED").
 * 2. Fall back to body-wide last-wins heuristic only when no marker is found.
 */
export function parseVerdict(output: string): ReviewVerdict {
	const normalized = output.toUpperCase();

	// Anchored marker: **Verdict**: X / **Status**: X / Verdict: X / Status: X
	// Use the LAST marker line (a re-emitted final verdict at the end of the
	// review wins over an earlier draft verdict).
	const markerRegex =
		/(?:\*\*\s*)?(?:VERDICT|STATUS)(?:\s*\*\*)?\s*:\s*([A-Z_ |/,]+)/g;
	let lastMarkerValue: string | undefined;
	let markerMatch: RegExpExecArray | null;
	while ((markerMatch = markerRegex.exec(normalized)) !== null) {
		lastMarkerValue = markerMatch[1].trim();
	}
	if (lastMarkerValue !== undefined) {
		const verdict = classifyVerdictToken(lastMarkerValue);
		if (verdict) return verdict;
	}

	// Fallback: body-wide heuristic (legacy behavior).
	const approvedMatch = normalized.match(/\bAPPROVED\b/);
	const needsChangesMatch = normalized.match(/\bNEEDS_CHANGES\b/);

	if (approvedMatch && needsChangesMatch) {
		const approvedIndex = normalized.lastIndexOf("APPROVED");
		const needsChangesIndex = normalized.lastIndexOf("NEEDS_CHANGES");
		return needsChangesIndex > approvedIndex ? "NEEDS_CHANGES" : "APPROVED";
	}
	if (approvedMatch) return "APPROVED";
	if (needsChangesMatch) return "NEEDS_CHANGES";

	if (
		normalized.includes("CHANGES_REQUESTED") ||
		normalized.includes("NEEDS_WORK") ||
		normalized.includes("NEEDS WORK")
	) {
		return "NEEDS_CHANGES";
	}
	if (normalized.includes("READY") && !normalized.includes("NEEDS")) {
		return "APPROVED";
	}
	return "NEEDS_CHANGES";
}

/**
 * Classify the captured value of a verdict marker (already upper-cased).
 * Returns undefined if the token is ambiguous so the caller can fall through.
 */
function classifyVerdictToken(token: string): ReviewVerdict | undefined {
	// Strip trailing punctuation and pipe-style alternatives ("APPROVED | NEEDS_CHANGES")
	// that the model sometimes parrots from the prompt template.
	const cleaned = token.replace(/[|/,.;:]+/g, " ").trim();
	const hasApproved = /\bAPPROVED\b/.test(cleaned);
	const hasNeedsChanges =
		/\b(NEEDS_CHANGES|NEEDS\s+CHANGES|CHANGES_REQUESTED|NEEDS_WORK|NEEDS\s+WORK)\b/.test(
			cleaned,
		);
	const hasReady = /\bREADY\b/.test(cleaned);

	if (hasApproved && hasNeedsChanges) return undefined; // template parrot — let caller decide
	if (hasNeedsChanges) return "NEEDS_CHANGES";
	if (hasApproved) return "APPROVED";
	if (hasReady) return "APPROVED";
	return undefined;
}

/** Check if review output mentions critical or major issues. */
export function hasSignificantIssues(output: string): boolean {
	const normalized = output.toUpperCase();
	return normalized.includes("CRITICAL") || normalized.includes("MAJOR");
}

// ============================================
// Context Types
// ============================================

export interface ReviewContext {
	cwd: string;
	projectConfig: ProjectConfig;
	systemPrompts: { [K in ReviewerRole]: string } & { addressReview: string };
	state: ReviewableState;
	saveFn: () => void;
	phaseIndex?: number;
	phaseName?: string;
	docName?: string;
	notify: (msg: string, type: "info" | "error" | "success" | "warning") => void;
	onOutput?: (event: AgentOutputEvent) => void;
	signal?: AbortSignal;
	sessionDir?: string;
	/**
	 * Optional callback invoked after every sub-agent run (review and fix).
	 * Lets the caller record the agent in its metrics so codeReviewer /
	 * addressReview show up alongside planDrafter / implementer.
	 */
	recordCall?: (info: {
		role: RoleName;
		modelConfig: ModelConfig;
		startTime: Date;
		exitCode: number;
		phase?: number;
		cycle: number;
		usage?: AgentCallUsage;
	}) => void;
	/**
	 * Optional callback invoked with the verbatim text the reviewer produced
	 * for each cycle. Useful for postmortems when the verdict surprises the
	 * user — the implementation state only retains `previousReview`, which is
	 * cleared between phases.
	 */
	recordReviewOutput?: (info: {
		role: RoleName;
		phase?: number;
		cycle: number;
		verdict: ReviewVerdict;
		output: string;
	}) => void;
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
}

export interface ReviewOperation {
	role: ReviewerRole;
	reviewTask: string;
	fixTask: (reviewOutput: string) => string;
	runAddressReviewOnSignificantIssues?: boolean;
}

// ============================================
// Review Execution
// ============================================

/**
 * Run a single-model review process.
 *
 * Flow:
 * 1. Review with configured reviewer model for N cycles.
 * 2. If NEEDS_CHANGES, apply fixes with addressReview.
 * 3. Repeat until APPROVED or max cycles reached.
 */
export async function runReview(
	ctx: ReviewContext,
	operation: ReviewOperation,
): Promise<ReviewResult> {
	const {
		cwd,
		projectConfig,
		systemPrompts,
		state,
		saveFn,
		phaseIndex,
		docName,
		notify,
		onOutput,
		signal,
		recordCall,
		recordReviewOutput,
	} = ctx;
	const {
		role,
		reviewTask,
		fixTask,
		runAddressReviewOnSignificantIssues = false,
	} = operation;
	const reviewerConfig = projectConfig.models[role];
	const addressReviewConfig = projectConfig.models.addressReview;
	const maxCycles = projectConfig.reviewCycles;
	const phaseCtx = phaseIndex !== undefined ? ` [Phase ${phaseIndex}]` : "";
	const roleEmoji = "💻";

	if (maxCycles === 0) {
		notify(`${roleEmoji} Skipping ${role} (cycles: 0)`, "info");
		return {
			verdict: "APPROVED",
			lastReviewOutput: "",
			cyclesCompleted: 0,
			hadError: false,
		};
	}

	let lastReviewOutput = "";
	let cyclesCompleted = 0;
	let misTierEscalated = false;
	(state as ImplementationState).reviewCyclesCompleted = 0;
	saveFn();

	notify(
		`${roleEmoji}${phaseCtx} Starting ${role} (${reviewerConfig.model}/${reviewerConfig.thinking}, cycles: ${maxCycles})`,
		"info",
	);

	for (let cycle = 1; cycle <= maxCycles; cycle++) {
		cyclesCompleted = cycle;
		(state as ImplementationState).reviewCyclesCompleted = cycle;
		saveFn();

		notify(`${phaseCtx} Review cycle ${cycle}/${maxCycles}`, "info");
		await createCheckpointAndSave(
			cwd,
			state,
			role,
			saveFn,
			phaseIndex,
			cycle,
			notify,
		);

		// Keep the user message byte-identical across cycles so prompt-cache prefixes
		// remain reusable. Earlier we appended a "continuing review after fixes" note
		// on cycle ≥ 2 — that broke cache for every later cycle. The reviewer can
		// observe applied fixes from git diff/status, so the note carries no signal
		// the agent doesn't already have.
		const reviewRun = await runAgentWithEscalation({
			baseConfig: reviewerConfig,
			escalatedConfig: ctx.escalation?.codeReviewerEscalated,
			maxEscalatedRetries: ctx.escalation?.hardFailureRetries ?? 0,
			role,
			task: reviewTask,
			cwd,
			systemPrompt: systemPrompts[role],
			signal,
			onOutput,
			sessionDir: ctx.sessionDir,
			onAttempt: ({ config, startTime, result }) => {
				recordCall?.({
					role,
					modelConfig: config,
					startTime,
					exitCode: result.exitCode,
					phase: phaseIndex,
					cycle,
					usage: result.usage,
				});
			},
			onEscalate: ({ fromModel, toModel }) => {
				ctx.escalation?.onEscalate?.({
					role,
					cycle,
					fromModel,
					toModel,
					reason: "hard_failure",
				});
			},
			notify,
		});
		const reviewResult = reviewRun.result;

		if (reviewRun.failureDescription) {
			await handleAgentError(
				cwd,
				state,
				reviewResult,
				reviewRun.config.model,
				role,
				reviewTask,
				phaseIndex,
				cycle,
				notify,
				saveFn,
			);
			return {
				verdict: "NEEDS_CHANGES",
				lastReviewOutput,
				cyclesCompleted,
				hadError: true,
			};
		}

		lastReviewOutput = reviewResult.output;
		const verdict = parseVerdict(lastReviewOutput);
		notify(
			`${phaseCtx} Review cycle ${cycle}/${maxCycles} verdict: ${verdict}`,
			"info",
		);

		recordReviewOutput?.({
			role,
			phase: phaseIndex,
			cycle,
			verdict,
			output: lastReviewOutput,
		});

		if (verdict === "APPROVED") {
			return {
				verdict: "APPROVED",
				lastReviewOutput,
				cyclesCompleted,
				hadError: false,
			};
		}

		// Apply fixes after NEEDS_CHANGES. Do this even on the last cycle so the
		// final tree reflects the latest feedback before proceeding.
		if (
			runAddressReviewOnSignificantIssues &&
			hasSignificantIssues(lastReviewOutput)
		) {
			notify(`${phaseCtx} Found significant issues - applying fix`, "info");
		}
		const escalatedFix = ctx.escalation?.addressReviewEscalated;
		const fixBase =
			cycle >= 2 && escalatedFix ? escalatedFix : addressReviewConfig;

		notify(`${phaseCtx} Applying fixes (${fixBase.model})...`, "info");

		// Mis-tier signal: the first cycle where the fix base differs from the
		// configured addressReview model. Fire onEscalate exactly once per run.
		if (fixBase !== addressReviewConfig && !misTierEscalated) {
			misTierEscalated = true;
			ctx.escalation?.onEscalate?.({
				role: "addressReview",
				cycle,
				fromModel: addressReviewConfig.model,
				toModel: escalatedFix!.model,
				reason: "review_cycles",
			});
		}

		const fixTaskText = fixTask(lastReviewOutput);
		const fixRun = await runAgentWithEscalation({
			baseConfig: fixBase,
			escalatedConfig:
				escalatedFix && fixBase !== escalatedFix ? escalatedFix : undefined,
			maxEscalatedRetries: ctx.escalation?.hardFailureRetries ?? 0,
			role: "addressReview",
			task: fixTaskText,
			cwd,
			systemPrompt: systemPrompts.addressReview,
			signal,
			onOutput,
			sessionDir: ctx.sessionDir,
			onAttempt: ({ config, startTime, result }) => {
				recordCall?.({
					role: "addressReview",
					modelConfig: config,
					startTime,
					exitCode: result.exitCode,
					phase: phaseIndex,
					cycle,
					usage: result.usage,
				});
			},
			onEscalate: ({ fromModel, toModel }) => {
				ctx.escalation?.onEscalate?.({
					role: "addressReview",
					cycle,
					fromModel,
					toModel,
					reason: "hard_failure",
				});
			},
			notify,
		});
		const fixResult = fixRun.result;
		const fixConfig = fixRun.config;

		if (fixRun.failureDescription) {
			await handleAgentError(
				cwd,
				state,
				fixResult,
				fixConfig.model,
				"addressReview",
				fixTaskText,
				phaseIndex,
				cycle,
				notify,
				saveFn,
			);
			return {
				verdict: "NEEDS_CHANGES",
				lastReviewOutput,
				cyclesCompleted,
				hadError: true,
			};
		}

		const commitResult = await createAgentCommit(
			cwd,
			state,
			{
				role: "addressReview",
				modelConfig: fixConfig,
				phase: phaseIndex,
				phaseName: ctx.phaseName,
				docName,
				cycle,
				reviewFeedback: lastReviewOutput,
			},
			projectConfig.models.agentCommitMessageWriter,
			saveFn,
			notify,
		);

		if (!commitResult.success) {
			notify(
				commitResult.usedFallback
					? "Commit message generation failed - fallback used. Pipeline aborted."
					: "Failed to create agent commit",
				"error",
			);
			return {
				verdict: "NEEDS_CHANGES",
				lastReviewOutput,
				cyclesCompleted,
				hadError: true,
			};
		}
	}

	notify(
		`${phaseCtx} Max review cycles reached - fixes applied, proceeding (cycles=${cyclesCompleted})`,
		"warning",
	);
	return {
		verdict: "NEEDS_CHANGES",
		lastReviewOutput,
		cyclesCompleted,
		hadError: false,
	};
}

// ============================================
// Retry Failed Operation
// ============================================

export async function retryFailedOperation(
	state: ReviewableState,
	cwd: string,
	projectConfig: ProjectConfig,
	saveFn: () => void,
	ctx: {
		ui: {
			notify: (
				msg: string,
				type: "info" | "error" | "success" | "warning",
			) => void;
			confirm: (title: string, message: string) => Promise<boolean>;
			setWidget?: (id: string, content: string[] | undefined) => void;
		};
	},
	escalation?: {
		config?: ModelConfig;
		onEscalate?: (info: {
			role: RoleName;
			fromModel: string;
			toModel: string;
			reason: "resume_retry";
		}) => void;
	},
): Promise<boolean> {
	const error = state.lastError;
	if (!error || typeof error === "string") return false;

	const { createSystemPrompts, buildPromptOptions } = await import(
		"./agents-config.ts"
	);
	const SYSTEM_PROMPTS = createSystemPrompts(buildPromptOptions(projectConfig));
	const systemPrompt =
		SYSTEM_PROMPTS[error.role as keyof typeof SYSTEM_PROMPTS];
	if (!systemPrompt) {
		ctx.ui.notify(`Unknown role: ${error.role}. Cannot retry.`, "error");
		return false;
	}

	await createCheckpointAndSave(
		cwd,
		state,
		`retry_${error.role}`,
		saveFn,
		error.phase,
		error.cycle,
		ctx.ui.notify.bind(ctx.ui),
	);
	ctx.ui.notify(`🔄 Retrying ${error.role}...`, "info");

	let modelConfig: ModelConfig;
	if (error.role === "codeReviewer") {
		modelConfig = projectConfig.models.codeReviewer;
	} else if (error.role === "commitMessageWriter") {
		modelConfig = projectConfig.models.agentCommitMessageWriter;
	} else {
		const nonReviewerRole = error.role as keyof Pick<
			typeof projectConfig.models,
			"planDrafter" | "implementer" | "addressReview"
		>;
		modelConfig = projectConfig.models[nonReviewerRole];
	}

	if (!modelConfig) {
		ctx.ui.notify(
			`No model configuration found for role: ${error.role}`,
			"error",
		);
		return false;
	}

	// Optional escalation: retry the failed operation at a higher tier when an
	// escalated config is supplied that actually differs from the resolved one.
	if (
		escalation?.config &&
		(escalation.config.model !== modelConfig.model ||
			escalation.config.thinking !== modelConfig.thinking)
	) {
		escalation.onEscalate?.({
			role: error.role as RoleName,
			fromModel: modelConfig.model,
			toModel: escalation.config.model,
			reason: "resume_retry",
		});
		ctx.ui.notify(
			`🔄 Retrying ${error.role} with escalated model ${escalation.config.model}...`,
			"info",
		);
		modelConfig = escalation.config;
	}

	const progressCallback = createProgressCallback(
		{
			ui: { notify: ctx.ui.notify, setWidget: ctx.ui.setWidget ?? (() => {}) },
		} as import("./types.ts").PipelineUIContext,
		state as import("./types.ts").ImplementationState,
		`Retry ${error.role}`,
		error.role !== "codeReviewer",
	);

	const result = await runAgentWithConfig(
		modelConfig,
		error.agentTask,
		cwd,
		systemPrompt,
		undefined,
		progressCallback,
		error.role,
		getSessionLogDir(cwd, state.id),
	);

	if (result.exitCode !== 0) {
		await handleAgentError(
			cwd,
			state,
			result,
			modelConfig.model,
			error.role,
			error.agentTask,
			error.phase,
			error.cycle,
			ctx.ui.notify.bind(ctx.ui),
			saveFn,
		);
		return false;
	}

	state.lastError = undefined;
	saveFn();
	ctx.ui.notify(`✅ Retry succeeded for ${error.role}`, "success");
	return true;
}
