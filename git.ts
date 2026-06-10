/**
 * Git operations for the spec pipeline
 */

import { spawn } from "node:child_process";
import type { ImplementationState } from "./types.ts";

// Union type for any state that has git fields
type GitState = ImplementationState;

// ============================================
// Git Command Execution
// ============================================

/**
 * Execute a git command and return the result
 */
export async function execGit(
	cwd: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		const proc = spawn("git", args, { cwd });
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) =>
			resolve({
				code: code ?? 1,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
			}),
		);
		proc.on("error", () =>
			resolve({ code: 1, stdout: "", stderr: "Failed to execute git" }),
		);
	});
}

// ============================================
// Git Repository Validation
// ============================================

/**
 * Validate that we're in a git repository
 * Returns true if git is available and we're in a repo
 */
export async function validateGitRepo(
	cwd: string,
): Promise<{ valid: boolean; error?: string }> {
	const result = await execGit(cwd, ["rev-parse", "--git-dir"]);
	if (result.code !== 0) {
		return {
			valid: false,
			error:
				"Not a git repository. Please initialize git with 'git init' before starting the pipeline.",
		};
	}
	return { valid: true };
}

/**
 * Check if the working directory is clean (no uncommitted changes)
 */
export async function checkGitClean(
	cwd: string,
): Promise<{ clean: boolean; status?: string }> {
	const result = await execGit(cwd, ["status", "--porcelain"]);
	if (result.code !== 0) {
		return { clean: false, status: result.stderr };
	}
	if (result.stdout.length > 0) {
		return { clean: false, status: result.stdout };
	}
	return { clean: true };
}

// ============================================
// Checkpoint Operations
// ============================================

/**
 * Create a checkpoint before a write operation and update state
 * Returns true if checkpoint was created (or not needed), false on error
 *
 * @param saveFn - Function to save the state after updating checkpoints
 */
export async function createCheckpointAndSave(
	cwd: string,
	state: GitState,
	role: string,
	saveFn: () => void,
	phase?: number,
	cycle?: number,
	notify?: (
		msg: string,
		type: "info" | "error" | "success" | "warning",
	) => void,
): Promise<boolean> {
	// Pipelines use agent commits instead of checkpoints
	return true;
}

// ============================================
// File Tracking Operations
// ============================================

/**
 * Capture the current git status (dirty state) before an agent runs
 * Returns the output of 'git status --porcelain' which shows:
 * - Modified files (M)
 * - Added files (A)
 * - Deleted files (D)
 * - Renamed files (R)
 * - Untracked files (??)
 */
export async function captureGitStatus(cwd: string): Promise<string> {
	const result = await execGit(cwd, ["status", "--porcelain"]);
	return result.stdout;
}

/**
 * Get the list of files modified since the last commit
 * This includes modifications, deletions, renames, and new untracked files
 * Returns an array of file paths
 */
export async function getModifiedFiles(cwd: string): Promise<string[]> {
	const files = new Set<string>();

	// Get tracked modified/deleted files
	const diffResult = await execGit(cwd, ["diff", "--name-only", "HEAD"]);
	if (diffResult.code === 0 && diffResult.stdout) {
		diffResult.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.forEach((file) => files.add(file));
	}

	// Get untracked files (shows actual files, not just directories)
	const untrackedResult = await execGit(cwd, [
		"ls-files",
		"--others",
		"--exclude-standard",
	]);
	if (untrackedResult.code === 0 && untrackedResult.stdout) {
		untrackedResult.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.forEach((file) => files.add(file));
	}

	return Array.from(files);
}

/**
 * Get the current HEAD commit hash, or undefined when it cannot be resolved
 * (e.g. not a git repo, or an unborn branch with no commits yet).
 */
export async function getHeadCommit(cwd: string): Promise<string | undefined> {
	const result = await execGit(cwd, ["rev-parse", "HEAD"]);
	if (result.code !== 0) {
		return undefined;
	}
	const hash = result.stdout.trim();
	return hash.length > 0 ? hash : undefined;
}

/**
 * Get the list of files changed since a base commit. Unlike
 * {@link getModifiedFiles} (which only sees the uncommitted working tree),
 * this also counts changes that were COMMITTED after `baseRef` — so an agent
 * that commits its own work is still detected as having made changes.
 *
 * Includes:
 * - Files changed between `baseRef` and the current working tree
 *   (covers both new commits and uncommitted tracked changes)
 * - Untracked files
 *
 * Returns an array of file paths relative to the repo root.
 */
