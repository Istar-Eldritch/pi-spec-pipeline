import { describe, it, expect, vi, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import { generateCommitMessage, extractPhaseName, extractDocName } from "./commit-agent.ts";
import type { CommitMessageContext } from "./commit-agent.ts";

// Mock state shared with the spawn mock below.
// - mockOutput: chunks the fake pi subprocess will stream as JSON events
// - mockExitCode: exit code the fake pi subprocess will report
// - mockShouldError: true → emit an 'error' event instead of running
// - mockNeverExit: true → spawn but never close (forces timeout path; we shorten it)
let mockOutput = "";
let mockExitCode = 0;
let mockShouldError = false;
let mockNeverExit = false;

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => {
		const proc = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill: (sig?: string) => void;
			killed: boolean;
		};
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.killed = false;
		proc.kill = () => { proc.killed = true; };

		if (mockShouldError) {
			setImmediate(() => proc.emit("error", new Error("spawn ENOENT")));
			return proc;
		}
		if (mockNeverExit) {
			return proc; // caller's timeout will fire
		}

		setImmediate(() => {
			// Stream the configured output as a single text_delta event so we
			// exercise the JSON-line parser the way pi actually emits.
			if (mockOutput) {
				const event = JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: mockOutput },
				});
				proc.stdout.emit("data", Buffer.from(event + "\n"));
			}
			proc.emit("close", mockExitCode);
		});
		return proc;
	}),
}));

beforeEach(() => {
	mockOutput = "";
	mockExitCode = 0;
	mockShouldError = false;
	mockNeverExit = false;
});

