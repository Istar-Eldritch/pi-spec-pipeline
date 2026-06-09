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
	generateSpecTimestamp,
	generateTimestamp,
	createInitialDiscoveryState,
	generateConversationalDiscoverySummary,
	createInitialSpecState,
	createInitialImplState,
	createInitialRoadmapState,
	createInitialEpicState,
	createInitialBrainstormState,
	saveSpecState,
	loadSpecState,
	loadImplState,
	getImplStateDir,
	getImplStatePath,
	saveBrainstormState,
	loadBrainstormState,
	listBrainstormStates,
	getLatestActiveBrainstormPipeline,
	getBrainstormStateDir,
	getBrainstormStatePath,
	extractChildItems,
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

describe("generateSpecTimestamp", () => {
	it("generates timestamp in YYMMDDhhmm format", () => {
		const ts = generateSpecTimestamp();
		expect(ts).toMatch(/^\d{10}$/);
	});

	it("generates correct timestamp for known date", () => {
		const mockDate = new Date("2026-02-01T14:35:00.000Z");
		vi.useFakeTimers();
		setSystemTime(mockDate);

		const ts = generateSpecTimestamp();
		expect(ts).toBe("2602011435");

		vi.useRealTimers();
	});

	it("pads single-digit months and days", () => {
		const mockDate = new Date("2026-01-05T08:05:00.000Z");
		vi.useFakeTimers();
		setSystemTime(mockDate);

		const ts = generateSpecTimestamp();
		expect(ts).toBe("2601050805");

		vi.useRealTimers();
	});
});

describe("createInitialDiscoveryState", () => {
	it("creates non-skipped state by default", () => {
		const state = createInitialDiscoveryState();
		expect(state.skipped).toBe(false);
		expect(state.completed).toBe(false);
	});

	it("creates skipped state when requested", () => {
		const state = createInitialDiscoveryState(true);
		expect(state.skipped).toBe(true);
		expect(state.completed).toBe(true);
	});

	it("initializes with empty conversationHistory", () => {
		const state = createInitialDiscoveryState();
		expect(state.conversationHistory).toEqual([]);
	});

	it("initializes with empty discoverySummary", () => {
		const state = createInitialDiscoveryState();
		expect(state.discoverySummary).toBe("");
	});

	it("initializes with empty topics and no active topic", () => {
		const state = createInitialDiscoveryState();
		expect(state.topics).toEqual([]);
		expect(state.activeTopic).toBeNull();
	});
});

describe("generateConversationalDiscoverySummary", () => {
	it("renders completed discovery topics with decision first and nested follow-ups", () => {
		const summary = generateConversationalDiscoverySummary(
			[],
			[
				{
					question: "Should enterprise tenants require SSO from launch?",
					decision: "Yes, but make SSO optional for launch.",
					followUps: [
						{
							userQuestion: "What happens to local accounts?",
							agentAnswer: "They remain available as fallback login.",
							timestamp: "2026-05-23T08:00:00.000Z",
						},
					],
					timestamp: "2026-05-23T07:59:00.000Z",
				},
			],
		);

		expect(summary).toContain(
			"### Topic 1: Should enterprise tenants require SSO from launch?",
		);
		expect(summary).toContain(
			"**Decision:** Yes, but make SSO optional for launch.",
		);
		expect(summary).toContain(
			"**Assumption:** Should enterprise tenants require SSO from launch?",
		);
		expect(summary.indexOf("**Decision:**")).toBeLessThan(
			summary.indexOf("**Assumption:**"),
		);
		expect(summary).toContain("**Supporting thread:**");
		expect(summary).toContain("- **Q:** What happens to local accounts?");
		expect(summary).toContain(
			"  **A:** They remain available as fallback login.",
		);
		expect(summary).not.toContain("### Exchange 1");
	});

	it("keeps the legacy exchange rendering when no topics are provided", () => {
		const summary = generateConversationalDiscoverySummary([
			{
				userMessage: "We need password auth.",
				assistantResponse: "Should registration require email verification?",
				timestamp: "2026-05-23T08:00:00.000Z",
			},
		]);

		expect(summary).toContain("### Exchange 1");
		expect(summary).toContain("**User:**");
		expect(summary).toContain("We need password auth.");
		expect(summary).toContain("**Discovery Agent:**");
		expect(summary).toContain(
			"Should registration require email verification?",
		);
	});

	it("renders flushed open topics as one topic with no final decision", () => {
		const summary = generateConversationalDiscoverySummary(
			[],
			[
				{
					question: "Should tenant admins manage user invites?",
					decision: null,
					followUps: [],
					timestamp: "2026-05-23T08:00:00.000Z",
				},
			],
		);

		expect(summary).toContain(
			"### Topic 1: Should tenant admins manage user invites?",
		);
		expect(summary).toContain("**Decision:** (No final decision recorded.)");
		expect(summary).not.toContain("### Exchange 1");
	});

	it("truncates long topic titles to about twelve words", () => {
		const summary = generateConversationalDiscoverySummary(
			[],
			[
				{
					question:
						"Should authentication support password reset magic links backup codes and session revocation for all tenants?",
					decision: "Yes.",
					followUps: [],
					timestamp: "2026-05-23T08:00:00.000Z",
				},
			],
		);

		expect(summary).toContain(
			"### Topic 1: Should authentication support password reset magic links backup codes and session revocation…",
		);
	});
});

