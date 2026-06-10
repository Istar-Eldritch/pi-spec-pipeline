import { describe, it, expect } from "vitest";
import type {
	AgentOutputEvent,
	ToolEventData,
	TextEventData,
} from "./types.ts";
import { createProgressCallback } from "./agents.ts";

describe("AgentOutputEvent type narrowing", () => {
	it("should correctly identify tool events", () => {
		const toolEvent: AgentOutputEvent = {
			type: "tool",
			name: "read",
			arguments: { path: "test.ts" },
		};

		if (
			typeof toolEvent !== "string" &&
			"type" in toolEvent &&
			toolEvent.type === "tool"
		) {
			expect(toolEvent.name).toBe("read");
			expect(toolEvent.arguments.path).toBe("test.ts");
		} else {
			throw new Error("Type narrowing failed for tool event");
		}
	});

	it("should correctly identify text string events", () => {
		const textEvent: AgentOutputEvent = "some text";

		if (typeof textEvent === "string") {
			expect(textEvent).toBe("some text");
		} else {
			throw new Error("Type narrowing failed for text string");
		}
	});

	it("should correctly identify text delta events", () => {
		const textEvent: AgentOutputEvent = {
			type: "text",
			delta: "delta text",
		};

		if (
			typeof textEvent !== "string" &&
			"type" in textEvent &&
			textEvent.type === "text"
		) {
			expect(textEvent.delta).toBe("delta text");
		} else {
			throw new Error("Type narrowing failed for text delta event");
		}
	});
});

describe("ToolEventData structure", () => {
	it("should accept valid tool event with string arguments", () => {
		const toolEvent: ToolEventData = {
			type: "tool",
			name: "read",
			arguments: { path: "src/test.ts" },
		};

		expect(toolEvent.type).toBe("tool");
		expect(toolEvent.name).toBe("read");
		expect(toolEvent.arguments).toEqual({ path: "src/test.ts" });
	});

	it("should accept valid tool event with complex arguments", () => {
		const toolEvent: ToolEventData = {
			type: "tool",
			name: "edit",
			arguments: {
				path: "src/test.ts",
				oldText: "const x = 1;",
				newText: "const x = 2;",
			},
		};

		expect(toolEvent.type).toBe("tool");
		expect(toolEvent.name).toBe("edit");
		expect(toolEvent.arguments).toHaveProperty("path");
		expect(toolEvent.arguments).toHaveProperty("oldText");
		expect(toolEvent.arguments).toHaveProperty("newText");
	});

	it("should accept valid tool event with array arguments", () => {
		const toolEvent: ToolEventData = {
			type: "tool",
			name: "bash",
			arguments: {
				command: "npm test",
				timeout: 300,
			},
		};

		expect(toolEvent.type).toBe("tool");
		expect(toolEvent.name).toBe("bash");
		expect(toolEvent.arguments.command).toBe("npm test");
		expect(toolEvent.arguments.timeout).toBe(300);
	});
});

describe("TextEventData structure", () => {
	it("should accept valid text delta event", () => {
		const textEvent: TextEventData = {
			type: "text",
			delta: "some text content",
		};

		expect(textEvent.type).toBe("text");
		expect(textEvent.delta).toBe("some text content");
	});

	it("should accept empty delta", () => {
		const textEvent: TextEventData = {
			type: "text",
			delta: "",
		};

		expect(textEvent.type).toBe("text");
		expect(textEvent.delta).toBe("");
	});
});

describe("AgentOutputEvent union type", () => {
	it("should accept string (backward compatibility)", () => {
		const event: AgentOutputEvent = "legacy text";
		expect(typeof event).toBe("string");
	});

	it("should accept ToolEventData", () => {
		const event: AgentOutputEvent = {
			type: "tool",
			name: "write",
			arguments: { path: "test.ts", content: "code" },
		};
		expect(typeof event).toBe("object");
		if (typeof event !== "string") {
			expect(event.type).toBe("tool");
		}
	});

	it("should accept TextEventData", () => {
		const event: AgentOutputEvent = {
			type: "text",
			delta: "text content",
		};
		expect(typeof event).toBe("object");
		if (typeof event !== "string") {
			expect(event.type).toBe("text");
		}
	});
});

