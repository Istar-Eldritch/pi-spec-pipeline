import { describe, it, expect } from "vitest";
import {
	buildPromptOptions,
	buildWorkspaceDirective,
	createSystemPrompts,
} from "./agents-config.ts";

const ROLES = [
	"planDrafter",
	"implementer",
	"codeReviewer",
	"commitMessageWriter",
	"addressReview",
] as const;

describe("buildWorkspaceDirective", () => {
	it("names the worktree path and forbids leaving it", () => {
		const wr = "/tmp/project/.pi/worktrees/feature-x";
		const directive = buildWorkspaceDirective(wr);
		expect(directive).toContain(wr);
		expect(directive).toContain("Working Directory Isolation");
		expect(directive).toContain("Do NOT");
		// The cd-escape footgun must be called out explicitly.
		expect(directive.toLowerCase()).toContain("cd");
	});
});

describe("createSystemPrompts — workspace isolation injection", () => {
	const projectConfig = { projectContext: "PROJECT_CONTEXT_MARKER" };

	it("prepends the worktree directive to EVERY role prompt when workRoot is set", () => {
		const workRoot = "/home/dev/repo/.pi/worktrees/iso-123";
		const prompts = createSystemPrompts(
			buildPromptOptions(projectConfig, workRoot),
		);
		for (const role of ROLES) {
			const p = prompts[role];
			expect(p, `${role} should contain the workRoot path`).toContain(workRoot);
			expect(
				p.startsWith("## CRITICAL: Working Directory Isolation"),
				`${role} should LEAD with the isolation directive`,
			).toBe(true);
		}
	});

	it("omits the directive when no workRoot is provided (legacy mode)", () => {
		const prompts = createSystemPrompts(buildPromptOptions(projectConfig));
		for (const role of ROLES) {
			expect(prompts[role]).not.toContain("Working Directory Isolation");
		}
	});

	it("still injects project context alongside the directive", () => {
		const prompts = createSystemPrompts(
			buildPromptOptions(projectConfig, "/w/root"),
		);
		// Roles that embed projectContext should retain it after the directive.
		expect(prompts.planDrafter).toContain("PROJECT_CONTEXT_MARKER");
		expect(prompts.planDrafter).toContain("Working Directory Isolation");
	});

	it("accepts workRoot via the options object directly", () => {
		const prompts = createSystemPrompts({
			projectContext: "ctx",
			workRoot: "/abs/worktree",
		});
		expect(prompts.implementer).toContain("/abs/worktree");
	});
});

// Regression: a review-fix agent for phase N produced phase N+1's deliverables
// ahead of schedule (epoch pipeline 20260621_090028_uprc), causing the later
// phase to fail with "no changes needed". The addressReview prompt must scope
// the agent to the CURRENT phase and forbid implementing later-phase work.
describe("createSystemPrompts — addressReview phase scope", () => {
	it("addressReview prompt constrains fixes to the current phase", () => {
		const prompts = createSystemPrompts(
			buildPromptOptions({ projectContext: "ctx" }),
		);
		expect(prompts.addressReview).toContain("Phase Scope");
		expect(prompts.addressReview).toContain("CURRENT phase");
		expect(prompts.addressReview).toContain("LATER phases");
		expect(prompts.addressReview.toLowerCase()).toContain(
			"do not implement deliverables",
		);
	});

	it("non-fix roles are not polluted with the phase-scope directive", () => {
		const prompts = createSystemPrompts(
			buildPromptOptions({ projectContext: "ctx" }),
		);
		expect(prompts.implementer).not.toContain("Phase Scope");
		expect(prompts.codeReviewer).not.toContain("Phase Scope");
	});
});
