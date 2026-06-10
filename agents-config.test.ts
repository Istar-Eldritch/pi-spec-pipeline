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
