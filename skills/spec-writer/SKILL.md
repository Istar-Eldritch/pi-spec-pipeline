---
name: spec-writer
description: |
  Translate a completed UX discovery document into a precise, structured
  technical specification. Use after discovery is complete and before planning
  or implementation. Produces numbered, traceable requirements and writes the
  spec to the requested output path.
---

# Spec Writer

Use when a UX discovery document exists and needs to become a technical
specification. This skill pairs with the `spec-writer` agent.

## When to Trigger

- A discovery interview has produced a structured problem summary or discovery document
- The user asks to draft, write, or generate a spec from discovery output
- The next step is requirements definition, not implementation planning

Skip if the user is still exploring the problem space; use `ux-discovery-interviewer` first.
Skip if the spec is already complete and the user wants implementation; use `implement-pipeline` instead.

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
- Open questions and risks

## Handoff

After the spec is written, review the saved file path with the user. The next step before implementation is creating a delivery plan:

```text
subagent agent=delivery-plan-architect task="Read <spec-path> and write the delivery plan to <output-path>."
```

Once the delivery plan is approved, hand off to `implement-pipeline` to execute it.
