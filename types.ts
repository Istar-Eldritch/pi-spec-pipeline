/**
 * Type definitions for the spec pipeline
 *
 * State type:
 * - ImplementationState: For implementation (/implement command)
 */

import { Type, type Static } from "@sinclair/typebox";

// ============================================
// Model Configuration Schemas
// ============================================

export const ModelNameSchema = Type.String({ minLength: 1 });

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("high"),
	Type.Literal("medium"),
	Type.Literal("low"),
	Type.Literal("minimal"),
	Type.Literal("off"),
]);

export const ModelConfigSchema = Type.Object({
	model: ModelNameSchema,
	thinking: ThinkingLevelSchema,
	// Per-role override for the streaming idle-timeout watchdog (ms). 0 disables.
	streamIdleTimeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
	// Some models (e.g. Ollama-hosted models) reject conversations where pi
	// injects the appended system prompt as an assistant-role prefill. Set to
	// "inline" to prepend the system prompt into the task string instead, keeping
	// the conversation as a plain [system] -> [user] exchange.
	systemPromptMode: Type.Optional(
		Type.Union([Type.Literal("append"), Type.Literal("inline")]),
	),
});

// Full models configuration schema
// NOTE: commitMessageWriter is explicitly included as optional Type.Any() to allow
// it in config but silently ignore it per R5a. Using Type.Any() means any value
// is accepted but we never use it.
export const ModelsConfigSchema = Type.Object({
	planDrafter: Type.Optional(ModelConfigSchema),
	implementer: Type.Optional(ModelConfigSchema),
	codeReviewer: Type.Optional(ModelConfigSchema),
	addressReview: Type.Optional(ModelConfigSchema),
	// agentCommitMessageWriter for commits after agent operations (R5)
	agentCommitMessageWriter: Type.Optional(ModelConfigSchema),
	// commitMessageWriter allowed in config but silently ignore it per R5a
	commitMessageWriter: Type.Optional(Type.Any()),
});

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

// Review cycles configuration (allows 0 to skip code review)
export const ReviewCyclesConfigSchema = Type.Number({
	minimum: 0,
	maximum: 10,
});

// Additional properties silently ignored for backward compatibility with configs
// that still contain removed fields (e.g. specTemplate, roadmapDrafter).
// Full pipeline configuration schema
export const SpecPipelineConfigSchema = Type.Object({
	testCommand: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	contextFiles: Type.Optional(Type.Array(Type.String())),
	models: Type.Optional(ModelsConfigSchema),
	tiers: Type.Optional(TiersConfigSchema),
	escalation: Type.Optional(EscalationConfigSchema),
	reviewCycles: Type.Optional(ReviewCyclesConfigSchema),
	// Experimental: skip plan generation phase (go directly from spec to implementation)
	skipPlanGeneration: Type.Optional(Type.Boolean()),
	// Project-level default for the streaming idle-timeout watchdog (ms). 0 disables.
	// Per-role values in `models.<role>.streamIdleTimeoutMs` take precedence.
	streamIdleTimeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
});

// ============================================
// Type Exports
// ============================================

export type ModelConfig = Static<typeof ModelConfigSchema>;
export type ModelsConfig = Static<typeof ModelsConfigSchema>;
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type ReviewCyclesConfig = Static<typeof ReviewCyclesConfigSchema>;
export type TierName = Static<typeof TierNameSchema>;
export type TiersConfig = Static<typeof TiersConfigSchema>;
export type EscalationConfig = Static<typeof EscalationConfigSchema>;

// Normalized review cycle count used internally
export type NormalizedReviewCycles = number;

// ============================================
// Metrics Types
// ============================================

/**
 * Token usage totals for one agent call. Aggregated across all assistant
 * messages emitted during the run. Useful for diagnosing cache behavior:
 * `cacheRead` should dominate `input` once the prefix is stable.
 */
export interface AgentCallUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

/**
 * Metrics for a single agent call
 */
export interface AgentCallMetrics {
	role: RoleName;
	model: string;
	thinking: ThinkingLevel;
	startTime: string; // ISO timestamp
	endTime: string; // ISO timestamp
	durationMs: number; // Wall clock duration
	exitCode: number;
	phase?: number; // Phase index if applicable
	cycle?: number; // Review cycle if applicable
	usage?: AgentCallUsage; // Token usage if reported by the subprocess
}

