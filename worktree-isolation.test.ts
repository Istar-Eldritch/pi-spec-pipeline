/**
 * Worktree Isolation Regression Tests (FR-7.2 / FR-4.5)
 *
 * Verify that every mutating pipeline operation runs inside the worktree and
 * NEVER touches the triggering checkout:
 *
 *  1. Pipeline commits (via createCommit) inside the worktree do NOT advance
 *     the triggering checkout's branch ref.
 *  2. handleAgentError's stash/reset cycle targets the worktree working
 *     directory and leaves the main repo's working tree byte-identical.
 *  3. New commits land exclusively on the impl/* branch (not on any other
 *     branch in the repository).
 *  4. No .pi/spec-pipeline state noise appears in the worktree's git status.
 *
 * Resume recreation tests (FR-7.4 second half):
 *  5. After the worktree directory is deleted and recreated via recreateWorktree,
 *     all prior impl/ commits are accessible at the same path and branch.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createWorktree, recreateWorktree } from "./worktree.ts";
import { execGit, createCommit } from "./git.ts";
import { handleAgentError } from "./errors.ts";
import { createInitialImplState, saveImplState } from "./state.ts";
import type { AgentResult } from "./types.ts";

// ============================================
// Test Helpers
// ============================================

/**
 * Create a temp git repo with an initial commit and a .gitignore
 * that excludes .pi/ (mirrors real project behaviour).
 */
async function createTempRepo(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "isolation-test-"));
	await execGit(dir, ["init"]);
	await execGit(dir, ["config", "user.email", "test@example.com"]);
	await execGit(dir, ["config", "user.name", "Test User"]);
	await writeFile(path.join(dir, "README.md"), "# Test\n");
	// Gitignore .pi/ so state files written during tests do not pollute
	// git status output (mirrors real repo behaviour — see ~/.gitignore_global).
	await writeFile(path.join(dir, ".gitignore"), ".pi/\n");
	await execGit(dir, ["add", "README.md", ".gitignore"]);
	await execGit(dir, ["commit", "-m", "Initial commit"]);
	return dir;
}

// ============================================
// Isolation Regression (FR-7.2 / FR-4.5)
// ============================================

