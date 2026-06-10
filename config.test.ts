import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	validateConfig,
	formatValidationErrors,
	DEFAULT_MODEL_CONFIGS,
	DEFAULT_REVIEW_CYCLES,
	DEFAULT_ESCALATION,
	DEFAULT_WORKTREE_BASE_PATH,
	loadPipelineConfig,
	getEscalatedModelConfig,
} from "./config.ts";
import type { ProjectConfig, ModelConfig } from "./types.ts";

describe("validateConfig", () => {
	describe("valid configurations", () => {
		it("accepts empty config", () => {
			expect(validateConfig({})).toEqual([]);
		});

		it("accepts minimal valid config", () => {
			const config = {
				testCommand: "npm test",
			};
			expect(validateConfig(config)).toEqual([]);
		});

		it("accepts full valid config", () => {
			const config = {
				testCommand: "npm test",
				contextFiles: ["README.md", "CONTRIBUTING.md"],
				models: {
					planDrafter: { model: "gpt-5.5", thinking: "high" },
					implementer: { model: "gpt-5.5", thinking: "high" },
					codeReviewer: { model: "gpt-5.4", thinking: "medium" },
				},
				reviewCycles: 2,
			};
			expect(validateConfig(config)).toEqual([]);
		});

		it("accepts null testCommand", () => {
			const config = {
				testCommand: null,
			};
			expect(validateConfig(config)).toEqual([]);
		});

		it("accepts review cycle count", () => {
			const config = {
				reviewCycles: 3,
			};
			expect(validateConfig(config)).toEqual([]);
		});

		it("accepts commitMessageWriter in config (silently ignored)", () => {
			const config = {
				models: {
					commitMessageWriter: { model: "gpt-5.4-mini", thinking: "off" },
				},
			};
			expect(validateConfig(config)).toEqual([]);
		});

		it("accepts skipPlanGeneration boolean", () => {
			const config = {
				skipPlanGeneration: true,
			};
			expect(validateConfig(config)).toEqual([]);
		});

		it("accepts skipPlanGeneration false", () => {
			const config = {
				skipPlanGeneration: false,
			};
			expect(validateConfig(config)).toEqual([]);
		});

		// FR-7.4 / NFR-3: configs containing removed planning fields must still
		// validate cleanly (retain-and-ignore unknown properties).
		it("silently accepts removed planning fields (retain-and-ignore)", () => {
			const config = {
				specsDir: "docs/specs",
				specTemplate: "docs/TEMPLATE.md",
				specTemplatePath: "docs/TEMPLATE.md",
				specConventionsPath: "docs/guide_specs.md",
				specFormat: "typ",
				models: {
					roadmapDrafter: { model: "gpt-5.5", thinking: "high" },
					roadmapReviewer: { model: "gpt-5.4", thinking: "medium" },
					epicDrafter: { model: "gpt-5.5", thinking: "high" },
					epicReviewer: { model: "gpt-5.4", thinking: "medium" },
				},
			};
			expect(validateConfig(config)).toEqual([]);
		});
	});

	describe("invalid configurations", () => {
		it("accepts any model name string", () => {
			const config = {
				models: {
					implementer: { model: "gpt-4", thinking: "high" },
				},
			};
			const errors = validateConfig(config);
			expect(errors).toEqual([]);
		});

		it("rejects invalid thinking level", () => {
			const config = {
				models: {
					implementer: { model: "opus", thinking: "extreme" },
				},
			};
			const errors = validateConfig(config);
			expect(errors.length).toBeGreaterThan(0);
		});

		// Note: Due to TypeBox Union + optional properties behavior, reviewCycles
		// validation is lenient. The Union matches whichever variant accepts the value,
		// and extra properties are ignored by default. This means invalid cycle values
		// may pass validation but will be normalized to defaults at runtime.
		// This is acceptable because the config normalization handles edge cases.

		it("rejects non-array contextFiles", () => {
			const config = {
				contextFiles: "README.md",
			};
			const errors = validateConfig(config);
			expect(errors.length).toBeGreaterThan(0);
		});
	});
});

