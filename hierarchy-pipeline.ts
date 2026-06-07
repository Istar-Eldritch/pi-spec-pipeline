/**
 * Hierarchy pipeline post-approval logic (shared by roadmaps and epics)
 *
 * Handles: Child Extraction → Completion
 *
 * Note: Discovery and drafting are handled conversationally in index.ts before this is called.
 * By the time runHierarchyPipeline is called, the document is already approved.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	RoadmapState,
	EpicState,
	HierarchyState,
	HierarchyLevel,
	ProjectConfig,
	PipelineUIContext,
} from "./types.ts";
import {
	saveRoadmapState,
	saveEpicState,
	extractChildItems,
} from "./state.ts";
import {
	clearPipelineWidget,
	formatDivider,
	formatKeyValue,
} from "./formatting.ts";

// ============================================
// State Save Helper
// ============================================

function saveState(cwd: string, state: HierarchyState): void {
	if (state.level === "roadmap") {
		saveRoadmapState(cwd, state as RoadmapState);
	} else {
		saveEpicState(cwd, state as EpicState);
	}
}

/** Get the child type label */
function getChildTypeLabel(level: HierarchyLevel): string {
	return level === "roadmap" ? "epics" : "features";
}

// ============================================
// Main Hierarchy Pipeline (Post-Approval)
// ============================================

/**
 * Run the hierarchy pipeline post-approval: child extraction and completion.
 *
 * By the time this is called, the document should already be approved
 * (drafting and user approval are handled conversationally in index.ts).
 *
 * @param state The roadmap or epic state (must have docApproved === true)
 * @param cwd Working directory
 * @param projectConfig Project configuration
 * @param ctx UI context
 * @param parentContext Optional context from parent document
 */
export async function runHierarchyPipeline(
	state: HierarchyState,
	cwd: string,
	projectConfig: ProjectConfig,
	ctx: PipelineUIContext,
	parentContext?: string
): Promise<void> {
	const level = state.level;
	const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
	const childLabel = getChildTypeLabel(level);

	const save = () => saveState(cwd, state);

	// Initialize metrics if not present
	if (!state.metrics) {
		state.metrics = {
			pipelineStartTime: new Date().toISOString(),
			agentCalls: [],
			specReviewCycles: 0,
			specIterations: state.docIteration,
			discoverySkipped: state.discovery?.skipped ?? true,
		};
		save();
	}
	const metrics = state.metrics;

	// ============================================
	// CHILD EXTRACTION
	// ============================================
	if (state.docApproved && state.children.length === 0) {
		// Re-read the approved document
		const fullDocPath = path.join(cwd, state.docPath);
		if (fs.existsSync(fullDocPath)) {
			state.docContent = fs.readFileSync(fullDocPath, "utf-8");
		}

		const children = extractChildItems(state.docContent);
		if (children.length === 0) {
			ctx.ui.notify(`⚠️ No child items table found in the ${level} document. You can add ${childLabel} manually later.`, "warning");
		} else {
			state.children = children;
			save();
			ctx.ui.notify(`📦 Extracted ${children.length} ${childLabel} from the ${level} document`, "success");
		}
	}

	// ============================================
	// COMPLETION
	// ============================================
	metrics.pipelineEndTime = new Date().toISOString();
	const startTime = new Date(metrics.pipelineStartTime).getTime();
	const endTime = new Date(metrics.pipelineEndTime).getTime();
	metrics.totalDurationMs = endTime - startTime;

	state.stage = "approved";
	save();

	clearPipelineWidget(ctx);

	const completionLines: string[] = [];
	completionLines.push("");
	completionLines.push(formatDivider(50));
	completionLines.push(`  🎉 ${levelLabel} Creation Complete!`);
	completionLines.push(formatDivider(50));
	completionLines.push("");
	completionLines.push(formatKeyValue("  Pipeline ID", state.id));
	completionLines.push(formatKeyValue("  Document", state.docFilename));
	completionLines.push(formatKeyValue("  Document Path", state.docPath));

	if (metrics.totalDurationMs) {
		const durationMins = Math.round(metrics.totalDurationMs / 60000);
		completionLines.push(formatKeyValue("  Duration", `${durationMins} min`));
	}

	if (state.children.length > 0) {
		completionLines.push("");
		completionLines.push(`  📦 ${state.children.length} ${childLabel} ready to create:`);
		for (const child of state.children) {
			const deps = child.dependencies.length > 0 ? ` (deps: ${child.dependencies.join(", ")})` : "";
			completionLines.push(`     ${child.number}. ${child.name} [${child.priority}]${deps}`);
		}
		completionLines.push("");
		completionLines.push("  📋 Next Steps:");
		completionLines.push(`     • Review the ${level} document`);
		if (level === "roadmap") {
			completionLines.push("     • Use /epic <description> to create each epic");
		} else {
			completionLines.push("     • Use /spec <description> to create each feature spec");
		}
		completionLines.push("     • The agent will suggest next steps but won't auto-start");
	} else {
		completionLines.push("");
		completionLines.push("  📋 Next Steps:");
		completionLines.push(`     • Review the ${level} document`);
	}

	completionLines.push("");
	completionLines.push(formatDivider(50));

	ctx.ui.notify(completionLines.join("\n"), "success");
}
