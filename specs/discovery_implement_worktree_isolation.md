# Discovery: Git worktree isolation for the /implement command

## Problem

Today the `/implement` command runs the implementation pipeline directly on the
branch/checkout it was triggered from. This means:

- The implementation mutates the user's current working tree and branch.
- Two implementations cannot run simultaneously in the same project without
  colliding (same checkout, same branch, conflicting dev servers/ports).
- The user cannot keep working on their current branch while an implementation
  is in progress.

## Desired behaviour

When `/implement` is run, the pipeline should create a **git worktree** with its
own dedicated branch, and run the entire implementation inside that worktree —
fully independent of the branch/checkout the command was triggered from.

## Requirements gathered from the user

1. **Worktree creation on /implement**: running `/implement` creates a new git
   worktree on its own new branch, and the implementation (all phases, reviews,
   commits) happens inside that worktree, not in the original checkout.
2. **Configurable worktree base path**: a new setting in
   `.pi/spec-pipeline.json` controls where worktrees are created. Default:
   `.pi/worktrees` inside the same project folder.
3. **Optional setup script**: a new setting in `.pi/spec-pipeline.json` for an
   optional setup script (path/command) that runs after the worktree is
   created, before implementation starts. Purpose: prepare the worktree so
   concurrent implementations don't conflict (e.g. install deps, assign unique
   dev-server ports, copy/generate `.env` files).

## Existing context (codebase facts)

- Project: `/home/istar/code/pi-spec-pipeline` (TypeScript, bun, pi extension).
- The `/implement` command pipeline lives in `implement-pipeline.ts`,
  registered in `index.ts`.
- Config loading/validation: `config.ts` with a TypeBox schema
  `SpecPipelineConfigSchema` in `types.ts`. Config file is
  `.pi/spec-pipeline.json`.
- `config.ts` already contains worktree *awareness*:
  `resolveMainRepoFromWorktree()` resolves the main repo root when running
  inside a worktree, and config loading falls back to the main repo's
  `.pi/spec-pipeline.json` when the worktree has none. This existing fallback
  must keep working with the new feature.
- Git helpers live in `git.ts`. Pipeline state lives in `state.ts`
  (`.pi/spec-pipeline/` directory). Tests use bun test (`*.test.ts`).

## Open points the spec should resolve

- Branch naming convention for the implementation branch (likely derived from
  the spec/plan name) and collision handling when a branch/worktree already
  exists.
- Whether `.pi/worktrees` should be gitignored (it should — worktrees inside
  the repo must not be committed).
- Setup script contract: working directory (the new worktree), arguments /
  environment variables passed (e.g. worktree path, branch name, main repo
  path), failure handling (abort vs warn).
- What happens on pipeline completion/failure: the worktree is left in place
  for the user to review/merge; cleanup policy should be defined.
- How resume (`pipeline-resume`) interacts with an implementation that lives
  in a worktree.
- Relative vs absolute worktree base paths in config (relative resolved
  against the project root).
