import { describe, it, expect } from "vitest";
import {
	classifyError,
	getErrorEmoji,
	getErrorSuggestion,
	truncateString,
	formatErrorForRetry,
	formatErrorBox,
} from "./errors.ts";
import type { SpecState, ImplementationState, ErrorDetails } from "./types.ts";

describe("classifyError", () => {
	describe("RATE_LIMIT detection", () => {
		it("detects HTTP 429 status code", () => {
			expect(classifyError("Error: Request failed with status 429")).toBe("RATE_LIMIT");
		});

		it("detects 'rate limit' text", () => {
			expect(classifyError("Rate limit exceeded. Please wait.")).toBe("RATE_LIMIT");
		});

		it("detects 'rate_limit' with underscore", () => {
			expect(classifyError("error: rate_limit_exceeded")).toBe("RATE_LIMIT");
		});

		it("detects 'ratelimit' as one word", () => {
			expect(classifyError("RateLimitError: too many requests")).toBe("RATE_LIMIT");
		});

		it("detects 'too many requests'", () => {
			expect(classifyError("Error: Too many requests")).toBe("RATE_LIMIT");
		});
	});

	describe("TIMEOUT detection", () => {
		it("detects 'timeout'", () => {
			expect(classifyError("Error: Connection timeout")).toBe("TIMEOUT");
		});

		it("detects 'timed out'", () => {
			expect(classifyError("Request timed out after 30s")).toBe("TIMEOUT");
		});

		it("detects 'etimedout'", () => {
			expect(classifyError("Error: ETIMEDOUT")).toBe("TIMEOUT");
		});
	});

	describe("NETWORK detection", () => {
		it("detects 'econnrefused'", () => {
			expect(classifyError("Error: connect ECONNREFUSED 127.0.0.1:3000")).toBe("NETWORK");
		});

		it("detects 'enotfound'", () => {
			expect(classifyError("Error: getaddrinfo ENOTFOUND api.example.com")).toBe("NETWORK");
		});

		it("detects 'network' keyword", () => {
			expect(classifyError("Network error occurred")).toBe("NETWORK");
		});

		it("detects 'connection' keyword", () => {
			expect(classifyError("Connection reset by peer")).toBe("NETWORK");
		});

		it("detects 'socket' keyword", () => {
			expect(classifyError("Socket hang up")).toBe("NETWORK");
		});

		it("detects 'dns' keyword", () => {
			expect(classifyError("DNS resolution failed")).toBe("NETWORK");
		});
	});

	describe("VALIDATION detection", () => {
		it("detects 'invalid'", () => {
			expect(classifyError("Invalid API key provided")).toBe("VALIDATION");
		});

		it("detects 'validation'", () => {
			expect(classifyError("Validation error: missing field")).toBe("VALIDATION");
		});

		it("detects 'malformed'", () => {
			expect(classifyError("Malformed JSON in request")).toBe("VALIDATION");
		});

		it("detects 'parse error'", () => {
			expect(classifyError("JSON parse error at line 5")).toBe("VALIDATION");
		});
	});

	describe("TOKEN_LIMIT detection", () => {
		it("detects 'finish_reason: length'", () => {
			expect(classifyError("finish_reason: length")).toBe("TOKEN_LIMIT");
		});

		it("detects 'model_context_window_exceeded'", () => {
			expect(classifyError("model_context_window_exceeded")).toBe("TOKEN_LIMIT");
		});

		it("detects 'max tokens'", () => {
			expect(classifyError("max tokens reached")).toBe("TOKEN_LIMIT");
		});
	});

	describe("INCOMPLETE detection", () => {
		it("detects 'aborted before completion'", () => {
			expect(classifyError("agent aborted before completion")).toBe("INCOMPLETE");
		});

		it("detects 'did not complete'", () => {
			expect(classifyError("did not complete successfully")).toBe("INCOMPLETE");
		});
	});

	describe("UNKNOWN fallback", () => {
		it("returns UNKNOWN for empty stderr", () => {
			expect(classifyError("")).toBe("UNKNOWN");
		});

		it("returns UNKNOWN for undefined", () => {
			expect(classifyError(undefined)).toBe("UNKNOWN");
		});

		it("returns UNKNOWN for unrecognized errors", () => {
			expect(classifyError("Something went wrong")).toBe("UNKNOWN");
		});

		it("returns UNKNOWN for generic error messages", () => {
			expect(classifyError("Error: Operation failed")).toBe("UNKNOWN");
		});
	});

	describe("case insensitivity", () => {
		it("handles uppercase", () => {
			expect(classifyError("RATE LIMIT EXCEEDED")).toBe("RATE_LIMIT");
		});

		it("handles mixed case", () => {
			expect(classifyError("Connection Timeout")).toBe("TIMEOUT");
		});
	});

	describe("priority (first match wins)", () => {
		// Rate limit should be detected even with other keywords present
		it("detects rate limit with network keywords", () => {
			expect(classifyError("Connection rate limit exceeded")).toBe("RATE_LIMIT");
		});
	});
});

