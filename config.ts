/**
 * Configuration loading, validation, and defaults for the spec pipeline
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import type { Static } from "@sinclair/typebox";
import {
	type ModelConfig,
	type ModelsConfig,
	type ReviewCyclesConfig,
	type NormalizedReviewCycles,
	type ProjectConfig,
	type TierName,
	type TiersConfig,
	type EscalationConfig,
	type RoleName,
	SpecPipelineConfigSchema,
} from "./types.ts";

// ============================================
// Default Configurations
// ============================================

/**
 * Default model configurations per role (R14)
 * These are the optimized defaults when no configuration is provided.
 * Model values are actual model identifiers passed directly to the pi CLI.
 */
export const DEFAULT_MODEL_CONFIGS: Record<string, ModelConfig> = {
	planDrafter: { model: "gpt-5.5", thinking: "high" }, // Complex planning task
	implementer: { model: "gpt-5.5", thinking: "high" }, // Complex code generation
	codeReviewer: { model: "gpt-5.4", thinking: "medium" }, // Review code changes
	addressReview: { model: "gpt-5.4", thinking: "medium" }, // Fix application — issues already identified by reviewer
	agentCommitMessageWriter: { model: "gpt-5.4-mini", thinking: "off" }, // Fast, cheap commit message generation (R5)
	roadmapDrafter: { model: "gpt-5.5", thinking: "high" }, // Roadmap documents (same as planDrafter)
	roadmapReviewer: { model: "gpt-5.4", thinking: "medium" }, // Review roadmap docs
	epicDrafter: { model: "gpt-5.5", thinking: "high" }, // Epic documents (same as planDrafter)
	epicReviewer: { model: "gpt-5.4", thinking: "medium" }, // Review epic docs
} as const;

/** Default code review cycle count. Set to 0 to skip code review. */
export const DEFAULT_REVIEW_CYCLES: NormalizedReviewCycles = 2;

/**
 * Which tier each role belongs to by default. The plan and the review are the
 * leverage points (strong); implementation/fixes are well-constrained (mid);
 * commit messages are mechanical (cheap).
 */
export const ROLE_TIERS: Record<string, TierName> = {
	planDrafter: "strong",
	implementer: "mid",
	codeReviewer: "strong",
	addressReview: "mid",
	agentCommitMessageWriter: "cheap",
	roadmapDrafter: "strong",
	roadmapReviewer: "strong",
	epicDrafter: "strong",
	epicReviewer: "strong",
};

export const DEFAULT_ESCALATION = {
	enabled: true,
	hardFailureRetries: 1,
} as const;

// ============================================
// Validation
// ============================================

/**
 * Validation error for configuration
 */
export interface ConfigValidationError {
	path: string;
	message: string;
}

/**
 * Validate configuration against schema
 * Returns array of validation errors (empty if valid)
 */
export function validateConfig(config: unknown): ConfigValidationError[] {
	const errors: ConfigValidationError[] = [];

	// Use TypeBox Value.Check for validation
	if (!Value.Check(SpecPipelineConfigSchema, config)) {
		// Get detailed errors using Value.Errors
		for (const error of Value.Errors(SpecPipelineConfigSchema, config)) {
			errors.push({
				path: error.path,
				message: error.message,
			});
		}
	}

	return errors;
}

/**
 * Format validation errors for display
 */
export function formatValidationErrors(
	errors: ConfigValidationError[],
): string {
	const lines: string[] = ["Invalid spec-pipeline configuration:", ""];

	for (const error of errors) {
		lines.push(`  • ${error.path || "root"}: ${error.message}`);
	}

	lines.push("");
	lines.push("Please fix .pi/spec-pipeline.json and try again.");

	return lines.join("\n");
}

// ============================================
// Configuration Normalization
// ============================================

function normalizeReviewCycles(
	userReviewCycles: ReviewCyclesConfig | undefined,
): NormalizedReviewCycles {
	return userReviewCycles ?? DEFAULT_REVIEW_CYCLES;
}

function normalizeEscalation(
	userEscalation: EscalationConfig | undefined,
): ProjectConfig["escalation"] {
	return {
		enabled: userEscalation?.enabled ?? DEFAULT_ESCALATION.enabled,
		hardFailureRetries:
			userEscalation?.hardFailureRetries ??
			DEFAULT_ESCALATION.hardFailureRetries,
	};
}

const TIER_LADDER: Record<TierName, TierName | undefined> = {
	cheap: "mid",
	mid: "strong",
	strong: undefined,
};

