import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	createInitialSpecState,
	saveSpecState,
	getLatestActiveSpecPipeline,
	loadSpecState,
} from "./state.ts";

const { mockRunAgentWithConfig, mockValidateGitRepo, mockLoadPipelineConfig } =
	vi.hoisted(() => ({
		mockRunAgentWithConfig: vi.fn(),
		mockValidateGitRepo: vi.fn(),
		mockLoadPipelineConfig: vi.fn(),
	}));

vi.mock("./agents.ts", async () => {
	const actual =
		await vi.importActual<typeof import("./agents.ts")>("./agents.ts");
	return {
		...actual,
		runAgentWithConfig: mockRunAgentWithConfig,
	};
});

vi.mock("./git.ts", async () => {
	const actual = await vi.importActual<typeof import("./git.ts")>("./git.ts");
	return {
		...actual,
		validateGitRepo: mockValidateGitRepo,
	};
});

vi.mock("./config.ts", async () => {
	const actual =
		await vi.importActual<typeof import("./config.ts")>("./config.ts");
	return {
		...actual,
		loadPipelineConfig: mockLoadPipelineConfig,
	};
});

const testProjectConfig = {
	specsDir: "docs/specs",
	testCommand: null,
	contextFiles: [],
	projectContext: "Project context",
	projectContextForReviewer: "Project context",
	projectContextForFixer: "Project context",
	specTemplate: null,
	specTemplatePath: null,
	specConventions: null,
	specConventionsPath: null,
	specFormat: "md",
	models: {
		planDrafter: { model: "gpt-5.5", thinking: "high" },
		implementer: { model: "gpt-5.5", thinking: "high" },
		codeReviewer: { model: "gpt-5.4", thinking: "medium" },
		addressReview: { model: "gpt-5.4", thinking: "medium" },
		agentCommitMessageWriter: { model: "gpt-5.4-mini", thinking: "off" },
		roadmapDrafter: { model: "gpt-5.5", thinking: "high" },
		roadmapReviewer: { model: "gpt-5.4", thinking: "medium" },
		epicDrafter: { model: "gpt-5.5", thinking: "high" },
		epicReviewer: { model: "gpt-5.4", thinking: "medium" },
	},
	reviewCycles: 2,
	skipPlanGeneration: false,
} as const;

type MockCommand = { handler: (args: string, ctx: any) => Promise<void> };
type MockEventHandler = (event: any, ctx: any) => Promise<any>;

function createMockPi() {
	const commands = new Map<string, MockCommand>();
	const events = new Map<string, MockEventHandler>();

	return {
		commands,
		events,
		sendUserMessage: vi.fn(),
		registerCommand: vi.fn((name: string, command: MockCommand) => {
			commands.set(name, command);
		}),
		on: vi.fn((name: string, handler: MockEventHandler) => {
			events.set(name, handler);
		}),
	};
}

function createMockCtx(cwd: string) {
	const notifications: Array<{ message: string; type: string }> = [];
	const ctx = {
		hasUI: true,
		cwd,
		ui: {
			notify: vi.fn((message: string, type: string) => {
				notifications.push({ message, type });
			}),
			confirm: vi.fn(async () => true),
			input: vi.fn(async (_title: string, placeholder?: string) => placeholder),
			setWidget: vi.fn(),
		},
	};
	return { ctx, notifications };
}

