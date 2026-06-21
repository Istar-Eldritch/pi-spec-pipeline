/**
 * Agent execution for the spec pipeline
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
	ModelConfig,
	AgentResult,
	AgentCallUsage,
	AgentOutputEvent,
	ToolEventData,
	PipelineUIContext,
	ImplementationState,
} from "./types.ts";
import { READ_ONLY_ROLES, WRITE_ROLES } from "./types.ts";
import { updateImplWidget } from "./formatting.ts";
import { resolveProjectRoot } from "./worktree.ts";

// ============================================
// Progress Display Constants
// ============================================

/**
 * Emoji mapping for tool operations (R6)
 * Used by progress callbacks to format user-friendly notifications
 */
const TOOL_EMOJI: Record<string, string> = {
	read: "📖",
	write: "✍️",
	edit: "✏️",
	bash: "⚙️",
	grep: "🔍",
	find: "🔎",
};

/**
 * Default emoji for unknown tool types
 */
const DEFAULT_TOOL_EMOJI = "🔧";

// ============================================
// Progress Callback Factory
// ============================================

/**
 * Create a progress callback for agent execution (R5-R21)
 *
 * The callback formats tool invocations into user-friendly messages and
 * updates the pipeline widget in real-time. Also prints to terminal for permanent history.
 *
 * @param ctx - UI context with notify and setWidget functions
 * @param state - Current implementation or spec state (for widget updates)
 * @param phaseInfo - Human-readable phase context (e.g., "Phase 2/3", "Review Cycle 1")
 * @param isImplPipeline - True for implementation widget, false for spec widget
 * @returns Callback function that handles AgentOutputEvent
 *
 * @example
 * ```typescript
 * const callback = createProgressCallback(
 *   ctx,
 *   state,
 *   "Phase 2/3",
 *   true
 * );
 * await runAgentWithConfig(
 *   config, task, cwd, systemPrompt,
 *   undefined, callback, "implementer"
 * );
 * ```
 */
export function createProgressCallback(
	ctx: PipelineUIContext,
	state: ImplementationState,
	phaseInfo: string,
	_isImplPipeline: boolean = true,
): (event: AgentOutputEvent) => void {
	return (event: AgentOutputEvent) => {
		// Handle legacy text deltas (ignore for progress display)
		if (typeof event === "string") {
			return;
		}

		// Handle structured text events (ignore for progress display)
		if (event.type === "text") {
			return;
		}

		// Handle tool invocation events (R2, R3, R4)
		if (event.type === "tool") {
			const emoji = TOOL_EMOJI[event.name] || DEFAULT_TOOL_EMOJI;
			let message = "";

			// Format message based on tool type (R7)
			if (event.name === "read" && event.arguments?.path) {
				// Read: show file path (R7)
				const path = formatPath(event.arguments.path);
				message = `${emoji} Reading ${path}`;
			} else if (event.name === "write" && event.arguments?.path) {
				// Write: show file path (R7)
				const path = formatPath(event.arguments.path);
				message = `${emoji} Creating ${path}`;
			} else if (event.name === "edit" && event.arguments?.path) {
				// Edit: show file path (R7)
				const path = formatPath(event.arguments.path);
				message = `${emoji} Editing ${path}`;
			} else if (event.name === "bash" && event.arguments?.command) {
				// Bash: show truncated command (R7, R9)
				const cmd = event.arguments.command;
				const truncated = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
				message = `${emoji} Running: ${truncated}`;
			} else if (event.name === "grep" && event.arguments?.pattern) {
				// Grep: show pattern and optional path (R7)
				const pattern = event.arguments.pattern;
				const pathPart = event.arguments.path
					? ` in ${formatPath(event.arguments.path)}`
					: "";
				message = `${emoji} Searching ${pattern}${pathPart}`;
			} else if (event.name === "find" && event.arguments?.pattern) {
				// Find: show pattern (R7)
				const pattern = event.arguments.pattern;
				message = `${emoji} Finding ${pattern}`;
			}

			// If we successfully formatted a message, update the widget and print to history
			if (message) {
				// Add phase context (R21)
				const contextualMessage = `${message} [${phaseInfo}]`;

				// Update widget with current action (R13, R14, R15)
				updateImplWidget(ctx, state, contextualMessage);

				// Notify UI and print to terminal for permanent history
				ctx.ui.notify(contextualMessage, "info");
				console.log(`  ${contextualMessage}`);
			}
		}
	};
}

/**
 * Format file path for display (R8)
 * Strips leading ./ and returns relative path
 */
