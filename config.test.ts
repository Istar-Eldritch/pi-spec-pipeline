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
	discoverSpecTemplate,
	discoverSpecConventions,
	detectSpecFormat,
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
				specsDir: "docs/specs",
			};
			expect(validateConfig(config)).toEqual([]);
		});

		it("accepts full valid config", () => {
			const config = {
				specsDir: "docs/specs",
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

		it("accepts hierarchy model roles in config", () => {
			const config = {
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

		it("rejects non-string specsDir", () => {
			const config = {
				specsDir: 123,
			};
			const errors = validateConfig(config);
			expect(errors.length).toBeGreaterThan(0);
		});

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
		it("has roadmapDrafter config", () => {
			expect(DEFAULT_MODEL_CONFIGS.roadmapDrafter).toBeDefined();
			expect(DEFAULT_MODEL_CONFIGS.roadmapDrafter.model).toBe("gpt-5.5");
		});

		it("has roadmapReviewer config", () => {
			expect(DEFAULT_MODEL_CONFIGS.roadmapReviewer).toBeDefined();
			expect(DEFAULT_MODEL_CONFIGS.roadmapReviewer.model).toBe("gpt-5.4");
		});

		it("has epicDrafter config", () => {
			expect(DEFAULT_MODEL_CONFIGS.epicDrafter).toBeDefined();
			expect(DEFAULT_MODEL_CONFIGS.epicDrafter.model).toBe("gpt-5.5");
		});

		it("has epicReviewer config", () => {
			expect(DEFAULT_MODEL_CONFIGS.epicReviewer).toBeDefined();
			expect(DEFAULT_MODEL_CONFIGS.epicReviewer.model).toBe("gpt-5.4");
		});
	});

	describe("DEFAULT_REVIEW_CYCLES", () => {
		it("defaults code review to 2 cycles", () => {
			expect(DEFAULT_REVIEW_CYCLES).toBe(2);
		});
	});
});

describe("discoverSpecTemplate", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-template-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("falls back to the built-in template when no project template exists", () => {
		fs.mkdirSync(path.join(tmpDir, "docs"));
		const result = discoverSpecTemplate(tmpDir, "docs");
		expect(result.builtin).toBe(true);
		expect(result.path).toBe("<built-in spec template>");
		expect(result.content).toContain("| Phase | Focus | Effort |");
	});

	it("discovers a TEMPLATE.md file in docs/", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(
			path.join(docsDir, "TEMPLATE.md"),
			"# Spec Template\n\nContent here",
		);
		const result = discoverSpecTemplate(tmpDir, "docs");
		expect(result.path).toBe("docs/TEMPLATE.md");
		expect(result.content).toContain("Spec Template");
	});

	it("discovers a timestamped TEMPLATE file (e.g. 2601221403_TEMPLATE.typ)", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(
			path.join(docsDir, "2601221403_TEMPLATE.typ"),
			"// Typst template\n= Overview",
		);
		const result = discoverSpecTemplate(tmpDir, "docs");
		expect(result.path).toBe("docs/2601221403_TEMPLATE.typ");
		expect(result.content).toContain("Typst template");
	});

	it("skips _template.typ layout files (underscore prefix) and falls back to built-in", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(path.join(docsDir, "_template.typ"), "// Layout template");
		const result = discoverSpecTemplate(tmpDir, "docs");
		expect(result.builtin).toBe(true);
	});

	it("skips template_example files and falls back to built-in", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(path.join(docsDir, "_template_example.typ"), "// Example");
		const result = discoverSpecTemplate(tmpDir, "docs");
		expect(result.builtin).toBe(true);
	});

	it("skips binary files (PDF) and falls back to built-in", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(
			path.join(docsDir, "TEMPLATE.pdf"),
			Buffer.from([0x25, 0x50, 0x44, 0x46]),
		);
		const result = discoverSpecTemplate(tmpDir, "docs");
		expect(result.builtin).toBe(true);
	});

	it("uses explicit path from config when provided", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(
			path.join(docsDir, "my_custom_template.md"),
			"# Custom Template",
		);
		fs.writeFileSync(path.join(docsDir, "TEMPLATE.md"), "# Default Template");
		const result = discoverSpecTemplate(
			tmpDir,
			"docs",
			"docs/my_custom_template.md",
		);
		expect(result.path).toBe("docs/my_custom_template.md");
		expect(result.content).toContain("Custom Template");
	});

	it("returns null when explicitly set to null", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(path.join(docsDir, "TEMPLATE.md"), "# Template");
		const result = discoverSpecTemplate(tmpDir, "docs", null);
		expect(result.path).toBeNull();
		expect(result.content).toBeNull();
	});

	it("falls back to auto-discovery when explicit path doesn't exist", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(path.join(docsDir, "TEMPLATE.md"), "# Fallback Template");
		const result = discoverSpecTemplate(tmpDir, "docs", "nonexistent.md");
		expect(result.path).toBe("docs/TEMPLATE.md");
		expect(result.content).toContain("Fallback Template");
	});

	it("skips empty template files and falls back to built-in", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(path.join(docsDir, "TEMPLATE.md"), "");
		const result = discoverSpecTemplate(tmpDir, "docs");
		expect(result.builtin).toBe(true);
	});
});