/**
 * Resolve the model config to escalate `role` to, or undefined when escalation
 * is impossible/pointless. Walks the tier ladder upward from the role's static
 * tier (ROLE_TIERS). When no `tiers` are configured, falls back to the
 * planDrafter config (by convention the strongest configured role) for
 * mid/cheap roles.
 */
export function getEscalatedModelConfig(
	projectConfig: ProjectConfig,
	role: RoleName,
): ModelConfig | undefined {
	// Step 1: escalation disabled
	if (!projectConfig.escalation.enabled) return undefined;

	// Step 2: map role to models key
	let key: string;
	if (role === "commitMessageWriter") {
		key = "agentCommitMessageWriter";
	} else if (role === "brainstormAgent") {
		return undefined;
	} else {
		key = role;
	}
	const models = projectConfig.models as Record<
		string,
		ModelConfig | undefined
	>;
	const current = models[key];
	if (!current) return undefined;

	// Step 3: get tier for role
	const tier: TierName = (ROLE_TIERS[key] as TierName | undefined) ?? "mid";

	// Step 4: walk the tier ladder to find a candidate
	let candidate: ModelConfig | undefined;
	let next: TierName | undefined = TIER_LADDER[tier];
	while (next !== undefined) {
		const tierConfig = projectConfig.tiers?.[next];
		if (tierConfig) {
			candidate = tierConfig;
			break;
		}
		next = TIER_LADDER[next];
	}

	// Step 5: fallback to planDrafter when no tier config and not already strong
	if (!candidate && tier !== "strong") {
		candidate = projectConfig.models.planDrafter;
	}

	// Step 6: no candidate
	if (!candidate) return undefined;

	// Step 7: $default models
	if (candidate.model === "$default" || current.model === "$default")
		return undefined;

	// Step 8: same model is pointless
	if (
		candidate.model === current.model &&
		candidate.thinking === current.thinking
	)
		return undefined;

	// Step 9: return candidate
	return candidate;
}

/**
 * Merge user-provided model config with defaults
 * Fills in missing values with optimized defaults (R3)
 * Note: commitMessageWriter in userModels is silently ignored (R5a)
 */
function mergeWithDefaults(
	userModels: ModelsConfig | undefined,
	userTiers: TiersConfig | undefined,
	userReviewCycles: ReviewCyclesConfig | undefined,
	projectStreamIdleTimeoutMs: number | undefined,
): {
	models: ProjectConfig["models"];
	reviewCycles: ProjectConfig["reviewCycles"];
} {
	// Build complete models config by merging user values with defaults
	// Note: commitMessageWriter from userModels is intentionally not used (R5a)
	const models: ProjectConfig["models"] = {
		planDrafter:
			userModels?.planDrafter ??
			userTiers?.[ROLE_TIERS.planDrafter] ??
			DEFAULT_MODEL_CONFIGS.planDrafter,
		implementer:
			userModels?.implementer ??
			userTiers?.[ROLE_TIERS.implementer] ??
			DEFAULT_MODEL_CONFIGS.implementer,
		codeReviewer:
			userModels?.codeReviewer ??
			userTiers?.[ROLE_TIERS.codeReviewer] ??
			DEFAULT_MODEL_CONFIGS.codeReviewer,
		addressReview:
			userModels?.addressReview ??
			userTiers?.[ROLE_TIERS.addressReview] ??
			DEFAULT_MODEL_CONFIGS.addressReview,
		agentCommitMessageWriter:
			userModels?.agentCommitMessageWriter ??
			userTiers?.[ROLE_TIERS.agentCommitMessageWriter] ??
			DEFAULT_MODEL_CONFIGS.agentCommitMessageWriter,
		roadmapDrafter:
			userModels?.roadmapDrafter ??
			userModels?.planDrafter ??
			userTiers?.[ROLE_TIERS.roadmapDrafter] ??
			DEFAULT_MODEL_CONFIGS.roadmapDrafter,
		roadmapReviewer:
			userModels?.roadmapReviewer ??
			userModels?.codeReviewer ??
			userTiers?.[ROLE_TIERS.roadmapReviewer] ??
			DEFAULT_MODEL_CONFIGS.roadmapReviewer,
		epicDrafter:
			userModels?.epicDrafter ??
			userModels?.planDrafter ??
			userTiers?.[ROLE_TIERS.epicDrafter] ??
			DEFAULT_MODEL_CONFIGS.epicDrafter,
		epicReviewer:
			userModels?.epicReviewer ??
			userModels?.codeReviewer ??
			userTiers?.[ROLE_TIERS.epicReviewer] ??
			DEFAULT_MODEL_CONFIGS.epicReviewer,
	};

	// Apply project-level streamIdleTimeoutMs as fallback when per-role isn't set.
	if (projectStreamIdleTimeoutMs !== undefined) {
		for (const role of Object.keys(models) as Array<keyof typeof models>) {
			if (models[role].streamIdleTimeoutMs === undefined) {
				models[role] = {
					...models[role],
					streamIdleTimeoutMs: projectStreamIdleTimeoutMs,
				};
			}
		}
	}

	// Normalize review cycles to per-reviewer format
	const reviewCycles = normalizeReviewCycles(userReviewCycles);

	return { models, reviewCycles };
}