/**
 * Metrics for implementation pipelines (for A/B testing plan generation)
 */
export interface ImplementationMetrics {
	pipelineStartTime: string;
	pipelineEndTime?: string;
	totalDurationMs?: number;
	planGenerationDurationMs?: number;
	implementationDurationMs?: number;
	agentCalls: AgentCallMetrics[];
	codeReviewCycles: number;
	codeReviewFirstPassRate: number;
	skipPlanGeneration: boolean;
	escalations?: number;
}

// ============================================
// Project Configuration
// ============================================

export interface ProjectConfig {
	testCommand: string | null;
	contextFiles: string[];
	projectContext: string;
	/**
	 * Stripped projectContext for read-only roles (codeReviewer).
	 *
	 * Why: the testing instruction is dead weight for a code reviewer
	 * (it doesn't run tests). Stripping it shrinks the cached prompt prefix
	 * and removes signal that could mislead the reviewer.
	 */
	projectContextForReviewer: string;
	/**
	 * Stripped projectContext for roles that run tests but don't author specs
	 * (implementer, addressReview).
	 *
	 * Why: the test command line IS needed but spec-specific content is not.
	 * Sits between projectContextForReviewer (no test) and projectContext (full).
	 */
	projectContextForFixer: string;
	// Model configurations per role
	models: {
		planDrafter: ModelConfig;
		implementer: ModelConfig;
		codeReviewer: ModelConfig;
		addressReview: ModelConfig;
		agentCommitMessageWriter: ModelConfig;
	};
	tiers?: TiersConfig;
	escalation: { enabled: boolean; hardFailureRetries: number };
	// Code review cycle count. Setting to 0 skips code review entirely.
	reviewCycles: NormalizedReviewCycles;
	// Experimental: skip plan generation (go directly from spec to implementation)
	skipPlanGeneration: boolean;
	// Project-level default for streaming idle-timeout watchdog (ms). undefined → fall back to env / 90s.
	streamIdleTimeoutMs?: number;
	// True when models were not configured and the pipeline is falling back to
	// the user's current/default model (omitting --model/--thinking on subagent calls).
	usingDefaultModels?: boolean;
}

// ============================================
// Error Handling Types
// ============================================

export type ErrorType =
	| "RATE_LIMIT"
	| "TIMEOUT"
	| "NETWORK"
	| "VALIDATION"
	| "TOKEN_LIMIT"
	| "INCOMPLETE"
	| "MODEL_COMPAT"
	| "UNKNOWN";

export type RoleName =
	| "planDrafter"
	| "implementer"
	| "codeReviewer"
	| "addressReview"
	| "agentCommitMessageWriter"
	| "commitMessageWriter";

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

export interface ErrorDetails {
	timestamp: string; // ISO timestamp of error
	agent: AgentName; // Which agent failed
	role: RoleName; // Which role was executing
	phase?: number; // Phase index (1-indexed, if in implementation stage)
	cycle?: number; // Review cycle (1-indexed, if in implementation stage)
	exitCode: number; // Subprocess exit code
	stderr?: string; // Error output from subprocess (truncated to 2000 chars)
	errorType: ErrorType; // Classified error type
	agentTask: string; // The exact task prompt sent to the agent
	finishReason?: string; // Provider/model finish reason if available
	completed?: boolean; // Whether the agent reported normal completion
}

// ============================================
// Implementation State Types
// ============================================

export type ImplementationStage =
	| "plan_generation"
	| "implementation"
	| "completed"
	| "cancelled";

/**
 * State for implementation pipelines (/implement command)
 * Stored in .pi/spec-pipeline/implementations/<id>/state.json
 */
export interface ImplementationState {
	id: string;
	implTimestamp: string; // YYMMDDhhmm format for this implementation
	specPath: string; // Path to the spec file being implemented
	specContent: string; // Cached spec content at start
	stage: ImplementationStage;
	createdAt: string;
	updatedAt: string;

	// Stage before cancellation (for resume)
	stageBeforeCancellation?: ImplementationStage;

	// Phases state
	phases: string[];
	/**
	 * Per-phase difficulty parsed from the spec's phase table (optional
	 * Difficulty column). Aligned with `phases`. Absent on older states
	 * and when the spec has no difficulty markers — treated as "standard".
	 */
	phaseDifficulties?: PlanDifficulty[];
	phasesGenerated: boolean[];
	currentPhaseIndex: number;

