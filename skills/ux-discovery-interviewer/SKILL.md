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

The discovery interview is inherently turn-by-turn and interactive. It runs as a **dedicated agent session** (`ux-discovery-interviewer`) so the persona is fully isolated. The two sessions coordinate via **intercom**: the main agent sends an ask, the interviewer replies with the problem summary when the user types `/discovery-done`.

## When to Trigger

- User starts with "I have an idea", "I want to build X", or describes a solution before defining the need
- The problem space is fuzzy before a `/spec` or planning session
- User explicitly asks for a discovery interview

Skip if the user already has a clear, grounded problem statement.

## How to Hand Off (main agent side)

1. **Send an intercom ask** to the `ux-discovery-interviewer` session to establish the return channel:
   ```
   intercom action=ask to=ux-discovery-interviewer message="Ready to receive discovery summary when the interview is complete."
   ```
2. **Tell the user** to open a new pi session and select the `ux-discovery-interviewer` agent (or run `pi --agent ux-discovery-interviewer`).
3. **Wait** — the intercom ask blocks until the interviewer sends the reply. The interviewer will send the problem summary automatically when the user types `/discovery-done`.
4. Once the reply arrives, **proceed with spec drafting** using the problem summary as input.

## What the Interviewer Does

The `ux-discovery-interviewer` agent:
- Conducts a structured, turn-by-turn problem-space interview (one question per message)
- Never discusses solutions, architecture, or technology
- On `/discovery-done`: synthesises a structured problem summary (who, pain, frequency, workarounds, cost of inaction, prior attempts, success criteria) and sends it back via intercom reply

## Inline Alternative

If the user is already in a conversation and doesn't want to switch sessions, you can conduct the interview inline by adopting the interviewer persona yourself — read `agents/ux-discovery-interviewer.md` for the full question arc and behavioural rules. In this case you do not use intercom; just proceed with spec drafting after the summary.
