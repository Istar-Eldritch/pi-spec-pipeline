/**
 * Git worktree management for /implement isolation.
 *
 * Provides: resolveProjectRoot, deriveShortName, resolveAndValidateBasePath,
 * ensureBasePathGitignore, createWorktree, runSetupScript,
 * verifyWorktree, recreateWorktree.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { resolveMainRepoFromWorktree } from "./config.ts";
import { execGit } from "./git.ts";
import { getSessionLogDir } from "./state.ts";

// ============================================
// Project Root Resolution
// ============================================

/**
 * Resolve the main project root from any cwd (including a worktree).
 * If cwd is inside a git worktree, returns the main repo root; otherwise cwd itself.
 */
export function resolveProjectRoot(cwd: string): string {
	return resolveMainRepoFromWorktree(cwd) ?? cwd;
}

// ============================================
// Short Name Derivation
// ============================================

/**
 * Derive a filesystem-safe short name from a spec path.
 * Strips numeric timestamp and "spec_" prefix, lowercases, replaces
 * non-alphanumeric characters with underscores, and truncates to 30 chars.
 *
 * Examples:
 *   "2606101218_spec_worktree_isolation.md" → "worktree_isolation"
 *   "2606101218_my_feature.md"              → "my_feature"
 *   "MyFeature.md"                          → "myfeature"
 */
export function deriveShortName(specPath: string): string {
	const specBasename = path.basename(specPath, path.extname(specPath));
	return specBasename
		.replace(/^\d+_spec_/, "")
		.replace(/^\d+_/, "")
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "_")
		.slice(0, 30);
}

// ============================================
// Error Types
// ============================================

/** Generic worktree operation error result */
export type WorktreeError = { ok: false; error: string };

// ============================================
// Base Path Validation
// ============================================

/**
 * Resolve and validate the worktree base path (FR-1.3/1.4).
 *
 * - Relative paths resolve against projectRoot
 * - Absolute paths used as-is
 * - Hard error if resolvedBase === projectRoot or is inside projectRoot/.git
 */
export function resolveAndValidateBasePath(
	basePath: string,
	projectRoot: string,
): { ok: true; resolvedBase: string } | WorktreeError {
	const resolvedBase = path.isAbsolute(basePath)
		? basePath
		: path.resolve(projectRoot, basePath);

	// Must not be the project root itself
	if (resolvedBase === projectRoot) {
		return {
			ok: false,
			error: `worktree.basePath must not be the project root itself (${projectRoot}). Use a subdirectory like ".pi/worktrees".`,
		};
	}

	// Must not be the .git directory or inside it
	const gitDir = path.join(projectRoot, ".git");
	if (resolvedBase === gitDir || resolvedBase.startsWith(gitDir + path.sep)) {
		return {
			ok: false,
			error: `worktree.basePath must not be inside .git (${gitDir}). Use a path outside .git like ".pi/worktrees".`,
		};
	}

	return { ok: true, resolvedBase };
}

// ============================================
// Gitignore Guard
// ============================================

/**
 * Ensure the base directory exists and has a .gitignore that excludes all
 * worktree subdirectories. Idempotent — only writes .gitignore when missing.
 */
export function ensureBasePathGitignore(resolvedBase: string): void {
	fs.mkdirSync(resolvedBase, { recursive: true });
	const gitignorePath = path.join(resolvedBase, ".gitignore");
	if (!fs.existsSync(gitignorePath)) {
		fs.writeFileSync(gitignorePath, "*\n", "utf-8");
	}
}

// ============================================
// Worktree Metadata
// ============================================

/** Metadata stored in ImplementationState.worktree (FR-5.1). */
export interface WorktreeMetadata {
	/** Absolute path to the worktree directory */
	path: string;
	/** Branch name, e.g. "impl/myfeature-2606101218" */
	branch: string;
	/** The commit the branch was created from */
	baseCommit: string;
	/** ISO timestamp of creation */
	createdAt: string;
	/** false until the setup script completes successfully (or there is no script) */
	setupScriptRan: boolean;
}

// ============================================
// Worktree Creation
// ============================================

/**
 * Create a git worktree for an implementation run (FR-2.2–2.4).
 *
 * Naming: branch `impl/<shortName>-<implTimestamp>`, dir `<shortName>-<implTimestamp>`.
 * Collision handling: runs `git worktree prune` first, then tries suffixes
 * `-2` through `-9`; exhaustion is a hard error.
 *
 * @param triggeringCwd - cwd of the triggering checkout (for reading HEAD)
 * @param projectRoot   - main repo root (where `git worktree add` runs)
 * @param shortName     - sanitized name (from deriveShortName)
 * @param implTimestamp - YYMMDDhhmm timestamp
 * @param basePath      - resolved absolute base path for worktrees
 */
