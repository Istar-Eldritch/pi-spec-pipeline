import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	parsePlanDifficulty,
	recordEscalation,
	ESCALATION_LOG_RELATIVE_PATH,
	runAgentWithEscalation,
} from "./escalation.ts";
import type { ImplementationState, AgentResult, ModelConfig } from "./types.ts";

// ============================================
// Helpers
// ============================================

function makeState(): ImplementationState {
	return {
		id: "test-pipeline-id",
		implTimestamp: "2606091200",
		specPath: "docs/spec.md",
		specContent: "# Spec",
		stage: "implementation",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		phases: [],
		phasesGenerated: [],
		currentPhaseIndex: 0,
		currentReviewCycle: 1,
		previousReview: "",
		phaseCommits: [],
	};
}

function makeSuccessResult(): AgentResult {
	return { output: "done", exitCode: 0, completed: true };
}

function makeFailureResult(): AgentResult {
	return { output: "", exitCode: 1, error: "agent failed", completed: false };
}

const BASE_CONFIG: ModelConfig = { model: "mid-model", thinking: "medium" };
const ESCALATED_CONFIG: ModelConfig = {
	model: "strong-model",
	thinking: "high",
};

// ============================================
// parsePlanDifficulty
// ============================================

describe("parsePlanDifficulty", () => {
	it("detects **Difficulty**: hard", () => {
		expect(parsePlanDifficulty("**Difficulty**: hard")).toBe("hard");
	});

	it("detects Difficulty: hard", () => {
		expect(parsePlanDifficulty("Difficulty: hard")).toBe("hard");
	});

	it("detects difficulty: HARD (case insensitive)", () => {
		expect(parsePlanDifficulty("difficulty: HARD")).toBe("hard");
	});

	it("detects **Difficulty**: standard", () => {
		expect(parsePlanDifficulty("**Difficulty**: standard")).toBe("standard");
	});

	it("returns standard when marker is absent", () => {
		expect(parsePlanDifficulty("No difficulty marker here")).toBe("standard");
	});

	it("returns standard for empty string", () => {
		expect(parsePlanDifficulty("")).toBe("standard");
	});

	it("detects marker inside a larger plan document", () => {
		const plan = `# Phase 1 Plan

Some description here.

**Difficulty**: hard

## Steps
1. Do this
2. Do that
`;
		expect(parsePlanDifficulty(plan)).toBe("hard");
	});
});

// ============================================
// recordEscalation
// ============================================

