# Spec: Automated Scoping Discovery for `/plan` Command

**Status**: Draft  
**Created**: 2026-02-07  
**Timestamp**: 2602072237

## Problem Statement

When the user runs `/plan <description>` without a level flag, the command immediately shows a manual `ctx.ui.select()` asking the user to choose between Roadmap, Epic, or Feature. This is suboptimal because:

- The user may not know the right scope level for their request
- A `scopingAgent` system prompt already exists but is never used by `/plan`
- The extension already supports conversational modes (discovery, drafting) — scoping should follow the same pattern

## Requirements

### R1: Add "scoping" pipeline mode
Extend `PipelineMode` type to include `"scoping"` alongside `"idle"`, `"discovery"`, and `"drafting"`.

### R2: Add ephemeral scoping state tracking
Track scoping conversations in memory (not persisted to disk). State includes:
- Original description from `/plan`
- Conversation history (ConversationalExchange[])
- The `--quick` flag status
- Recommended level (parsed from agent output)

### R3: Modify `/plan` command handler  
When no level flag is given: enter scoping mode, inject scopingAgent prompt, send initial message. The LLM explores the codebase and asks scoping questions conversationally.

### R4: Add `/plan-done` command
Ends scoping mode. Parses agent's recommendation from conversation. Presents confirm/override UI. Routes to correct pipeline (roadmap/epic/spec). Passes scoping context to child pipeline.

### R5: Wire event handlers for scoping mode
- `before_agent_start`: inject scopingAgent prompt when in scoping mode
- `input`: track user messages
- `agent_end`: capture assistant responses  
- `context`: filter scoping context messages when not in scoping mode

### R6: Preserve override flags
`--roadmap`, `--epic`, `--feature` continue to skip scoping entirely.

### R7: Widget display during scoping

### R8: Forward scoping context to child pipeline
Build a summary of the scoping conversation and pass it as additional context.

## Success Criteria

- [ ] `/plan <desc>` without flags enters scoping mode
- [ ] Host LLM acts as scoping agent
- [ ] `/plan-done` presents confirm/override UI
- [ ] Correct pipeline starts after confirmation
- [ ] Override flags still work
- [ ] Scoping context forwarded to child pipeline
- [ ] Widget shows scoping status

## Out of Scope

- Persisting scoping state to disk
- Creating git branches during scoping
- Changes to the scopingAgent system prompt

## Implementation Plan

| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | Type changes (`PipelineMode`, scoping state interface) | 0.5 days |
| Phase 2 | `/plan` handler rewrite + `/plan-done` command + event handler wiring | 1 day |
| Phase 3 | Context forwarding to child pipelines | 0.5 days |
