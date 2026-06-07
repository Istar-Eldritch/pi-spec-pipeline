/**
 * Type definitions for the spec pipeline
 *
 * Split into two separate state types:
 * - SpecState: For spec creation (/spec command)
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
	// Hierarchy document roles (optional, fall back to planDrafter / codeReviewer)
	roadmapDrafter: Type.Optional(ModelConfigSchema),
	roadmapReviewer: Type.Optional(ModelConfigSchema),
	epicDrafter: Type.Optional(ModelConfigSchema),
	epicReviewer: Type.Optional(ModelConfigSchema),
	// commitMessageWriter allowed in config but silently ignore it per R5a
	commitMessageWriter: Type.Optional(Type.Any()),
});

// Review cycles configuration (allows 0 to skip code review)
export const ReviewCyclesConfigSchema = Type.Number({
	minimum: 0,
	maximum: 10,
});

// Full pipeline configuration schema
export const SpecPipelineConfigSchema = Type.Object({
	specsDir: Type.Optional(Type.String()),
	testCommand: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	contextFiles: Type.Optional(Type.Array(Type.String())),
	// Explicit paths to spec template and conventions files (overrides auto-discovery)
	specTemplatePath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	specConventionsPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	// Output format for generated specs: "md" (default) or file extension from template
	// Auto-detected from existing specs or template format when not specified
	specFormat: Type.Optional(Type.String()),
	models: Type.Optional(ModelsConfigSchema),
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
 * Metrics for spec creation pipelines
 */
export interface SpecMetrics {
	pipelineStartTime: string;
	pipelineEndTime?: string;
	totalDurationMs?: number;
	discoveryDurationMs?: number;
	specDraftingDurationMs?: number;
	agentCalls: AgentCallMetrics[];
	specReviewCycles: number;
	specIterations: number;
	discoverySkipped: boolean;
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
}

// ============================================
// Project Configuration
// ============================================

