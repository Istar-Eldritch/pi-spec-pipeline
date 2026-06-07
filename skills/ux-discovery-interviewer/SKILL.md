---
name: ux-discovery-interviewer
description: |
  Conduct a structured UX discovery interview before any spec or implementation work.
  Use at the very start of a new feature, product, or workflow discussion — before
  architecture, design, or implementation is considered. Trigger when someone has
  "an idea", "a problem to solve", "a feature request", or when they describe a
  solution before clearly defining the underlying need.
---

# UX Discovery Interviewer

The `ux-discovery-interviewer` agent is available as a subagent for structured problem-space exploration. It is a UX researcher persona that helps users clearly articulate the problem they are trying to solve before any solution is discussed.

## When to Invoke

Delegate to `ux-discovery-interviewer` when:
- A user starts with "I have an idea" or "I want to build X" without explaining the underlying need
- A solution is being discussed before the problem is defined
- You're about to start a `/spec` or planning session and the problem space is fuzzy
- The user says they want to "explore" or "figure out" what they need

Do **not** invoke if the user has already provided a clear, grounded problem statement with known stakeholders, pain, and success criteria.

## How to Invoke

Use the `subagent` tool with `agent: "ux-discovery-interviewer"`. The interviewer will conduct the session and end when the user types `/discovery-done`, at which point it hands off a problem summary for the next stage (spec drafting or planning).

```
agent: ux-discovery-interviewer
```

The agent will begin with:
> "Walk me through what prompted this. What's happening today that you want to change?"

After `/discovery-done`, use the problem summary to proceed with `/spec` or another planning workflow.
