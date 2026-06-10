/**
 * Error handling for the spec pipeline
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ErrorType,
	ErrorDetails,
	AgentName,
	RoleName,
	AgentResult,
	ImplementationState,
} from "./types.ts";
import { getStateDir } from "./state.ts";

// Union type for states that have error-related fields
type ErrorableState = ImplementationState;
import { stashChanges } from "./git.ts";
import { formatBox, formatKeyValue, formatDivider } from "./formatting.ts";

// ============================================
// Error Classification
// ============================================

/**
 * Classify error type from stderr output
 */
export function classifyError(stderr: string | undefined): ErrorType {
	if (!stderr) return "UNKNOWN";

	const lowerStderr = stderr.toLowerCase();

	// Rate limit detection (HTTP 429 or rate limit text)
	if (
		lowerStderr.includes("429") ||
		lowerStderr.includes("rate limit") ||
		lowerStderr.includes("rate_limit") ||
		lowerStderr.includes("ratelimit") ||
		lowerStderr.includes("too many requests")
	) {
		return "RATE_LIMIT";
	}

	// Timeout detection
	if (
		lowerStderr.includes("timeout") ||
		lowerStderr.includes("timed out") ||
		lowerStderr.includes("etimedout")
	) {
		return "TIMEOUT";
	}

	// Network error detection
	if (
		lowerStderr.includes("econnrefused") ||
		lowerStderr.includes("enotfound") ||
		lowerStderr.includes("network") ||
		lowerStderr.includes("connection") ||
		lowerStderr.includes("socket") ||
		lowerStderr.includes("dns")
	) {
		return "NETWORK";
	}

	// Validation error detection
	if (
		lowerStderr.includes("invalid") ||
		lowerStderr.includes("validation") ||
		lowerStderr.includes("malformed") ||
		lowerStderr.includes("parse error")
	) {
		return "VALIDATION";
	}

	// Token/context/output limit detection
	if (
		lowerStderr.includes("max tokens") ||
		lowerStderr.includes("maximum tokens") ||
		lowerStderr.includes("context length") ||
		lowerStderr.includes("context window") ||
		lowerStderr.includes("output limit") ||
		lowerStderr.includes("model_context_window_exceeded") ||
		lowerStderr.includes("stop_reason: length") ||
		lowerStderr.includes("finish_reason: length") ||
		lowerStderr.includes("token limit")
	) {
		return "TOKEN_LIMIT";
	}

	// Model compatibility errors: the conversation format was rejected by the
	// provider before any generation started (e.g. Ollama models that do not
	// accept an assistant-role system-prompt injection).
	if (
		lowerStderr.includes("cannot continue from message role") ||
		lowerStderr.includes("message role: assistant") ||
		lowerStderr.includes("invalid message role") ||
		lowerStderr.includes("unexpected role")
	) {
		return "MODEL_COMPAT";
	}

	if (
		lowerStderr.includes("incomplete") ||
		lowerStderr.includes("did not complete") ||
		lowerStderr.includes("aborted before completion")
	) {
		return "INCOMPLETE";
	}

	return "UNKNOWN";
}

/**
 * Get emoji indicator for error type
 */
export function getErrorEmoji(errorType: ErrorType): string {
	switch (errorType) {
		case "RATE_LIMIT":
			return "⏱️"; // Clock for rate limiting
		case "TIMEOUT":
			return "⌛"; // Hourglass for timeout
		case "NETWORK":
			return "🌐"; // Globe for network issues
		case "VALIDATION":
			return "⚠️"; // Warning for validation
		case "TOKEN_LIMIT":
			return "📏";
		case "INCOMPLETE":
			return "🧩";
		case "MODEL_COMPAT":
			return "🔌";
		case "UNKNOWN":
		default:
			return "❓"; // Question mark for unknown
	}
}

/**
 * Get actionable suggestion based on error type
 */
export function getErrorSuggestion(errorType: ErrorType): string {
	switch (errorType) {
		case "RATE_LIMIT":
			return "Wait a few minutes for rate limits to reset, then resume to retry";
		case "TIMEOUT":
			return "Check your network connection, then resume to retry";
		case "NETWORK":
			return "Check your network connection, then resume to retry";
		case "VALIDATION":
			return "Review the error details above. You may need to manually fix issues before resuming.";
		case "TOKEN_LIMIT":
			return "The model likely hit a token/context/output limit. Resume to retry, reduce phase scope, or use a larger-context model.";
		case "INCOMPLETE":
			return "The agent exited without a clear completion signal. Resume to retry and inspect provider/model limits.";
		case "MODEL_COMPAT":
			return 'The model rejected the conversation format (e.g. assistant-role system-prompt injection). Add `"systemPromptMode": "inline"` to the failing role in .pi/spec-pipeline.json under `models`, then resume to retry.';
		case "UNKNOWN":
		default:
			return "Check error details in the log file, then resume to retry";
	}
}