describe("createInitialSpecState", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setSystemTime(new Date("2026-02-01T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates state with correct description", () => {
		const state = createInitialSpecState(
			"Build a feature",
			"2602011200",
			"feature",
			"docs/specs",
		);
		expect(state.description).toBe("Build a feature");
	});

	it("creates state with correct spec filename", () => {
		const state = createInitialSpecState(
			"Build a feature",
			"2602011200",
			"feature",
			"docs/specs",
		);
		expect(state.specFilename).toBe("2602011200_spec_feature.md");
	});

	it("creates state with correct spec path", () => {
		const state = createInitialSpecState(
			"Build a feature",
			"2602011200",
			"feature",
			"docs/specs",
		);
		expect(state.specPath).toBe("docs/specs/2602011200_spec_feature.md");
	});

	it("starts in discovery stage when discovery enabled", () => {
		const state = createInitialSpecState(
			"Build a feature",
			"2602011200",
			"feature",
			"docs/specs",
			false, // skipDiscovery
		);
		expect(state.stage).toBe("discovery");
	});

	it("starts in spec_drafting stage when discovery disabled", () => {
		const state = createInitialSpecState(
			"Build a feature",
			"2602011200",
			"feature",
			"docs/specs",
			true, // skipDiscovery
		);
		expect(state.stage).toBe("spec_drafting");
	});

	it("starts in spec_drafting stage when skipDiscovery is true", () => {
		const state = createInitialSpecState(
			"Build a feature",
			"2602011200",
			"feature",
			"docs/specs",
			true, // skipDiscovery
		);
		expect(state.stage).toBe("spec_drafting");
		expect(state.discovery?.skipped).toBe(true);
	});

	it("initializes spec as not approved", () => {
		const state = createInitialSpecState(
			"Build a feature",
			"2602011200",
			"feature",
			"docs/specs",
		);
		expect(state.specApproved).toBe(false);
		expect(state.specIteration).toBe(0);
	});

	it("sets timestamps", () => {
		const state = createInitialSpecState(
			"Build a feature",
			"2602011200",
			"feature",
			"docs/specs",
		);
		expect(state.createdAt).toBe("2026-02-01T12:00:00.000Z");
		expect(state.updatedAt).toBe("2026-02-01T12:00:00.000Z");
	});

	it("generates unique ID", () => {
		const state1 = createInitialSpecState(
			"Feature 1",
			"2602011200",
			"f1",
			"docs/specs",
		);
		const state2 = createInitialSpecState(
			"Feature 2",
			"2602011201",
			"f2",
			"docs/specs",
		);
		expect(state1.id).not.toBe(state2.id);
	});

	it("persists discovery topics and active topic on spec state", () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "spec-pipeline-topic-test-"),
		);
		try {
			const state = createInitialSpecState(
				"Build threaded discovery",
				"2605230739",
				"threaded_discovery",
				"docs/specs",
			);

			state.discovery!.topics = [
				{
					question: "Should discovery support follow-ups?",
					followUps: [],
					decision: "Yes, support natural follow-ups.",
					timestamp: "2026-05-23T07:39:00.000Z",
				},
			];
			state.discovery!.activeTopic = {
				question: "How should active threads resume?",
				followUps: [
					{
						userQuestion: "Can this survive restart?",
						agentAnswer: "It should be saved in DiscoveryState.",
						timestamp: "2026-05-23T07:40:00.000Z",
					},
				],
				decision: null,
				timestamp: "2026-05-23T07:39:30.000Z",
			};

			saveSpecState(tempDir, state);
			const loaded = loadSpecState(tempDir, state.id);

			expect(loaded).not.toBeNull();
			expect(loaded!.discovery!.topics).toEqual(state.discovery!.topics);
			expect(loaded!.discovery!.activeTopic).toEqual(
				state.discovery!.activeTopic,
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

// ============================================
// Hierarchy State Tests
// ============================================

describe("createInitialRoadmapState", () => {
	const defaultDiscoveryConfig = {
		enabled: true,
		maxRounds: 5,
		questionsPerRound: 4,
	};

	it("creates state with correct level and defaults", () => {
		const state = createInitialRoadmapState(
			"Warm machine pools initiative",
			"2602071200",
			"warm_pools",
			"docs",
		);
		expect(state.level).toBe("roadmap");
		expect(state.description).toBe("Warm machine pools initiative");
		expect(state.stage).toBe("discovery");
		expect(state.docFilename).toBe("2602071200_roadmap_warm_pools.md");
		expect(state.docPath).toBe("docs/2602071200_roadmap_warm_pools.md");
		expect(state.children).toEqual([]);
		expect(state.docApproved).toBe(false);
	});

	it("skips discovery when flag is set", () => {
		const state = createInitialRoadmapState(
			"Quick roadmap",
			"2602071200",
			"quick",
			"docs",
			true,
		);
		expect(state.stage).toBe("drafting");
		expect(state.discovery?.skipped).toBe(true);
	});
});

describe("createInitialEpicState", () => {
	const defaultDiscoveryConfig = {
		enabled: true,
		maxRounds: 5,
		questionsPerRound: 4,
	};

	it("creates state with correct level and defaults", () => {
		const state = createInitialEpicState(
			"Pool configuration",
			"2602071200",
			"pool_config",
			"docs",
		);
		expect(state.level).toBe("epic");
		expect(state.description).toBe("Pool configuration");
		expect(state.docFilename).toBe("2602071200_epic_pool_config.md");
		expect(state.children).toEqual([]);
	});

	it("stores parent reference when provided", () => {
		const state = createInitialEpicState(
			"Pool configuration",
			"2602071200",
			"pool_config",
			"docs",
			false,
			"md",
			"parent123",
			"roadmap",
		);
		expect(state.parentId).toBe("parent123");
		expect(state.parentType).toBe("roadmap");
	});
});

describe("extractChildItems", () => {
	it("extracts items from a standard child items table", () => {
		const doc = `# Warm Machine Pools Roadmap

## Child Items

| # | Item | Description | Priority | Dependencies |
|---|------|-------------|----------|--------------|
| 1 | Pool configuration | API and UI for warm pool settings | High | - |
| 2 | Provisioning engine | Background provisioning with retries | High | 1 |
| 3 | Billing integration | Track warm machine hours | Medium | 1 |
| 4 | Monitoring dashboard | Metrics and alerts | Low | 1, 2 |
`;
		const items = extractChildItems(doc);
		expect(items).toHaveLength(4);

		expect(items[0].number).toBe(1);
		expect(items[0].name).toBe("Pool configuration");
		expect(items[0].description).toBe("API and UI for warm pool settings");
		expect(items[0].priority).toBe("High");
		expect(items[0].dependencies).toEqual([]);

		expect(items[1].number).toBe(2);
		expect(items[1].dependencies).toEqual([1]);

		expect(items[2].priority).toBe("Medium");

		expect(items[3].number).toBe(4);
		expect(items[3].priority).toBe("Low");
		expect(items[3].dependencies).toEqual([1, 2]);
	});

	it("returns empty array when no child items table found", () => {
		const doc = `# Just a regular document

## Some Section

No child items here.
`;
		const items = extractChildItems(doc);
		expect(items).toHaveLength(0);
	});

	it("handles dependencies with 'None' keyword", () => {
		const doc = `| # | Item | Description | Priority | Dependencies |
|---|------|-------------|----------|--------------|
| 1 | First item | Desc | High | None |
`;
		const items = extractChildItems(doc);
		expect(items).toHaveLength(1);
		expect(items[0].dependencies).toEqual([]);
	});

	it("handles extra whitespace in cells", () => {
		const doc = `| # | Item | Description | Priority | Dependencies |
|---|------|-------------|----------|--------------|
|  1  |  Pool config  |  Some description  |  high  |  -  |
`;
		const items = extractChildItems(doc);
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe("Pool config");
		expect(items[0].priority).toBe("High");
	});

	it("stops parsing at end of table", () => {
		const doc = `| # | Item | Description | Priority | Dependencies |
|---|------|-------------|----------|--------------|
| 1 | Item one | Desc one | High | - |

## Next Section

Some other content.
`;
		const items = extractChildItems(doc);
		expect(items).toHaveLength(1);
	});
});

// ============================================
// Brainstorm State Tests
// ============================================

describe("createInitialBrainstormState", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setSystemTime(new Date("2026-02-17T11:19:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates state with correct defaults", () => {
		const state = createInitialBrainstormState(
			"Redesign the billing system",
			"2602171119",
			"billing_redesign",
			"docs/specs",
		);
		expect(state.description).toBe("Redesign the billing system");
		expect(state.stage).toBe("brainstorming");
		expect(state.docFilename).toBe("2602171119_brainstorm_billing_redesign.md");
		expect(state.docPath).toBe(
			"docs/specs/2602171119_brainstorm_billing_redesign.md",
		);
		expect(state.docContent).toBe("");
		expect(state.conversationHistory).toEqual([]);
	});

	it("uses specified spec format", () => {
		const state = createInitialBrainstormState(
			"Billing redesign",
			"2602171119",
			"billing",
			"docs",
			"typ",
		);
		expect(state.docFilename).toBe("2602171119_brainstorm_billing.typ");
	});

	it("sets timestamps correctly", () => {
		const state = createInitialBrainstormState(
			"Test",
			"2602171119",
			"test",
			"docs/specs",
		);
		expect(state.createdAt).toBe("2026-02-17T11:19:00.000Z");
		expect(state.updatedAt).toBe("2026-02-17T11:19:00.000Z");
	});

	it("generates unique IDs", () => {
		const state1 = createInitialBrainstormState("A", "2602171119", "a", "docs");
		const state2 = createInitialBrainstormState("B", "2602171120", "b", "docs");
		expect(state1.id).not.toBe(state2.id);
	});
});

describe("brainstorm state CRUD", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.useFakeTimers();
		setSystemTime(new Date("2026-02-17T11:19:00Z"));
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brainstorm-test-"));
	});

	afterEach(() => {
		vi.useRealTimers();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("saves and loads brainstorm state", () => {
		const state = createInitialBrainstormState(
			"Test brainstorm",
			"2602171119",
			"test",
			"docs",
		);
		saveBrainstormState(tmpDir, state);

		const loaded = loadBrainstormState(tmpDir, state.id);
		expect(loaded).not.toBeNull();
		expect(loaded!.description).toBe("Test brainstorm");
		expect(loaded!.stage).toBe("brainstorming");
		expect(loaded!.docFilename).toBe("2602171119_brainstorm_test.md");
	});

	it("returns null for non-existent state", () => {
		const loaded = loadBrainstormState(tmpDir, "nonexistent");
		expect(loaded).toBeNull();
	});

	it("creates directory on first save", () => {
		const stateDir = getBrainstormStateDir(tmpDir);
		expect(fs.existsSync(stateDir)).toBe(false);

		const state = createInitialBrainstormState(
			"Test",
			"2602171119",
			"test",
			"docs",
		);
		saveBrainstormState(tmpDir, state);

		expect(fs.existsSync(stateDir)).toBe(true);
	});

	it("updates updatedAt on save", () => {
		const state = createInitialBrainstormState(
			"Test",
			"2602171119",
			"test",
			"docs",
		);
		saveBrainstormState(tmpDir, state);

		setSystemTime(new Date("2026-02-17T12:00:00Z"));
		saveBrainstormState(tmpDir, state);

		const loaded = loadBrainstormState(tmpDir, state.id);
		expect(loaded!.updatedAt).toBe("2026-02-17T12:00:00.000Z");
	});

	it("lists brainstorm states sorted by createdAt descending", () => {
		const state1 = createInitialBrainstormState(
			"First",
			"2602171100",
			"first",
			"docs",
		);
		setSystemTime(new Date("2026-02-17T11:00:00Z"));
		state1.createdAt = new Date().toISOString();
		saveBrainstormState(tmpDir, state1);

		setSystemTime(new Date("2026-02-17T12:00:00Z"));
		const state2 = createInitialBrainstormState(
			"Second",
			"2602171200",
			"second",
			"docs",
		);
		state2.createdAt = new Date().toISOString();
		saveBrainstormState(tmpDir, state2);

		const states = listBrainstormStates(tmpDir);
		expect(states).toHaveLength(2);
		expect(states[0].description).toBe("Second");
		expect(states[1].description).toBe("First");
	});

	it("returns empty array when no brainstorms exist", () => {
		const states = listBrainstormStates(tmpDir);
		expect(states).toEqual([]);
	});

	it("getLatestActiveBrainstormPipeline returns active state", () => {
		const state = createInitialBrainstormState(
			"Active",
			"2602171119",
			"active",
			"docs",
		);
		saveBrainstormState(tmpDir, state);

		const active = getLatestActiveBrainstormPipeline(tmpDir);
		expect(active).not.toBeNull();
		expect(active!.description).toBe("Active");
	});

	it("getLatestActiveBrainstormPipeline skips completed states", () => {
		const state = createInitialBrainstormState(
			"Done",
			"2602171119",
			"done",
			"docs",
		);
		state.stage = "completed";
		saveBrainstormState(tmpDir, state);

		const active = getLatestActiveBrainstormPipeline(tmpDir);
		expect(active).toBeNull();
	});

	it("getLatestActiveBrainstormPipeline skips cancelled states", () => {
		const state = createInitialBrainstormState(
			"Cancelled",
			"2602171119",
			"cancelled",
			"docs",
		);
		state.stage = "cancelled";
		saveBrainstormState(tmpDir, state);

		const active = getLatestActiveBrainstormPipeline(tmpDir);
		expect(active).toBeNull();
	});

	it("getBrainstormStatePath returns correct path", () => {
		const p = getBrainstormStatePath(tmpDir, "test-id");
		expect(p).toBe(
			path.join(tmpDir, ".pi/spec-pipeline/brainstorms/test-id.json"),
		);
	});

	it("initializes missing fields on load", () => {
		const stateDir = getBrainstormStateDir(tmpDir);
		fs.mkdirSync(stateDir, { recursive: true });
		const minimalState = {
			id: "minimal-test",
			description: "Minimal",
			stage: "brainstorming",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			docTimestamp: "2602171119",
			docFilename: "2602171119_brainstorm_minimal.md",
			docPath: "docs/2602171119_brainstorm_minimal.md",
			docContent: "",
		};
		fs.writeFileSync(
			path.join(stateDir, "minimal-test.json"),
			JSON.stringify(minimalState),
			"utf-8",
		);

		const loaded = loadBrainstormState(tmpDir, "minimal-test");
		expect(loaded).not.toBeNull();
		expect(loaded!.checkpoints).toEqual([]);
		expect(loaded!.conversationHistory).toEqual([]);
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
