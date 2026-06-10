/**
 * Formatting utilities for the spec pipeline UI
 */

import type {
	ImplementationStage,
	ImplementationState,
	ModelConfig,
	ProjectConfig,
	WidgetUIContext,
	ErrorDetails,
} from "./types.ts";
import { PIPELINE_WIDGET_ID } from "./types.ts";
import { getErrorEmoji, getErrorSuggestion } from "./errors.ts";

// ============================================
// Box Formatting
// ============================================

/**
 * Create a formatted box with title and content
 * Uses Unicode box-drawing characters for visual appeal
 */
export function formatBox(
	title: string,
	content: string[],
	width: number = 60,
): string {
	const lines: string[] = [];
	const innerWidth = width - 4; // Account for "│ " and " │"

	// Top border with title
	const titlePadded = ` ${title} `;
	const titleLen = titlePadded.length;
	const leftBorder = Math.floor((width - titleLen - 2) / 2);
	const rightBorder = width - titleLen - leftBorder - 2;
	lines.push(
		`┌${"─".repeat(leftBorder)}${titlePadded}${"─".repeat(rightBorder)}┐`,
	);

	// Content lines
	for (const line of content) {
		// Word-wrap long lines
		if (line.length <= innerWidth) {
			lines.push(`│ ${line.padEnd(innerWidth)} │`);
		} else {
			// Word-boundary aware wrapping
			let remaining = line;
			while (remaining.length > 0) {
				if (remaining.length <= innerWidth) {
					lines.push(`│ ${remaining.padEnd(innerWidth)} │`);
					break;
				}
				// Find last space within the width limit
				let breakPoint = remaining.lastIndexOf(" ", innerWidth);
				if (breakPoint <= 0) {
					// No space found, fall back to hard break
					breakPoint = innerWidth;
				}
				const chunk = remaining.slice(0, breakPoint);
				remaining = remaining.slice(breakPoint).trimStart();
				lines.push(`│ ${chunk.padEnd(innerWidth)} │`);
			}
		}
	}

	// Bottom border
	lines.push(`└${"─".repeat(width - 2)}┘`);

	return lines.join("\n");
}

/**
 * Create a simple divider line
 */
export function formatDivider(width: number = 60): string {
	return "─".repeat(width);
}

/**
 * Format a key-value pair with consistent alignment
 */
export function formatKeyValue(
	key: string,
	value: string,
	keyWidth: number = 14,
): string {
	return `${key.padEnd(keyWidth)}: ${value}`;
}

// ============================================
// Step & Banner Formatting
// ============================================

/**
 * Format a step notification banner for pipeline progress
 * These notifications stay visible in the terminal after resize
 */
export function formatStepBanner(
	step: string,
	details?: string,
	emoji?: string,
): string {
	const icon = emoji || "▶";
	const lines: string[] = [];
	lines.push("");
	lines.push(formatDivider(50));
	lines.push(`  ${icon} ${step}`);
	if (details) {
		lines.push(`     ${details}`);
	}
	lines.push(formatDivider(50));
	lines.push("");
	return lines.join("\n");
}

// ============================================
// Model Config Formatting
// ============================================

/**
 * Format model config for display
 */
export function formatModelConfig(config: ModelConfig): string {
	return config.model === "$default"
		? "(user default)"
		: `${config.model}/${config.thinking}`;
}

/**
 * Format effective configuration for display at startup (R5)
 */
export function formatEffectiveConfig(
	config: ProjectConfig,
	fromFile: boolean,
): string {
	const lines: string[] = [];

	lines.push(formatDivider(60));
	lines.push(
		`  📋 Configuration${fromFile ? " (from .pi/spec-pipeline.json)" : " (defaults)"}`,
	);
	lines.push(formatDivider(60));
	lines.push("");

	if (config.usingDefaultModels) {
		lines.push(
			"  ⚠️  No .pi/spec-pipeline.json found. All pipeline roles will use your",
		);
		lines.push(
			"     current default model (no --model override). Create .pi/spec-pipeline.json",
		);
		lines.push("     to configure specific models per role.");
		lines.push("");
	}

	// Model configurations
	lines.push("  Model Configurations:");
	lines.push(
		`    planDrafter       : ${formatModelConfig(config.models.planDrafter)}`,
	);
	lines.push(
		`    implementer       : ${formatModelConfig(config.models.implementer)}`,
	);
	lines.push(
		`    codeReviewer      : ${formatModelConfig(config.models.codeReviewer)}`,
	);
	lines.push(
		`    addressReview     : ${formatModelConfig(config.models.addressReview)}`,
	);
	lines.push(
		`    agentCommitMessageWriter: ${formatModelConfig(config.models.agentCommitMessageWriter)}`,
	);
	lines.push("");

	// Review cycles
	lines.push("  Review Cycles:");
	lines.push(
		`    codeReviewer: ${config.reviewCycles === 0 ? "skipped" : config.reviewCycles}`,
	);
	lines.push("");

	lines.push(formatDivider(60));

	return lines.join("\n");
}

