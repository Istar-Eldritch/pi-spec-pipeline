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

The discovery interview runs as an **async subagent** and communicates entirely through **intercom**. The user never leaves the main session — the main agent relays each question to the user and each answer back to the interviewer. The interviewer maintains the conversational state and conducts the full interview turn by turn.

## When to Trigger

- User starts with "I have an idea", "I want to build X", or describes a solution before defining the need
- The problem space is fuzzy before a `/spec` or planning session
- User explicitly asks for a discovery interview

Skip if the user already has a clear, grounded problem statement.

## How to Run the Interview (main agent side)

1. **Launch the interviewer as an async subagent**, passing the current session name and any initial context the user provided:
   ```
   subagent agent=ux-discovery-interviewer async=true task="<initial context from user>"
   ```

2. **Enter the relay loop** — wait for intercom asks from the interviewer, present each question to the user naturally (not as a raw intercom message), collect the answer, and send it back as an intercom reply:
   ```
   intercom action=pending   → shows the interviewer's question
   (present question to user, get their answer)
   intercom action=reply message="<user's answer>"
   ```

3. **Repeat** until the interviewer sends a final `intercom send` (not an ask) containing the problem summary. You'll know it's the summary rather than a question because it arrives as a non-blocking send, not a pending ask.

4. **Proceed with spec drafting** using the problem summary as input — hand it to `/spec` or use it to start the planning phase.

## Presenting Questions to the User

When relaying the interviewer's questions, present them naturally as your own words — don't expose the intercom mechanics. The user should experience a smooth conversation, not see "the interviewer asked via intercom that…".

## What the Interviewer Does

The `ux-discovery-interviewer` agent:
- Reads project context to ground its questions
- Follows a structured question arc: opening → pain → workarounds → stakes → prior attempts → success → constraints
- Asks one question at a time, goes deep before broad
- Stays strictly in problem-space — never discusses solutions
- When the picture is complete: synthesises a structured problem summary (who, pain, frequency, workarounds, cost of inaction, prior attempts, success criteria) and sends it to the main session
