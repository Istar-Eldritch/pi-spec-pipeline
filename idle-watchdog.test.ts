import { describe, it, expect } from "vitest";
import { IdleWatchdog, type IdleWatchdogFireInfo } from "./agents.ts";

/**
 * Minimal fake timer implementation for deterministic watchdog tests.
 *
 * The watchdog stores its handle via the injected `setTimeout` and clears it
 * via the injected `clearTimeout`. We emulate Node's timer API with a numeric
 * handle and an explicit `tick(ms)` driver so tests never wait in real time.
 */
function makeFakeTimers() {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { fire: () => void; at: number }>();

	const setTimeoutFn = ((fn: () => void, ms?: number) => {
		const id = nextId++;
		timers.set(id, { fire: fn, at: now + (ms ?? 0) });
		return id as unknown as NodeJS.Timeout;
	}) as typeof setTimeout;

	const clearTimeoutFn = ((handle: NodeJS.Timeout) => {
		timers.delete(handle as unknown as number);
	}) as typeof clearTimeout;

	const tick = (ms: number) => {
		const target = now + ms;
		// Fire due timers in deadline order until none remain due.
		for (;;) {
			let earliestId: number | undefined;
			let earliestAt = Infinity;
			for (const [id, t] of timers) {
				if (t.at <= target && t.at < earliestAt) {
					earliestAt = t.at;
					earliestId = id;
				}
			}
			if (earliestId === undefined) break;
			const t = timers.get(earliestId)!;
			timers.delete(earliestId);
			now = t.at;
			t.fire();
		}
		now = target;
	};

	return {
		setTimeoutFn,
		clearTimeoutFn,
		tick,
		pending: () => timers.size,
	};
}

interface Harness {
	watchdog: IdleWatchdog;
	fired: IdleWatchdogFireInfo[];
	timers: ReturnType<typeof makeFakeTimers>;
}

function makeHarness(
	streamMs: number,
	toolMs: number,
): Harness {
	const fired: IdleWatchdogFireInfo[] = [];
	const timers = makeFakeTimers();
	const watchdog = new IdleWatchdog({
		streamIdleTimeoutMs: streamMs,
		toolStreamIdleTimeoutMs: toolMs,
		onFire: (info) => fired.push(info),
		setTimeoutFn: timers.setTimeoutFn,
		clearTimeoutFn: timers.clearTimeoutFn,
	});
	return { watchdog, fired, timers };
}

describe("IdleWatchdog — budget selection", () => {
	it("uses the model-stream budget when no tool is running", () => {
		const { watchdog } = makeHarness(90_000, 0);
		expect(watchdog.budget()).toBe(90_000);
		expect(watchdog.toolRunning()).toBe(false);
	});

	it("uses the tool-execution budget while a tool is running", () => {
		const { watchdog } = makeHarness(90_000, 1_200_000);
		watchdog.onEventData({ type: "tool_execution_start" });
		expect(watchdog.toolRunning()).toBe(true);
		expect(watchdog.budget()).toBe(1_200_000);
	});

	it("restores the model-stream budget after a tool finishes", () => {
		const { watchdog } = makeHarness(90_000, 1_200_000);
		watchdog.onEventData({ type: "tool_execution_start" });
		watchdog.onEventData({ type: "tool_execution_end" });
		expect(watchdog.toolRunning()).toBe(false);
		expect(watchdog.budget()).toBe(90_000);
	});

	it("tracks parallel tool calls (two starts, then ends)", () => {
		const { watchdog } = makeHarness(90_000, 1_200_000);
		watchdog.onEventData({ type: "tool_execution_start" });
		watchdog.onEventData({ type: "tool_execution_start" });
		expect(watchdog.toolRunning()).toBe(true);
		// One end → still a tool in flight.
		watchdog.onEventData({ type: "tool_execution_end" });
		expect(watchdog.toolRunning()).toBe(true);
		// Second end → back to model-stream.
		watchdog.onEventData({ type: "tool_execution_end" });
		expect(watchdog.toolRunning()).toBe(false);
		expect(watchdog.budget()).toBe(90_000);
	});

	it("never goes negative on unmatched tool_execution_end", () => {
		const { watchdog } = makeHarness(90_000, 1_200_000);
		// End with no prior start — counter clamps at 0.
		watchdog.onEventData({ type: "tool_execution_end" });
		expect(watchdog.toolRunning()).toBe(false);
		expect(watchdog.budget()).toBe(90_000);
	});

	it("ignores null/undefined and unrelated events", () => {
		const { watchdog } = makeHarness(90_000, 1_200_000);
		watchdog.onEventData(null);
		watchdog.onEventData(undefined);
		watchdog.onEventData({ type: "message_update" });
		watchdog.onEventData({ type: "turn_end" });
		expect(watchdog.toolRunning()).toBe(false);
		expect(watchdog.budget()).toBe(90_000);
	});
});

