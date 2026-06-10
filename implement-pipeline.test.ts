import { describe, it, expect } from "vitest";
import { extractPhases } from "./implement-pipeline.ts";

// Common test parameters
const TIMESTAMP = "2602071200";
const SHORT_NAME = "warm_pools";

describe("extractPhases", () => {
	// ============================================
	// Format 1: Table with links (legacy)
	// ============================================
	describe("table format with links (legacy)", () => {
		it("extracts phases from linked table format", () => {
			const spec = `
## Implementation Plan

| Phase | Focus | Effort | Details |
|-------|-------|--------|---------|
| Phase 1 | Backend API | 2 days | [backend-api](./2602071200_warm_pools/phase1_backend_api.md) |
| Phase 2 | Frontend UI | 3 days | [frontend-ui](./2602071200_warm_pools/phase2_frontend_ui.md) |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(false);
			expect(result.paths).toEqual([
				"./2602071200_warm_pools/phase1_backend_api.md",
				"./2602071200_warm_pools/phase2_frontend_ui.md",
			]);
		});

		it("extracts paths from linked format with varying whitespace", () => {
			const spec = `
| Phase 1 |  API  |  2d  | [api](./specs/phase1.md) |
|  Phase 2  | UI | 3d | [ui](./specs/phase2.md) |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(false);
			expect(result.paths).toEqual(["./specs/phase1.md", "./specs/phase2.md"]);
		});

		it("linked format takes priority over plain table format", () => {
			// Both formats present — linked should win
			const spec = `
| Phase 1 | Backend API endpoints | 2 days | [backend](./path/phase1.md) |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(false);
			// Should use the linked path, not generate from description
			expect(result.paths).toEqual(["./path/phase1.md"]);
		});
	});

	// ============================================
	// Format 2: Table without links (preferred)
	// ============================================
	describe("table format without links (preferred)", () => {
		it("extracts phases from simple table format", () => {
			const spec = `
## Implementation Plan

| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | Backend API endpoints for job cancellation | 2 days |
| Phase 2 | Real-time notification system | 3 days |
| Phase 3 | Frontend UI components | 1 day |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(false);
			expect(result.paths).toHaveLength(3);
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_backend_api_endpoints_job.md`,
			);
			expect(result.paths[1]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase2_realtime_notification_system.md`,
			);
			expect(result.paths[2]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase3_frontend_ui_components.md`,
			);
		});

		it("generates slug from focus description (max 4 words, stop words removed)", () => {
			const spec = `
| Phase 1 | Add the authentication flow for users | 5 days |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			// PHASE_STOP_WORDS only includes articles/prepositions: "the", "for" removed
			// "add" is NOT a stop word here; remaining: "add", "authentication", "flow", "users" (4 max)
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_add_authentication_flow_users.md`,
			);
		});

		it("handles single phase", () => {
			const spec = `
| Phase 1 | Complete implementation | 3 days |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			expect(result.paths[0]).toContain("phase1_");
			expect(result.paths[0]).toContain(".md");
		});

		it("handles phase numbers > 9", () => {
			const spec = `
| Phase 10 | Final cleanup and documentation | 1 day |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			expect(result.paths[0]).toContain("phase10_");
		});

		it("handles extra whitespace in table cells", () => {
			const spec = `
|  Phase 1  |   Backend API    |   2 days   |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_backend_api.md`,
			);
		});

		it("filters stop words from phase descriptions", () => {
			const spec = `
| Phase 1 | Add a new API for the billing system | 3 days |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			// "a" filtered (length 1), "for"/"the" are stop words
			// Remaining: "add", "new", "api", "billing" (4 words max, "system" truncated)
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_add_new_api_billing.md`,
			);
		});

		it("handles descriptions that result in empty slug after filtering", () => {
			// All words are stop words or single chars
			const spec = `
| Phase 1 | a | 1 day |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			// "a" is single char, filtered out → falls back to "phase"
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_phase.md`,
			);
		});

		it("strips non-alphanumeric characters from descriptions", () => {
			const spec = `
| Phase 1 | WebSocket (real-time) integration | 2 days |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			// "WebSocket", "(real-time)", "integration" → after sanitize: "websocket", "realtime", "integration"
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_websocket_realtime_integration.md`,
			);
		});

		it("does not match table header row", () => {
			const spec = `
| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | Actual content | 2 days |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			// "Phase" alone (without number) should not match
			expect(result.paths).toHaveLength(1);
			expect(result.paths[0]).toContain("phase1_");
		});
	});

	// ============================================
	// Format 3: Typst table format
	// ============================================
	describe("Typst table format", () => {
		it("extracts phases from Typst table syntax", () => {
			const spec = `
#table(
  columns: 3,
  [*Phase*], [*Focus*], [*Effort*],
  [Phase 1], [Backend API endpoints], [2 days],
  [Phase 2], [Frontend components], [3 days],
  [Phase 3], [Integration testing], [1 day],
)
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(false);
			expect(result.paths).toHaveLength(3);
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_backend_api_endpoints.md`,
			);
			expect(result.paths[1]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase2_frontend_components.md`,
			);
			expect(result.paths[2]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase3_integration_testing.md`,
			);
		});

		it("handles Typst format with special characters in description", () => {
			const spec = `
  [Phase 1], [WebSocket real-time updates], [2 days],
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_websocket_realtime_updates.md`,
			);
		});

		it("does not match Typst header row with asterisks", () => {
			const spec = `
  [*Phase*], [*Focus*], [*Effort*],
  [Phase 1], [Actual content here], [2 days],
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			// Only the data row should match, not the header
			expect(result.paths).toHaveLength(1);
			expect(result.paths[0]).toContain("phase1_");
		});
	});

	// ============================================
	// Format 4: Inline headers (fallback)
	// ============================================
	describe("inline header format (fallback)", () => {
		it("extracts phases from ### headers", () => {
			const spec = `
## Implementation Plan

### Phase 1: Backend API Endpoints

Description of phase 1...

### Phase 2: Frontend UI Components

Description of phase 2...

### Phase 3: Integration Testing
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(true);
			expect(result.paths).toHaveLength(3);
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_backend_api_endpoints.md`,
			);
			expect(result.paths[1]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase2_frontend_ui_components.md`,
			);
			expect(result.paths[2]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase3_integration_testing.md`,
			);
		});

		it("strips parenthesized effort from inline headers", () => {
			const spec = `
### Phase 1: Backend API Endpoints (2 days)
### Phase 2: Frontend (3 days)
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(true);
			expect(result.paths).toHaveLength(2);
			// Parenthesized content should be stripped
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_backend_api_endpoints.md`,
			);
			expect(result.paths[1]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase2_frontend.md`,
			);
		});

		it("matches em-dash, en-dash, and hyphen separators in inline headers", () => {
			const spec = `
### Phase 1 — Skeleton Plumbing
### Phase 2 – Pilot Domain
### Phase 3 - Cleanup Pass
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(true);
			expect(result.paths).toHaveLength(3);
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_skeleton_plumbing.md`,
			);
			expect(result.paths[1]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase2_pilot_domain.md`,
			);
			expect(result.paths[2]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase3_cleanup_pass.md`,
			);
		});

		it("does not match ## or #### headers", () => {
			const spec = `
## Phase 1: Should not match
#### Phase 2: Should not match
### Phase 3: Should match
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			expect(result.paths[0]).toContain("phase3_");
		});
	});

	// ============================================
	// No phases found
	// ============================================
	describe("no phases detected", () => {
		it("returns empty array when no phases found", () => {
			const spec = `
## Some Spec

This is a spec without any phase table or headers.

Just regular text content here.
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(0);
			expect(result.isInline).toBe(true); // fallback path returns isInline: true
		});

		it("returns empty for empty string", () => {
			const result = extractPhases("", TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(0);
		});
	});

	// ============================================
	// Priority / format precedence
	// ============================================
	describe("format precedence", () => {
		it("linked table takes priority over plain table", () => {
			const spec = `
| Phase 1 | Backend API | 2 days | [backend](./custom/path.md) |
| Phase 2 | Frontend | 3 days | [frontend](./custom/path2.md) |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(false);
			// Should use linked paths, not auto-generated
			expect(result.paths).toEqual(["./custom/path.md", "./custom/path2.md"]);
		});

		it("plain table takes priority over Typst format", () => {
			// If both markdown table and Typst table are present, markdown table wins
			const spec = `
| Phase 1 | Markdown table phase | 2 days |

Some other content...

[Phase 1], [Typst table phase], [2 days],
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			// Should use the markdown table format, not Typst
			expect(result.paths[0]).toContain("markdown_table_phase");
		});

		it("Typst format takes priority over inline headers", () => {
			const spec = `
[Phase 1], [Typst phase], [2 days],

### Phase 1: Inline Header Phase
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(false);
			expect(result.paths).toHaveLength(1);
			expect(result.paths[0]).toContain("typst_phase");
		});
	});

	// ============================================
	// Real-world spec examples
	// ============================================
	describe("real-world spec patterns", () => {
		it("extracts phases from a full spec document", () => {
			const spec = `
# Spec: Warm Machine Pools

**Status**: Draft
**Created**: 2026-02-07

## Problem Statement

We need warm machine pools for faster instance startup.

## Requirements

R1: Pool configuration API
R2: Background provisioning engine

## Implementation Plan

| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | Pool configuration API and data model | 3 days |
| Phase 2 | Background provisioning engine with retry logic | 5 days |
| Phase 3 | Billing integration for warm machine hours | 2 days |
| Phase 4 | Monitoring dashboard and alerting | 2 days |

## Success Criteria

- [ ] Pools can be configured via API
- [ ] Machines are provisioned within SLA
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(false);
			expect(result.paths).toHaveLength(4);
			expect(result.paths[0]).toContain("phase1_");
			expect(result.paths[1]).toContain("phase2_");
			expect(result.paths[2]).toContain("phase3_");
			expect(result.paths[3]).toContain("phase4_");
		});

		it("handles spec with only one phase", () => {
			const spec = `
## Implementation Plan

| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | Complete refactoring of auth module | 2 days |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			expect(result.paths[0]).toContain("phase1_");
		});

		it("handles Typst spec document", () => {
			const spec = `
= Spec: Job Cancellation

== Implementation Plan

#table(
  columns: (auto, 1fr, auto),
  [*Phase*], [*Focus*], [*Effort*],
  [Phase 1], [Cancellation API endpoints and state machine], [3 days],
  [Phase 2], [Worker graceful shutdown integration], [2 days],
)
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.isInline).toBe(false);
			expect(result.paths).toHaveLength(2);
			expect(result.paths[0]).toContain("phase1_");
			expect(result.paths[1]).toContain("phase2_");
		});
	});

	// ============================================
	// Edge cases
	// ============================================
	describe("edge cases", () => {
		it("handles phase description with only stop words", () => {
			const spec = `
| Phase 1 | is a for the in on | 1 day |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			// All words are stop words → falls back to "phase"
			expect(result.paths[0]).toBe(
				`${TIMESTAMP}_${SHORT_NAME}/phase1_phase.md`,
			);
		});

		it("handles description with numbers and special chars", () => {
			const spec = `
| Phase 1 | OAuth 2.0 token validation & refresh | 2 days |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			// Special chars stripped, "20" filtered (length > 1 passes), stop words removed
			expect(result.paths[0]).toContain("phase1_");
			expect(result.paths[0]).toContain("oauth");
		});

		it("uses specTimestamp and shortName in generated paths", () => {
			const spec = `
| Phase 1 | Backend API | 2 days |
`;
			const result = extractPhases(spec, "2602080900", "my_feature");
			expect(result.paths[0]).toMatch(/^2602080900_my_feature\//);
		});

		it("handles multiple tables — only matches phase rows", () => {
			const spec = `
## Requirements

| # | Requirement | Priority |
|---|-------------|----------|
| 1 | Auth flow   | High     |

## Implementation Plan

| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | Auth flow implementation | 2 days |
`;
			const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
			expect(result.paths).toHaveLength(1);
			expect(result.paths[0]).toContain("phase1_");
		});
	});
});