function formatPath(path: string): string {
	if (path.startsWith("./")) {
		return path.slice(2);
	}
	return path;
}

/**
 * Cache observability: hash the bytes that contribute to the prompt prefix
 * (system prompt, model config, role) per (cwd, role) so we can detect when a
 * "stable" prefix actually changed across calls. Pairs with the post-call
 * `cacheRead`/`cacheWrite` totals already captured in `AgentCallUsage`.
 *
 * LRU-bounded so a long-running pi process doesn't accumulate state.
 */
const CACHE_TRACK_MAX_ENTRIES = 32;
interface CacheTrackEntry {
	systemHash: string;
	modelHash: string;
	systemSample: string;
}
const cacheTrack = new Map<string, CacheTrackEntry>();

function hashString(s: string): string {
	return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function recordPromptHash(
	cwd: string,
	role: string | undefined,
	systemPrompt: string,
	modelConfig: ModelConfig,
	roleArgs: string,
): {
	systemChanged: boolean;
	modelChanged: boolean;
	previousSystemHash?: string;
} {
	const key = `${cwd}::${role ?? "unknown"}`;
	const systemHash = hashString(systemPrompt);
	const modelHash = hashString(
		`${modelConfig.model}|${modelConfig.thinking}|${roleArgs}`,
	);
	const prev = cacheTrack.get(key);
	const result = {
		systemChanged: !!prev && prev.systemHash !== systemHash,
		modelChanged: !!prev && prev.modelHash !== modelHash,
		previousSystemHash: prev?.systemHash,
	};
	// LRU touch
	if (prev) cacheTrack.delete(key);
	cacheTrack.set(key, {
		systemHash,
		modelHash,
		systemSample: systemPrompt.slice(0, 4000),
	});
	while (cacheTrack.size > CACHE_TRACK_MAX_ENTRIES) {
		const first = cacheTrack.keys().next().value;
		if (first === undefined) break;
		cacheTrack.delete(first);
	}
	return result;
}

function writeCacheDiff(
	cwd: string,
	role: string | undefined,
	currentSystemPrompt: string,
	prevHash: string | undefined,
	currentHash: string,
): void {
	if (!prevHash) return;
	try {
		// Write diff samples under the main repo (not the worktree) so they
		// survive worktree cleanup. The in-memory cache map is still keyed by the
		// raw cwd (workRoot) — per-run isolation is acceptable here.
		const dir = path.join(
			resolveProjectRoot(cwd),
			".pi",
			"spec-pipeline",
			"cache-diffs",
		);
		fs.mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const file = path.join(
			dir,
			`${stamp}_${role ?? "unknown"}_${prevHash}_to_${currentHash}.txt`,
		);
		fs.writeFileSync(file, currentSystemPrompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	} catch {
		// Diagnostic only — never let this kill the run.
	}
}

// ============================================
// Streaming Idle-Timeout Watchdog
// ============================================

/**
 * Idle budget (ms) for one of the two silence kinds a pi subprocess can show.
 */
export interface IdleWatchdogBudgets {
	/** Budget for gaps while NO tool is executing (model-stream silence). 0 disables. */
	streamIdleTimeoutMs: number;
	/** Budget for gaps while a tool is executing (tool-execution silence). 0 disables. */
	toolStreamIdleTimeoutMs: number;
}

/**
 * Which budget elapsed when the watchdog fires.
 */
export type IdleWatchdogLabel = "model-stream" | "tool-execution";

/**
 * Information passed to `onFire` when the watchdog elapses.
 */
export interface IdleWatchdogFireInfo {
	/** Which budget fired. */
	label: IdleWatchdogLabel;
	/** The budget that elapsed, in ms. */
	budgetMs: number;
}

/**
 * Options for constructing an {@link IdleWatchdog}.
 */
export interface IdleWatchdogOptions extends IdleWatchdogBudgets {
	/** Called when the watchdog fires (budget elapsed with no events). */
	onFire: (info: IdleWatchdogFireInfo) => void;
	/** Injectable `setTimeout` for unit testing. Defaults to the global. */
	setTimeoutFn?: typeof setTimeout;
	/** Injectable `clearTimeout` for unit testing. Defaults to the global. */
	clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Idle-timeout watchdog for a pi subprocess.
 *
 * pi emits events on stdout/stderr as it runs. Two distinct kinds of silence
 * can occur, and they have very different meanings:
 *
 * 1. **Model-stream silence** — a gap between events while NO tool is
 *    executing. This usually means the upstream LLM provider hung
 *    (connection open but no tokens). The `streamIdleTimeoutMs` budget
 *    catches this.
 *
 * 2. **Tool-execution silence** — a gap while a tool (e.g. `bash`) is
 *    running. pi emits `tool_execution_start`, at most one
 *    `tool_execution_update` near the start, and then NOTHING until the
 *    tool finishes — even for a multi-minute `cargo test` run. This is
 *    normal, NOT a hang: the tool has its own timeout (the bash `timeout`
 *    arg, pi's tool timeout). Killing pi here is wrong; it murders healthy
 *    subprocesses running legitimately long commands.
 *
 * The watchdog therefore picks the budget based on whether a tool is in
 * flight. `toolStreamIdleTimeoutMs` defaults to 0 (disabled) so tool runs are
 * bounded only by their own timeouts; set it to a positive value to also
 * bound tool-run silence.
 *
 * The caller is responsible for calling `onEventData(parsedEvent)` for every
 * parsed pi JSON event and `arm()` after each batch of events so the new
 * budget takes effect.
 */
export class IdleWatchdog {
	private toolsInFlight = 0;
	private handle: NodeJS.Timeout | undefined;
	private readonly streamMs: number;
	private readonly toolMs: number;
	private readonly onFire: (info: IdleWatchdogFireInfo) => void;
	private readonly st: typeof setTimeout;
	private readonly ct: typeof clearTimeout;

	constructor(opts: IdleWatchdogOptions) {
		this.streamMs = opts.streamIdleTimeoutMs;
		this.toolMs = opts.toolStreamIdleTimeoutMs;
		this.onFire = opts.onFire;
		this.st = opts.setTimeoutFn ?? setTimeout;
		this.ct = opts.clearTimeoutFn ?? clearTimeout;
	}

	/** True when at least one tool is currently executing. */
	toolRunning(): boolean {
		return this.toolsInFlight > 0;
	}

	/**
	 * The current idle budget (ms) based on tool-execution state.
	 * Returns 0 when the active budget is disabled.
	 */
	budget(): number {
		return this.toolsInFlight > 0 ? this.toolMs : this.streamMs;
	}

	/**
	 * (Re)arm the timer with the current budget. No-op if the current budget
	 * is <= 0 (disabled). The label is captured at arm time so the `onFire`
	 * callback always reports which budget actually elapsed, regardless of any
	 * state change between arming and firing (none is possible during a true
	 * idle gap, but capturing it is unambiguous and robust).
	 */
	arm(): void {
		this.disarm();
		const ms = this.budget();
		if (ms <= 0) return;
		const label: IdleWatchdogLabel =
			this.toolsInFlight > 0 ? "tool-execution" : "model-stream";
		this.handle = this.st(() => {
			this.onFire({ label, budgetMs: ms });
		}, ms);
		// Don't keep the Node event loop alive solely for the watchdog.
		(this.handle as { unref?: () => void })?.unref?.();
	}

	/** Clear any pending timer. */
	disarm(): void {
		if (this.handle) {
			this.ct(this.handle);
			this.handle = undefined;
		}
	}

	/**
	 * Track tool-execution lifecycle from a parsed pi JSON event. Non
	 * tool-execution events are ignored. The counter supports parallel tool
	 * calls (multiple `tool_execution_start` before any `end`).
	 */
	onEventData(event: { type?: string } | null | undefined): void {
		if (!event) return;
		if (event.type === "tool_execution_start") {
			this.toolsInFlight++;
		} else if (event.type === "tool_execution_end") {
			this.toolsInFlight = Math.max(0, this.toolsInFlight - 1);
		}
	}
}

/**
 * Run a pi subprocess with explicit model configuration
 * This is the core agent runner that accepts ModelConfig directly.
 */
export async function runAgentWithConfig(
	modelConfig: ModelConfig,
	task: string,
	cwd: string,
	systemPrompt: string,
	signal?: AbortSignal,
	onOutput?: (event: AgentOutputEvent) => void,
	role?: string,
	sessionDir?: string,
): Promise<AgentResult> {
	const useSystemDefault = modelConfig.model === "$default";
	let args: string[];
	if (sessionDir) {
		fs.mkdirSync(sessionDir, { recursive: true });
		args = ["--mode", "json", "-p", "--session-dir", sessionDir];
	} else {
		args = ["--mode", "json", "-p", "--no-session"];
	}
	if (!useSystemDefault) {
		args.push("--model", modelConfig.model, "--thinking", modelConfig.thinking);
	}

	// Restrict tools based on role. The two strings below are intentionally
	// constants — varying the --tools allowlist changes pi's tool-schema prefix
	// and breaks cache between invocations of the same role. Read-only and write
	// roles will never share a cache prefix; that's by design.
	let roleArgs = "";
	if (role && READ_ONLY_ROLES.has(role)) {
		roleArgs = "read,bash,grep,find,ls";
		args.push("--tools", roleArgs);
	} else if (role && WRITE_ROLES.has(role)) {
		roleArgs = "read,bash,edit,write,grep,find,ls";
		args.push("--tools", roleArgs);
	}

	// Cache-break detection (technique #7 phase 1): hash system prompt + model
	// config per (cwd, role) and write a diff sample if the system prompt
	// changed since the last call for the same source. Post-call cacheRead
	// totals (below) plus this pre-call diff are enough to explain regressions.
	const hashCheck = recordPromptHash(
		cwd,
		role,
		systemPrompt,
		modelConfig,
		roleArgs,
	);
	if (hashCheck.systemChanged) {
		const newHash = hashString(systemPrompt);
		writeCacheDiff(
			cwd,
			role,
			systemPrompt,
			hashCheck.previousSystemHash,
			newHash,
		);
	}

	// For models that reject pi's assistant-role system-prompt injection
	// ("Cannot continue from message role: assistant"), inline the system prompt
	// as a prefix in the task string so only a clean [system]->[user] turn is sent.
	const useInlineSystemPrompt = modelConfig.systemPromptMode === "inline";

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-pipeline-"));
	let promptPath: string | null = null;
	if (!useInlineSystemPrompt) {
		promptPath = path.join(tmpDir, "system.md");
		fs.writeFileSync(promptPath, systemPrompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
		args.push("--append-system-prompt", promptPath);
	}

	const effectiveTask = useInlineSystemPrompt
		? `${systemPrompt}\n\n---\n\n${task}`
		: task;
	args.push(effectiveTask);

	let output = "";
	let error = "";
	let proc: ChildProcess | null = null;
	let completed = false;
	let finishReason: string | undefined;
	let stopReason: string | undefined;
	let limitHit = false;

	// Accumulated token usage across all assistant turns. Pi emits one
	// AssistantMessage per turn and each carries a `usage` object — see
	// pi docs/session-format.md and docs/json.md. We sum across the run.
	const usage: AgentCallUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	};
	let usageRecorded = false;
	const seenAssistantUsage = new Set<string>();
	const accumulateAssistantUsage = (msg: any): void => {
		if (!msg || msg.role !== "assistant") return;
		const u = msg.usage;
		if (!u || typeof u !== "object") return;
		// Dedupe across message_end/turn_end/agent_end which may all carry the
		// same assistant message. Pi assigns a stable `id` to each entry.
		const key = typeof msg.id === "string" ? msg.id : `t${msg.timestamp ?? ""}`;
		if (seenAssistantUsage.has(key)) return;
		seenAssistantUsage.add(key);
		usage.input += Number(u.input) || 0;
		usage.output += Number(u.output) || 0;
		usage.cacheRead += Number(u.cacheRead) || 0;
		usage.cacheWrite += Number(u.cacheWrite) || 0;
		usage.totalTokens += Number(u.totalTokens) || 0;
		usageRecorded = true;
	};

	try {
		const exitCode = await new Promise<number>((resolve) => {
			proc = spawn("pi", args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			// Streaming idle-timeout watchdog. Two budgets:
			//  - streamIdleTimeoutMs: gaps while NO tool is running (model-stream
			//    silence — catches a hung LLM provider connection).
			//  - toolStreamIdleTimeoutMs: gaps while a tool IS running. pi emits no
			//    heartbeat during tool execution, so this defaults to 0 (disabled)
			//    and tools are bounded by their own timeouts (bash `timeout`, pi's
			//    tool timeout). See IdleWatchdog above for the full rationale.
			// Resolution order for each: per-role ModelConfig > env var > default.
			// The project-level values (from .pi/spec-pipeline.json
			// `streamIdleTimeoutMs` / `toolStreamIdleTimeoutMs`) are folded into
			// per-role configs by mergeWithDefaults in config.ts.
			const streamIdleTimeoutMs =
				modelConfig.streamIdleTimeoutMs ??
				(Number(process.env.SPEC_PIPELINE_STREAM_IDLE_TIMEOUT_MS) ||
					90_000);
			const toolStreamIdleTimeoutMs =
				modelConfig.toolStreamIdleTimeoutMs ??
				(Number(
					process.env.SPEC_PIPELINE_TOOL_STREAM_IDLE_TIMEOUT_MS,
				) || 0);
			const watchdog = new IdleWatchdog({
				streamIdleTimeoutMs,
				toolStreamIdleTimeoutMs,
				onFire: (info) => {
					error += `\n[spec-pipeline] ${info.label} idle timeout: no events for ${info.budgetMs}ms — killing pi subprocess\n`;
					proc?.kill("SIGTERM");
					setTimeout(() => {
						if (proc && !proc.killed) proc.kill("SIGKILL");
					}, 5000);
				},
			});
			watchdog.arm();

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line);

					// Track tool-execution lifecycle so the idle watchdog applies the
					// correct budget (tool-execution vs model-stream).
					watchdog.onEventData(event);

					// Handle text delta events (for output accumulation and legacy callbacks)
					if (
						event.type === "message_update" &&
						event.assistantMessageEvent?.type === "text_delta"
					) {
						const delta = event.assistantMessageEvent.delta;
						output += delta;

						if (onOutput) {
							onOutput(delta);
						}
					}

					// Handle tool call events (for progress visibility)
					if (
						event.type === "message_update" &&
						event.assistantMessageEvent?.type === "toolcall_end"
					) {
						const toolCall = event.assistantMessageEvent?.toolCall;

						if (toolCall && toolCall.name && toolCall.arguments) {
							const toolEvent: ToolEventData = {
								type: "tool",
								name: toolCall.name,
								arguments: toolCall.arguments,
							};

							if (onOutput) {
								onOutput(toolEvent);
							}
						}
					}

					if (
						event.type === "message_stop" ||
						event.type === "response.completed" ||
						event.type === "completed"
					) {
						completed = true;
					}

					// Token usage from pi's --mode json events. Assistant messages
					// arrive on message_end / turn_end / agent_end; dedupe by id.
					if (event.type === "message_end" || event.type === "turn_end") {
						accumulateAssistantUsage(event.message);
					} else if (
						event.type === "agent_end" &&
						Array.isArray(event.messages)
					) {
						for (const m of event.messages) accumulateAssistantUsage(m);
					}

					const rawFinishReason =
						event.finishReason ??
						event.finish_reason ??
						event.stopReason ??
						event.stop_reason ??
						event.assistantMessageEvent?.finishReason ??
						event.assistantMessageEvent?.finish_reason ??
						event.response?.finishReason ??
						event.response?.finish_reason;
					if (typeof rawFinishReason === "string") {
						finishReason = rawFinishReason;
						stopReason = rawFinishReason;
						const fr = rawFinishReason.toLowerCase();
						if (
							fr === "length" ||
							fr === "max_tokens" ||
							fr === "output_limit"
						) {
							limitHit = true;
						}
					}
				} catch {
					// Ignore parse errors (malformed JSON, incomplete events)
				}
			};

			proc.stdout?.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
				// Re-arm AFTER processing: tool_execution_* events may switch the
				// active budget between model-stream and tool-execution.
				watchdog.arm();
			});

			proc.stderr?.on("data", (data) => {
				error += data.toString();
				watchdog.arm();
			});

			proc.on("close", (code) => {
				watchdog.disarm();
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const killProc = () => {
					proc?.kill("SIGTERM");
					setTimeout(() => {
						if (proc && !proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		// Stderr-only limit detection (safe to scan once at end; agent assistant text is in `output`, not `error`)
		if (!limitHit && error) {
			const lowerErr = error.toLowerCase();
			if (
				lowerErr.includes("max tokens") ||
				lowerErr.includes("maximum tokens") ||
				lowerErr.includes("context length") ||
				lowerErr.includes("context window") ||
				lowerErr.includes("output limit") ||
				lowerErr.includes("model_context_window_exceeded") ||
				lowerErr.includes("token limit")
			) {
				limitHit = true;
			}
		}

		const combinedError = [
			error || "",
			finishReason || "",
			stopReason || "",
			limitHit ? "token/context/output limit hit" : "",
		]
			.filter(Boolean)
			.join("\n");
		const successfulCompletion =
			!limitHit && (completed || (exitCode === 0 && output.trim().length > 0));
		return {
			output: output.trim(),
			exitCode,
			error: combinedError || undefined,
			completed: successfulCompletion,
			finishReason,
			stopReason,
			limitHit,
			usage: usageRecorded ? usage : undefined,
		};
	} finally {
		try {
			if (promptPath) fs.unlinkSync(promptPath);
			fs.rmdirSync(tmpDir);
		} catch {
			/* ignore */
		}
	}
}
