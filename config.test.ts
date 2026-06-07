import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	validateConfig,
	formatValidationErrors,
	DEFAULT_MODEL_CONFIGS,
	DEFAULT_REVIEW_CYCLES,
	discoverSpecTemplate,
	discoverSpecConventions,
	detectSpecFormat,
} from "./config.ts";

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
