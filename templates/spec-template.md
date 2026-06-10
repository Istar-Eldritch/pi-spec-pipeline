> **Note:** This template is no longer auto-loaded by the extension. Use it as a reference
> when working with the `spec-writer` agent or when authoring a spec manually.

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

Detailed `### Phase N: Name` subsections are **optional**; the machine-readable source of truth is the `## Phases (JSON)` section at the end of the document.

### Phase 1: <Name>  *(optional detail)*

Brief prose describing this phase's capability, layers involved, and any cross-phase constraints. No file paths or code — those belong in the phase plan generated during `/implement`.

### Phase 2: <Name>  *(optional detail)*

...

**Rules:**
- Phase descriptions describe WHAT (capability), not HOW (file paths, function names).
- If you use detailed subsections, use `:` as the separator (not em-dash/en-dash) so the fallback parser works.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| ... | ... |

## References

- Related specs, RFCs, or tickets

## Phases (JSON)

The pipeline parses the JSON block below to drive `/implement`. It is **mandatory**, must be the **last section** of the document, and must be valid JSON (double-quoted strings, no trailing commas, no comments). `difficulty` is exactly `"standard"` or `"hard"` (lowercase); `hard` phases are routed to a stronger model.

```json
{
  "phases": [
    { "phase": 1, "focus": "High-level capability description", "effort": "S", "difficulty": "standard" },
    { "phase": 2, "focus": "High-level capability description", "effort": "M", "difficulty": "hard" }
  ]
}
```
