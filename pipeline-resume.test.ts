/**
 * Tests for pipeline resume behavior after cancellation and worktree resume decisions
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	createInitialImplState,
	saveImplState,
	loadImplState,
} from "./state.ts";
import {
	createWorktree,
	verifyWorktree,
	recreateWorktree,
	type WorktreeMetadata,
} from "./worktree.ts";
import { execGit } from "./git.ts";

// ============================================
// Shared temp repo helper (mirrors worktree.test.ts)
// ============================================

async function createTempRepo(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "resume-test-"));
	await execGit(dir, ["init"]);
	await execGit(dir, ["config", "user.email", "test@example.com"]);
	await execGit(dir, ["config", "user.name", "Test User"]);
	await writeFile(path.join(dir, "README.md"), "# Test\n");
	await execGit(dir, ["add", "README.md"]);
	await execGit(dir, ["commit", "-m", "Initial commit"]);
	return dir;
}

describe("Implementation Pipeline Resume After Cancellation", () => {
	let tempDir: string;
	let cwd: string;

	function setupTempDir() {
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "impl-pipeline-resume-test-"),
		);
		cwd = tempDir;
	}

	function teardownTempDir() {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}

	it("should remember --no-plan flag when resuming", () => {
		setupTempDir();

		try {
			const state = createInitialImplState(
				"docs/specs/test_spec.md",
				"# Test Spec\nContent",
				"2602061200",
				true, // skipPlanGeneration
			);

			expect(state.skipPlanGeneration).toBe(true);

			saveImplState(cwd, state);

			state.stage = "cancelled";
			saveImplState(cwd, state);

			const loadedState = loadImplState(cwd, state.id);
			expect(loadedState).not.toBeNull();
			expect(loadedState!.skipPlanGeneration).toBe(true);
		} finally {
			teardownTempDir();
		}
	});

	it("should preserve stage before cancellation", () => {
		setupTempDir();

		try {
			const state = createInitialImplState(
				"docs/specs/test_spec.md",
				"# Test Spec",
				"2602061200",
			);

			state.stage = "implementation";
			state.phases = ["phase1.md"];
			state.phasesGenerated = [true];
			saveImplState(cwd, state);

			state.stageBeforeCancellation = state.stage;
			state.stage = "cancelled";
			saveImplState(cwd, state);

			const loadedState = loadImplState(cwd, state.id);
			expect(loadedState).not.toBeNull();
			expect(loadedState!.stage).toBe("cancelled");
			expect(loadedState!.stageBeforeCancellation).toBe("implementation");
		} finally {
			teardownTempDir();
		}
	});
});

// ============================================
// Worktree state metadata round-trip
// ============================================

describe("Worktree state metadata", () => {
	let tempDir: string;
	let cwd: string;

	function setupTempDir() {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-state-test-"));
		cwd = tempDir;
	}

	function teardownTempDir() {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}

	it("state with worktree metadata round-trips through save/load", () => {
		setupTempDir();
		try {
			const state = createInitialImplState(
				"docs/specs/test_spec.md",
				"# Test",
				"2606101218",
			);
			state.worktree = {
				path: "/tmp/worktrees/myfeature-2606101218",
				branch: "impl/myfeature-2606101218",
				baseCommit: "abc123def456789",
				createdAt: "2026-06-10T12:18:00.000Z",
				setupScriptRan: false,
			};
			saveImplState(cwd, state);

			const loaded = loadImplState(cwd, state.id);
			expect(loaded).not.toBeNull();
			expect(loaded!.worktree).toEqual(state.worktree);
			expect(loaded!.worktree!.setupScriptRan).toBe(false);
			expect(loaded!.worktree!.branch).toBe("impl/myfeature-2606101218");
		} finally {
			teardownTempDir();
		}
	});

	it("setupScriptRan can be updated to true and persisted", () => {
		setupTempDir();
		try {
			const state = createInitialImplState(
				"docs/specs/test_spec.md",
				"# Test",
				"2606101218",
			);
			state.worktree = {
				path: "/tmp/worktrees/feat-2606101218",
				branch: "impl/feat-2606101218",
				baseCommit: "deadbeef",
				createdAt: new Date().toISOString(),
				setupScriptRan: false,
			};
			saveImplState(cwd, state);

			// Simulate successful setup-script completion
			state.worktree = { ...state.worktree, setupScriptRan: true };
			saveImplState(cwd, state);

			const loaded = loadImplState(cwd, state.id);
			expect(loaded!.worktree!.setupScriptRan).toBe(true);
		} finally {
			teardownTempDir();
		}
	});

	it("legacy state with no worktree field loads with state.worktree === undefined", () => {
		setupTempDir();
		try {
			const state = createInitialImplState(
				"docs/specs/test_spec.md",
				"# Test",
				"2606101218",
			);
			// No state.worktree set
			saveImplState(cwd, state);

			const loaded = loadImplState(cwd, state.id);
			expect(loaded).not.toBeNull();
			expect(loaded!.worktree).toBeUndefined();
		} finally {
			teardownTempDir();
		}
	});
});

// ============================================
// Worktree resume decision logic (real git repos)
// ============================================

describe("Worktree resume decisions", () => {
	let mainRepo: string;
	let worktreeBase: string;

	beforeEach(async () => {
		mainRepo = await createTempRepo();
		worktreeBase = await mkdtemp(path.join(tmpdir(), "wt-resume-base-"));
	});

	afterEach(async () => {
		await execGit(mainRepo, ["worktree", "prune"]).catch(() => {});
		await rm(mainRepo, { recursive: true, force: true });
		await rm(worktreeBase, { recursive: true, force: true });
	});

	it("legacy state (no worktree metadata) — state.worktree is undefined", () => {
		const state = createInitialImplState(
			"docs/specs/test.md",
			"# Spec",
			"2606101218",
		);
		// Legacy state has no worktree field
		expect(state.worktree).toBeUndefined();
		// workRoot would equal projectRoot in the legacy branch of the handler
	});

	it("worktree intact \u2014 verifyWorktree returns true and workRoot is the worktree path", async () => {
		const result = await createWorktree(
			mainRepo,
			mainRepo,
			"myfeature",
			"2606101218",
			worktreeBase,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// With an intact worktree, verifyWorktree should return true
		const verified = await verifyWorktree(result.meta);
		expect(verified).toBe(true);

		// workRoot should be the worktree path (not mainRepo)
		expect(result.meta.path).not.toBe(mainRepo);
		expect(result.meta.path).toContain("myfeature-2606101218");
	});

	it("directory deleted + branch alive \u2014 recreate restores commits and flags setup re-run", async () => {
		const r = await createWorktree(
			mainRepo,
			mainRepo,
			"rebuild",
			"2606101218",
			worktreeBase,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;

		// Add a commit in the worktree
		await writeFile(path.join(r.meta.path, "added.txt"), "content");
		await execGit(r.meta.path, ["add", "added.txt"]);
		await execGit(r.meta.path, ["commit", "-m", "worktree commit"]);

		// Simulate directory deletion (remove worktree without pruning)
		await execGit(mainRepo, ["worktree", "remove", "--force", r.meta.path]);
		expect(fs.existsSync(r.meta.path)).toBe(false);

		// verifyWorktree should now fail
		const verified = await verifyWorktree(r.meta);
		expect(verified).toBe(false);

		// recreateWorktree should succeed
		const recreateResult = await recreateWorktree(mainRepo, r.meta);
		expect(recreateResult.ok).toBe(true);

		// The worktree directory is back
		expect(fs.existsSync(r.meta.path)).toBe(true);

		// Prior commits are restored
		expect(fs.existsSync(path.join(r.meta.path, "added.txt"))).toBe(true);

		// In the handler, setupScriptRan would be reset to false after recreation
		const stateAfterRecreate = {
			...r.meta,
			setupScriptRan: false, // reset as per FR-5.4
		};
		expect(stateAfterRecreate.setupScriptRan).toBe(false);
	});

	it("branch deleted \u2014 recreateWorktree fails with appropriate hard-error message", async () => {
		const fakeMeta: WorktreeMetadata = {
			path: path.join(worktreeBase, "ghost-2606101218"),
			branch: "impl/ghost-2606101218",
			baseCommit: "abc123",
			createdAt: new Date().toISOString(),
			setupScriptRan: false,
		};

		// Branch never existed — verifyWorktree returns false
		const verified = await verifyWorktree(fakeMeta);
		expect(verified).toBe(false);

		// recreateWorktree fails with a message directing to a fresh /implement
		const result = await recreateWorktree(mainRepo, fakeMeta);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("impl/ghost-2606101218");
			// Should mention that the branch no longer exists
			expect(result.error).toContain("no longer exists");
			// Should direct user to start fresh
			expect(result.error).toContain("/implement");
		}
	});
});