describe("extractPhases difficulty column", () => {
	it("3-column table → all phases standard", () => {
		const spec = `
| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | Backend API | 2 days |
| Phase 2 | Frontend UI | 3 days |
`;
		const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
		expect(result.paths).toHaveLength(2);
		expect(result.difficulties).toEqual(["standard", "standard"]);
	});

	it("4-column table with Difficulty cells is parsed per phase", () => {
		const spec = `
| Phase | Focus | Effort | Difficulty |
|-------|-------|--------|------------|
| Phase 1 | Backend API | 2 days | standard |
| Phase 2 | Auth migration | 1 day | hard |
| Phase 3 | Frontend UI | 3 days | standard |
`;
		const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
		expect(result.paths).toHaveLength(3);
		expect(result.difficulties).toEqual(["standard", "hard", "standard"]);
	});

	it("difficulty is case-insensitive", () => {
		const spec = `
| Phase | Focus | Effort | Difficulty |
|-------|-------|--------|------------|
| Phase 1 | Backend API | 2 days | Hard |
| Phase 2 | Frontend UI | 3 days | STANDARD |
`;
		const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
		expect(result.difficulties).toEqual(["hard", "standard"]);
	});

	it("non-difficulty 4th column values default to standard", () => {
		const spec = `
| Phase | Focus | Effort | Owner |
|-------|-------|--------|-------|
| Phase 1 | Backend API | 2 days | alice |
| Phase 2 | Frontend UI | 3 days | bob |
`;
		const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
		expect(result.paths).toHaveLength(2);
		expect(result.difficulties).toEqual(["standard", "standard"]);
	});

	it("a 3-column table's 4th capture never swallows the next row", () => {
		const spec = `
| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | Backend API | 2 days |
| Phase 2 | Hard things | 3 days |
`;
		const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
		// Both rows must be detected as phases (the optional difficulty group
		// must not consume "Phase 2" across the newline).
		expect(result.paths).toHaveLength(2);
		expect(result.paths[0]).toContain("phase1_");
		expect(result.paths[1]).toContain("phase2_");
		expect(result.difficulties).toEqual(["standard", "standard"]);
	});

	it("typst table with 4th [hard] cell is parsed", () => {
		const spec = `
#table(
  columns: 4,
  [Phase 1], [Backend API], [2 days], [standard],
  [Phase 2], [Auth migration], [1 day], [hard],
)
`;
		const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
		expect(result.paths).toHaveLength(2);
		expect(result.difficulties).toEqual(["standard", "hard"]);
	});

	it("typst table without difficulty cells → standard", () => {
		const spec = `
#table(
  columns: 3,
  [Phase 1], [Backend API], [2 days],
  [Phase 2], [Frontend UI], [3 days],
)
`;
		const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
		expect(result.paths).toHaveLength(2);
		expect(result.difficulties).toEqual(["standard", "standard"]);
	});

	it("inline phase with (hard) parenthetical is marked hard", () => {
		const spec = `
### Phase 1: Backend API
### Phase 2: Auth migration (hard)
### Phase 3: Frontend UI (2 days)
`;
		const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
		expect(result.isInline).toBe(true);
		expect(result.paths).toHaveLength(3);
		expect(result.difficulties).toEqual(["standard", "hard", "standard"]);
	});

	it("linked legacy table → all standard", () => {
		const spec = `
| Phase | Focus | Effort | Details |
|-------|-------|--------|---------|
| Phase 1 | Backend API | 2 days | [backend-api](./2602071200_warm_pools/phase1_backend_api.md) |
`;
		const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
		expect(result.difficulties).toEqual(["standard"]);
	});

	it("difficulties is always aligned with paths", () => {
		const spec = `
| Phase | Focus | Effort | Difficulty |
|-------|-------|--------|------------|
| Phase 1 | A | 1 day | hard |
| Phase 2 | B | 1 day |
| Phase 3 | C | 1 day | hard |
`;
		const result = extractPhases(spec, TIMESTAMP, SHORT_NAME);
		expect(result.difficulties).toHaveLength(result.paths.length);
		expect(result.difficulties[0]).toBe("hard");
		expect(result.difficulties[2]).toBe("hard");
	});
});

