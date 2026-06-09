/**
 * Spec Pipeline Extension
 *
 * Split into two separate workflows:
 *
 * SPEC CREATION (/spec):
 *   1. Discovery (optional): Conversational — LLM proposes assumptions one at a time for user to confirm
 *   2. Spec Drafting: Conversational — user guides LLM to write specification
 *   3. User Approval: User approves, requests revisions, or cancels
 *   4. User reviews and approves the spec
 *
 * HIERARCHY (/roadmap, /epic):
 *   1. Discovery (optional): Conversational — LLM proposes assumptions one at a time for user to confirm
 *   2. Drafting: Conversational — user guides LLM to write document
 *   3. User Approval: User approves, requests revisions, or cancels
 *   4. Child extraction (auto-parses child items table from document)
 *   5. User reviews and approves the document
 *
 * IMPLEMENTATION (/implement):
 *   1. Takes EITHER a spec file path OR a description as input
 *      - File path: Reads spec and starts implementation
 *      - Description: Enters discovery mode → writes summary → starts implementation
 *   2. Discovery (if using description): Conversational — LLM proposes assumptions
 *   3. For each implementation phase (plan + implement interleaved):
 *      - Plan Drafting: GPT-5.5 drafts implementation plan
 *      - Implementation: GPT-5.5 implements according to plan
 *      - Code Review: GPT-5.4 reviews implementation
 *   3. User reviews the implementation
 *
 * Usage:
 *   /plan <description>                             # Conversational scoping → recommends roadmap/epic/spec
 *   /plan-done                                      # Accept or override scoping recommendation
 *   /plan-cancel                                    # Cancel scoping session
 *   /plan --roadmap <description>                   # Skip scoping, create roadmap
 *   /plan --epic <description>                      # Skip scoping, create epic
 *   /plan --feature <description>                   # Skip scoping, create feature spec
 *
 *   /roadmap <description>                          # Create a roadmap (→ epics)
 *   /roadmap-resume                                 # Resume roadmap pipeline
 *   /roadmap-status                                 # Show roadmap status
 *   /roadmap-list                                   # List roadmaps
 *   /roadmap-cancel                                 # Cancel roadmap pipeline
 *
 *   /epic <description>                             # Create an epic (→ feature specs)
 *   /epic --roadmap <id> <description>              # Create epic linked to roadmap
 *   /epic-resume                                    # Resume epic pipeline
 *   /epic-status                                    # Show epic status
 *   /epic-list                                      # List epics
 *   /epic-cancel                                    # Cancel epic pipeline
 *
 *   /plan-overview [id]                             # Show full hierarchy tree
 *
 *   /spec <description>                             # Start spec creation
 *   /spec --quick <description>                     # Skip discovery phase
 *   /spec-resume                                    # Resume spec creation
 *   /spec-status                                    # Show spec status
 *   /spec-list                                      # List spec pipelines
 *   /spec-cancel                                    # Cancel spec pipeline
 *
 *   /implement <spec-path|description>              # Start implementation (file or discovery)
 *   /implement --no-plan <spec-path|description>    # Skip plan generation
 *   /implement --no-review <spec-path|description>  # Skip reviews
 *   /implement-resume                               # Resume implementation
 *   /implement-status                               # Show implementation status
 *   /implement-list                                 # List implementations
 *   /implement-cancel                               # Cancel implementation
 *   /implement-metrics [id]                         # Export metrics
 *
 * Configuration:
 *   Create .pi/spec-pipeline.json in your project root (same config for both)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// Import types
import type {
	SpecState,
	ImplementationState,
	RoadmapState,
	EpicState,
	HierarchyState,
	HierarchyLevel,
	ConversationalExchange,
	DiscoveryTopic,
	ProjectConfig,
	PipelineMode,
	ScopingState,
	ConversationalPipelineState,
	BrainstormState,
} from "./types.ts";

// Import config
import { loadPipelineConfig } from "./config.ts";

// Import state management
import {
	loadSpecState,
	saveSpecState,
	listSpecStates,
	getLatestActiveSpecPipeline,
	loadImplState,
	saveImplState,
	listImplStates,
	getLatestActiveImplPipeline,
	loadRoadmapState,
	saveRoadmapState,
	listRoadmapStates,
	getLatestActiveRoadmapPipeline,
	loadEpicState,
	saveEpicState,
	listEpicStates,
	getLatestActiveEpicPipeline,
	loadBrainstormState,
	saveBrainstormState,
	listBrainstormStates,
	getLatestActiveBrainstormPipeline,
	createInitialBrainstormState,
	createInitialRoadmapState,
	createInitialEpicState,
	generateTimestamp,
	generatePipelineId,
	createInitialSpecState,
	createInitialImplState,
	getStateDir,
	getSpecStateDir,
	getImplStateDir,
	getSessionLogDir,
	generateConversationalDiscoverySummary,
} from "./state.ts";

// Import git operations
import {
	validateGitRepo,
	checkGitClean,
	stashExists,
	dropStash,
	createAgentCommit,
} from "./git.ts";

// Import error handling
import {
	getErrorEmoji,
	getErrorSuggestion,
	formatErrorForRetry,
	formatErrorBox,
	truncateString,
} from "./errors.ts";

// Import formatting
import {
	formatStepBanner,
	formatEffectiveConfig,
	formatSpecStage,
	formatImplStage,
	formatHierarchyStage,
	formatSpecState,
	formatImplState,
	formatRoadmapState,
	formatEpicState,
	formatDivider,
	formatKeyValue,
	updateSpecWidget,
	updateImplWidget,
	clearPipelineWidget,
} from "./formatting.ts";

// Import agents

// Import review
import { retryFailedOperation } from "./review.ts";
import { runAgentWithConfig } from "./agents.ts";

// Import pipelines
import { runSpecPipeline } from "./spec-pipeline.ts";
import { runImplementPipeline, extractPhases } from "./implement-pipeline.ts";
import { runHierarchyPipeline } from "./hierarchy-pipeline.ts";

// Import system prompts
import { createSystemPrompts, buildPromptOptions } from "./agents-config.ts";

// ============================================
// Helpers
// ============================================

/** Common stop words for generating short names from descriptions */
const STOP_WORDS = new Set([
	// Articles, pronouns, determiners
	"a",
	"an",
	"the",
	"i",
	"we",
	"you",
	"it",
	"he",
	"she",
	"they",
	"me",
	"us",
	"my",
	"our",
	"your",
	"their",
	"its",
	"his",
	"her",
	"this",
	"that",
	"these",
	"those",
	"some",
	"any",
	"all",
	"each",
	"every",
	"no",
	"not",
	// Be/have/do verbs
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"having",
	"do",
	"does",
	"did",
	"done",
	"doing",
	// Modal/auxiliary verbs
	"will",
	"would",
	"can",
	"could",
	"should",
	"may",
	"might",
	"must",
	"shall",
	// Common action verbs (too generic for naming)
	"want",
	"need",
	"like",
	"go",
	"get",
	"got",
	"let",
	"lets",
	"put",
	"set",
	"take",
	"give",
	"tell",
	"say",
	"said",
	"know",
	"see",
	"look",
	"find",
	"use",
	"used",
	"using",
	"try",
	"keep",
	"start",
	"run",
	"work",
	"call",
	"come",
	"think",
	"also",
	"just",
	"even",
	"still",
	"way",
	"more",
	"much",
	"many",
	"less",
	"most",
	"only",
	"already",
	"now",
	"here",
	"there",
	// Spec/dev action verbs (user intent, not content)
	"add",
	"create",
	"make",
	"build",
	"implement",
	"write",
	"spec",
	"plan",
	"design",
	"develop",
	"setup",
	"configure",
	"update",
	"modify",
	"change",
	"fix",
	"address",
	"handle",
	"support",
	"enable",
	"allow",
	"ensure",
	"improve",
	"optimize",
	"optimise",
	"refactor",
	"introduce",
	"provide",
	// Prepositions and conjunctions
	"to",
	"for",
	"of",
	"in",
	"on",
	"at",
	"by",
	"up",
	"out",
	"off",
	"from",
	"into",
	"with",
	"about",
	"between",
	"through",
	"after",
	"before",
	"and",
	"or",
	"but",
	"so",
	"if",
	"then",
	"than",
	"when",
	"where",
	"how",
	// Filler words
	"new",
	"thing",
	"stuff",
	"feature",
	"functionality",
	"ability",
	"something",
	"everything",
	"nothing",
	"really",
	"very",
	"quite",
	"please",
	"thanks",
	"hey",
	"ok",
	"okay",
	"sure",
	"right",
]);

function generateShortName(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((word) => word.length > 1 && !STOP_WORDS.has(word))
			.slice(0, 4)
			.join("_") || "spec"
	);
}

/**
 * Prompt the user for a short name, with the auto-generated one as default.
 * Returns { shortName }.
 */
async function promptForShortName(
	ctx: {
		ui: {
			input: (
				title: string,
				placeholder?: string,
			) => Promise<string | undefined>;
		};
	},
	description: string,
): Promise<{ shortName: string }> {
	const suggested = generateShortName(description);
	const userInput = await ctx.ui.input(
		"Short name (used for file names):",
		suggested,
	);
	// Sanitize whatever the user typed (or use suggested if they cancelled/left empty)
	const raw = userInput && userInput.trim() ? userInput.trim() : suggested;
	const shortName =
		raw
			.toLowerCase()
			.replace(/[^a-z0-9\s_-]/g, "")
			.replace(/[\s-]+/g, "_")
			.replace(/^_+|_+$/g, "") || "spec";
	return { shortName };
}