export async function createWorktree(
	triggeringCwd: string,
	projectRoot: string,
	shortName: string,
	implTimestamp: string,
	basePath: string,
): Promise<{ ok: true; meta: WorktreeMetadata } | WorktreeError> {
	// Prune stale worktree refs before scanning for collisions
	await execGit(projectRoot, ["worktree", "prune"]);

	const baseDir = `${shortName}-${implTimestamp}`;
	const baseBranch = `impl/${shortName}-${implTimestamp}`;

	// Try base name then -2 through -9 (9 candidates total)
	const suffixes = ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"];
	let finalDir: string | null = null;
	let finalBranch: string | null = null;

	for (const suffix of suffixes) {
		const candidateDir = baseDir + suffix;
		const candidateBranch = baseBranch + suffix;
		const absPath = path.join(basePath, candidateDir);

		// Check branch existence
		const branchCheck = await execGit(projectRoot, [
			"rev-parse",
			"--verify",
			"--quiet",
			`refs/heads/${candidateBranch}`,
		]);
		const branchExists = branchCheck.code === 0;

		// Check directory existence
		const dirExists = fs.existsSync(absPath);

		if (!branchExists && !dirExists) {
			finalDir = candidateDir;
			finalBranch = candidateBranch;
			break;
		}
	}

	if (!finalDir || !finalBranch) {
		return {
			ok: false,
			error:
				`Cannot create worktree: all candidate branch/directory names are taken ` +
				`(tried ${baseDir} through ${baseDir}-9). ` +
				`Run \`git worktree list\` to inspect active worktrees and \`git worktree prune\` to clean up stale ones.`,
		};
	}

	// Resolve baseCommit from the triggering checkout's HEAD
	const headResult = await execGit(triggeringCwd, ["rev-parse", "HEAD"]);
	if (headResult.code !== 0) {
		return {
			ok: false,
			error: `Failed to resolve HEAD from triggering checkout (${triggeringCwd}): ${headResult.stderr}`,
		};
	}
	const baseCommit = headResult.stdout.trim();

	const absPath = path.join(basePath, finalDir);

	// Create the worktree and branch
	const addResult = await execGit(projectRoot, [
		"worktree",
		"add",
		"-b",
		finalBranch,
		absPath,
		baseCommit,
	]);

	if (addResult.code !== 0) {
		return {
			ok: false,
			error: `git worktree add failed: ${addResult.stderr}`,
		};
	}

	return {
		ok: true,
		meta: {
			path: absPath,
			branch: finalBranch,
			baseCommit,
			createdAt: new Date().toISOString(),
			setupScriptRan: false,
		},
	};
}

// ============================================
// Setup Script Runner
// ============================================

/** Result of running the setup script. */
export interface SetupScriptResult {
	/** true when the script exited 0 */
	ok: boolean;
	/** Actual exit code (0 = success) */
	exitCode: number;
	/** Last ~2000 chars of combined stdout+stderr */
	outputTail: string;
	/** Absolute path to the full log file */
	logPath: string;
}

/** Default timeout before SIGTERM is sent (15 minutes) */
const SETUP_SCRIPT_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Grace period after SIGTERM before SIGKILL is sent (10 seconds) */
const SETUP_SCRIPT_SIGKILL_DELAY_MS = 10 * 1000;

/** Maximum output tail length in result (chars) */
const MAX_OUTPUT_TAIL = 2000;

/**
 * Run the setup script in the worktree directory (FR-3).
 *
 * Environment variables injected (merged over process.env):
 * - PI_WORKTREE_PATH: absolute worktree path
 * - PI_WORKTREE_BRANCH: branch name
 * - PI_MAIN_REPO: main repo root path
 * - PI_IMPL_ID: implementation pipeline ID
 *
 * Log is written best-effort to
 * `<projectRoot>/.pi/spec-pipeline/sessions/<implId>/setup-script.log`.
 * The caller decides whether a non-zero exit aborts the run (FR-3.4).
 *
 * @param options.timeoutMs - Injectable timeout (default 15 min; set low for tests)
 */