	// Implementation state (per phase)
	currentReviewCycle: number;
	previousReview: string;

	// Review state
	reviewCyclesCompleted?: number;

	// Resume tracking
	implementerCompletedForPhase?: boolean;

	// Commit tracking
	phaseCommits: boolean[][]; // phaseCommits[phaseIdx][cycleIdx]

	// Git state
	checkpoints?: string[];
	errorStash?: string;

	// Escalation audit trail for this run (also appended to .pi/spec-pipeline/escalations.log)
	escalations?: EscalationRecord[];

	// Error tracking
	lastError?: ErrorDetails | string;

	// Flags
	skipPlanGeneration?: boolean;

	// Metrics
	metrics?: ImplementationMetrics;
}

// ============================================
// Agent Types
// ============================================

export type AgentName = string;

export interface AgentResult {
	output: string;
	exitCode: number;
	error?: string;
	completed?: boolean;
	finishReason?: string;
	stopReason?: string;
	limitHit?: boolean;
	usage?: AgentCallUsage;
}

// ============================================
// Review Types
// ============================================

/**
 * Review verdict types
 */
export type ReviewVerdict = "APPROVED" | "NEEDS_CHANGES";

/**
 * Result from a review process
 */
export interface ReviewResult {
	/** Final verdict from the review process */
	verdict: ReviewVerdict;
	/** Output from the last review */
	lastReviewOutput: string;
	/** Number of review cycles completed */
	cyclesCompleted: number;
	/** Whether the process was interrupted by an error */
	hadError: boolean;
}

/** Reviewer role name */
export type ReviewerRole = "codeReviewer";

// ============================================
// UI Context Types
// ============================================

/** UI context type for widget functions */
export type WidgetUIContext = {
	ui: {
		setWidget: (id: string, content: string[] | undefined) => void;
	};
};

/** Full UI context for pipeline operations */
export interface PipelineUIContext {
	ui: {
		notify: (
			msg: string,
			type: "info" | "error" | "success" | "warning",
		) => void;
		confirm: (title: string, msg: string) => Promise<boolean>;
		editor: (title: string, initial: string) => Promise<string | undefined>;
		select: (title: string, options: Array<string>) => Promise<string>;
		setWidget: (id: string, content: string[] | undefined) => void;
	};
}

// ============================================
// Constants
// ============================================

export const STATE_DIR = ".pi/spec-pipeline";
export const IMPL_STATE_DIR = ".pi/spec-pipeline/implementations";
export const STATE_FILE = "state.json";
export const MAX_SPEC_ITERATIONS = 5;
export const PIPELINE_WIDGET_ID = "spec-pipeline-status";

// Roles that need write/edit access to modify files
export const WRITE_ROLES = new Set(["implementer", "addressReview"]);
// Roles that only need to read and analyze (no write/edit access)
export const READ_ONLY_ROLES = new Set([
	"planDrafter",
	"codeReviewer",
	"commitMessageWriter",
]);

// ============================================
// Agent Progress Event Types
// ============================================

/**
 * Data structure for tool invocation events from pi subprocess
 */
export interface ToolEventData {
	type: "tool";
	name: string;
	arguments: Record<string, any>;
}

/**
 * Data structure for text delta events from pi subprocess (legacy)
 */
export interface TextEventData {
	type: "text";
	delta: string;
}

/**
 * Union type for agent output events
 *
 * Supports both legacy string callbacks and structured event data:
 * - `string`: Text delta from agent output (backward compatible)
 * - `TextEventData`: Structured text delta with explicit type
 * - `ToolEventData`: Tool invocation events (name, arguments)
 *
 * **Type Narrowing Example:**
 * ```typescript
 * function handleOutput(event: AgentOutputEvent) {
 *     if (typeof event === "string") {
 *         // Legacy text delta
 *     } else if (event.type === "tool") {
 *         // Tool invocation: event.name, event.arguments
 *     } else if (event.type === "text") {
 *         // Structured text: event.delta
 *     }
 * }
 * ```
 *
 * @since Phase 1 - Event parsing infrastructure
 * @see Phase 2 will introduce progress callbacks that leverage ToolEventData
 */
export type AgentOutputEvent = TextEventData | ToolEventData | string;
