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
- The problem space is fuzzy before a `spec-writer` run
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

   - **A discovery interview is human-paced.** Long gaps between turns are expected and normal — the interviewer is *supposed* to be blocked waiting on the user. Do NOT treat "no activity for 60s" stall nudges as a problem or interrupt/resume the run because of them. Only act on a nudge if the interviewer is genuinely stuck (e.g. it errored), not merely waiting for the next human answer.
   - **Answer grounding/codebase questions yourself.** If the interviewer asks something the codebase can answer ("does the assignee picker wire to a backend?", "what statuses exist today?"), look it up with your own tools and feed the *fact* back as the reply rather than relaying a code question to the user. Reserve the user's attention for intent and product decisions.

4. **Proceed with spec writing** using the problem summary as input — hand it to the `spec-writer` agent to produce a technical specification with a phased delivery plan, then run `/implement` to execute it.

## Presenting Questions to the User

When relaying the interviewer's questions, present them naturally as your own words — don't expose the intercom mechanics. The user should experience a smooth conversation, not see "the interviewer asked via intercom that…".

## What the Interviewer Does

The `ux-discovery-interviewer` agent:
- **Grounds itself in the codebase first** — establishes current implementation facts with its own read tools before asking anything, so it never asks the user a question the code can answer
- Follows a structured question arc: opening → pain → workarounds → stakes → prior attempts → success → constraints
- Asks one question at a time, goes deep before broad
- **Enforces phase order**: problem-space (pain/actors/flow in the user's words) before any option/state-machine question
- Allows "both/neither" answers and reflects repeated answer patterns back to check if they generalize
- Stays strictly in problem-space — never discusses solutions
- When the picture is complete: synthesises a structured problem summary (who, pain, frequency, workarounds, cost of inaction, prior attempts, success criteria) and sends it to the main session, splitting any open questions into *user decisions* vs *implementer lookups*