export interface ProjectConfig {
	specsDir: string;
	testCommand: string | null;
	contextFiles: string[];
	projectContext: string;
	/**
	 * Stripped projectContext for read-only roles (codeReviewer).
	 *
	 * Why: spec template/conventions and the testing instruction are dead weight
	 * for a code reviewer (it doesn't write specs and is told not to run tests).
	 * Stripping them shrinks the cached prompt prefix and removes signal that
	 * could mislead the reviewer.
	 */
	projectContextForReviewer: string;
	/**
	 * Stripped projectContext for roles that run tests but don't author specs
	 * (implementer, addressReview).
	 *
	 * Why: spec template/conventions are irrelevant to a coding agent applying
	 * a plan or fixing review feedback, but the test command line IS needed.
	 * Sits between projectContextForReviewer (no test) and projectContext (full).
	 */
	projectContextForFixer: string;
	// Spec template content (auto-discovered or from config)
	specTemplate: string | null;
	// Path to spec template file (for reference in prompts)
	specTemplatePath: string | null;
	// Spec conventions content (auto-discovered or from config)
	specConventions: string | null;
	// Path to spec conventions file (for reference in prompts)
	specConventionsPath: string | null;
	// Output format for generated specs (file extension without dot, e.g. "md", "typ")
	specFormat: string;
	// Model configurations per role
	models: {
		planDrafter: ModelConfig;
		implementer: ModelConfig;
		codeReviewer: ModelConfig;
		addressReview: ModelConfig;
		agentCommitMessageWriter: ModelConfig;
		roadmapDrafter: ModelConfig;
		roadmapReviewer: ModelConfig;
		epicDrafter: ModelConfig;
		epicReviewer: ModelConfig;
	};
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
	| "commitMessageWriter"
	| "brainstormAgent" // Role for tool restrictions (read-only for both old and new commit agents)
	| "roadmapDrafter"
	| "roadmapReviewer"
	| "epicDrafter"
	| "epicReviewer";

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
// Spec State Types
// ============================================

export type SpecStage =
	| "discovery"
	| "spec_drafting"
	| "spec_review"
	| "user_approval"
	| "completed"
	| "cancelled";

/**
 * A single exchange in conversational discovery (user message + assistant response)
 */
export interface ConversationalExchange {
	userMessage: string;
	assistantResponse: string;
	timestamp: string;
}

/**
 * A follow-up exchange inside a single discovery topic thread.
 */
export interface DiscoveryFollowUp {
	/** User's follow-up question about the active topic */
	userQuestion: string;
	/** Discovery agent's answer to that follow-up */
	agentAnswer: string;
	/** ISO timestamp for when the follow-up was recorded */
	timestamp: string;
}

/**
 * One complete or in-progress extension-driven discovery topic.
 */
export interface DiscoveryTopic {
	/** The original subagent assumption/question */
	question: string;
	/** Follow-up exchanges within this topic; empty for one-shot answers */
	followUps: DiscoveryFollowUp[];
	/** User's final confirmation/correction; null while the topic is open */
	decision: string | null;
	/** ISO timestamp for when the topic was opened */
	timestamp: string;
}

/**
 * Discovery stage state
 */
export interface DiscoveryState {
	/** Whether discovery was skipped via --quick flag */
	skipped: boolean;
	/** Accumulated discovery summary (synthesized from conversation) */
	discoverySummary: string;
	/** Whether discovery is complete (user chose to proceed) */
	completed: boolean;
	/** Conversational discovery exchanges; kept for legacy summary paths */
	conversationHistory?: ConversationalExchange[];
	/** Closed topics from the extension-driven discovery loop */
	topics?: DiscoveryTopic[];
	/** In-progress topic thread; null when no topic is pending */
	activeTopic?: DiscoveryTopic | null;
}

/**
 * Drafting stage state (for conversational drafting)
 */
export interface DraftingState {
	/** Conversation history for drafting phase */
	conversationHistory: ConversationalExchange[];
	/** Whether drafting is complete (user typed /spec-draft-done or /draft-done) */
	completed: boolean;
}

/**
 * Pipeline mode for the conversational extension state machine.
 * - idle: No active conversational mode
 * - scoping: Host LLM is acting as scoping agent (for /plan command)
 * - discovery: Host LLM is acting as discovery agent
 * - drafting: Host LLM is acting as spec drafter
 */
export type PipelineMode =
	| "idle"
	| "scoping"
	| "discovery"
	| "drafting"
	| "brainstorm";

/**
 * Ephemeral scoping state (not persisted to disk).
 * Tracks the scoping conversation during /plan to recommend a level.
 */
export interface ScopingState {
	/** Original description from /plan command */
	description: string;
	/** Whether --quick flag was passed */
	isQuick: boolean;
	/** Conversation history */
	conversationHistory: ConversationalExchange[];
	/** Recommended level parsed from agent output */
	recommendedLevel?: HierarchyLevel;
}

/**
 * Common interface for any pipeline state that supports conversational modes.
 * Both SpecState and HierarchyState (RoadmapState, EpicState) implement this.
 */
export interface ConversationalPipelineState {
	id: string;
	description: string;
	discovery?: DiscoveryState;
	drafting?: DraftingState;
}

/**
 * State for spec creation pipelines (/spec command)
 * Stored in .pi/spec-pipeline/specs/<id>/state.json
 */
export interface SpecState {
	id: string;
	description: string;
	stage: SpecStage;
	createdAt: string;
	updatedAt: string;

	// Stage before cancellation (for resume)
	stageBeforeCancellation?: SpecStage;

	// Discovery state
	discovery?: DiscoveryState;

	// Drafting state (conversational mode)
	drafting?: DraftingState;

	// Spec-related state
	specTimestamp: string; // YYMMDDhhmm format
	specFilename: string;
	specPath: string;
	specDraft: string;
	specApproved: boolean;
	specIteration: number;

	// Git state
	checkpoints?: string[]; // Array of commit hashes
	errorStash?: string; // Stash reference if error occurred

	// Error tracking
	lastError?: ErrorDetails | string; // string for legacy compatibility