describe("Event type guards", () => {
	it("should distinguish between string and object events", () => {
		const events: AgentOutputEvent[] = [
			"string event",
			{ type: "tool", name: "read", arguments: { path: "test.ts" } },
			{ type: "text", delta: "text delta" },
		];

		const strings = events.filter((e) => typeof e === "string");
		const objects = events.filter((e) => typeof e !== "string");

		expect(strings.length).toBe(1);
		expect(objects.length).toBe(2);
	});

	it("should distinguish between tool and text events", () => {
		const events: AgentOutputEvent[] = [
			{ type: "tool", name: "read", arguments: { path: "test.ts" } },
			{ type: "text", delta: "text delta" },
			"string event",
		];

		const toolEvents = events.filter(
			(e): e is ToolEventData =>
				typeof e !== "string" && "type" in e && e.type === "tool",
		);
		const textEvents = events.filter(
			(e): e is TextEventData =>
				typeof e !== "string" && "type" in e && e.type === "text",
		);
		const stringEvents = events.filter(
			(e): e is string => typeof e === "string",
		);

		expect(toolEvents.length).toBe(1);
		expect(textEvents.length).toBe(1);
		expect(stringEvents.length).toBe(1);

		// Verify type narrowing works
		if (toolEvents[0]) {
			expect(toolEvents[0].name).toBe("read");
		}
		if (textEvents[0]) {
			expect(textEvents[0].delta).toBe("text delta");
		}
	});
});