describe("recordEscalation", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "escalation-rec-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("pushes onto state.escalations", () => {
		const state = makeState();
		const save = vi.fn();

		recordEscalation(
			tmpDir,
			state,
			{
				role: "implementer",
				fromModel: "mid-model",
				toModel: "strong-model",
				reason: "hard_failure",
			},
			save,
		);

		expect(state.escalations).toHaveLength(1);
		expect(state.escalations![0].role).toBe("implementer");
		expect(state.escalations![0].fromModel).toBe("mid-model");
		expect(state.escalations![0].toModel).toBe("strong-model");
		expect(state.escalations![0].reason).toBe("hard_failure");
		expect(state.escalations![0].timestamp).toBeDefined();
	});

	it("works when state.escalations is initially undefined", () => {
		const state = makeState();
		expect(state.escalations).toBeUndefined();

		const save = vi.fn();
		recordEscalation(
			tmpDir,
			state,
			{
				role: "planDrafter",
				fromModel: "m1",
				toModel: "m2",
				reason: "hard_failure",
			},
			save,
		);

		expect(state.escalations).toHaveLength(1);
	});

	it("calls save exactly once", () => {
		const state = makeState();
		const save = vi.fn();

		recordEscalation(
			tmpDir,
			state,
			{
				role: "implementer",
				fromModel: "m1",
				toModel: "m2",
				reason: "hard_failure",
			},
			save,
		);

		expect(save).toHaveBeenCalledTimes(1);
	});

	it("appends a parseable JSONL line containing required fields", () => {
		const state = makeState();
		const save = vi.fn();

		recordEscalation(
			tmpDir,
			state,
			{
				role: "implementer",
				phase: 1,
				fromModel: "mid-model",
				toModel: "strong-model",
				reason: "hard_failure",
			},
			save,
		);

		const logPath = path.join(tmpDir, ESCALATION_LOG_RELATIVE_PATH);
		expect(fs.existsSync(logPath)).toBe(true);

		const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);

		const parsed = JSON.parse(lines[0]);
		expect(parsed.pipelineId).toBe("test-pipeline-id");
		expect(parsed.specPath).toBe("docs/spec.md");
		expect(parsed.role).toBe("implementer");
		expect(parsed.fromModel).toBe("mid-model");
		expect(parsed.toModel).toBe("strong-model");
		expect(parsed.reason).toBe("hard_failure");
		expect(parsed.timestamp).toBeDefined();
	});

	it("two calls append two lines", () => {
		const state = makeState();
		const save = vi.fn();

		recordEscalation(
			tmpDir,
			state,
			{
				role: "implementer",
				fromModel: "m1",
				toModel: "m2",
				reason: "hard_failure",
			},
			save,
		);

		recordEscalation(
			tmpDir,
			state,
			{
				role: "implementer",
				fromModel: "m2",
				toModel: "m3",
				reason: "review_cycles",
			},
			save,
		);

		const logPath = path.join(tmpDir, ESCALATION_LOG_RELATIVE_PATH);
		const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("calls notify with escalation message", () => {
		const state = makeState();
		const save = vi.fn();
		const notify = vi.fn();

		recordEscalation(
			tmpDir,
			state,
			{
				role: "implementer",
				fromModel: "mid-model",
				toModel: "strong-model",
				reason: "hard_failure",
			},
			save,
			notify,
		);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Escalated implementer"),
			"warning",
		);
	});

	it("returns the full escalation record", () => {
		const state = makeState();
		const save = vi.fn();

		const record = recordEscalation(
			tmpDir,
			state,
			{
				role: "implementer",
				phase: 2,
				fromModel: "m1",
				toModel: "m2",
				reason: "difficulty_routing",
			},
			save,
		);

		expect(record.role).toBe("implementer");
		expect(record.phase).toBe(2);
		expect(record.timestamp).toBeDefined();
	});
});

// ============================================
// runAgentWithEscalation
// ============================================

