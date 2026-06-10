import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
	setSystemTime,
} from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	generatePipelineId,
	loadImplState,
	getImplStateDir,
	getImplStatePath,
} from "./state.ts";

describe("generatePipelineId", () => {
	it("generates a non-empty string", () => {
		const id = generatePipelineId();
		expect(id).toBeTruthy();
		expect(typeof id).toBe("string");
	});

	it("generates unique IDs on subsequent calls", () => {
		const id1 = generatePipelineId();
		const id2 = generatePipelineId();
		expect(id1).not.toBe(id2);
	});

	it("contains date component", () => {
		const id = generatePipelineId();
		// Format: YYYYMMDD_HHMMSS_xxxx
		expect(id).toMatch(/^\d{8}_\d{6}_\w+$/);
	});

	it("generates IDs with correct format", () => {
		// Mock date for predictable testing
		const mockDate = new Date("2026-02-01T12:30:45.000Z");
		vi.useFakeTimers();
		setSystemTime(mockDate);

		const id = generatePipelineId();

		// Should start with 20260201_123045
		expect(id).toMatch(/^20260201_123045_\w{4}$/);

		vi.useRealTimers();
	});
});

// ============================================
// ImplementationState escalations migration
// ============================================

describe("loadImplState escalations migration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "impl-state-escalation-test-"),
		);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("a saved impl state without escalations loads with escalations: []", () => {
		const stateDir = getImplStateDir(tmpDir);
		fs.mkdirSync(stateDir, { recursive: true });

		// Write a minimal impl state without the escalations field
		const minimalState = {
			id: "impl-migration-test",
			implTimestamp: "2606091200",
			specPath: "docs/spec.md",
			specContent: "# Spec",
			stage: "implementation",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			phases: ["phase 1"],
			phasesGenerated: [true],
			currentPhaseIndex: 0,
			currentReviewCycle: 1,
			previousReview: "",
			phaseCommits: [],
			checkpoints: [],
			reviewCyclesCompleted: 0,
			// NOTE: no 'escalations' field
		};

		fs.writeFileSync(
			getImplStatePath(tmpDir, "impl-migration-test"),
			JSON.stringify(minimalState),
			"utf-8",
		);

		const loaded = loadImplState(tmpDir, "impl-migration-test");
		expect(loaded).not.toBeNull();
		expect(loaded!.escalations).toEqual([]);
	});
});
