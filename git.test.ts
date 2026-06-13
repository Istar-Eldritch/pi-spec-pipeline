import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	extractCommitMessage,
	captureGitStatus,
	getChangedFilesSince,
	getHeadCommit,
	getModifiedFiles,
	stageFiles,
	hasChangesStaged,
	stashChanges,
	dropStash,
	stashExists,
	resetToHead,
	execGit,
} from "./git.ts";
import { handleAgentError } from "./errors.ts";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImplementationState, AgentResult } from "./types.ts";

describe("extractCommitMessage", () => {
	describe("code block extraction", () => {
		it("extracts message from markdown code block", () => {
			const output = `Here's the commit message:

\`\`\`
feat(api): add user authentication endpoint

- Implement JWT token generation
- Add login/logout routes
- Include rate limiting
\`\`\`

This follows conventional commit format.`;

			const message = extractCommitMessage(output);
			expect(message).toContain("feat(api): add user authentication endpoint");
			expect(message).toContain("Implement JWT token generation");
		});

		it("extracts message from code block with language hint", () => {
			const output = `\`\`\`text
fix(parser): handle edge case in tokenizer
\`\`\``;

			const message = extractCommitMessage(output);
			expect(message).toBe("fix(parser): handle edge case in tokenizer");
		});

		it("handles code block with empty language hint", () => {
			const output = `\`\`\`
docs: update README with new examples
\`\`\``;

			const message = extractCommitMessage(output);
			expect(message).toBe("docs: update README with new examples");
		});
	});

	describe("conventional commit extraction", () => {
		it("extracts feat commit without code block", () => {
			const output = `Based on the changes, here's an appropriate commit message:

feat(auth): implement OAuth2 login flow

Added support for Google and GitHub OAuth providers.`;

			const message = extractCommitMessage(output);
			expect(message).toContain("feat(auth): implement OAuth2 login flow");
		});

		it("extracts fix commit", () => {
			const output =
				"The appropriate message is: fix(ui): resolve button alignment issue";
			const message = extractCommitMessage(output);
			expect(message).toContain("fix(ui): resolve button alignment issue");
		});

		it("extracts docs commit", () => {
			const output =
				"docs(api): add endpoint documentation\n\nDetailed description here.";
			const message = extractCommitMessage(output);
			expect(message).toContain("docs(api): add endpoint documentation");
		});

		it("extracts refactor commit", () => {
			const output = "refactor(core): simplify data processing pipeline";
			const message = extractCommitMessage(output);
			expect(message).toContain(
				"refactor(core): simplify data processing pipeline",
			);
		});

		it("extracts test commit", () => {
			const output = "test(utils): add unit tests for string helpers";
			const message = extractCommitMessage(output);
			expect(message).toContain(
				"test(utils): add unit tests for string helpers",
			);
		});

		it("extracts chore commit", () => {
			const output = "chore(deps): update dependencies to latest versions";
			const message = extractCommitMessage(output);
			expect(message).toContain(
				"chore(deps): update dependencies to latest versions",
			);
		});
	});

	describe("multi-line commit messages", () => {
		it("preserves body in conventional commit", () => {
			const output = `\`\`\`
feat(pipeline): add code review loop

Implements a single-model review process:
- GPT-5.4 reviews implementation changes
- addressReview applies fixes when needed

Closes #123
\`\`\``;

			const message = extractCommitMessage(output);
			expect(message).toContain("feat(pipeline): add code review loop");
			expect(message).toContain("single-model review process");
			expect(message).toContain("Closes #123");
		});
	});

	describe("fallback behavior", () => {
		it("returns trimmed output when no pattern matches", () => {
			const output = "  Simple commit message  ";
			const message = extractCommitMessage(output);
			expect(message).toBe("Simple commit message");
		});

		it("handles empty output", () => {
			const message = extractCommitMessage("");
			expect(message).toBe("");
		});

		it("handles whitespace-only output", () => {
			const message = extractCommitMessage("   \n\t  ");
			expect(message).toBe("");
		});
	});

	describe("preference for code blocks", () => {
		it("prefers code block over inline conventional commit", () => {
			const output = `feat(ignored): this should be ignored

\`\`\`
fix(actual): this is the real message
\`\`\`

feat(also-ignored): also ignored`;

			const message = extractCommitMessage(output);
			expect(message).toBe("fix(actual): this is the real message");
		});
	});
});

