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
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
	RoleName,
} from "./types.ts";

// Import config
import { loadPipelineConfig, getEscalatedModelConfig } from "./config.ts";

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
import { recordEscalation } from "./escalation.ts";
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

function installBundledSubagents(): void {
	try {
		const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
		const sourceDir = path.join(extensionRoot, "agents");
		const targetDir = path.join(os.homedir(), ".pi", "agent", "agents");

		if (!fs.existsSync(sourceDir)) return;
		fs.mkdirSync(targetDir, { recursive: true });

		for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

			const sourcePath = path.join(sourceDir, entry.name);
			const targetPath = path.join(targetDir, entry.name);
			const sourceContent = fs.readFileSync(sourcePath, "utf-8");

			if (fs.existsSync(targetPath)) continue;

			fs.writeFileSync(targetPath, sourceContent);
		}
	} catch (error) {
		console.warn(
			`spec-pipeline could not install bundled subagents: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

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


export default function (pi: ExtensionAPI) {
	installBundledSubagents();

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
				activePipelineState
					? getSessionLogDir(cwd, activePipelineState.id)
					: undefined,
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
	// IMPLEMENTATION COMMANDS
	// ============================================

	pi.registerCommand("implement", {
		description:
			"Start implementation from a delivery-plan file. Use --no-plan to skip plan generation, --no-review to skip reviews, --auto to run without interactive TTY.",
		handler: async (args, ctx) => {
			const argsStr = args || "";
			const autoMode = argsStr.includes("--auto");

			if (!ctx.hasUI && !autoMode) {
				ctx.ui.notify(
					"spec-pipeline requires interactive mode. Use --auto for non-interactive (agent-driven) runs.",
					"error",
				);
				return;
			}

			if (pipelineMode === "brainstorm") {
				ctx.ui.notify(
					"Cannot start /implement while a brainstorm session is active. Use /brainstorm-cancel to cancel it first.",
					"error",
				);
				return;
			}

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
					ctx.ui.notify(
						"Auto-mode: overriding existing pipeline (starting fresh)",
						"info",
					);
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
				ctx.ui.notify(
					"❌ /implement requires a delivery-plan file.\n\n" +
						"Usage: /implement [--no-plan] [--no-review] [--auto] <delivery-plan.md>\n\n" +
						"To produce a delivery plan, run the delivery-plan-architect agent:\n" +
						'  subagent agent=delivery-plan-architect task="Read <spec-path> and write the delivery plan to <output-path>."',
					"error",
				);
				return;
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

					const errPhase = state.lastError.phase;
					const errCycle = state.lastError.cycle;
					const retrySuccess = await retryFailedOperation(
						state,
						cwd,
						projectConfig,
						() => saveImplState(cwd, state),
						ctx,
						{
							config: getEscalatedModelConfig(projectConfig, state.lastError.role as RoleName),
							onEscalate: ({ role, fromModel, toModel, reason }) =>
								recordEscalation(
									cwd, state,
									{ role, phase: errPhase, cycle: errCycle, fromModel, toModel, reason },
									() => saveImplState(cwd, state), (msg, type) => ctx.ui.notify(msg, type),
								),
						},
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
		description: "Cancel an active implementation pipeline",
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

				// Escalations section (R10b)
				if (state.escalations && state.escalations.length > 0) {
					lines.push("");
					lines.push(`## Escalations (${state.escalations.length})`);
					for (const esc of state.escalations) {
						const cycleStr = esc.cycle !== undefined ? ` cycle ${esc.cycle}` : "";
						lines.push(`- phase ${esc.phase}${cycleStr}: ${esc.role} ${esc.fromModel} → ${esc.toModel} (${esc.reason}) at ${esc.timestamp}`);
					}
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
}