describe("formatValidationErrors", () => {
	it("formats single error", () => {
		const errors = [{ path: "/specsDir", message: "Expected string" }];
		const formatted = formatValidationErrors(errors);
		expect(formatted).toContain("Invalid spec-pipeline configuration");
		expect(formatted).toContain("/specsDir");
		expect(formatted).toContain("Expected string");
	});

	it("formats multiple errors", () => {
		const errors = [
			{ path: "/specsDir", message: "Expected string" },
			{ path: "/models/planDrafter/model", message: "Invalid model" },
		];
		const formatted = formatValidationErrors(errors);
		expect(formatted).toContain("/specsDir");
		expect(formatted).toContain("/models/planDrafter/model");
	});

	it("handles root-level errors", () => {
		const errors = [{ path: "", message: "Expected object" }];
		const formatted = formatValidationErrors(errors);
		expect(formatted).toContain("root");
	});

	it("includes fix suggestion", () => {
		const errors = [{ path: "/specsDir", message: "Error" }];
		const formatted = formatValidationErrors(errors);
		expect(formatted).toContain(".pi/spec-pipeline.json");
	});
});

describe("default configurations", () => {
	describe("DEFAULT_MODEL_CONFIGS", () => {
		it("has planDrafter config", () => {
			expect(DEFAULT_MODEL_CONFIGS.planDrafter).toBeDefined();
			expect(DEFAULT_MODEL_CONFIGS.planDrafter.model).toBe("gpt-5.5");
		});

		it("has implementer config", () => {
			expect(DEFAULT_MODEL_CONFIGS.implementer).toBeDefined();
			expect(DEFAULT_MODEL_CONFIGS.implementer.model).toBe("gpt-5.5");
		});

		it("has codeReviewer config", () => {
			expect(DEFAULT_MODEL_CONFIGS.codeReviewer).toBeDefined();
			expect(DEFAULT_MODEL_CONFIGS.codeReviewer.model).toBe("gpt-5.4");
		});

		it("has addressReview config", () => {
			expect(DEFAULT_MODEL_CONFIGS.addressReview).toBeDefined();
			expect(DEFAULT_MODEL_CONFIGS.addressReview.model).toBe("gpt-5.4");
		});

		it("has agentCommitMessageWriter config", () => {
			expect(DEFAULT_MODEL_CONFIGS.agentCommitMessageWriter).toBeDefined();
			expect(DEFAULT_MODEL_CONFIGS.agentCommitMessageWriter.model).toBe(
				"gpt-5.4-mini",
			);
		});
	});

	describe("DEFAULT_REVIEW_CYCLES", () => {
		it("defaults code review to 2 cycles", () => {
			expect(DEFAULT_REVIEW_CYCLES).toBe(2);
		});
	});
});

// ============================================
// Tier-aware model resolution
// ============================================