export default function (pi: ExtensionAPI) {
	// ============================================
	// UNIFIED CONVERSATIONAL MODE STATE
	// ============================================

	/** Current pipeline mode: idle, scoping, discovery, or drafting */
	let pipelineMode: PipelineMode = "idle";

	/** The pipeline state for the active conversational session (spec or hierarchy) */
	let activePipelineState: ConversationalPipelineState | null = null;

	/** Which kind of pipeline is active: "spec", "hierarchy", "implement", or "brainstorm" */
	let activePipelineKind:
		| "spec"
		| "hierarchy"
		| "implement"
		| "brainstorm"
		| null = null;

	/** Hierarchy level when activePipelineKind === "hierarchy" */
	let activeHierarchyLevel: HierarchyLevel | null = null;

	/** Parent context string for hierarchy pipelines (roadmap context, scoping context, etc.) */
	let activeParentContext: string | undefined;

	/** Function to persist the active pipeline state */
	let activeStateSaveFn: (() => void) | null = null;

	/** The cwd for the active conversational session */
	let activeCwd: string = "";

	/** The project config for the active conversational session */
	let activeProjectConfig: ProjectConfig | null = null;

	/** Ephemeral scoping state for /plan command (not persisted) */
	let activeScopingState: ScopingState | null = null;

	/** Active brainstorm state (persisted to disk) */
	let activeBrainstormState: BrainstormState | null = null;

	/** Tracks the last user message for pairing with assistant response */
	let lastUserMessage: string = "";

	/** Number of conversation exchanges in current mode */
	let exchangeCount = 0;

	// Extension-driven discovery topic loop state
	/** True while the extension is running the structured Q&A loop for discovery */
	let discoveryLoopActive = false;
	/** Closed topics accumulated during the current extension-driven discovery loop */
	let discoveryTopics: DiscoveryTopic[] = [];
	/** The active topic the extension just injected — waiting for the user's decision/follow-up */
	let activeDiscoveryTopic: DiscoveryTopic | null = null;
	/** AbortController for the in-flight discovery subagent call */
	let discoveryLoopAbort: AbortController | null = null;

	function discoveryTopicToExchange(
		topic: DiscoveryTopic,
	): ConversationalExchange {
		return {
			userMessage: topic.decision ?? "(No final decision recorded)",
			assistantResponse: topic.question,
			timestamp: topic.timestamp,
		};
	}

	function persistDiscoveryLoopState(): void {
		if (!activePipelineState?.discovery) return;
		activePipelineState.discovery.topics = discoveryTopics;
		activePipelineState.discovery.activeTopic = activeDiscoveryTopic;
		activeStateSaveFn?.();
	}

	function syncDiscoveryTopicsToState(
		includeActiveTopic: boolean = false,
	): void {
		if (!activePipelineState?.discovery) return;

		const topicsToPersist = [...discoveryTopics];
		if (includeActiveTopic && activeDiscoveryTopic) {
			topicsToPersist.push(activeDiscoveryTopic);
		}

		activePipelineState.discovery.topics = topicsToPersist;
		activePipelineState.discovery.activeTopic = null;
		activePipelineState.discovery.conversationHistory = topicsToPersist.map(
			discoveryTopicToExchange,
		);
		exchangeCount = activePipelineState.discovery.conversationHistory.length;
		activeStateSaveFn?.();
	}

	function resetDiscoveryLoopState(): void {
		discoveryLoopActive = false;
		discoveryTopics = [];
		activeDiscoveryTopic = null;
		if (discoveryLoopAbort) {
			discoveryLoopAbort.abort();
			discoveryLoopAbort = null;
		}
	}

	function trimIncompleteFollowUps(topic: DiscoveryTopic): DiscoveryTopic {
		const followUps = [...topic.followUps];
		while (
			followUps.length > 0 &&
			followUps[followUps.length - 1].agentAnswer.trim().length === 0
		) {
			followUps.pop();
		}
		return { ...topic, followUps };
	}

	function previewDiscoveryTopic(question: string): string {
		const normalized = question.trim().replace(/\s+/g, " ");
		if (normalized.length <= 80) return normalized;
		return `${normalized.slice(0, 80)}…`;
	}

	function restoreSpecDiscoveryLoopFromState(state: SpecState): boolean {
		const persistedTopics = state.discovery?.topics ?? [];
		const restoredActiveTopic = state.discovery?.activeTopic
			? trimIncompleteFollowUps(state.discovery.activeTopic)
			: null;

		const hasPersistedLoopState =
			persistedTopics.length > 0 || restoredActiveTopic !== null;

		if (!hasPersistedLoopState) {
			resetDiscoveryLoopState();
			return false;
		}

		discoveryLoopActive = true;
		discoveryTopics = persistedTopics;
		activeDiscoveryTopic = restoredActiveTopic;
		persistDiscoveryLoopState();
		return true;
	}

	type DiscoveryReplyClassification = "followup" | "decision";

	function isUnambiguousDiscoveryDecision(reply: string): boolean {
		const normalized = reply
			.trim()
			.toLowerCase()
			.replace(/[.!]+$/g, "")
			.replace(/\s+/g, " ");

		if (!normalized) return false;
		if (normalized.includes("?")) return false;

		const oneWordDecisions = new Set([
			"yes",
			"yep",
			"yeah",
			"correct",
			"confirmed",
			"confirm",
			"ok",
			"okay",
			"sure",
			"no",
			"nope",
		]);

		if (oneWordDecisions.has(normalized)) return true;

		return /^(yes|yep|yeah|correct|confirmed|confirm|ok|okay|sure|sounds good|no|nope)\b/.test(
			normalized,
		);
	}

	function buildDiscoveryReplyClassifierSystemPrompt(
		topic: DiscoveryTopic,
		reply: string,
	): string {
		const followUpContext =
			topic.followUps.length > 0
				? `\n## Supporting Thread So Far\n\n${topic.followUps
						.map(
							(f, i) =>
								`Follow-up ${i + 1}\nUser: ${f.userQuestion}\nDiscovery Agent: ${f.agentAnswer}`,
						)
						.join("\n\n")}\n`
				: "";

		return `You are classifying a user reply during requirements discovery.

## Active Topic

${topic.question}
${followUpContext}
## User Reply

${reply}

## Classification Rules

Output exactly one word: FOLLOWUP or DECISION.

- FOLLOWUP: the reply asks a question, requests more information, asks for examples/tradeoffs, or otherwise keeps exploring this same topic.
- DECISION: the reply confirms, rejects, corrects, constrains, or closes the topic, even if the decision is partial.

Output only FOLLOWUP or DECISION. No punctuation. No explanation.`;
	}

	async function classifyDiscoveryReply(
		reply: string,
		topic: DiscoveryTopic,
		projectConfig: ProjectConfig,
		cwd: string,
		signal: AbortSignal,
	): Promise<DiscoveryReplyClassification> {
		if (isUnambiguousDiscoveryDecision(reply)) {
			return "decision";
		}

		try {
			const result = await runAgentWithConfig(
				projectConfig.models.agentCommitMessageWriter,
				"Classify whether this discovery reply is a follow-up question or a final decision.",
				cwd,
				buildDiscoveryReplyClassifierSystemPrompt(topic, reply),
				signal,
				undefined,
				"commitMessageWriter",
				activePipelineState ? getSessionLogDir(cwd, activePipelineState.id) : undefined,
			);

			const normalized = result.output.trim().toUpperCase();
			if (normalized === "FOLLOWUP") return "followup";
			if (normalized === "DECISION") return "decision";
		} catch {
			// Conservative fallback: preserve pre-feature behavior if classification fails.
		}

		return "decision";
	}

	function buildDiscoveryFollowUpSystemPrompt(
		state: ConversationalPipelineState,
		projectConfig: ProjectConfig,
		topic: DiscoveryTopic,
		currentFollowUpQuestion: string,
		parentContext?: string,
	): string {
		const { projectContext } = projectConfig;

		const previousFollowUps = topic.followUps
			.filter((followUp) => followUp.agentAnswer.trim().length > 0)
			.map(
				(followUp, i) =>
					`Follow-up ${i + 1}\nUser: ${followUp.userQuestion}\nDiscovery Agent: ${followUp.agentAnswer}`,
			)
			.join("\n\n");

		const previousFollowUpsBlock = previousFollowUps
			? `\n## Previous Follow-ups in This Topic\n\n${previousFollowUps}\n`
			: "";

		const parentBlock = parentContext
			? `\n## Parent Context\n\n${parentContext}\n`
			: "";

		const scopingBlock = state.discovery?.discoverySummary
			? `\n## Prior Scoping Context\n\n${state.discovery.discoverySummary}\n`
			: "";

		return `You are a requirements discovery expert answering a user's follow-up question inside an active discovery topic.\n\n${projectContext}${scopingBlock}${parentBlock}\n## Feature Being Explored\n\n${state.description}\n\n## Active Discovery Topic\n\n${topic.question}\n${previousFollowUpsBlock}\n## User's Current Follow-up Question\n\n${currentFollowUpQuestion}\n\n## Instructions\n\n- Answer only this follow-up question in the context of the active discovery topic.\n- You may explore the codebase with read, bash, grep, find, and ls to ground your answer.\n- Explain relevant tradeoffs, codebase constraints, and options that help the user decide this topic.\n- Do NOT ask or propose a new unrelated discovery topic.\n- Do NOT output READY_TO_DRAFT.\n- End by inviting the user to either ask another follow-up or give their final confirmation/correction for this same topic.\n`;
	}

	/** Pending scoping context from /plan → feature route, consumed by next /spec invocation */
	let pendingScopingContext: string | undefined;

	/** Flags for implement-discovery sessions (--no-plan, --no-review)
	 * NOTE: Ephemeral (not persisted to disk) because discovery is conversational.
	 * Flags are applied after /discovery-done when creating the implementation state. */
	let pendingImplementFlags: { noPlan: boolean; noReview: boolean } | null =
		null;

	/** Short name for implement-discovery session
	 * NOTE: Ephemeral (not persisted) - cleared on mode exit */
	let pendingImplementShortName: string | null = null;

	/** Timestamp for implement-discovery session
	 * NOTE: Ephemeral (not persisted) - cleared on mode exit */
	let pendingImplementTimestamp: string | null = null;

	/** Helper to get the active state as SpecState (only valid when activePipelineKind === "spec") */
	function getActiveSpecState(): SpecState | null {
		return activePipelineKind === "spec"
			? (activePipelineState as SpecState)
			: null;
	}

	/** Helper to get the active state as HierarchyState (only valid when activePipelineKind === "hierarchy") */
	function getActiveHierarchyState(): HierarchyState | null {
		return activePipelineKind === "hierarchy"
			? (activePipelineState as HierarchyState)
			: null;
	}

	/**
	 * Enter scoping mode (no pipeline state, just ephemeral scoping)
	 */
	function enterScopingMode(
		cwd: string,
		projectConfig: ProjectConfig,
		scopingState: ScopingState,
	): void {
		pipelineMode = "scoping";
		activePipelineState = null;
		activePipelineKind = null;
		activeHierarchyLevel = null;
		activeParentContext = undefined;
		activeStateSaveFn = null;
		activeCwd = cwd;
		activeProjectConfig = projectConfig;
		activeScopingState = scopingState;
		lastUserMessage = "";
		exchangeCount = scopingState.conversationHistory.length;
	}

	/**
	 * Enter discovery or drafting mode for a spec pipeline
	 */
	function enterSpecMode(
		mode: "discovery" | "drafting",
		state: SpecState,
		cwd: string,
		projectConfig: ProjectConfig,
	): void {
		pipelineMode = mode;
		activePipelineState = state;
		activePipelineKind = "spec";
		activeHierarchyLevel = null;
		activeParentContext = undefined;
		activeStateSaveFn = () => saveSpecState(cwd, state);
		activeCwd = cwd;
		activeProjectConfig = projectConfig;
		activeScopingState = null;
		lastUserMessage = "";
		exchangeCount =
			mode === "discovery"
				? (state.discovery?.conversationHistory?.length ?? 0)
				: (state.drafting?.conversationHistory?.length ?? 0);
	}

	/**
	 * Enter discovery or drafting mode for a hierarchy pipeline (roadmap/epic)
	 */
	function enterHierarchyMode(
		mode: "discovery" | "drafting",
		state: HierarchyState,
		level: HierarchyLevel,
		cwd: string,
		projectConfig: ProjectConfig,
		parentContext?: string,
	): void {
		pipelineMode = mode;
		activePipelineState = state;
		activePipelineKind = "hierarchy";
		activeHierarchyLevel = level;
		activeParentContext = parentContext;
		activeStateSaveFn = () => {
			if (state.level === "roadmap")
				saveRoadmapState(cwd, state as RoadmapState);
			else saveEpicState(cwd, state as EpicState);
		};
		activeCwd = cwd;
		activeProjectConfig = projectConfig;
		activeScopingState = null;
		lastUserMessage = "";
		exchangeCount =
			mode === "discovery"
				? (state.discovery?.conversationHistory?.length ?? 0)
				: (state.drafting?.conversationHistory?.length ?? 0);
	}

	/**
	 * Enter discovery mode for an implement pipeline (no persistent state, just ephemeral discovery)
	 */
	function enterImplementDiscoveryMode(
		cwd: string,
		projectConfig: ProjectConfig,
		discoveryState: ConversationalPipelineState,
		flags: { noPlan: boolean; noReview: boolean },
		shortName: string,
		timestamp: string,
	): void {
		pipelineMode = "discovery";
		activePipelineState = discoveryState;
		activePipelineKind = "implement";
		activeHierarchyLevel = null;
		activeParentContext = undefined;
		activeStateSaveFn = null; // No persistence for implement-discovery
		activeCwd = cwd;
		activeProjectConfig = projectConfig;
		activeScopingState = null;
		lastUserMessage = "";
		exchangeCount = discoveryState.discovery?.conversationHistory?.length ?? 0;

		// Store flags and metadata for use at /discovery-done
		pendingImplementFlags = flags;
		pendingImplementShortName = shortName;
		pendingImplementTimestamp = timestamp;
	}

	/**
	 * Enter brainstorm mode
	 */
	function enterBrainstormMode(
		cwd: string,
		projectConfig: ProjectConfig,
		brainstormState: BrainstormState,
	): void {
		pipelineMode = "brainstorm";
		activePipelineState = null;
		activePipelineKind = "brainstorm";
		activeHierarchyLevel = null;
		activeParentContext = undefined;
		activeStateSaveFn = null;
		activeCwd = cwd;
		activeProjectConfig = projectConfig;
		activeScopingState = null;
		activeBrainstormState = brainstormState;
		lastUserMessage = "";
		exchangeCount = brainstormState.conversationHistory.length;
	}

	/**
	 * Helper to get the active brainstorm state (only valid when activePipelineKind === "brainstorm")
	 */
	function getActiveBrainstormState(): BrainstormState | null {
		return activePipelineKind === "brainstorm" ? activeBrainstormState : null;
	}

	/**
	 * Exit any conversational mode and return to idle
	 */
	function exitMode(): { exchangeCount: number } {
		const result = { exchangeCount };
		pipelineMode = "idle";
		activePipelineState = null;
		activePipelineKind = null;
		activeHierarchyLevel = null;
		activeParentContext = undefined;
		activeStateSaveFn = null;
		activeScopingState = null;
		activeBrainstormState = null;
		activeCwd = "";
		activeProjectConfig = null;
		lastUserMessage = "";
		exchangeCount = 0;
		// Clear implement-discovery ephemeral state
		pendingImplementFlags = null;
		pendingImplementShortName = null;
		pendingImplementTimestamp = null;
		// Clear discovery loop state
		resetDiscoveryLoopState();
		return result;
	}

	/**
	 * Build the unified discovery system prompt injection for before_agent_start.
	 * This turns the host LLM into a discovery agent for any pipeline type.
	 *
	 * @param state - The conversational pipeline state (spec, hierarchy, or implement)
	 * @param projectConfig - The project configuration
	 * @param doneCommand - Command to tell user (e.g., "/discovery-done")
	 * @param sessionLabel - Label for the session type (e.g., "Spec", "Implementation", "Roadmap")
	 * @param nextStep - What happens after discovery (e.g., "proceed to spec drafting", "proceed to implementation")
	 * @param parentContext - Optional parent context for hierarchy pipelines
	 * @returns The discovery system prompt injection string
	 */
	function buildUnifiedDiscoveryPrompt(
		state: ConversationalPipelineState,
		projectConfig: ProjectConfig,
		doneCommand: string,
		sessionLabel: string,
		nextStep: string,
		parentContext?: string,
	): string {
		const SYSTEM_PROMPTS = createSystemPrompts(
			buildPromptOptions(projectConfig),
		);
		const discoveryPrompt = SYSTEM_PROMPTS.discoveryAgent;

		let conversationContext = "";
		if (
			state.discovery?.conversationHistory &&
			state.discovery.conversationHistory.length > 0
		) {
			conversationContext = "\n\n## Previous Discovery Exchanges\n\n";
			for (const exchange of state.discovery.conversationHistory) {
				conversationContext += `**User**: ${exchange.userMessage}\n\n`;
				conversationContext += `**You**: ${exchange.assistantResponse}\n\n---\n\n`;
			}
		}

		const scopingSection = state.discovery?.discoverySummary
			? `\n\n## Prior Context\n\nThe following context was gathered before this discovery session:\n\n${state.discovery.discoverySummary}\n`
			: "";

		const parentSection = parentContext
			? `\n\n## Parent Context\n\n${parentContext}\n`
			: "";

		return `
${discoveryPrompt}

## Active ${sessionLabel} Discovery Session

You are currently conducting a discovery session for:

${state.description}
${scopingSection}${parentSection}${conversationContext}

## Instructions

- Explore the project using read, bash, grep, find, ls tools — USE THEM
- Reference specific files and patterns you find
- Present ONE assumption at a time — propose the most likely solution, explain your reasoning, and ask the user to confirm or correct
- The user will respond naturally — adapt based on their feedback and move to the next topic
- When you feel you have enough context, tell the user they can type ${doneCommand} to ${nextStep}
${state.discovery?.discoverySummary ? "- Prior context is available above — factor it in but don't skip exploring the codebase" : ""}

IMPORTANT: You are in DISCOVERY MODE.
- Do NOT write specs, plans, or code.
- Do NOT enter plan mode or implementation mode — even if the host environment offers it.
- Do NOT produce implementation designs, architecture diagrams, or phase breakdowns.
- If the user says "yes", "sounds good", or otherwise confirms an assumption, move to the NEXT assumption — do not treat it as approval to implement.
- If the user asks you to proceed, start planning, or implement, tell them to type ${doneCommand} instead.
- Your only valid outputs are: (a) one assumption proposal, (b) a request for clarification, or (c) the instruction to type ${doneCommand} when discovery is complete.
`;
	}

	/**
	 * Build the system prompt for a single extension-driven discovery question.
	 * The agent must output either:
	 *   - A single question/assumption (free text)
	 *   - The exact token READY_TO_DRAFT on its own line when it has enough context
	 */
	function buildDiscoveryQuestionSystemPrompt(
		state: ConversationalPipelineState,
		projectConfig: ProjectConfig,
		topics: DiscoveryTopic[],
		parentContext?: string,
	): string {
		const { projectContext } = projectConfig;

		const historyBlock =
			topics.length > 0
				? `\n## Discovery So Far\n\n${topics
						.map((topic, i) => {
							const followUps =
								topic.followUps.length > 0
									? `\nFollow-ups:\n${topic.followUps.map((f, j) => `- F${j + 1} Q: ${f.userQuestion}\n  F${j + 1} A: ${f.agentAnswer}`).join("\n")}`
									: "";
							return `Topic ${i + 1}: ${topic.question}\nDecision ${i + 1}: ${topic.decision ?? "(open)"}${followUps}`;
						})
						.join("\n\n")}\n`
				: "";

		const scopingBlock = state.discovery?.discoverySummary
			? `\n## Prior Scoping Context\n\n${state.discovery.discoverySummary}\n`
			: "";

		const parentBlock = parentContext
			? `\n## Parent Context\n\n${parentContext}\n`
			: "";

		return `You are a requirements discovery expert.\n\n${projectContext}${scopingBlock}${parentBlock}\n## Task\n\nFeature being explored: ${state.description}\n${historyBlock}\n## Instructions\n\nSTEP 1 — Audit "Discovery So Far" (if present):\nBefore exploring anything, internally list each topic and its decision. Treat every sub-point a prior decision addressed as SETTLED, even if the prior question bundled several sub-questions and the user's answer covered them in one paragraph. Do not re-open settled sub-points.\n\nSTEP 2 — Explore the codebase (read, bash, grep, find, ls) to find the next genuine ambiguity that is NOT already settled.\n\nSTEP 3 — Output ONE of the following:\n\n1. ONE single clarifying question or assumption proposal, grounded in codebase evidence.\n   Format it as a short prose paragraph — state your assumption, explain your reasoning in 1-2 sentences, then ask the user to confirm or correct.\n\n2. The exact token READY_TO_DRAFT on its own line — only when you have gathered enough context to write a thorough spec.\n\nHARD RULES — violations cause the discovery loop to repeat itself:\n- ONE question only. Not two. Not "a few key questions". Not a numbered list of sub-questions. Not bullet points enumerating concerns. If you find yourself writing "1.", "2.", "a)", "b)", or phrases like "a few questions", "several things", "to scope this" — STOP and pick the SINGLE most important one.\n- Do NOT bundle related concerns under one topic header. Pick the most important sub-concern and ask only about that one; the others can come on later turns if still relevant.\n- Do NOT ask a question that is the same OR materially equivalent to ANY topic already in "Discovery So Far", even if the prior answer was brief ("yes", "no") or covered multiple sub-parts in one sentence.\n- If the prior decision addressed your intended question even partially, pick a different ambiguity or emit READY_TO_DRAFT.\n- If you cannot find a genuinely new ambiguity after exploring, emit READY_TO_DRAFT.\n\nOutput ONLY the single-question prose OR the token READY_TO_DRAFT. Nothing else.`;
	}

	async function runFollowUpStep(
		ctx: any,
		followUpQuestion: string,
		topicAtStart: DiscoveryTopic,
	): Promise<void> {
		if (!activePipelineState || !activeCwd || !activeProjectConfig) return;
		if (!discoveryLoopActive || activeDiscoveryTopic !== topicAtStart) return;
		if (activePipelineKind !== "spec") return;

		const state = activePipelineState;
		const cwd = activeCwd;
		const projectConfig = activeProjectConfig;

		const followUp = {
			userQuestion: followUpQuestion,
			agentAnswer: "",
			timestamp: new Date().toISOString(),
		};

		activeDiscoveryTopic.followUps.push(followUp);
		persistDiscoveryLoopState();

		ctx.ui.notify(
			"🔎 Exploring this follow-up in the current topic...",
			"info",
		);

		const followUpAbort = new AbortController();
		discoveryLoopAbort = followUpAbort;

		try {
			const result = await runAgentWithConfig(
				projectConfig.models.planDrafter,
				`Answer a discovery follow-up for: ${state.description}`,
				cwd,
				buildDiscoveryFollowUpSystemPrompt(
					state,
					projectConfig,
					topicAtStart,
					followUpQuestion,
					activeParentContext,
				),
				followUpAbort.signal,
				undefined,
				"brainstormAgent",
				getSessionLogDir(cwd, state.id),
			);

			if (discoveryLoopAbort === followUpAbort) {
				discoveryLoopAbort = null;
			}

			// If /discovery-done, /spec-cancel, or another state transition happened while
			// the subagent was running, do not mutate or notify stale topic state.
			if (!discoveryLoopActive || activeDiscoveryTopic !== topicAtStart) {
				return;
			}

			const answer = result.output.trim();
			followUp.agentAnswer = answer || "(Discovery agent returned no answer.)";
			persistDiscoveryLoopState();

			if (!answer && result.error) {
				console.error(
					"[spec-pipeline] Discovery follow-up error:",
					result.error,
				);
			}

			pi.sendMessage({
				customType: "spec-discovery-qa",
				content: `💬 Follow-up answer\n\n${followUp.agentAnswer}${result.error ? "\n\n⚠️ Error: " + result.error.split("\n")[0] : ""}\n\n➔ Ask another follow-up or give your final confirmation/correction for this topic:`,
				display: true,
			});
		} catch (error) {
			if (discoveryLoopAbort === followUpAbort) {
				discoveryLoopAbort = null;
			}

			if (!discoveryLoopActive || activeDiscoveryTopic !== topicAtStart) {
				return;
			}

			// Preserve a clean resumable topic: the user can retry by asking again, and
			// the state file will not contain a permanent empty-answer placeholder.
			activeDiscoveryTopic.followUps = activeDiscoveryTopic.followUps.filter(
				(entry) => entry !== followUp,
			);
			persistDiscoveryLoopState();

			ctx.ui.notify(
				"Discovery follow-up agent failed. The topic is still open; ask again or type /discovery-done to proceed.",
				"warning",
			);
		}
	}

	/**
	 * Run one step of the extension-driven discovery loop.
	 * Calls the discovery subagent, then either injects the question into the
	 * conversation (awaiting user answer) or transitions to drafting if READY_TO_DRAFT.
	 */
	async function runDiscoveryStep(
		ctx: any,
		sessionLabel: string,
		nextStep: string,
	): Promise<void> {
		if (!activePipelineState || !activeCwd || !activeProjectConfig) return;

		const state = activePipelineState;
		const cwd = activeCwd;
		const projectConfig = activeProjectConfig;

		ctx.ui.notify(`🔍 Exploring codebase to form next question...`, "info");

		discoveryLoopAbort = new AbortController();
		const systemPrompt = buildDiscoveryQuestionSystemPrompt(
			state,
			projectConfig,
			discoveryTopics,
			activeParentContext,
		);

		if (process.env.SPEC_DISCOVERY_DEBUG) {
			try {
				const dumpDir = path.join(
					cwd,
					".pi",
					"spec-pipeline",
					"discovery-debug",
				);
				fs.mkdirSync(dumpDir, { recursive: true });
				const ts = new Date().toISOString().replace(/[:.]/g, "-");
				fs.writeFileSync(
					path.join(dumpDir, `q${discoveryTopics.length + 1}-${ts}.md`),
					`# Discovery prompt for question ${discoveryTopics.length + 1}\n\nTopics in history: ${discoveryTopics.length}\n\n---\n\n${systemPrompt}\n`,
				);
			} catch (e) {
				console.error("[spec-pipeline] discovery debug dump failed:", e);
			}
		}

		const result = await runAgentWithConfig(
			projectConfig.models.planDrafter,
			`Conduct one step of requirements discovery for: ${state.description}`,
			cwd,
			systemPrompt,
			discoveryLoopAbort.signal,
			undefined,
			"brainstormAgent",
			getSessionLogDir(cwd, state.id),
		);
		discoveryLoopAbort = null;

		if (!result.output.trim()) {
			const errorDetail = result.error
				? `\n\nDetails: ${result.error.split("\n")[0].slice(0, 200)}`
				: result.exitCode !== 0
					? `\n\nExit code: ${result.exitCode}${result.finishReason ? ` (finish reason: ${result.finishReason})` : ""}`
					: "";
			console.error(
				"[spec-pipeline] Discovery step empty output. error=",
				result.error,
				"exitCode=",
				result.exitCode,
				"finishReason=",
				result.finishReason,
			);
			pi.sendMessage({
				customType: "spec-discovery-qa",
				content:
					"⚠️ Discovery agent returned empty output." +
					`${errorDetail}\n\n` +
					"Type /discovery-done to proceed.",
				display: true,
			});
			return;
		}

		const output = result.output.trim();

		if (output === "READY_TO_DRAFT") {
			syncDiscoveryTopicsToState(false);

			ctx.ui.notify(
				`✅ Discovery complete (${discoveryTopics.length} questions). Transitioning to ${nextStep}...`,
				"success",
			);
			discoveryLoopActive = false;
			activeDiscoveryTopic = null;

			// Trigger the same transition that /discovery-done uses
			await handleDiscoveryDone(ctx, sessionLabel);
			return;
		}

		// It's a question — append as a custom message so it persists in the
		// session and renders conversationally, but filter it from LLM context
		// so the host agent does not react to it.
		activeDiscoveryTopic = {
			question: output,
			followUps: [],
			decision: null,
			timestamp: new Date().toISOString(),
		};
		persistDiscoveryLoopState();

		pi.sendMessage({
			customType: "spec-discovery-qa",
			content: `💬 Question ${discoveryTopics.length + 1}\n\n${output}\n\n➔ Type your answer below:`,
			display: true,
		});
	}

	/**
	 * Shared handler for completing discovery — called both by /discovery-done
	 * and automatically when the agent signals READY_TO_DRAFT.
	 */
	async function handleDiscoveryDone(
		ctx: any,
		sessionLabel: string,
	): Promise<void> {
		if (
			pipelineMode !== "discovery" ||
			!activePipelineKind ||
			!activePipelineState ||
			!activeCwd ||
			!activeProjectConfig
		) {
			ctx.ui.notify("No active discovery session.", "error");
			return;
		}

		discoveryLoopActive = false;
		activeDiscoveryTopic = null;
		if (discoveryLoopAbort) {
			discoveryLoopAbort.abort();
			discoveryLoopAbort = null;
		}

		if (activePipelineKind === "spec") {
			await endDiscoveryAndStartDrafting(ctx);
		} else {
			// Delegate to the existing /discovery-done handler for hierarchy/implement
			// by invoking the shared endDiscoveryForKind logic inline
			// (for now: fall through to the existing handler which re-checks state)
		}
	}

	/**
	 * Build the spec drafting system prompt injection for before_agent_start.
	 * This turns the host LLM into a spec drafter.
	 */
	function buildDraftingPromptInjection(
		state: SpecState,
		projectConfig: ProjectConfig,
	): string {
		const SYSTEM_PROMPTS = createSystemPrompts(
			buildPromptOptions(projectConfig),
		);
		const specDrafterPrompt = SYSTEM_PROMPTS.specDrafter;

		const fullSpecPath = path.join(activeCwd, state.specPath);

		const discoveryContext = state.discovery?.discoverySummary
			? `\n\n## Discovery Context\n\nThe following requirements were gathered during discovery:\n\n${state.discovery.discoverySummary}\n`
			: "";

		let draftingHistory = "";
		if (
			state.drafting?.conversationHistory &&
			state.drafting.conversationHistory.length > 0
		) {
			draftingHistory = `\n\n## Drafting Progress\n\nYou have had ${state.drafting.conversationHistory.length} exchanges with the user while drafting this spec.\n`;
		}

		return `
${specDrafterPrompt}

## Active Spec Drafting Session

You are drafting a technical specification for this feature:

${state.description}
${discoveryContext}${draftingHistory}

## Spec File Details

- **Spec timestamp**: ${state.specTimestamp}
- **Spec file path**: ${fullSpecPath}
- **Iteration**: ${state.specIteration + 1}

## Instructions

- You have FULL tool access: read, bash, edit, write, grep, find, ls
- Explore the codebase to understand existing patterns and conventions
- Write the spec to the EXACT path above using the write tool
- The user will guide you conversationally — follow their instructions
- If the user asks you to focus on specific areas, adjust the spec accordingly
- When the user is satisfied, they will type /spec-draft-done to proceed

${state.specIteration > 0 ? `This is iteration ${state.specIteration + 1}. Read the existing spec file and revise it based on the conversation.` : "This is the first draft. Create the spec from scratch."}

IMPORTANT: You are in SPEC DRAFTING MODE. Focus on creating/refining the specification. Do NOT implement code.
`;
	}

	/**
	 * Build the scoping system prompt injection for before_agent_start.
	 * This turns the host LLM into a scoping agent for /plan.
	 */
	function buildScopingPromptInjection(
		scopingState: ScopingState,
		projectConfig: ProjectConfig,
	): string {
		const SYSTEM_PROMPTS = createSystemPrompts(
			buildPromptOptions(projectConfig),
		);
		const scopingPrompt = SYSTEM_PROMPTS.scopingAgent;

		let conversationContext = "";
		if (scopingState.conversationHistory.length > 0) {
			conversationContext = "\n\n## Previous Scoping Exchanges\n\n";
			for (const exchange of scopingState.conversationHistory) {
				conversationContext += `**User**: ${exchange.userMessage}\n\n`;
				conversationContext += `**You**: ${exchange.assistantResponse}\n\n---\n\n`;
			}
		}

		return `
${scopingPrompt}

## Active Scoping Session

You are assessing the scope of this request:

${scopingState.description}

${conversationContext}

## Instructions

- Explore the codebase to understand the scope of impact
- Ask targeted scoping questions ONE AT A TIME to understand the scope (never batch multiple questions in a single message)
- Based on the answers and your codebase exploration, recommend a level: roadmap, epic, or feature
- When you have enough information, present your recommendation clearly:
  - Start a line with "**Recommended Level**: roadmap" or "**Recommended Level**: epic" or "**Recommended Level**: feature"
  - Provide a brief justification
  - If roadmap or epic, sketch what the child items might look like
- Tell the user they can type /plan-done to accept or override your recommendation

IMPORTANT: You are in SCOPING MODE. Do NOT write specs, plans, or code. Only assess scope and recommend the right planning level.
`;
	}

	/**
	 * Build a summary of the scoping conversation for forwarding to child pipelines.
	 */
	function buildScopingSummary(scopingState: ScopingState): string {
		if (scopingState.conversationHistory.length === 0) {
			return "";
		}

		const sections: string[] = [];
		sections.push("## Scoping Context\n");
		sections.push(
			"The following information was gathered during a scoping assessment:\n",
		);

		for (let i = 0; i < scopingState.conversationHistory.length; i++) {
			const exchange = scopingState.conversationHistory[i];
			sections.push(`### Exchange ${i + 1}\n`);
			sections.push(`**User**: ${exchange.userMessage}\n`);
			sections.push(`**Scoping Agent**: ${exchange.assistantResponse}\n`);
			sections.push("---\n");
		}

		return sections.join("\n");
	}

	/**
	 * Parse the recommended level from the scoping agent's conversation.
	 * Looks for "**Recommended Level**: roadmap|epic|feature" in the last few exchanges.
	 */
	function parseRecommendedLevel(
		scopingState: ScopingState,
	): HierarchyLevel | null {
		// Search from the most recent exchange backwards
		for (let i = scopingState.conversationHistory.length - 1; i >= 0; i--) {
			const response = scopingState.conversationHistory[i].assistantResponse;
			// Match patterns like "**Recommended Level**: roadmap" or "Recommended Level: feature"
			const match = response.match(
				/\*?\*?Recommended\s+Level\*?\*?\s*:\s*(roadmap|epic|feature)/i,
			);
			if (match) {
				return match[1].toLowerCase() as HierarchyLevel;
			}
		}
		return null;
	}

	/**
	 * Build the drafting system prompt injection for hierarchy pipelines (roadmap/epic).
	 * This turns the host LLM into a roadmap/epic drafter.
	 */
	function buildHierarchyDraftingPromptInjection(
		state: HierarchyState,
		level: HierarchyLevel,
		projectConfig: ProjectConfig,
		parentContext?: string,
	): string {
		const SYSTEM_PROMPTS = createSystemPrompts(
			buildPromptOptions(projectConfig),
		);
		const drafterPrompt =
			level === "roadmap"
				? SYSTEM_PROMPTS.roadmapDrafter
				: SYSTEM_PROMPTS.epicDrafter;

		const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
		const fullDocPath = path.join(activeCwd, state.docPath);

		const discoveryContext = state.discovery?.discoverySummary
			? `\n\n## Discovery Context\n\nThe following requirements were gathered during discovery:\n\n${state.discovery.discoverySummary}\n`
			: "";

		const parentSection = parentContext
			? `\n\n## Parent Context\n\n${parentContext}\n`
			: "";

		let draftingHistory = "";
		if (
			state.drafting?.conversationHistory &&
			state.drafting.conversationHistory.length > 0
		) {
			draftingHistory = `\n\n## Drafting Progress\n\nYou have had ${state.drafting.conversationHistory.length} exchanges with the user while drafting this ${level}.\n`;
		}

		return `
${drafterPrompt}

## Active ${levelLabel} Drafting Session

You are drafting a ${level} document for:

${state.description}
${discoveryContext}${parentSection}${draftingHistory}

## Document File Details

- **Document timestamp**: ${state.docTimestamp}
- **Document file path**: ${fullDocPath}
- **Iteration**: ${state.docIteration + 1}

## Instructions

- You have FULL tool access: read, bash, edit, write, grep, find, ls
- Explore the codebase to understand existing patterns and project structure
- Write the ${level} document to the EXACT path above using the write tool
- The user will guide you conversationally — follow their instructions
- If the user asks you to focus on specific areas, adjust the document accordingly
- When the user is satisfied, they will type /draft-done to proceed to approval

${state.docIteration > 0 ? `This is iteration ${state.docIteration + 1}. Read the existing document file and revise it based on the conversation.` : `This is the first draft. Create the ${level} document from scratch.`}

IMPORTANT: You are in ${levelLabel.toUpperCase()} DRAFTING MODE. Focus on creating/refining the ${level} document. Do NOT implement code.
`;
	}

	/**
	 * Build the brainstorm system prompt injection for before_agent_start.
	 * This turns the host LLM into a brainstorming thought partner.
	 */
	function buildBrainstormPromptInjection(
		brainstormState: BrainstormState,
		projectConfig: ProjectConfig,
	): string {
		const SYSTEM_PROMPTS = createSystemPrompts(
			buildPromptOptions(projectConfig),
		);
		const brainstormPrompt = SYSTEM_PROMPTS.brainstormAgent;

		let conversationContext = "";
		if (brainstormState.conversationHistory.length > 0) {
			conversationContext = "\n\n## Previous Brainstorm Exchanges\n\n";
			for (const exchange of brainstormState.conversationHistory) {
				conversationContext += `**User**: ${exchange.userMessage}\n\n`;
				conversationContext += `**You**: ${exchange.assistantResponse}\n\n---\n\n`;
			}
		}

		const fullDocPath = path.join(activeCwd, brainstormState.docPath);

		return `
${brainstormPrompt}

## Active Brainstorm Session

You are brainstorming the following topic:

${brainstormState.description}
${conversationContext}

## Session Details

- **Document timestamp**: ${brainstormState.docTimestamp}
- **Document file path**: ${fullDocPath}

## Instructions

- Explore the codebase freely using read, bash, grep, find, ls tools
- Focus each message on ONE concept or problem — you may explore multiple angles within it, but don't jump between unrelated topics
- Ask open-ended questions that expand the design space within the current topic
- Surface tradeoffs, risks, and opportunities the user may not have considered
- Do NOT write specifications, plans, or code — only explore ideas
- When the user feels ready to capture the ideas, they will type /brainstorm-done

IMPORTANT: You are in BRAINSTORM MODE. Focus on divergent exploration, not convergent requirements gathering. Go deep on one concept at a time before moving to the next.
`;
	}

	/**
	 * Get the spec file size for widget display
	 */
	function getSpecFileInfo(cwd: string, specPath: string): string {
		const fullPath = path.join(cwd, specPath);
		if (!fs.existsSync(fullPath)) {
			return "not yet created";
		}
		const stats = fs.statSync(fullPath);
		const kb = (stats.size / 1024).toFixed(1);
		return `${kb} KB`;
	}

	/**
	 * Update the widget for the current mode
	 */
	function updateModeWidget(ctx: any): void {
		if (pipelineMode === "idle") return;

		if (pipelineMode === "scoping" && activeScopingState) {
			ctx.ui.setWidget("spec-pipeline-status", [
				"🔎 Scoping Mode",
				"────────────────────────────────────",
				`Exchanges: ${exchangeCount}`,
				"",
				"Chat naturally to help assess scope.",
				"Type /plan-done when ready to proceed.",
			]);
			return;
		}

		if (pipelineMode === "brainstorm" && activeBrainstormState) {
			ctx.ui.setWidget("spec-pipeline-status", [
				"🧠 Brainstorm Mode",
				"────────────────────────────────────",
				`Exchanges: ${exchangeCount}`,
				"",
				"Chat freely to explore ideas.",
				"Type /brainstorm-done when ready.",
			]);
			return;
		}

		if (!activePipelineState) return;

		const doneCmd = "/discovery-done"; // Unified for all pipeline types
		const draftDoneCmd =
			activePipelineKind === "spec" ? "/spec-draft-done" : "/draft-done";
		const kindLabel =
			activePipelineKind === "hierarchy" && activeHierarchyLevel
				? activeHierarchyLevel.charAt(0).toUpperCase() +
					activeHierarchyLevel.slice(1)
				: activePipelineKind === "implement"
					? "Implementation"
					: "Spec";

		if (pipelineMode === "discovery") {
			ctx.ui.setWidget("spec-pipeline-status", [
				`🔍 ${kindLabel} Discovery Mode`,
				"────────────────────────────────────",
				`Exchanges: ${exchangeCount}`,
				"",
				"Confirm or correct each assumption.",
				`Type ${doneCmd} when ready to proceed.`,
			]);
		} else if (pipelineMode === "drafting") {
			const specState = getActiveSpecState();
			const hierState = getActiveHierarchyState();
			if (specState) {
				const specInfo = getSpecFileInfo(activeCwd, specState.specPath);
				const iteration = specState.specIteration + 1;
				const lines = [
					"📝 Drafting Mode",
					"────────────────────────────────────",
					`Spec file: ${specInfo}`,
					`Iteration: ${iteration}`,
					`Exchanges: ${exchangeCount}`,
				];
				lines.push("", `Type ${draftDoneCmd} when satisfied.`);
				ctx.ui.setWidget("spec-pipeline-status", lines);
			} else if (hierState) {
				const docInfo = getSpecFileInfo(activeCwd, hierState.docPath);
				const iteration = hierState.docIteration + 1;
				const lines = [
					`📝 ${kindLabel} Drafting Mode`,
					"────────────────────────────────────",
					`Document: ${docInfo}`,
					`Iteration: ${iteration}`,
					`Exchanges: ${exchangeCount}`,
				];
				lines.push("", `Type ${draftDoneCmd} when satisfied.`);
				ctx.ui.setWidget("spec-pipeline-status", lines);
			}
		}
	}

	/**
	 * End discovery mode and proceed to spec drafting mode
	 */
	async function endDiscoveryAndStartDrafting(ctx: any): Promise<void> {
		const specState = getActiveSpecState();
		if (
			pipelineMode !== "discovery" ||
			!specState ||
			!activeCwd ||
			!activeProjectConfig
		) {
			ctx.ui.notify("No active discovery session.", "error");
			return;
		}

		const state = specState;
		const cwd = activeCwd;
		const projectConfig = activeProjectConfig;

		// Build the discovery summary from structured topics when available, falling
		// back to legacy conversation history for older discovery sessions.
		if (state.discovery) {
			const exchanges = state.discovery.conversationHistory ?? [];
			const topics = state.discovery.topics ?? [];
			if (topics.length > 0 || exchanges.length > 0) {
				state.discovery.discoverySummary =
					generateConversationalDiscoverySummary(exchanges, topics);
			}
		}

		state.discovery!.completed = true;
		const discoveryExchanges = exchangeCount;

		ctx.ui.notify(
			formatStepBanner(
				"DISCOVERY COMPLETE",
				`${discoveryExchanges} exchanges recorded. Entering spec drafting mode...`,
				"✅",
			),
			"success",
		);

		// Initialize drafting state
		state.drafting = {
			conversationHistory: [],
			completed: false,
		};
		state.stage = "spec_drafting";
		saveSpecState(cwd, state);

		// Transition to drafting mode
		enterSpecMode("drafting", state, cwd, projectConfig);

		// Update widget
		updateModeWidget(ctx);

		ctx.ui.notify(
			formatStepBanner(
				"SPEC DRAFTING MODE",
				"The LLM will now draft the specification. Guide it conversationally.",
				"📝",
			),
			"info",
		);
		ctx.ui.notify(`Spec file will be written to: ${state.specPath}`, "info");
		ctx.ui.notify("When satisfied, type /spec-draft-done to proceed.", "info");

		// Build the kickoff message
		const fullSpecPath = path.join(cwd, state.specPath);
		const discoveryContext = state.discovery?.discoverySummary
			? `\n\nHere is the context gathered during discovery:\n\n${state.discovery.discoverySummary}`
			: "";

		pi.sendUserMessage(
			`Please create a technical specification for: ${state.description}${discoveryContext}\n\n` +
				`Write the spec to this exact path: ${fullSpecPath}\n` +
				`Use spec timestamp: ${state.specTimestamp}\n\n` +
				`Explore the codebase first to understand existing patterns, then create a comprehensive spec.`,
		);
	}

	/**
	 * Enter drafting mode directly (for --quick or after review revisions)
	 */
	function enterDraftingMode(
		state: SpecState,
		cwd: string,
		projectConfig: ProjectConfig,
		ctx: any,
	): void {
		// Initialize drafting state if needed
		if (!state.drafting) {
			state.drafting = {
				conversationHistory: [],
				completed: false,
			};
		} else {
			state.drafting.completed = false;
		}
		state.stage = "spec_drafting";
		saveSpecState(cwd, state);

		enterSpecMode("drafting", state, cwd, projectConfig);
		updateModeWidget(ctx);
	}

	/**
	 * Handle end of spec drafting: commit and present approval options (no AI review)
	 */
	async function endSpecDrafting(ctx: any): Promise<void> {
		const specState = getActiveSpecState();
		if (
			pipelineMode !== "drafting" ||
			!specState ||
			!activeCwd ||
			!activeProjectConfig
		) {
			ctx.ui.notify("No active drafting session.", "error");
			return;
		}

		const state = specState;
		const cwd = activeCwd;
		const projectConfig = activeProjectConfig;
		const fullSpecPath = path.join(cwd, state.specPath);

		// Validate spec file exists
		if (!fs.existsSync(fullSpecPath)) {
			ctx.ui.notify(
				`Spec file not found at: ${state.specPath}\n\nThe LLM needs to write the spec file first. Continue chatting to guide it.`,
				"error",
			);
			return;
		}

		// Read the spec content
		state.specDraft = fs.readFileSync(fullSpecPath, "utf-8");
		if (!state.specDraft.trim()) {
			ctx.ui.notify(
				"Spec file is empty. Continue chatting to guide the LLM.",
				"error",
			);
			return;
		}

		// Warn if the spec has no phase table — /implement will fall back to a single phase
		const { paths: detectedPhases } = extractPhases(
			state.specDraft,
			state.specTimestamp,
			"check",
		);
		if (detectedPhases.length === 0) {
			ctx.ui.notify(
				"⚠️  No phase table found in the spec.\n" +
					"/implement will treat this as a single phase.\n" +
					"Add a phases table (| Phase | Focus | Effort |) if you want parallel phase planning.",
				"warning",
			);
		}

		// Mark drafting as complete
		state.drafting!.completed = true;
		state.specIteration++;
		state.stage = "user_approval";
		saveSpecState(cwd, state);

		// Exit drafting mode
		const { exchangeCount: draftExchanges } = exitMode();

		ctx.ui.notify(
			formatStepBanner(
				"SPEC DRAFTING COMPLETE",
				`${draftExchanges} exchanges. Creating commit...`,
				"✅",
			),
			"success",
		);

		// Create git commit scoped to the spec file only (dirty tree is OK for doc pipelines)
		// Extract doc name from filename for better commit messages
		const { extractDocName } = await import("./commit-agent.ts");
		const docName = extractDocName(state.specFilename);

		const commitResult = await createAgentCommit(
			cwd,
			state,
			{
				role: "specDrafter",
				modelConfig: projectConfig.models.planDrafter,
				docName,
			},
			projectConfig.models.agentCommitMessageWriter,
			() => saveSpecState(cwd, state),
			ctx.ui.notify.bind(ctx.ui),
			[state.specPath],
		);

		if (!commitResult.success) {
			ctx.ui.notify(
				"Warning: Failed to create commit for spec draft",
				"warning",
			);
		}

		// Present approval options to user
		const specPreview =
			state.specDraft.length > 3000
				? state.specDraft.slice(0, 3000) +
					"\n\n[... truncated — read the file for full content ...]"
				: state.specDraft;

		ctx.ui.notify(
			formatStepBanner(
				"User Approval Required",
				`Review the spec at: ${state.specPath}`,
				"👤",
			),
			"info",
		);

		const choices = [
			"Approve spec and start implementation now",
			"Approve spec (implement later with /implement)",
			"Revise spec conversationally",
			"Cancel pipeline",
		];
		const choice = await ctx.ui.select(
			"How would you like to proceed?",
			choices,
		);

		if (choice === choices[0] || choice === choices[1]) {
			// Approve
			state.specApproved = true;
			state.stage = "completed";
			saveSpecState(cwd, state);
			clearPipelineWidget(ctx);

			ctx.ui.notify(
				formatStepBanner(
					"🎉 Spec Creation Complete!",
					`Spec: ${state.specPath}`,
					"✅",
				),
				"success",
			);

			if (choice === choices[1]) {
				ctx.ui.notify(`Run: /implement ${state.specPath}`, "info");
				return;
			}

			// Launch implementation directly from the extension — no agent free-running
			const implTimestamp = generateTimestamp();
			const implState = createInitialImplState(
				state.specPath,
				state.specDraft,
				implTimestamp,
				projectConfig.skipPlanGeneration,
			);
			implState.checkpoints = [];
			saveImplState(cwd, implState);

			ctx.ui.notify(
				formatStepBanner("IMPLEMENTATION STARTED", `ID: ${implState.id}`, "🚀"),
				"info",
			);
			updateImplWidget(ctx, implState, "Initializing...");

			await runImplementPipeline(implState, cwd, projectConfig, ctx);
			return;
		}

		if (choice === choices[3]) {
			// Cancel
			state.stage = "cancelled";
			saveSpecState(cwd, state);
			clearPipelineWidget(ctx);
			ctx.ui.notify("Pipeline cancelled.", "info");
			return;
		}

		// Re-enter drafting mode for revision
		state.drafting!.completed = false;
		enterDraftingMode(state, cwd, projectConfig, ctx);

		ctx.ui.notify(
			formatStepBanner(
				"REVISION MODE",
				"Continue chatting to refine the spec.",
				"📝",
			),
			"info",
		);
		ctx.ui.notify("Type /spec-draft-done when satisfied.", "info");

		// Kick off revision
		pi.sendUserMessage(
			`Please read the current spec at ${fullSpecPath} and let me guide you on revisions.`,
		);
	}

	/**
	 * Handle end of hierarchy drafting: commit and present approval options (no AI review)
	 */
	async function endHierarchyDrafting(ctx: any): Promise<void> {
		const hierState = getActiveHierarchyState();
		if (
			pipelineMode !== "drafting" ||
			!hierState ||
			!activeCwd ||
			!activeProjectConfig
		) {
			ctx.ui.notify("No active hierarchy drafting session.", "error");
			return;
		}

		const state = hierState;
		const cwd = activeCwd;
		const projectConfig = activeProjectConfig;
		const level = activeHierarchyLevel!;
		const parentContext = activeParentContext;
		const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
		const fullDocPath = path.join(cwd, state.docPath);

		// Validate document file exists
		if (!fs.existsSync(fullDocPath)) {
			ctx.ui.notify(
				`Document file not found at: ${state.docPath}\n\nThe LLM needs to write the document file first. Continue chatting to guide it.`,
				"error",
			);
			return;
		}

		// Read the document content
		state.docContent = fs.readFileSync(fullDocPath, "utf-8");
		if (!state.docContent.trim()) {
			ctx.ui.notify(
				"Document file is empty. Continue chatting to guide the LLM.",
				"error",
			);
			return;
		}

		// Mark drafting as complete
		state.drafting!.completed = true;
		state.docIteration++;
		state.stage = "user_approval";
		if (state.level === "roadmap") saveRoadmapState(cwd, state as RoadmapState);
		else saveEpicState(cwd, state as EpicState);

		// Exit drafting mode
		const { exchangeCount: draftExchanges } = exitMode();

		ctx.ui.notify(
			formatStepBanner(
				`${levelLabel.toUpperCase()} DRAFTING COMPLETE`,
				`${draftExchanges} exchanges. Creating commit...`,
				"✅",
			),
			"success",
		);

		// Create git commit scoped to the doc file only (dirty tree is OK for doc pipelines)
		const drafterRole = level === "roadmap" ? "roadmapDrafter" : "epicDrafter";

		// Extract doc name from filename for better commit messages
		const { extractDocName } = await import("./commit-agent.ts");
		const docName = extractDocName(state.docFilename);

		const commitResult = await createAgentCommit(
			cwd,
			state,
			{
				role: drafterRole,
				modelConfig:
					level === "roadmap"
						? projectConfig.models.roadmapDrafter
						: projectConfig.models.epicDrafter,
				docName,
			},
			projectConfig.models.agentCommitMessageWriter,
			() => {
				if (state.level === "roadmap")
					saveRoadmapState(cwd, state as RoadmapState);
				else saveEpicState(cwd, state as EpicState);
			},
			ctx.ui.notify.bind(ctx.ui),
			[state.docPath],
		);

		if (!commitResult.success) {
			ctx.ui.notify(
				"Warning: Failed to create commit for document draft",
				"warning",
			);
		}

		// Present approval options to user
		ctx.ui.notify(
			formatStepBanner(
				"User Approval Required",
				`Review the ${level} document at: ${state.docPath}`,
				"👤",
			),
			"info",
		);

		const choices = [
			`Approve ${level}`,
			`Revise ${level} conversationally`,
			"Cancel pipeline",
		];
		const choice = await ctx.ui.select(
			"How would you like to proceed?",
			choices,
		);

		if (choice === choices[0]) {
			// Approve — continue to child extraction and completion
			state.docApproved = true;
			if (state.level === "roadmap")
				saveRoadmapState(cwd, state as RoadmapState);
			else saveEpicState(cwd, state as EpicState);

			// Run the hierarchy pipeline for child extraction and completion
			await runHierarchyPipeline(state, cwd, projectConfig, ctx, parentContext);
			return;
		}

		if (choice === choices[2]) {
			// Cancel
			state.stage = "cancelled";
			if (state.level === "roadmap")
				saveRoadmapState(cwd, state as RoadmapState);
			else saveEpicState(cwd, state as EpicState);
			clearPipelineWidget(ctx);
			ctx.ui.notify("Pipeline cancelled.", "info");
			return;
		}

		// Re-enter drafting mode for revision
		state.drafting!.completed = false;
		state.stage = "drafting";
		if (state.level === "roadmap") saveRoadmapState(cwd, state as RoadmapState);
		else saveEpicState(cwd, state as EpicState);

		enterHierarchyMode(
			"drafting",
			state,
			level,
			cwd,
			projectConfig,
			parentContext,
		);
		updateModeWidget(ctx);

		ctx.ui.notify(
			formatStepBanner(
				"REVISION MODE",
				`Continue chatting to refine the ${level} document.`,
				"📝",
			),
			"info",
		);
		ctx.ui.notify("Type /draft-done when satisfied.", "info");

		// Kick off revision
		pi.sendUserMessage(
			`Please read the current ${level} document at ${fullDocPath} and let me guide you on revisions.`,
		);
	}

	// ============================================
	// EVENT HANDLERS FOR CONVERSATIONAL MODES
	// ============================================

	/**
	 * Inject system prompt when in a conversational mode (scoping, discovery, or drafting)
	 */
	pi.on("before_agent_start", async (event, ctx) => {
		if (pipelineMode === "idle" || !activeProjectConfig) {
			return undefined;
		}

		let injection: string;
		let customType: string;
		let contextLabel: string;

		if (pipelineMode === "scoping" && activeScopingState) {
			injection = buildScopingPromptInjection(
				activeScopingState,
				activeProjectConfig,
			);
			customType = "spec-scoping-context";
			contextLabel = `[SCOPING MODE ACTIVE - Assessing scope for: ${activeScopingState.description}]`;
		} else if (pipelineMode === "discovery" && activePipelineState) {
			// When the extension-driven loop is active, the host agent must not run
			// — the subagent in runDiscoveryStep handles question generation.
			if (discoveryLoopActive) {
				return undefined;
			}

			let sessionLabel = "Spec";
			let nextStep = "proceed to spec drafting";

			if (activePipelineKind === "spec") {
				sessionLabel = "Spec";
				nextStep = "proceed to spec drafting";
			} else if (activePipelineKind === "hierarchy") {
				sessionLabel =
					activeHierarchyLevel!.charAt(0).toUpperCase() +
					activeHierarchyLevel!.slice(1);
				nextStep = `proceed to ${activeHierarchyLevel} drafting`;
			} else if (activePipelineKind === "implement") {
				sessionLabel = "Implementation";
				nextStep = "proceed to implementation";
			}

			injection = buildUnifiedDiscoveryPrompt(
				activePipelineState,
				activeProjectConfig,
				"/discovery-done",
				sessionLabel,
				nextStep,
				activeParentContext,
			);
			customType = "spec-discovery-context";
			contextLabel = `[DISCOVERY MODE ACTIVE - Exploring requirements for: ${activePipelineState.description}]`;
		} else if (pipelineMode === "drafting" && activePipelineState) {
			if (activePipelineKind === "spec") {
				injection = buildDraftingPromptInjection(
					activePipelineState as SpecState,
					activeProjectConfig,
				);
			} else {
				injection = buildHierarchyDraftingPromptInjection(
					activePipelineState as HierarchyState,
					activeHierarchyLevel!,
					activeProjectConfig,
					activeParentContext,
				);
			}
			customType = "spec-drafting-context";
			contextLabel = `[DRAFTING MODE ACTIVE - Creating ${activePipelineKind === "spec" ? "spec" : activeHierarchyLevel} for: ${activePipelineState.description}]`;
		} else if (pipelineMode === "brainstorm" && activeBrainstormState) {
			injection = buildBrainstormPromptInjection(
				activeBrainstormState,
				activeProjectConfig,
			);
			customType = "spec-brainstorm-context";
			contextLabel = `[BRAINSTORM MODE ACTIVE - Exploring: ${activeBrainstormState.description}]`;
		} else {
			return undefined;
		}

		return {
			systemPrompt: event.systemPrompt + "\n\n" + injection,
			message: {
				customType,
				content: contextLabel,
				display: false,
			},
		};
	});

	/**
	 * Capture user input during any conversational mode to track conversation.
	 * When the extension-driven discovery loop is active, intercept the user's
	 * answer, record the Q&A pair, and trigger the next discovery step instead
	 * of letting the host agent respond.
	 */
	pi.on("input", async (event, ctx) => {
		if (pipelineMode === "idle") {
			return { action: "continue" as const };
		}

		// Don't intercept extension-injected messages
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		// Extension-driven /spec discovery loop: classify the reply before deciding
		// whether to close the active topic or keep it open for a follow-up thread.
		if (discoveryLoopActive && activeDiscoveryTopic !== null) {
			const answer = event.text.trim();

			// Allow /discovery-done to break out even during the loop.
			if (!answer.startsWith("/")) {
				const topicAtClassification = activeDiscoveryTopic;
				let classification: DiscoveryReplyClassification = "decision";

				if (
					activePipelineKind === "spec" &&
					activeProjectConfig &&
					activeCwd &&
					!isUnambiguousDiscoveryDecision(answer)
				) {
					const classifierAbort = new AbortController();
					discoveryLoopAbort = classifierAbort;
					ctx.ui.notify(
						"🤔 Checking whether this is a follow-up or a decision...",
						"info",
					);
					classification = await classifyDiscoveryReply(
						answer,
						topicAtClassification,
						activeProjectConfig,
						activeCwd,
						classifierAbort.signal,
					);
					if (discoveryLoopAbort === classifierAbort) {
						discoveryLoopAbort = null;
					}
				}

				// If another command changed state while the classifier was running, do not
				// resurrect stale topic data.
				if (
					!discoveryLoopActive ||
					activeDiscoveryTopic !== topicAtClassification
				) {
					return { action: "handled" as const };
				}

				if (classification === "followup") {
					pi.sendMessage({
						customType: "spec-discovery-qa",
						content: `❓ Follow-up: ${answer}`,
						display: true,
					});
					await runFollowUpStep(ctx, answer, topicAtClassification);
					return { action: "handled" as const };
				}

				pi.sendMessage({
					customType: "spec-discovery-qa",
					content: `👤 Decision: ${answer}`,
					display: true,
				});

				const closedTopic: DiscoveryTopic = {
					...activeDiscoveryTopic,
					decision: answer,
				};
				discoveryTopics.push(closedTopic);
				activeDiscoveryTopic = null;
				persistDiscoveryLoopState();

				let sessionLabel = "Spec";
				let nextStep = "spec drafting";
				if (activePipelineKind === "hierarchy") {
					sessionLabel =
						activeHierarchyLevel!.charAt(0).toUpperCase() +
						activeHierarchyLevel!.slice(1);
					nextStep = `${activeHierarchyLevel} drafting`;
				} else if (activePipelineKind === "implement") {
					sessionLabel = "Implementation";
					nextStep = "implementation";
				}

				setImmediate(() => runDiscoveryStep(ctx, sessionLabel, nextStep));
				return { action: "handled" as const };
			}
		}

		// Store the user message for pairing with assistant response
		lastUserMessage = event.text;

		return { action: "continue" as const };
	});

	/**
	 * After each agent turn, capture the assistant response
	 * and pair it with the user message to build conversation history
	 */
	pi.on("agent_end", async (event, ctx) => {
		if (pipelineMode === "idle") {
			return;
		}

		// Extract the last assistant text from the messages
		let assistantText = "";
		const messages = event.messages || [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as any;
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				const textParts = msg.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text);
				if (textParts.length > 0) {
					assistantText = textParts.join("\n");
					break;
				}
			}
		}

		if (assistantText && lastUserMessage) {
			const exchange: ConversationalExchange = {
				userMessage: lastUserMessage,
				assistantResponse: assistantText,
				timestamp: new Date().toISOString(),
			};

			if (pipelineMode === "scoping" && activeScopingState) {
				activeScopingState.conversationHistory.push(exchange);
				exchangeCount = activeScopingState.conversationHistory.length;
				// No need to persist — scoping state is ephemeral
			} else if (pipelineMode === "brainstorm" && activeBrainstormState) {
				activeBrainstormState.conversationHistory.push(exchange);
				exchangeCount = activeBrainstormState.conversationHistory.length;
				saveBrainstormState(activeCwd, activeBrainstormState);
			} else if (pipelineMode === "discovery" && activePipelineState) {
				if (!activePipelineState.discovery!.conversationHistory) {
					activePipelineState.discovery!.conversationHistory = [];
				}
				activePipelineState.discovery!.conversationHistory.push(exchange);
				exchangeCount =
					activePipelineState.discovery!.conversationHistory.length;
				activeStateSaveFn?.();
			} else if (pipelineMode === "drafting" && activePipelineState) {
				if (!activePipelineState.drafting!.conversationHistory) {
					activePipelineState.drafting!.conversationHistory = [];
				}
				activePipelineState.drafting!.conversationHistory.push(exchange);
				exchangeCount =
					activePipelineState.drafting!.conversationHistory.length;
				activeStateSaveFn?.();
			}

			updateModeWidget(ctx);
			lastUserMessage = "";
		}
	});

	/**
	 * Filter out pipeline context messages that don't belong to the current mode.
	 * - In idle: filter out all pipeline context messages
	 * - In scoping: filter out discovery and drafting context messages
	 * - In discovery: filter out scoping and drafting context messages
	 * - In drafting: filter out scoping and discovery context messages
	 */
	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m: any) => {
				if (m.customType === "spec-scoping-context") {
					return pipelineMode === "scoping";
				}
				if (m.customType === "spec-discovery-context") {
					return pipelineMode === "discovery";
				}
				if (m.customType === "spec-drafting-context") {
					return pipelineMode === "drafting";
				}
				if (m.customType === "spec-brainstorm-context") {
					return pipelineMode === "brainstorm";
				}
				// Discovery QA display messages are UI-only; never feed them to the LLM.
				if (m.customType === "spec-discovery-qa") {
					return false;
				}
				return true;
			}),
		};
	});

	// ============================================
	// SPEC CREATION COMMANDS
	// ============================================

	pi.registerCommand("spec-draft-done", {
		description: "End spec drafting and proceed to approval",
		handler: async (_args, ctx) => {
			if (pipelineMode !== "drafting" || activePipelineKind !== "spec") {
				ctx.ui.notify(
					"No active spec drafting session. Use /spec to start one.",
					"error",
				);
				return;
			}

			await endSpecDrafting(ctx);
		},
	});

	pi.registerCommand("discovery-done", {
		description:
			"End discovery and proceed to next phase (spec drafting, hierarchy drafting, or implementation)",
		handler: async (_args, ctx) => {
			if (
				pipelineMode !== "discovery" ||
				!activePipelineKind ||
				!activePipelineState ||
				!activeCwd ||
				!activeProjectConfig
			) {
				ctx.ui.notify("No active discovery session.", "error");
				return;
			}

			// Stop the extension-driven loop and flush any partial topic into history
			if (discoveryLoopActive) {
				discoveryLoopActive = false;
				if (discoveryLoopAbort) {
					discoveryLoopAbort.abort();
					discoveryLoopAbort = null;
				}
				syncDiscoveryTopicsToState(true);
				discoveryTopics = [];
				activeDiscoveryTopic = null;
			}

			if (exchangeCount === 0) {
				const proceed = await ctx.ui.confirm(
					"No Discovery Exchanges",
					"No conversation exchanges recorded yet. Proceed anyway?",
				);
				if (!proceed) return;
			}

			// Dispatch based on pipeline kind
			if (activePipelineKind === "spec") {
				// Absorb /spec-done logic
				await endDiscoveryAndStartDrafting(ctx);
			} else if (activePipelineKind === "hierarchy") {
				// Existing hierarchy logic
				const state = getActiveHierarchyState();
				if (!state) {
					ctx.ui.notify("No active hierarchy discovery session.", "error");
					return;
				}

				// Build the discovery summary from conversation history
				if (
					state.discovery &&
					state.discovery.conversationHistory &&
					state.discovery.conversationHistory.length > 0
				) {
					state.discovery.discoverySummary =
						generateConversationalDiscoverySummary(
							state.discovery.conversationHistory,
						);
				}

				state.discovery!.completed = true;
				const discoveryExchanges = exchangeCount;

				const level = activeHierarchyLevel!;
				const cwd = activeCwd;
				const projectConfig = activeProjectConfig;
				const parentContext = activeParentContext;
				const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);

				ctx.ui.notify(
					formatStepBanner(
						"DISCOVERY COMPLETE",
						`${discoveryExchanges} exchanges recorded. Entering ${level} drafting mode...`,
						"✅",
					),
					"success",
				);

				// Initialize drafting state and transition to drafting mode
				state.drafting = {
					conversationHistory: [],
					completed: false,
				};
				state.stage = "drafting";
				if (state.level === "roadmap")
					saveRoadmapState(cwd, state as RoadmapState);
				else saveEpicState(cwd, state as EpicState);

				// Enter hierarchy drafting mode
				enterHierarchyMode(
					"drafting",
					state,
					level,
					cwd,
					projectConfig,
					parentContext,
				);
				updateModeWidget(ctx);

				ctx.ui.notify(
					formatStepBanner(
						`${levelLabel.toUpperCase()} DRAFTING MODE`,
						`The LLM will draft the ${level} document. Guide it conversationally.`,
						"📝",
					),
					"info",
				);
				ctx.ui.notify(`Document will be written to: ${state.docPath}`, "info");
				ctx.ui.notify(
					"When satisfied, type /draft-done to proceed to approval.",
					"info",
				);

				// Send the kickoff message
				const fullDocPath = path.join(cwd, state.docPath);
				const discoveryContext = state.discovery?.discoverySummary
					? `\n\nHere is the context gathered during discovery:\n\n${state.discovery.discoverySummary}`
					: "";

				pi.sendUserMessage(
					`Please create a ${level} document for: ${state.description}${discoveryContext}\n\n` +
						`Write the document to this exact path: ${fullDocPath}\n` +
						`Use document timestamp: ${state.docTimestamp}\n\n` +
						`Explore the codebase first to understand existing patterns, then create a comprehensive ${level} document.`,
				);
			} else if (activePipelineKind === "implement") {
				// Implement-discovery → implementation transition
				const state = activePipelineState as ConversationalPipelineState;
				const cwd = activeCwd;
				const projectConfig = activeProjectConfig;
				const flags = pendingImplementFlags!;
				const shortName = pendingImplementShortName!;
				const timestamp = pendingImplementTimestamp!;

				// Build discovery summary
				let discoverySummary = "";
				if (
					state.discovery &&
					state.discovery.conversationHistory &&
					state.discovery.conversationHistory.length > 0
				) {
					discoverySummary = generateConversationalDiscoverySummary(
						state.discovery.conversationHistory,
					);
				}

				const discoveryExchanges = exchangeCount;

				ctx.ui.notify(
					formatStepBanner(
						"DISCOVERY COMPLETE",
						`${discoveryExchanges} exchanges recorded. Checking git status...`,
						"✅",
					),
					"success",
				);

				// NOW check git clean (deferred from /implement invocation)
				const gitClean = await checkGitClean(cwd);
				if (!gitClean.clean) {
					ctx.ui.notify(
						formatStepBanner(
							"UNCOMMITTED CHANGES DETECTED",
							"The implementation pipeline requires a clean working tree.",
							"⚠️",
						),
						"warning",
					);
					ctx.ui.notify("Uncommitted changes:\n" + gitClean.status, "warning");
					ctx.ui.notify(
						"\nPlease commit or stash your changes, then run /discovery-done again.",
						"info",
					);
					ctx.ui.notify("Your discovery session will remain active.", "info");
					// Do NOT exit mode - leave discovery session active
					return;
				}

				// Exit discovery mode (clears all state including pendingImplementFlags)
				exitMode();
				clearPipelineWidget(ctx);

				ctx.ui.notify("Writing discovery summary...", "info");

				// Write discovery summary file to specsDir
				const discoveryFilename = `${timestamp}_discovery_${shortName}.md`;
				const discoveryContent =
					discoverySummary ||
					`# Discovery Summary\n\n${state.description}\n\nNo discovery exchanges recorded.`;

				// Resolve absolute path to specsDir (handle both absolute and relative configs)
				const fullSpecsDir = path.isAbsolute(projectConfig.specsDir)
					? projectConfig.specsDir
					: path.join(cwd, projectConfig.specsDir);

				// Ensure specsDir exists
				if (!fs.existsSync(fullSpecsDir)) {
					fs.mkdirSync(fullSpecsDir, { recursive: true });
				}

				// Write file to absolute path, compute relative path for display/state
				const fullDiscoveryPath = path.join(fullSpecsDir, discoveryFilename);
				const discoveryPath = path.relative(cwd, fullDiscoveryPath);
				fs.writeFileSync(fullDiscoveryPath, discoveryContent, "utf-8");

				ctx.ui.notify(
					`Discovery summary written to: ${discoveryPath}`,
					"success",
				);
				ctx.ui.notify(
					formatStepBanner(
						"STARTING IMPLEMENTATION",
						`From discovery file: ${discoveryPath}`,
						"🚀",
					),
					"info",
				);

				// Create implementation state (using discovery file as "spec")
				const implTimestamp = generateTimestamp();
				const implState = createInitialImplState(
					discoveryPath,
					discoveryContent,
					implTimestamp,
					flags.noPlan,
				);

				implState.checkpoints = [];
				saveImplState(cwd, implState);

				ctx.ui.notify(
					formatStepBanner(
						"IMPLEMENTATION STARTED",
						`ID: ${implState.id}`,
						"🚀",
					),
					"info",
				);
				ctx.ui.notify(`Spec: ${discoveryPath}`, "info");
				if (flags.noPlan) {
					ctx.ui.notify("⚡ Skipping plan generation (--no-plan)", "info");
				}
				if (flags.noReview) {
					ctx.ui.notify("⚡ Skipping reviews (--no-review)", "info");
				}

				updateImplWidget(ctx, implState, "Initializing...");

				// Apply --no-review flag if present (clone config to avoid mutation)
				let effectiveConfig = projectConfig;
				if (flags.noReview) {
					effectiveConfig = {
						...projectConfig,
						reviewCycles: 0,
					};
				}

				// Run implementation pipeline
				await runImplementPipeline(implState, cwd, effectiveConfig, ctx);
			}
		},
	});

	pi.registerCommand("draft-done", {
		description: "End hierarchy drafting and proceed to approval",
		handler: async (_args, ctx) => {
			if (pipelineMode !== "drafting" || activePipelineKind !== "hierarchy") {
				ctx.ui.notify(
					"No active hierarchy drafting session. Use /roadmap or /epic to start one.",
					"error",
				);
				return;
			}

			await endHierarchyDrafting(ctx);
		},
	});

	pi.registerCommand("spec", {
		description: "Start spec creation. Use --quick to skip discovery.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			if (pipelineMode === "brainstorm") {
				ctx.ui.notify(
					"Cannot start /spec while a brainstorm session is active. Use /brainstorm-cancel to cancel it first.",
					"error",
				);
				return;
			}

			const argsStr = args || "";
			const isQuick = argsStr.includes("--quick");
			const description = argsStr
				.replace("--quick", "")
				.replace(/\s+/g, " ")
				.trim();

			if (!description) {
				ctx.ui.notify(
					"Usage: /spec [--quick] <description of what you want to build>",
					"error",
				);
				return;
			}

			const cwd = ctx.cwd;

			// Check for existing active spec pipeline
			const existingPipeline = getLatestActiveSpecPipeline(cwd);
			if (existingPipeline) {
				const resume = await ctx.ui.confirm(
					"Active Spec Pipeline Found",
					`There's an active spec pipeline:\n${formatSpecState(existingPipeline)}\n\nDo you want to continue with a NEW pipeline? (No = cancel)`,
				);
				if (!resume) {
					ctx.ui.notify(
						"Use /spec-resume to continue the existing pipeline",
						"info",
					);
					return;
				}
			}

			// Git validation (repo must exist, but dirty state is OK for doc pipelines)
			const gitValidation = await validateGitRepo(cwd);
			if (!gitValidation.valid) {
				ctx.ui.notify(gitValidation.error!, "error");
				return;
			}

			// Load config
			const configResult = loadPipelineConfig(cwd);
			if (!configResult.success) {
				ctx.ui.notify(configResult.error, "error");
				return;
			}
			const projectConfig = configResult.config;

			ctx.ui.notify(
				formatEffectiveConfig(projectConfig, configResult.fromFile),
				"info",
			);
			ctx.ui.notify("Starting spec creation...", "info");
			if (projectConfig.contextFiles.length > 0) {
				ctx.ui.notify(
					`Using context from: ${projectConfig.contextFiles.join(", ")}`,
					"info",
				);
			}

			// Generate names and timestamps
			const specTimestamp = generateTimestamp();
			const { shortName } = await promptForShortName(ctx, description);

			// Create initial state
			const state = createInitialSpecState(
				description,
				specTimestamp,
				shortName,
				projectConfig.specsDir,
				isQuick,
				projectConfig.specFormat,
			);

			state.checkpoints = [];
			saveSpecState(cwd, state);

			ctx.ui.notify(
				formatStepBanner("SPEC CREATION STARTED", `ID: ${state.id}`, "📝"),
				"info",
			);

			if (isQuick) {
				ctx.ui.notify("Skipping discovery phase (--quick mode)", "info");
			}

			updateSpecWidget(ctx, state, "Initializing...");

			// Consume any pending scoping context from /plan → feature route
			const scopingContext = pendingScopingContext;
			pendingScopingContext = undefined;
			if (scopingContext) {
				ctx.ui.notify(
					"📎 Including scoping context from /plan session.",
					"info",
				);
			}

			// If discovery is enabled (not --quick), enter conversational discovery mode
			const shouldDiscover = !isQuick && state.stage === "discovery";

			if (shouldDiscover) {
				// If we have scoping context, pre-populate the discovery summary so it's available
				if (scopingContext && state.discovery) {
					state.discovery.discoverySummary = scopingContext;
				}

				// Initialize conversational discovery state
				state.discovery!.conversationHistory = [];
				saveSpecState(cwd, state);

				// Enter discovery mode
				enterSpecMode("discovery", state, cwd, projectConfig);

				// Show discovery widget
				updateModeWidget(ctx);

				ctx.ui.notify(
					formatStepBanner(
						"DISCOVERY MODE",
						"The LLM will explore the codebase, propose assumptions, and ask you to confirm.",
						"🔍",
					),
					"info",
				);
				ctx.ui.notify(
					"The extension will ask questions one at a time. Answer each one and the next will follow automatically.",
					"info",
				);
				ctx.ui.notify(
					"Type /discovery-done at any time to skip to spec drafting.",
					"info",
				);

				// Start the extension-driven topic loop
				discoveryLoopActive = true;
				discoveryTopics = state.discovery?.topics ?? [];
				activeDiscoveryTopic = state.discovery?.activeTopic ?? null;
				persistDiscoveryLoopState();
				setImmediate(() => runDiscoveryStep(ctx, "Spec", "spec drafting"));
			} else {
				// --quick mode: enter conversational drafting directly
				enterDraftingMode(state, cwd, projectConfig, ctx);

				ctx.ui.notify(
					formatStepBanner(
						"SPEC DRAFTING MODE",
						"The LLM will draft the specification. Guide it conversationally.",
						"📝",
					),
					"info",
				);
				ctx.ui.notify(
					`Spec file will be written to: ${state.specPath}`,
					"info",
				);
				ctx.ui.notify(
					"When satisfied, type /spec-draft-done to proceed.",
					"info",
				);

				// Send the kickoff message
				const fullSpecPath = path.join(cwd, state.specPath);
				const scopingNote = scopingContext
					? `\n\nThe following context was gathered during a scoping assessment:\n\n${scopingContext}\n\nIncorporate this context into the specification.`
					: "";
				pi.sendUserMessage(
					`Please create a technical specification for: ${description}${scopingNote}\n\n` +
						`Write the spec to this exact path: ${fullSpecPath}\n` +
						`Use spec timestamp: ${state.specTimestamp}\n\n` +
						`Explore the codebase first to understand existing patterns, then create a comprehensive spec.`,
				);
			}
		},
	});

	pi.registerCommand("spec-resume", {
		description: "Resume an active spec pipeline",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: SpecState | null;
			if (pipelineId) {
				state = loadSpecState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Spec pipeline not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveSpecPipeline(cwd);
				if (!state) {
					ctx.ui.notify(
						"No active spec pipeline found. Use /spec to start one.",
						"error",
					);
					return;
				}
			}

			if (state.stage === "completed") {
				ctx.ui.notify("This spec pipeline is already completed.", "info");
				return;
			}

			if (state.stage === "cancelled") {
				const restart = await ctx.ui.confirm(
					"Pipeline Cancelled",
					"This pipeline was cancelled. Restart from where it left off?",
				);
				if (!restart) return;

				if (
					state.stageBeforeCancellation &&
					state.stageBeforeCancellation !== "cancelled"
				) {
					ctx.ui.notify(
						`Resuming from saved stage: ${formatSpecStage(state.stageBeforeCancellation)}`,
						"info",
					);
					state.stage = state.stageBeforeCancellation;
					state.stageBeforeCancellation = undefined;
				} else {
					if (state.discovery && !state.discovery.completed) {
						state.stage = "discovery";
					} else if (!state.specApproved) {
						const fullSpecPath = path.join(cwd, state.specPath);
						if (fs.existsSync(fullSpecPath) && state.specIteration > 0) {
							state.stage = "spec_review";
						} else {
							state.stage = "spec_drafting";
						}
					} else {
						state.stage = "completed";
					}
				}
				saveSpecState(cwd, state);
			}

			// Git validation (repo must exist, but dirty state is OK for doc pipelines)
			const gitValidation = await validateGitRepo(cwd);
			if (!gitValidation.valid) {
				ctx.ui.notify(gitValidation.error!, "error");
				return;
			}

			// Clean up error stash if present
			if (state.errorStash) {
				const stashStillExists = await stashExists(cwd, state.errorStash);
				if (stashStillExists) {
					ctx.ui.notify(
						"Dropping stashed changes from previous error...",
						"info",
					);
					await dropStash(cwd, state.errorStash);
				}
				state.errorStash = undefined;
				saveSpecState(cwd, state);
			}

			ctx.ui.notify(
				formatStepBanner("RESUMING SPEC PIPELINE", `ID: ${state.id}`, "🔄"),
				"info",
			);
			ctx.ui.notify(`Current stage: ${formatSpecStage(state.stage)}`, "info");

			if (state.discovery?.skipped) {
				ctx.ui.notify("📌 Discovery was skipped (--quick)", "info");
			}

			updateSpecWidget(ctx, state, "Resuming...");

			const configResult = loadPipelineConfig(cwd);
			if (!configResult.success) {
				ctx.ui.notify(configResult.error, "error");
				return;
			}
			const projectConfig = configResult.config;

			// Handle error retry
			if (state.lastError) {
				if (typeof state.lastError === "string") {
					ctx.ui.notify(
						`Previous error (legacy): ${state.lastError.slice(0, 200)}`,
						"warning",
					);
					state.lastError = undefined;
					saveSpecState(cwd, state);
				} else if (state.lastError.agentTask) {
					const errorDisplay = formatErrorForRetry(state.lastError, state);
					ctx.ui.notify(errorDisplay, "info");

					const shouldRetry = await ctx.ui.confirm(
						"Retry Failed Operation?",
						`The pipeline failed at ${state.lastError.role}.\n\nRetry the same operation?`,
					);

					if (!shouldRetry) {
						ctx.ui.notify("Resume cancelled.", "info");
						return;
					}

					const retrySuccess = await retryFailedOperation(
						state,
						cwd,
						projectConfig,
						() => saveSpecState(cwd, state),
						ctx,
					);

					if (!retrySuccess) {
						ctx.ui.notify(
							"Retry failed. Run /spec-resume to try again.",
							"info",
						);
						return;
					}

					ctx.ui.notify("Retry successful! Continuing pipeline...", "success");
				} else {
					state.lastError = undefined;
					saveSpecState(cwd, state);
				}
			}

			// If resuming in discovery mode, restore the structured discovery loop when possible
			if (state.stage === "discovery" && !state.discovery?.completed) {
				enterSpecMode("discovery", state, cwd, projectConfig);
				updateModeWidget(ctx);

				if (restoreSpecDiscoveryLoopFromState(state)) {
					ctx.ui.notify(
						formatStepBanner(
							"DISCOVERY MODE RESUMED",
							`${discoveryTopics.length} completed topics restored.`,
							"🔍",
						),
						"info",
					);
					ctx.ui.notify(
						"Type /discovery-done when ready to proceed to spec drafting.",
						"info",
					);

					if (activeDiscoveryTopic) {
						ctx.ui.notify(
							`Resuming topic: ${previewDiscoveryTopic(activeDiscoveryTopic.question)}`,
							"info",
						);
						ctx.ui.notify(
							`\n💬 Resuming pending question ${discoveryTopics.length + 1}\n\n${activeDiscoveryTopic.question}\n\n➔ Type your answer below:`,
							"info",
						);
					} else {
						setImmediate(() => runDiscoveryStep(ctx, "Spec", "spec drafting"));
					}
					return;
				}

				ctx.ui.notify(
					formatStepBanner(
						"DISCOVERY MODE RESUMED",
						`${exchangeCount} previous exchanges. Continue chatting to refine requirements.`,
						"🔍",
					),
					"info",
				);
				ctx.ui.notify(
					"Type /discovery-done when ready to proceed to spec drafting.",
					"info",
				);

				// Backward-compatible fallback for older discovery sessions without topic-loop state.
				pi.sendUserMessage(
					`I'm resuming the discovery session for: ${state.description}\n\nPlease review what we've discussed so far and continue with the next most important assumption to verify.`,
				);
				return;
			}

			// If resuming in conversational drafting mode, re-enter drafting mode
			if (
				state.stage === "spec_drafting" &&
				state.drafting &&
				!state.drafting.completed
			) {
				enterSpecMode("drafting", state, cwd, projectConfig);
				updateModeWidget(ctx);

				ctx.ui.notify(
					formatStepBanner(
						"DRAFTING MODE RESUMED",
						`${exchangeCount} previous exchanges. Continue guiding the spec.`,
						"📝",
					),
					"info",
				);
				ctx.ui.notify(`Spec file: ${state.specPath}`, "info");
				ctx.ui.notify("Type /spec-draft-done when satisfied.", "info");

				// Send a resume message
				const fullSpecPath = path.join(cwd, state.specPath);
				pi.sendUserMessage(
					`I'm resuming the spec drafting session for: ${state.description}\n\n` +
						`Spec file path: ${fullSpecPath}\n\n` +
						`Please review the current state and continue drafting.`,
				);
				return;
			}

			await runSpecPipeline(state, cwd, projectConfig, ctx);
		},
	});

	pi.registerCommand("spec-status", {
		description: "Show spec pipeline status",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: SpecState | null;
			if (pipelineId) {
				state = loadSpecState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Spec pipeline not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveSpecPipeline(cwd);
				if (!state) {
					const states = listSpecStates(cwd);
					if (states.length === 0) {
						ctx.ui.notify(
							"No spec pipelines found. Use /spec to start one.",
							"info",
						);
						return;
					}
					state = states[0];
				}
			}

			ctx.ui.notify(formatSpecState(state), "info");

			if (state.stage === "completed") {
				ctx.ui.notify(
					`\n✅ Spec completed. Run: /implement ${state.specPath}`,
					"success",
				);
			} else if (state.stage === "cancelled") {
				ctx.ui.notify("\n🚫 Cancelled. Use /spec-resume to restart.", "info");
			} else if (state.lastError) {
				ctx.ui.notify(
					"\n❌ Stopped due to error. Use /spec-resume to retry.",
					"warning",
				);
			} else {
				ctx.ui.notify("\n▶️ Active. Use /spec-resume to continue.", "info");
			}
		},
	});

	pi.registerCommand("spec-list", {
		description: "List all spec pipelines",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const states = listSpecStates(cwd);

			if (states.length === 0) {
				ctx.ui.notify(
					"No spec pipelines found. Use /spec to start one.",
					"info",
				);
				return;
			}

			const lines: string[] = [];
			lines.push(formatDivider(60));
			lines.push(`  📋 Spec Pipelines (${states.length} total)`);
			lines.push(formatDivider(60));
			lines.push("");

			for (const state of states) {
				const hasError = state.lastError !== undefined;
				let statusIcon = "  ";
				if (state.stage === "completed") statusIcon = "✅";
				else if (state.stage === "cancelled") statusIcon = "🚫";
				else if (hasError) statusIcon = "❌";
				else statusIcon = "▶️";

				lines.push(`${statusIcon} ${state.id || "unknown"}`);
				const desc = state.description || "(no description)";
				lines.push(`   ${desc.slice(0, 55)}${desc.length > 55 ? "..." : ""}`);
				lines.push(`   Stage: ${formatSpecStage(state.stage)}`);
				lines.push(`   Updated: ${state.updatedAt}`);
				if (state.stage === "completed") {
					lines.push(`   Spec: ${state.specPath}`);
				}
				lines.push("");
			}

			lines.push(formatDivider(60));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("spec-cancel", {
		description: "Cancel an active spec pipeline",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: SpecState | null;
			if (pipelineId) {
				state = loadSpecState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Spec pipeline not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveSpecPipeline(cwd);
				if (!state) {
					ctx.ui.notify("No active spec pipeline to cancel.", "info");
					return;
				}
			}

			if (state.stage === "completed" || state.stage === "cancelled") {
				ctx.ui.notify("Pipeline is already finished.", "info");
				return;
			}

			const confirm = await ctx.ui.confirm(
				"Cancel Spec Pipeline?",
				`Cancel spec pipeline ${state.id}?\n\nYou can resume later with /spec-resume.`,
			);

			if (confirm) {
				if (state.stage !== "cancelled") {
					state.stageBeforeCancellation = state.stage;
				}
				state.stage = "cancelled";
				saveSpecState(cwd, state);

				// Clean up conversational mode if active
				if (pipelineMode !== "idle" && activePipelineState?.id === state.id) {
					exitMode();
				}

				clearPipelineWidget(ctx);
				ctx.ui.notify("Pipeline cancelled. Resume with /spec-resume", "info");
			}
		},
	});

	// ============================================
	// IMPLEMENTATION COMMANDS
	// ============================================

	pi.registerCommand("implement", {
		description:
			"Start implementation from a spec file OR text description (text enters discovery mode). Use --no-plan to skip plan generation, --no-review to skip reviews, --auto to run without interactive TTY (agent-driven).",
		handler: async (args, ctx) => {
			const argsStr = args || "";
			const autoMode = argsStr.includes("--auto");

			if (!ctx.hasUI && !autoMode) {
				ctx.ui.notify("spec-pipeline requires interactive mode. Use --auto for non-interactive (agent-driven) runs.", "error");
				return;
			}

			if (pipelineMode === "brainstorm") {
				ctx.ui.notify(
					"Cannot start /implement while a brainstorm session is active. Use /brainstorm-cancel to cancel it first.",
					"error",
				);
				return;
			}

			const argsStr = args || "";
			const noPlan = argsStr.includes("--no-plan");
			const noReview = argsStr.includes("--no-review");
			const argWithoutFlags = argsStr
				.replace("--no-plan", "")
				.replace("--no-review", "")
				.replace("--auto", "")
				.replace(/\s+/g, " ")
				.trim();

			if (!argWithoutFlags) {
				ctx.ui.notify(
					"Usage: /implement [--no-plan] [--no-review] [--auto] <spec-file-or-description>",
					"error",
				);
				return;
			}

			const cwd = ctx.cwd;

			// Check if argument is a file path
			const fullPath = path.isAbsolute(argWithoutFlags)
				? argWithoutFlags
				: path.join(cwd, argWithoutFlags);

			// Check if it's an existing file first (handles edge cases like "fix/bug-123" or files without extensions)
			const isFile = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();

			// Heuristic: if it looks like a file path but doesn't exist, show error
			const looksLikeFilePath =
				argWithoutFlags.includes("/") || /\.(md|typ)$/i.test(argWithoutFlags);
			if (looksLikeFilePath && !isFile) {
				ctx.ui.notify(`Spec file not found: ${argWithoutFlags}`, "error");
				return;
			}

			// If it's a valid file, continue with existing implementation logic
			if (isFile) {
				// *** EXISTING FILE-BASED IMPLEMENTATION LOGIC CONTINUES HERE ***
				const specPath = argWithoutFlags;
				const fullSpecPath = fullPath;
				const specContent = fs.readFileSync(fullSpecPath, "utf-8");
				if (!specContent.trim()) {
					ctx.ui.notify("Spec file is empty", "error");
					return;
				}

				// Make specPath relative to cwd
				const relativeSpecPath = path.isAbsolute(specPath)
					? path.relative(cwd, specPath)
					: specPath;

				// Move autoMode into the closure scope so other functions can read it (if needed)
				const isAutoMode = autoMode;

				// Check for existing active implementation
				const existingPipeline = getLatestActiveImplPipeline(cwd);
				if (existingPipeline && !isAutoMode) {
					const resume = await ctx.ui.confirm(
						"Active Implementation Found",
						`There's an active implementation:\n${formatImplState(existingPipeline)}\n\nStart a NEW implementation? (No = cancel)`,
					);
					if (!resume) {
						ctx.ui.notify(
							"Use /implement-resume to continue the existing implementation",
							"info",
						);
						return;
					}
				} else if (existingPipeline && isAutoMode) {
					// Auto-mode: skip over existing pipeline detection; start fresh
					ctx.ui.notify("Auto-mode: overriding existing pipeline (starting fresh)", "info");
				}

				// Git validation
				const gitValidation = await validateGitRepo(cwd);
				if (!gitValidation.valid) {
					ctx.ui.notify(gitValidation.error!, "error");
					return;
				}

				const gitClean = await checkGitClean(cwd);
				if (!gitClean.clean) {
					ctx.ui.notify(
						"Working directory has uncommitted changes. Please commit or stash first.",
						"error",
					);
					if (gitClean.status) {
						ctx.ui.notify(
							`Changed files:\n${gitClean.status.slice(0, 500)}`,
							"info",
						);
					}
					return;
				}

				// Load config
				const configResult = loadPipelineConfig(cwd);
				if (!configResult.success) {
					ctx.ui.notify(configResult.error, "error");
					return;
				}
				const projectConfig = configResult.config;

				if (noPlan) {
					projectConfig.skipPlanGeneration = true;
				}

				if (noReview) {
					projectConfig.reviewCycles = 0;
				}

				ctx.ui.notify(
					formatEffectiveConfig(projectConfig, configResult.fromFile),
					"info",
				);

				if (noPlan) {
					ctx.ui.notify(
						"⏭️ Plan generation will be skipped (--no-plan flag)",
						"info",
					);
				}

				if (noReview) {
					ctx.ui.notify("⏭️ Reviews will be skipped (--no-review flag)", "info");
				}

				ctx.ui.notify(
					`Starting implementation from: ${relativeSpecPath}`,
					"info",
				);

				// Generate timestamp and names
				const implTimestamp = generateTimestamp();

				// Create initial state
				const state = createInitialImplState(
					relativeSpecPath,
					specContent,
					implTimestamp,
					noPlan,
				);

				state.checkpoints = [];
				saveImplState(cwd, state);

				ctx.ui.notify(
					formatStepBanner("IMPLEMENTATION STARTED", `ID: ${state.id}`, "🚀"),
					"info",
				);
				ctx.ui.notify(`Spec: ${relativeSpecPath}`, "info");

				updateImplWidget(ctx, state, "Initializing...");

				await runImplementPipeline(state, cwd, projectConfig, ctx);
			} else {
				// *** NEW: DISCOVERY MODE ENTRY ***
				const description = argWithoutFlags;

				// Check for existing active implement pipeline
				const existingPipeline = getLatestActiveImplPipeline(cwd);
				if (existingPipeline) {
					const proceed = await ctx.ui.confirm(
						"Active Implementation Pipeline Found",
						`There's an active implementation pipeline:\n${formatImplState(existingPipeline)}\n\nDo you want to continue with a NEW pipeline? (No = cancel)`,
					);
					if (!proceed) {
						ctx.ui.notify(
							"Use /implement-resume to continue the existing pipeline",
							"info",
						);
						return;
					}
				}

				// Git validation (repo must exist, but don't check clean yet - deferred to /discovery-done)
				const gitValidation = await validateGitRepo(cwd);
				if (!gitValidation.valid) {
					ctx.ui.notify(gitValidation.error!, "error");
					return;
				}

				// Load config
				const configResult = loadPipelineConfig(cwd);
				if (!configResult.success) {
					ctx.ui.notify(configResult.error, "error");
					return;
				}
				const projectConfig = configResult.config;

				ctx.ui.notify(
					formatEffectiveConfig(projectConfig, configResult.fromFile),
					"info",
				);
				ctx.ui.notify("Starting implementation discovery...", "info");
				if (projectConfig.contextFiles.length > 0) {
					ctx.ui.notify(
						`Using context from: ${projectConfig.contextFiles.join(", ")}`,
						"info",
					);
				}

				// Generate timestamp and prompt for short name
				const timestamp = generateTimestamp();
				const { shortName } = await promptForShortName(ctx, description);

				// Create ephemeral conversational state (not persisted to disk)
				const discoveryState: ConversationalPipelineState = {
					id: generatePipelineId(),
					description,
					discovery: {
						skipped: false,
						conversationHistory: [],
						completed: false,
					},
				};

				// Enter implement-discovery mode
				enterImplementDiscoveryMode(
					cwd,
					projectConfig,
					discoveryState,
					{ noPlan, noReview },
					shortName,
					timestamp,
				);
				updateModeWidget(ctx);

				ctx.ui.notify(
					formatStepBanner(
						"IMPLEMENTATION DISCOVERY MODE",
						"The LLM will explore the codebase, propose assumptions, and ask you to confirm.",
						"🔍",
					),
					"info",
				);
				ctx.ui.notify(
					"The LLM will propose what it thinks is the best approach for each aspect, one at a time. Confirm or correct each assumption.",
					"info",
				);
				ctx.ui.notify(
					"(This is the same discovery process as /spec - conversational and iterative)",
					"info",
				);
				ctx.ui.notify(
					"When you're satisfied with the discovery, type /discovery-done to proceed to implementation.",
					"info",
				);

				if (noPlan) {
					ctx.ui.notify(
						"⚡ --no-plan flag will be applied after discovery",
						"info",
					);
				}
				if (noReview) {
					ctx.ui.notify(
						"⚡ --no-review flag will be applied after discovery",
						"info",
					);
				}

				// Send the initial discovery message
				pi.sendUserMessage(
					`I want to implement the following: ${description}\n\n` +
						`Please explore the codebase, identify the most important ambiguity or decision point, and propose your best assumption for how it should work.`,
				);
			}
		},
	});

	pi.registerCommand("implement-resume", {
		description: "Resume an active implementation pipeline",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: ImplementationState | null;
			if (pipelineId) {
				state = loadImplState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Implementation not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveImplPipeline(cwd);
				if (!state) {
					ctx.ui.notify(
						"No active implementation found. Use /implement to start one.",
						"error",
					);
					return;
				}
			}

			if (state.stage === "completed") {
				ctx.ui.notify("This implementation is already completed.", "info");
				return;
			}

			if (state.stage === "cancelled") {
				const restart = await ctx.ui.confirm(
					"Implementation Cancelled",
					"This implementation was cancelled. Restart from where it left off?",
				);
				if (!restart) return;

				if (
					state.stageBeforeCancellation &&
					state.stageBeforeCancellation !== "cancelled"
				) {
					ctx.ui.notify(
						`Resuming from saved stage: ${formatImplStage(state.stageBeforeCancellation)}`,
						"info",
					);
					state.stage = state.stageBeforeCancellation;
					state.stageBeforeCancellation = undefined;
				} else {
					// Plan generation and implementation are now interleaved per-phase,
					// so always resume into "implementation" stage
					state.stage = "implementation";
				}
				saveImplState(cwd, state);
			}

			// Git validation
			const gitValidation = await validateGitRepo(cwd);
			if (!gitValidation.valid) {
				ctx.ui.notify(gitValidation.error!, "error");
				return;
			}

			const gitClean = await checkGitClean(cwd);
			if (!gitClean.clean) {
				ctx.ui.notify(
					"Working directory has uncommitted changes. Please commit or stash first.",
					"error",
				);
				if (gitClean.status) {
					ctx.ui.notify(
						`Changed files:\n${gitClean.status.slice(0, 500)}`,
						"info",
					);
				}
				return;
			}

			// Clean up error stash if present
			if (state.errorStash) {
				const stashStillExists = await stashExists(cwd, state.errorStash);
				if (stashStillExists) {
					ctx.ui.notify(
						"Dropping stashed changes from previous error...",
						"info",
					);
					await dropStash(cwd, state.errorStash);
				}
				state.errorStash = undefined;
				saveImplState(cwd, state);
			}

			ctx.ui.notify(
				formatStepBanner("RESUMING IMPLEMENTATION", `ID: ${state.id}`, "🔄"),
				"info",
			);
			ctx.ui.notify(`Current stage: ${formatImplStage(state.stage)}`, "info");

			if (state.skipPlanGeneration) {
				ctx.ui.notify("📌 Plan generation is skipped (--no-plan)", "info");
			}

			updateImplWidget(ctx, state, "Resuming...");

			const configResult = loadPipelineConfig(cwd);
			if (!configResult.success) {
				ctx.ui.notify(configResult.error, "error");
				return;
			}
			const projectConfig = configResult.config;

			// Handle error retry
			if (state.lastError) {
				if (typeof state.lastError === "string") {
					ctx.ui.notify(
						`Previous error (legacy): ${state.lastError.slice(0, 200)}`,
						"warning",
					);
					state.lastError = undefined;
					saveImplState(cwd, state);
				} else if (state.lastError.agentTask) {
					const errorDisplay = formatErrorForRetry(state.lastError, state);
					ctx.ui.notify(errorDisplay, "info");

					const shouldRetry = await ctx.ui.confirm(
						"Retry Failed Operation?",
						`The implementation failed at ${state.lastError.role}.\n\nRetry the same operation?`,
					);

					if (!shouldRetry) {
						ctx.ui.notify("Resume cancelled.", "info");
						return;
					}

					const retrySuccess = await retryFailedOperation(
						state,
						cwd,
						projectConfig,
						() => saveImplState(cwd, state),
						ctx,
					);

					if (!retrySuccess) {
						ctx.ui.notify(
							"Retry failed. Run /implement-resume to try again.",
							"info",
						);
						return;
					}

					ctx.ui.notify("Retry successful! Continuing pipeline...", "success");
				} else {
					state.lastError = undefined;
					saveImplState(cwd, state);
				}
			}

			await runImplementPipeline(state, cwd, projectConfig, ctx);
		},
	});

	pi.registerCommand("implement-status", {
		description: "Show implementation status",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: ImplementationState | null;
			if (pipelineId) {
				state = loadImplState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Implementation not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveImplPipeline(cwd);
				if (!state) {
					const states = listImplStates(cwd);
					if (states.length === 0) {
						ctx.ui.notify(
							"No implementations found. Use /implement to start one.",
							"info",
						);
						return;
					}
					state = states[0];
				}
			}

			ctx.ui.notify(formatImplState(state), "info");

			if (state.stage === "completed") {
				ctx.ui.notify("\n✅ Implementation completed.", "success");
			} else if (state.stage === "cancelled") {
				ctx.ui.notify(
					"\n🚫 Cancelled. Use /implement-resume to restart.",
					"info",
				);
			} else if (state.lastError) {
				ctx.ui.notify(
					"\n❌ Stopped due to error. Use /implement-resume to retry.",
					"warning",
				);
			} else {
				ctx.ui.notify("\n▶️ Active. Use /implement-resume to continue.", "info");
			}
		},
	});

	pi.registerCommand("implement-list", {
		description: "List all implementations",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const states = listImplStates(cwd);

			if (states.length === 0) {
				ctx.ui.notify(
					"No implementations found. Use /implement to start one.",
					"info",
				);
				return;
			}

			const lines: string[] = [];
			lines.push(formatDivider(60));
			lines.push(`  🚀 Implementations (${states.length} total)`);
			lines.push(formatDivider(60));
			lines.push("");

			for (const state of states) {
				const hasError = state.lastError !== undefined;
				let statusIcon = "  ";
				if (state.stage === "completed") statusIcon = "✅";
				else if (state.stage === "cancelled") statusIcon = "🚫";
				else if (hasError) statusIcon = "❌";
				else statusIcon = "▶️";

				lines.push(`${statusIcon} ${state.id || "unknown"}`);
				lines.push(`   Spec: ${state.specPath}`);
				lines.push(`   Stage: ${formatImplStage(state.stage)}`);
				const phases = state.phases || [];
				if (phases.length > 0) {
					lines.push(
						`   Phases: ${state.currentPhaseIndex + 1}/${phases.length}`,
					);
				}
				lines.push(`   Updated: ${state.updatedAt}`);
				lines.push("");
			}

			lines.push(formatDivider(60));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("implement-cancel", {
		description: "Cancel an active implementation or discovery session",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			// Check if we're in implement-discovery mode (ephemeral, not persisted)
			if (pipelineMode === "discovery" && activePipelineKind === "implement") {
				exitMode();
				clearPipelineWidget(ctx);
				ctx.ui.notify("Discovery session cancelled.", "info");
				return;
			}

			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: ImplementationState | null;
			if (pipelineId) {
				state = loadImplState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Implementation not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveImplPipeline(cwd);
				if (!state) {
					ctx.ui.notify("No active implementation to cancel.", "info");
					return;
				}
			}

			if (state.stage === "completed" || state.stage === "cancelled") {
				ctx.ui.notify("Implementation is already finished.", "info");
				return;
			}

			const confirm = await ctx.ui.confirm(
				"Cancel Implementation?",
				`Cancel implementation ${state.id}?\n\nYou can resume later with /implement-resume.`,
			);

			if (confirm) {
				if (state.stage !== "cancelled") {
					state.stageBeforeCancellation = state.stage;
				}
				state.stage = "cancelled";
				saveImplState(cwd, state);

				clearPipelineWidget(ctx);
				ctx.ui.notify(
					"Implementation cancelled. Resume with /implement-resume",
					"info",
				);
			}
		},
	});

	pi.registerCommand("implement-metrics", {
		description: "Export implementation metrics for A/B testing",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let statesToExport: ImplementationState[] = [];

			if (pipelineId === "--all") {
				statesToExport = listImplStates(cwd).filter(
					(s) => s.stage === "completed" && s.metrics,
				);
			} else if (pipelineId) {
				const state = loadImplState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Implementation not found: ${pipelineId}`, "error");
					return;
				}
				if (state.metrics) {
					statesToExport = [state];
				} else {
					ctx.ui.notify(
						`Implementation ${pipelineId} has no metrics`,
						"warning",
					);
					return;
				}
			} else {
				const states = listImplStates(cwd);
				const completed = states.filter(
					(s) => s.stage === "completed" && s.metrics,
				);
				if (completed.length === 0) {
					ctx.ui.notify(
						"No completed implementations with metrics found.",
						"info",
					);
					return;
				}
				statesToExport = [completed[0]];
			}

			if (statesToExport.length === 0) {
				ctx.ui.notify("No implementations with metrics to export.", "info");
				return;
			}

			const lines: string[] = [];
			lines.push(formatDivider(70));
			lines.push(
				`  📊 Implementation Metrics (${statesToExport.length} pipeline${statesToExport.length > 1 ? "s" : ""})`,
			);
			lines.push(formatDivider(70));
			lines.push("");

			lines.push(
				"| ID | Plan Gen | Duration | Code Review Cycles | First Pass |",
			);
			lines.push(
				"|-----|----------|----------|--------------------|------------|",
			);

			for (const state of statesToExport) {
				const m = state.metrics!;
				const durationMins = m.totalDurationMs
					? Math.round(m.totalDurationMs / 60000)
					: "?";
				const planGen = m.skipPlanGeneration ? "SKIP" : "YES";
				const codeReview = String(m.codeReviewCycles);
				const firstPass = `${m.codeReviewFirstPassRate}%`;

				const stateId = state.id || "unknown";
				lines.push(
					`| ${stateId.slice(0, 16)} | ${planGen.padEnd(8)} | ${String(durationMins).padEnd(8)} | ${codeReview.padEnd(17)} | ${firstPass.padEnd(10)} |`,
				);
			}

			lines.push("");

			if (statesToExport.length === 1) {
				const state = statesToExport[0];
				const m = state.metrics!;

				lines.push("📋 Detailed Metrics:");
				lines.push("");
				lines.push(formatKeyValue("  Pipeline ID", state.id || "unknown"));
				lines.push(formatKeyValue("  Spec Path", state.specPath));
				lines.push(formatKeyValue("  Status", state.stage));
				lines.push("");
				lines.push("  Configuration:");
				lines.push(
					formatKeyValue(
						"    Skip Plan Generation",
						m.skipPlanGeneration ? "Yes (A/B test)" : "No (normal)",
					),
				);
				lines.push("");
				lines.push("  Timing:");
				if (m.totalDurationMs) {
					lines.push(
						formatKeyValue(
							"    Total Duration",
							`${Math.round(m.totalDurationMs / 60000)} minutes`,
						),
					);
				}
				lines.push(
					formatKeyValue("    Agent Calls", String(m.agentCalls.length)),
				);
				lines.push("");
				lines.push("  Review Cycles:");
				lines.push(
					formatKeyValue("    Code Review", String(m.codeReviewCycles)),
				);
				lines.push("");
				lines.push("  Quality:");
				lines.push(
					formatKeyValue(
						"    First Pass Rate",
						`${m.codeReviewFirstPassRate}%`,
					),
				);
				lines.push("");

				const callsByRole: Record<string, number> = {};
				for (const call of m.agentCalls) {
					callsByRole[call.role] = (callsByRole[call.role] || 0) + 1;
				}
				lines.push("  Agent Calls by Role:");
				for (const [role, count] of Object.entries(callsByRole)) {
					lines.push(`    ${role}: ${count}`);
				}
			}

			lines.push("");
			lines.push(formatDivider(70));

			const stateDir = getStateDir(cwd);
			if (!fs.existsSync(stateDir)) {
				fs.mkdirSync(stateDir, { recursive: true });
			}
			const exportPath = path.join(stateDir, "metrics-export.json");
			const exportData = statesToExport.map((s) => ({
				id: s.id,
				specPath: s.specPath,
				stage: s.stage,
				createdAt: s.createdAt,
				metrics: s.metrics,
			}));
			fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
			lines.push(`\n📁 Full metrics exported to: ${exportPath}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ============================================
	// HIERARCHY COMMANDS (Roadmaps & Epics)
	// ============================================

	/**
	 * Shared helper: start a hierarchy pipeline (roadmap or epic)
	 */
	async function startHierarchyPipeline(
		level: HierarchyLevel,
		description: string,
		isQuick: boolean,
		ctx: any,
		parentId?: string,
		parentType?: "roadmap",
		scopingSummary?: string,
	): Promise<void> {
		const cwd = ctx.cwd;

		// Git validation (repo must exist, but dirty state is OK for doc pipelines)
		const gitValidation = await validateGitRepo(cwd);
		if (!gitValidation.valid) {
			ctx.ui.notify(gitValidation.error!, "error");
			return;
		}

		// Load config
		const configResult = loadPipelineConfig(cwd);
		if (!configResult.success) {
			ctx.ui.notify(configResult.error, "error");
			return;
		}
		const projectConfig = configResult.config;

		ctx.ui.notify(
			formatEffectiveConfig(projectConfig, configResult.fromFile),
			"info",
		);
		ctx.ui.notify(`Starting ${level} creation...`, "info");

		// Generate names and timestamps
		const docTimestamp = generateTimestamp();
		const { shortName } = await promptForShortName(ctx, description);

		// Create initial state
		let state: HierarchyState;
		if (level === "roadmap") {
			state = createInitialRoadmapState(
				description,
				docTimestamp,
				shortName,
				projectConfig.specsDir,
				isQuick,
				projectConfig.specFormat,
			);
		} else {
			state = createInitialEpicState(
				description,
				docTimestamp,
				shortName,
				projectConfig.specsDir,
				isQuick,
				projectConfig.specFormat,
				parentId,
				parentType,
			);
		}

		state.checkpoints = [];

		if (level === "roadmap") {
			saveRoadmapState(cwd, state as RoadmapState);
		} else {
			saveEpicState(cwd, state as EpicState);
		}

		const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
		ctx.ui.notify(
			formatStepBanner(
				`${levelLabel.toUpperCase()} CREATION STARTED`,
				`ID: ${state.id}`,
				level === "roadmap" ? "🗺️" : "📋",
			),
			"info",
		);

		if (isQuick) {
			ctx.ui.notify("Skipping discovery phase (--quick mode)", "info");
		}

		// Build parent context if this is an epic under a roadmap
		let parentContext: string | undefined;
		if (parentId && parentType === "roadmap") {
			const parentState = loadRoadmapState(cwd, parentId);
			if (parentState?.docContent) {
				parentContext = `## Parent Roadmap\n\n${parentState.docContent}`;
				if (parentState.discovery?.discoverySummary) {
					parentContext += `\n\n## Roadmap Discovery Context\n\n${parentState.discovery.discoverySummary}`;
				}
			}
		}

		// Append scoping context if available (from /plan command)
		if (scopingSummary) {
			parentContext =
				(parentContext ? parentContext + "\n\n" : "") + scopingSummary;
		}

		// If discovery is enabled (not --quick), enter conversational discovery mode
		const shouldDiscover = !isQuick && state.stage === "discovery";

		if (shouldDiscover) {
			// Initialize conversational discovery state
			state.discovery!.conversationHistory = [];
			if (level === "roadmap") saveRoadmapState(cwd, state as RoadmapState);
			else saveEpicState(cwd, state as EpicState);

			// Enter hierarchy discovery mode
			enterHierarchyMode(
				"discovery",
				state,
				level,
				cwd,
				projectConfig,
				parentContext,
			);

			// Show discovery widget
			updateModeWidget(ctx);

			ctx.ui.notify(
				formatStepBanner(
					`${levelLabel.toUpperCase()} DISCOVERY MODE`,
					"The LLM will explore the codebase, propose assumptions, and ask you to confirm.",
					"🔍",
				),
				"info",
			);
			ctx.ui.notify(
				"The LLM will propose what it thinks is the best approach for each aspect, one at a time. Confirm or correct each assumption.",
				"info",
			);
			ctx.ui.notify(
				"When you're satisfied with the discovery, type /discovery-done to proceed.",
				"info",
			);

			// Send the initial discovery message
			const parentNote = parentContext
				? "\n\nRelevant parent context has been provided."
				: "";
			pi.sendUserMessage(
				`I want to create a ${level} for the following: ${description}${parentNote}\n\n` +
					`Please explore the codebase, identify the most important ambiguity or decision point, and propose your best assumption for how it should work.`,
			);
		} else {
			// --quick mode or discovery disabled: enter conversational drafting directly
			state.drafting = {
				conversationHistory: [],
				completed: false,
			};
			state.stage = "drafting";
			if (level === "roadmap") saveRoadmapState(cwd, state as RoadmapState);
			else saveEpicState(cwd, state as EpicState);

			enterHierarchyMode(
				"drafting",
				state,
				level,
				cwd,
				projectConfig,
				parentContext,
			);
			updateModeWidget(ctx);

			ctx.ui.notify(
				formatStepBanner(
					`${levelLabel.toUpperCase()} DRAFTING MODE`,
					`The LLM will draft the ${level} document. Guide it conversationally.`,
					"📝",
				),
				"info",
			);
			ctx.ui.notify(`Document will be written to: ${state.docPath}`, "info");
			ctx.ui.notify(
				"When satisfied, type /draft-done to proceed to approval.",
				"info",
			);

			// Send the kickoff message
			const fullDocPath = path.join(cwd, state.docPath);
			const parentNote = parentContext
				? "\n\nRelevant parent context has been provided."
				: "";
			pi.sendUserMessage(
				`Please create a ${level} document for: ${description}${parentNote}\n\n` +
					`Write the document to this exact path: ${fullDocPath}\n` +
					`Use document timestamp: ${state.docTimestamp}\n\n` +
					`Explore the codebase first to understand existing patterns, then create a comprehensive ${level} document.`,
			);
		}
	}

	/**
	 * Shared helper: resume a hierarchy pipeline (roadmap or epic)
	 */
	async function resumeHierarchyPipeline(
		level: HierarchyLevel,
		pipelineId: string | undefined,
		ctx: any,
	): Promise<void> {
		const cwd = ctx.cwd;
		const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);

		let state: HierarchyState | null;
		if (pipelineId) {
			state =
				level === "roadmap"
					? loadRoadmapState(cwd, pipelineId)
					: loadEpicState(cwd, pipelineId);
			if (!state) {
				ctx.ui.notify(
					`${levelLabel} pipeline not found: ${pipelineId}`,
					"error",
				);
				return;
			}
		} else {
			state =
				level === "roadmap"
					? getLatestActiveRoadmapPipeline(cwd)
					: getLatestActiveEpicPipeline(cwd);
			if (!state) {
				ctx.ui.notify(
					`No active ${level} pipeline found. Use /${level} to start one.`,
					"error",
				);
				return;
			}
		}

		if (state.stage === "completed") {
			ctx.ui.notify(`This ${level} pipeline is already completed.`, "info");
			return;
		}

		if (state.stage === "cancelled") {
			const restart = await ctx.ui.confirm(
				`${levelLabel} Cancelled`,
				`This ${level} was cancelled. Restart from where it left off?`,
			);
			if (!restart) return;

			if (
				state.stageBeforeCancellation &&
				state.stageBeforeCancellation !== "cancelled"
			) {
				ctx.ui.notify(
					`Resuming from saved stage: ${formatHierarchyStage(state.stageBeforeCancellation)}`,
					"info",
				);
				state.stage = state.stageBeforeCancellation;
				state.stageBeforeCancellation = undefined;
			} else {
				if (state.discovery && !state.discovery.completed) {
					state.stage = "discovery";
				} else if (!state.docApproved) {
					const fullDocPath = path.join(cwd, state.docPath);
					if (fs.existsSync(fullDocPath) && state.docIteration > 0) {
						state.stage = "review";
					} else {
						state.stage = "drafting";
					}
				} else {
					state.stage = "approved";
				}
			}
			if (level === "roadmap") saveRoadmapState(cwd, state as RoadmapState);
			else saveEpicState(cwd, state as EpicState);
		}

		// Git validation (repo must exist, but dirty state is OK for doc pipelines)
		const gitValidation = await validateGitRepo(cwd);
		if (!gitValidation.valid) {
			ctx.ui.notify(gitValidation.error!, "error");
			return;
		}

		// Clean up error stash if present
		if (state.errorStash) {
			const stashStillExists = await stashExists(cwd, state.errorStash);
			if (stashStillExists) {
				ctx.ui.notify(
					"Dropping stashed changes from previous error...",
					"info",
				);
				await dropStash(cwd, state.errorStash);
			}
			state.errorStash = undefined;
			if (level === "roadmap") saveRoadmapState(cwd, state as RoadmapState);
			else saveEpicState(cwd, state as EpicState);
		}

		ctx.ui.notify(
			formatStepBanner(
				`RESUMING ${levelLabel.toUpperCase()}`,
				`ID: ${state.id}`,
				"🔄",
			),
			"info",
		);
		ctx.ui.notify(
			`Current stage: ${formatHierarchyStage(state.stage)}`,
			"info",
		);

		const configResult = loadPipelineConfig(cwd);
		if (!configResult.success) {
			ctx.ui.notify(configResult.error, "error");
			return;
		}
		const projectConfig = configResult.config;

		// If resuming in conversational discovery mode, re-enter discovery mode
		if (
			state.stage === "discovery" &&
			state.discovery &&
			!state.discovery.completed
		) {
			enterHierarchyMode("discovery", state, level, cwd, projectConfig);
			updateModeWidget(ctx);

			ctx.ui.notify(
				formatStepBanner(
					`${levelLabel.toUpperCase()} DISCOVERY MODE RESUMED`,
					`${exchangeCount} previous exchanges. Continue chatting to refine requirements.`,
					"🔍",
				),
				"info",
			);
			ctx.ui.notify("Type /discovery-done when ready to proceed.", "info");

			pi.sendUserMessage(
				`I'm resuming the discovery session for this ${level}: ${state.description}\n\nPlease review what we've discussed so far and continue with the next most important assumption to verify.`,
			);
			return;
		}

		// If resuming in conversational drafting mode, re-enter drafting mode
		if (
			state.stage === "drafting" &&
			state.drafting &&
			!state.drafting.completed
		) {
			enterHierarchyMode("drafting", state, level, cwd, projectConfig);
			updateModeWidget(ctx);

			ctx.ui.notify(
				formatStepBanner(
					`${levelLabel.toUpperCase()} DRAFTING MODE RESUMED`,
					`${exchangeCount} previous exchanges. Continue guiding the ${level} document.`,
					"📝",
				),
				"info",
			);
			ctx.ui.notify(`Document: ${state.docPath}`, "info");
			ctx.ui.notify("Type /draft-done when satisfied.", "info");

			// Send a resume message
			const fullDocPath = path.join(cwd, state.docPath);
			pi.sendUserMessage(
				`I'm resuming the ${level} drafting session for: ${state.description}\n\n` +
					`Document file path: ${fullDocPath}\n\n` +
					`Please review the current state and continue drafting.`,
			);
			return;
		}

		// For approved/completed stages, or user_approval after drafting, continue with pipeline
		await runHierarchyPipeline(state, cwd, projectConfig, ctx);
	}

	// ---- /plan command ----

	pi.registerCommand("plan", {
		description:
			"Unified entry point for planning. Assesses scope and recommends roadmap/epic/feature level. Flags: --quick, --roadmap, --epic, --feature",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			const argsStr = args || "";
			const isQuick = argsStr.includes("--quick");
			const forceRoadmap = argsStr.includes("--roadmap");
			const forceEpic = argsStr.includes("--epic");
			const forceFeature = argsStr.includes("--feature");

			const description = argsStr
				.replace("--quick", "")
				.replace("--roadmap", "")
				.replace("--epic", "")
				.replace("--feature", "")
				.replace(/\s+/g, " ")
				.trim();

			if (!description) {
				ctx.ui.notify(
					"Usage: /plan [--quick] [--roadmap|--epic|--feature] <description>",
					"error",
				);
				return;
			}

			// If a level was explicitly specified, route directly
			if (forceRoadmap) {
				await startHierarchyPipeline("roadmap", description, isQuick, ctx);
				return;
			}
			if (forceEpic) {
				await startHierarchyPipeline("epic", description, isQuick, ctx);
				return;
			}
			if (forceFeature) {
				// Delegate to existing /spec command — notify user to run it
				ctx.ui.notify(
					`Recommendation: Feature level. Run:\n  /spec ${isQuick ? "--quick " : ""}${description}`,
					"info",
				);
				return;
			}

			// Check for existing active scoping session
			if (pipelineMode === "scoping") {
				ctx.ui.notify(
					"A scoping session is already active. Use /plan-done to finish it, or /plan-cancel to cancel.",
					"error",
				);
				return;
			}

			if (pipelineMode === "brainstorm") {
				ctx.ui.notify(
					"Cannot start /plan while a brainstorm session is active. Use /brainstorm-cancel to cancel it first.",
					"error",
				);
				return;
			}

			const cwd = ctx.cwd;

			// Load config
			const configResult = loadPipelineConfig(cwd);
			if (!configResult.success) {
				ctx.ui.notify(configResult.error, "error");
				return;
			}
			const projectConfig = configResult.config;

			// Create ephemeral scoping state
			const scopingState: ScopingState = {
				description,
				isQuick,
				conversationHistory: [],
			};

			// Enter scoping mode
			enterScopingMode(cwd, projectConfig, scopingState);

			// Show scoping widget
			updateModeWidget(ctx);

			ctx.ui.notify(
				formatStepBanner(
					"SCOPING MODE",
					"The agent will explore the codebase and ask questions to assess the right planning level.",
					"🔎",
				),
				"info",
			);
			ctx.ui.notify(
				"Chat naturally to help the agent understand the scope. It will recommend Roadmap, Epic, or Feature.",
				"info",
			);
			ctx.ui.notify(
				"Type /plan-done when ready to proceed with the recommendation.",
				"info",
			);

			// Send the initial scoping message
			pi.sendUserMessage(
				`I want to build the following: ${description}\n\n` +
					`Please explore the codebase and assess what level of planning this needs ` +
					`(roadmap for large multi-epic initiatives, epic for medium multi-feature efforts, or feature for a single spec). ` +
					`Ask me scoping questions if needed.`,
			);
		},
	});

	pi.registerCommand("plan-done", {
		description:
			"End scoping assessment and proceed with the recommended level",
		handler: async (_args, ctx) => {
			if (
				pipelineMode !== "scoping" ||
				!activeScopingState ||
				!activeCwd ||
				!activeProjectConfig
			) {
				ctx.ui.notify(
					"No active scoping session. Use /plan to start one.",
					"error",
				);
				return;
			}

			const scopingState = activeScopingState;
			const cwd = activeCwd;
			const projectConfig = activeProjectConfig;
			const scopingExchanges = exchangeCount;

			if (scopingExchanges === 0) {
				const proceed = await ctx.ui.confirm(
					"No Scoping Exchanges",
					"No conversation exchanges recorded yet. Proceed anyway?",
				);
				if (!proceed) return;
			}

			// Parse the recommended level from the conversation
			const recommendedLevel = parseRecommendedLevel(scopingState);

			// Build scoping summary for forwarding to child pipeline
			const scopingSummary = buildScopingSummary(scopingState);
			const description = scopingState.description;
			const isQuick = scopingState.isQuick;

			// Exit scoping mode
			exitMode();
			clearPipelineWidget(ctx);

			ctx.ui.notify(
				formatStepBanner(
					"SCOPING COMPLETE",
					`${scopingExchanges} exchange${scopingExchanges !== 1 ? "s" : ""} recorded.`,
					"✅",
				),
				"success",
			);

			// Present recommendation or let user choose
			let chosenLevel: HierarchyLevel;

			if (recommendedLevel) {
				const levelLabels: Record<HierarchyLevel, string> = {
					roadmap: "Roadmap (large initiative → multiple epics)",
					epic: "Epic (medium effort → multiple feature specs)",
					feature: "Feature (single spec → direct implementation)",
				};

				const confirmed = await ctx.ui.confirm(
					"Scoping Recommendation",
					`The agent recommends: **${levelLabels[recommendedLevel]}**\n\nAccept this recommendation?`,
				);

				if (confirmed) {
					chosenLevel = recommendedLevel;
				} else {
					// Let user override
					const levelChoices = [
						"Roadmap (large initiative → multiple epics, months of work)",
						"Epic (medium effort → multiple feature specs, weeks of work)",
						"Feature (single spec → direct implementation, days of work)",
					];

					const choice = await ctx.ui.select(
						"Override: Select the planning level",
						levelChoices,
					);

					if (choice === levelChoices[0]) {
						chosenLevel = "roadmap";
					} else if (choice === levelChoices[1]) {
						chosenLevel = "epic";
					} else {
						chosenLevel = "feature";
					}
				}
			} else {
				// No recommendation found — let user choose
				ctx.ui.notify(
					"The agent didn't provide a clear recommendation. Please choose a level.",
					"warning",
				);

				const levelChoices = [
					"Roadmap (large initiative → multiple epics, months of work)",
					"Epic (medium effort → multiple feature specs, weeks of work)",
					"Feature (single spec → direct implementation, days of work)",
				];

				const choice = await ctx.ui.select(
					"Select the planning level",
					levelChoices,
				);

				if (choice === levelChoices[0]) {
					chosenLevel = "roadmap";
				} else if (choice === levelChoices[1]) {
					chosenLevel = "epic";
				} else {
					chosenLevel = "feature";
				}
			}

			const levelLabel =
				chosenLevel.charAt(0).toUpperCase() + chosenLevel.slice(1);
			ctx.ui.notify(
				`Selected: ${levelLabel} level. Starting pipeline...`,
				"info",
			);

			// Route to the appropriate pipeline, forwarding scoping context
			if (chosenLevel === "feature") {
				// Store scoping context so the next /spec invocation picks it up
				if (scopingSummary) {
					pendingScopingContext = scopingSummary;
				}
				ctx.ui.notify(
					`Run:\n  /spec ${isQuick ? "--quick " : ""}${description}`,
					"info",
				);
				if (scopingSummary) {
					ctx.ui.notify(
						"✅ Scoping context saved — it will be automatically included when you run /spec.",
						"info",
					);
				}
			} else {
				await startHierarchyPipeline(
					chosenLevel,
					description,
					isQuick,
					ctx,
					undefined,
					undefined,
					scopingSummary,
				);
			}
		},
	});

	pi.registerCommand("plan-cancel", {
		description: "Cancel an active scoping session",
		handler: async (_args, ctx) => {
			if (pipelineMode !== "scoping") {
				ctx.ui.notify("No active scoping session to cancel.", "info");
				return;
			}

			exitMode();
			clearPipelineWidget(ctx);
			ctx.ui.notify("Scoping session cancelled.", "info");
		},
	});

	// ---- /roadmap commands ----

	pi.registerCommand("roadmap", {
		description:
			"Create a roadmap (high-level initiative → epics). Use --quick to skip discovery.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			if (pipelineMode === "brainstorm") {
				ctx.ui.notify(
					"Cannot start /roadmap while a brainstorm session is active. Use /brainstorm-cancel to cancel it first.",
					"error",
				);
				return;
			}

			const argsStr = args || "";
			const isQuick = argsStr.includes("--quick");
			const description = argsStr
				.replace("--quick", "")
				.replace(/\s+/g, " ")
				.trim();

			if (!description) {
				ctx.ui.notify("Usage: /roadmap [--quick] <description>", "error");
				return;
			}

			// Check for existing active roadmap
			const cwd = ctx.cwd;
			const existingPipeline = getLatestActiveRoadmapPipeline(cwd);
			if (existingPipeline) {
				const resume = await ctx.ui.confirm(
					"Active Roadmap Found",
					`There's an active roadmap:\n${formatRoadmapState(existingPipeline)}\n\nStart a NEW roadmap? (No = cancel)`,
				);
				if (!resume) {
					ctx.ui.notify(
						"Use /roadmap-resume to continue the existing roadmap",
						"info",
					);
					return;
				}
			}

			await startHierarchyPipeline("roadmap", description, isQuick, ctx);
		},
	});

	pi.registerCommand("roadmap-resume", {
		description: "Resume an active roadmap pipeline",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}
			await resumeHierarchyPipeline(
				"roadmap",
				(args || "").trim() || undefined,
				ctx,
			);
		},
	});

	pi.registerCommand("roadmap-status", {
		description: "Show roadmap status with hierarchical progress",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: RoadmapState | null;
			if (pipelineId) {
				state = loadRoadmapState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Roadmap not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveRoadmapPipeline(cwd);
				if (!state) {
					const states = listRoadmapStates(cwd);
					if (states.length === 0) {
						ctx.ui.notify(
							"No roadmaps found. Use /roadmap to start one.",
							"info",
						);
						return;
					}
					state = states[0];
				}
			}

			ctx.ui.notify(formatRoadmapState(state), "info");

			// Show child epic statuses
			if (state.children.length > 0) {
				for (const child of state.children) {
					if (child.childPipelineId) {
						const epicState = loadEpicState(cwd, child.childPipelineId);
						if (epicState) {
							child.childStatus =
								epicState.stage === "completed"
									? "completed"
									: epicState.stage === "cancelled"
										? "cancelled"
										: "in_progress";
						}
					}
				}
				// Re-display with updated statuses
				saveRoadmapState(cwd, state);
			}
		},
	});

	pi.registerCommand("roadmap-list", {
		description: "List all roadmaps",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const states = listRoadmapStates(cwd);

			if (states.length === 0) {
				ctx.ui.notify("No roadmaps found. Use /roadmap to start one.", "info");
				return;
			}

			const lines: string[] = [];
			lines.push(formatDivider(60));
			lines.push(`  🗺️ Roadmaps (${states.length} total)`);
			lines.push(formatDivider(60));
			lines.push("");

			for (const state of states) {
				let statusIcon = "  ";
				if (state.stage === "completed") statusIcon = "✅";
				else if (state.stage === "cancelled") statusIcon = "🚫";
				else if (state.lastError) statusIcon = "❌";
				else statusIcon = "▶️";

				lines.push(`${statusIcon} ${state.id || "unknown"}`);
				const desc = state.description || "(no description)";
				lines.push(`   ${desc.slice(0, 55)}${desc.length > 55 ? "..." : ""}`);
				lines.push(`   Stage: ${formatHierarchyStage(state.stage)}`);
				if (state.children.length > 0) {
					const completed = state.children.filter(
						(c) => c.childStatus === "completed",
					).length;
					lines.push(
						`   Children: ${completed}/${state.children.length} completed`,
					);
				}
				lines.push(`   Updated: ${state.updatedAt}`);
				lines.push("");
			}

			lines.push(formatDivider(60));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("roadmap-cancel", {
		description: "Cancel an active roadmap pipeline",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: RoadmapState | null;
			if (pipelineId) {
				state = loadRoadmapState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Roadmap not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveRoadmapPipeline(cwd);
				if (!state) {
					ctx.ui.notify("No active roadmap to cancel.", "info");
					return;
				}
			}

			if (state.stage === "completed" || state.stage === "cancelled") {
				ctx.ui.notify("Roadmap is already finished.", "info");
				return;
			}

			const confirm = await ctx.ui.confirm(
				"Cancel Roadmap?",
				`Cancel roadmap ${state.id}?\n\nYou can resume later with /roadmap-resume.`,
			);

			if (confirm) {
				if (state.stage !== "cancelled") {
					state.stageBeforeCancellation = state.stage;
				}
				state.stage = "cancelled";
				saveRoadmapState(cwd, state);

				// Clean up conversational mode if active
				if (pipelineMode !== "idle" && activePipelineState?.id === state.id) {
					exitMode();
				}

				clearPipelineWidget(ctx);
				ctx.ui.notify("Roadmap cancelled. Resume with /roadmap-resume", "info");
			}
		},
	});

	// ---- /epic commands ----

	pi.registerCommand("epic", {
		description:
			"Create an epic (medium effort → feature specs). Use --quick to skip discovery, --roadmap <id> to link to a roadmap.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			if (pipelineMode === "brainstorm") {
				ctx.ui.notify(
					"Cannot start /epic while a brainstorm session is active. Use /brainstorm-cancel to cancel it first.",
					"error",
				);
				return;
			}

			const argsStr = args || "";
			const isQuick = argsStr.includes("--quick");

			// Extract --roadmap <id> flag
			let parentId: string | undefined;
			const roadmapMatch = argsStr.match(/--roadmap\s+(\S+)/);
			if (roadmapMatch) {
				parentId = roadmapMatch[1];
			}

			const description = argsStr
				.replace("--quick", "")
				.replace(/--roadmap\s+\S+/, "")
				.replace(/\s+/g, " ")
				.trim();

			if (!description) {
				ctx.ui.notify(
					"Usage: /epic [--quick] [--roadmap <id>] <description>",
					"error",
				);
				return;
			}

			// Check for existing active epic
			const cwd = ctx.cwd;
			const existingPipeline = getLatestActiveEpicPipeline(cwd);
			if (existingPipeline) {
				const resume = await ctx.ui.confirm(
					"Active Epic Found",
					`There's an active epic:\n${formatEpicState(existingPipeline)}\n\nStart a NEW epic? (No = cancel)`,
				);
				if (!resume) {
					ctx.ui.notify(
						"Use /epic-resume to continue the existing epic",
						"info",
					);
					return;
				}
			}

			// Validate parent if specified
			if (parentId) {
				const parentState = loadRoadmapState(cwd, parentId);
				if (!parentState) {
					ctx.ui.notify(`Parent roadmap not found: ${parentId}`, "error");
					return;
				}
				if (!parentState.docApproved) {
					ctx.ui.notify("Parent roadmap has not been approved yet.", "error");
					return;
				}
			}

			await startHierarchyPipeline(
				"epic",
				description,
				isQuick,
				ctx,
				parentId,
				parentId ? "roadmap" : undefined,
			);
		},
	});

	pi.registerCommand("epic-resume", {
		description: "Resume an active epic pipeline",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}
			await resumeHierarchyPipeline(
				"epic",
				(args || "").trim() || undefined,
				ctx,
			);
		},
	});

	pi.registerCommand("epic-status", {
		description: "Show epic status with hierarchical progress",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: EpicState | null;
			if (pipelineId) {
				state = loadEpicState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Epic not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveEpicPipeline(cwd);
				if (!state) {
					const states = listEpicStates(cwd);
					if (states.length === 0) {
						ctx.ui.notify("No epics found. Use /epic to start one.", "info");
						return;
					}
					state = states[0];
				}
			}

			ctx.ui.notify(formatEpicState(state), "info");

			// Show child spec statuses
			if (state.children.length > 0) {
				for (const child of state.children) {
					if (child.childPipelineId) {
						const specState = loadSpecState(cwd, child.childPipelineId);
						if (specState) {
							child.childStatus =
								specState.stage === "completed"
									? "completed"
									: specState.stage === "cancelled"
										? "cancelled"
										: "in_progress";
						}
					}
				}
				saveEpicState(cwd, state);
			}
		},
	});

	pi.registerCommand("epic-list", {
		description: "List all epics",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const states = listEpicStates(cwd);

			if (states.length === 0) {
				ctx.ui.notify("No epics found. Use /epic to start one.", "info");
				return;
			}

			const lines: string[] = [];
			lines.push(formatDivider(60));
			lines.push(`  📋 Epics (${states.length} total)`);
			lines.push(formatDivider(60));
			lines.push("");

			for (const state of states) {
				let statusIcon = "  ";
				if (state.stage === "completed") statusIcon = "✅";
				else if (state.stage === "cancelled") statusIcon = "🚫";
				else if (state.lastError) statusIcon = "❌";
				else statusIcon = "▶️";

				lines.push(`${statusIcon} ${state.id || "unknown"}`);
				const desc = state.description || "(no description)";
				lines.push(`   ${desc.slice(0, 55)}${desc.length > 55 ? "..." : ""}`);
				lines.push(`   Stage: ${formatHierarchyStage(state.stage)}`);
				if (state.parentId)
					lines.push(`   Parent: ${state.parentType}:${state.parentId}`);
				if (state.children.length > 0) {
					const completed = state.children.filter(
						(c) => c.childStatus === "completed",
					).length;
					lines.push(
						`   Children: ${completed}/${state.children.length} completed`,
					);
				}
				lines.push(`   Updated: ${state.updatedAt}`);
				lines.push("");
			}

			lines.push(formatDivider(60));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("epic-cancel", {
		description: "Cancel an active epic pipeline",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: EpicState | null;
			if (pipelineId) {
				state = loadEpicState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Epic not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveEpicPipeline(cwd);
				if (!state) {
					ctx.ui.notify("No active epic to cancel.", "info");
					return;
				}
			}

			if (state.stage === "completed" || state.stage === "cancelled") {
				ctx.ui.notify("Epic is already finished.", "info");
				return;
			}

			const confirm = await ctx.ui.confirm(
				"Cancel Epic?",
				`Cancel epic ${state.id}?\n\nYou can resume later with /epic-resume.`,
			);

			if (confirm) {
				if (state.stage !== "cancelled") {
					state.stageBeforeCancellation = state.stage;
				}
				state.stage = "cancelled";
				saveEpicState(cwd, state);

				// Clean up conversational mode if active
				if (pipelineMode !== "idle" && activePipelineState?.id === state.id) {
					exitMode();
				}

				clearPipelineWidget(ctx);
				ctx.ui.notify("Epic cancelled. Resume with /epic-resume", "info");
			}
		},
	});

	// ---- /plan-overview command ----

	pi.registerCommand("plan-overview", {
		description:
			"Show full hierarchy tree from any level. Usage: /plan-overview [id]",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const targetId = (args || "").trim();

			const lines: string[] = [];
			lines.push(formatDivider(65));
			lines.push("  🌳 Plan Overview — Hierarchical Work Tree");
			lines.push(formatDivider(65));
			lines.push("");

			const roadmaps = listRoadmapStates(cwd);
			const epics = listEpicStates(cwd);
			const specs = listSpecStates(cwd);

			// If a specific ID was given, find it and show its tree
			if (targetId) {
				// Check if it's a roadmap
				const roadmap = loadRoadmapState(cwd, targetId);
				if (roadmap) {
					renderRoadmapTree(lines, roadmap, cwd);
					lines.push("");
					lines.push(formatDivider(65));
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				// Check if it's an epic
				const epic = loadEpicState(cwd, targetId);
				if (epic) {
					// If epic has a parent roadmap, show from there
					if (epic.parentId) {
						const parentRoadmap = loadRoadmapState(cwd, epic.parentId);
						if (parentRoadmap) {
							renderRoadmapTree(lines, parentRoadmap, cwd);
							lines.push("");
							lines.push(formatDivider(65));
							ctx.ui.notify(lines.join("\n"), "info");
							return;
						}
					}
					// Show standalone epic tree
					renderEpicTree(lines, epic, cwd, "");
					lines.push("");
					lines.push(formatDivider(65));
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				// Check if it's a spec
				const spec = loadSpecState(cwd, targetId);
				if (spec) {
					lines.push(
						`  📄 Feature: ${spec.description?.slice(0, 50) || "(no description)"}`,
					);
					lines.push(`     Stage: ${formatSpecStage(spec.stage)}`);
					lines.push(`     Spec: ${spec.specPath}`);
					lines.push("");
					lines.push(formatDivider(65));
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				ctx.ui.notify(`No pipeline found with ID: ${targetId}`, "error");
				return;
			}

			// No ID specified — show all hierarchies
			if (roadmaps.length === 0 && epics.length === 0 && specs.length === 0) {
				ctx.ui.notify(
					"No pipelines found. Use /plan, /roadmap, /epic, or /spec to get started.",
					"info",
				);
				return;
			}

			// Show roadmaps and their children
			for (const roadmap of roadmaps) {
				renderRoadmapTree(lines, roadmap, cwd);
				lines.push("");
			}

			// Show standalone epics (not under a roadmap)
			const standaloneEpics = epics.filter((e) => !e.parentId);
			for (const epic of standaloneEpics) {
				renderEpicTree(lines, epic, cwd, "");
				lines.push("");
			}

			// Show standalone specs (not under an epic)
			const epicChildSpecIds = new Set<string>();
			for (const epic of epics) {
				for (const child of epic.children) {
					if (child.childPipelineId)
						epicChildSpecIds.add(child.childPipelineId);
				}
			}
			const standaloneSpecs = specs.filter((s) => !epicChildSpecIds.has(s.id));
			if (standaloneSpecs.length > 0) {
				lines.push("  📄 Standalone Features:");
				for (const spec of standaloneSpecs.slice(0, 10)) {
					const stageIcon =
						spec.stage === "completed"
							? "✅"
							: spec.stage === "cancelled"
								? "🚫"
								: "▶️";
					lines.push(
						`     ${stageIcon} ${spec.description?.slice(0, 45) || spec.id} (${formatSpecStage(spec.stage)})`,
					);
				}
				if (standaloneSpecs.length > 10) {
					lines.push(`     ... and ${standaloneSpecs.length - 10} more`);
				}
				lines.push("");
			}

			lines.push(formatDivider(65));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	/** Helper: render a roadmap tree into lines */
	function renderRoadmapTree(
		lines: string[],
		roadmap: RoadmapState,
		cwd: string,
	): void {
		const stageIcon =
			roadmap.stage === "completed"
				? "✅"
				: roadmap.stage === "cancelled"
					? "🚫"
					: "▶️";
		lines.push(
			`  ${stageIcon} 🗺️ Roadmap: ${roadmap.description?.slice(0, 45) || roadmap.id}`,
		);
		lines.push(
			`     Stage: ${formatHierarchyStage(roadmap.stage)} | ID: ${roadmap.id}`,
		);

		if (roadmap.children.length > 0) {
			for (let i = 0; i < roadmap.children.length; i++) {
				const child = roadmap.children[i];
				const isLast = i === roadmap.children.length - 1;
				const prefix = isLast ? "  └── " : "  ├── ";
				const childPrefix = isLast ? "      " : "  │   ";

				if (child.childPipelineId) {
					const epicState = loadEpicState(cwd, child.childPipelineId);
					if (epicState) {
						// Update status
						child.childStatus =
							epicState.stage === "completed"
								? "completed"
								: epicState.stage === "cancelled"
									? "cancelled"
									: epicState.stage !== "approved" &&
											epicState.stage !== "in_progress"
										? "pending"
										: "in_progress";

						const epicIcon =
							child.childStatus === "completed"
								? "✅"
								: child.childStatus === "in_progress"
									? "🔄"
									: child.childStatus === "cancelled"
										? "🚫"
										: "⬜";
						lines.push(
							`${prefix}${epicIcon} ${child.number}. ${child.name} [${child.priority}]`,
						);
						renderEpicTree(lines, epicState, cwd, childPrefix);
						continue;
					}
				}

				// Child not yet created
				const deps =
					child.dependencies.length > 0
						? ` (deps: ${child.dependencies.join(", ")})`
						: "";
				lines.push(
					`${prefix}⬜ ${child.number}. ${child.name} [${child.priority}]${deps} — not started`,
				);
			}
		}
	}

	/** Helper: render an epic tree into lines */
	function renderEpicTree(
		lines: string[],
		epic: EpicState,
		cwd: string,
		indent: string,
	): void {
		if (!indent) {
			const stageIcon =
				epic.stage === "completed"
					? "✅"
					: epic.stage === "cancelled"
						? "🚫"
						: "▶️";
			lines.push(
				`  ${stageIcon} 📋 Epic: ${epic.description?.slice(0, 45) || epic.id}`,
			);
			lines.push(
				`     Stage: ${formatHierarchyStage(epic.stage)} | ID: ${epic.id}`,
			);
			indent = "  ";
		}

		if (epic.children.length > 0) {
			for (let i = 0; i < epic.children.length; i++) {
				const child = epic.children[i];
				const isLast = i === epic.children.length - 1;
				const prefix = `${indent}${isLast ? "└── " : "├── "}`;

				if (child.childPipelineId) {
					const specState = loadSpecState(cwd, child.childPipelineId);
					if (specState) {
						child.childStatus =
							specState.stage === "completed"
								? "completed"
								: specState.stage === "cancelled"
									? "cancelled"
									: "in_progress";
						const specIcon =
							child.childStatus === "completed"
								? "✅"
								: child.childStatus === "in_progress"
									? "🔄"
									: child.childStatus === "cancelled"
										? "🚫"
										: "⬜";
						lines.push(
							`${prefix}${specIcon} ${child.number}. ${child.name} [${child.priority}]`,
						);
						continue;
					}
				}

				const deps =
					child.dependencies.length > 0
						? ` (deps: ${child.dependencies.join(", ")})`
						: "";
				lines.push(
					`${prefix}⬜ ${child.number}. ${child.name} [${child.priority}]${deps} — not started`,
				);
			}
		}
	}

	// ============================================
	// BRAINSTORM COMMANDS
	// ============================================

	pi.registerCommand("brainstorm", {
		description:
			"Start a brainstorming session for open-ended idea exploration.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			const description = (args || "").trim();
			if (!description) {
				ctx.ui.notify(
					"Usage: /brainstorm <description of what you want to explore>",
					"error",
				);
				return;
			}

			// Check for mode conflicts — reject if any pipeline mode is active
			if (pipelineMode !== "idle") {
				const modeLabels: Record<PipelineMode, string> = {
					idle: "",
					scoping: "scoping session (/plan)",
					discovery: "discovery session",
					drafting: "drafting session",
					brainstorm: "brainstorm session",
				};
				ctx.ui.notify(
					`Cannot start brainstorm: a ${modeLabels[pipelineMode]} is already active.\n` +
						`Finish or cancel the current session first.`,
					"error",
				);
				return;
			}

			const cwd = ctx.cwd;

			// Check for existing active brainstorm pipeline
			const existingPipeline = getLatestActiveBrainstormPipeline(cwd);
			if (existingPipeline) {
				const proceed = await ctx.ui.confirm(
					"Active Brainstorm Found",
					`There's an active brainstorm:\n` +
						`  Description: ${existingPipeline.description.slice(0, 60)}${existingPipeline.description.length > 60 ? "..." : ""}\n` +
						`  Stage: ${existingPipeline.stage}\n` +
						`  Exchanges: ${existingPipeline.conversationHistory.length}\n\n` +
						`Start a NEW brainstorm? (No = cancel)`,
				);
				if (!proceed) {
					ctx.ui.notify(
						"Existing brainstorm is still active. Cancel it with /brainstorm-cancel if needed.",
						"info",
					);
					return;
				}
			}

			// Git validation (repo must exist, but dirty state is OK for doc pipelines)
			const gitValidation = await validateGitRepo(cwd);
			if (!gitValidation.valid) {
				ctx.ui.notify(gitValidation.error!, "error");
				return;
			}

			// Load config
			const configResult = loadPipelineConfig(cwd);
			if (!configResult.success) {
				ctx.ui.notify(configResult.error, "error");
				return;
			}
			const projectConfig = configResult.config;

			// Prompt for short name
			const docTimestamp = generateTimestamp();
			const { shortName } = await promptForShortName(ctx, description);

			// Create initial brainstorm state
			const state = createInitialBrainstormState(
				description,
				docTimestamp,
				shortName,
				projectConfig.specsDir,
				projectConfig.specFormat,
			);
			saveBrainstormState(cwd, state);

			ctx.ui.notify(
				formatStepBanner("BRAINSTORM STARTED", `ID: ${state.id}`, "🧠"),
				"info",
			);

			// Enter brainstorm mode
			enterBrainstormMode(cwd, projectConfig, state);

			// Show widget
			updateModeWidget(ctx);

			ctx.ui.notify(
				"Explore ideas freely. The LLM will ask one question at a time to help you think things through.",
				"info",
			);
			ctx.ui.notify(
				"Type /brainstorm-done when you're ready to capture the ideas.",
				"info",
			);

			// Send the initial brainstorm message to kick off the session
			pi.sendUserMessage(
				`I want to brainstorm the following idea: ${description}\n\n` +
					`Please explore the codebase to understand the current state, then start with ONE question or angle to kick things off. ` +
					`We'll explore the problem space one step at a time.`,
			);
		},
	});

	pi.registerCommand("brainstorm-done", {
		description: "End brainstorm session and capture ideas to a document",
		// Two-step invocation design: first /brainstorm-done triggers synthesis (sends a message to the LLM
		// to write the document file); second invocation (after the LLM writes the file) finalizes and commits.
		// The plan's original await-agent_end approach was impractical inside a command handler since command
		// handlers must return synchronously — they cannot await async pi events.
		handler: async (_args, ctx) => {
			const brainstormState = getActiveBrainstormState();
			if (
				pipelineMode !== "brainstorm" ||
				!brainstormState ||
				!activeCwd ||
				!activeProjectConfig
			) {
				ctx.ui.notify(
					"No active brainstorm session. Use /brainstorm to start one.",
					"error",
				);
				return;
			}

			const state = brainstormState;
			const cwd = activeCwd;
			const projectConfig = activeProjectConfig;
			const fullDocPath = path.join(cwd, state.docPath);

			// Check if the document has already been written (second invocation after synthesis)
			if (fs.existsSync(fullDocPath)) {
				const docContent = fs.readFileSync(fullDocPath, "utf-8");
				if (docContent.trim()) {
					// Document exists — finalize the brainstorm
					state.docContent = docContent;
					state.stage = "completed";
					saveBrainstormState(cwd, state);

					const brainstormExchanges = exchangeCount;

					// Exit brainstorm mode
					exitMode();
					clearPipelineWidget(ctx);

					ctx.ui.notify(
						formatStepBanner(
							"BRAINSTORM CAPTURED",
							`${brainstormExchanges} exchanges. Creating commit...`,
							"✅",
						),
						"info",
					);

					// Create git commit scoped to the brainstorm file
					const { extractDocName } = await import("./commit-agent.ts");
					const docName = extractDocName(state.docFilename);

					const commitResult = await createAgentCommit(
						cwd,
						state,
						{
							role: "brainstormAgent",
							modelConfig: projectConfig.models.planDrafter,
							docName,
						},
						projectConfig.models.agentCommitMessageWriter,
						() => saveBrainstormState(cwd, state),
						ctx.ui.notify.bind(ctx.ui) as (
							msg: string,
							type: "info" | "error" | "success" | "warning",
						) => void,
						[state.docPath],
					);

					if (!commitResult.success) {
						ctx.ui.notify(
							"Warning: Failed to create commit for brainstorm document",
							"warning",
						);
					}

					// Success notification — no approval dialog
					ctx.ui.notify(
						formatStepBanner(
							"🎉 Brainstorm Complete!",
							`Document: ${state.docPath}`,
							"✅",
						),
						"info",
					);
					ctx.ui.notify(
						`You can reference this document in /spec, /epic, or /roadmap commands.`,
						"info",
					);
					return;
				}
			}

			// Document not ready yet — send synthesis message
			ctx.ui.notify(
				formatStepBanner(
					"SYNTHESIZING BRAINSTORM",
					"The LLM will now capture the ideas into a document...",
					"📝",
				),
				"info",
			);

			// Send synthesis message to the LLM — it will write the file
			pi.sendUserMessage(
				`Please synthesize our brainstorm conversation into a document and write it to this exact path: ${fullDocPath}\n\n` +
					`Use the brainstorm document format with these sections:\n` +
					`- Problem / Opportunity\n` +
					`- Context & Background\n` +
					`- Proposed Directions (with tradeoffs for each option)\n` +
					`- Out of Scope\n` +
					`- Open Questions\n` +
					`- Rough Scope Assessment\n\n` +
					`Use timestamp: ${state.docTimestamp}\n` +
					`Title: ${state.description}\n\n` +
					`Write the complete document to the file now.\n\n` +
					`After writing the file, the user will type /brainstorm-done again to finalize.`,
			);

			ctx.ui.notify(
				"Once the LLM finishes writing, type /brainstorm-done again to finalize.",
				"info",
			);
		},
	});

	pi.registerCommand("brainstorm-status", {
		description: "Show status of the latest brainstorm session",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: BrainstormState | null;
			if (pipelineId) {
				state = loadBrainstormState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Brainstorm not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveBrainstormPipeline(cwd);
				if (!state) {
					const states = listBrainstormStates(cwd);
					if (states.length === 0) {
						ctx.ui.notify(
							"No brainstorm sessions found. Use /brainstorm to start one.",
							"info",
						);
						return;
					}
					state = states[0];
				}
			}

			const lines: string[] = [];
			lines.push(formatDivider(50));
			lines.push(`  Brainstorm: ${state.id || "unknown"}`);
			lines.push(formatDivider(50));
			lines.push("");
			lines.push("📋 Basic Information");
			const description = state.description || "(no description)";
			lines.push(
				formatKeyValue(
					"  Description",
					description.slice(0, 50) + (description.length > 50 ? "..." : ""),
				),
			);

			const stageLabels: Record<string, string> = {
				brainstorming: "🧠 Brainstorming",
				completed: "✅ Completed",
				cancelled: "❌ Cancelled",
			};
			lines.push(
				formatKeyValue("  Stage", stageLabels[state.stage] || state.stage),
			);
			lines.push(formatKeyValue("  Created", state.createdAt));
			lines.push(formatKeyValue("  Updated", state.updatedAt));
			lines.push(
				formatKeyValue("  Exchanges", String(state.conversationHistory.length)),
			);
			lines.push(formatKeyValue("  Document", state.docFilename));

			if (state.stage === "completed") {
				lines.push(formatKeyValue("  Doc Path", state.docPath));
			}

			lines.push("");
			lines.push(formatDivider(50));

			ctx.ui.notify(lines.join("\n"), "info");

			if (state.stage === "completed") {
				ctx.ui.notify(
					`\n✅ Brainstorm completed. Document at: ${state.docPath}`,
					"info",
				);
			} else if (state.stage === "cancelled") {
				ctx.ui.notify("\n🚫 Cancelled.", "info");
			} else {
				ctx.ui.notify("\n▶️ Active brainstorm session.", "info");
			}
		},
	});

	pi.registerCommand("brainstorm-list", {
		description: "List all brainstorm sessions",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const states = listBrainstormStates(cwd);

			if (states.length === 0) {
				ctx.ui.notify(
					"No brainstorm sessions found. Use /brainstorm to start one.",
					"info",
				);
				return;
			}

			const lines: string[] = [];
			lines.push(formatDivider(60));
			lines.push(`  🧠 Brainstorm Sessions (${states.length} total)`);
			lines.push(formatDivider(60));
			lines.push("");

			for (const state of states) {
				let statusIcon = "  ";
				if (state.stage === "completed") statusIcon = "✅";
				else if (state.stage === "cancelled") statusIcon = "🚫";
				else statusIcon = "▶️";

				lines.push(`${statusIcon} ${state.id || "unknown"}`);
				const desc = state.description || "(no description)";
				lines.push(`   ${desc.slice(0, 55)}${desc.length > 55 ? "..." : ""}`);

				const stageLabels: Record<string, string> = {
					brainstorming: "🧠 Brainstorming",
					completed: "✅ Completed",
					cancelled: "❌ Cancelled",
				};
				lines.push(`   Stage: ${stageLabels[state.stage] || state.stage}`);
				lines.push(`   Exchanges: ${state.conversationHistory.length}`);
				lines.push(`   Created: ${state.createdAt}`);
				lines.push("");
			}

			lines.push(formatDivider(60));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("brainstorm-cancel", {
		description: "Cancel the active brainstorm session",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			// If we're currently in brainstorm mode, exit immediately
			if (pipelineMode === "brainstorm" && activeBrainstormState) {
				const state = activeBrainstormState;
				const cwd = activeCwd;

				state.stageBeforeCancellation = state.stage;
				state.stage = "cancelled";
				saveBrainstormState(cwd, state);

				exitMode();
				clearPipelineWidget(ctx);
				ctx.ui.notify("Brainstorm session cancelled.", "info");
				return;
			}

			// Otherwise, look up by ID or latest active
			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: BrainstormState | null;
			if (pipelineId) {
				state = loadBrainstormState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Brainstorm not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveBrainstormPipeline(cwd);
				if (!state) {
					ctx.ui.notify("No active brainstorm session to cancel.", "info");
					return;
				}
			}

			if (state.stage === "completed" || state.stage === "cancelled") {
				ctx.ui.notify("Brainstorm session is already finished.", "info");
				return;
			}

			state.stageBeforeCancellation = state.stage;
			state.stage = "cancelled";
			saveBrainstormState(cwd, state);

			ctx.ui.notify("Brainstorm session cancelled.", "info");
		},
	});
}
