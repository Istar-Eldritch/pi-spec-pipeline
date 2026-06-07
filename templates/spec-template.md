# Spec: <Title> (<TICKET-ID>)

**Status:** Draft
**Created:** YYYY-MM-DD
**Timestamp:** YYMMDDhhmm

> Replace the placeholders above. `Timestamp` must match the filename prefix so the spec pipeline can pair the spec with its phase plans.

## Problem Statement

- **Business context:** Why does this matter?
- **Current state:** What exists today?
- **Key issues:** What problems need solving?

## Requirements

- **R1.** Specific, testable requirement describing WHAT, not HOW.
- **R2.** ...
- **R3.** ...

Each requirement must be independently verifiable.

## Success Criteria

- [ ] Measurable outcome 1
- [ ] Measurable outcome 2
- [ ] Measurable outcome 3

## Scope & Boundaries

**In scope:**
- ...

**Out of scope:**
- ...

## Open Questions

- [ ] Unresolved decision that may affect requirements
- [x] ~~Resolved question — keep with strikethrough for history~~

## Implementation Plan

The pipeline parses the table below to drive `/implement`. The table is **mandatory** and must be the first thing in this section.

| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | High-level capability description (e.g. "Backend API endpoints for X") | 1 day |
| Phase 2 | High-level capability description (e.g. "Real-time notification delivery") | 2 days |
| Phase 3 | High-level capability description (e.g. "Frontend UI components") | 1 day |

**Rules:**
- Phase descriptions describe WHAT (capability), not HOW (file paths, function names).
- Do NOT include phase file links or a "Details" column.
- Detailed `### Phase N: Name` subsections below are **optional** and must come AFTER the table.
- If you use detailed subsections, use `:` as the separator (not em-dash/en-dash) so the fallback parser works.

### Phase 1: <Name>  *(optional detail)*

Brief prose describing this phase's capability, layers involved, and any cross-phase constraints. No file paths or code — those belong in the phase plan generated during `/implement`.

### Phase 2: <Name>  *(optional detail)*

...

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| ... | ... |

## References

- Related specs, RFCs, or tickets
