/**
 * Commit message generation.
 *
 * Spawns a `pi` subprocess in print/no-tools mode to generate conventional-commit
 * messages from the staged diff. Subprocess (not in-process SDK) is intentional:
 * spec-pipeline configs often reference custom-provider models (e.g.
 * `claude-native/haiku`) registered by sibling extensions at pi startup. Those
 * providers are not visible to a fresh in-process SDK session, so the previous
 * in-process implementation silently fell back to template messages for any
 * non-built-in provider.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelConfig, RoleName } from "./types.ts";

// ============================================
// Types
// ============================================

export interface CommitMessageContext {
	/** The role that performed the work (e.g., "specDrafter", "implementer") */
	role: RoleName;
	/** The model configuration that was used for the actual work */
	modelConfig: ModelConfig;
	/** Files that were modified by the agent */
	files: string[];
	/** Phase number (1-indexed) if in implementation stage */
	phase?: number;
	/** Phase name/description extracted from the phase file path */
	phaseName?: string;
	/** Document name for roadmap/epic (e.g., "warm pools", "user auth") */
	docName?: string;
	/** Cycle number (1-indexed) if in implementation stage */
	cycle?: number;
	/** Review feedback that was addressed (if applicable) */
	reviewFeedback?: string;
	/** The staged git diff showing actual changes */
	diff?: string;
}

export type CommitMessageResult =
	| { type: "success"; message: string }
	| { type: "fallback"; message: string };

// ============================================
// Phase/Doc Name Extraction
// ============================================

/**
 * Extract phase name from a phase path.
 * Phase paths look like: "20250209_myproject/phase1_backend_api.md"
 * This extracts "backend_api" → "backend api"
 */
export function extractPhaseName(phasePath: string): string | undefined {
	const filename = phasePath.split("/").pop();
	if (!filename) return undefined;
	const match = filename.match(/^phase\d+_(.+)\.md$/);
	if (!match) return undefined;
	return match[1].replace(/_/g, " ");
}

/**
 * Extract document name from spec/roadmap/epic filename.
 * e.g. "2602071200_roadmap_warm_pools.md" → "warm pools"
 */
export function extractDocName(filename: string): string | undefined {
	const name = filename.split("/").pop();
	if (!name) return undefined;
	const match = name.match(
		/^\d+_(?:spec|roadmap|epic|discovery|brainstorm|fix|guide)_(.+)\.(md|typ)$/,
	);
	if (!match) return undefined;
	return match[1].replace(/_/g, " ");
}

// ============================================
// Fallback Template
// ============================================

const MAX_FILES_IN_BODY = 20;
/** Phase-name scopes longer than this are dropped from the scope (template only). */
const MAX_PHASE_NAME_IN_SCOPE = 24;

/**
 * Pick a short scope for fallback messages.
 *
 * Truncating phase names with "..." produces ugly scopes like
 * `phase-3/frontend renamefilemodalhtm...`, so when the phase name would be
 * too long we just drop it and use `phase-N`.
 */
function phaseScope(phase?: number, phaseName?: string): string {
	if (phase === undefined) return "pipeline";
	if (phaseName && phaseName.length <= MAX_PHASE_NAME_IN_SCOPE) {
		return `phase-${phase}/${phaseName}`;
	}
	return `phase-${phase}`;
}

function buildFileListBody(files: string[]): string {
	if (files.length === 0) return "";
	const lines: string[] = [""];
	const shown = files.slice(0, MAX_FILES_IN_BODY);
	for (const file of shown) lines.push(`- ${file}`);
	if (files.length > MAX_FILES_IN_BODY) {
		lines.push(`- ... and ${files.length - MAX_FILES_IN_BODY} more files`);
	}
	return lines.join("\n");
}

/**
 * Last-resort message used when the LLM call fails. Generic by design — the
 * file list at least tells a human reader which area was touched.
 */
function generateFallbackMessage(context: CommitMessageContext): string {
	const { role, files, phase, phaseName, cycle, docName } = context;
	const scope = docName ?? phaseScope(phase, phaseName);
	const body = buildFileListBody(files);

	let subject: string;
	switch (role) {
		case "planDrafter":
			subject = `docs(${scope}): create implementation plan`;
			break;
		case "implementer":
			subject = `feat(${scope}): implement phase changes`;
			break;
		case "addressReview":
			subject =
				cycle !== undefined
					? `fix(${scope}): address review feedback (cycle ${cycle})`
					: `fix(${scope}): address review feedback`;
			break;
		case "codeReviewer":
			subject = `refactor(${scope}): apply code review changes`;
			break;
		default:
			subject = `chore(${scope}): ${role} changes`;
			break;
	}
	return body ? `${subject}\n${body}` : subject;
}

// ============================================
// Prompt
// ============================================