describe("Git file tracking utilities", () => {
	let testDir: string;

	beforeEach(async () => {
		// Create a temporary directory for git operations
		testDir = await mkdtemp(join(tmpdir(), "git-test-"));

		// Initialize git repo
		await execGit(testDir, ["init"]);
		await execGit(testDir, ["config", "user.email", "test@example.com"]);
		await execGit(testDir, ["config", "user.name", "Test User"]);

		// Create initial commit
		await writeFile(join(testDir, "README.md"), "# Test repo\n");
		await execGit(testDir, ["add", "README.md"]);
		await execGit(testDir, ["commit", "-m", "Initial commit"]);
	});

	afterEach(async () => {
		// Clean up test directory
		await rm(testDir, { recursive: true, force: true });
	});

	describe("captureGitStatus", () => {
		it("returns empty string for clean working directory", async () => {
			const status = await captureGitStatus(testDir);
			expect(status).toBe("");
		});

		it("detects modified files", async () => {
			await writeFile(join(testDir, "README.md"), "# Modified content\n");
			const status = await captureGitStatus(testDir);
			expect(status).toContain("M README.md");
		});

		it("detects new files", async () => {
			await writeFile(join(testDir, "new-file.txt"), "New content\n");
			const status = await captureGitStatus(testDir);
			expect(status).toContain("?? new-file.txt");
		});

		it("detects deleted files", async () => {
			await rm(join(testDir, "README.md"));
			const status = await captureGitStatus(testDir);
			expect(status).toContain("D README.md");
		});
	});

	describe("getModifiedFiles", () => {
		it("returns empty array for clean working directory", async () => {
			const files = await getModifiedFiles(testDir);
			expect(files).toEqual([]);
		});

		it("returns modified files", async () => {
			await writeFile(join(testDir, "README.md"), "# Modified content\n");
			const files = await getModifiedFiles(testDir);
			expect(files).toContain("README.md");
		});

		it("returns newly created files", async () => {
			await writeFile(join(testDir, "new-file.txt"), "New content\n");
			const files = await getModifiedFiles(testDir);
			expect(files).toContain("new-file.txt");
		});

		it("handles multiple modified files", async () => {
			await writeFile(join(testDir, "README.md"), "# Modified\n");
			await writeFile(join(testDir, "file1.txt"), "Content 1\n");
			await writeFile(join(testDir, "file2.txt"), "Content 2\n");
			const files = await getModifiedFiles(testDir);
			expect(files).toContain("README.md");
			expect(files).toContain("file1.txt");
			expect(files).toContain("file2.txt");
			expect(files.length).toBe(3);
		});
	});

	describe("getHeadCommit", () => {
		it("returns the current HEAD hash", async () => {
			const head = await getHeadCommit(testDir);
			expect(head).toMatch(/^[0-9a-f]{40}$/);
		});

		it("returns undefined for a non-git directory", async () => {
			const plainDir = await mkdtemp(join(tmpdir(), "not-a-repo-"));
			try {
				const head = await getHeadCommit(plainDir);
				expect(head).toBeUndefined();
			} finally {
				await rm(plainDir, { recursive: true, force: true });
			}
		});

		it("returns undefined for a repo with no commits (unborn HEAD)", async () => {
			const emptyRepo = await mkdtemp(join(tmpdir(), "empty-repo-"));
			try {
				await execGit(emptyRepo, ["init"]);
				const head = await getHeadCommit(emptyRepo);
				expect(head).toBeUndefined();
			} finally {
				await rm(emptyRepo, { recursive: true, force: true });
			}
		});
	});

	describe("getChangedFilesSince", () => {
		it("returns empty array when nothing changed since base", async () => {
			const base = await getHeadCommit(testDir);
			expect(base).toBeDefined();
			const files = await getChangedFilesSince(testDir, base as string);
			expect(files).toEqual([]);
		});

		it("detects uncommitted working tree changes", async () => {
			const base = await getHeadCommit(testDir);
			await writeFile(join(testDir, "README.md"), "# Modified\n");
			const files = await getChangedFilesSince(testDir, base as string);
			expect(files).toContain("README.md");
		});

		it("detects untracked files", async () => {
			const base = await getHeadCommit(testDir);
			await writeFile(join(testDir, "new-file.txt"), "New content\n");
			const files = await getChangedFilesSince(testDir, base as string);
			expect(files).toContain("new-file.txt");
		});

		it("detects changes that the agent committed itself (clean tree)", async () => {
			// Regression: a self-committing implementer leaves a clean working
			// tree, which getModifiedFiles reports as "no changes". Changes must
			// still be detected relative to the pre-run HEAD.
			const base = await getHeadCommit(testDir);
			await writeFile(join(testDir, "feature.txt"), "Implemented\n");
			await writeFile(join(testDir, "README.md"), "# Updated docs\n");
			await execGit(testDir, ["add", "-A"]);
			await execGit(testDir, ["commit", "-m", "feat(x): agent self-commit"]);

			// Sanity: working tree is clean, old detector would see nothing
			expect(await getModifiedFiles(testDir)).toEqual([]);

			const files = await getChangedFilesSince(testDir, base as string);
			expect(files).toContain("feature.txt");
			expect(files).toContain("README.md");
		});

		it("combines committed and uncommitted changes since base", async () => {
			const base = await getHeadCommit(testDir);
			await writeFile(join(testDir, "committed.txt"), "Committed\n");
			await execGit(testDir, ["add", "-A"]);
			await execGit(testDir, ["commit", "-m", "feat(x): partial commit"]);
			await writeFile(join(testDir, "pending.txt"), "Uncommitted\n");

			const files = await getChangedFilesSince(testDir, base as string);
			expect(files).toContain("committed.txt");
			expect(files).toContain("pending.txt");
		});
	});

	describe("stageFiles", () => {
		it("returns true for empty file list", async () => {
			const result = await stageFiles(testDir, []);
			expect(result).toBe(true);
		});

		it("stages specified files only", async () => {
			await writeFile(join(testDir, "file1.txt"), "Content 1\n");
			await writeFile(join(testDir, "file2.txt"), "Content 2\n");

			const result = await stageFiles(testDir, ["file1.txt"]);
			expect(result).toBe(true);

			// Check that only file1.txt is staged
			const statusResult = await execGit(testDir, ["status", "--porcelain"]);
			expect(statusResult.stdout).toContain("A  file1.txt");
			expect(statusResult.stdout).toContain("?? file2.txt");
		});

		it("handles file modifications", async () => {
			await writeFile(join(testDir, "README.md"), "# Modified\n");

			const result = await stageFiles(testDir, ["README.md"]);
			expect(result).toBe(true);

			const statusResult = await execGit(testDir, ["status", "--porcelain"]);
			expect(statusResult.stdout).toContain("M  README.md");
		});

		it("handles file deletions", async () => {
			await rm(join(testDir, "README.md"));

			const result = await stageFiles(testDir, ["README.md"]);
			expect(result).toBe(true);

			const statusResult = await execGit(testDir, ["status", "--porcelain"]);
			expect(statusResult.stdout).toContain("D  README.md");
		});

		it("stages multiple files", async () => {
			await writeFile(join(testDir, "file1.txt"), "Content 1\n");
			await writeFile(join(testDir, "file2.txt"), "Content 2\n");
			await writeFile(join(testDir, "file3.txt"), "Content 3\n");

			const result = await stageFiles(testDir, ["file1.txt", "file2.txt"]);
			expect(result).toBe(true);

			const statusResult = await execGit(testDir, ["status", "--porcelain"]);
			expect(statusResult.stdout).toContain("A  file1.txt");
			expect(statusResult.stdout).toContain("A  file2.txt");
			expect(statusResult.stdout).toContain("?? file3.txt");
		});

		it("stages a staged deletion even when the deleted path is now ignored and reused by an untracked symlink", async () => {
			// Regression: a tracked file is staged for deletion, then the same
			// path becomes gitignored and is reused by an untracked symlink.
			// `git add --all .cache` would fail on the ignored symlink and
			// abort the whole staging operation.
			await writeFile(join(testDir, ".cache"), "cached\n");
			await execGit(testDir, ["add", ".cache"]);
			await execGit(testDir, ["commit", "-m", "add cache"]);

			await execGit(testDir, ["rm", ".cache"]);
			await writeFile(join(testDir, ".gitignore"), ".cache\n");
			// Recreate as a symlink like the catacloud worktree setup script does.
			await execGit(testDir, ["ln", "-s", "/tmp", join(testDir, ".cache")]);

			await writeFile(join(testDir, "README.md"), "# Modified\n");

			const result = await stageFiles(testDir, [".cache", "README.md"]);
			expect(result).toBe(true);

			const statusResult = await execGit(testDir, ["status", "--porcelain"]);
			expect(statusResult.stdout).toContain("D  .cache");
			expect(statusResult.stdout).toContain("M  README.md");
			expect(statusResult.stdout).not.toContain("?? .cache");

			await execGit(testDir, ["commit", "-m", "fix: drop cache and update readme"]);
			const committedFiles = await execGit(testDir, [
				"diff-tree",
				"--no-commit-id",
				"--name-only",
				"-r",
				"HEAD",
			]);
			expect(committedFiles.stdout).toContain(".cache");
			expect(committedFiles.stdout).toContain("README.md");
		});

		it("does not force-add an ignored untracked file", async () => {
			await writeFile(join(testDir, ".gitignore"), "ignored.txt\n");
			await writeFile(join(testDir, "ignored.txt"), "should not be committed\n");
			await writeFile(join(testDir, "tracked.txt"), "should be committed\n");

			const result = await stageFiles(testDir, ["ignored.txt", "tracked.txt"]);
			expect(result).toBe(true);

			const statusResult = await execGit(testDir, ["status", "--porcelain"]);
			expect(statusResult.stdout).not.toContain("ignored.txt");
			expect(statusResult.stdout).toContain("A  tracked.txt");
		});
	});

	describe("hasChangesStaged", () => {
		it("returns false when nothing is staged", async () => {
			const result = await hasChangesStaged(testDir);
			expect(result).toBe(false);
		});

		it("returns false when files are modified but not staged", async () => {
			await writeFile(join(testDir, "README.md"), "# Modified\n");
			const result = await hasChangesStaged(testDir);
			expect(result).toBe(false);
		});

		it("returns true when files are staged", async () => {
			await writeFile(join(testDir, "new-file.txt"), "New content\n");
			await execGit(testDir, ["add", "new-file.txt"]);

			const result = await hasChangesStaged(testDir);
			expect(result).toBe(true);
		});

		it("returns true after staging modifications", async () => {
			await writeFile(join(testDir, "README.md"), "# Modified\n");
			await execGit(testDir, ["add", "README.md"]);

			const result = await hasChangesStaged(testDir);
			expect(result).toBe(true);
		});

		it("returns true after staging deletions", async () => {
			await rm(join(testDir, "README.md"));
			await execGit(testDir, ["add", "README.md"]);

			const result = await hasChangesStaged(testDir);
			expect(result).toBe(true);
		});
	});

	describe("Stash operations", () => {
		it("stashChanges returns stash reference when changes exist", async () => {
			// Create some changes
			await writeFile(join(testDir, "README.md"), "# Modified\n");
			await writeFile(join(testDir, "new-file.txt"), "New content\n");

			const timestamp = Date.now().toString();
			const stashRef = await stashChanges(testDir, timestamp);

			expect(stashRef).not.toBeNull();
			expect(stashRef).toMatch(/^stash@\{\d+\}$/);

			// Verify working directory is clean after stash
			const status = await captureGitStatus(testDir);
			expect(status).toBe("");
		});

		it("stashChanges returns null when no changes exist", async () => {
			const timestamp = Date.now().toString();
			const stashRef = await stashChanges(testDir, timestamp);

			expect(stashRef).toBeNull();
		});

		it("stashChanges includes untracked files", async () => {
			// Create an untracked file
			await writeFile(join(testDir, "untracked.txt"), "Untracked content\n");

			const timestamp = Date.now().toString();
			const stashRef = await stashChanges(testDir, timestamp);

			expect(stashRef).not.toBeNull();

			// Verify untracked file is stashed
			const status = await captureGitStatus(testDir);
			expect(status).toBe("");
		});

		it("stashChanges creates stash with identifiable message", async () => {
			await writeFile(join(testDir, "test.txt"), "Test\n");

			const timestamp = Date.now().toString();
			const stashRef = await stashChanges(testDir, timestamp);

			expect(stashRef).not.toBeNull();

			// Verify stash message
			const listResult = await execGit(testDir, ["stash", "list"]);
			expect(listResult.stdout).toContain(`spec-pipeline-error-${timestamp}`);
		});

		it("dropStash successfully drops existing stash", async () => {
			// Create a stash
			await writeFile(join(testDir, "test.txt"), "Test\n");
			const timestamp = Date.now().toString();
			const stashRef = await stashChanges(testDir, timestamp);

			expect(stashRef).not.toBeNull();

			// Drop the stash
			const result = await dropStash(testDir, stashRef!);
			expect(result).toBe(true);

			// Verify stash is gone
			const listResult = await execGit(testDir, ["stash", "list"]);
			expect(listResult.stdout).not.toContain(stashRef!);
		});

		it("dropStash returns false for non-existent stash", async () => {
			const result = await dropStash(testDir, "stash@{999}");
			expect(result).toBe(false);
		});

		it("stashExists returns true for existing stash", async () => {
			// Create a stash
			await writeFile(join(testDir, "test.txt"), "Test\n");
			const timestamp = Date.now().toString();
			const stashRef = await stashChanges(testDir, timestamp);

			expect(stashRef).not.toBeNull();

			// Check if it exists
			const exists = await stashExists(testDir, stashRef!);
			expect(exists).toBe(true);
		});

		it("stashExists returns false for non-existent stash", async () => {
			const exists = await stashExists(testDir, "stash@{999}");
			expect(exists).toBe(false);
		});

		it("integration: stash → drop workflow", async () => {
			// Create changes
			await writeFile(join(testDir, "README.md"), "# Modified\n");
			await writeFile(join(testDir, "new-file.txt"), "New content\n");

			// Stash changes
			const timestamp = Date.now().toString();
			const stashRef = await stashChanges(testDir, timestamp);
			expect(stashRef).not.toBeNull();

			// Verify stash exists
			const exists1 = await stashExists(testDir, stashRef!);
			expect(exists1).toBe(true);

			// Working directory should be clean
			const status = await captureGitStatus(testDir);
			expect(status).toBe("");

			// Drop stash
			const dropped = await dropStash(testDir, stashRef!);
			expect(dropped).toBe(true);

			// Verify stash no longer exists
			const exists2 = await stashExists(testDir, stashRef!);
			expect(exists2).toBe(false);
		});

		it("handles multiple stashes correctly", async () => {
			// Create first stash
			await writeFile(join(testDir, "file1.txt"), "Content 1\n");
			const stashRef1 = await stashChanges(testDir, "timestamp1");
			expect(stashRef1).not.toBeNull();
			expect(stashRef1).toBe("stash@{0}");

			// Create second stash
			await writeFile(join(testDir, "file2.txt"), "Content 2\n");
			const stashRef2 = await stashChanges(testDir, "timestamp2");
			expect(stashRef2).not.toBeNull();
			expect(stashRef2).toBe("stash@{0}");

			// Verify both stashes exist in the list
			const listResult = await execGit(testDir, ["stash", "list"]);
			expect(listResult.stdout).toContain("timestamp1");
			expect(listResult.stdout).toContain("timestamp2");

			// The first stash has shifted to stash@{1}
			expect(await stashExists(testDir, "stash@{0}")).toBe(true); // timestamp2
			expect(await stashExists(testDir, "stash@{1}")).toBe(true); // timestamp1

			// Note: stash@{N} references are positional and shift when new stashes are added
			// This is expected git behavior - stash references should be used immediately
		});
	});

	describe("Error recovery operations", () => {
		it("resetToHead discards all uncommitted changes", async () => {
			// Create some uncommitted changes
			await writeFile(join(testDir, "README.md"), "# Modified content\n");
			await writeFile(join(testDir, "new-file.txt"), "New file\n");

			// Verify changes exist
			const statusBefore = await captureGitStatus(testDir);
			expect(statusBefore).not.toBe("");

			// Reset to HEAD
			const result = await resetToHead(testDir);
			expect(result).toBe(true);

			// Verify working directory is clean
			const statusAfter = await captureGitStatus(testDir);
			expect(statusAfter).toBe("");
		});

		it("resetToHead removes untracked files", async () => {
			// Create untracked files
			await writeFile(join(testDir, "untracked.txt"), "Untracked content\n");
			await mkdir(join(testDir, "untracked-dir"), { recursive: true });
			await writeFile(join(testDir, "untracked-dir/file.txt"), "Content\n");

			// Verify untracked files exist
			const statusBefore = await captureGitStatus(testDir);
			expect(statusBefore).toContain("untracked.txt");

			// Reset to HEAD
			const result = await resetToHead(testDir);
			expect(result).toBe(true);

			// Verify untracked files are gone
			const statusAfter = await captureGitStatus(testDir);
			expect(statusAfter).toBe("");
		});

		it("resetToHead handles modified tracked files", async () => {
			// Modify existing tracked file
			await writeFile(
				join(testDir, "README.md"),
				"# Completely different content\n",
			);

			// Verify modification exists
			const modifiedBefore = await getModifiedFiles(testDir);
			expect(modifiedBefore).toContain("README.md");

			// Reset to HEAD
			const result = await resetToHead(testDir);
			expect(result).toBe(true);

			// Verify file is restored to original state
			const modifiedAfter = await getModifiedFiles(testDir);
			expect(modifiedAfter).toHaveLength(0);
		});

		it("resetToHead handles staged changes", async () => {
			// Create and stage changes
			await writeFile(join(testDir, "new-file.txt"), "Staged content\n");
			await execGit(testDir, ["add", "new-file.txt"]);

			// Verify changes are staged
			const stagedBefore = await hasChangesStaged(testDir);
			expect(stagedBefore).toBe(true);

			// Reset to HEAD
			const result = await resetToHead(testDir);
			expect(result).toBe(true);

			// Verify no staged changes remain
			const stagedAfter = await hasChangesStaged(testDir);
			expect(stagedAfter).toBe(false);

			// Verify working directory is clean
			const status = await captureGitStatus(testDir);
			expect(status).toBe("");
		});

		it("resetToHead is idempotent on clean directory", async () => {
			// Ensure directory is clean
			const statusBefore = await captureGitStatus(testDir);
			expect(statusBefore).toBe("");

			// Reset to HEAD
			const result = await resetToHead(testDir);
			expect(result).toBe(true);

			// Verify still clean
			const statusAfter = await captureGitStatus(testDir);
			expect(statusAfter).toBe("");
		});

		it("integration: stash → reset workflow (error recovery)", async () => {
			// Simulate agent making changes that fail
			await writeFile(join(testDir, "README.md"), "# Failed changes\n");
			await writeFile(join(testDir, "broken.txt"), "This didn't work\n");

			// Step 1: Stash the failed changes
			const timestamp = Date.now().toString();
			const stashRef = await stashChanges(testDir, timestamp);
			expect(stashRef).not.toBeNull();

			// Working directory should be clean after stash
			const statusAfterStash = await captureGitStatus(testDir);
			expect(statusAfterStash).toBe("");

			// Step 2: Reset to ensure clean state (defensive)
			const resetResult = await resetToHead(testDir);
			expect(resetResult).toBe(true);

			// Verify still clean
			const statusAfterReset = await captureGitStatus(testDir);
			expect(statusAfterReset).toBe("");

			// Step 3: Verify stash still exists
			const stashStillExists = await stashExists(testDir, stashRef!);
			expect(stashStillExists).toBe(true);

			// Step 4: On successful retry, drop the stash
			const dropped = await dropStash(testDir, stashRef!);
			expect(dropped).toBe(true);
		});
	});

	describe("integration: file tracking workflow", () => {
		it("tracks files modified by agent simulation", async () => {
			// Capture status before "agent" runs
			const beforeStatus = await captureGitStatus(testDir);
			expect(beforeStatus).toBe("");

			// Simulate agent modifying files
			await writeFile(join(testDir, "README.md"), "# Agent modified\n");
			await writeFile(
				join(testDir, "new-feature.ts"),
				"export const feature = true;\n",
			);
			await mkdir(join(testDir, "src"), { recursive: true });
			await writeFile(
				join(testDir, "src/utils.ts"),
				"export const util = () => {};\n",
			);

			// Get modified files
			const modifiedFiles = await getModifiedFiles(testDir);
			expect(modifiedFiles).toContain("README.md");
			expect(modifiedFiles).toContain("new-feature.ts");
			expect(modifiedFiles).toContain("src/utils.ts");

			// Stage only those files
			const stageResult = await stageFiles(testDir, modifiedFiles);
			expect(stageResult).toBe(true);

			// Verify changes are staged
			const hasChanges = await hasChangesStaged(testDir);
			expect(hasChanges).toBe(true);

			// Verify we can commit
			const commitResult = await execGit(testDir, [
				"commit",
				"-m",
				"Agent changes",
			]);
			expect(commitResult.code).toBe(0);

			// After commit, working directory should be clean
			const afterFiles = await getModifiedFiles(testDir);
			expect(afterFiles).toEqual([]);
		});

		it("handles scenario where agent makes no changes", async () => {
			// Simulate agent running but making no changes
			const modifiedFiles = await getModifiedFiles(testDir);
			expect(modifiedFiles).toEqual([]);

			// Try to stage (should succeed with empty list)
			const stageResult = await stageFiles(testDir, modifiedFiles);
			expect(stageResult).toBe(true);

			// No changes staged
			const hasChanges = await hasChangesStaged(testDir);
			expect(hasChanges).toBe(false);
		});
	});

	describe("scoped commits (dirty tree support)", () => {
		it("commits only scoped files while leaving other dirty files untouched", async () => {
			// Simulate a dirty working tree (e.g. implementation in progress)
			await writeFile(join(testDir, "src-file.ts"), "implementation code\n");
			await writeFile(join(testDir, "another-dirty.ts"), "more dirty code\n");

			// Simulate doc pipeline writing a spec file
			await mkdir(join(testDir, "specs"), { recursive: true });
			await writeFile(join(testDir, "specs/my-spec.md"), "# My Spec\n");

			// Stage and commit only the spec file (scoped)
			const scopeFiles = ["specs/my-spec.md"];
			const allModified = await getModifiedFiles(testDir);
			const allModifiedSet = new Set(allModified);
			const filesToCommit = scopeFiles.filter((f) => allModifiedSet.has(f));

			expect(filesToCommit).toEqual(["specs/my-spec.md"]);

			const stageResult = await stageFiles(testDir, filesToCommit);
			expect(stageResult).toBe(true);

			const commitResult = await execGit(testDir, [
				"commit",
				"-m",
				"docs: add spec",
			]);
			expect(commitResult.code).toBe(0);

			// Verify the dirty files are still uncommitted
			const remainingModified = await getModifiedFiles(testDir);
			expect(remainingModified).toContain("src-file.ts");
			expect(remainingModified).toContain("another-dirty.ts");
			expect(remainingModified).not.toContain("specs/my-spec.md");
		});

		it("skips commit when scoped file is not in modified files", async () => {
			// Dirty tree with unrelated changes
			await writeFile(join(testDir, "dirty.ts"), "dirty code\n");

			// The spec file doesn't exist / wasn't modified
			const scopeFiles = ["specs/nonexistent.md"];
			const allModified = await getModifiedFiles(testDir);
			const allModifiedSet = new Set(allModified);
			const filesToCommit = scopeFiles.filter((f) => allModifiedSet.has(f));

			expect(filesToCommit).toEqual([]);

			// Nothing to stage or commit
			const hasChanges = await hasChangesStaged(testDir);
			expect(hasChanges).toBe(false);

			// Dirty file is still there
			const remaining = await getModifiedFiles(testDir);
			expect(remaining).toContain("dirty.ts");
		});

		it("handles multiple scoped files", async () => {
			// Create dirty unrelated files
			await writeFile(join(testDir, "unrelated.ts"), "unrelated\n");

			// Create scoped files
			await mkdir(join(testDir, "specs"), { recursive: true });
			await writeFile(join(testDir, "specs/spec.md"), "# Spec\n");
			await writeFile(join(testDir, "specs/appendix.md"), "# Appendix\n");

			const scopeFiles = ["specs/spec.md", "specs/appendix.md"];
			const allModified = await getModifiedFiles(testDir);
			const allModifiedSet = new Set(allModified);
			const filesToCommit = scopeFiles.filter((f) => allModifiedSet.has(f));

			expect(filesToCommit).toHaveLength(2);
			expect(filesToCommit).toContain("specs/spec.md");
			expect(filesToCommit).toContain("specs/appendix.md");

			const stageResult = await stageFiles(testDir, filesToCommit);
			expect(stageResult).toBe(true);

			const commitResult = await execGit(testDir, [
				"commit",
				"-m",
				"docs: add specs",
			]);
			expect(commitResult.code).toBe(0);

			// Unrelated file still dirty
			const remaining = await getModifiedFiles(testDir);
			expect(remaining).toContain("unrelated.ts");
			expect(remaining).not.toContain("specs/spec.md");
			expect(remaining).not.toContain("specs/appendix.md");
		});
	});
});