export async function getChangedFilesSince(
	cwd: string,
	baseRef: string,
): Promise<string[]> {
	const files = new Set<string>();

	// Diff base commit against the working tree: covers commits made after
	// baseRef AND uncommitted tracked modifications/deletions.
	const diffResult = await execGit(cwd, ["diff", "--name-only", baseRef]);
	if (diffResult.code === 0 && diffResult.stdout) {
		diffResult.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.forEach((file) => files.add(file));
	}

	// Untracked files (new files never committed nor staged)
	const untrackedResult = await execGit(cwd, [
		"ls-files",
		"--others",
		"--exclude-standard",
	]);
	if (untrackedResult.code === 0 && untrackedResult.stdout) {
		untrackedResult.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.forEach((file) => files.add(file));
	}

	return Array.from(files);
}

/**
 * Stage specific files (not all files)
 * Handles modifications, deletions, and renames
 * Returns true if staging was successful
 */
export async function stageFiles(
	cwd: string,
	files: string[],
): Promise<boolean> {
	if (files.length === 0) {
		return true; // Nothing to stage
	}

	// Use 'git add --all <file>...' to handle modifications, deletions, and renames
	const result = await execGit(cwd, ["add", "--all", ...files]);
	return result.code === 0;
}

/**
 * Check if there are any staged changes ready to commit
 * Returns true if there are staged changes, false otherwise
 */
export async function hasChangesStaged(cwd: string): Promise<boolean> {
	// 'git diff --staged --quiet' exits with code 0 if no staged changes
	// and code 1 if there are staged changes
	const result = await execGit(cwd, ["diff", "--staged", "--quiet"]);
	return result.code !== 0;
}

// ============================================
// Stash Operations
// ============================================

/**
 * Stash any uncommitted changes with an identifiable message
 * Returns the stash reference or null if nothing to stash
 *
 * NOTE: Stash references (stash@{N}) are positional and will change if new stashes
 * are created. Use the returned reference immediately or verify existence before use.
 */
export async function stashChanges(
	cwd: string,
	timestamp: string,
): Promise<string | null> {
	// Check if there are changes to stash
	const statusResult = await execGit(cwd, ["status", "--porcelain"]);
	if (statusResult.code !== 0) {
		return null; // Git command failed
	}
	if (statusResult.stdout.length === 0) {
		return null; // No changes to stash
	}

	// Create stash with message
	const message = `spec-pipeline-error-${timestamp}`;
	const result = await execGit(cwd, [
		"stash",
		"push",
		"-m",
		message,
		"--include-untracked",
	]);
	if (result.code !== 0) {
		return null;
	}

	// Get the stable stash reference from the stash list
	// The most recent stash is at the top of the list
	const listResult = await execGit(cwd, ["stash", "list"]);
	if (listResult.code !== 0) {
		return null;
	}

	const match = listResult.stdout.split("\n")[0]?.match(/^(stash@\{\d+\})/);
	return match ? match[1] : null;
}

/**
 * Drop a specific stash by reference
 */
export async function dropStash(
	cwd: string,
	stashRef: string,
): Promise<boolean> {
	const result = await execGit(cwd, ["stash", "drop", stashRef]);
	return result.code === 0;
}

/**
 * Check if a stash reference still exists
 */
export async function stashExists(
	cwd: string,
	stashRef: string,
): Promise<boolean> {
	// Try to show the stash - if it fails, stash doesn't exist
	const showResult = await execGit(cwd, ["stash", "show", stashRef]);
	return showResult.code === 0;
}

/**
 * Reset working directory to HEAD (discard all uncommitted changes)
 * This is used for error recovery after stashing failed changes
 * Returns true if reset was successful, false otherwise
 *
 * Note: This performs both:
 * 1. git reset --hard HEAD (resets tracked files)
 * 2. git clean -fd (removes untracked files and directories)
 */
export async function resetToHead(cwd: string): Promise<boolean> {
	// Reset tracked files to HEAD
	const resetResult = await execGit(cwd, ["reset", "--hard", "HEAD"]);
	if (resetResult.code !== 0) {
		return false;
	}

	// Remove untracked files and directories
	const cleanResult = await execGit(cwd, ["clean", "-fd"]);
	return cleanResult.code === 0;
}

// ============================================
// Commit Operations
// ============================================

/**
 * Create a git commit with the given message
 */
export async function createCommit(
	cwd: string,
	message: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["add", "-A"], { cwd });
		proc.on("close", (code) => {
			if (code !== 0) {
				resolve(false);
				return;
			}
			const commitProc = spawn("git", ["commit", "-m", message], { cwd });
			commitProc.on("close", (code) => resolve(code === 0));
		});
	});
}

/**
 * Extract commit message from agent output.
 */
export function extractCommitMessage(output: string): string {
	// Try to extract from code block first
	const codeBlockMatch = output.match(/```(?:\w*\n)?([\s\S]*?)```/);
	if (codeBlockMatch) {
		return codeBlockMatch[1].trim();
	}

	// Look for conventional commit format
	const conventionalMatch = output.match(
		/((?:feat|fix|docs|refactor|test|chore)\([^)]+\):[^\n]+(?:\n\n[\s\S]*)?)/,
	);
	if (conventionalMatch) {
		return conventionalMatch[1].trim();
	}

	return output.trim();
}