// ============================================
// Stage Formatting
// ============================================

/**
 * Format implementation stage for display
 */
export function formatImplStage(stage: ImplementationStage): string {
	const stageNames: Record<ImplementationStage, string> = {
		plan_generation: "📋 Plan Generation",
		implementation: "🚀 Implementation",
		completed: "✅ Completed",
		cancelled: "❌ Cancelled",
	};
	return stageNames[stage] || stage;
}

// ============================================
// Agent Output Formatting
// ============================================

/**
 * Generate a summary of agent output for persistent display
 * Extracts key information and truncates to reasonable length
 */
export function summarizeAgentOutput(
	output: string,
	maxLines: number = 10,
	maxChars: number = 800,
): string {
	if (!output || output.trim().length === 0) {
		return "(no output)";
	}

	const lines = output.trim().split("\n");

	// If output is short enough, return as-is
	if (lines.length <= maxLines && output.length <= maxChars) {
		return output.trim();
	}

	// Take first few and last few lines for context
	const headLines = Math.ceil(maxLines * 0.6);
	const tailLines = maxLines - headLines;

	let summary: string[] = [];

	if (lines.length > maxLines) {
		summary = [
			...lines.slice(0, headLines),
			`  ... (${lines.length - maxLines} lines omitted) ...`,
			...lines.slice(-tailLines),
		];
	} else {
		summary = lines;
	}

	let result = summary.join("\n");

	// Truncate if still too long
	if (result.length > maxChars) {
		result = result.slice(0, maxChars - 20) + "\n  ... (truncated)";
	}

	return result;
}

/**
 * Format agent completion notification
 */
export function formatAgentSummary(
	role: string,
	model: string,
	output: string,
	emoji: string = "✅",
	phase?: number,
	cycleInfo?: string,
): string {
	const lines: string[] = [];
	let header = `${emoji} ${role} complete (${model})`;
	if (phase !== undefined) {
		header += ` [Phase ${phase}]`;
	}
	if (cycleInfo) {
		header += ` ${cycleInfo}`;
	}
	lines.push(header);
	lines.push("─── Output Summary ───");
	lines.push(summarizeAgentOutput(output));
	lines.push("─── End Summary ───");
	return lines.join("\n");
}

// ============================================
// Implementation State Formatting
// ============================================

/**
 * Format implementation state for display
 */
export function formatImplState(state: ImplementationState): string {
	const lines: string[] = [];

	// Header section
	lines.push(formatDivider(50));
	lines.push(`  Implementation: ${state.id || "unknown"}`);
	lines.push(formatDivider(50));
	lines.push("");

	// Basic info section
	lines.push("📋 Basic Information");
	lines.push(formatKeyValue("  Spec Path", state.specPath));
	lines.push(formatKeyValue("  Stage", formatImplStage(state.stage)));
	lines.push(formatKeyValue("  Created", state.createdAt));
	lines.push(formatKeyValue("  Updated", state.updatedAt));
	if (state.skipPlanGeneration) {
		lines.push(formatKeyValue("  Plan Gen", "Skipped (--no-plan)"));
	}

	// Git section
	if (
		(state.checkpoints && state.checkpoints.length > 0) ||
		state.errorStash ||
		state.worktree
	) {
		lines.push("");
		lines.push("📦 Git");
		if (state.checkpoints && state.checkpoints.length > 0) {
			lines.push(formatKeyValue("  Commits", String(state.checkpoints.length)));
		}
		if (state.errorStash) {
			lines.push(
				formatKeyValue(
					"  Error Stash",
					state.errorStash + " (will be dropped on resume)",
				),
			);
		}
		if (state.worktree) {
			lines.push(formatKeyValue("  Branch", state.worktree.branch));
			lines.push(formatKeyValue("  Worktree", state.worktree.path));
		}
	}

	// Phases section
	const phases = state.phases || [];
	const phasesGenerated = state.phasesGenerated || [];
	if (phases.length > 0) {
		lines.push("");
		lines.push("🏗️ Implementation Phases");
		const generatedCount = phasesGenerated.filter(Boolean).length;
		lines.push(formatKeyValue("  Total Phases", String(phases.length)));
		lines.push(
			formatKeyValue("  Plans Ready", `${generatedCount}/${phases.length}`),
		);

		if (state.stage === "implementation") {
			lines.push(
				formatKeyValue(
					"  Current Phase",
					`${state.currentPhaseIndex + 1}/${phases.length}`,
				),
			);
			if (state.reviewCyclesCompleted !== undefined) {
				lines.push(
					formatKeyValue(
						"  Review Cycles",
						String(state.reviewCyclesCompleted || 0),
					),
				);
			} else {
				lines.push(
					formatKeyValue("  Review Cycle", String(state.currentReviewCycle)),
				);
			}

			// Show phase names with progress indicators
			lines.push("");
			lines.push("  Phase Progress:");
			for (let i = 0; i < phases.length && i < 5; i++) {
				const phase = phases[i] || "(unnamed phase)";
				const phaseName = phase.slice(0, 30) + (phase.length > 30 ? "..." : "");
				let status = "  ⬜"; // Pending
				if (i < state.currentPhaseIndex) {
					status = "  ✅"; // Completed
				} else if (i === state.currentPhaseIndex) {
					status = "  🔄"; // In progress
				}
				lines.push(`  ${status} Phase ${i + 1}: ${phaseName}`);
			}
			if (phases.length > 5) {
				lines.push(`    ... and ${phases.length - 5} more phases`);
			}
		}
	}

	// Error section
	if (state.lastError) {
		lines.push("");
		formatErrorSection(lines, state.lastError);
	}

	// Escalations section (R9)
	if (state.escalations && state.escalations.length > 0) {
		lines.push("");
		lines.push(`Escalations: ${state.escalations.length}`);
		for (const esc of state.escalations) {
			const cycleStr = esc.cycle !== undefined ? ` cycle ${esc.cycle}` : "";
			lines.push(
				`  ⬆️ phase ${esc.phase}${cycleStr}: ${esc.role} ${esc.fromModel} → ${esc.toModel} (${esc.reason})`,
			);
		}
	}

	lines.push("");
	lines.push(formatDivider(50));

	return lines.join("\n");
}