/**
 * Maximum diff bytes we feed the model. The diff drives message quality, but
 * large diffs (8KB+) waste cache and rarely add information past the first
 * couple of hunks. The truncation marker tells the model not to assume the
 * whole diff was shown.
 */
const MAX_DIFF_LENGTH = 8000;

function truncateDiff(diff: string): string {
	if (diff.length <= MAX_DIFF_LENGTH) return diff;
	return diff.slice(0, MAX_DIFF_LENGTH) + "\n... (diff truncated)";
}

function buildSystemPrompt(): string {
	return [
		"You write git commit messages for an automated spec-pipeline. Output ONLY the commit message — no preamble, no explanation, no surrounding code fences.",
		"",
		"Format: conventional commits.",
		"  <type>(<scope>): <subject>",
		"  ",
		"  <optional body>",
		"",
		"Rules:",
		"- type: feat | fix | docs | refactor | test | chore",
		"- subject: lowercase, imperative mood ('add X', not 'added X'), no trailing period, under 72 characters",
		"- subject MUST describe what the staged diff actually does — not the role or phase name",
		"- body (optional): 1–4 short bullet points explaining what changed and why, wrapped at ~72 chars. Skip the body if the subject is self-explanatory.",
		"- Do NOT echo file paths as a bullet list — the body should explain change intent, not enumerate files",
		"- Do NOT invent functionality not present in the diff",
	].join("\n");
}

function buildUserPrompt(context: CommitMessageContext): string {
	const {
		role,
		files,
		phase,
		phaseName,
		docName,
		cycle,
		reviewFeedback,
		diff,
	} = context;
	const parts: string[] = ["Context for this commit:"];

	switch (role) {
		case "planDrafter":
			parts.push(
				`- Stage: implementation plan for phase ${phase ?? "?"}${phaseName ? ` (${phaseName})` : ""}`,
			);
			break;
		case "implementer":
			parts.push(
				`- Stage: implementation of phase ${phase ?? "?"}${phaseName ? ` (${phaseName})` : ""}`,
			);
			break;
		case "addressReview":
			parts.push(
				`- Stage: addressing review feedback${cycle ? ` (cycle ${cycle})` : ""}`,
			);
			if (reviewFeedback) {
				const snippet = reviewFeedback.slice(0, 400);
				parts.push(
					`- Review feedback excerpt: ${snippet}${reviewFeedback.length > 400 ? "..." : ""}`,
				);
			}
			break;
		case "codeReviewer":
			parts.push("- Stage: applying code-review fixes");
			break;
		default:
			// agentCommitMessageWriter / commitMessageWriter and any future roles
			// reach here; the diff + files list provides enough context.
			parts.push(`- Stage: ${role}`);
			break;
	}

	if (docName) parts.push(`- Document: ${docName}`);

	parts.push("", "Files staged:");
	if (files.length === 0) {
		parts.push("- (no files)");
	} else {
		const shown = files.slice(0, 15);
		for (const f of shown) parts.push(`- ${f}`);
		if (files.length > 15) parts.push(`- ... and ${files.length - 15} more`);
	}

	if (diff) {
		parts.push("", "Staged diff:", "```diff", truncateDiff(diff), "```");
	}

	parts.push("");
	if (docName) {
		parts.push(`Scope MUST be: ${docName}`);
	} else if (phaseName && phaseName.length <= MAX_PHASE_NAME_IN_SCOPE) {
		parts.push(
			`Suggested scope: a short component name from the diff (e.g. 'auth', 'jobs', 'billing'). If nothing better fits, use 'phase-${phase}'.`,
		);
	} else {
		parts.push(
			"Suggested scope: a short component name (1–2 words, lowercase) derived from what the diff actually changes — e.g. 'auth', 'jobs', 'billing', 'files'. Avoid invented or overly specific scopes.",
		);
	}
	parts.push("Output the commit message and nothing else.");

	return parts.join("\n");
}

// ============================================
// Pi subprocess invocation
// ============================================

/**
 * How long we wait for the commit-message subprocess. The job is small (a few
 * hundred tokens of output, no tools), but custom providers like claude-native
 * spawn their own subprocess and can have cold-start overhead, so 30s gives
 * plenty of headroom before we fall back to a template.
 */
const SUBPROCESS_TIMEOUT_MS = 30_000;

interface PiResult {
	exitCode: number;
	output: string;
	error: string;
	timedOut: boolean;
}