describe("spec discovery loop", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "spec-pipeline-loop-test-"));
		vi.clearAllMocks();
		mockValidateGitRepo.mockResolvedValue({ valid: true });
		mockLoadPipelineConfig.mockReturnValue({
			success: true,
			config: testProjectConfig,
			fromFile: false,
		});
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("closes the active topic on plain user input and syncs topics into conversationHistory on READY_TO_DRAFT", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx, notifications } = createMockCtx(cwd);

		let resolveReady: ((value: { output: string }) => void) | null = null;
		mockRunAgentWithConfig
			.mockResolvedValueOnce({ output: "Should we support SSO from day one?" })
			.mockImplementationOnce(
				() =>
					new Promise<{ output: string }>(
						(resolve: (value: { output: string }) => void) => {
							resolveReady = resolve;
						},
					),
			);

		await pi.commands.get("spec")!.handler("Add authentication", ctx);

		await vi.waitFor(() => {
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(1);
		});

		let state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.discovery?.activeTopic?.question).toContain("SSO");
		expect(state.discovery?.topics).toEqual([]);

		const inputResult = await pi.events.get("input")!(
			{ text: "No, email/password first.", source: "user" },
			ctx,
		);
		expect(inputResult).toEqual({ action: "handled" });

		await vi.waitFor(() => {
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(2);
		});
		expect(mockRunAgentWithConfig.mock.calls[0][0]).toBe(
			testProjectConfig.models.planDrafter,
		);
		expect(mockRunAgentWithConfig.mock.calls[1][0]).toBe(
			testProjectConfig.models.planDrafter,
		);
		expect(
			notifications.some((entry) =>
				entry.message.includes(
					"Checking whether this is a follow-up or a decision",
				),
			),
		).toBe(false);

		state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.discovery?.activeTopic).toBeNull();
		expect(state.discovery?.topics).toHaveLength(1);
		expect(state.discovery?.topics?.[0].decision).toBe(
			"No, email/password first.",
		);

		(resolveReady as unknown as (value: { output: string }) => void)({
			output: "READY_TO_DRAFT",
		});

		await vi.waitFor(() => {
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		});

		state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.stage).toBe("spec_drafting");
		expect(state.discovery?.completed).toBe(true);
		expect(state.discovery?.topics).toHaveLength(1);
		expect(state.discovery?.activeTopic).toBeNull();
		expect(state.discovery?.conversationHistory).toEqual([
			{
				userMessage: "No, email/password first.",
				assistantResponse: "Should we support SSO from day one?",
				timestamp: state.discovery!.topics![0].timestamp,
			},
		]);
	});

	it("classifies question-shaped replies as follow-ups and keeps the active topic open", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx, notifications } = createMockCtx(cwd);

		mockRunAgentWithConfig
			.mockResolvedValueOnce({
				output: "Should enterprise tenants require SSO?",
			})
			.mockResolvedValueOnce({ output: "FOLLOWUP" })
			.mockResolvedValueOnce({
				output:
					"Optional SSO would allow local accounts to remain available while enterprise tenants configure identity providers.",
			});

		await pi.commands.get("spec")!.handler("Add authentication", ctx);

		await vi.waitFor(() => {
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(1);
		});

		const inputResult = await pi.events.get("input")!(
			{
				text: "What would optional SSO mean for local accounts?",
				source: "user",
			},
			ctx,
		);

		expect(inputResult).toEqual({ action: "handled" });
		expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(3);
		expect(mockRunAgentWithConfig.mock.calls[1][0]).toBe(
			testProjectConfig.models.agentCommitMessageWriter,
		);
		expect(mockRunAgentWithConfig.mock.calls[1][6]).toBe("commitMessageWriter");
		expect(mockRunAgentWithConfig.mock.calls[2][0]).toBe(
			testProjectConfig.models.planDrafter,
		);
		expect(mockRunAgentWithConfig.mock.calls[2][6]).toBe("brainstormAgent");
		expect(mockRunAgentWithConfig.mock.calls[2][3]).toContain(
			"Do NOT ask or propose a new unrelated discovery topic",
		);

		const state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.discovery?.topics).toEqual([]);
		expect(state.discovery?.activeTopic).toMatchObject({
			question: "Should enterprise tenants require SSO?",
			decision: null,
			followUps: [
				{
					userQuestion: "What would optional SSO mean for local accounts?",
					agentAnswer:
						"Optional SSO would allow local accounts to remain available while enterprise tenants configure identity providers.",
				},
			],
		});
		expect(
			notifications.some((entry) => entry.message.includes("Follow-up answer")),
		).toBe(true);
	});

	it("persists an in-flight follow-up placeholder and then fills the answer", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx } = createMockCtx(cwd);

		let resolveFollowUp!: (value: { output: string }) => void;
		mockRunAgentWithConfig
			.mockResolvedValueOnce({
				output: "Should enterprise tenants require SSO?",
			})
			.mockResolvedValueOnce({ output: "FOLLOWUP" })
			.mockImplementationOnce(
				() =>
					new Promise<{ output: string }>((resolve) => {
						resolveFollowUp = resolve;
					}),
			);

		await pi.commands.get("spec")!.handler("Add authentication", ctx);
		await vi.waitFor(() =>
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(1),
		);

		const inputPromise = pi.events.get("input")!(
			{
				text: "What would optional SSO mean for local accounts?",
				source: "user",
			},
			ctx,
		);

		await vi.waitFor(() =>
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(3),
		);

		let state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.discovery?.activeTopic?.followUps).toMatchObject([
			{
				userQuestion: "What would optional SSO mean for local accounts?",
				agentAnswer: "",
			},
		]);

		resolveFollowUp({
			output: "It allows fallback local login while SSO is configured.",
		});
		await expect(inputPromise).resolves.toEqual({ action: "handled" });

		state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.discovery?.activeTopic?.followUps?.[0].agentAnswer).toBe(
			"It allows fallback local login while SSO is configured.",
		);
		expect(state.discovery?.topics).toEqual([]);
	});

	it("closes the same topic and advances discovery after a follow-up decision", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx } = createMockCtx(cwd);

		mockRunAgentWithConfig
			.mockResolvedValueOnce({
				output: "Should enterprise tenants require SSO?",
			})
			.mockResolvedValueOnce({ output: "FOLLOWUP" })
			.mockResolvedValueOnce({
				output: "It allows fallback local login while SSO is configured.",
			})
			.mockResolvedValueOnce({ output: "READY_TO_DRAFT" });

		await pi.commands.get("spec")!.handler("Add authentication", ctx);
		await vi.waitFor(() =>
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(1),
		);

		await expect(
			pi.events.get("input")!(
				{
					text: "What would optional SSO mean for local accounts?",
					source: "user",
				},
				ctx,
			),
		).resolves.toEqual({ action: "handled" });
		expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(3);

		await expect(
			pi.events.get("input")!(
				{ text: "Yes, make SSO optional.", source: "user" },
				ctx,
			),
		).resolves.toEqual({ action: "handled" });

		let state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.discovery?.topics).toHaveLength(1);
		expect(state.discovery?.topics?.[0]).toMatchObject({
			question: "Should enterprise tenants require SSO?",
			decision: "Yes, make SSO optional.",
			followUps: [
				{
					userQuestion: "What would optional SSO mean for local accounts?",
					agentAnswer:
						"It allows fallback local login while SSO is configured.",
				},
			],
		});
		expect(state.discovery?.activeTopic).toBeNull();

		await vi.waitFor(() =>
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(4),
		);
		expect(mockRunAgentWithConfig.mock.calls[3][0]).toBe(
			testProjectConfig.models.planDrafter,
		);
		expect(mockRunAgentWithConfig.mock.calls[3][6]).toBe("brainstormAgent");

		await vi.waitFor(() => {
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		});

		state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.stage).toBe("spec_drafting");
		expect(state.discovery?.discoverySummary).toContain("### Topic 1:");
		expect(state.discovery?.discoverySummary).toContain(
			"**Decision:** Yes, make SSO optional.",
		);
		expect(state.discovery?.discoverySummary).toContain(
			"**Supporting thread:**",
		);
		expect(state.discovery?.discoverySummary).toContain(
			"- **Q:** What would optional SSO mean for local accounts?",
		);
		expect(state.discovery?.discoverySummary).not.toContain("### Exchange 1");
	});

	it("removes the placeholder and keeps the topic open when the follow-up agent fails", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx, notifications } = createMockCtx(cwd);

		mockRunAgentWithConfig
			.mockResolvedValueOnce({
				output: "Should enterprise tenants require SSO?",
			})
			.mockResolvedValueOnce({ output: "FOLLOWUP" })
			.mockRejectedValueOnce(new Error("follow-up unavailable"));

		await pi.commands.get("spec")!.handler("Add authentication", ctx);
		await vi.waitFor(() =>
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(1),
		);

		const inputResult = pi.events.get("input")!(
			{
				text: "What would optional SSO mean for local accounts?",
				source: "user",
			},
			ctx,
		);

		await expect(inputResult).resolves.toEqual({ action: "handled" });
		expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(3);

		const state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.discovery?.activeTopic).toMatchObject({
			question: "Should enterprise tenants require SSO?",
			decision: null,
			followUps: [],
		});
		expect(state.discovery?.topics).toEqual([]);
		expect(
			notifications.some((entry) =>
				entry.message.includes("Discovery follow-up agent failed"),
			),
		).toBe(true);
	});

	it("falls back to decision when the classifier fails", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx } = createMockCtx(cwd);

		mockRunAgentWithConfig
			.mockResolvedValueOnce({ output: "Should we support local auth?" })
			.mockRejectedValueOnce(new Error("classifier unavailable"))
			.mockResolvedValueOnce({ output: "READY_TO_DRAFT" });

		await pi.commands.get("spec")!.handler("Add authentication", ctx);
		await vi.waitFor(() =>
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(1),
		);

		const inputResult = await pi.events.get("input")!(
			{ text: "local auth only for launch", source: "user" },
			ctx,
		);

		expect(inputResult).toEqual({ action: "handled" });
		await vi.waitFor(() =>
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(3),
		);

		const state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.discovery?.topics).toHaveLength(1);
		expect(state.discovery?.topics?.[0]).toMatchObject({
			question: "Should we support local auth?",
			decision: "local auth only for launch",
		});
		expect(state.discovery?.activeTopic).toBeNull();
	});

	it("falls back to decision when the classifier returns malformed output", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx } = createMockCtx(cwd);

		mockRunAgentWithConfig
			.mockResolvedValueOnce({ output: "Should we support local auth?" })
			.mockResolvedValueOnce({ output: "MAYBE_DECISION" })
			.mockResolvedValueOnce({ output: "READY_TO_DRAFT" });

		await pi.commands.get("spec")!.handler("Add authentication", ctx);
		await vi.waitFor(() =>
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(1),
		);

		const inputResult = await pi.events.get("input")!(
			{ text: "local auth only for launch", source: "user" },
			ctx,
		);

		expect(inputResult).toEqual({ action: "handled" });
		await vi.waitFor(() =>
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(3),
		);

		const state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.discovery?.topics).toHaveLength(1);
		expect(state.discovery?.topics?.[0]).toMatchObject({
			question: "Should we support local auth?",
			decision: "local auth only for launch",
		});
		expect(state.discovery?.activeTopic).toBeNull();
	});

	it("preserves an open topic with decision null when /discovery-done is used", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx } = createMockCtx(cwd);

		mockRunAgentWithConfig.mockResolvedValueOnce({
			output: "Should tenant admins manage user invites?",
		});

		await pi.commands.get("spec")!.handler("Add team invitations", ctx);

		await vi.waitFor(() => {
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(1);
		});

		await pi.commands.get("discovery-done")!.handler("", ctx);

		await vi.waitFor(() => {
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		});

		const state = getLatestActiveSpecPipeline(cwd)!;
		expect(state.stage).toBe("spec_drafting");
		expect(state.discovery?.completed).toBe(true);
		expect(state.discovery?.topics).toHaveLength(1);
		expect(state.discovery?.topics?.[0]).toMatchObject({
			question: "Should tenant admins manage user invites?",
			decision: null,
		});
		expect(state.discovery?.activeTopic).toBeNull();
		expect(state.discovery?.conversationHistory?.[0]).toMatchObject({
			userMessage: "(No final decision recorded)",
			assistantResponse: "Should tenant admins manage user invites?",
		});
	});

	it("restores persisted discovery loop state on /spec-resume", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx, notifications } = createMockCtx(cwd);

		const state = createInitialSpecState(
			"Add authentication",
			"2605231200",
			"auth",
			"docs/specs",
			false,
			"md",
		);
		state.discovery!.topics = [
			{
				question: "Should local auth remain supported?",
				followUps: [],
				decision: "Yes, keep both local auth and SSO.",
				timestamp: "2026-05-23T12:00:00.000Z",
			},
		];
		state.discovery!.activeTopic = {
			question: "Should SSO be mandatory for enterprise tenants?",
			followUps: [],
			decision: null,
			timestamp: "2026-05-23T12:05:00.000Z",
		};
		saveSpecState(cwd, state);

		let continueDiscovery!: (value: { output: string }) => void;
		mockRunAgentWithConfig.mockImplementationOnce(
			() =>
				new Promise<{ output: string }>(
					(resolve: (value: { output: string }) => void) => {
						continueDiscovery = resolve;
					},
				),
		);

		await pi.commands.get("spec-resume")!.handler(state.id, ctx);

		expect(mockRunAgentWithConfig).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(
			notifications.some((entry) =>
				entry.message.includes("Resuming topic: Should SSO be mandatory"),
			),
		).toBe(true);
		expect(
			notifications.some((entry) =>
				entry.message.includes(
					"Should SSO be mandatory for enterprise tenants?",
				),
			),
		).toBe(true);

		const inputResult = await pi.events.get("input")!(
			{ text: "No, make it optional.", source: "user" },
			ctx,
		);
		expect(inputResult).toEqual({ action: "handled" });

		await vi.waitFor(() => {
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(1);
		});

		const resumedState = loadSpecState(cwd, state.id)!;
		expect(resumedState.discovery?.topics).toHaveLength(2);
		expect(resumedState.discovery?.topics?.[1]).toMatchObject({
			question: "Should SSO be mandatory for enterprise tenants?",
			decision: "No, make it optional.",
		});
		expect(resumedState.discovery?.activeTopic).toBeNull();

		continueDiscovery({ output: "READY_TO_DRAFT" });
	});

	it("drops an in-flight empty follow-up placeholder when resuming an active topic", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx } = createMockCtx(cwd);

		const state = createInitialSpecState(
			"Add authentication",
			"2605231201",
			"auth",
			"docs/specs",
			false,
			"md",
		);
		state.discovery!.activeTopic = {
			question: "Should enterprise tenants require SSO?",
			followUps: [
				{
					userQuestion: "What happens to local accounts?",
					agentAnswer: "",
					timestamp: "2026-05-23T12:06:00.000Z",
				},
			],
			decision: null,
			timestamp: "2026-05-23T12:05:00.000Z",
		};
		saveSpecState(cwd, state);

		await pi.commands.get("spec-resume")!.handler(state.id, ctx);

		const resumedState = loadSpecState(cwd, state.id)!;
		expect(resumedState.discovery?.activeTopic?.followUps).toEqual([]);
		expect(mockRunAgentWithConfig).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("continues discovery on /spec-resume when completed topics exist but no active topic", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx } = createMockCtx(cwd);

		const state = createInitialSpecState(
			"Add authentication",
			"2605231202",
			"auth",
			"docs/specs",
			false,
			"md",
		);
		state.discovery!.topics = [
			{
				question: "Should local auth remain supported?",
				followUps: [],
				decision: "Yes.",
				timestamp: "2026-05-23T12:00:00.000Z",
			},
		];
		state.discovery!.activeTopic = null;
		saveSpecState(cwd, state);

		mockRunAgentWithConfig.mockResolvedValueOnce({
			output: "Should SSO be mandatory?",
		});

		await pi.commands.get("spec-resume")!.handler(state.id, ctx);

		await vi.waitFor(() => {
			expect(mockRunAgentWithConfig).toHaveBeenCalledTimes(1);
		});
		expect(pi.sendUserMessage).not.toHaveBeenCalled();

		const resumedState = loadSpecState(cwd, state.id)!;
		expect(resumedState.discovery?.topics).toHaveLength(1);
		expect(resumedState.discovery?.activeTopic?.question).toBe(
			"Should SSO be mandatory?",
		);
	});

	it("uses legacy host-agent resume when no topic-loop state exists", async () => {
		const { default: specPipeline } = await import("./index.ts");
		const pi = createMockPi();
		specPipeline(pi as any);
		const { ctx } = createMockCtx(cwd);

		const state = createInitialSpecState(
			"Add authentication",
			"2605231203",
			"auth",
			"docs/specs",
			false,
			"md",
		);
		state.discovery!.topics = [];
		state.discovery!.activeTopic = null;
		saveSpecState(cwd, state);

		await pi.commands.get("spec-resume")!.handler(state.id, ctx);

		expect(mockRunAgentWithConfig).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining(
				"I'm resuming the discovery session for: Add authentication",
			),
		);
	});
});