// ============================================
// Configuration Loading
// ============================================

// ============================================
// Spec Template & Conventions Discovery
// ============================================

/** File extensions we can read as text-based templates */
const READABLE_EXTENSIONS = new Set([".md", ".typ", ".txt", ".rst", ".adoc"]);

/**
 * Try to read a file if it exists and has a readable text extension.
 * Returns the content or null.
 */
function readTextFile(filePath: string): string | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const ext = path.extname(filePath).toLowerCase();
		if (!READABLE_EXTENSIONS.has(ext)) return null;
		const content = fs.readFileSync(filePath, "utf-8");
		return content.trim().length > 0 ? content : null;
	} catch {
		return null;
	}
}

/**
 * Search a directory for files matching patterns.
 * Returns relative paths from cwd.
 */
function findFilesMatching(dir: string, patterns: RegExp[]): string[] {
	const results: string[] = [];
	try {
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return results;
		const entries = fs.readdirSync(dir);
		for (const entry of entries) {
			const fullPath = path.join(dir, entry);
			const stat = fs.statSync(fullPath);
			if (!stat.isFile()) continue;
			for (const pattern of patterns) {
				if (pattern.test(entry)) {
					results.push(fullPath);
					break;
				}
			}
		}
	} catch {
		/* ignore */
	}
	return results;
}

/**
 * Discover spec template file in the project.
 *
 * Priority:
 * 1. Explicit path from config (specTemplatePath)
 * 2. Files matching *TEMPLATE* or *template* in specs directory / common locations
 * 3. Built-in fallback template shipped with the extension
 *
 * Returns { path, content, builtin } or { path: null, content: null }.
 * `builtin: true` means the caller should surface a one-time hint telling the
 * user how to customise it.
 */
export function discoverSpecTemplate(
	cwd: string,
	specsDir: string,
	explicitPath?: string | null,
): { path: string | null; content: string | null; builtin?: boolean } {
	// 1. Explicit path from config
	if (explicitPath) {
		const fullPath = path.isAbsolute(explicitPath)
			? explicitPath
			: path.join(cwd, explicitPath);
		const content = readTextFile(fullPath);
		if (content) {
			return { path: explicitPath, content };
		}
	}

	// Null means explicitly disabled
	if (explicitPath === null) {
		return { path: null, content: null };
	}

	// 2. Search in specs directory
	const templatePatterns = [/template/i];

	const searchDirs = [
		path.join(cwd, specsDir),
		path.join(cwd, "docs"),
		path.join(cwd, "specs"),
	];

	// Deduplicate directories
	const seen = new Set<string>();
	for (const dir of searchDirs) {
		const resolved = path.resolve(dir);
		if (seen.has(resolved)) continue;
		seen.add(resolved);

		const matches = findFilesMatching(dir, templatePatterns);
		// Prefer files with TEMPLATE in the name (case-insensitive)
		// Filter out _template.typ (the Typst layout file) - we want the spec template
		const templateFiles = matches.filter((f) => {
			const basename = path.basename(f).toLowerCase();
			// Must have "template" in the name
			if (!basename.includes("template")) return false;
			// Skip binary files
			const ext = path.extname(f).toLowerCase();
			if (!READABLE_EXTENSIONS.has(ext)) return false;
			// Skip layout template files (prefixed with underscore, no date prefix)
			// These are Typst layout files, not spec templates
			if (basename.startsWith("_")) return false;
			// Skip example files
			if (basename.includes("example")) return false;
			return true;
		});

		if (templateFiles.length > 0) {
			// Pick the first match (sorted for determinism)
			templateFiles.sort();
			const templatePath = templateFiles[0];
			const content = readTextFile(templatePath);
			if (content) {
				const relativePath = path.relative(cwd, templatePath);
				return { path: relativePath, content };
			}
		}
	}

	// 3. Built-in fallback shipped with the extension
	const builtinPath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"templates",
		"spec-template.md",
	);
	const builtinContent = readTextFile(builtinPath);
	if (builtinContent) {
		return {
			path: "<built-in spec template>",
			content: builtinContent,
			builtin: true,
		};
	}

	return { path: null, content: null };
}