describe("getErrorEmoji", () => {
	it("returns clock for RATE_LIMIT", () => {
		expect(getErrorEmoji("RATE_LIMIT")).toBe("⏱️");
	});

	it("returns hourglass for TIMEOUT", () => {
		expect(getErrorEmoji("TIMEOUT")).toBe("⌛");
	});

	it("returns globe for NETWORK", () => {
		expect(getErrorEmoji("NETWORK")).toBe("🌐");
	});

	it("returns warning for VALIDATION", () => {
		expect(getErrorEmoji("VALIDATION")).toBe("⚠️");
	});

	it("returns question mark for UNKNOWN", () => {
		expect(getErrorEmoji("UNKNOWN")).toBe("❓");
	});
});

describe("getErrorSuggestion", () => {
	it("suggests waiting for RATE_LIMIT", () => {
		const suggestion = getErrorSuggestion("RATE_LIMIT");
		expect(suggestion).toContain("Wait");
		expect(suggestion).toContain("resume");
	});

	it("suggests network check for TIMEOUT", () => {
		const suggestion = getErrorSuggestion("TIMEOUT");
		expect(suggestion).toContain("network");
		expect(suggestion).toContain("resume");
	});

	it("suggests network check for NETWORK", () => {
		const suggestion = getErrorSuggestion("NETWORK");
		expect(suggestion).toContain("network");
		expect(suggestion).toContain("resume");
	});

	it("suggests manual review for VALIDATION", () => {
		const suggestion = getErrorSuggestion("VALIDATION");
		expect(suggestion).toContain("Review");
	});

	it("suggests log check for UNKNOWN", () => {
		const suggestion = getErrorSuggestion("UNKNOWN");
		expect(suggestion).toContain("log");
		expect(suggestion).toContain("resume");
	});
});

describe("truncateString", () => {
	it("returns original string if under max length", () => {
		expect(truncateString("hello", 10)).toBe("hello");
	});

	it("returns original string if exactly max length", () => {
		expect(truncateString("hello", 5)).toBe("hello");
	});

	it("truncates and adds ellipsis if over max length", () => {
		expect(truncateString("hello world", 8)).toBe("hello...");
	});

	it("handles very short max length", () => {
		expect(truncateString("hello", 4)).toBe("h...");
	});

	it("handles empty string", () => {
		expect(truncateString("", 10)).toBe("");
	});

	it("preserves exact length with ellipsis", () => {
		const result = truncateString("hello world foo bar", 10);
		expect(result.length).toBe(10);
		expect(result).toBe("hello w...");
	});
});