describe("tier-aware model resolution (mergeWithDefaults via loadPipelineConfig)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-tiers-test-"));
		fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeConfig(config: object): void {
		fs.writeFileSync(
			path.join(tmpDir, ".pi", "spec-pipeline.json"),
			JSON.stringify(config),
			"utf-8",
		);
	}

	function loadConfig(): ProjectConfig {
		const result = loadPipelineConfig(tmpDir);
		if (!result.success) throw new Error((result as any).error);
		return (result as any).config;
	}

	it("tiers.mid is used for implementer when models.implementer is absent", () => {
		writeConfig({
			tiers: { mid: { model: "mid-tier-model", thinking: "medium" } },
		});
		const config = loadConfig();
		expect(config.models.implementer.model).toBe("mid-tier-model");
		expect(config.models.implementer.thinking).toBe("medium");
	});

	it("explicit models.implementer wins over tiers.mid", () => {
		writeConfig({
			models: { implementer: { model: "explicit-model", thinking: "high" } },
			tiers: { mid: { model: "mid-tier-model", thinking: "medium" } },
		});
		const config = loadConfig();
		expect(config.models.implementer.model).toBe("explicit-model");
	});

	it("no tiers → hardcoded defaults (implementer is gpt-5.5, unchanged)", () => {
		writeConfig({});
		const config = loadConfig();
		expect(config.models.implementer.model).toBe("gpt-5.5");
	});

	// FR-7.4: configs that still carry removed planning fields load without error.
	it("loads configs containing removed planning fields without error", () => {
		writeConfig({
			specsDir: "docs/specs",
			specTemplatePath: "docs/TEMPLATE.md",
			specFormat: "typ",
			models: {
				roadmapDrafter: { model: "gpt-5.5", thinking: "high" },
				implementer: { model: "explicit-model", thinking: "high" },
			},
		});
		const config = loadConfig();
		expect(config.models.implementer.model).toBe("explicit-model");
		expect((config as any).specsDir).toBeUndefined();
		expect((config as any).specTemplatePath).toBeUndefined();
	});
});

// ============================================
// getEscalatedModelConfig
// ============================================

describe("getEscalatedModelConfig", () => {
	function makeModels(
		overrides: Partial<ProjectConfig["models"]> = {},
	): ProjectConfig["models"] {
		return {
			planDrafter: { model: "gpt-5.5", thinking: "high" },
			implementer: { model: "gpt-5.5", thinking: "high" },
			codeReviewer: { model: "gpt-5.4", thinking: "medium" },
			addressReview: { model: "gpt-5.4", thinking: "medium" },
			agentCommitMessageWriter: { model: "gpt-5.4-mini", thinking: "off" },
			...overrides,
		};
	}

	function makeProjectConfig(overrides: Partial<ProjectConfig>): ProjectConfig {
		return {
			testCommand: null,
			contextFiles: [],
			projectContext: "",
			projectContextForReviewer: "",
			projectContextForFixer: "",
			models: makeModels(),
			tiers: undefined,
			escalation: { enabled: true, hardFailureRetries: 1 },
			reviewCycles: 2,
			skipPlanGeneration: false,
			...overrides,
		} as ProjectConfig;
	}

	it("implementer with tiers.strong configured → returns the strong config", () => {
		const strongConfig: ModelConfig = {
			model: "strong-tier-model",
			thinking: "high",
		};
		const config = makeProjectConfig({
			models: makeModels({
				implementer: { model: "mid-model", thinking: "medium" },
			}),
			tiers: { strong: strongConfig },
		});
		expect(getEscalatedModelConfig(config, "implementer")).toEqual(
			strongConfig,
		);
	});

	it("implementer with NO tiers → returns planDrafter's config (fallback)", () => {
		const config = makeProjectConfig({
			models: makeModels({
				planDrafter: { model: "strong-model", thinking: "high" },
				implementer: { model: "mid-model", thinking: "medium" },
			}),
			tiers: undefined,
		});
		expect(getEscalatedModelConfig(config, "implementer")).toEqual({
			model: "strong-model",
			thinking: "high",
		});
	});

	it("implementer with no tiers AND planDrafter identical to implementer → undefined", () => {
		// Default models have planDrafter and implementer both as gpt-5.5/high
		const config = makeProjectConfig({ tiers: undefined });
		expect(getEscalatedModelConfig(config, "implementer")).toBeUndefined();
	});

	it("codeReviewer (strong tier) with no tiers → undefined (nowhere to go)", () => {
		const config = makeProjectConfig({ tiers: undefined });
		expect(getEscalatedModelConfig(config, "codeReviewer")).toBeUndefined();
	});

	it("escalation disabled (escalation.enabled: false) → undefined", () => {
		const config = makeProjectConfig({
			escalation: { enabled: false, hardFailureRetries: 0 },
		});
		expect(getEscalatedModelConfig(config, "implementer")).toBeUndefined();
	});

	it("$default models (usingDefaultModels path) → undefined", () => {
		const config = makeProjectConfig({
			models: makeModels({
				planDrafter: { model: "$default", thinking: "off" },
				implementer: { model: "$default", thinking: "off" },
				codeReviewer: { model: "$default", thinking: "off" },
				addressReview: { model: "$default", thinking: "off" },
				agentCommitMessageWriter: { model: "$default", thinking: "off" },
			}),
			usingDefaultModels: true,
			tiers: { strong: { model: "strong-model", thinking: "high" } },
		});
		expect(getEscalatedModelConfig(config, "implementer")).toBeUndefined();
	});

	it("cheap role (commitMessageWriter) walks to tiers.mid", () => {
		const midConfig: ModelConfig = {
			model: "mid-tier-model",
			thinking: "medium",
		};
		const config = makeProjectConfig({
			models: makeModels({
				agentCommitMessageWriter: { model: "cheap-model", thinking: "off" },
			}),
			tiers: { mid: midConfig },
		});
		expect(getEscalatedModelConfig(config, "commitMessageWriter")).toEqual(
			midConfig,
		);
	});

	it("cheap role walks to tiers.strong when only strong is configured", () => {
		const strongConfig: ModelConfig = {
			model: "strong-tier-model",
			thinking: "high",
		};
		const config = makeProjectConfig({
			models: makeModels({
				planDrafter: { model: "some-planner-model", thinking: "high" },
				agentCommitMessageWriter: { model: "cheap-model", thinking: "off" },
			}),
			tiers: { strong: strongConfig },
		});
		expect(getEscalatedModelConfig(config, "commitMessageWriter")).toEqual(
			strongConfig,
		);
	});
});

