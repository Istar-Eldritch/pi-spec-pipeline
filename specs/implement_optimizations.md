# Spec: Implement Pipeline Optimizations

**Status**: Draft
**Created**: 2026-02-08

## Problem Statement

The `/implement` command's pipeline spawns excessive `pi` subprocesses for commit message generation (5-10+ per phase), includes redundant final-phase commits, embeds large spec content repeatedly in agent prompts, and uses expensive models for fix application where cheaper ones suffice.

## Requirements

R1: Replace LLM-based commit message generation with deterministic templates — no subprocess spawning for commit messages.

R2: Guard the final phase commit — skip it entirely if no uncommitted changes exist after the review loop.

R3: Write spec/plan content to temp files instead of embedding inline in agent task prompts — reduce IPC overhead.

R4: Use `projectConfig.models.addressReview` for fix application in both cheap and expensive review tiers, and change the default to sonnet.

## Implementation Plan

| Phase | Focus | Effort |
|-------|-------|--------|
| Phase 1 | Deterministic commit messages and final phase commit guard | 1 day |
| Phase 2 | Temp file spec content and addressReview model change | 0.5 day |