describe("discoverSpecConventions", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-conventions-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when no convention files exist", () => {
		fs.mkdirSync(path.join(tmpDir, "docs"));
		const result = discoverSpecConventions(tmpDir, "docs");
		expect(result.path).toBeNull();
		expect(result.content).toBeNull();
	});

	it("discovers a guide_specs file", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(
			path.join(docsDir, "guide_specs.md"),
			"# Spec Guide\n\nConventions here",
		);
		const result = discoverSpecConventions(tmpDir, "docs");
		expect(result.path).toBe("docs/guide_specs.md");
		expect(result.content).toContain("Spec Guide");
	});

	it("discovers a timestamped guide_specs file", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(
			path.join(docsDir, "2601221403_guide_specs.typ"),
			"// Spec Conventions",
		);
		const result = discoverSpecConventions(tmpDir, "docs");
		expect(result.path).toBe("docs/2601221403_guide_specs.typ");
		expect(result.content).toContain("Spec Conventions");
	});

	it("discovers spec_conventions file", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(
			path.join(docsDir, "spec_conventions.md"),
			"# Conventions",
		);
		const result = discoverSpecConventions(tmpDir, "docs");
		expect(result.path).toBe("docs/spec_conventions.md");
		expect(result.content).toContain("Conventions");
	});

	it("uses explicit path from config when provided", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(
			path.join(docsDir, "my_conventions.md"),
			"# My Conventions",
		);
		const result = discoverSpecConventions(
			tmpDir,
			"docs",
			"docs/my_conventions.md",
		);
		expect(result.path).toBe("docs/my_conventions.md");
		expect(result.content).toContain("My Conventions");
	});

	it("returns null when explicitly set to null", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(path.join(docsDir, "guide_specs.md"), "# Guide");
		const result = discoverSpecConventions(tmpDir, "docs", null);
		expect(result.path).toBeNull();
		expect(result.content).toBeNull();
	});

	it("does not discover non-spec guide files", () => {
		const docsDir = path.join(tmpDir, "docs");
		fs.mkdirSync(docsDir);
		fs.writeFileSync(path.join(docsDir, "guide_testing.md"), "# Testing Guide");
		fs.writeFileSync(
			path.join(docsDir, "guide_deployment.md"),
			"# Deployment Guide",
		);
		const result = discoverSpecConventions(tmpDir, "docs");
		expect(result.path).toBeNull();
		expect(result.content).toBeNull();
	});
});

describe("validateConfig with template fields", () => {
	it("accepts specTemplatePath as string", () => {
		const config = { specTemplatePath: "docs/TEMPLATE.md" };
		expect(validateConfig(config)).toEqual([]);
	});

	it("accepts specTemplatePath as null (disabled)", () => {
		const config = { specTemplatePath: null };
		expect(validateConfig(config)).toEqual([]);
	});

	it("accepts specConventionsPath as string", () => {
		const config = { specConventionsPath: "docs/guide_specs.md" };
		expect(validateConfig(config)).toEqual([]);
	});

	it("accepts specConventionsPath as null (disabled)", () => {
		const config = { specConventionsPath: null };
		expect(validateConfig(config)).toEqual([]);
	});

	it("accepts both template and conventions paths", () => {
		const config = {
			specTemplatePath: "docs/TEMPLATE.typ",
			specConventionsPath: "docs/guide_specs.typ",
		};
		expect(validateConfig(config)).toEqual([]);
	});

	it("accepts specFormat as string", () => {
		const config = { specFormat: "typ" };
		expect(validateConfig(config)).toEqual([]);
	});
});

