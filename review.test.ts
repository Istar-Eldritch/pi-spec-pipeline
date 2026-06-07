import { describe, it, expect } from "vitest";
import { parseVerdict, hasSignificantIssues } from "./review.ts";

describe("parseVerdict", () => {
	describe("explicit verdict markers", () => {
		it("parses **Verdict**: APPROVED", () => {
			expect(parseVerdict("**Verdict**: APPROVED")).toBe("APPROVED");
		});

		it("parses **Verdict**: NEEDS_CHANGES", () => {
			expect(parseVerdict("**Verdict**: NEEDS_CHANGES")).toBe("NEEDS_CHANGES");
		});

		it("parses **Status**: APPROVED", () => {
			expect(parseVerdict("**Status**: APPROVED")).toBe("APPROVED");
		});

		it("parses **Status**: NEEDS_CHANGES", () => {
			expect(parseVerdict("**Status**: NEEDS_CHANGES")).toBe("NEEDS_CHANGES");
		});
	});

	describe("inline verdict in text", () => {
		it("finds APPROVED in surrounding text", () => {
			expect(parseVerdict("Blah blah... APPROVED ... more text")).toBe("APPROVED");
		});

		it("finds APPROVED with context", () => {
			expect(parseVerdict("The code is APPROVED for merge")).toBe("APPROVED");
		});

		it("finds NEEDS_CHANGES with suffix", () => {
			expect(parseVerdict("NEEDS_CHANGES - see issues below")).toBe("NEEDS_CHANGES");
		});
	});

	describe("case insensitivity", () => {
		it("handles lowercase approved", () => {
			expect(parseVerdict("approved")).toBe("APPROVED");
		});

		it("handles mixed case Approved", () => {
			expect(parseVerdict("Approved")).toBe("APPROVED");
		});

		it("handles lowercase needs_changes", () => {
			expect(parseVerdict("needs_changes")).toBe("NEEDS_CHANGES");
		});
	});

	describe("legacy verdict formats", () => {
		it("treats CHANGES_REQUESTED as NEEDS_CHANGES", () => {
			expect(parseVerdict("**Status**: CHANGES_REQUESTED")).toBe("NEEDS_CHANGES");
		});

		it("treats READY as APPROVED", () => {
			expect(parseVerdict("**Status**: READY")).toBe("APPROVED");
		});

		it("treats NEEDS_WORK as NEEDS_CHANGES", () => {
			expect(parseVerdict("**Status**: NEEDS_WORK")).toBe("NEEDS_CHANGES");
		});

		it("treats 'NEEDS WORK' (with space) as NEEDS_CHANGES", () => {
			expect(parseVerdict("This NEEDS WORK before proceeding")).toBe("NEEDS_CHANGES");
		});
	});

	describe("conflicting verdicts (last wins)", () => {
		it("returns NEEDS_CHANGES when APPROVED comes first", () => {
			expect(parseVerdict("APPROVED then later NEEDS_CHANGES")).toBe("NEEDS_CHANGES");
		});

		it("returns APPROVED when NEEDS_CHANGES comes first", () => {
			expect(parseVerdict("NEEDS_CHANGES then later APPROVED")).toBe("APPROVED");
		});

		it("handles multiple occurrences - last wins", () => {
			expect(parseVerdict("APPROVED ... NEEDS_CHANGES ... APPROVED")).toBe("APPROVED");
		});
	});

	describe("conservative default behavior", () => {
		it("returns NEEDS_CHANGES when no verdict found", () => {
			expect(parseVerdict("No verdict in output at all")).toBe("NEEDS_CHANGES");
		});

		it("returns NEEDS_CHANGES for empty string", () => {
			expect(parseVerdict("")).toBe("NEEDS_CHANGES");
		});

		it("returns NEEDS_CHANGES for ambiguous text", () => {
			expect(parseVerdict("The code looks good but needs some work")).toBe("NEEDS_CHANGES");
		});
	});

	describe("word boundary matching", () => {
		it("does not match UNAPPROVED as APPROVED", () => {
			// UNAPPROVED contains APPROVED but should not match
			expect(parseVerdict("This is UNAPPROVED")).toBe("NEEDS_CHANGES");
		});

		it("does not match DISAPPROVED as APPROVED", () => {
			expect(parseVerdict("DISAPPROVED by reviewer")).toBe("NEEDS_CHANGES");
		});
	});

	describe("real-world review outputs", () => {
		it("handles multiline review with verdict at end", () => {
			const output = `
## Code Review

The implementation looks good overall.

### Minor Issues
- Consider adding more comments

**Verdict**: APPROVED
`;
			expect(parseVerdict(output)).toBe("APPROVED");
		});

		it("handles review with issues list and NEEDS_CHANGES", () => {
			const output = `
## Review Results

### Critical Issues
1. Missing null check in processData()
2. SQL injection vulnerability

### Recommendation
NEEDS_CHANGES - please address the critical issues above.
`;
			expect(parseVerdict(output)).toBe("NEEDS_CHANGES");
		});

		it("anchors to verdict marker even when body mentions 'APPROVED' later", () => {
			const output = `
**Verdict**: NEEDS_CHANGES

**Issues**:
1. [CRITICAL] Missing input validation on request body

**Notes**:
- Once these issues are fixed the change should be APPROVED for merge.
`;
			expect(parseVerdict(output)).toBe("NEEDS_CHANGES");
		});

		it("anchors to verdict marker even when body mentions 'NEEDS_CHANGES' later", () => {
			const output = `
**Verdict**: APPROVED

**Strengths**:
- Implementation follows spec exactly
- Tests cover the new behaviour

**Notes**:
- Earlier drafts had NEEDS_CHANGES but those have been resolved.
`;
			expect(parseVerdict(output)).toBe("APPROVED");
		});

		it("falls through when marker parrots template 'APPROVED | NEEDS_CHANGES'", () => {
			// When the model echoes the prompt template literally, the marker is
			// ambiguous; the legacy last-wins fallback should pick NEEDS_CHANGES.
			const output = "**Verdict**: APPROVED | NEEDS_CHANGES";
			expect(parseVerdict(output)).toBe("NEEDS_CHANGES");
		});

		it("uses the last verdict marker when there are multiple", () => {
			// A reviewer might draft an early verdict then revise it at the end.
			const output = `
**Verdict**: APPROVED

(further analysis)

**Verdict**: NEEDS_CHANGES
`;
			expect(parseVerdict(output)).toBe("NEEDS_CHANGES");
		});
	});
});

describe("hasSignificantIssues", () => {
	it("detects CRITICAL keyword", () => {
		expect(hasSignificantIssues("There is a CRITICAL bug")).toBe(true);
	});

	it("detects MAJOR keyword", () => {
		expect(hasSignificantIssues("Found MAJOR issues")).toBe(true);
	});

	it("is case insensitive", () => {
		expect(hasSignificantIssues("critical issue found")).toBe(true);
		expect(hasSignificantIssues("Major problem")).toBe(true);
	});

	it("returns false for minor issues", () => {
		expect(hasSignificantIssues("Minor formatting issues")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasSignificantIssues("")).toBe(false);
	});

	it("returns false for general feedback", () => {
		expect(hasSignificantIssues("The code looks good, just some small tweaks needed")).toBe(false);
	});
});