// ============================================
// Error Logging
// ============================================

/**
 * Truncate string to specified length, adding ellipsis if truncated
 */
export function truncateString(str: string, maxLength: number): string {
	if (str.length <= maxLength) return str;
	return str.slice(0, maxLength - 3) + "...";
}

/**
 * Append error details to the error log file.
 * This file is intentionally preserved (not cleaned up) for debugging history.
 */
export function appendErrorLog(
	cwd: string,
	pipelineId: string,
	error: ErrorDetails,
): void {
	const stateDir = getStateDir(cwd);
	if (!fs.existsSync(stateDir)) {
		fs.mkdirSync(stateDir, { recursive: true });
	}

	const logPath = path.join(stateDir, `${pipelineId}.error.log`);

	const logEntry = `
================================================================================
ERROR LOG ENTRY - ${error.timestamp}
================================================================================
Agent: ${error.agent}
Role: ${error.role}
Error Type: ${error.errorType}
Exit Code: ${error.exitCode}
${error.phase !== undefined ? `Phase: ${error.phase}` : ""}
${error.cycle !== undefined ? `Cycle: ${error.cycle}` : ""}

--- STDERR ---
${error.stderr || "(no stderr output)"}

--- AGENT TASK ---
${error.agentTask}
================================================================================

`;

	fs.appendFileSync(logPath, logEntry, "utf-8");
}

// ============================================
// Error Handling
// ============================================

/**
 * Handle agent error - save state, log error, notify user
 * Returns the ErrorDetails object for the caller to use
 *
 * Destructive recovery (stash + reset) runs in `workRoot` (the worktree),
 * while the error log is written under `projectRoot` (the main repo) so it
 * survives worktree cleanup. When the two roots are equal (legacy mode) this
 * is byte-for-byte identical to the previous single-`cwd` behavior.
 *
 * @param saveFn - Function to save the state after updating error fields
 */
export async function handleAgentError(
	projectRoot: string,
	workRoot: string,
	state: ErrorableState,
	result: AgentResult,
	agent: AgentName,
	role: RoleName,
	task: string,
	phase: number | undefined,
	cycle: number | undefined,
	notify: (msg: string, type: "info" | "error" | "success" | "warning") => void,
	saveFn?: () => void,
): Promise<ErrorDetails> {
	const combinedErrorText = [
		result.error || "",
		result.finishReason || "",
		result.stopReason || "",
	]
		.filter(Boolean)
		.join("\n");
	let errorType: ErrorType;
	if (result.limitHit) {
		errorType = "TOKEN_LIMIT";
	} else if (result.completed === false) {
		errorType = "INCOMPLETE";
	} else {
		errorType = classifyError(combinedErrorText);
	}
	const errorDetails: ErrorDetails = {
		timestamp: new Date().toISOString(),
		agent,
		role,
		phase,
		cycle,
		exitCode: result.exitCode,
		stderr: truncateString(combinedErrorText, 2000),
		errorType,
		agentTask: task,
		finishReason: result.finishReason || result.stopReason,
		completed: result.completed,
	};

	// Stash any uncommitted changes from the failed operation (in the worktree)
	const stashRef = await stashChanges(
		workRoot,
		errorDetails.timestamp.replace(/[:.]/g, "-"),
	);
	if (stashRef) {
		state.errorStash = stashRef;
		notify("💾 Uncommitted changes stashed for recovery", "info");

		// Reset working directory to clean state (R6)
		const { resetToHead } = await import("./git.ts");
		const resetSuccess = await resetToHead(workRoot);
		if (resetSuccess) {
			notify("🔄 Working directory reset to clean state", "info");
		} else {
			notify(
				"⚠️ Failed to reset working directory - manual cleanup may be needed",
				"warning",
			);
		}
	}

	// Save to state
	state.lastError = errorDetails;
	saveFn?.();

	// Append to error log (under the main repo so it survives worktree cleanup)
	appendErrorLog(projectRoot, state.id, errorDetails);

	// Format user notification with visual formatting
	const emoji = getErrorEmoji(errorDetails.errorType);
	const phaseInfo =
		phase !== undefined
			? ` (Phase ${phase}${cycle !== undefined ? `, Cycle ${cycle}` : ""})`
			: "";

	// Build notification content
	const notifyLines: string[] = [];
	notifyLines.push(`${emoji} ${role} failed${phaseInfo}`);
	notifyLines.push("");
	notifyLines.push(formatKeyValue("Error Type", errorDetails.errorType, 12));

	if (errorDetails.stderr) {
		const preview = truncateString(errorDetails.stderr, 300);
		notifyLines.push("");
		notifyLines.push("Error Message:");
		notifyLines.push(`  ${preview}`);
	}

	notifyLines.push("");
	notifyLines.push(formatDivider(40));
	notifyLines.push("");
	notifyLines.push(`💡 ${getErrorSuggestion(errorDetails.errorType)}`);
	notifyLines.push("");
	notifyLines.push(`📁 Error log: .pi/spec-pipeline/${state.id}.error.log`);
	notifyLines.push(`🔍 Details: /spec-error`);

	notify(notifyLines.join("\n"), "error");

	return errorDetails;
}

