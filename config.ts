/**
 * Configuration loading, validation, and defaults for the spec pipeline
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
} as const;

/** Default code review cycle count. Set to 0 to skip code review. */
export const DEFAULT_REVIEW_CYCLES: NormalizedReviewCycles = 2;

/** Default base path for git worktrees used by /implement (relative to the project root). */
export const DEFAULT_WORKTREE_BASE_PATH = ".pi/worktrees";

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
	projectToolStreamIdleTimeoutMs: number | undefined,
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
	};

	// Apply project-level streamIdleTimeoutMs as fallback when per-role isn't set.
	// (Model-stream watchdog — gaps while no tool is running.)
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

	// Apply project-level toolStreamIdleTimeoutMs as fallback when per-role isn't set.
	// (Tool-execution watchdog — gaps while a tool is running. Defaults to 0 /
	// disabled since tools have their own timeouts and pi emits no heartbeat
	// during long tool runs.)
	if (projectToolStreamIdleTimeoutMs !== undefined) {
		for (const role of Object.keys(models) as Array<keyof typeof models>) {
			if (models[role].toolStreamIdleTimeoutMs === undefined) {
				models[role] = {
					...models[role],
					toolStreamIdleTimeoutMs: projectToolStreamIdleTimeoutMs,
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
	// to read-only review roles (testing instructions).
	const projectContextForReviewer = projectContext;

	if (testCommand) {
		projectContext += `\n## Testing\n\nYou MUST run tests with: \`${testCommand}\`\n`;
	}

	// Snapshot for roles that run tests (implementer, addressReview).
	const projectContextForFixer = projectContext;

	// Merge model configs with defaults (R3, R5)
	// Note: commitMessageWriter in config.models is silently ignored (R5a)
	const { models, reviewCycles } = mergeWithDefaults(
		config.models,
		config.tiers,
		config.reviewCycles,
		config.streamIdleTimeoutMs,
		config.toolStreamIdleTimeoutMs,
	);

	// Skip plan generation (experimental A/B testing)
	const skipPlanGeneration = config.skipPlanGeneration ?? false;

	// Normalize tier configs with the project-level streamIdleTimeoutMs fallback,
	// identical to the per-role normalization already done inside mergeWithDefaults.
	// Without this, escalated-tier agents receive a ModelConfig without
	// streamIdleTimeoutMs and fall back to the hardcoded 90 s watchdog default,
	// even when the project config specifies a much longer timeout.
	//
	// Also propagate toolStreamIdleTimeoutMs (the tool-execution budget) so
	// escalated tiers inherit the same tool-watchdog policy as base roles.
	const normalizedTiers: typeof config.tiers = (() => {
		if (
			!config.tiers ||
			(config.streamIdleTimeoutMs === undefined &&
				config.toolStreamIdleTimeoutMs === undefined)
		)
			return config.tiers;
		const result = { ...config.tiers };
		for (const tier of ["strong", "mid", "cheap"] as const) {
			const t = result[tier];
			if (!t) continue;
			const patch: Partial<typeof t> = {};
			if (
				config.streamIdleTimeoutMs !== undefined &&
				t.streamIdleTimeoutMs === undefined
			) {
				patch.streamIdleTimeoutMs = config.streamIdleTimeoutMs;
			}
			if (
				config.toolStreamIdleTimeoutMs !== undefined &&
				t.toolStreamIdleTimeoutMs === undefined
			) {
				patch.toolStreamIdleTimeoutMs = config.toolStreamIdleTimeoutMs;
			}
			if (Object.keys(patch).length > 0) {
				result[tier] = { ...t, ...patch };
			}
		}
		return result;
	})();

	// Normalize worktree config (FR-1.2).
	// setupScript is absent when missing, null, or whitespace-only.
	const rawSetupScript = config.worktree?.setupScript;
	const normalizedSetupScript =
		typeof rawSetupScript === "string" && rawSetupScript.trim().length > 0
			? rawSetupScript.trim()
			: undefined;

	return {
		testCommand,
		contextFiles: foundFiles,
		projectContext,
		projectContextForReviewer,
		projectContextForFixer,
		models,
		tiers: normalizedTiers,
		escalation: normalizeEscalation(config.escalation),
		reviewCycles,
		skipPlanGeneration,
		streamIdleTimeoutMs: config.streamIdleTimeoutMs,
		toolStreamIdleTimeoutMs: config.toolStreamIdleTimeoutMs,
		worktree: {
			basePath: config.worktree?.basePath ?? DEFAULT_WORKTREE_BASE_PATH,
			...(normalizedSetupScript !== undefined
				? { setupScript: normalizedSetupScript }
				: {}),
		},
	};
}

/**
 * Try to resolve the main git repository path when running inside a worktree.
 * Git worktrees have a `.git` file (not directory) containing `gitdir: <path>`.
 * Returns the main repo root or null if not a worktree.
 */
export function resolveMainRepoFromWorktree(cwd: string): string | null {
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
		// Remove .git/worktrees/<name> → go up 3 levels.
		// Use join(path.sep) instead of path.join() to preserve the leading
		// empty segment on absolute paths (e.g. ["" "tmp" "repo"] → "/tmp/repo").
		if (parts.length >= 3) {
			const mainRepo = parts.slice(0, -3).join(path.sep);
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
 *
 * Unknown/removed fields in the JSON (e.g. specTemplate, roadmapDrafter) are
 * silently ignored — TypeBox does not reject additional properties by default.
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
