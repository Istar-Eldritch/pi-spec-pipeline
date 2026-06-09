/**
 * Pipeline state management - CRUD operations for spec and implementation state
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type SpecState,
	type ImplementationState,
	type DiscoveryState,
	type ConversationalExchange,
	type DiscoveryTopic,
	type ProjectConfig,
	type RoadmapState,
	type EpicState,
	type HierarchyState,
	type HierarchyLevel,
	type ChildItem,
	type BrainstormState,
	SPEC_STATE_DIR,
	IMPL_STATE_DIR,
	STATE_DIR,
	ROADMAP_STATE_DIR,
	EPIC_STATE_DIR,
	BRAINSTORM_STATE_DIR,
} from "./types.ts";
import { classifyError } from "./errors.ts";

// ============================================
// State Directory & Path Helpers
// ============================================

/**
 * Get the state directory for specs
 */
export function getSpecStateDir(cwd: string): string {
	return path.join(cwd, SPEC_STATE_DIR);
}

/**
 * Get the state directory for implementations
 */
export function getImplStateDir(cwd: string): string {
	return path.join(cwd, IMPL_STATE_DIR);
}

/**
 * Get the base state directory (for shared resources like error logs)
 */
export function getStateDir(cwd: string): string {
	return path.join(cwd, STATE_DIR);
}

/**
 * Get the directory where subagent session logs are stored for a given pipeline run.
 * Logs are scoped by state ID so each run's sessions are grouped together.
 */
export function getSessionLogDir(cwd: string, stateId: string): string {
	return path.join(cwd, STATE_DIR, "sessions", stateId);
}

/**
 * Get path to a specific spec state file
 */
export function getSpecStatePath(cwd: string, id: string): string {
	return path.join(getSpecStateDir(cwd), `${id}.json`);
}

/**
 * Get path to a specific implementation state file
 */
export function getImplStatePath(cwd: string, id: string): string {
	return path.join(getImplStateDir(cwd), `${id}.json`);
}

// ============================================
// Spec State CRUD Operations
// ============================================

/**
 * Load spec state by ID
 */
export function loadSpecState(cwd: string, id: string): SpecState | null {
	const statePath = getSpecStatePath(cwd, id);
	if (!fs.existsSync(statePath)) {
		return null;
	}
	try {
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as SpecState;

		// Migrate: ensure discovery field exists
		if (!state.discovery) {
			state.discovery = {
				skipped: true,
				discoverySummary: "",
				completed: true,
			};
		}
		// Migrate: remove legacy subprocess fields
		const disc = state.discovery as any;
		if (disc.qaHistory !== undefined) delete disc.qaHistory;
		if (disc.currentRound !== undefined) delete disc.currentRound;
		if (disc.maxRounds !== undefined) delete disc.maxRounds;
		if (disc.conversational !== undefined) delete disc.conversational;

		// Migrate: convert absolute specPath to relative
		let needsSave = false;
		if (state.specPath && path.isAbsolute(state.specPath)) {
			const relativePath = path.relative(cwd, state.specPath);
			if (!relativePath.startsWith("..")) {
				state.specPath = relativePath;
				needsSave = true;
			}
		}

		// Migrate: handle null lastError
		if (state.lastError === null) {
			state.lastError = undefined;
			needsSave = true;
		} else if (state.lastError && typeof state.lastError === "string") {
			const legacyError = state.lastError as unknown as string;
			state.lastError = {
				timestamp: state.updatedAt || new Date().toISOString(),
				agent: "unknown",
				role: "planDrafter",
				exitCode: 1,
				stderr: legacyError,
				errorType: classifyError(legacyError),
				agentTask: "(task not recorded in legacy state)",
			};
			needsSave = true;
		}

		// Initialize missing fields
		if (state.checkpoints === undefined) {
			state.checkpoints = [];
		}

		if (needsSave) {
			try {
				fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
			} catch {
				// Ignore write errors
			}
		}

		return state;
	} catch {
		return null;
	}
}

/**
 * Save spec state
 */