describe("formatErrorForRetry", () => {
	function createMinimalState(overrides: Partial<ImplementationState> = {}): ImplementationState {
		return {
			id: "test-id-123",
			implTimestamp: "2602061200",
			specPath: "docs/test_spec.md",
			specContent: "",
			stage: "implementation",
			createdAt: "2026-02-06T12:00:00.000Z",
			updatedAt: "2026-02-06T12:00:00.000Z",
			phases: ["phase1.md", "phase2.md"],
			phasesGenerated: [true, true],
			currentPhaseIndex: 0,
			currentReviewCycle: 1,
			previousReview: "",
			phaseCommits: [],
			...overrides,
		};
	}

	function createError(overrides: Partial<ErrorDetails> = {}): ErrorDetails {
		return {
			timestamp: "2026-02-06T12:00:00.000Z",
			agent: "opus",
			role: "implementer",
			phase: 1,
			cycle: 1,
			exitCode: 1,
			errorType: "UNKNOWN",
			agentTask: "test task",
			...overrides,
		};
	}

	it("handles state with undefined phases", () => {
		const error = createError({ phase: 1 });
		const state = createMinimalState();
		(state as any).phases = undefined;
		
		expect(() => formatErrorForRetry(error, state)).not.toThrow();
		const result = formatErrorForRetry(error, state);
		// Should show "?" for unknown total phases
		expect(result).toContain("1 of ?");
	});

	it("handles state with empty phases array", () => {
		const error = createError({ phase: 1 });
		const state = createMinimalState({ phases: [] });
		
		expect(() => formatErrorForRetry(error, state)).not.toThrow();
		const result = formatErrorForRetry(error, state);
		expect(result).toContain("1 of ?");
	});

	it("handles error without phase", () => {
		const error = createError();
		delete (error as any).phase;
		const state = createMinimalState();
		
		expect(() => formatErrorForRetry(error, state)).not.toThrow();
	});

	it("includes all error details when present", () => {
		const error = createError({
			stderr: "Some error output",
			phase: 2,
			cycle: 3,
		});
		const state = createMinimalState({ phases: ["p1.md", "p2.md", "p3.md"] });
		
		const result = formatErrorForRetry(error, state);
		expect(result).toContain("opus");
		expect(result).toContain("implementer");
		expect(result).toContain("2 of 3");
	});
});

describe("formatErrorBox", () => {
	function createMinimalState(overrides: Partial<ImplementationState> = {}): ImplementationState {
		return {
			id: "test-id-123",
			implTimestamp: "2602061200",
			specPath: "docs/test_spec.md",
			specContent: "",
			stage: "implementation",
			createdAt: "2026-02-06T12:00:00.000Z",
			updatedAt: "2026-02-06T12:00:00.000Z",
			phases: ["phase1.md", "phase2.md"],
			phasesGenerated: [true, true],
			currentPhaseIndex: 0,
			currentReviewCycle: 1,
			previousReview: "",
			phaseCommits: [],
			...overrides,
		};
	}

	function createError(overrides: Partial<ErrorDetails> = {}): ErrorDetails {
		return {
			timestamp: "2026-02-06T12:00:00.000Z",
			agent: "opus",
			role: "implementer",
			phase: 1,
			cycle: 1,
			exitCode: 1,
			errorType: "UNKNOWN",
			agentTask: "test task",
			...overrides,
		};
	}

	it("handles state with undefined phases", () => {
		const error = createError({ phase: 1 });
		const state = createMinimalState();
		(state as any).phases = undefined;
		
		expect(() => formatErrorBox(error, state)).not.toThrow();
		const result = formatErrorBox(error, state);
		expect(result).toContain("1 of ?");
	});

	it("handles error with stderr", () => {
		const error = createError({
			stderr: "Error: Something went wrong\nStack trace here",
		});
		const state = createMinimalState();
		
		const result = formatErrorBox(error, state);
		expect(result).toContain("Error Message");
		expect(result).toContain("Something went wrong");
	});

	it("handles error without optional fields", () => {
		const error: ErrorDetails = {
			timestamp: "2026-02-06T12:00:00.000Z",
			agent: "gpt-5.4",
			role: "codeReviewer",
			exitCode: 1,
			errorType: "NETWORK",
			agentTask: "review task",
		};
		const state = createMinimalState();
		
		expect(() => formatErrorBox(error, state)).not.toThrow();
		const result = formatErrorBox(error, state);
		expect(result).toContain("gpt-5.4");
		expect(result).toContain("codeReviewer");
	});
});