describe("IdleWatchdog — firing", () => {
	it("fires the model-stream budget after a silent gap with no tool running", () => {
		const { watchdog, fired, timers } = makeHarness(50, 0);
		watchdog.arm();
		expect(timers.pending()).toBe(1);

		// Idle for the model-stream budget → fires.
		timers.tick(49);
		expect(fired).toEqual([]);
		timers.tick(1);
		expect(fired).toEqual([{ label: "model-stream", budgetMs: 50 }]);
	});

	// Core regression: pi emits no heartbeat during long tool execution, so the
	// watchdog MUST NOT fire (it would murder a healthy `cargo test` run).
	// With toolStreamIdleTimeoutMs = 0 (default), tool-execution silence is
	// unbounded — the tool's own timeout governs.
	it("does NOT fire during tool execution when toolStreamIdleTimeoutMs is 0 (default)", () => {
		const { watchdog, fired, timers } = makeHarness(50, 0);
		watchdog.arm();
		// A tool starts. processLine calls onEventData then re-arms.
		watchdog.onEventData({ type: "tool_execution_start" });
		watchdog.arm();
		expect(watchdog.toolRunning()).toBe(true);
		// Advance far beyond the model-stream budget — nothing should fire.
		timers.tick(1_000_000);
		expect(fired).toEqual([]);
		expect(timers.pending()).toBe(0); // no timer scheduled (budget 0)
		// Tool finishes → budget reverts to model-stream, arm schedules it.
		watchdog.onEventData({ type: "tool_execution_end" });
		watchdog.arm();
		expect(timers.pending()).toBe(1);
	});

	it("fires the tool-execution budget when toolStreamIdleTimeoutMs > 0", () => {
		const { watchdog, fired, timers } = makeHarness(50, 1_200_000);
		watchdog.arm();
		// Tool starts — arm now schedules the tool budget.
		watchdog.onEventData({ type: "tool_execution_start" });
		watchdog.arm();
		expect(timers.pending()).toBe(1);

		// Just under the tool budget → no fire.
		timers.tick(1_199_999);
		expect(fired).toEqual([]);
		// Cross the tool budget → fires with the tool-execution label.
		timers.tick(1);
		expect(fired).toEqual([{ label: "tool-execution", budgetMs: 1_200_000 }]);
	});

	it("re-arming after tool_execution_end restores the (shorter) model-stream budget", () => {
		const { watchdog, fired, timers } = makeHarness(50, 1_000_000);
		watchdog.arm();
		watchdog.onEventData({ type: "tool_execution_start" });
		watchdog.arm();
		// Long idle during the tool — but tool finishes before the tool budget.
		timers.tick(10_000);
		expect(fired).toEqual([]);
		watchdog.onEventData({ type: "tool_execution_end" });
		watchdog.arm();
		// Now the model-stream budget (50) governs; the old 1_000_000 timer was
		// cleared on re-arm.
		timers.tick(49);
		expect(fired).toEqual([]);
		timers.tick(1);
		expect(fired).toEqual([{ label: "model-stream", budgetMs: 50 }]);
	});

	it("disarm cancels a pending timer", () => {
		const { watchdog, fired, timers } = makeHarness(50, 0);
		watchdog.arm();
		expect(timers.pending()).toBe(1);
		watchdog.disarm();
		expect(timers.pending()).toBe(0);
		timers.tick(1_000_000);
		expect(fired).toEqual([]);
	});

	it("arm is a no-op when the active budget is 0 (disabled)", () => {
		// Both disabled.
		const { watchdog, fired, timers } = makeHarness(0, 0);
		watchdog.arm();
		expect(timers.pending()).toBe(0);
		timers.tick(1_000_000);
		expect(fired).toEqual([]);
	});

	it("disabling only the tool budget still allows the model-stream budget to fire", () => {
		// stream enabled, tool disabled — the realistic default.
		const { watchdog, fired, timers } = makeHarness(50, 0);
		watchdog.arm();
		timers.tick(50);
		expect(fired).toEqual([{ label: "model-stream", budgetMs: 50 }]);
	});
});
