/**
 * Tests for pipeline resume behavior after cancellation
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createInitialSpecState, saveSpecState, loadSpecState, createInitialImplState, saveImplState, loadImplState } from "./state.ts";

describe("Spec Pipeline Resume After Cancellation", () => {
	let tempDir: string;
	let cwd: string;
	
	function setupTempDir() {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-pipeline-resume-test-"));
		cwd = tempDir;
	}
	
	function teardownTempDir() {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}
	
	it("should detect cancelled mid-draft and reset iteration counter", () => {
		setupTempDir();
		
		try {
			const state = createInitialSpecState(
				"Test feature",
				"2602051400",
				"test_feature",
				"docs",
				true
			);
			
			state.specIteration = 1;
			state.stage = "spec_drafting";
			saveSpecState(cwd, state);
			
			state.stage = "cancelled";
			saveSpecState(cwd, state);
			
			const loadedState = loadSpecState(cwd, state.id);
			expect(loadedState).not.toBeNull();
			expect(loadedState!.specIteration).toBe(1);
			expect(loadedState!.stage).toBe("cancelled");
			
			loadedState!.stage = "spec_drafting";
			
			const fullSpecPath = path.join(cwd, loadedState!.specPath);
			const specFileExists = fs.existsSync(fullSpecPath);
			expect(specFileExists).toBe(false);
			
			if (loadedState!.specIteration > 0 && !specFileExists) {
				loadedState!.specIteration = 0;
			}
			
			expect(loadedState!.specIteration).toBe(0);
			
		} finally {
			teardownTempDir();
		}
	});
	
	it("should NOT reset iteration counter if spec file exists", () => {
		setupTempDir();
		
		try {
			const state = createInitialSpecState(
				"Test feature",
				"2602051400",
				"test_feature",
				"docs",
				true
			);
			
			state.specIteration = 1;
			state.stage = "spec_review";
			saveSpecState(cwd, state);
			
			const fullSpecPath = path.join(cwd, state.specPath);
			fs.mkdirSync(path.dirname(fullSpecPath), { recursive: true });
			fs.writeFileSync(fullSpecPath, "# Test Spec\nSome content here");
			
			state.stage = "cancelled";
			saveSpecState(cwd, state);
			
			const loadedState = loadSpecState(cwd, state.id);
			expect(loadedState).not.toBeNull();
			expect(loadedState!.specIteration).toBe(1);
			
			loadedState!.stage = "spec_review";
			
			const specFileExists = fs.existsSync(fullSpecPath);
			expect(specFileExists).toBe(true);
			
			if (loadedState!.specIteration > 0 && !specFileExists) {
				loadedState!.specIteration = 0;
			}
			
			expect(loadedState!.specIteration).toBe(1);
			
		} finally {
			teardownTempDir();
		}
	});
	
	it("should properly resume at spec_review stage without re-drafting", () => {
		setupTempDir();
		
		try {
			const state = createInitialSpecState(
				"Test feature",
				"2602051400",
				"test_feature",
				"docs",
				true
			);
			
			state.specIteration = 1;
			state.stage = "spec_review";
			saveSpecState(cwd, state);
			
			const fullSpecPath = path.join(cwd, state.specPath);
			fs.mkdirSync(path.dirname(fullSpecPath), { recursive: true });
			fs.writeFileSync(fullSpecPath, "# Test Spec\nCompleted draft");
			
			state.stage = "cancelled";
			saveSpecState(cwd, state);
			
			const loadedState = loadSpecState(cwd, state.id);
			loadedState!.stage = "spec_review";
			
			const specFileExists = fs.existsSync(fullSpecPath);
			expect(specFileExists).toBe(true);
			
			const resumingMidIteration = loadedState!.stage === "spec_review" || loadedState!.stage === "user_approval";
			const skipSpecDrafter = resumingMidIteration && loadedState!.specIteration > 0 && specFileExists;
			
			expect(resumingMidIteration).toBe(true);
			expect(skipSpecDrafter).toBe(true);
			
		} finally {
			teardownTempDir();
		}
	});
	
	it("should preserve stage before cancellation", () => {
		setupTempDir();
		
		try {
			const state = createInitialSpecState(
				"Test feature",
				"2602051400",
				"test_feature",
				"docs",
				true
			);
			
			state.specIteration = 1;
			state.stage = "spec_review";
			
			const fullSpecPath = path.join(cwd, state.specPath);
			fs.mkdirSync(path.dirname(fullSpecPath), { recursive: true });
			fs.writeFileSync(fullSpecPath, "# Test Spec\nContent");
			
			saveSpecState(cwd, state);
			
			state.stageBeforeCancellation = state.stage;
			state.stage = "cancelled";
			saveSpecState(cwd, state);
			
			const loadedState = loadSpecState(cwd, state.id);
			expect(loadedState).not.toBeNull();
			expect(loadedState!.stage).toBe("cancelled");
			expect(loadedState!.stageBeforeCancellation).toBe("spec_review");
			
			if (loadedState!.stageBeforeCancellation && loadedState!.stageBeforeCancellation !== "cancelled") {
				loadedState!.stage = loadedState!.stageBeforeCancellation;
				loadedState!.stageBeforeCancellation = undefined;
			}
			
			expect(loadedState!.stage).toBe("spec_review");
			expect(loadedState!.stageBeforeCancellation).toBeUndefined();
			
		} finally {
			teardownTempDir();
		}
	});
	
	it("should remember --quick flag (discovery skipped) when resuming", () => {
		setupTempDir();
		
		try {
			const state = createInitialSpecState(
				"Test feature",
				"2602051400",
				"test_feature",
				"docs",
				true
			);
			
			expect(state.discovery?.skipped).toBe(true);
			expect(state.discovery?.completed).toBe(true);
			
			saveSpecState(cwd, state);
			
			state.stage = "spec_drafting";
			saveSpecState(cwd, state);
			
			state.stage = "cancelled";
			saveSpecState(cwd, state);
			
			const loadedState = loadSpecState(cwd, state.id);
			expect(loadedState).not.toBeNull();
			expect(loadedState!.discovery?.skipped).toBe(true);
			expect(loadedState!.discovery?.completed).toBe(true);
			
		} finally {
			teardownTempDir();
		}
	});
});

describe("Implementation Pipeline Resume After Cancellation", () => {
	let tempDir: string;
	let cwd: string;
	
	function setupTempDir() {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "impl-pipeline-resume-test-"));
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
				true // skipPlanGeneration
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
				"2602061200"
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