/**
 * Discover spec conventions/guide file in the project.
 *
 * Priority:
 * 1. Explicit path from config (specConventionsPath)
 * 2. Files matching *guide*spec* or *spec*convention* in specs directory
 * 3. Files matching similar patterns in common locations
 *
 * Returns { path, content } or { path: null, content: null }
 */
export function discoverSpecConventions(
	cwd: string,
	specsDir: string,
	explicitPath?: string | null,
): { path: string | null; content: string | null } {
	// 1. Explicit path from config
	if (explicitPath) {
		const fullPath = path.isAbsolute(explicitPath)
			? explicitPath
			: path.join(cwd, explicitPath);
		const content = readTextFile(fullPath);
		if (content) {
			return { path: explicitPath, content };
		}
	}

	// Null means explicitly disabled
	if (explicitPath === null) {
		return { path: null, content: null };
	}

	// 2. Search for convention files
	const conventionPatterns = [
		/guide.*spec/i,
		/spec.*guide/i,
		/spec.*convention/i,
		/convention.*spec/i,
		/writing.*spec/i,
		/spec.*standard/i,
	];

	const searchDirs = [
		path.join(cwd, specsDir),
		path.join(cwd, "docs"),
		path.join(cwd, "specs"),
	];

	const seen = new Set<string>();
	for (const dir of searchDirs) {
		const resolved = path.resolve(dir);
		if (seen.has(resolved)) continue;
		seen.add(resolved);

		const matches = findFilesMatching(dir, conventionPatterns);
		const conventionFiles = matches.filter((f) => {
			const ext = path.extname(f).toLowerCase();
			return READABLE_EXTENSIONS.has(ext);
		});

		if (conventionFiles.length > 0) {
			conventionFiles.sort();
			const conventionPath = conventionFiles[0];
			const content = readTextFile(conventionPath);
			if (content) {
				const relativePath = path.relative(cwd, conventionPath);
				return { path: relativePath, content };
			}
		}
	}

	return { path: null, content: null };
}

/**
 * Detect the spec output format.
 *
 * Priority:
 * 1. Explicit format from config
 * 2. Extension of the discovered template file
 * 3. Default to "md"
 */
export function detectSpecFormat(
	explicitFormat?: string,
	templatePath?: string | null,
): string {
	if (explicitFormat) {
		return explicitFormat.replace(/^\./, "");
	}
	if (templatePath) {
		const ext = path.extname(templatePath).toLowerCase().replace(/^\./, "");
		if (ext) return ext;
	}
	return "md";
}

/**
 * Configuration loading result
 */
export type ConfigLoadResult =
	| {
			success: true;
			config: ProjectConfig;
			fromFile: boolean;
	  }
	| {
			success: false;
			error: string;
	  };

/**
 * Build complete ProjectConfig from validated raw config
 */
