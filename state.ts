/**
 * Pipeline state management - CRUD operations for implementation state
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ImplementationState,
	IMPL_STATE_DIR,
	STATE_DIR,
} from "./types.ts";
import { classifyError } from "./errors.ts";

// ============================================
// State Directory & Path Helpers
// ============================================

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
 * Get path to a specific implementation state file
 */
export function getImplStatePath(cwd: string, id: string): string {
	return path.join(getImplStateDir(cwd), `${id}.json`);
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

		// Migrate legacy `phaseCommits: boolean[][]` (presence-only `true`
		// markers) to `string[][]` of commit hashes. The legacy hashes aren't
		// recoverable, so coerce `true` → `""` (placeholder) to preserve array
		// length; real hashes are recorded for new phases going forward.
		if (Array.isArray(state.phaseCommits)) {
			let phaseCommitsMigrated = false;
			state.phaseCommits = state.phaseCommits.map((cycleArr) => {
				if (!Array.isArray(cycleArr)) return [];
				return cycleArr.map((entry) => {
					if (typeof entry === "string") return entry;
					phaseCommitsMigrated = true;
					return "";
				});
			});
			if (phaseCommitsMigrated) needsSave = true;
		} else {
			state.phaseCommits = [];
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