export function saveSpecState(cwd: string, state: SpecState): void {
	const stateDir = getSpecStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		fs.mkdirSync(stateDir, { recursive: true });
	}
	state.updatedAt = new Date().toISOString();
	fs.writeFileSync(
		getSpecStatePath(cwd, state.id),
		JSON.stringify(state, null, 2),
		"utf-8",
	);
}

/**
 * List all spec states
 */
export function listSpecStates(cwd: string): SpecState[] {
	const stateDir = getSpecStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		return [];
	}
	const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json"));
	const states: SpecState[] = [];
	for (const file of files) {
		const id = file.replace(/\.json$/, "");
		const state = loadSpecState(cwd, id);
		if (state) {
			states.push(state);
		}
	}
	return states.sort(
		(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
	);
}

/**
 * Get the most recent active spec pipeline
 */
export function getLatestActiveSpecPipeline(cwd: string): SpecState | null {
	const states = listSpecStates(cwd);
	return (
		states.find((s) => s.stage !== "completed" && s.stage !== "cancelled") ||
		null
	);
}

// ============================================
// Implementation State CRUD Operations
// ============================================

/**
 * Load implementation state by ID
 */
export function loadImplState(
	cwd: string,
	id: string,
): ImplementationState | null {
	const statePath = getImplStatePath(cwd, id);
	if (!fs.existsSync(statePath)) {
		return null;
	}
	try {
		const state = JSON.parse(
			fs.readFileSync(statePath, "utf-8"),
		) as ImplementationState;

		let needsSave = false;

		// Migrate: handle null lastError
		if (state.lastError === null) {
			state.lastError = undefined;
			needsSave = true;
		} else if (state.lastError && typeof state.lastError === "string") {
			const legacyError = state.lastError as unknown as string;
			state.lastError = {
				timestamp: state.updatedAt || new Date().toISOString(),
				agent: "unknown",
				role: "implementer",
				exitCode: 1,
				stderr: legacyError,
				errorType: classifyError(legacyError),
				agentTask: "(task not recorded in legacy state)",
			};
			needsSave = true;
		}

		// Initialize missing fields
		if (state.checkpoints === undefined) {
			state.checkpoints = [];
		}
		if (state.reviewCyclesCompleted === undefined) {
			state.reviewCyclesCompleted = 0;
		}
		if (state.escalations === undefined) {
			state.escalations = [];
			needsSave = true;
		}

		if (needsSave) {
			try {
				fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
			} catch {
				// Ignore write errors
			}
		}

		return state;
	} catch {
		return null;
	}
}

/**
 * Save implementation state
 */
export function saveImplState(cwd: string, state: ImplementationState): void {
	const stateDir = getImplStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		fs.mkdirSync(stateDir, { recursive: true });
	}
	state.updatedAt = new Date().toISOString();
	fs.writeFileSync(
		getImplStatePath(cwd, state.id),
		JSON.stringify(state, null, 2),
		"utf-8",
	);
}

/**
 * List all implementation states
 */
export function listImplStates(cwd: string): ImplementationState[] {
	const stateDir = getImplStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		return [];
	}
	const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json"));
	const states: ImplementationState[] = [];
	for (const file of files) {
		const id = file.replace(/\.json$/, "");
		const state = loadImplState(cwd, id);
		if (state) {
			states.push(state);
		}
	}
	return states.sort(
		(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
	);
}

/**
 * Get the most recent active implementation pipeline
 */
export function getLatestActiveImplPipeline(
	cwd: string,
): ImplementationState | null {
	const states = listImplStates(cwd);
	return (
		states.find((s) => s.stage !== "completed" && s.stage !== "cancelled") ||
		null
	);
}

// ============================================
// State Creation Helpers
// ============================================

/**
 * Generate a unique pipeline ID
 */
export function generatePipelineId(): string {
	const now = new Date();
	const date = now.toISOString().slice(0, 10).replace(/-/g, "");
	const time = now.toISOString().slice(11, 19).replace(/:/g, "");
	const rand = Math.random().toString(36).slice(2, 6);
	return `${date}_${time}_${rand}`;
}

/**
 * Generate a timestamp in YYMMDDhhmm format
 */
export function generateTimestamp(): string {
	const now = new Date();
	const yy = String(now.getFullYear()).slice(2);
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	const hh = String(now.getHours()).padStart(2, "0");
	const min = String(now.getMinutes()).padStart(2, "0");
	return `${yy}${mm}${dd}${hh}${min}`;
}