describe("createProgressCallback", () => {
	it("formats read tool events correctly", () => {
		const notifications: string[] = [];
		const widgets: Array<{ id: string; content: string[] | undefined }> = [];

		const ctx: any = {
			ui: {
				notify: (msg: string, type: string) => notifications.push(msg),
				setWidget: (id: string, content: string[] | undefined) =>
					widgets.push({ id, content }),
			},
		};

		const state: any = {
			id: "test_impl",
			phases: ["Phase 1", "Phase 2"],
			currentPhaseIndex: 0,
			stage: "implementation",
		};

		const callback = createProgressCallback(ctx, state, "Phase 1/2", true);

		// Invoke with read tool event
		callback({
			type: "tool",
			name: "read",
			arguments: { path: "./src/auth.ts" },
		});

		// Verify notification was sent
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toBe("📖 Reading src/auth.ts [Phase 1/2]");

		// Verify widget was updated
		expect(widgets).toHaveLength(1);
		expect(widgets[0].content).toBeDefined();
		expect(widgets[0].content?.join("\n")).toContain("📖 Reading src/auth.ts");
	});

	it("formats write tool events correctly", () => {
		const notifications: string[] = [];
		const ctx: any = {
			ui: {
				notify: (msg: string) => notifications.push(msg),
				setWidget: () => {},
			},
		};
		const state: any = {
			id: "test",
			phases: [],
			currentPhaseIndex: 0,
			stage: "implementation",
		};

		const callback = createProgressCallback(ctx, state, "Phase 2", true);
		callback({
			type: "tool",
			name: "write",
			arguments: { path: "src/new-file.ts" },
		});

		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("✍️ Creating src/new-file.ts");
		expect(notifications[0]).toContain("[Phase 2]");
	});

	it("formats edit tool events correctly", () => {
		const notifications: string[] = [];
		const ctx: any = {
			ui: {
				notify: (msg: string) => notifications.push(msg),
				setWidget: () => {},
			},
		};
		const state: any = {
			id: "test",
			phases: [],
			currentPhaseIndex: 0,
			stage: "implementation",
		};

		const callback = createProgressCallback(ctx, state, "Review Cycle 1", true);
		callback({
			type: "tool",
			name: "edit",
			arguments: { path: "./lib/utils.ts" },
		});

		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toBe("✏️ Editing lib/utils.ts [Review Cycle 1]");
	});

	it("truncates long bash commands", () => {
		const notifications: string[] = [];
		const ctx: any = {
			ui: {
				notify: (msg: string) => notifications.push(msg),
				setWidget: () => {},
			},
		};
		const state: any = {
			id: "test",
			phases: [],
			currentPhaseIndex: 0,
			stage: "implementation",
		};

		const callback = createProgressCallback(ctx, state, "Phase 3", true);
		const longCommand =
			"npm test -- --watch --coverage --reporters=verbose --maxWorkers=4 --bail";

		callback({
			type: "tool",
			name: "bash",
			arguments: { command: longCommand },
		});

		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("⚙️ Running:");
		expect(notifications[0]).toContain("...");
		expect(notifications[0].length).toBeLessThan(120); // Truncated message
	});

	it("handles grep tool events", () => {
		const notifications: string[] = [];
		const ctx: any = {
			ui: {
				notify: (msg: string) => notifications.push(msg),
				setWidget: () => {},
			},
		};
		const state: any = {
			id: "test",
			phases: [],
			currentPhaseIndex: 0,
			stage: "implementation",
		};

		const callback = createProgressCallback(ctx, state, "Phase 1", true);
		callback({
			type: "tool",
			name: "grep",
			arguments: { pattern: "interface.*User", path: "src/" },
		});

		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("🔍 Searching interface.*User in src/");
	});

	it("handles find tool events", () => {
		const notifications: string[] = [];
		const ctx: any = {
			ui: {
				notify: (msg: string) => notifications.push(msg),
				setWidget: () => {},
			},
		};
		const state: any = {
			id: "test",
			phases: [],
			currentPhaseIndex: 0,
			stage: "implementation",
		};

		const callback = createProgressCallback(ctx, state, "Phase 2", true);
		callback({
			type: "tool",
			name: "find",
			arguments: { pattern: "*.test.ts" },
		});

		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toBe("🔎 Finding *.test.ts [Phase 2]");
	});

	it("ignores text delta events (backward compatibility)", () => {
		const notifications: string[] = [];
		const ctx: any = {
			ui: {
				notify: (msg: string) => notifications.push(msg),
				setWidget: () => {},
			},
		};
		const state: any = {
			id: "test",
			phases: [],
			currentPhaseIndex: 0,
			stage: "implementation",
		};

		const callback = createProgressCallback(ctx, state, "Phase 1", true);

		// Legacy string event
		callback("some text output");
		expect(notifications).toHaveLength(0);

		// Structured text event
		callback({ type: "text", delta: "more output" });
		expect(notifications).toHaveLength(0);
	});

	it("handles unknown tool types with default emoji", () => {
		const notifications: string[] = [];
		const ctx: any = {
			ui: {
				notify: (msg: string) => notifications.push(msg),
				setWidget: () => {},
			},
		};
		const state: any = {
			id: "test",
			phases: [],
			currentPhaseIndex: 0,
			stage: "implementation",
		};

		const callback = createProgressCallback(ctx, state, "Phase 1", true);
		callback({
			type: "tool",
			name: "unknown_tool",
			arguments: { some: "arg" },
		});

		// Unknown tools without specific formatting should not generate notifications
		expect(notifications).toHaveLength(0);
	});

	it("strips leading ./ from paths", () => {
		const notifications: string[] = [];
		const ctx: any = {
			ui: {
				notify: (msg: string) => notifications.push(msg),
				setWidget: () => {},
			},
		};
		const state: any = {
			id: "test",
			phases: [],
			currentPhaseIndex: 0,
			stage: "implementation",
		};

		const callback = createProgressCallback(ctx, state, "Phase 1", true);
		callback({
			type: "tool",
			name: "read",
			arguments: { path: "./src/nested/file.ts" },
		});

		expect(notifications[0]).toBe("📖 Reading src/nested/file.ts [Phase 1]");
		expect(notifications[0]).not.toContain("./src");
	});
});