describe("generateCommitMessage (pi subprocess)", () => {
	describe("successful generation", () => {
		it("returns the model output when it's a valid conventional commit", async () => {
			mockOutput = "docs(phase-1): add implementation plan for user authentication";

			const context: CommitMessageContext = {
				role: "planDrafter",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["docs/plan-phase1.md"],
				phase: 1,
			};

			const result = await generateCommitMessage(context);
			expect(result.type).toBe("success");
			expect(result.message).toBe("docs(phase-1): add implementation plan for user authentication");
		});

		it("strips an outer fenced code block", async () => {
			mockOutput = "```\nfeat(phase-2): add user authentication endpoints\n```";

			const context: CommitMessageContext = {
				role: "implementer",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/auth.ts"],
				phase: 2,
			};

			const result = await generateCommitMessage(context);
			expect(result.type).toBe("success");
			expect(result.message).toBe("feat(phase-2): add user authentication endpoints");
		});

		it("preserves a multi-line body", async () => {
			mockOutput = "feat(phase-1): add auth middleware\n\n- wires session management into the request pipeline\n- validates JWT signatures before downstream handlers run";

			const context: CommitMessageContext = {
				role: "implementer",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/middleware.ts"],
				phase: 1,
			};

			const result = await generateCommitMessage(context);
			expect(result.type).toBe("success");
			expect(result.message).toContain("feat(phase-1): add auth middleware");
			expect(result.message).toContain("wires session management");
			expect(result.message).toContain("validates JWT signatures");
		});

		it("strips common preambles like 'Here is the commit message:'", async () => {
			mockOutput = "Here is the commit message:\nfeat(jobs): add bulk download endpoint";

			const context: CommitMessageContext = {
				role: "implementer",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/jobs.ts"],
				phase: 3,
			};

			const result = await generateCommitMessage(context);
			expect(result.type).toBe("success");
			expect(result.message).toBe("feat(jobs): add bulk download endpoint");
		});

		it("accepts scope-less conventional commits", async () => {
			mockOutput = "feat: enable websockets across all routes";

			const result = await generateCommitMessage({
				role: "implementer",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/ws.ts"],
				phase: 1,
			});
			expect(result.type).toBe("success");
			expect(result.message).toBe("feat: enable websockets across all routes");
		});
	});

	describe("fallback behavior", () => {
		it("falls back when the model output isn't conventional-commit format", async () => {
			mockOutput = "This is not a conventional commit message";

			const result = await generateCommitMessage({
				role: "planDrafter",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["docs/plan.md"],
			});
			expect(result.type).toBe("fallback");
			expect(result.message).toContain("docs(pipeline): create implementation plan");
		});

		it("falls back when the subprocess errors out", async () => {
			mockShouldError = true;

			const result = await generateCommitMessage({
				role: "implementer",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/api.ts"],
				phase: 2,
			});
			expect(result.type).toBe("fallback");
			expect(result.message).toContain("feat(phase-2): implement phase changes");
		});

		it("falls back on non-zero exit code", async () => {
			mockOutput = "";
			mockExitCode = 1;

			const result = await generateCommitMessage({
				role: "addressReview",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/fix.ts"],
				phase: 1,
				cycle: 2,
			});
			expect(result.type).toBe("fallback");
			expect(result.message).toContain("fix(phase-1): address review feedback (cycle 2)");
		});

		it("falls back on empty output", async () => {
			mockOutput = "";

			const result = await generateCommitMessage({
				role: "implementer",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/a.ts", "src/b.ts", "tests/a.test.ts"],
				phase: 1,
			});
			expect(result.type).toBe("fallback");
			expect(result.message).toContain("feat(phase-1): implement phase changes");
			expect(result.message).toContain("- src/a.ts");
			expect(result.message).toContain("- src/b.ts");
			expect(result.message).toContain("- tests/a.test.ts");
		});
	});

	describe("fallback templates per role", () => {
		it("generates planDrafter fallback", async () => {
			mockShouldError = true;
			const result = await generateCommitMessage({
				role: "planDrafter",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["docs/plan.md"],
				phase: 3,
			});
			expect(result.message).toContain("docs(phase-3): create implementation plan");
		});

		it("generates implementer fallback", async () => {
			mockShouldError = true;
			const result = await generateCommitMessage({
				role: "implementer",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/code.ts"],
				phase: 2,
			});
			expect(result.message).toContain("feat(phase-2): implement phase changes");
		});

		it("generates addressReview fallback with cycle", async () => {
			mockShouldError = true;
			const result = await generateCommitMessage({
				role: "addressReview",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/api.ts"],
				phase: 1,
				cycle: 3,
			});
			expect(result.message).toContain("fix(phase-1): address review feedback (cycle 3)");
		});

		it("generates codeReviewer fallback", async () => {
			mockShouldError = true;
			const result = await generateCommitMessage({
				role: "codeReviewer",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/code.ts"],
				phase: 1,
			});
			expect(result.message).toContain("refactor(phase-1): apply code review changes");
		});

		it("generates chore fallback for unknown roles", async () => {
			mockShouldError = true;
			const result = await generateCommitMessage({
				role: "unknownRole" as any,
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["notes.md"],
			});
			expect(result.message).toContain("chore(pipeline): unknownRole changes");
		});

	});

	describe("phase name handling in fallback scope", () => {
		it("includes short phase names in scope", async () => {
			mockShouldError = true;
			const result = await generateCommitMessage({
				role: "implementer",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/api.ts"],
				phase: 1,
				phaseName: "backend api",
			});
			expect(result.message).toContain("feat(phase-1/backend api): implement phase changes");
		});

		it("drops overly long phase names rather than truncating with '...'", async () => {
			mockShouldError = true;
			const result = await generateCommitMessage({
				role: "implementer",
				modelConfig: { model: "claude-native/haiku", thinking: "off" },
				files: ["src/x.ts"],
				phase: 3,
				phaseName: "frontend renamefilemodalhtm bunch of stuff",
			});
			// No "..." truncation — just use the phase number.
			expect(result.message).toContain("feat(phase-3): implement phase changes");
			expect(result.message).not.toContain("...");
		});
	});

	describe("phase name extraction", () => {
		it("extracts phase name from a phase path", () => {
			expect(extractPhaseName("20250209_myproject/phase1_backend_api.md")).toBe("backend api");
			expect(extractPhaseName("20250209_myproject/phase2_frontend_components.md")).toBe("frontend components");
			expect(extractPhaseName("specs/phase10_database_migrations.md")).toBe("database migrations");
		});

		it("handles underscore-separated names", () => {
			expect(extractPhaseName("20250209_project/phase1_user_auth_system.md")).toBe("user auth system");
		});

		it("returns undefined for invalid paths", () => {
			expect(extractPhaseName("invalid.md")).toBeUndefined();
			expect(extractPhaseName("phase1.md")).toBeUndefined();
			expect(extractPhaseName("")).toBeUndefined();
			expect(extractPhaseName("no-phase-here.md")).toBeUndefined();
		});
	});

	describe("document name extraction", () => {
		it("extracts doc name from spec filename", () => {
			expect(extractDocName("20250209_spec_user_auth.md")).toBe("user auth");
		});

		it("extracts doc name from roadmap filename", () => {
			expect(extractDocName("2602071200_roadmap_warm_pools.md")).toBe("warm pools");
		});

		it("extracts doc name from epic filename", () => {
			expect(extractDocName("2602071200_epic_payment_system.md")).toBe("payment system");
		});

		it("handles .typ extension", () => {
			expect(extractDocName("20250209_spec_api_design.typ")).toBe("api design");
		});

		it("extracts name from brainstorm filename", () => {
			expect(extractDocName("2602171000_brainstorm_billing_redesign.md")).toBe("billing redesign");
		});

		it("returns undefined for invalid filenames", () => {
			expect(extractDocName("invalid.md")).toBeUndefined();
			expect(extractDocName("spec_no_timestamp.md")).toBeUndefined();
			expect(extractDocName("")).toBeUndefined();
		});
	});
});