function buildProjectConfig(
	cwd: string,
	config: Static<typeof SpecPipelineConfigSchema>,
): ProjectConfig {
	// Detect specs directory (existing logic)
	let specsDir = config.specsDir;
	if (!specsDir) {
		if (fs.existsSync(path.join(cwd, "docs", "specs"))) {
			specsDir = "docs/specs";
		} else if (fs.existsSync(path.join(cwd, "docs"))) {
			specsDir = "docs";
		} else if (fs.existsSync(path.join(cwd, "specs"))) {
			specsDir = "specs";
		} else {
			specsDir = "docs";
		}
	}

	// Detect test command (existing logic)
	let testCommand = config.testCommand ?? null;
	if (!testCommand) {
		if (fs.existsSync(path.join(cwd, "package.json"))) {
			try {
				const pkg = JSON.parse(
					fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
				);
				if (pkg.scripts?.test) {
					testCommand = "npm test";
				}
			} catch {
				/* ignore */
			}
		}
		if (!testCommand && fs.existsSync(path.join(cwd, "Cargo.toml"))) {
			testCommand = "cargo test";
		}
		if (!testCommand && fs.existsSync(path.join(cwd, "pyproject.toml"))) {
			testCommand = "pytest";
		}
		if (!testCommand && fs.existsSync(path.join(cwd, "go.mod"))) {
			testCommand = "go test ./...";
		}
		if (!testCommand && fs.existsSync(path.join(cwd, "Makefile"))) {
			const makefile = fs.readFileSync(path.join(cwd, "Makefile"), "utf-8");
			if (makefile.includes("test:")) {
				testCommand = "make test";
			}
		}
		if (!testCommand && fs.existsSync(path.join(cwd, "scripts", "test.sh"))) {
			testCommand = "./scripts/test.sh";
		}
	}

	// Gather context files (existing logic)
	const contextFiles = config.contextFiles ?? [];
	const defaultContextFiles = [
		"AGENTS.md",
		"CONTRIBUTING.md",
		"ARCHITECTURE.md",
		"README.md",
		"docs/CONTRIBUTING.md",
		"docs/architecture.md",
		".github/CONTRIBUTING.md",
	];

	let projectContext = "## Project Context\n\n";
	const foundFiles: string[] = [];

	for (const file of [...contextFiles, ...defaultContextFiles]) {
		const filePath = path.join(cwd, file);
		if (fs.existsSync(filePath)) {
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				if (content.trim().length > 100) {
					foundFiles.push(file);
					const truncated =
						content.length > 5000
							? content.slice(0, 5000) + "\n\n[... truncated ...]"
							: content;
					projectContext += `### From ${file}:\n\n${truncated}\n\n`;
				}
			} catch {
				/* ignore */
			}
		}
	}

	if (foundFiles.length === 0) {
		projectContext =
			"## Project Context\n\nNo project documentation found. Explore the codebase to understand conventions.\n";
	} else {
		projectContext =
			`## Project Context\n\nFound documentation in: ${foundFiles.join(", ")}\n\n` +
			projectContext;
	}

	// Snapshot the docs-only context before appending sections that don't apply
	// to read-only review roles (testing instructions, spec template/conventions).
	const projectContextForReviewer = projectContext;

	if (testCommand) {
		projectContext += `\n## Testing\n\nYou MUST run tests with: \`${testCommand}\`\n`;
	}

	// Snapshot for roles that run tests but don't author specs (implementer,
	// addressReview). Includes the test command, excludes spec template/conventions.
	const projectContextForFixer = projectContext;

	// Discover spec template, conventions, and output format
	const template = discoverSpecTemplate(cwd, specsDir, config.specTemplatePath);
	if (template.builtin) {
		console.log(
			`ℹ️  spec-pipeline: using built-in spec template. Drop a *template*.md under \`${specsDir}/\` (or set \`specTemplatePath\` in .pi/spec-pipeline.json) to customise.`,
		);
	}
	const conventions = discoverSpecConventions(
		cwd,
		specsDir,
		config.specConventionsPath,
	);
	const specFormat = detectSpecFormat(config.specFormat, template.path);

	if (template.content) {
		const truncatedTemplate =
			template.content.length > 8000
				? template.content.slice(0, 8000) + "\n\n[... truncated ...]"
				: template.content;
		projectContext += `\n## Spec Template (from ${template.path})\n\nUse this template as the basis for new specifications:\n\n\`\`\`\n${truncatedTemplate}\n\`\`\`\n`;
	}

	if (conventions.content) {
		const truncatedConventions =
			conventions.content.length > 8000
				? conventions.content.slice(0, 8000) + "\n\n[... truncated ...]"
				: conventions.content;
		projectContext += `\n## Spec Conventions (from ${conventions.path})\n\nFollow these conventions when writing specs:\n\n\`\`\`\n${truncatedConventions}\n\`\`\`\n`;
	}

	// Merge model configs with defaults (R3, R5)
	// Note: commitMessageWriter in config.models is silently ignored (R5a)
	const { models, reviewCycles } = mergeWithDefaults(
		config.models,
		config.tiers,
		config.reviewCycles,
		config.streamIdleTimeoutMs,
	);

	// Skip plan generation (experimental A/B testing)
	const skipPlanGeneration = config.skipPlanGeneration ?? false;

	return {
		specsDir,
		testCommand,
		contextFiles: foundFiles,
		projectContext,
		projectContextForReviewer,
		projectContextForFixer,
		specTemplate: template.content,
		specTemplatePath: template.path,
		specConventions: conventions.content,
		specConventionsPath: conventions.path,
		specFormat,
		models,
		tiers: config.tiers,
		escalation: normalizeEscalation(config.escalation),
		reviewCycles,
		skipPlanGeneration,
		streamIdleTimeoutMs: config.streamIdleTimeoutMs,
	};
}