describe("Worktree Isolation Regression (FR-7.2 / FR-4.5)", () => {
	let mainRepo: string;
	let worktreeBase: string;

	beforeEach(async () => {
		mainRepo = await createTempRepo();
		worktreeBase = await mkdtemp(path.join(tmpdir(), "isolation-base-"));
	});

	afterEach(async () => {
		await execGit(mainRepo, ["worktree", "prune"]).catch(() => {});
		await rm(mainRepo, { recursive: true, force: true });
		await rm(worktreeBase, { recursive: true, force: true });
	});

	it("commits made in the worktree do not advance the triggering checkout HEAD", async () => {
		// Record original HEAD of the triggering checkout
		const origHead = (
			await execGit(mainRepo, ["rev-parse", "HEAD"])
		).stdout.trim();

		// Add a dirty (uncommitted) file to the main repo
		const dirtyFile = path.join(mainRepo, "dirty.txt");
		fs.writeFileSync(dirtyFile, "user work in progress\n");
		const origStatus = (await execGit(mainRepo, ["status", "--porcelain"]))
			.stdout;
		const origDirtyBytes = fs.readFileSync(dirtyFile, "utf-8");

		// Create a worktree
		const worktreeResult = await createWorktree(
			mainRepo,
			mainRepo,
			"isol",
			"2606101218",
			worktreeBase,
		);
		expect(worktreeResult.ok).toBe(true);
		if (!worktreeResult.ok) return;

		const { meta } = worktreeResult;
		const workRoot = meta.path;

		// Write a file in the worktree and commit it (simulates one pipeline phase)
		fs.writeFileSync(
			path.join(workRoot, "impl-file.txt"),
			"implementation content\n",
		);
		const committed = await createCommit(
			workRoot,
			"feat: add implementation file",
		);
		expect(committed).toBe(true);

		// ── Assertions ──────────────────────────────────────────────────────

		// 1. Triggering checkout HEAD must be unchanged
		const newHead = (
			await execGit(mainRepo, ["rev-parse", "HEAD"])
		).stdout.trim();
		expect(newHead).toBe(origHead);

		// 2. git status output must be byte-identical (dirty.txt still untracked)
		const newStatus = (await execGit(mainRepo, ["status", "--porcelain"]))
			.stdout;
		expect(newStatus).toBe(origStatus);

		// 3. Dirty file bytes must be unchanged
		const newDirtyBytes = fs.readFileSync(dirtyFile, "utf-8");
		expect(newDirtyBytes).toBe(origDirtyBytes);

		// 4. The commit must be on the impl/ branch …
		const implLog = (await execGit(mainRepo, ["log", "--oneline", meta.branch]))
			.stdout;
		expect(implLog).toContain("feat: add implementation file");

		// … and NOT on the triggering checkout's branch
		const mainLog = (await execGit(mainRepo, ["log", "--oneline", "HEAD"]))
			.stdout;
		expect(mainLog).not.toContain("feat: add implementation file");
	});

	it("handleAgentError stash/reset targets the worktree and leaves main repo untouched", async () => {
		// Add a dirty file to the main repo
		const dirtyFile = path.join(mainRepo, "user-work.txt");
		fs.writeFileSync(dirtyFile, "user work in progress\n");
		const origDirtyBytes = fs.readFileSync(dirtyFile, "utf-8");
		const origStatus = (await execGit(mainRepo, ["status", "--porcelain"]))
			.stdout;
		const origHead = (
			await execGit(mainRepo, ["rev-parse", "HEAD"])
		).stdout.trim();

		// Create a worktree
		const worktreeResult = await createWorktree(
			mainRepo,
			mainRepo,
			"errtest",
			"2606101218",
			worktreeBase,
		);
		expect(worktreeResult.ok).toBe(true);
		if (!worktreeResult.ok) return;

		const { meta } = worktreeResult;
		const workRoot = meta.path;

		// Simulate a half-written implementation step in the worktree
		fs.writeFileSync(
			path.join(workRoot, "half-done.txt"),
			"half-implemented content\n",
		);
		expect(fs.existsSync(path.join(workRoot, "half-done.txt"))).toBe(true);

		// Set up pipeline state (saved to projectRoot)
		const state = createInitialImplState(
			"specs/test.md",
			"# Spec",
			"2606101218",
		);
		state.worktree = { ...meta };
		saveImplState(mainRepo, state);

		const mockResult: AgentResult = {
			output: "",
			exitCode: 1,
			error: "test agent failure",
			completed: false,
		};

		const notifications: string[] = [];
		await handleAgentError(
			mainRepo, // projectRoot — error log written here
			workRoot, // workRoot — stash/reset happen here
			state,
			mockResult,
			"implementer",
			"implementer",
			"Implement phase 1: add feature",
			1,
			undefined,
			(msg, _type) => notifications.push(msg),
			() => saveImplState(mainRepo, state),
		);

		// ── Main repo assertions ─────────────────────────────────────────────

		// HEAD unchanged
		const newHead = (
			await execGit(mainRepo, ["rev-parse", "HEAD"])
		).stdout.trim();
		expect(newHead).toBe(origHead);

		// git status byte-identical (user-work.txt still untracked)
		const newStatus = (await execGit(mainRepo, ["status", "--porcelain"]))
			.stdout;
		expect(newStatus).toBe(origStatus);

		// Dirty file content preserved
		const newDirtyBytes = fs.readFileSync(dirtyFile, "utf-8");
		expect(newDirtyBytes).toBe(origDirtyBytes);

		// ── Worktree assertions ──────────────────────────────────────────────

		// half-done.txt was stashed/reset — it must be gone from the worktree
		expect(fs.existsSync(path.join(workRoot, "half-done.txt"))).toBe(false);

		// Stash notification was emitted (at least one mentions stash)
		const stashMsg = notifications.find((n) =>
			n.toLowerCase().includes("stash"),
		);
		expect(stashMsg).toBeTruthy();

		// ── No .pi/spec-pipeline noise in the worktree status ───────────────
		// State is written to projectRoot/.pi/spec-pipeline/, NOT workRoot.
		// The worktree should be clean after the reset.
		const wtStatus = (await execGit(workRoot, ["status", "--porcelain"]))
			.stdout;
		expect(wtStatus.trim()).toBe("");
	});

	it("multiple phase commits land exclusively on the impl/* branch", async () => {
		const origHead = (
			await execGit(mainRepo, ["rev-parse", "HEAD"])
		).stdout.trim();

		// Create a worktree
		const worktreeResult = await createWorktree(
			mainRepo,
			mainRepo,
			"exclusive",
			"2606101218",
			worktreeBase,
		);
		expect(worktreeResult.ok).toBe(true);
		if (!worktreeResult.ok) return;

		const { meta } = worktreeResult;
		const workRoot = meta.path;

		// Simulate 3 phase commits in the worktree
		for (let i = 1; i <= 3; i++) {
			fs.writeFileSync(
				path.join(workRoot, `phase${i}-result.txt`),
				`Phase ${i} output\n`,
			);
			const ok = await createCommit(
				workRoot,
				`feat(phase${i}): implement phase ${i}`,
			);
			expect(ok).toBe(true);
		}

		// Triggering checkout HEAD unchanged
		const newMainHead = (
			await execGit(mainRepo, ["rev-parse", "HEAD"])
		).stdout.trim();
		expect(newMainHead).toBe(origHead);

		// impl/ branch tip is ahead of the original HEAD
		const implTip = (
			await execGit(mainRepo, ["rev-parse", meta.branch])
		).stdout.trim();
		expect(implTip).not.toBe(origHead);

		// All 3 commits on the impl/ branch
		const implLog = (await execGit(mainRepo, ["log", "--oneline", meta.branch]))
			.stdout;
		expect(implLog).toContain("feat(phase1)");
		expect(implLog).toContain("feat(phase2)");
		expect(implLog).toContain("feat(phase3)");

		// None of those commits visible on the triggering checkout
		const mainLog = (await execGit(mainRepo, ["log", "--oneline", "HEAD"]))
			.stdout;
		expect(mainLog).not.toContain("feat(phase1)");
		expect(mainLog).not.toContain("feat(phase2)");
		expect(mainLog).not.toContain("feat(phase3)");

		// Worktree is clean after all commits
		const wtStatus = (await execGit(workRoot, ["status", "--porcelain"]))
			.stdout;
		expect(wtStatus.trim()).toBe("");
	});

	it("error log is written under projectRoot, not inside the worktree", async () => {
		// Create a worktree
		const worktreeResult = await createWorktree(
			mainRepo,
			mainRepo,
			"logtest",
			"2606101218",
			worktreeBase,
		);
		expect(worktreeResult.ok).toBe(true);
		if (!worktreeResult.ok) return;

		const workRoot = worktreeResult.meta.path;

		const state = createInitialImplState(
			"specs/test.md",
			"# Spec",
			"2606101218",
		);
		state.worktree = { ...worktreeResult.meta };
		saveImplState(mainRepo, state);

		const mockResult: AgentResult = {
			output: "",
			exitCode: 1,
			error: "log location test",
			completed: false,
		};

		await handleAgentError(
			mainRepo,
			workRoot,
			state,
			mockResult,
			"implementer",
			"implementer",
			"test task",
			undefined,
			undefined,
			(_msg, _type) => {},
			() => saveImplState(mainRepo, state),
		);

		// Error log must exist under the main repo .pi/spec-pipeline/
		const mainRepoLogPath = path.join(
			mainRepo,
			".pi",
			"spec-pipeline",
			`${state.id}.error.log`,
		);
		expect(fs.existsSync(mainRepoLogPath)).toBe(true);

		// Error log must NOT exist under the worktree
		const worktreeLogPath = path.join(
			workRoot,
			".pi",
			"spec-pipeline",
			`${state.id}.error.log`,
		);
		expect(fs.existsSync(worktreeLogPath)).toBe(false);
	});
});