describe("runAgentWithEscalation", () => {
	it("success on attempt 1 → one runner call, escalated: false", async () => {
		const runner = vi.fn().mockResolvedValue(makeSuccessResult());

		const result = await runAgentWithEscalation({
			baseConfig: BASE_CONFIG,
			escalatedConfig: ESCALATED_CONFIG,
			maxEscalatedRetries: 1,
			role: "implementer",
			task: "do something",
			cwd: "/tmp",
			systemPrompt: "sys",
			runner,
		});

		expect(runner).toHaveBeenCalledTimes(1);
		expect(result.escalated).toBe(false);
		expect(result.failureDescription).toBeUndefined();
		expect(result.config).toEqual(BASE_CONFIG);
	});

	it("hard failure then success → two runner calls, second uses escalatedConfig, onEscalate fired once, escalated: true", async () => {
		const runner = vi
			.fn()
			.mockResolvedValueOnce(makeFailureResult())
			.mockResolvedValueOnce(makeSuccessResult());
		const onEscalate = vi.fn();

		const result = await runAgentWithEscalation({
			baseConfig: BASE_CONFIG,
			escalatedConfig: ESCALATED_CONFIG,
			maxEscalatedRetries: 1,
			role: "implementer",
			task: "do something",
			cwd: "/tmp",
			systemPrompt: "sys",
			runner,
			onEscalate,
		});

		expect(runner).toHaveBeenCalledTimes(2);
		// Second call uses escalatedConfig
		expect(runner.mock.calls[1][0]).toEqual(ESCALATED_CONFIG);
		expect(onEscalate).toHaveBeenCalledTimes(1);
		expect(onEscalate).toHaveBeenCalledWith({
			fromModel: "mid-model",
			toModel: "strong-model",
		});
		expect(result.escalated).toBe(true);
		expect(result.failureDescription).toBeUndefined();
	});

	it("hard failure with escalatedConfig undefined → one call, failureDescription set", async () => {
		const runner = vi.fn().mockResolvedValue(makeFailureResult());

		const result = await runAgentWithEscalation({
			baseConfig: BASE_CONFIG,
			escalatedConfig: undefined,
			maxEscalatedRetries: 1,
			role: "implementer",
			task: "do something",
			cwd: "/tmp",
			systemPrompt: "sys",
			runner,
		});

		expect(runner).toHaveBeenCalledTimes(1);
		expect(result.failureDescription).toBeDefined();
		expect(result.escalated).toBe(false);
	});

	it("hard failure with maxEscalatedRetries: 0 → one call only", async () => {
		const runner = vi.fn().mockResolvedValue(makeFailureResult());

		const result = await runAgentWithEscalation({
			baseConfig: BASE_CONFIG,
			escalatedConfig: ESCALATED_CONFIG,
			maxEscalatedRetries: 0,
			role: "implementer",
			task: "do something",
			cwd: "/tmp",
			systemPrompt: "sys",
			runner,
		});

		expect(runner).toHaveBeenCalledTimes(1);
		expect(result.failureDescription).toBeDefined();
	});

	it("validate returning description on attempt 1 → triggers escalation even with exitCode 0; passes on attempt 2 → success", async () => {
		const runner = vi.fn().mockResolvedValue(makeSuccessResult());
		const validate = vi
			.fn()
			.mockResolvedValueOnce("output too short")
			.mockResolvedValueOnce(undefined);
		const onEscalate = vi.fn();

		const result = await runAgentWithEscalation({
			baseConfig: BASE_CONFIG,
			escalatedConfig: ESCALATED_CONFIG,
			maxEscalatedRetries: 1,
			role: "implementer",
			task: "do something",
			cwd: "/tmp",
			systemPrompt: "sys",
			runner,
			validate,
			onEscalate,
		});

		expect(runner).toHaveBeenCalledTimes(2);
		expect(onEscalate).toHaveBeenCalledTimes(1);
		expect(result.escalated).toBe(true);
		expect(result.failureDescription).toBeUndefined();
	});

	it("both attempts fail → failureDescription set, result is last attempt's", async () => {
		const firstResult: AgentResult = {
			output: "first",
			exitCode: 1,
			error: "first error",
		};
		const secondResult: AgentResult = {
			output: "second",
			exitCode: 1,
			error: "second error",
		};
		const runner = vi
			.fn()
			.mockResolvedValueOnce(firstResult)
			.mockResolvedValueOnce(secondResult);

		const result = await runAgentWithEscalation({
			baseConfig: BASE_CONFIG,
			escalatedConfig: ESCALATED_CONFIG,
			maxEscalatedRetries: 1,
			role: "implementer",
			task: "do something",
			cwd: "/tmp",
			systemPrompt: "sys",
			runner,
		});

		expect(result.failureDescription).toBeDefined();
		expect(result.result).toEqual(secondResult);
		expect(result.config).toEqual(ESCALATED_CONFIG);
	});

	it("onAttempt is called once per attempt with the attempt's config", async () => {
		const runner = vi
			.fn()
			.mockResolvedValueOnce(makeFailureResult())
			.mockResolvedValueOnce(makeSuccessResult());
		const onAttempt = vi.fn();

		await runAgentWithEscalation({
			baseConfig: BASE_CONFIG,
			escalatedConfig: ESCALATED_CONFIG,
			maxEscalatedRetries: 1,
			role: "implementer",
			task: "do something",
			cwd: "/tmp",
			systemPrompt: "sys",
			runner,
			onAttempt,
		});

		expect(onAttempt).toHaveBeenCalledTimes(2);
		expect(onAttempt.mock.calls[0][0].config).toEqual(BASE_CONFIG);
		expect(onAttempt.mock.calls[0][0].attempt).toBe(1);
		expect(onAttempt.mock.calls[1][0].config).toEqual(ESCALATED_CONFIG);
		expect(onAttempt.mock.calls[1][0].attempt).toBe(2);
	});
});
