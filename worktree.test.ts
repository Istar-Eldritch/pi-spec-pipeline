import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	resolveProjectRoot,
	deriveShortName,
	resolveAndValidateBasePath,
	ensureBasePathGitignore,
	createWorktree,
	runSetupScript,
	verifyWorktree,
	recreateWorktree,
	findWorktreeRootForPath,
	type WorktreeMetadata,
} from "./worktree.ts";
import { execGit } from "./git.ts";

// ============================================
// Test Helpers
// ============================================

/**
 * Create a temporary git repository with one initial commit.
 * Follows the same pattern as git.test.ts.
 */
async function createTempRepo(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "worktree-test-"));
	await execGit(dir, ["init"]);
	await execGit(dir, ["config", "user.email", "test@example.com"]);
	await execGit(dir, ["config", "user.name", "Test User"]);
	await writeFile(path.join(dir, "README.md"), "# Test\n");
	await execGit(dir, ["add", "README.md"]);
	await execGit(dir, ["commit", "-m", "Initial commit"]);
	return dir;
}

// ============================================
// resolveProjectRoot
// ============================================

describe("resolveProjectRoot", () => {
	let mainRepo: string;

	beforeEach(async () => {
		mainRepo = await createTempRepo();
	});

	afterEach(async () => {
		await execGit(mainRepo, ["worktree", "prune"]).catch(() => {});
		await rm(mainRepo, { recursive: true, force: true });
	});

	it("returns cwd unchanged when not in a worktree", () => {
		expect(resolveProjectRoot(mainRepo)).toBe(mainRepo);
	});

	it("returns the main repo root when called from inside a generated worktree", async () => {
		const worktreeDir = path.join(tmpdir(), "test-wt-resolve-" + Date.now());
		try {
			const r = await execGit(mainRepo, [
				"worktree",
				"add",
				"-b",
				"test-resolve-branch",
				worktreeDir,
				"HEAD",
			]);
			expect(r.code).toBe(0);

			// resolveProjectRoot from inside the worktree should return mainRepo
			expect(resolveProjectRoot(worktreeDir)).toBe(mainRepo);
		} finally {
			await execGit(mainRepo, [
				"worktree",
				"remove",
				"--force",
				worktreeDir,
			]).catch(() => {});
			await execGit(mainRepo, ["branch", "-D", "test-resolve-branch"]).catch(
				() => {},
			);
			await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

// ============================================
// deriveShortName
// ============================================

describe("deriveShortName", () => {
	it("strips numeric+spec_ prefix", () => {
		expect(deriveShortName("2606101218_spec_my_feature.md")).toBe("my_feature");
	});

	it("strips numeric-only prefix", () => {
		expect(deriveShortName("2606101218_my_feature.md")).toBe("my_feature");
	});

	it("lowercases the name", () => {
		expect(deriveShortName("MyFeature.md")).toBe("myfeature");
	});

	it("replaces hyphens with underscores", () => {
		expect(deriveShortName("my-feature.md")).toBe("my_feature");
	});

	it("replaces spaces and special chars with underscores", () => {
		expect(deriveShortName("my feature!.md")).toBe("my_feature_");
	});

	it("truncates to 30 characters", () => {
		const long = "a".repeat(40);
		const result = deriveShortName(`${long}.md`);
		expect(result).toHaveLength(30);
		expect(result).toBe("a".repeat(30));
	});

	it("handles paths with leading directories", () => {
		expect(
			deriveShortName("/specs/2606101218_spec_worktree_isolation.md"),
		).toBe("worktree_isolation");
	});

	it("handles filename without extension", () => {
		// path.extname returns "" for no extension, basename is the full name
		expect(deriveShortName("noextension")).toBe("noextension");
	});

	it("handles names that need no transformation", () => {
		expect(deriveShortName("already_clean.md")).toBe("already_clean");
	});

	it("matches the existing inline logic in implement-pipeline.ts", () => {
		// These test cases mirror the spec filename patterns used in the pipeline
		expect(deriveShortName("2606101218_spec_implement_worktree.md")).toBe(
			"implement_worktree",
		);
		expect(deriveShortName("2602071200_warm_pools.md")).toBe("warm_pools");
		// Timestamp in different format
		expect(deriveShortName("12345678_spec_test.md")).toBe("test");
	});
});

// ============================================
// resolveAndValidateBasePath
// ============================================

describe("resolveAndValidateBasePath", () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await mkdtemp(path.join(tmpdir(), "basepath-test-"));
	});

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
	});

	it("resolves relative paths against projectRoot", () => {
		const result = resolveAndValidateBasePath(".pi/worktrees", projectRoot);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.resolvedBase).toBe(path.join(projectRoot, ".pi/worktrees"));
		}
	});

	it("uses absolute paths as-is", () => {
		const absPath = path.join(projectRoot, "my-worktrees");
		const result = resolveAndValidateBasePath(absPath, projectRoot);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.resolvedBase).toBe(absPath);
		}
	});

	it("rejects basePath equal to projectRoot (relative .)", () => {
		const result = resolveAndValidateBasePath(".", projectRoot);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain(projectRoot);
		}
	});

	it("rejects basePath equal to projectRoot (absolute)", () => {
		const result = resolveAndValidateBasePath(projectRoot, projectRoot);
		expect(result.ok).toBe(false);
	});

	it("rejects basePath inside .git (relative)", () => {
		const result = resolveAndValidateBasePath(".git/worktrees", projectRoot);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain(".git");
		}
	});

	it("rejects basePath equal to .git (absolute)", () => {
		const result = resolveAndValidateBasePath(
			path.join(projectRoot, ".git"),
			projectRoot,
		);
		expect(result.ok).toBe(false);
	});

	it("rejects basePath deeply nested inside .git", () => {
		const result = resolveAndValidateBasePath(
			path.join(projectRoot, ".git", "refs", "worktrees"),
			projectRoot,
		);
		expect(result.ok).toBe(false);
	});

	it("accepts a sibling directory outside the project", () => {
		const siblingPath = path.resolve(projectRoot, "../sibling-worktrees");
		const result = resolveAndValidateBasePath(siblingPath, projectRoot);
		expect(result.ok).toBe(true);
	});
});