// ============================================
// Resume Recreation Tests (FR-7.4 second half)
// ============================================

describe("Worktree Recreation Restores Prior Commits (FR-7.4)", () => {
	let mainRepo: string;
	let worktreeBase: string;

	beforeEach(async () => {
		mainRepo = await createTempRepo();
		worktreeBase = await mkdtemp(path.join(tmpdir(), "recreation-base-"));
	});

	afterEach(async () => {
		await execGit(mainRepo, ["worktree", "prune"]).catch(() => {});
		await rm(mainRepo, { recursive: true, force: true });
		await rm(worktreeBase, { recursive: true, force: true });
	});

	it("recreated worktree exposes all prior pipeline commits at the same path and branch", async () => {
		// Create a worktree
		const r = await createWorktree(
			mainRepo,
			mainRepo,
			"recreate2",
			"2606101218",
			worktreeBase,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;

		const workRoot = r.meta.path;

		// Simulate two phase commits
		for (let i = 1; i <= 2; i++) {
			fs.writeFileSync(path.join(workRoot, `output${i}.txt`), `Output ${i}\n`);
			const ok = await createCommit(workRoot, `feat: output ${i}`);
			expect(ok).toBe(true);
		}

		// Record the branch tip before deletion
		const tipBeforeDelete = (
			await execGit(workRoot, ["rev-parse", "HEAD"])
		).stdout.trim();

		// Delete the worktree directory (simulate manual rm / accident)
		await execGit(mainRepo, ["worktree", "remove", "--force", workRoot]);
		expect(fs.existsSync(workRoot)).toBe(false);

		// The branch must still exist in the main repo
		const branchCheck = await execGit(mainRepo, [
			"rev-parse",
			"--verify",
			`refs/heads/${r.meta.branch}`,
		]);
		expect(branchCheck.code).toBe(0);

		// Recreate the worktree from the existing branch
		const recreateResult = await recreateWorktree(mainRepo, r.meta);
		expect(recreateResult.ok).toBe(true);

		// Directory is back
		expect(fs.existsSync(workRoot)).toBe(true);

		// Branch tip must be unchanged — prior commits are restored
		const tipAfterRecreate = (
			await execGit(workRoot, ["rev-parse", "HEAD"])
		).stdout.trim();
		expect(tipAfterRecreate).toBe(tipBeforeDelete);

		// Both output files are accessible in the recreated worktree
		expect(fs.existsSync(path.join(workRoot, "output1.txt"))).toBe(true);
		expect(fs.existsSync(path.join(workRoot, "output2.txt"))).toBe(true);

		// Full commit log is intact
		const logAfterRecreate = (await execGit(workRoot, ["log", "--oneline"]))
			.stdout;
		expect(logAfterRecreate).toContain("feat: output 1");
		expect(logAfterRecreate).toContain("feat: output 2");
	});

	it("recreated worktree has the correct branch checked out", async () => {
		const r = await createWorktree(
			mainRepo,
			mainRepo,
			"branchcheck",
			"2606101218",
			worktreeBase,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;

		const workRoot = r.meta.path;

		// Add a commit so the branch diverges from HEAD
		fs.writeFileSync(path.join(workRoot, "feature.txt"), "feature\n");
		await createCommit(workRoot, "feat: add feature");

		// Remove and recreate
		await execGit(mainRepo, ["worktree", "remove", "--force", workRoot]);
		const recreateResult = await recreateWorktree(mainRepo, r.meta);
		expect(recreateResult.ok).toBe(true);

		// Branch name must match
		const branchResult = await execGit(workRoot, [
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]);
		expect(branchResult.stdout.trim()).toBe(r.meta.branch);
	});
});