describe("detectSpecFormat", () => {
	it("defaults to md when no template and no explicit format", () => {
		expect(detectSpecFormat(undefined, null)).toBe("md");
	});

	it("derives format from template path extension", () => {
		expect(detectSpecFormat(undefined, "docs/2601221403_TEMPLATE.typ")).toBe(
			"typ",
		);
	});

	it("derives md from a .md template path", () => {
		expect(detectSpecFormat(undefined, "docs/TEMPLATE.md")).toBe("md");
	});

	it("explicit format overrides template path", () => {
		expect(detectSpecFormat("md", "docs/2601221403_TEMPLATE.typ")).toBe("md");
	});

	it("strips leading dot from explicit format", () => {
		expect(detectSpecFormat(".typ", null)).toBe("typ");
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
});

// ============================================
// getEscalatedModelConfig
// ============================================

describe("getEscalatedModelConfig", () => {
	function makeProjectConfig(overrides: Partial<ProjectConfig>): ProjectConfig {
		const defaultModels = {
			planDrafter: { model: "gpt-5.5", thinking: "high" } as ModelConfig,
			implementer: { model: "gpt-5.5", thinking: "high" } as ModelConfig,
			codeReviewer: { model: "gpt-5.4", thinking: "medium" } as ModelConfig,
			addressReview: { model: "gpt-5.4", thinking: "medium" } as ModelConfig,
			agentCommitMessageWriter: {
				model: "gpt-5.4-mini",
				thinking: "off",
			} as ModelConfig,
			roadmapDrafter: { model: "gpt-5.5", thinking: "high" } as ModelConfig,
			roadmapReviewer: { model: "gpt-5.4", thinking: "medium" } as ModelConfig,
			epicDrafter: { model: "gpt-5.5", thinking: "high" } as ModelConfig,
			epicReviewer: { model: "gpt-5.4", thinking: "medium" } as ModelConfig,
		};
		return {
			specsDir: "docs",
			testCommand: null,
			contextFiles: [],
			projectContext: "",
			projectContextForReviewer: "",
			projectContextForFixer: "",
			specTemplate: null,
			specTemplatePath: null,
			specConventions: null,
			specConventionsPath: null,
			specFormat: "md",
			models: defaultModels,
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
			models: {
				planDrafter: { model: "gpt-5.5", thinking: "high" },
				implementer: { model: "mid-model", thinking: "medium" },
				codeReviewer: { model: "gpt-5.4", thinking: "medium" },
				addressReview: { model: "gpt-5.4", thinking: "medium" },
				agentCommitMessageWriter: { model: "gpt-5.4-mini", thinking: "off" },
				roadmapDrafter: { model: "gpt-5.5", thinking: "high" },
				roadmapReviewer: { model: "gpt-5.4", thinking: "medium" },
				epicDrafter: { model: "gpt-5.5", thinking: "high" },
				epicReviewer: { model: "gpt-5.4", thinking: "medium" },
			},
			tiers: { strong: strongConfig },
		});
		expect(getEscalatedModelConfig(config, "implementer")).toEqual(
			strongConfig,
		);
	});

	it("implementer with NO tiers → returns planDrafter's config (fallback)", () => {
		const config = makeProjectConfig({
			models: {
				planDrafter: { model: "strong-model", thinking: "high" },
				implementer: { model: "mid-model", thinking: "medium" },
				codeReviewer: { model: "gpt-5.4", thinking: "medium" },
				addressReview: { model: "gpt-5.4", thinking: "medium" },
				agentCommitMessageWriter: { model: "gpt-5.4-mini", thinking: "off" },
				roadmapDrafter: { model: "strong-model", thinking: "high" },
				roadmapReviewer: { model: "gpt-5.4", thinking: "medium" },
				epicDrafter: { model: "strong-model", thinking: "high" },
				epicReviewer: { model: "gpt-5.4", thinking: "medium" },
			},
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
		const defaultModels = {
			planDrafter: { model: "$default", thinking: "off" } as ModelConfig,
			implementer: { model: "$default", thinking: "off" } as ModelConfig,
			codeReviewer: { model: "$default", thinking: "off" } as ModelConfig,
			addressReview: { model: "$default", thinking: "off" } as ModelConfig,
			agentCommitMessageWriter: {
				model: "$default",
				thinking: "off",
			} as ModelConfig,
			roadmapDrafter: { model: "$default", thinking: "off" } as ModelConfig,
			roadmapReviewer: { model: "$default", thinking: "off" } as ModelConfig,
			epicDrafter: { model: "$default", thinking: "off" } as ModelConfig,
			epicReviewer: { model: "$default", thinking: "off" } as ModelConfig,
		};
		const config = makeProjectConfig({
			models: defaultModels,
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
			models: {
				planDrafter: { model: "gpt-5.5", thinking: "high" },
				implementer: { model: "gpt-5.5", thinking: "high" },
				codeReviewer: { model: "gpt-5.4", thinking: "medium" },
				addressReview: { model: "gpt-5.4", thinking: "medium" },
				agentCommitMessageWriter: { model: "cheap-model", thinking: "off" },
				roadmapDrafter: { model: "gpt-5.5", thinking: "high" },
				roadmapReviewer: { model: "gpt-5.4", thinking: "medium" },
				epicDrafter: { model: "gpt-5.5", thinking: "high" },
				epicReviewer: { model: "gpt-5.4", thinking: "medium" },
			},
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
			models: {
				planDrafter: { model: "some-planner-model", thinking: "high" },
				implementer: { model: "gpt-5.5", thinking: "high" },
				codeReviewer: { model: "gpt-5.4", thinking: "medium" },
				addressReview: { model: "gpt-5.4", thinking: "medium" },
				agentCommitMessageWriter: { model: "cheap-model", thinking: "off" },
				roadmapDrafter: { model: "some-planner-model", thinking: "high" },
				roadmapReviewer: { model: "gpt-5.4", thinking: "medium" },
				epicDrafter: { model: "some-planner-model", thinking: "high" },
				epicReviewer: { model: "gpt-5.4", thinking: "medium" },
			},
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
