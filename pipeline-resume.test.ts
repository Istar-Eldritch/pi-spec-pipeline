/**
 * Tests for pipeline resume behavior after cancellation
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	createInitialImplState,
	saveImplState,
	loadImplState,
} from "./state.ts";

describe("Implementation Pipeline Resume After Cancellation", () => {
	let tempDir: string;
	let cwd: string;

	function setupTempDir() {
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "impl-pipeline-resume-test-"),
		);
		cwd = tempDir;
	}

	function teardownTempDir() {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}

	it("should remember --no-plan flag when resuming", () => {
		setupTempDir();

		try {
			const state = createInitialImplState(
				"docs/specs/test_spec.md",
				"# Test Spec\nContent",
				"2602061200",
				true, // skipPlanGeneration
			);

			expect(state.skipPlanGeneration).toBe(true);

			saveImplState(cwd, state);

			state.stage = "cancelled";
			saveImplState(cwd, state);

			const loadedState = loadImplState(cwd, state.id);
			expect(loadedState).not.toBeNull();
			expect(loadedState!.skipPlanGeneration).toBe(true);
		} finally {
			teardownTempDir();
		}
	});

	it("should preserve stage before cancellation", () => {
		setupTempDir();

		try {
			const state = createInitialImplState(
				"docs/specs/test_spec.md",
				"# Test Spec",
				"2602061200",
			);

			state.stage = "implementation";
			state.phases = ["phase1.md"];
			state.phasesGenerated = [true];
			saveImplState(cwd, state);

			state.stageBeforeCancellation = state.stage;
			state.stage = "cancelled";
			saveImplState(cwd, state);

			const loadedState = loadImplState(cwd, state.id);
			expect(loadedState).not.toBeNull();
			expect(loadedState!.stage).toBe("cancelled");
			expect(loadedState!.stageBeforeCancellation).toBe("implementation");
		} finally {
			teardownTempDir();
		}
	});
});
