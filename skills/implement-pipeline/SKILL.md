name: implement-pipeline
description: |
  Invoke the spec-pipeline implementation workflow. Use when a spec document
  is ready for coding and the user or another agent explicitly tells you to
  implement it. The pipeline handles plan generation, phased implementation,
  code review, and automated commits per phase.
---

# Implement Pipeline

Use when a spec document is ready for implementation and the user asks you to
run it. The pipeline reads the spec file, extracts phases from its phase table,
and processes each one: implement → review → commit.

## When to use

- A spec document exists and the user says "implement this", "start implementation", etc.
- Another agent delegates implementation work via /implement

## Usage

When the user asks to implement a spec, tell them:

```
The spec is ready. Run: /implement docs/<spec-path>
```

Or, if both agents understand the protocol, call it with --auto:

```
/implement --auto docs/2606082331_spec_annotation_review_flow.md
```

The `--auto` flag allows non-interactive (agent-driven) invocation, skipping
TTY confirmations and answering defaults automatically.

## Optional flags

- `--no-plan` — Skip plan generation (if the spec is already detailed enough)
- `--no-review` — Skip code review cycles
- `--auto` — Skip interactive confirmations (for agent-driven / non-TTY use)

## What the pipeline does

1. Checks for a clean git working tree
2. Parses the phase table from the spec/plan document
3. Per phase:
   - Plans (or reads plan)
   - Implements code and runs tests
   - Reviews with an AI code reviewer
   - Commits with AI-generated message

## Configuration

Reads `.pi/spec-pipeline.json` in the project root for model selection, review
cycles, and test commands. The catacloud project already has this configured.