// Keep old name as alias
export const generateSpecTimestamp = generateTimestamp;

/**
 * Create initial discovery state
 */
export function createInitialDiscoveryState(
	skipped: boolean = false,
): DiscoveryState {
	return {
		skipped,
		discoverySummary: "",
		completed: skipped,
		conversationHistory: [],
		topics: [],
		activeTopic: null,
	};
}

function summarizeDiscoveryTopicTitle(question: string): string {
	const normalized = question.trim().replace(/\s+/g, " ");
	if (!normalized) return "Untitled topic";

	const words = normalized.split(" ");
	if (words.length <= 12) return normalized;
	return `${words.slice(0, 12).join(" ")}…`;
}

function summaryText(
	value: string | null | undefined,
	fallback: string,
): string {
	const normalized = (value ?? "").trim();
	return normalized.length > 0 ? normalized : fallback;
}

function indentContinuationLines(value: string, indent: string): string {
	return value.replace(/\n/g, `\n${indent}`);
}

function generateDiscoveryTopicSummary(topics: DiscoveryTopic[]): string {
	const sections: string[] = [];
	sections.push("## Discovery Summary\n");
	sections.push(
		"The following decisions were gathered during an interactive discovery conversation:\n",
	);

	for (let i = 0; i < topics.length; i++) {
		const topic = topics[i];
		sections.push(
			`### Topic ${i + 1}: ${summarizeDiscoveryTopicTitle(topic.question)}\n`,
		);
		sections.push(
			`**Decision:** ${summaryText(topic.decision, "(No final decision recorded.)")}\n`,
		);
		sections.push(
			`**Assumption:** ${summaryText(topic.question, "(No assumption recorded.)")}\n`,
		);

		if (topic.followUps.length > 0) {
			sections.push("**Supporting thread:**\n");
			for (const followUp of topic.followUps) {
				const question = indentContinuationLines(
					summaryText(
						followUp.userQuestion,
						"(No follow-up question recorded.)",
					),
					"  ",
				);
				const answer = indentContinuationLines(
					summaryText(followUp.agentAnswer, "(No follow-up answer recorded.)"),
					"  ",
				);
				sections.push(`- **Q:** ${question}`);
				sections.push(`  **A:** ${answer}`);
			}
			sections.push("");
		}

		sections.push("---\n");
	}

	return sections.join("\n");
}

/**
 * Generate a discovery summary from conversational exchanges
 */
export function generateConversationalDiscoverySummary(
	exchanges: ConversationalExchange[] = [],
	topics: DiscoveryTopic[] = [],
): string {
	if (topics.length > 0) {
		return generateDiscoveryTopicSummary(topics);
	}

	if (exchanges.length === 0) {
		return "";
	}

	const sections: string[] = [];
	sections.push("## Discovery Summary\n");
	sections.push(
		"The following information was gathered during an interactive discovery conversation:\n",
	);

	for (let i = 0; i < exchanges.length; i++) {
		const exchange = exchanges[i];
		sections.push(`### Exchange ${i + 1}\n`);
		sections.push("**User:**\n");
		sections.push(exchange.userMessage);
		sections.push("\n**Discovery Agent:**\n");
		sections.push(exchange.assistantResponse);
		sections.push("\n---\n");
	}

	return sections.join("\n");
}

/**
 * Create initial spec state
 */
export function createInitialSpecState(
	description: string,
	specTimestamp: string,
	shortName: string,
	specsDir: string,
	skipDiscovery: boolean = false,
	specFormat: string = "md",
): SpecState {
	const specFilename = `${specTimestamp}_spec_${shortName}.${specFormat}`;
	const specPath = path.join(specsDir, specFilename);
	const now = new Date().toISOString();

	return {
		id: generatePipelineId(),
		description,
		stage: skipDiscovery ? "spec_drafting" : "discovery",
		createdAt: now,
		updatedAt: now,

		discovery: createInitialDiscoveryState(skipDiscovery),

		specTimestamp,
		specFilename,
		specPath,
		specDraft: "",
		specApproved: false,
		specIteration: 0,
	};
}