	// Metrics
	metrics?: SpecMetrics;
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
export const SPEC_STATE_DIR = ".pi/spec-pipeline/specs";
export const IMPL_STATE_DIR = ".pi/spec-pipeline/implementations";
export const BRAINSTORM_STATE_DIR = ".pi/spec-pipeline/brainstorms";
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
// Hierarchy Types (Roadmaps & Epics)
// ============================================

/** Document types in the hierarchy */
export type HierarchyLevel = "roadmap" | "epic" | "feature";

/** Stages for roadmap/epic pipelines */
export type HierarchyStage =
	| "scoping" // /plan scoping assessment
	| "discovery"
	| "drafting"
	| "review"
	| "user_approval"
	| "approved" // Approved, children can be created
	| "in_progress" // At least one child started
	| "completed"
	| "cancelled";

/** A child item extracted from a roadmap/epic document */
export interface ChildItem {
	/** Sequential number within parent (1-indexed) */
	number: number;
	/** Name/title of the child item */
	name: string;
	/** Description of the child item */
	description: string;
	/** Priority: High, Medium, Low */
	priority: "High" | "Medium" | "Low";
	/** Dependencies as item numbers within same parent */
	dependencies: number[];
	/** Reference to the child pipeline once created */
	childPipelineId?: string;
	/** Type of child pipeline */
	childPipelineType?: HierarchyLevel;
	/** Status of the child (derived from child pipeline state) */
	childStatus?: "pending" | "in_progress" | "completed" | "cancelled";
}

/** State for roadmap pipelines */
export interface RoadmapState {
	id: string;
	level: "roadmap";
	description: string;
	stage: HierarchyStage;
	createdAt: string;
	updatedAt: string;

	// Stage before cancellation (for resume)
	stageBeforeCancellation?: HierarchyStage;

	// Discovery state (reuses existing DiscoveryState)
	discovery?: DiscoveryState;

	// Drafting state (reuses existing DraftingState)
	drafting?: DraftingState;

	// Document details
	docTimestamp: string; // YYMMDDhhmm format
	docFilename: string; // e.g. "2602071200_roadmap_warm_pools.md"
	docPath: string; // relative path to document
	docContent: string; // current document content
	docApproved: boolean;
	docIteration: number;

	// Child items (extracted from document after approval)
	children: ChildItem[];

	// Git state
	checkpoints?: string[];
	errorStash?: string;

	// Error tracking
	lastError?: ErrorDetails | string;

	// Metrics (reuses SpecMetrics structure)
	metrics?: SpecMetrics;
}

/** State for epic pipelines */
export interface EpicState {
	id: string;
	level: "epic";
	description: string;
	stage: HierarchyStage;
	createdAt: string;
	updatedAt: string;

	// Stage before cancellation (for resume)
	stageBeforeCancellation?: HierarchyStage;

	// Parent reference (optional — epic can be standalone)
	parentId?: string;
	parentType?: "roadmap";

	// Discovery state
	discovery?: DiscoveryState;

	// Drafting state
	drafting?: DraftingState;

	// Document details
	docTimestamp: string;
	docFilename: string;
	docPath: string;
	docContent: string;
	docApproved: boolean;
	docIteration: number;

	// Child items (features extracted from document after approval)
	children: ChildItem[];

	// Git state
	checkpoints?: string[];
	errorStash?: string;

	// Error tracking
	lastError?: ErrorDetails | string;

	// Metrics
	metrics?: SpecMetrics;
}

/** Union type for any hierarchy state */
export type HierarchyState = RoadmapState | EpicState;

/** State directories for hierarchy types */
export const ROADMAP_STATE_DIR = ".pi/spec-pipeline/roadmaps";
export const EPIC_STATE_DIR = ".pi/spec-pipeline/epics";

// ============================================
// Brainstorm Types
// ============================================

/** Stages for brainstorm pipelines */
export type BrainstormStage = "brainstorming" | "completed" | "cancelled";

/**
 * State for brainstorm pipelines (/brainstorm command)
 * Stored in .pi/spec-pipeline/brainstorms/<id>.json
 */
export interface BrainstormState {
	id: string;
	description: string;
	stage: BrainstormStage;
	createdAt: string;
	updatedAt: string;

	// Stage before cancellation (for potential future resume)
	stageBeforeCancellation?: BrainstormStage;

	// Document details
	docTimestamp: string; // YYMMDDhhmm format
	docFilename: string; // e.g. "2602171119_brainstorm_billing_redesign.md"
	docPath: string; // relative path to document
	docContent: string; // written at completion

	// Conversation history
	conversationHistory: ConversationalExchange[];

	// Git state
	checkpoints?: string[];

	// Error tracking
	lastError?: string;
}

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