function spawnPiCommitJob(
	model: string,
	thinking: string,
	systemPrompt: string,
	userPrompt: string,
	cwd: string,
): Promise<PiResult> {
	return new Promise((resolve) => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "spec-pipeline-commit-"),
		);
		const promptPath = path.join(tmpDir, "system.md");
		fs.writeFileSync(promptPath, systemPrompt, {
			encoding: "utf-8",
			mode: 0o600,
		});

		const args: string[] = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-tools",
		];
		if (model !== "$default") {
			args.push("--model", model, "--thinking", thinking);
		}
		args.push("--append-system-prompt", promptPath, userPrompt);

		let output = "";
		let error = "";
		let timedOut = false;

		const proc = spawn("pi", args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timeout = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 2000);
		}, SUBPROCESS_TIMEOUT_MS);

		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				if (
					event.type === "message_update" &&
					event.assistantMessageEvent?.type === "text_delta" &&
					typeof event.assistantMessageEvent.delta === "string"
				) {
					output += event.assistantMessageEvent.delta;
				}
			} catch {
				// Non-JSON line; ignore. pi sometimes emits banner lines.
			}
		};

		proc.stdout?.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data) => {
			error += data.toString();
		});
		proc.on("close", (code) => {
			clearTimeout(timeout);
			if (buffer.trim()) processLine(buffer);
			try {
				fs.unlinkSync(promptPath);
				fs.rmdirSync(tmpDir);
			} catch {
				/* ignore */
			}
			resolve({ exitCode: code ?? 1, output, error, timedOut });
		});
		proc.on("error", (err) => {
			clearTimeout(timeout);
			error += `\n${err.message}`;
			try {
				fs.unlinkSync(promptPath);
				fs.rmdirSync(tmpDir);
			} catch {
				/* ignore */
			}
			resolve({ exitCode: 1, output, error, timedOut });
		});
	});
}

// ============================================
// Output sanitization & validation
// ============================================

const CONVENTIONAL_HEADER =
	/^(feat|fix|docs|refactor|test|chore)\([^)]+\):\s+\S/;
const CONVENTIONAL_HEADER_NO_SCOPE =
	/^(feat|fix|docs|refactor|test|chore):\s+\S/;

/**
 * Strip framing the model sometimes adds: leading "Here is..." preambles,
 * outer fenced code blocks, or stray "Output:" prefixes.
 */
function sanitizeMessage(raw: string): string {
	let message = raw.trim();

	// Drop a single outer code fence if the entire message is wrapped in one.
	const fence = message.match(/^```(?:[\w-]+)?\n([\s\S]*?)\n```\s*$/);
	if (fence) message = fence[1].trim();

	// Drop common preamble lines that some models emit before the message.
	const preamblePatterns = [
		/^here(?:'s| is) (?:the |a )?commit message[:.]\s*/i,
		/^commit message:\s*/i,
		/^output:\s*/i,
	];
	for (const re of preamblePatterns) message = message.replace(re, "").trim();

	return message;
}

function isValidConventionalMessage(message: string): boolean {
	const firstLine = message.split("\n")[0];
	if (!firstLine) return false;
	if (firstLine.length > 120) return false; // sanity cap
	return (
		CONVENTIONAL_HEADER.test(firstLine) ||
		CONVENTIONAL_HEADER_NO_SCOPE.test(firstLine)
	);
}

// ============================================
// Public API
// ============================================

/**
 * Generate a commit message by shelling out to `pi -p --no-tools`. The
 * subprocess inherits the pi runtime, so custom-provider models registered
 * by sibling extensions (e.g. `claude-native/haiku`) resolve correctly.
 *
 * Falls back to a deterministic template if the subprocess fails, times out,
 * or returns something that doesn't look like a conventional commit.
 */
export async function generateCommitMessage(
	context: CommitMessageContext,
	agentConfig?: ModelConfig,
	cwd?: string,
): Promise<CommitMessageResult> {
	try {
		const model = agentConfig?.model ?? context.modelConfig.model;
		const thinking =
			agentConfig?.thinking ?? context.modelConfig.thinking ?? "off";
		const systemPrompt = buildSystemPrompt();
		const userPrompt = buildUserPrompt(context);

		const result = await spawnPiCommitJob(
			model,
			thinking,
			systemPrompt,
			userPrompt,
			cwd ?? process.cwd(),
		);

		if (process.env.DEBUG_COMMIT_MESSAGES) {
			console.error(
				"[commit-agent] pi exit=%d timedOut=%s raw=%s err=%s",
				result.exitCode,
				result.timedOut,
				JSON.stringify(result.output.slice(0, 500)),
				result.error ? result.error.slice(0, 300) : "",
			);
		}

		if (result.timedOut || result.exitCode !== 0 || !result.output.trim()) {
			return { type: "fallback", message: generateFallbackMessage(context) };
		}

		const sanitized = sanitizeMessage(result.output);
		if (!isValidConventionalMessage(sanitized)) {
			return { type: "fallback", message: generateFallbackMessage(context) };
		}
		return { type: "success", message: sanitized };
	} catch (error) {
		if (process.env.DEBUG_COMMIT_MESSAGES) {
			console.error("[commit-agent] threw:", error);
		}
		return { type: "fallback", message: generateFallbackMessage(context) };
	}
}
