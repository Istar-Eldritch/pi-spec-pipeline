/**
 * Spec Pipeline Extension
 *
 * Split into two separate workflows:
 *
 * SPEC CREATION (/spec):
 *   1. Discovery (optional): Conversational — LLM proposes assumptions one at a time for user to confirm
 *   2. Spec Drafting: Conversational — user guides LLM to write specification
 *   3. User Approval: User approves, requests revisions, or cancels
 *   4. User reviews and approves the spec
 *
 * HIERARCHY (/roadmap, /epic):
 *   1. Discovery (optional): Conversational — LLM proposes assumptions one at a time for user to confirm
 *   2. Drafting: Conversational — user guides LLM to write document
 *   3. User Approval: User approves, requests revisions, or cancels
 *   4. Child extraction (auto-parses child items table from document)
 *   5. User reviews and approves the document
 *
 * IMPLEMENTATION (/implement):
 *   1. Takes EITHER a spec file path OR a description as input
 *      - File path: Reads spec and starts implementation
 *      - Description: Enters discovery mode → writes summary → starts implementation
 *   2. Discovery (if using description): Conversational — LLM proposes assumptions
 *   3. For each implementation phase (plan + implement interleaved):
 *      - Plan Drafting: GPT-5.5 drafts implementation plan
 *      - Implementation: GPT-5.5 implements according to plan
 *      - Code Review: GPT-5.4 reviews implementation
 *   3. User reviews the implementation
 *
 * Usage:
 *   /plan <description>                             # Conversational scoping → recommends roadmap/epic/spec
 *   /plan-done                                      # Accept or override scoping recommendation
 *   /plan-cancel                                    # Cancel scoping session
 *   /plan --roadmap <description>                   # Skip scoping, create roadmap
 *   /plan --epic <description>                      # Skip scoping, create epic
 *   /plan --feature <description>                   # Skip scoping, create feature spec
 *
 *   /roadmap <description>                          # Create a roadmap (→ epics)
 *   /roadmap-resume                                 # Resume roadmap pipeline
 *   /roadmap-status                                 # Show roadmap status
 *   /roadmap-list                                   # List roadmaps
 *   /roadmap-cancel                                 # Cancel roadmap pipeline
 *
 *   /epic <description>                             # Create an epic (→ feature specs)
 *   /epic --roadmap <id> <description>              # Create epic linked to roadmap
 *   /epic-resume                                    # Resume epic pipeline
 *   /epic-status                                    # Show epic status
 *   /epic-list                                      # List epics
 *   /epic-cancel                                    # Cancel epic pipeline
 *
 *   /plan-overview [id]                             # Show full hierarchy tree
 *
 *   /spec <description>                             # Start spec creation
 *   /spec --quick <description>                     # Skip discovery phase
 *   /spec-resume                                    # Resume spec creation
 *   /spec-status                                    # Show spec status
 *   /spec-list                                      # List spec pipelines
 *   /spec-cancel                                    # Cancel spec pipeline
 *
 *   /implement <spec-path|description>              # Start implementation (file or discovery)
 *   /implement --no-plan <spec-path|description>    # Skip plan generation
 *   /implement --no-review <spec-path|description>  # Skip reviews
 *   /implement-resume                               # Resume implementation
 *   /implement-status                               # Show implementation status
 *   /implement-list                                 # List implementations
 *   /implement-cancel                               # Cancel implementation
 *   /implement-metrics [id]                         # Export metrics
 *
 * Configuration:
 *   Create .pi/spec-pipeline.json in your project root (same config for both)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// Import types
import type {
	ImplementationState,
	ProjectConfig,
	RoleName,
} from "./types.ts";

// Import config
import { loadPipelineConfig, getEscalatedModelConfig } from "./config.ts";

// Import state management
import {
	loadImplState,
	saveImplState,
	listImplStates,
	getLatestActiveImplPipeline,
	createInitialImplState,
	generateTimestamp,
	generatePipelineId,
	getStateDir,
	getImplStateDir,
	getSessionLogDir,
} from "./state.ts";

// Import git operations
import {
	validateGitRepo,
	checkGitClean,
	stashExists,
	dropStash,
	createAgentCommit,
} from "./git.ts";

// Import error handling
import {
	getErrorEmoji,
	getErrorSuggestion,
	formatErrorForRetry,
	formatErrorBox,
	truncateString,
} from "./errors.ts";

// Import formatting
import {
	formatStepBanner,
	formatEffectiveConfig,
	formatImplStage,
	formatImplState,
	formatDivider,
	formatKeyValue,
	updateImplWidget,
	clearPipelineWidget,
} from "./formatting.ts";

// Import agents

// Import review
import { retryFailedOperation } from "./review.ts";
import { recordEscalation } from "./escalation.ts";
import { runAgentWithConfig } from "./agents.ts";

// Import pipelines
import { runImplementPipeline, extractPhases } from "./implement-pipeline.ts";

// Import system prompts
import { createSystemPrompts, buildPromptOptions } from "./agents-config.ts";

// ============================================
// Helpers
// ============================================

function installBundledSubagents(): void {
	try {
		const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
		const sourceDir = path.join(extensionRoot, "agents");
		const targetDir = path.join(os.homedir(), ".pi", "agent", "agents");

		if (!fs.existsSync(sourceDir)) return;
		fs.mkdirSync(targetDir, { recursive: true });

		for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

			const sourcePath = path.join(sourceDir, entry.name);
			const targetPath = path.join(targetDir, entry.name);
			const sourceContent = fs.readFileSync(sourcePath, "utf-8");

			if (fs.existsSync(targetPath)) continue;

			fs.writeFileSync(targetPath, sourceContent);
		}
	} catch (error) {
		console.warn(
			`spec-pipeline could not install bundled subagents: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}


export default function (pi: ExtensionAPI) {
	installBundledSubagents();


	// ============================================
	// IMPLEMENTATION COMMANDS
	// ============================================

	pi.registerCommand("implement", {
		description:
			"Start implementation from a delivery-plan file. Use --no-plan to skip plan generation, --no-review to skip reviews, --auto to run without interactive TTY.",
		handler: async (args, ctx) => {
			const argsStr = args || "";
			const autoMode = argsStr.includes("--auto");

			if (!ctx.hasUI && !autoMode) {
				ctx.ui.notify(
					"spec-pipeline requires interactive mode. Use --auto for non-interactive (agent-driven) runs.",
					"error",
				);
				return;
			}

			const noPlan = argsStr.includes("--no-plan");
			const noReview = argsStr.includes("--no-review");
			const argWithoutFlags = argsStr
				.replace("--no-plan", "")
				.replace("--no-review", "")
				.replace("--auto", "")
				.replace(/\s+/g, " ")
				.trim();

			if (!argWithoutFlags) {
				ctx.ui.notify(
					"Usage: /implement [--no-plan] [--no-review] [--auto] <delivery-plan.md>",
					"error",
				);
				return;
			}

			const cwd = ctx.cwd;

			// Check if argument is a file path
			const fullPath = path.isAbsolute(argWithoutFlags)
				? argWithoutFlags
				: path.join(cwd, argWithoutFlags);

			// Check if it's an existing file first (handles edge cases like "fix/bug-123" or files without extensions)
			const isFile = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();

			// Heuristic: if it looks like a file path but doesn't exist, show error
			const looksLikeFilePath =
				argWithoutFlags.includes("/") || /\.(md|typ)$/i.test(argWithoutFlags);
			if (looksLikeFilePath && !isFile) {
				ctx.ui.notify(`Spec file not found: ${argWithoutFlags}`, "error");
				return;
			}

			// If it's a valid file, continue with existing implementation logic
			if (isFile) {
				// *** EXISTING FILE-BASED IMPLEMENTATION LOGIC CONTINUES HERE ***
				const specPath = argWithoutFlags;
				const fullSpecPath = fullPath;
				const specContent = fs.readFileSync(fullSpecPath, "utf-8");
				if (!specContent.trim()) {
					ctx.ui.notify("Spec file is empty", "error");
					return;
				}

				// Make specPath relative to cwd
				const relativeSpecPath = path.isAbsolute(specPath)
					? path.relative(cwd, specPath)
					: specPath;

				// Move autoMode into the closure scope so other functions can read it (if needed)
				const isAutoMode = autoMode;

				// Check for existing active implementation
				const existingPipeline = getLatestActiveImplPipeline(cwd);
				if (existingPipeline && !isAutoMode) {
					const resume = await ctx.ui.confirm(
						"Active Implementation Found",
						`There's an active implementation:\n${formatImplState(existingPipeline)}\n\nStart a NEW implementation? (No = cancel)`,
					);
					if (!resume) {
						ctx.ui.notify(
							"Use /implement-resume to continue the existing implementation",
							"info",
						);
						return;
					}
				} else if (existingPipeline && isAutoMode) {
					// Auto-mode: skip over existing pipeline detection; start fresh
					ctx.ui.notify(
						"Auto-mode: overriding existing pipeline (starting fresh)",
						"info",
					);
				}

				// Git validation
				const gitValidation = await validateGitRepo(cwd);
				if (!gitValidation.valid) {
					ctx.ui.notify(gitValidation.error!, "error");
					return;
				}

				const gitClean = await checkGitClean(cwd);
				if (!gitClean.clean) {
					ctx.ui.notify(
						"Working directory has uncommitted changes. Please commit or stash first.",
						"error",
					);
					if (gitClean.status) {
						ctx.ui.notify(
							`Changed files:\n${gitClean.status.slice(0, 500)}`,
							"info",
						);
					}
					return;
				}

				// Load config
				const configResult = loadPipelineConfig(cwd);
				if (!configResult.success) {
					ctx.ui.notify(configResult.error, "error");
					return;
				}
				const projectConfig = configResult.config;

				if (noPlan) {
					projectConfig.skipPlanGeneration = true;
				}

				if (noReview) {
					projectConfig.reviewCycles = 0;
				}

				ctx.ui.notify(
					formatEffectiveConfig(projectConfig, configResult.fromFile),
					"info",
				);

				if (noPlan) {
					ctx.ui.notify(
						"⏭️ Plan generation will be skipped (--no-plan flag)",
						"info",
					);
				}

				if (noReview) {
					ctx.ui.notify("⏭️ Reviews will be skipped (--no-review flag)", "info");
				}

				ctx.ui.notify(
					`Starting implementation from: ${relativeSpecPath}`,
					"info",
				);

				// Generate timestamp and names
				const implTimestamp = generateTimestamp();

				// Create initial state
				const state = createInitialImplState(
					relativeSpecPath,
					specContent,
					implTimestamp,
					noPlan,
				);

				state.checkpoints = [];
				saveImplState(cwd, state);

				ctx.ui.notify(
					formatStepBanner("IMPLEMENTATION STARTED", `ID: ${state.id}`, "🚀"),
					"info",
				);
				ctx.ui.notify(`Spec: ${relativeSpecPath}`, "info");

				updateImplWidget(ctx, state, "Initializing...");

				await runImplementPipeline(state, cwd, projectConfig, ctx);
			} else {
				ctx.ui.notify(
					"❌ /implement requires a delivery-plan file.\n\n" +
						"Usage: /implement [--no-plan] [--no-review] [--auto] <delivery-plan.md>\n\n" +
						"To produce a delivery plan, run the delivery-plan-architect agent:\n" +
						'  subagent agent=delivery-plan-architect task="Read <spec-path> and write the delivery plan to <output-path>."',
					"error",
				);
				return;
			}
		},
	});

	pi.registerCommand("implement-resume", {
		description: "Resume an active implementation pipeline",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: ImplementationState | null;
			if (pipelineId) {
				state = loadImplState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Implementation not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveImplPipeline(cwd);
				if (!state) {
					ctx.ui.notify(
						"No active implementation found. Use /implement to start one.",
						"error",
					);
					return;
				}
			}

			if (state.stage === "completed") {
				ctx.ui.notify("This implementation is already completed.", "info");
				return;
			}

			if (state.stage === "cancelled") {
				const restart = await ctx.ui.confirm(
					"Implementation Cancelled",
					"This implementation was cancelled. Restart from where it left off?",
				);
				if (!restart) return;

				if (
					state.stageBeforeCancellation &&
					state.stageBeforeCancellation !== "cancelled"
				) {
					ctx.ui.notify(
						`Resuming from saved stage: ${formatImplStage(state.stageBeforeCancellation)}`,
						"info",
					);
					state.stage = state.stageBeforeCancellation;
					state.stageBeforeCancellation = undefined;
				} else {
					// Plan generation and implementation are now interleaved per-phase,
					// so always resume into "implementation" stage
					state.stage = "implementation";
				}
				saveImplState(cwd, state);
			}

			// Git validation
			const gitValidation = await validateGitRepo(cwd);
			if (!gitValidation.valid) {
				ctx.ui.notify(gitValidation.error!, "error");
				return;
			}

			const gitClean = await checkGitClean(cwd);
			if (!gitClean.clean) {
				ctx.ui.notify(
					"Working directory has uncommitted changes. Please commit or stash first.",
					"error",
				);
				if (gitClean.status) {
					ctx.ui.notify(
						`Changed files:\n${gitClean.status.slice(0, 500)}`,
						"info",
					);
				}
				return;
			}

			// Clean up error stash if present
			if (state.errorStash) {
				const stashStillExists = await stashExists(cwd, state.errorStash);
				if (stashStillExists) {
					ctx.ui.notify(
						"Dropping stashed changes from previous error...",
						"info",
					);
					await dropStash(cwd, state.errorStash);
				}
				state.errorStash = undefined;
				saveImplState(cwd, state);
			}

			ctx.ui.notify(
				formatStepBanner("RESUMING IMPLEMENTATION", `ID: ${state.id}`, "🔄"),
				"info",
			);
			ctx.ui.notify(`Current stage: ${formatImplStage(state.stage)}`, "info");

			if (state.skipPlanGeneration) {
				ctx.ui.notify("📌 Plan generation is skipped (--no-plan)", "info");
			}

			updateImplWidget(ctx, state, "Resuming...");

			const configResult = loadPipelineConfig(cwd);
			if (!configResult.success) {
				ctx.ui.notify(configResult.error, "error");
				return;
			}
			const projectConfig = configResult.config;

			// Handle error retry
			if (state.lastError) {
				if (typeof state.lastError === "string") {
					ctx.ui.notify(
						`Previous error (legacy): ${state.lastError.slice(0, 200)}`,
						"warning",
					);
					state.lastError = undefined;
					saveImplState(cwd, state);
				} else if (state.lastError.agentTask) {
					const errorDisplay = formatErrorForRetry(state.lastError, state);
					ctx.ui.notify(errorDisplay, "info");

					const shouldRetry = await ctx.ui.confirm(
						"Retry Failed Operation?",
						`The implementation failed at ${state.lastError.role}.\n\nRetry the same operation?`,
					);

					if (!shouldRetry) {
						ctx.ui.notify("Resume cancelled.", "info");
						return;
					}

					const errPhase = state.lastError.phase;
					const errCycle = state.lastError.cycle;
					const retrySuccess = await retryFailedOperation(
						state,
						cwd,
						projectConfig,
						() => saveImplState(cwd, state),
						ctx,
						{
							config: getEscalatedModelConfig(
								projectConfig,
								state.lastError.role as RoleName,
							),
							onEscalate: ({ role, fromModel, toModel, reason }) =>
								recordEscalation(
									cwd,
									state,
									{
										role,
										phase: errPhase,
										cycle: errCycle,
										fromModel,
										toModel,
										reason,
									},
									() => saveImplState(cwd, state),
									(msg, type) => ctx.ui.notify(msg, type),
								),
						},
					);

					if (!retrySuccess) {
						ctx.ui.notify(
							"Retry failed. Run /implement-resume to try again.",
							"info",
						);
						return;
					}

					ctx.ui.notify("Retry successful! Continuing pipeline...", "success");
				} else {
					state.lastError = undefined;
					saveImplState(cwd, state);
				}
			}

			await runImplementPipeline(state, cwd, projectConfig, ctx);
		},
	});

	pi.registerCommand("implement-status", {
		description: "Show implementation status",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: ImplementationState | null;
			if (pipelineId) {
				state = loadImplState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Implementation not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveImplPipeline(cwd);
				if (!state) {
					const states = listImplStates(cwd);
					if (states.length === 0) {
						ctx.ui.notify(
							"No implementations found. Use /implement to start one.",
							"info",
						);
						return;
					}
					state = states[0];
				}
			}

			ctx.ui.notify(formatImplState(state), "info");

			if (state.stage === "completed") {
				ctx.ui.notify("\n✅ Implementation completed.", "success");
			} else if (state.stage === "cancelled") {
				ctx.ui.notify(
					"\n🚫 Cancelled. Use /implement-resume to restart.",
					"info",
				);
			} else if (state.lastError) {
				ctx.ui.notify(
					"\n❌ Stopped due to error. Use /implement-resume to retry.",
					"warning",
				);
			} else {
				ctx.ui.notify("\n▶️ Active. Use /implement-resume to continue.", "info");
			}
		},
	});

	pi.registerCommand("implement-list", {
		description: "List all implementations",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const states = listImplStates(cwd);

			if (states.length === 0) {
				ctx.ui.notify(
					"No implementations found. Use /implement to start one.",
					"info",
				);
				return;
			}

			const lines: string[] = [];
			lines.push(formatDivider(60));
			lines.push(`  🚀 Implementations (${states.length} total)`);
			lines.push(formatDivider(60));
			lines.push("");

			for (const state of states) {
				const hasError = state.lastError !== undefined;
				let statusIcon = "  ";
				if (state.stage === "completed") statusIcon = "✅";
				else if (state.stage === "cancelled") statusIcon = "🚫";
				else if (hasError) statusIcon = "❌";
				else statusIcon = "▶️";

				lines.push(`${statusIcon} ${state.id || "unknown"}`);
				lines.push(`   Spec: ${state.specPath}`);
				lines.push(`   Stage: ${formatImplStage(state.stage)}`);
				const phases = state.phases || [];
				if (phases.length > 0) {
					lines.push(
						`   Phases: ${state.currentPhaseIndex + 1}/${phases.length}`,
					);
				}
				lines.push(`   Updated: ${state.updatedAt}`);
				lines.push("");
			}

			lines.push(formatDivider(60));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("implement-cancel", {
		description: "Cancel an active implementation pipeline",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spec-pipeline requires interactive mode", "error");
				return;
			}

			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let state: ImplementationState | null;
			if (pipelineId) {
				state = loadImplState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Implementation not found: ${pipelineId}`, "error");
					return;
				}
			} else {
				state = getLatestActiveImplPipeline(cwd);
				if (!state) {
					ctx.ui.notify("No active implementation to cancel.", "info");
					return;
				}
			}

			if (state.stage === "completed" || state.stage === "cancelled") {
				ctx.ui.notify("Implementation is already finished.", "info");
				return;
			}

			const confirm = await ctx.ui.confirm(
				"Cancel Implementation?",
				`Cancel implementation ${state.id}?\n\nYou can resume later with /implement-resume.`,
			);

			if (confirm) {
				if (state.stage !== "cancelled") {
					state.stageBeforeCancellation = state.stage;
				}
				state.stage = "cancelled";
				saveImplState(cwd, state);

				clearPipelineWidget(ctx);
				ctx.ui.notify(
					"Implementation cancelled. Resume with /implement-resume",
					"info",
				);
			}
		},
	});

	pi.registerCommand("implement-metrics", {
		description: "Export implementation metrics for A/B testing",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const pipelineId = (args || "").trim();

			let statesToExport: ImplementationState[] = [];

			if (pipelineId === "--all") {
				statesToExport = listImplStates(cwd).filter(
					(s) => s.stage === "completed" && s.metrics,
				);
			} else if (pipelineId) {
				const state = loadImplState(cwd, pipelineId);
				if (!state) {
					ctx.ui.notify(`Implementation not found: ${pipelineId}`, "error");
					return;
				}
				if (state.metrics) {
					statesToExport = [state];
				} else {
					ctx.ui.notify(
						`Implementation ${pipelineId} has no metrics`,
						"warning",
					);
					return;
				}
			} else {
				const states = listImplStates(cwd);
				const completed = states.filter(
					(s) => s.stage === "completed" && s.metrics,
				);
				if (completed.length === 0) {
					ctx.ui.notify(
						"No completed implementations with metrics found.",
						"info",
					);
					return;
				}
				statesToExport = [completed[0]];
			}

			if (statesToExport.length === 0) {
				ctx.ui.notify("No implementations with metrics to export.", "info");
				return;
			}

			const lines: string[] = [];
			lines.push(formatDivider(70));
			lines.push(
				`  📊 Implementation Metrics (${statesToExport.length} pipeline${statesToExport.length > 1 ? "s" : ""})`,
			);
			lines.push(formatDivider(70));
			lines.push("");

			lines.push(
				"| ID | Plan Gen | Duration | Code Review Cycles | First Pass |",
			);
			lines.push(
				"|-----|----------|----------|--------------------|------------|",
			);

			for (const state of statesToExport) {
				const m = state.metrics!;
				const durationMins = m.totalDurationMs
					? Math.round(m.totalDurationMs / 60000)
					: "?";
				const planGen = m.skipPlanGeneration ? "SKIP" : "YES";
				const codeReview = String(m.codeReviewCycles);
				const firstPass = `${m.codeReviewFirstPassRate}%`;

				const stateId = state.id || "unknown";
				lines.push(
					`| ${stateId.slice(0, 16)} | ${planGen.padEnd(8)} | ${String(durationMins).padEnd(8)} | ${codeReview.padEnd(17)} | ${firstPass.padEnd(10)} |`,
				);
			}

			lines.push("");

			if (statesToExport.length === 1) {
				const state = statesToExport[0];
				const m = state.metrics!;

				lines.push("📋 Detailed Metrics:");
				lines.push("");
				lines.push(formatKeyValue("  Pipeline ID", state.id || "unknown"));
				lines.push(formatKeyValue("  Spec Path", state.specPath));
				lines.push(formatKeyValue("  Status", state.stage));
				lines.push("");
				lines.push("  Configuration:");
				lines.push(
					formatKeyValue(
						"    Skip Plan Generation",
						m.skipPlanGeneration ? "Yes (A/B test)" : "No (normal)",
					),
				);
				lines.push("");
				lines.push("  Timing:");
				if (m.totalDurationMs) {
					lines.push(
						formatKeyValue(
							"    Total Duration",
							`${Math.round(m.totalDurationMs / 60000)} minutes`,
						),
					);
				}
				lines.push(
					formatKeyValue("    Agent Calls", String(m.agentCalls.length)),
				);
				lines.push("");
				lines.push("  Review Cycles:");
				lines.push(
					formatKeyValue("    Code Review", String(m.codeReviewCycles)),
				);
				lines.push("");
				lines.push("  Quality:");
				lines.push(
					formatKeyValue(
						"    First Pass Rate",
						`${m.codeReviewFirstPassRate}%`,
					),
				);
				lines.push("");

				const callsByRole: Record<string, number> = {};
				for (const call of m.agentCalls) {
					callsByRole[call.role] = (callsByRole[call.role] || 0) + 1;
				}
				lines.push("  Agent Calls by Role:");
				for (const [role, count] of Object.entries(callsByRole)) {
					lines.push(`    ${role}: ${count}`);
				}

				// Escalations section (R10b)
				if (state.escalations && state.escalations.length > 0) {
					lines.push("");
					lines.push(`## Escalations (${state.escalations.length})`);
					for (const esc of state.escalations) {
						const cycleStr =
							esc.cycle !== undefined ? ` cycle ${esc.cycle}` : "";
						lines.push(
							`- phase ${esc.phase}${cycleStr}: ${esc.role} ${esc.fromModel} → ${esc.toModel} (${esc.reason}) at ${esc.timestamp}`,
						);
					}
				}
			}

			lines.push("");
			lines.push(formatDivider(70));

			const stateDir = getStateDir(cwd);
			if (!fs.existsSync(stateDir)) {
				fs.mkdirSync(stateDir, { recursive: true });
			}
			const exportPath = path.join(stateDir, "metrics-export.json");
			const exportData = statesToExport.map((s) => ({
				id: s.id,
				specPath: s.specPath,
				stage: s.stage,
				createdAt: s.createdAt,
				metrics: s.metrics,
			}));
			fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
			lines.push(`\n📁 Full metrics exported to: ${exportPath}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