// ============================================
// ensureBasePathGitignore
// ============================================

describe("ensureBasePathGitignore", () => {
	let baseDir: string;

	beforeEach(async () => {
		baseDir = await mkdtemp(path.join(tmpdir(), "gitignore-test-"));
	});

	afterEach(async () => {
		await rm(baseDir, { recursive: true, force: true });
	});

	it("creates the directory and .gitignore with * when missing", () => {
		const subDir = path.join(baseDir, "worktrees");
		expect(fs.existsSync(subDir)).toBe(false);

		ensureBasePathGitignore(subDir);

		expect(fs.existsSync(subDir)).toBe(true);
		const content = fs.readFileSync(path.join(subDir, ".gitignore"), "utf-8");
		expect(content).toBe("*\n");
	});

	it("is idempotent — does not overwrite an existing .gitignore", () => {
		const subDir = path.join(baseDir, "worktrees");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(
			path.join(subDir, ".gitignore"),
			"custom-content\n",
			"utf-8",
		);

		ensureBasePathGitignore(subDir);

		const content = fs.readFileSync(path.join(subDir, ".gitignore"), "utf-8");
		expect(content).toBe("custom-content\n");
	});

	it("can be called multiple times safely", () => {
		const subDir = path.join(baseDir, "worktrees");
		ensureBasePathGitignore(subDir);
		ensureBasePathGitignore(subDir);
		ensureBasePathGitignore(subDir);

		const content = fs.readFileSync(path.join(subDir, ".gitignore"), "utf-8");
		expect(content).toBe("*\n");
	});
});