// ============================================
// Error Display Formatting
// ============================================

/**
 * Format error details for display before retry
 * Returns formatted string for user notification
 */
export function formatErrorForRetry(
	error: ErrorDetails,
	state: ErrorableState,
): string {
	const emoji = getErrorEmoji(error.errorType);
	const content: string[] = [];

	content.push(formatKeyValue("Failed at", error.timestamp));
	content.push(formatKeyValue("Agent", error.agent));
	content.push(formatKeyValue("Role", error.role));

	if (error.phase !== undefined) {
		const totalPhases =
			("phases" in state && Array.isArray((state as any).phases)
				? (state as any).phases.length
				: 0) || "?";
		const phaseInfo = `${error.phase} of ${totalPhases}`;
		if (error.cycle !== undefined) {
			content.push(formatKeyValue("Phase", phaseInfo));
			// Note: We can't access projectConfig here, so show cycle count without total
			content.push(formatKeyValue("Cycle", String(error.cycle)));
		} else {
			content.push(formatKeyValue("Phase", phaseInfo));
		}
	}

	content.push(formatKeyValue("Error type", `${emoji} ${error.errorType}`));

	if (error.stderr) {
		const preview =
			error.stderr.length > 150
				? error.stderr.slice(0, 150) + "..."
				: error.stderr;
		content.push(formatKeyValue("Message", preview));
	}

	content.push("");
	content.push(`💡 ${getErrorSuggestion(error.errorType)}`);

	const box = formatBox("Resuming from Error", content, 55);
	return "\n" + box + "\n";
}

/**
 * Format error details as a visually appealing box for display
 * Used by /spec-status and /spec-error commands
 */
export function formatErrorBox(
	error: ErrorDetails,
	state: ErrorableState,
): string {
	const emoji = getErrorEmoji(error.errorType);
	const content: string[] = [];

	content.push(formatKeyValue("Timestamp", error.timestamp));
	content.push(formatKeyValue("Agent", `${error.agent} (${error.role})`));

	if (error.phase !== undefined) {
		const totalPhases =
			("phases" in state && Array.isArray((state as any).phases)
				? (state as any).phases.length
				: 0) || "?";
		let phaseInfo = `${error.phase} of ${totalPhases}`;
		if (error.cycle !== undefined) {
			phaseInfo += `, Cycle ${error.cycle} of 3`;
		}
		content.push(formatKeyValue("Phase", phaseInfo));
	}

	content.push(formatKeyValue("Error Type", `${emoji} ${error.errorType}`));
	content.push(formatKeyValue("Exit Code", String(error.exitCode)));

	if (error.stderr) {
		content.push("");
		content.push("─── Error Message ───");
		// Truncate and format error message
		const preview = truncateString(error.stderr, 400);
		// Split by newlines and add each line
		for (const line of preview.split("\n").slice(0, 6)) {
			content.push(`  ${line.trim()}`);
		}
	}

	content.push("");
	content.push("─── Recovery ───");
	content.push(`  ${getErrorSuggestion(error.errorType)}`);

	content.push("");
	content.push(
		formatKeyValue("Error Log", `.pi/spec-pipeline/${state.id}.error.log`),
	);

	if (error.agentTask) {
		content.push(formatKeyValue("Can Retry", "Yes (use resume command)"));
	} else {
		content.push(formatKeyValue("Can Retry", "No (task not stored)"));
	}

	return formatBox(`${emoji} Error Details`, content);
}
