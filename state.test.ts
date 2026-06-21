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
	saveImplState,
	createInitialImplState,
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

// ============================================
// phaseCommits boolean[][] → string[][] migration
// ============================================

describe("loadImplState phaseCommits migration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "impl-state-phasecommits-test-"),
		);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeRawState(id: string, raw: object): void {
		const stateDir = getImplStateDir(tmpDir);
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(getImplStatePath(tmpDir, id), JSON.stringify(raw), "utf-8");
	}

	// Regression: older states recorded `phaseCommits: boolean[][]` with `true`
	// presence markers. The field is now `string[][]` of commit hashes. Legacy
	// booleans coerce to "" (placeholder) so the array type/length stays sane.
	it("coerces legacy boolean[][] phaseCommits to string[][] on load", () => {
		writeRawState("legacy-bool", {
			id: "legacy-bool",
			implTimestamp: "2606091200",
			specPath: "docs/spec.md",
			specContent: "# Spec",
			stage: "implementation",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			phases: ["phase 1", "phase 2"],
			phasesGenerated: [true, true],
			currentPhaseIndex: 0,
			currentReviewCycle: 1,
			previousReview: "",
			phaseCommits: [[true], [true, true]],
		});

		const loaded = loadImplState(tmpDir, "legacy-bool");
		expect(loaded).not.toBeNull();
		// Every entry is now a string; length preserved.
		expect(loaded!.phaseCommits).toEqual([[""], ["", ""]]);
		for (const arr of loaded!.phaseCommits) {
			for (const entry of arr) {
				expect(typeof entry).toBe("string");
			}
		}
	});

	it("preserves string[][] phaseCommits with real hashes", () => {
		writeRawState("modern-str", {
			id: "modern-str",
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
			phaseCommits: [["abc123", "def456"]],
			phaseStartHead: "base000",
		});

		const loaded = loadImplState(tmpDir, "modern-str");
		expect(loaded).not.toBeNull();
		expect(loaded!.phaseCommits).toEqual([["abc123", "def456"]]);
		expect(loaded!.phaseStartHead).toBe("base000");
	});

	it("initializes phaseCommits to [] when the field is absent", () => {
		writeRawState("missing-field", {
			id: "missing-field",
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
			// NOTE: no phaseCommits field
		});

		const loaded = loadImplState(tmpDir, "missing-field");
		expect(loaded).not.toBeNull();
		expect(loaded!.phaseCommits).toEqual([]);
	});
});

// ============================================
// Worktree metadata round-trip (FR-7.4)
// ============================================

describe("worktree metadata state round-trip", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "impl-state-worktree-test-"),
		);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("state.worktree round-trips through saveImplState / loadImplState", () => {
		const state = createInitialImplState(
			"specs/test.md",
			"# Test",
			"2606101200",
		);

		const worktreeMeta = {
			path: "/tmp/worktrees/test-2606101200",
			branch: "impl/test-2606101200",
			baseCommit: "abc123def456",
			createdAt: new Date().toISOString(),
			setupScriptRan: false,
		};
		state.worktree = worktreeMeta;

		saveImplState(tmpDir, state);

		// Reload and assert all five metadata keys are present
		const loaded = loadImplState(tmpDir, state.id);
		expect(loaded).not.toBeNull();
		expect(loaded!.worktree).toBeDefined();
		expect(loaded!.worktree!.path).toBe(worktreeMeta.path);
		expect(loaded!.worktree!.branch).toBe(worktreeMeta.branch);
		expect(loaded!.worktree!.baseCommit).toBe(worktreeMeta.baseCommit);
		expect(loaded!.worktree!.createdAt).toBe(worktreeMeta.createdAt);
		expect(loaded!.worktree!.setupScriptRan).toBe(false);
	});

	it("state.worktree.setupScriptRan = true round-trips correctly", () => {
		const state = createInitialImplState(
			"specs/test.md",
			"# Test",
			"2606101200",
		);
		state.worktree = {
			path: "/tmp/worktrees/test-2606101200",
			branch: "impl/test-2606101200",
			baseCommit: "abc123def456",
			createdAt: new Date().toISOString(),
			setupScriptRan: true,
		};
		saveImplState(tmpDir, state);

		const loaded = loadImplState(tmpDir, state.id);
		expect(loaded!.worktree!.setupScriptRan).toBe(true);
	});

	it("legacy state without worktree field loads with state.worktree === undefined (FR-5.2)", () => {
		// Write a raw state file that lacks the worktree field (legacy format)
		const stateDir = getImplStateDir(tmpDir);
		fs.mkdirSync(stateDir, { recursive: true });

		const legacyState = {
			id: "legacy-no-worktree",
			implTimestamp: "2601010000",
			specPath: "specs/old.md",
			specContent: "# Old spec",
			stage: "implementation",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			phases: [],
			phasesGenerated: [],
			currentPhaseIndex: 0,
			currentReviewCycle: 1,
			previousReview: "",
			phaseCommits: [],
			escalations: [],
			checkpoints: [],
			reviewCyclesCompleted: 0,
			// NOTE: no 'worktree' field
		};

		const statePath = getImplStatePath(tmpDir, "legacy-no-worktree");
		const originalJson = JSON.stringify(legacyState, null, 2);
		fs.writeFileSync(statePath, originalJson, "utf-8");

		const loaded = loadImplState(tmpDir, "legacy-no-worktree");
		expect(loaded).not.toBeNull();
		expect(loaded!.worktree).toBeUndefined();

		// Assert the file on disk is NOT rewritten to add a worktree field
		// (needsSave must not be triggered for the absent worktree field).
		// Assert byte-stability across loadImplState per FR-5.2.
		const diskJson = fs.readFileSync(statePath, "utf-8");
		expect(diskJson).toBe(originalJson);
		const diskParsed = JSON.parse(diskJson);
		expect(diskParsed).not.toHaveProperty("worktree");
	});

	it("disk JSON written by saveImplState contains all five worktree metadata keys", () => {
		const state = createInitialImplState(
			"specs/test.md",
			"# Test",
			"2606101200",
		);
		const createdAt = new Date().toISOString();
		state.worktree = {
			path: "/tmp/wt/myfeature-2606101200",
			branch: "impl/myfeature-2606101200",
			baseCommit: "deadbeef",
			createdAt,
			setupScriptRan: false,
		};
		saveImplState(tmpDir, state);

		const diskJson = fs.readFileSync(
			getImplStatePath(tmpDir, state.id),
			"utf-8",
		);
		const diskParsed = JSON.parse(diskJson);
		expect(diskParsed.worktree).toBeDefined();
		expect(Object.keys(diskParsed.worktree)).toEqual(
			expect.arrayContaining([
				"path",
				"branch",
				"baseCommit",
				"createdAt",
				"setupScriptRan",
			]),
		);
	});
});