// ============================================
// Agent Commit Operations
// ============================================

/**
 * Create a commit after an agent successfully modifies files (R1, R2, R3, R4, R8)
 *
 * This function:
 * 1. Detects which files were modified by the agent
 * 2. Stages only those files (not all changes)
 * 3. Generates a commit message using the agentCommitMessageWriter
 * 4. Creates the commit
 * 5. Adds the commit hash to state.checkpoints[]
 *
 * When `scopeFiles` is provided, only those specific files are staged and committed
 * (even if other files have been modified). This is used by documentation pipelines
 * (spec/roadmap/epic) to avoid committing unrelated dirty-tree changes.
 *
 * @param cwd - Working directory
 * @param state - Pipeline state (ImplementationState)
 * @param context - Context for commit message generation (role, model, phase, etc.)
 * @param agentConfig - Model configuration (unused — retained for backward compatibility)
 * @param saveFn - Function to save the state after updating checkpoints
 * @param notify - UI notification callback
 * @param scopeFiles - If provided, only these files are staged/committed (ignoring other changes)
 * @returns { success: boolean; commitHash?: string; usedFallback?: boolean }
 */
export async function createAgentCommit(
	cwd: string,
	state: GitState,
	context: {
		role: string;
		modelConfig: { model: string; thinking: string };
		phase?: number;
		phaseName?: string;
		docName?: string;
		cycle?: number;
		reviewFeedback?: string;
	},
	agentConfig: { model: string; thinking: string },
	saveFn: () => void,
	notify?: (
		msg: string,
		type: "info" | "error" | "success" | "warning",
	) => void,
	scopeFiles?: string[],
): Promise<{ success: boolean; commitHash?: string; usedFallback?: boolean }> {
	// Import generateCommitMessage (async, uses configured commit-message model)
	const { generateCommitMessage } = await import("./commit-agent.ts");

	// Step 1: Get files to commit
	let filesToCommit: string[];
	if (scopeFiles && scopeFiles.length > 0) {
		// Scoped mode: only commit the specified files (if they have changes)
		const allModified = await getModifiedFiles(cwd);
		const allModifiedSet = new Set(allModified);
		filesToCommit = scopeFiles.filter((f) => allModifiedSet.has(f));
	} else {
		// Default mode: commit all modified files
		filesToCommit = await getModifiedFiles(cwd);
	}

	// Step 2: Check if any files were modified
	if (filesToCommit.length === 0) {
		notify?.("No files modified by agent - skipping commit", "info");
		return { success: true }; // Nothing to commit
	}

	// Step 3: Stage the files
	const staged = await stageFiles(cwd, filesToCommit);
	if (!staged) {
		notify?.("Failed to stage files", "error");
		return { success: false };
	}

	// Step 4: Check if there are actually staged changes
	const hasChanges = await hasChangesStaged(cwd);
	if (!hasChanges) {
		notify?.("No staged changes after staging - skipping commit", "info");
		return { success: true }; // No changes to commit
	}

	// Step 5: Get the staged diff for commit message context
	const diffResult = await execGit(cwd, ["diff", "--cached", "--no-color"]);
	let diff = diffResult.code === 0 ? diffResult.stdout : undefined;

	// Truncate diff if too large (keep under ~8KB to avoid overwhelming the commit-message model)
	const MAX_DIFF_LENGTH = 8000;
	if (diff && diff.length > MAX_DIFF_LENGTH) {
		diff = diff.slice(0, MAX_DIFF_LENGTH) + "\n... (diff truncated)";
	}

	// Step 6: Generate commit message using configured commit-message model
	const messageResult = await generateCommitMessage(
		{
			role: context.role as any,
			modelConfig: context.modelConfig as any,
			files: filesToCommit,
			phase: context.phase,
			phaseName: context.phaseName,
			docName: context.docName,
			cycle: context.cycle,
			reviewFeedback: context.reviewFeedback,
			diff,
		},
		agentConfig as any,
		cwd,
	);

	// Step 7: Create the commit
	const commitResult = await execGit(cwd, [
		"commit",
		"-m",
		messageResult.message,
	]);
	if (commitResult.code !== 0) {
		notify?.("Failed to create commit", "error");
		return { success: false };
	}

	// Step 8: Get commit hash
	const hashResult = await execGit(cwd, ["rev-parse", "HEAD"]);
	if (hashResult.code !== 0) {
		notify?.("Failed to get commit hash", "error");
		return { success: false };
	}
	const commitHash = hashResult.stdout;

	// Step 9: Add to checkpoints array
	if (!state.checkpoints) {
		state.checkpoints = [];
	}
	state.checkpoints.push(commitHash);
	saveFn();

	notify?.(`✅ Agent commit created: ${commitHash.slice(0, 8)}`, "success");

	return { success: true, commitHash };
}