// ============================================
// Escalation config normalization
// ============================================

describe("escalation config normalization", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-escalation-test-"));
		fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeConfig(config: object): void {
		fs.writeFileSync(
			path.join(tmpDir, ".pi", "spec-pipeline.json"),
			JSON.stringify(config),
			"utf-8",
		);
	}

	it("absent escalation config → DEFAULT_ESCALATION values", () => {
		writeConfig({});
		const result = loadPipelineConfig(tmpDir);
		if (!result.success) throw new Error((result as any).error);
		expect((result as any).config.escalation).toEqual({
			enabled: DEFAULT_ESCALATION.enabled,
			hardFailureRetries: DEFAULT_ESCALATION.hardFailureRetries,
		});
	});

	it("explicit escalation values are respected", () => {
		writeConfig({ escalation: { enabled: false, hardFailureRetries: 0 } });
		const result = loadPipelineConfig(tmpDir);
		if (!result.success) throw new Error((result as any).error);
		expect((result as any).config.escalation).toEqual({
			enabled: false,
			hardFailureRetries: 0,
		});
	});

	it("DEFAULT_ESCALATION has enabled: true and hardFailureRetries: 1", () => {
		expect(DEFAULT_ESCALATION.enabled).toBe(true);
		expect(DEFAULT_ESCALATION.hardFailureRetries).toBe(1);
	});
});

// ============================================
// Worktree config (FR-7.3)
// ============================================

