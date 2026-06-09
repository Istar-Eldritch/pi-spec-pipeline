/**
 * Bounded escalation: hard failures retry one tier up instead of re-rolling the
 * same model; every escalation is recorded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ImplementationState,
	EscalationRecord,
	ModelConfig,
	AgentOutputEvent,
	AgentResult,
	RoleName,
	PlanDifficulty,
} from "./types.ts";
import { runAgentWithConfig } from "./agents.ts";

// ============================================
// Difficulty Parsing
// ============================================

/**
 * Parse the planDrafter's difficulty marker. Defaults to "standard".
 * Matches the FIRST occurrence of `Difficulty: <value>` with optional `**` bolding
 * on the label, case-insensitive.
 */
export function parsePlanDifficulty(plan: string): PlanDifficulty {
	const match = plan.match(
		/(?:\*\*\s*)?Difficulty(?:\s*\*\*)?\s*:\s*(standard|hard)\b/i,
	);
	if (match && match[1].toLowerCase() === "hard") {
		return "hard";
	}
	return "standard";
}

// ============================================
// Escalation Recording
// ============================================

export const ESCALATION_LOG_RELATIVE_PATH = ".pi/spec-pipeline/escalations.log";

/**
 * Record an escalation on the implementation state AND append a JSONL line to
 * the cross-run log. Logging must never throw — swallow fs errors.
 */
export function recordEscalation(
	cwd: string,
	state: ImplementationState,
	record: Omit<EscalationRecord, "timestamp">,
	save: () => void,
	notify?: (
		msg: string,
		type: "info" | "error" | "success" | "warning",
	) => void,
): EscalationRecord {
	const full: EscalationRecord = {
		...record,
		timestamp: new Date().toISOString(),
	};

	state.escalations ??= [];
	state.escalations.push(full);
	save();

	try {
		const logPath = path.join(cwd, ESCALATION_LOG_RELATIVE_PATH);
		const logDir = path.dirname(logPath);
		fs.mkdirSync(logDir, { recursive: true });
		const line =
			JSON.stringify({
				pipelineId: state.id,
				specPath: state.specPath,
				...full,
			}) + "\n";
		fs.appendFileSync(logPath, line, "utf-8");
	} catch {
		// Swallow fs errors
	}

	notify?.(
		`⬆️ Escalated ${record.role}: ${record.fromModel} → ${record.toModel} (${record.reason})`,
		"warning",
	);

	return full;
}

// ============================================
// Escalating Agent Runner
// ============================================

export interface EscalatingAgentRun {
	result: AgentResult;
	config: ModelConfig; // the config of the FINAL attempt
	escalated: boolean; // true when the final attempt used escalatedConfig
	failureDescription?: string; // set when the final attempt still failed
}

export async function runAgentWithEscalation(opts: {
	baseConfig: ModelConfig;
	escalatedConfig?: ModelConfig; // from getEscalatedModelConfig(); undefined disables escalation
	maxEscalatedRetries: number; // projectConfig.escalation.hardFailureRetries
	role: RoleName;
	task: string;
	cwd: string;
	systemPrompt: string;
	signal?: AbortSignal;
	onOutput?: (event: AgentOutputEvent) => void;
	sessionDir?: string;
	/** Extra failure detection on a "successful" result (e.g. empty output). Return a description to treat as failure. */
	validate?: (
		result: AgentResult,
	) => Promise<string | undefined> | string | undefined;
	/** Called after EVERY attempt — use to record per-attempt metrics with the attempt's config. */
	onAttempt?: (info: {
		config: ModelConfig;
		startTime: Date;
		result: AgentResult;
		attempt: number;
	}) => void;
	/** Called ONCE, when transitioning from base to escalated config. */
	onEscalate?: (info: { fromModel: string; toModel: string }) => void;
	notify?: (
		msg: string,
		type: "info" | "error" | "success" | "warning",
	) => void;
	/** Injectable for tests; defaults to runAgentWithConfig from agents.ts. */
	runner?: typeof runAgentWithConfig;
}): Promise<EscalatingAgentRun> {
	const runner = opts.runner ?? runAgentWithConfig;
	const totalAttempts =
		1 + (opts.escalatedConfig ? Math.max(0, opts.maxEscalatedRetries) : 0);

	let lastResult!: AgentResult;
	let lastConfig!: ModelConfig;
	let lastFailureDescription: string | undefined;

	for (let attempt = 1; attempt <= totalAttempts; attempt++) {
		const config = attempt === 1 ? opts.baseConfig : opts.escalatedConfig!;
		const startTime = new Date();
		const result = await runner(
			config,
			opts.task,
			opts.cwd,
			opts.systemPrompt,
			opts.signal,
			opts.onOutput,
			opts.role,
			opts.sessionDir,
		);

		opts.onAttempt?.({ config, startTime, result, attempt });

		lastResult = result;
		lastConfig = config;

		// Failure check
		let failureDescription: string | undefined;
		const isHardFailure =
			result.exitCode !== 0 || result.completed === false || result.limitHit;
		if (isHardFailure) {
			failureDescription =
				result.error ?? `agent run failed (exit ${result.exitCode})`;
		} else if (opts.validate) {
			failureDescription = await opts.validate(result);
		}

		if (!failureDescription) {
			return { result, config, escalated: attempt > 1 };
		}

		lastFailureDescription = failureDescription;

		// If there are attempts remaining
		if (attempt < totalAttempts) {
			if (attempt === 1) {
				opts.onEscalate?.({
					fromModel: opts.baseConfig.model,
					toModel: opts.escalatedConfig!.model,
				});
				opts.notify?.(
					`⬆️ ${opts.role} failed (${failureDescription}) — retrying with ${opts.escalatedConfig!.model}`,
					"warning",
				);
			}
			// Continue loop
		}
	}

	return {
		result: lastResult,
		config: lastConfig,
		escalated: totalAttempts > 1,
		failureDescription: lastFailureDescription,
	};
}
