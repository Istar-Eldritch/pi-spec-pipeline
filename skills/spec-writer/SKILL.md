---
name: spec-writer
description: |
  Translate a completed UX discovery document into a precise, structured
  technical specification with a phased delivery plan. Use after discovery is
  complete and before implementation begins. Produces numbered, traceable
  requirements, sequenced delivery phases, and a machine-readable JSON phases
  block that /implement parses directly.
---

# Spec Writer

Use when a UX discovery document exists and needs to become a technical
specification with an executable delivery plan. This skill pairs with the
`spec-writer` agent, which handles both requirements definition and delivery
planning in a single pass.

## When to Trigger

- A discovery interview has produced a structured problem summary or discovery document
- The user asks to draft, write, or generate a spec from discovery output
- The user asks for a delivery plan, implementation roadmap, phase plan, or execution plan
- The next step is requirements definition and work sequencing, not coding

Skip if the user is still exploring the problem space; use `ux-discovery-interviewer` first.
Skip if a complete spec with phases already exists and the user wants implementation; use `implement-pipeline` instead.

## How to Run

Launch the agent with both the discovery document path and the exact output path:

```text
subagent agent=spec-writer task="Read <discovery-path> and write the spec to <output-path>."
```

If no output path is provided, ask the user for one before launching the agent. Do not guess.

## What the Agent Produces

The `spec-writer` agent writes the specification file directly. It does not return the spec body in chat.

The spec includes:
- Problem statement grounded in the discovery document
- Numbered, independently verifiable requirements
- Explicit non-functional requirements
- Observable success criteria
- Scope and boundaries
- Advisory solution approach
- A codebase map: every file the work touches, anchored with `path:line` and
  symbol names gathered during codebase exploration
- Open questions and risks
- A phased delivery plan: per-phase goals, concrete scopes (files to modify
  with anchors, files to create, explicit out-of-bounds), entry conditions,
  exit criteria, parallelism, effort, difficulty, and blockers — written so a
  less capable implementer model can execute each phase without re-exploring
  the codebase
- A final `## Phases (JSON)` section — a fenced ```json block encoding the
  phases (`phase`, `focus`, `effort`, `difficulty`) that `/implement` parses
  to sequence the work and route `hard` phases to a stronger model

## Handoff

After the spec is written, review the saved file path with the user. Once they
approve it, hand off directly to `implement-pipeline`:

```text
/implement <spec-path>
```