// ============================================
// handleAgentError root splitting (Phase 3 / FR-4.1, FR-4.2)
// ============================================

describe("handleAgentError split roots", () => {
	let projectRoot: string;
	let workRoot: string;

	async function initRepo(dir: string): Promise<void> {
		await execGit(dir, ["init"]);
		await execGit(dir, ["config", "user.email", "test@example.com"]);
		await execGit(dir, ["config", "user.name", "Test User"]);
		await writeFile(join(dir, "README.md"), "# Test repo\n");
		await execGit(dir, ["add", "README.md"]);
		await execGit(dir, ["commit", "-m", "Initial commit"]);
	}

	beforeEach(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "errors-project-"));
		workRoot = await mkdtemp(join(tmpdir(), "errors-work-"));
		await initRepo(projectRoot);
		await initRepo(workRoot);
	});

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
		await rm(workRoot, { recursive: true, force: true });
	});

	it("stashes/resets in workRoot but writes the error log under projectRoot", async () => {
		// Dirty the worktree so there is something to stash
		await writeFile(join(workRoot, "dirty.txt"), "uncommitted work\n");

		const state = { id: "impl-test-id" } as ImplementationState;
		const result: AgentResult = {
			exitCode: 1,
			output: "",
			error: "agent blew up",
			completed: false,
		};

		await handleAgentError(
			projectRoot,
			workRoot,
			state,
			result,
			"gpt-5",
			"implementer",
			"do the thing",
			1,
			1,
			() => {},
		);

		// Error log lives under projectRoot, NOT workRoot (FR-4.2)
		const projectLog = join(
			projectRoot,
			".pi/spec-pipeline",
			"impl-test-id.error.log",
		);
		const workLog = join(
			workRoot,
			".pi/spec-pipeline",
			"impl-test-id.error.log",
		);
		expect(existsSync(projectLog)).toBe(true);
		expect(existsSync(workLog)).toBe(false);

		// Destructive ops happened in workRoot (FR-4.1): stash created, tree reset
		expect(state.errorStash).toBeTruthy();
		const workStatus = await execGit(workRoot, ["status", "--porcelain"]);
		expect(workStatus.stdout).toBe("");
		const workStash = await execGit(workRoot, ["stash", "list"]);
		expect(workStash.stdout).toContain("spec-pipeline-error-");

		// projectRoot was never touched by the destructive ops
		const projectStash = await execGit(projectRoot, ["stash", "list"]);
		expect(projectStash.stdout).toBe("");
	});
});