/**
 * Try to resolve the main git repository path when running inside a worktree.
 * Git worktrees have a `.git` file (not directory) containing `gitdir: <path>`.
 * Returns the main repo root or null if not a worktree.
 */
function resolveMainRepoFromWorktree(cwd: string): string | null {
	const gitFile = path.join(cwd, ".git");
	try {
		const stat = fs.statSync(gitFile);
		if (stat.isDirectory()) return null; // normal repo
		const content = fs.readFileSync(gitFile, "utf-8").trim();
		// e.g. gitdir: /home/user/project/.git/worktrees/branch-name
		const match = content.match(/^gitdir:\s*(.+)$/m);
		if (!match) return null;
		const gitDir = match[1].trim();
		// Navigate from .git/worktrees/<name> up to the repo root
		const parts = gitDir.split(path.sep);
		// Remove .git/worktrees/<name> → go up 3 levels
		if (parts.length >= 3) {
			const mainRepo = path.join(...parts.slice(0, -3));
			return path.isAbsolute(mainRepo) ? mainRepo : path.resolve(cwd, mainRepo);
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Load and validate pipeline configuration
 * Returns error if config is corrupt or invalid (R4)
 */
export function loadPipelineConfig(cwd: string): ConfigLoadResult {
	const configPath = path.join(cwd, ".pi", "spec-pipeline.json");
	let rawConfig: unknown = {};
	let fromFile = false;
	let resolvedPath = configPath;

	if (fs.existsSync(configPath)) {
		fromFile = true;
	} else {
		// Worktree fallback: untracked `.pi/` is not copied by `git worktree add`,
		// so look in the main repo for the config.
		const mainRepo = resolveMainRepoFromWorktree(cwd);
		if (mainRepo) {
			const fallbackPath = path.join(mainRepo, ".pi", "spec-pipeline.json");
			if (fs.existsSync(fallbackPath)) {
				fromFile = true;
				resolvedPath = fallbackPath;
			}
		}
	}

	if (fromFile) {
		try {
			const content = fs.readFileSync(resolvedPath, "utf-8");
			rawConfig = JSON.parse(content);
			if (resolvedPath !== configPath) {
				console.log(
					`ℹ️  spec-pipeline: using config from main repo (${path.relative(cwd, resolvedPath)}) because this worktree does not have its own .pi/spec-pipeline.json.`,
				);
			}
		} catch (e) {
			// JSON parse error - return error (R4)
			const parseError = e instanceof Error ? e.message : "Unknown parse error";
			return {
				success: false,
				error: `Failed to parse .pi/spec-pipeline.json: ${parseError}`,
			};
		}

		// Validate against schema (R4)
		const validationErrors = validateConfig(rawConfig);
		if (validationErrors.length > 0) {
			return {
				success: false,
				error: formatValidationErrors(validationErrors),
			};
		}
	}

	// Cast to typed config after validation
	const typedConfig = rawConfig as Static<typeof SpecPipelineConfigSchema>;

	const projectConfig = buildProjectConfig(cwd, typedConfig);

	// When no config file exists (including worktree fallback), all model roles
	// fall back to the user's current default model instead of hardcoded ones.
	// Runtimes spawn pi without --model/--thinking so the subagent inherits the
	// user's default.
	if (!fromFile) {
		projectConfig.usingDefaultModels = true;
		for (const role of Object.keys(projectConfig.models) as Array<
			keyof typeof projectConfig.models
		>) {
			projectConfig.models[role] = { model: "$default", thinking: "off" };
		}
		projectConfig.tiers = undefined;
		projectConfig.escalation = { enabled: true, hardFailureRetries: 1 };
	}

	return {
		success: true,
		config: projectConfig,
		fromFile,
	};
}

/**
 * Legacy function - wraps loadPipelineConfig for backward compatibility
 * Throws error if config is invalid (caught by calling code)
 */
export function detectProjectConfig(cwd: string): ProjectConfig {
	const result = loadPipelineConfig(cwd);
	if (!result.success) {
		throw new Error(result.error);
	}
	return result.config;
}