/**
 * Helper: format error section for state display
 */
function formatErrorSection(
	lines: string[],
	lastError: ErrorDetails | string | undefined,
): void {
	if (typeof lastError === "string") {
		lines.push("❌ Last Error (Legacy)");
		lines.push(
			`  ${lastError.slice(0, 200)}${lastError.length > 200 ? "..." : ""}`,
		);
	} else if (lastError) {
		const emoji = getErrorEmoji(lastError.errorType);
		const content: string[] = [];

		content.push(formatKeyValue("Timestamp", lastError.timestamp));
		content.push(
			formatKeyValue("Agent", `${lastError.agent} (${lastError.role})`),
		);

		if (lastError.phase !== undefined) {
			let phaseInfo = `Phase ${lastError.phase}`;
			if (lastError.cycle !== undefined) {
				phaseInfo += `, Cycle ${lastError.cycle}`;
			}
			content.push(formatKeyValue("Phase", phaseInfo));
		}

		content.push(
			formatKeyValue("Error Type", `${emoji} ${lastError.errorType}`),
		);
		content.push(formatKeyValue("Exit Code", String(lastError.exitCode)));

		if (lastError.stderr) {
			content.push("");
			content.push("─── Error Message ───");
			const preview =
				lastError.stderr.length > 400
					? lastError.stderr.slice(0, 400) + "..."
					: lastError.stderr;
			for (const line of preview.split("\n").slice(0, 6)) {
				content.push(`  ${line.trim()}`);
			}
		}

		content.push("");
		content.push("─── Recovery ───");
		content.push(`  ${getErrorSuggestion(lastError.errorType)}`);

		lines.push(formatBox(`${emoji} Error Details`, content));
	}
}

// ============================================
// Widget Management
// ============================================

/**
 * Update the persistent pipeline status widget for implementation
 */
export function updateImplWidget(
	ctx: WidgetUIContext,
	state: ImplementationState,
	currentAction?: string,
): void {
	const lines: string[] = [];

	// Header
	const stateId = state.id || "unknown";
	lines.push(`🚀 Implement: ${stateId.slice(0, 16)}...`);
	lines.push(formatDivider(40));

	// Stage indicator
	lines.push(`Stage: ${formatImplStage(state.stage)}`);

	// Phase progress if in implementation
	const widgetPhases = state.phases || [];
	if (widgetPhases.length > 0 && state.stage === "implementation") {
		const completed = state.currentPhaseIndex;
		const total = widgetPhases.length;
		const progressBar = "█".repeat(completed) + "░".repeat(total - completed);
		lines.push(`Phases: [${progressBar}] ${completed + 1}/${total}`);
	}

	// Current action
	if (currentAction) {
		lines.push(formatDivider(40));
		lines.push(`⏳ ${currentAction}`);
	}

	ctx.ui.setWidget(PIPELINE_WIDGET_ID, lines);
}

/**
 * Clear the pipeline status widget
 */
export function clearPipelineWidget(ctx: WidgetUIContext): void {
	ctx.ui.setWidget(PIPELINE_WIDGET_ID, undefined);
}