/**
 * Create initial implementation state
 */
export function createInitialImplState(
	specPath: string,
	specContent: string,
	implTimestamp: string,
	skipPlanGeneration: boolean = false,
): ImplementationState {
	const now = new Date().toISOString();

	return {
		id: generatePipelineId(),
		implTimestamp,
		specPath,
		specContent,
		stage: "implementation",
		createdAt: now,
		updatedAt: now,

		phases: [],
		phasesGenerated: [],
		currentPhaseIndex: 0,

		currentReviewCycle: 1,
		previousReview: "",

		phaseCommits: [],

		skipPlanGeneration,
	};
}

// ============================================
// Roadmap State CRUD Operations
// ============================================

/**
 * Get the state directory for roadmaps
 */
export function getRoadmapStateDir(cwd: string): string {
	return path.join(cwd, ROADMAP_STATE_DIR);
}

/**
 * Get path to a specific roadmap state file
 */
export function getRoadmapStatePath(cwd: string, id: string): string {
	return path.join(getRoadmapStateDir(cwd), `${id}.json`);
}

/**
 * Load roadmap state by ID
 */
export function loadRoadmapState(cwd: string, id: string): RoadmapState | null {
	const statePath = getRoadmapStatePath(cwd, id);
	if (!fs.existsSync(statePath)) {
		return null;
	}
	try {
		const state = JSON.parse(
			fs.readFileSync(statePath, "utf-8"),
		) as RoadmapState;

		// Ensure level is set
		if (!state.level) {
			(state as any).level = "roadmap";
		}

		// Initialize missing fields
		if (state.checkpoints === undefined) {
			state.checkpoints = [];
		}
		if (state.children === undefined) {
			state.children = [];
		}

		return state;
	} catch {
		return null;
	}
}

/**
 * Save roadmap state
 */
export function saveRoadmapState(cwd: string, state: RoadmapState): void {
	const stateDir = getRoadmapStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		fs.mkdirSync(stateDir, { recursive: true });
	}
	state.updatedAt = new Date().toISOString();
	fs.writeFileSync(
		getRoadmapStatePath(cwd, state.id),
		JSON.stringify(state, null, 2),
		"utf-8",
	);
}

/**
 * List all roadmap states
 */
export function listRoadmapStates(cwd: string): RoadmapState[] {
	const stateDir = getRoadmapStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		return [];
	}
	const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json"));
	const states: RoadmapState[] = [];
	for (const file of files) {
		const id = file.replace(/\.json$/, "");
		const state = loadRoadmapState(cwd, id);
		if (state) {
			states.push(state);
		}
	}
	return states.sort(
		(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
	);
}

/**
 * Get the most recent active roadmap pipeline
 */
export function getLatestActiveRoadmapPipeline(
	cwd: string,
): RoadmapState | null {
	const states = listRoadmapStates(cwd);
	return (
		states.find((s) => s.stage !== "completed" && s.stage !== "cancelled") ||
		null
	);
}

// ============================================
// Epic State CRUD Operations
// ============================================

/**
 * Get the state directory for epics
 */
export function getEpicStateDir(cwd: string): string {
	return path.join(cwd, EPIC_STATE_DIR);
}

/**
 * Get path to a specific epic state file
 */
export function getEpicStatePath(cwd: string, id: string): string {
	return path.join(getEpicStateDir(cwd), `${id}.json`);
}

/**
 * Load epic state by ID
 */
export function loadEpicState(cwd: string, id: string): EpicState | null {
	const statePath = getEpicStatePath(cwd, id);
	if (!fs.existsSync(statePath)) {
		return null;
	}
	try {
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as EpicState;

		// Ensure level is set
		if (!state.level) {
			(state as any).level = "epic";
		}

		// Initialize missing fields
		if (state.checkpoints === undefined) {
			state.checkpoints = [];
		}
		if (state.children === undefined) {
			state.children = [];
		}

		return state;
	} catch {
		return null;
	}
}

/**
 * Save epic state
 */
