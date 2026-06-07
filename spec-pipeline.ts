/**
 * Spec creation pipeline completion logic
 * 
 * Note: Discovery and drafting are handled conversationally in index.ts.
 * This module is called after the user approves the spec to finalize completion.
 * 
 * Currently, the spec pipeline completion is handled directly in index.ts
 * (endSpecDrafting sets stage to "completed" on approval). This module is
 * retained for potential future use (e.g., post-approval processing).
 */

import type {
	SpecState,
	ProjectConfig,
	PipelineUIContext,
} from "./types.ts";
import { saveSpecState } from "./state.ts";
import {
	clearPipelineWidget,
	formatDivider,
	formatKeyValue,
} from "./formatting.ts";

// ============================================
// Main Spec Pipeline Completion
// ============================================

/**
 * Run the spec pipeline completion.
 * Called when the spec is already approved (drafting handled conversationally in index.ts).
 */
export async function runSpecPipeline(
	state: SpecState,
	cwd: string,
	projectConfig: ProjectConfig,
	ctx: PipelineUIContext
): Promise<void> {
	const save = () => saveSpecState(cwd, state);

	// Initialize metrics if not present
	if (!state.metrics) {
		state.metrics = {
			pipelineStartTime: new Date().toISOString(),
			agentCalls: [],
			specReviewCycles: 0,
			specIterations: state.specIteration,
			discoverySkipped: state.discovery?.skipped ?? true,
		};
		save();
	}
	const metrics = state.metrics;

	// ============================================
	// COMPLETION
	// ============================================
	metrics.pipelineEndTime = new Date().toISOString();
	const startTime = new Date(metrics.pipelineStartTime).getTime();
	const endTime = new Date(metrics.pipelineEndTime).getTime();
	metrics.totalDurationMs = endTime - startTime;

	state.stage = "completed";
	save();
	
	clearPipelineWidget(ctx);
	
	const completionLines: string[] = [];
	completionLines.push("");
	completionLines.push(formatDivider(50));
	completionLines.push("  🎉 Spec Creation Complete!");
	completionLines.push(formatDivider(50));
	completionLines.push("");
	completionLines.push(formatKeyValue("  Pipeline ID", state.id));
	completionLines.push(formatKeyValue("  Spec File", state.specFilename));
	completionLines.push(formatKeyValue("  Spec Path", state.specPath));
	
	if (metrics.totalDurationMs) {
		const durationMins = Math.round(metrics.totalDurationMs / 60000);
		completionLines.push(formatKeyValue("  Duration", `${durationMins} min`));
	}
	
	completionLines.push("");
	completionLines.push("  📋 Next Steps:");
	completionLines.push("     • Review the spec");
	completionLines.push(`     • Then run: /implement ${state.specPath}`);
	completionLines.push("");
	completionLines.push(formatDivider(50));
	
	ctx.ui.notify(completionLines.join("\n"), "success");
}
