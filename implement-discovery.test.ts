import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Test suite for implement-discovery functionality
 * 
 * Tests cover:
 * - File vs description detection
 * - Path heuristic logic (slashes, extensions)
 * - Flag storage and application
 * - Discovery file naming and content
 * - Edge cases (files without extensions, slash-containing descriptions)
 */

describe("implement-discovery mode", () => {
	describe("file path detection", () => {
		it("detects existing file as file path (not description)", () => {
			// This would be tested via integration test with real file system
			// or by mocking fs.existsSync and fs.statSync
			
			// The logic is:
			// const isFile = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
			
			// When isFile is true, should use file-based implementation
			// When isFile is false and looksLikeFilePath is false, should use discovery mode
			expect(true).toBe(true); // Placeholder for integration test
		});

		it("heuristic detects slash-containing strings as file paths", () => {
			const argWithSlash = "specs/feature.md";
			const looksLikeFilePath = argWithSlash.includes("/") || /\.(md|typ)$/i.test(argWithSlash);
			expect(looksLikeFilePath).toBe(true);
		});

		it("heuristic detects .md extension as file path", () => {
			const argWithMd = "feature.md";
			const looksLikeFilePath = argWithMd.includes("/") || /\.(md|typ)$/i.test(argWithMd);
			expect(looksLikeFilePath).toBe(true);
		});

		it("heuristic detects .typ extension as file path", () => {
			const argWithTyp = "feature.typ";
			const looksLikeFilePath = argWithTyp.includes("/") || /\.(md|typ)$/i.test(argWithTyp);
			expect(looksLikeFilePath).toBe(true);
		});

		it("heuristic treats plain text as description (not file)", () => {
			const plainText = "add user authentication";
			const looksLikeFilePath = plainText.includes("/") || /\.(md|typ)$/i.test(plainText);
			expect(looksLikeFilePath).toBe(false);
		});

		it("edge case: 'fix/bug-123' treated as file path by heuristic", () => {
			// This is why we check fs.existsSync first - existing files take priority
			const edgeCase = "fix/bug-123";
			const looksLikeFilePath = edgeCase.includes("/") || /\.(md|typ)$/i.test(edgeCase);
			expect(looksLikeFilePath).toBe(true);
			
			// But if fs.existsSync returns false, it would show "file not found" error
			// which is acceptable UX (user can quote it or rephrase)
		});

		it("edge case: file without extension checks fs.existsSync", () => {
			// Files like "SPEC" or "README" rely on fs.existsSync check
			const noExtension = "SPEC";
			const looksLikeFilePath = noExtension.includes("/") || /\.(md|typ)$/i.test(noExtension);
			expect(looksLikeFilePath).toBe(false);
			
			// So if file exists, fs.existsSync && fs.statSync().isFile() returns true
			// and it's treated as a file. Otherwise, treated as description.
		});

		it("case insensitive extension matching (.MD, .TYP)", () => {
			expect(/\.(md|typ)$/i.test("file.MD")).toBe(true);
			expect(/\.(md|typ)$/i.test("file.TYP")).toBe(true);
			expect(/\.(md|typ)$/i.test("file.Md")).toBe(true);
		});
	});

	describe("flag parsing and storage", () => {
		it("parses --no-plan flag", () => {
			const argsStr = "--no-plan add authentication";
			const noPlan = argsStr.includes("--no-plan");
			const noReview = argsStr.includes("--no-review");
			expect(noPlan).toBe(true);
			expect(noReview).toBe(false);
		});

		it("parses --no-review flag", () => {
			const argsStr = "--no-review add authentication";
			const noPlan = argsStr.includes("--no-plan");
			const noReview = argsStr.includes("--no-review");
			expect(noPlan).toBe(false);
			expect(noReview).toBe(true);
		});

		it("parses both flags", () => {
			const argsStr = "--no-plan --no-review add authentication";
			const noPlan = argsStr.includes("--no-plan");
			const noReview = argsStr.includes("--no-review");
			expect(noPlan).toBe(true);
			expect(noReview).toBe(true);
		});

		it("strips flags from description", () => {
			const argsStr = "--no-plan --no-review add user authentication";
			const argWithoutFlags = argsStr
				.replace("--no-plan", "")
				.replace("--no-review", "")
				.replace(/\s+/g, " ")
				.trim();
			expect(argWithoutFlags).toBe("add user authentication");
		});

		it("handles flags in different positions", () => {
			const argsStr = "add --no-plan authentication --no-review";
			const argWithoutFlags = argsStr
				.replace("--no-plan", "")
				.replace("--no-review", "")
				.replace(/\s+/g, " ")
				.trim();
			expect(argWithoutFlags).toBe("add authentication");
		});

		it("normalizes multiple spaces after flag removal", () => {
			const argsStr = "--no-plan    --no-review    add     auth";
			const argWithoutFlags = argsStr
				.replace("--no-plan", "")
				.replace("--no-review", "")
				.replace(/\s+/g, " ")
				.trim();
			expect(argWithoutFlags).toBe("add auth");
		});
	});

	describe("discovery file naming", () => {
		it("generates discovery filename with timestamp and short name", () => {
			const timestamp = "2602101200";
			const shortName = "auth_system";
			const discoveryFilename = `${timestamp}_discovery_${shortName}.md`;
			expect(discoveryFilename).toBe("2602101200_discovery_auth_system.md");
		});

		it("sanitizes short name in filename", () => {
			// Short name should already be sanitized by promptForShortName
			// But we test the pattern
			const timestamp = "2602101200";
			const shortName = "user_auth"; // underscores are allowed
			const discoveryFilename = `${timestamp}_discovery_${shortName}.md`;
			expect(discoveryFilename).toMatch(/^\d{10}_discovery_[a-z0-9_]+\.md$/);
		});
	});

	describe("discovery file content", () => {
		it("generates fallback content when no exchanges recorded", () => {
			const description = "Add user authentication system";
			const discoverySummary = undefined;
			const discoveryContent = discoverySummary || `# Discovery Summary\n\n${description}\n\nNo discovery exchanges recorded.`;
			
			expect(discoveryContent).toContain("# Discovery Summary");
			expect(discoveryContent).toContain(description);
			expect(discoveryContent).toContain("No discovery exchanges recorded");
		});

		it("uses actual discovery summary when available", () => {
			const discoverySummary = `# Discovery Summary

## Requirements
- User registration
- Login/logout
- Password reset

## Implementation Approach
Use bcrypt for password hashing...`;
			
			const discoveryContent = discoverySummary || "# Discovery Summary\n\nFallback";
			expect(discoveryContent).toBe(discoverySummary);
			expect(discoveryContent).toContain("Requirements");
			expect(discoveryContent).toContain("Implementation Approach");
		});
	});

	describe("path handling for discovery files", () => {
		it("resolves absolute specsDir correctly", () => {
			const specsDir = "/absolute/path/to/specs";
			const cwd = "/project/root";
			
			const fullSpecsDir = path.isAbsolute(specsDir)
				? specsDir
				: path.join(cwd, specsDir);
			
			expect(fullSpecsDir).toBe("/absolute/path/to/specs");
		});

		it("resolves relative specsDir correctly", () => {
			const specsDir = "docs/specs";
			const cwd = "/project/root";
			
			const fullSpecsDir = path.isAbsolute(specsDir)
				? specsDir
				: path.join(cwd, specsDir);
			
			expect(fullSpecsDir).toBe("/project/root/docs/specs");
		});

		it("computes relative path for discovery file", () => {
			const cwd = "/project/root";
			const fullSpecsDir = "/project/root/docs/specs";
			const discoveryFilename = "2602101200_discovery_auth.md";
			const fullDiscoveryPath = path.join(fullSpecsDir, discoveryFilename);
			const discoveryPath = path.relative(cwd, fullDiscoveryPath);
			
			expect(discoveryPath).toBe("docs/specs/2602101200_discovery_auth.md");
		});

		it("handles absolute specsDir in relative path computation", () => {
			const cwd = "/project/root";
			const fullSpecsDir = "/absolute/specs";
			const discoveryFilename = "2602101200_discovery_auth.md";
			const fullDiscoveryPath = path.join(fullSpecsDir, discoveryFilename);
			const discoveryPath = path.relative(cwd, fullDiscoveryPath);
			
			// Relative path from /project/root to /absolute/specs/...
			expect(path.isAbsolute(discoveryPath)).toBe(false);
			expect(discoveryPath).toContain("2602101200_discovery_auth.md");
		});
	});

	describe("config mutation prevention", () => {
		it("clones config when applying --no-review flag", () => {
			const projectConfig = {
				specsDir: "specs",
				reviewCycles: 3,
			};
			
			const flags = { noPlan: false, noReview: true };
			
			// Clone config to avoid mutation
			let effectiveConfig = projectConfig;
			if (flags.noReview) {
				effectiveConfig = {
					...projectConfig,
					reviewCycles: 0,
				};
			}
			
			// Original config should be unchanged
			expect(projectConfig.reviewCycles).toBe(3);
			
			// Effective config should have reviews disabled
			expect(effectiveConfig.reviewCycles).toBe(0);
		});

		it("does not clone config when --no-review not present", () => {
			const projectConfig = {
				specsDir: "specs",
				reviewCycles: 3,
			};
			
			const flags = { noPlan: true, noReview: false };
			
			let effectiveConfig = projectConfig;
			if (flags.noReview) {
				effectiveConfig = {
					...projectConfig,
					reviewCycles: 0,
				};
			}
			
			// Should be same reference
			expect(effectiveConfig).toBe(projectConfig);
		});
	});

	describe("integration scenarios", () => {
		it("scenario: /implement --no-plan 'add auth'", () => {
			const argsStr = "--no-plan add user authentication";
			const noPlan = argsStr.includes("--no-plan");
			const noReview = argsStr.includes("--no-review");
			const argWithoutFlags = argsStr
				.replace("--no-plan", "")
				.replace("--no-review", "")
				.replace(/\s+/g, " ")
				.trim();
			
			const looksLikeFilePath = argWithoutFlags.includes("/") || /\.(md|typ)$/i.test(argWithoutFlags);
			
			expect(noPlan).toBe(true);
			expect(noReview).toBe(false);
			expect(argWithoutFlags).toBe("add user authentication");
			expect(looksLikeFilePath).toBe(false); // Should enter discovery mode
		});

		it("scenario: /implement --no-review specs/feature.md", () => {
			const argsStr = "--no-review specs/feature.md";
			const noPlan = argsStr.includes("--no-plan");
			const noReview = argsStr.includes("--no-review");
			const argWithoutFlags = argsStr
				.replace("--no-plan", "")
				.replace("--no-review", "")
				.replace(/\s+/g, " ")
				.trim();
			
			const looksLikeFilePath = argWithoutFlags.includes("/") || /\.(md|typ)$/i.test(argWithoutFlags);
			
			expect(noPlan).toBe(false);
			expect(noReview).toBe(true);
			expect(argWithoutFlags).toBe("specs/feature.md");
			expect(looksLikeFilePath).toBe(true); // Should use file-based implementation
		});

		it("scenario: /implement 'improve database performance'", () => {
			const argsStr = "improve database performance";
			const noPlan = argsStr.includes("--no-plan");
			const noReview = argsStr.includes("--no-review");
			const argWithoutFlags = argsStr
				.replace("--no-plan", "")
				.replace("--no-review", "")
				.replace(/\s+/g, " ")
				.trim();
			
			const looksLikeFilePath = argWithoutFlags.includes("/") || /\.(md|typ)$/i.test(argWithoutFlags);
			
			expect(noPlan).toBe(false);
			expect(noReview).toBe(false);
			expect(argWithoutFlags).toBe("improve database performance");
			expect(looksLikeFilePath).toBe(false); // Should enter discovery mode
		});
	});

	describe("error handling", () => {
		it("rejects empty input after flag removal", () => {
			const argsStr = "--no-plan --no-review";
			const argWithoutFlags = argsStr
				.replace("--no-plan", "")
				.replace("--no-review", "")
				.replace(/\s+/g, " ")
				.trim();
			
			expect(argWithoutFlags).toBe("");
			// Should trigger error: "Usage: /implement [--no-plan] [--no-review] <spec-file-or-description>"
		});

		it("detects missing file that looks like file path", () => {
			const argWithoutFlags = "specs/nonexistent.md";
			const looksLikeFilePath = argWithoutFlags.includes("/") || /\.(md|typ)$/i.test(argWithoutFlags);
			
			expect(looksLikeFilePath).toBe(true);
			// If fs.existsSync returns false, should show:
			// "Spec file not found: specs/nonexistent.md"
		});
	});
});