export function saveEpicState(cwd: string, state: EpicState): void {
	const stateDir = getEpicStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		fs.mkdirSync(stateDir, { recursive: true });
	}
	state.updatedAt = new Date().toISOString();
	fs.writeFileSync(
		getEpicStatePath(cwd, state.id),
		JSON.stringify(state, null, 2),
		"utf-8",
	);
}

/**
 * List all epic states
 */
export function listEpicStates(cwd: string): EpicState[] {
	const stateDir = getEpicStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		return [];
	}
	const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json"));
	const states: EpicState[] = [];
	for (const file of files) {
		const id = file.replace(/\.json$/, "");
		const state = loadEpicState(cwd, id);
		if (state) {
			states.push(state);
		}
	}
	return states.sort(
		(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
	);
}

/**
 * Get the most recent active epic pipeline
 */
export function getLatestActiveEpicPipeline(cwd: string): EpicState | null {
	const states = listEpicStates(cwd);
	return (
		states.find((s) => s.stage !== "completed" && s.stage !== "cancelled") ||
		null
	);
}

// ============================================
// Hierarchy State Creation Helpers
// ============================================

/**
 * Create initial roadmap state
 */
export function createInitialRoadmapState(
	description: string,
	docTimestamp: string,
	shortName: string,
	specsDir: string,
	skipDiscovery: boolean = false,
	docFormat: string = "md",
): RoadmapState {
	const docFilename = `${docTimestamp}_roadmap_${shortName}.${docFormat}`;
	const docPath = path.join(specsDir, docFilename);
	const now = new Date().toISOString();

	return {
		id: generatePipelineId(),
		level: "roadmap",
		description,
		stage: skipDiscovery ? "drafting" : "discovery",
		createdAt: now,
		updatedAt: now,

		discovery: createInitialDiscoveryState(skipDiscovery),

		docTimestamp,
		docFilename,
		docPath,
		docContent: "",
		docApproved: false,
		docIteration: 0,

		children: [],
	};
}

/**
 * Create initial epic state
 */
export function createInitialEpicState(
	description: string,
	docTimestamp: string,
	shortName: string,
	specsDir: string,
	skipDiscovery: boolean = false,
	docFormat: string = "md",
	parentId?: string,
	parentType?: "roadmap",
): EpicState {
	const docFilename = `${docTimestamp}_epic_${shortName}.${docFormat}`;
	const docPath = path.join(specsDir, docFilename);
	const now = new Date().toISOString();

	return {
		id: generatePipelineId(),
		level: "epic",
		description,
		stage: skipDiscovery ? "drafting" : "discovery",
		createdAt: now,
		updatedAt: now,

		parentId,
		parentType,

		discovery: createInitialDiscoveryState(skipDiscovery),

		docTimestamp,
		docFilename,
		docPath,
		docContent: "",
		docApproved: false,
		docIteration: 0,

		children: [],
	};
}

// ============================================
// Brainstorm State CRUD Operations
// ============================================

/**
 * Get the state directory for brainstorms
 */
export function getBrainstormStateDir(cwd: string): string {
	return path.join(cwd, BRAINSTORM_STATE_DIR);
}

/**
 * Get path to a specific brainstorm state file
 */
export function getBrainstormStatePath(cwd: string, id: string): string {
	return path.join(getBrainstormStateDir(cwd), `${id}.json`);
}

/**
 * Load brainstorm state by ID
 */
export function loadBrainstormState(
	cwd: string,
	id: string,
): BrainstormState | null {
	const statePath = getBrainstormStatePath(cwd, id);
	if (!fs.existsSync(statePath)) {
		return null;
	}
	try {
		const state = JSON.parse(
			fs.readFileSync(statePath, "utf-8"),
		) as BrainstormState;

		// Initialize missing fields
		if (state.checkpoints === undefined) {
			state.checkpoints = [];
		}
		if (state.conversationHistory === undefined) {
			state.conversationHistory = [];
		}

		return state;
	} catch {
		return null;
	}
}

/**
 * Save brainstorm state
 */
export function saveBrainstormState(cwd: string, state: BrainstormState): void {
	const stateDir = getBrainstormStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		fs.mkdirSync(stateDir, { recursive: true });
	}
	state.updatedAt = new Date().toISOString();
	fs.writeFileSync(
		getBrainstormStatePath(cwd, state.id),
		JSON.stringify(state, null, 2),
		"utf-8",
	);
}