export async function runSetupScript(
	script: string,
	meta: Pick<WorktreeMetadata, "path" | "branch">,
	projectRoot: string,
	implId: string,
	options?: { timeoutMs?: number },
): Promise<SetupScriptResult> {
	const timeoutMs = options?.timeoutMs ?? SETUP_SCRIPT_DEFAULT_TIMEOUT_MS;
	const logDir = getSessionLogDir(projectRoot, implId);
	const logPath = path.join(logDir, "setup-script.log");

	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_WORKTREE_PATH: meta.path,
		PI_WORKTREE_BRANCH: meta.branch,
		PI_MAIN_REPO: projectRoot,
		PI_IMPL_ID: implId,
	};

	const { ok, exitCode, combined } = await new Promise<{
		ok: boolean;
		exitCode: number;
		combined: string;
	}>((resolve) => {
		let combined = "";
		const proc = spawn("bash", ["-c", script], {
			cwd: meta.path,
			env,
		});

		proc.stdout?.on("data", (data: Buffer) => {
			combined += data.toString();
		});
		proc.stderr?.on("data", (data: Buffer) => {
			combined += data.toString();
		});

		let settled = false;
		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

		// Send SIGTERM after timeout, then SIGKILL after grace period
		const timeoutTimer = setTimeout(() => {
			if (!settled) {
				proc.kill("SIGTERM");
				sigkillTimer = setTimeout(() => {
					if (!settled) {
						proc.kill("SIGKILL");
					}
				}, SETUP_SCRIPT_SIGKILL_DELAY_MS);
			}
		}, timeoutMs);

		proc.on("close", (code) => {
			settled = true;
			clearTimeout(timeoutTimer);
			if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
			resolve({
				ok: (code ?? 1) === 0,
				exitCode: code ?? 1,
				combined,
			});
		});

		proc.on("error", (err) => {
			settled = true;
			clearTimeout(timeoutTimer);
			if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
			resolve({
				ok: false,
				exitCode: 1,
				combined: combined + `\nProcess error: ${err.message}`,
			});
		});
	});

	// Write full log best-effort
	try {
		fs.mkdirSync(logDir, { recursive: true });
		fs.writeFileSync(logPath, combined, "utf-8");
	} catch {
		/* best-effort */
	}

	const outputTail =
		combined.length > MAX_OUTPUT_TAIL
			? combined.slice(-MAX_OUTPUT_TAIL)
			: combined;

	return { ok, exitCode, outputTail, logPath };
}

// ============================================
// Spec-path Worktree Detection
// ============================================

/**
 * Walk up the directory tree from `filePath` looking for a git worktree root
 * (a directory that contains a `.git` *file*, not a `.git` directory).
 *
 * - Returns the worktree root path when found.
 * - Returns `null` when the first `.git` entry encountered is a directory
 *   (the file lives directly in the main repo, not in a worktree).
 * - Returns `null` when no `.git` entry is found before the filesystem root.
 *
 * Used by /implement to detect when the spec file lives inside a worktree
 * that is different from the agent's current working directory.
 */
export function findWorktreeRootForPath(filePath: string): string | null {
	let dir = path.dirname(path.resolve(filePath));

	while (true) {
		const gitEntry = path.join(dir, ".git");
		try {
			const stat = fs.statSync(gitEntry);
			if (stat.isDirectory()) {
				// Main repo root — file is not in a worktree
				return null;
			}
			// .git is a file → this dir is a worktree root
			return dir;
		} catch {
			// No .git here; walk up
		}
		const parent = path.dirname(dir);
		if (parent === dir) break; // reached filesystem root
		dir = parent;
	}
	return null;
}

// ============================================
// Resume Helpers
// ============================================

/**
 * Verify that a worktree is still usable (FR-5.3):
 * - Directory exists
 * - `git rev-parse --git-dir` succeeds in the directory
 * - The checked-out branch matches `meta.branch`
 */
export async function verifyWorktree(meta: WorktreeMetadata): Promise<boolean> {
	if (!fs.existsSync(meta.path)) {
		return false;
	}

	const gitDirResult = await execGit(meta.path, ["rev-parse", "--git-dir"]);
	if (gitDirResult.code !== 0) {
		return false;
	}

	const branchResult = await execGit(meta.path, [
		"rev-parse",
		"--abbrev-ref",
		"HEAD",
	]);
	if (branchResult.code !== 0) {
		return false;
	}

	return branchResult.stdout.trim() === meta.branch;
}

/**
 * Recreate a worktree whose directory was deleted but whose branch still
 * exists (FR-5.4). Runs `git worktree prune` then
 * `git worktree add <path> <branch>` (no -b, since the branch already exists).
 * Returns a hard error if the branch is gone.
 */
export async function recreateWorktree(
	projectRoot: string,
	meta: WorktreeMetadata,
): Promise<{ ok: true } | WorktreeError> {
	// Hard fail if the branch no longer exists
	const branchCheck = await execGit(projectRoot, [
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/heads/${meta.branch}`,
	]);
	if (branchCheck.code !== 0) {
		return {
			ok: false,
			error:
				`Cannot recreate worktree: branch "${meta.branch}" no longer exists. ` +
				`The implementation history may be lost. Start a fresh /implement run.`,
		};
	}

	// Prune stale refs before re-adding
	await execGit(projectRoot, ["worktree", "prune"]);

	// Re-add without -b (branch already exists)
	const addResult = await execGit(projectRoot, [
		"worktree",
		"add",
		meta.path,
		meta.branch,
	]);

	if (addResult.code !== 0) {
		return {
			ok: false,
			error: `git worktree add failed during recreate: ${addResult.stderr}`,
		};
	}

	return { ok: true };
}