describe("worktree config schema validation", () => {
	it("accepts a valid worktree section", () => {
		expect(
			validateConfig({
				worktree: { basePath: ".pi/worktrees", setupScript: "npm install" },
			}),
		).toEqual([]);
	});

	it("accepts worktree with only basePath", () => {
		expect(validateConfig({ worktree: { basePath: "custom/path" } })).toEqual(
			[],
		);
	});

	it("accepts worktree with only setupScript", () => {
		expect(validateConfig({ worktree: { setupScript: "./setup.sh" } })).toEqual(
			[],
		);
	});

	it("accepts config without worktree key (backward compat, FR-1.5)", () => {
		expect(validateConfig({})).toEqual([]);
		expect(validateConfig({ testCommand: "bun test" })).toEqual([]);
	});

	it("rejects basePath: 42 (wrong type) with error naming /worktree/basePath", () => {
		const errors = validateConfig({ worktree: { basePath: 42 } });
		expect(errors.length).toBeGreaterThan(0);
		const paths = errors.map((e) => e.path).join(" ");
		expect(paths).toContain("/worktree/basePath");
	});

	it("rejects basePath: '' (empty string, violates minLength 1)", () => {
		const errors = validateConfig({ worktree: { basePath: "" } });
		expect(errors.length).toBeGreaterThan(0);
	});

	it("rejects setupScript: '' (empty string, violates minLength 1)", () => {
		const errors = validateConfig({ worktree: { setupScript: "" } });
		expect(errors.length).toBeGreaterThan(0);
	});
});

describe("worktree config normalization", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-worktree-test-"));
		fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeConfig(config: object): void {
		fs.writeFileSync(
			path.join(tmpDir, ".pi", "spec-pipeline.json"),
			JSON.stringify(config),
			"utf-8",
		);
	}

	function loadConfig(): ProjectConfig {
		const result = loadPipelineConfig(tmpDir);
		if (!result.success) throw new Error((result as any).error);
		return (result as any).config;
	}

	it("absent worktree key → basePath defaults to DEFAULT_WORKTREE_BASE_PATH", () => {
		writeConfig({});
		const config = loadConfig();
		expect(config.worktree.basePath).toBe(DEFAULT_WORKTREE_BASE_PATH);
		expect(config.worktree.setupScript).toBeUndefined();
	});

	it("explicit basePath is preserved", () => {
		writeConfig({ worktree: { basePath: "/tmp/my-worktrees" } });
		const config = loadConfig();
		expect(config.worktree.basePath).toBe("/tmp/my-worktrees");
	});

	it("explicit setupScript is preserved (trimmed)", () => {
		writeConfig({ worktree: { setupScript: "  ./scripts/setup.sh  " } });
		const config = loadConfig();
		expect(config.worktree.setupScript).toBe("./scripts/setup.sh");
	});

	it("whitespace-only setupScript is normalized to absent (FR-1.2)", () => {
		writeConfig({ worktree: { setupScript: "   " } });
		// Note: the schema rejects empty strings (minLength 1) but whitespace-only
		// passes schema validation; normalization in buildProjectConfig removes it.
		// However, \"   \" has length 3, so it passes schema but gets trimmed to absent.
		const config = loadConfig();
		expect(config.worktree.setupScript).toBeUndefined();
	});

	it("configs without worktree key load with worktree defaults (NFR-2)", () => {
		// Simulate a config that was written before this feature existed
		writeConfig({ testCommand: "bun test", reviewCycles: 1 });
		const config = loadConfig();
		expect(config.worktree).toBeDefined();
		expect(config.worktree.basePath).toBe(DEFAULT_WORKTREE_BASE_PATH);
		expect(config.worktree.setupScript).toBeUndefined();
		// Ensure other fields are unaffected
		expect(config.testCommand).toBe("bun test");
		expect(config.reviewCycles).toBe(1);
	});

	it("no-config-file path also gets default worktree settings", () => {
		// No .pi/spec-pipeline.json — uses defaults including usingDefaultModels
		const result = loadPipelineConfig(tmpDir);
		if (!result.success) throw new Error((result as any).error);
		const config = (result as any).config as ProjectConfig;
		expect(config.worktree.basePath).toBe(DEFAULT_WORKTREE_BASE_PATH);
		expect(config.worktree.setupScript).toBeUndefined();
	});

	it("DEFAULT_WORKTREE_BASE_PATH is '.pi/worktrees'", () => {
		expect(DEFAULT_WORKTREE_BASE_PATH).toBe(".pi/worktrees");
	});
});