// ============================================
// createWorktree
// ============================================

describe("createWorktree", () => {
	let mainRepo: string;
	let worktreeBase: string;

	beforeEach(async () => {
		mainRepo = await createTempRepo();
		worktreeBase = await mkdtemp(path.join(tmpdir(), "wt-base-"));
	});

	afterEach(async () => {
		// Remove any worktrees before cleaning up dirs
		await execGit(mainRepo, ["worktree", "prune"]).catch(() => {});
		await rm(mainRepo, { recursive: true, force: true });
		await rm(worktreeBase, { recursive: true, force: true });
	});

	it("creates a worktree on the correct branch at the triggering HEAD", async () => {
		const result = await createWorktree(
			mainRepo,
			mainRepo,
			"myfeature",
			"2606101218",
			worktreeBase,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const { meta } = result;
		expect(meta.branch).toBe("impl/myfeature-2606101218");
		expect(meta.path).toBe(path.join(worktreeBase, "myfeature-2606101218"));
		expect(meta.setupScriptRan).toBe(false);
		expect(meta.baseCommit).toBeTruthy();
		expect(meta.createdAt).toBeTruthy();
	});

	it("worktree directory exists after creation", async () => {
		const result = await createWorktree(
			mainRepo,
			mainRepo,
			"myfeature",
			"2606101218",
			worktreeBase,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(fs.existsSync(result.meta.path)).toBe(true);
	});

	it("worktree has the correct branch checked out", async () => {
		const result = await createWorktree(
			mainRepo,
			mainRepo,
			"myfeature",
			"2606101218",
			worktreeBase,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const branchResult = await execGit(result.meta.path, [
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]);
		expect(branchResult.stdout.trim()).toBe("impl/myfeature-2606101218");
	});

	it("worktree HEAD equals the triggering checkout HEAD", async () => {
		const result = await createWorktree(
			mainRepo,
			mainRepo,
			"myfeature",
			"2606101218",
			worktreeBase,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const worktreeHead = await execGit(result.meta.path, ["rev-parse", "HEAD"]);
		const mainHead = await execGit(mainRepo, ["rev-parse", "HEAD"]);
		expect(worktreeHead.stdout.trim()).toBe(mainHead.stdout.trim());
		expect(result.meta.baseCommit).toBe(mainHead.stdout.trim());
	});

	it("worktree appears in git worktree list", async () => {
		const result = await createWorktree(
			mainRepo,
			mainRepo,
			"myfeature",
			"2606101218",
			worktreeBase,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const listResult = await execGit(mainRepo, ["worktree", "list"]);
		expect(listResult.stdout).toContain(result.meta.path);
		expect(listResult.stdout).toContain("impl/myfeature-2606101218");
	});

	it("uses -2 suffix on the first collision", async () => {
		const r1 = await createWorktree(
			mainRepo,
			mainRepo,
			"myfeature",
			"2606101218",
			worktreeBase,
		);
		expect(r1.ok).toBe(true);

		const r2 = await createWorktree(
			mainRepo,
			mainRepo,
			"myfeature",
			"2606101218",
			worktreeBase,
		);
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;

		expect(r2.meta.branch).toBe("impl/myfeature-2606101218-2");
		expect(r2.meta.path).toBe(
			path.join(worktreeBase, "myfeature-2606101218-2"),
		);
	});

	it("returns an error when all 9 candidate slots are taken", async () => {
		const shortName = "exh";
		const ts = "2606101218";
		const baseDir = `${shortName}-${ts}`;
		const baseBranch = `impl/${shortName}-${ts}`;

		// Pre-populate all 9 slots by creating branches and directories
		const suffixes = ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"];
		for (const s of suffixes) {
			// Create branch pointing at HEAD
			await execGit(mainRepo, ["branch", `${baseBranch}${s}`, "HEAD"]);
			// Create the directory so the dir-check also triggers
			fs.mkdirSync(path.join(worktreeBase, `${baseDir}${s}`), {
				recursive: true,
			});
		}

		const result = await createWorktree(
			mainRepo,
			mainRepo,
			shortName,
			ts,
			worktreeBase,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("git worktree list");
			expect(result.error).toContain("git worktree prune");
		}
	});

	it("resolves a relative basePath correctly when supplied as an absolute path", async () => {
		// The basePath passed to createWorktree should already be resolved by the caller;
		// verify the path in metadata is correct
		const relResolved = path.join(mainRepo, ".pi/worktrees");
		fs.mkdirSync(relResolved, { recursive: true });

		const result = await createWorktree(
			mainRepo,
			mainRepo,
			"feat",
			"2606101218",
			relResolved,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.meta.path).toBe(path.join(relResolved, "feat-2606101218"));
	});
});

// ============================================
// runSetupScript
// ============================================

describe("runSetupScript", () => {
	let mainRepo: string;
	let worktreeDir: string;

	beforeEach(async () => {
		mainRepo = await createTempRepo();
		worktreeDir = await mkdtemp(path.join(tmpdir(), "setup-script-test-"));
	});

	afterEach(async () => {
		await rm(mainRepo, { recursive: true, force: true });
		await rm(worktreeDir, { recursive: true, force: true });
	});

	function fakeMeta(
		worktreePath: string,
	): Pick<WorktreeMetadata, "path" | "branch"> {
		return { path: worktreePath, branch: "impl/test-2606101218" };
	}

	it("runs the script with correct environment variables", async () => {
		// Echo all variables to stdout so they appear in outputTail
		const script = [
			`echo "PATH=$PI_WORKTREE_PATH"`,
			`echo "BRANCH=$PI_WORKTREE_BRANCH"`,
			`echo "REPO=$PI_MAIN_REPO"`,
			`echo "ID=$PI_IMPL_ID"`,
		].join(" && ");

		const result = await runSetupScript(
			script,
			fakeMeta(worktreeDir),
			mainRepo,
			"test-impl-id",
		);

		expect(result.ok).toBe(true);
		expect(result.outputTail).toContain(`PATH=${worktreeDir}`);
		expect(result.outputTail).toContain(`BRANCH=impl/test-2606101218`);
		expect(result.outputTail).toContain(`REPO=${mainRepo}`);
		expect(result.outputTail).toContain(`ID=test-impl-id`);
	});

	it("runs the script with worktree path as cwd", async () => {
		const outputFile = path.join(worktreeDir, "cwd.txt");
		const result = await runSetupScript(
			`pwd > ${JSON.stringify(outputFile)}`,
			fakeMeta(worktreeDir),
			mainRepo,
			"test-impl-id",
		);

		expect(result.ok).toBe(true);
		const cwd = fs.readFileSync(outputFile, "utf-8").trim();
		// Resolve both to handle symlinks (e.g. /var → /private/var on macOS)
		expect(path.resolve(cwd)).toBe(path.resolve(worktreeDir));
	});

	it("captures combined stdout and stderr in outputTail", async () => {
		const result = await runSetupScript(
			`echo "stdout line" && echo "stderr line" >&2`,
			fakeMeta(worktreeDir),
			mainRepo,
			"test-impl-id",
		);

		expect(result.ok).toBe(true);
		expect(result.outputTail).toContain("stdout line");
		expect(result.outputTail).toContain("stderr line");
	});

	it("returns ok=false and non-zero exitCode on script failure", async () => {
		const result = await runSetupScript(
			`echo "before error" && exit 42`,
			fakeMeta(worktreeDir),
			mainRepo,
			"test-impl-id",
		);

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(42);
		expect(result.outputTail).toContain("before error");
	});

	it("writes the full log to the session log directory", async () => {
		const result = await runSetupScript(
			`echo "hello from setup script"`,
			fakeMeta(worktreeDir),
			mainRepo,
			"test-impl-id",
		);

		expect(result.ok).toBe(true);
		expect(result.logPath).toContain("setup-script.log");
		expect(fs.existsSync(result.logPath)).toBe(true);
		const logContent = fs.readFileSync(result.logPath, "utf-8");
		expect(logContent).toContain("hello from setup script");
	});

	it("truncates outputTail to at most 2000 chars when output is large", async () => {
		// 120 lines of ~30 chars = ~3600 chars total
		const result = await runSetupScript(
			`for i in $(seq 1 120); do echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; done`,
			fakeMeta(worktreeDir),
			mainRepo,
			"test-impl-id",
		);

		expect(result.ok).toBe(true);
		expect(result.outputTail.length).toBeLessThanOrEqual(2000);
	});

	it("handles script timeout using injectable timeoutMs (SIGTERM kills the process)", async () => {
		const start = Date.now();
		// sleep 30 would normally take 30s; with a 50ms timeout it is killed promptly
		const result = await runSetupScript(
			`sleep 30`,
			fakeMeta(worktreeDir),
			mainRepo,
			"test-impl-id",
			{ timeoutMs: 50 },
		);
		const elapsed = Date.now() - start;

		expect(result.ok).toBe(false);
		// Should finish well within 5 seconds (50ms + signal handling; SIGKILL at 10s)
		expect(elapsed).toBeLessThan(5000);
	});

	it("returns ok=true for a zero-exit script", async () => {
		const result = await runSetupScript(
			`echo "done" && exit 0`,
			fakeMeta(worktreeDir),
			mainRepo,
			"test-impl-id",
		);
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
	});
});

// ============================================
// verifyWorktree
// ============================================

describe("verifyWorktree", () => {
	let mainRepo: string;
	let worktreeBase: string;

	beforeEach(async () => {
		mainRepo = await createTempRepo();
		worktreeBase = await mkdtemp(path.join(tmpdir(), "verify-test-"));
	});

	afterEach(async () => {
		await execGit(mainRepo, ["worktree", "prune"]).catch(() => {});
		await rm(mainRepo, { recursive: true, force: true });
		await rm(worktreeBase, { recursive: true, force: true });
	});

	it("returns true for an intact worktree", async () => {
		const r = await createWorktree(
			mainRepo,
			mainRepo,
			"verify",
			"2606101218",
			worktreeBase,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;

		expect(await verifyWorktree(r.meta)).toBe(true);
	});

	it("returns false when the worktree directory does not exist", async () => {
		const fakeMeta: WorktreeMetadata = {
			path: path.join(worktreeBase, "nonexistent"),
			branch: "impl/nonexistent-2606101218",
			baseCommit: "abc123",
			createdAt: new Date().toISOString(),
			setupScriptRan: false,
		};

		expect(await verifyWorktree(fakeMeta)).toBe(false);
	});

	it("returns false when the checked-out branch does not match meta.branch", async () => {
		const r = await createWorktree(
			mainRepo,
			mainRepo,
			"verify",
			"2606101218",
			worktreeBase,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;

		const wrongMeta: WorktreeMetadata = {
			...r.meta,
			branch: "impl/completely-wrong-branch",
		};
		expect(await verifyWorktree(wrongMeta)).toBe(false);
	});
});

// ============================================
// recreateWorktree
// ============================================

describe("recreateWorktree", () => {
	let mainRepo: string;
	let worktreeBase: string;

	beforeEach(async () => {
		mainRepo = await createTempRepo();
		worktreeBase = await mkdtemp(path.join(tmpdir(), "recreate-test-"));
	});

	afterEach(async () => {
		await execGit(mainRepo, ["worktree", "prune"]).catch(() => {});
		await rm(mainRepo, { recursive: true, force: true });
		await rm(worktreeBase, { recursive: true, force: true });
	});

	it("restores a deleted worktree directory from the existing branch", async () => {
		const r = await createWorktree(
			mainRepo,
			mainRepo,
			"recreate",
			"2606101218",
			worktreeBase,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;

		// Add a commit to the worktree's branch so we can verify it's restored later
		await writeFile(path.join(r.meta.path, "test.txt"), "content");
		await execGit(r.meta.path, ["add", "test.txt"]);
		await execGit(r.meta.path, ["commit", "-m", "worktree commit"]);

		// Remove the worktree directory (simulate directory deletion)
		await execGit(mainRepo, ["worktree", "remove", "--force", r.meta.path]);
		expect(fs.existsSync(r.meta.path)).toBe(false);

		// Recreate
		const recreateResult = await recreateWorktree(mainRepo, r.meta);
		expect(recreateResult.ok).toBe(true);

		// Directory should be back
		expect(fs.existsSync(r.meta.path)).toBe(true);

		// Branch should be correct
		const branchResult = await execGit(r.meta.path, [
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]);
		expect(branchResult.stdout.trim()).toBe(r.meta.branch);

		// Prior commits should be restored
		expect(fs.existsSync(path.join(r.meta.path, "test.txt"))).toBe(true);
	});

	it("returns an error when the branch no longer exists", async () => {
		const fakeMeta: WorktreeMetadata = {
			path: path.join(worktreeBase, "ghost"),
			branch: "impl/ghost-branch-never-existed",
			baseCommit: "abc123",
			createdAt: new Date().toISOString(),
			setupScriptRan: false,
		};

		const result = await recreateWorktree(mainRepo, fakeMeta);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("impl/ghost-branch-never-existed");
			expect(result.error).toContain("/implement");
		}
	});
});

// ============================================
// findWorktreeRootForPath
// ============================================

describe("findWorktreeRootForPath", () => {
	let mainRepo: string;
	let worktreeBase: string;

	beforeEach(async () => {
		mainRepo = await createTempRepo();
		worktreeBase = path.join(mainRepo, ".pi", "worktrees");
		fs.mkdirSync(worktreeBase, { recursive: true });
	});

	afterEach(async () => {
		await execGit(mainRepo, ["worktree", "prune"]).catch(() => {});
		await rm(mainRepo, { recursive: true, force: true });
	});

	it("returns null for a file in the main repo", () => {
		const filePath = path.join(mainRepo, "docs", "spec.md");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "spec");
		expect(findWorktreeRootForPath(filePath)).toBeNull();
	});

	it("returns the worktree root for a file at the root of a worktree", async () => {
		const r = await createWorktree(
			mainRepo,
			mainRepo,
			"myfeature",
			"2606141200",
			worktreeBase,
		);
		if (!r.ok) throw new Error(r.error);

		const fileAtRoot = path.join(r.meta.path, "spec.md");
		fs.writeFileSync(fileAtRoot, "spec");
		expect(findWorktreeRootForPath(fileAtRoot)).toBe(r.meta.path);
	});

	it("returns the worktree root for a file nested deep inside a worktree", async () => {
		const r = await createWorktree(
			mainRepo,
			mainRepo,
			"myfeature",
			"2606141201",
			worktreeBase,
		);
		if (!r.ok) throw new Error(r.error);

		const nestedFile = path.join(r.meta.path, "docs", "deep", "spec.md");
		fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
		fs.writeFileSync(nestedFile, "spec");
		expect(findWorktreeRootForPath(nestedFile)).toBe(r.meta.path);
	});

	it("returns null for a path that has no git repo at all", async () => {
		const orphanDir = await mkdtemp(path.join(tmpdir(), "no-git-"));
		try {
			const filePath = path.join(orphanDir, "spec.md");
			fs.writeFileSync(filePath, "spec");
			expect(findWorktreeRootForPath(filePath)).toBeNull();
		} finally {
			await rm(orphanDir, { recursive: true, force: true });
		}
	});
});