/**
 * List all brainstorm states, sorted by createdAt descending (most recent first)
 */
export function listBrainstormStates(cwd: string): BrainstormState[] {
	const stateDir = getBrainstormStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		return [];
	}
	const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json"));
	const states: BrainstormState[] = [];
	for (const file of files) {
		const id = file.replace(/\.json$/, "");
		const state = loadBrainstormState(cwd, id);
		if (state) {
			states.push(state);
		}
	}
	return states.sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
}

/**
 * Get the most recent active brainstorm pipeline (not completed or cancelled)
 */
export function getLatestActiveBrainstormPipeline(
	cwd: string,
): BrainstormState | null {
	const states = listBrainstormStates(cwd);
	return (
		states.find((s) => s.stage !== "completed" && s.stage !== "cancelled") ||
		null
	);
}

/**
 * Create initial brainstorm state
 */
export function createInitialBrainstormState(
	description: string,
	docTimestamp: string,
	shortName: string,
	specsDir: string,
	specFormat: string = "md",
): BrainstormState {
	const docFilename = `${docTimestamp}_brainstorm_${shortName}.${specFormat}`;
	const docPath = path.join(specsDir, docFilename);
	const now = new Date().toISOString();

	return {
		id: generatePipelineId(),
		description,
		stage: "brainstorming",
		createdAt: now,
		updatedAt: now,

		docTimestamp,
		docFilename,
		docPath,
		docContent: "",

		conversationHistory: [],
	};
}

// ============================================
// Child Item Extraction
// ============================================

/**
 * Extract child items from a roadmap/epic document.
 *
 * Parses tables with the format:
 * ```
 * | # | Item | Description | Priority | Dependencies |
 * |---|------|-------------|----------|--------------|
 * | 1 | Name | Description text | High | - |
 * | 2 | Name2 | Description text | Medium | 1 |
 * | 3 | Name3 | Description text | Low | 1, 2 |
 * ```
 */
export function extractChildItems(docContent: string): ChildItem[] {
	const items: ChildItem[] = [];

	// Match table rows: | number | name | description | priority | dependencies |
	// Skip the header row and separator row
	const lines = docContent.split("\n");
	let inTable = false;
	let headerSeen = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Detect table header row
		if (!inTable && /\|\s*#\s*\|\s*Item\s*\|/i.test(trimmed)) {
			inTable = true;
			headerSeen = false;
			continue;
		}

		// Skip separator row (|---|---|...)
		if (inTable && !headerSeen && /^\|[\s\-:|]+\|$/.test(trimmed)) {
			headerSeen = true;
			continue;
		}

		// Parse data rows
		if (inTable && headerSeen) {
			// End of table if we hit a non-table line
			if (!trimmed.startsWith("|")) {
				inTable = false;
				headerSeen = false;
				continue;
			}

			// Split by pipe, trim, filter empties
			const cells = trimmed
				.split("|")
				.map((c) => c.trim())
				.filter((c) => c.length > 0);
			if (cells.length < 5) continue;

			const num = parseInt(cells[0], 10);
			if (isNaN(num)) continue;

			const name = cells[1];
			const description = cells[2];
			const priorityRaw = cells[3].trim();
			const depsRaw = cells[4].trim();

			// Parse priority
			let priority: ChildItem["priority"] = "Medium";
			if (/^high$/i.test(priorityRaw)) priority = "High";
			else if (/^low$/i.test(priorityRaw)) priority = "Low";
			else if (/^medium$/i.test(priorityRaw)) priority = "Medium";

			// Parse dependencies
			const dependencies: number[] = [];
			if (
				depsRaw !== "-" &&
				depsRaw !== "" &&
				depsRaw !== "None" &&
				depsRaw !== "none"
			) {
				const parts = depsRaw.split(/[,\s]+/);
				for (const part of parts) {
					const depNum = parseInt(part.trim(), 10);
					if (!isNaN(depNum)) {
						dependencies.push(depNum);
					}
				}
			}

			items.push({
				number: num,
				name,
				description,
				priority,
				dependencies,
			});
		}
	}

	return items;
}
