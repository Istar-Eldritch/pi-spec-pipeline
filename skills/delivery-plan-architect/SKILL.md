---
name: delivery-plan-architect
description: |
  Translate a completed implementation spec or technical design document into a
  structured, phased delivery plan for engineering execution. Use after the spec
  is complete and before implementation begins.
---

# Delivery Plan Architect

Use when a completed implementation specification or technical design document
needs to become a sequenced delivery plan. This skill pairs with the
`delivery-plan-architect` agent.

## When to Trigger

- A technical spec or design document is complete enough to plan implementation
- The user asks to create a delivery plan, implementation roadmap, phase plan, or execution plan
- The next step is sequencing work, identifying dependencies, and defining verifiable phase outcomes

Skip if the user is still defining requirements; use `spec-writer` first.
Skip if the user wants to start coding from an existing plan; use `implement-pipeline` instead.

## How to Run

Launch the agent with the path to the completed spec or design document:

```text
subagent agent=delivery-plan-architect task="Read <spec-or-design-path> and produce a delivery plan."
```

If the user wants the plan saved to a specific file, include that output path in
the task:

```text
subagent agent=delivery-plan-architect task="Read <spec-or-design-path> and write the delivery plan to <output-path>."
```

If no source document path is provided, ask for one before launching the agent.
Do not guess.

## What the Agent Produces

The `delivery-plan-architect` agent produces a numbered delivery plan with:

- A concise spec summary
- Critical blockers, if any
- Phases with goals, entry conditions, exit criteria, parallelism, effort, and blockers
- A parallelism summary
- An effort summary

## Handoff

After the delivery plan is produced, review it with the user. If they approve the
plan and want implementation to begin, hand off to `implement-pipeline`.