// ============================================
// FR-2.2: /implement input contract
// ============================================

describe("/implement input contract (FR-2.2)", () => {
	// The handler's heuristic for detecting free-text vs. file-path arguments:
	//   looksLikeFilePath = arg.includes("/") || /\.(md|typ)$/i.test(arg)
	// If !looksLikeFilePath && !fs.existsSync(fullPath) → guidance error returned
	// (no discovery mode; OQ-1 resolution removes enterImplementDiscoveryMode)

	it("detects free-text as non-file and would return guidance error", () => {
		const freeTextArgs = [
			"add user auth",
			"fix the null pointer bug",
			"refactor billing",
		];
		for (const arg of freeTextArgs) {
			const looksLikeFilePath = arg.includes("/") || /\.(md|typ)$/i.test(arg);
			// Free text does not look like a file path → guidance error path
			expect(looksLikeFilePath).toBe(false);
		}
	});

	it("does NOT treat .md argument as free text", () => {
		const arg = "plan.md";
		const looksLikeFilePath = arg.includes("/") || /\.(md|typ)$/i.test(arg);
		expect(looksLikeFilePath).toBe(true);
	});

	it("does NOT treat .typ argument as free text", () => {
		const arg = "delivery-plan.typ";
		const looksLikeFilePath = arg.includes("/") || /\.(md|typ)$/i.test(arg);
		expect(looksLikeFilePath).toBe(true);
	});

	it("does NOT treat path-with-slash argument as free text", () => {
		const args = [
			"docs/2606101200_deliver_plan.md",
			"./specs/plan.md",
			"/home/user/plan.md",
		];
		for (const arg of args) {
			const looksLikeFilePath = arg.includes("/") || /\.(md|typ)$/i.test(arg);
			expect(looksLikeFilePath).toBe(true);
		}
	});
});
