# Technical Spec: Git Worktree Isolation for `/implement`

> Source discovery: `specs/discovery_implement_worktree_isolation.md`.
> Codebase: `/home/istar/code/pi-spec-pipeline` (TypeScript, bun, pi extension).
> Date: 2026-06-10.
> Verification: `bun test` · TypeScript typecheck (`tsc --noEmit` or equivalent).

---

## 1. Problem Statement

Today `/implement` runs the implementation pipeline directly in the checkout it
was triggered from: agents are spawned with `cwd = ctx.cwd`, commits land on
the current branch (`createAgentCommit`, `createCommit` in `git.ts`), and the
error-recovery path (`resetToHead` → `git reset --hard` + `git clean -fd`)
mutates the user's working tree. Consequences:

- The user's current branch and working tree are hijacked for the duration of
  the run (which is why `/implement` currently hard-fails on a dirty tree —
  see `checkGitClean` gate in `index.ts` and `DIRTY_TREE_SUPPORT.md`).
- Two implementations cannot run concurrently in the same project (same
  checkout, same branch, conflicting dev servers/ports).
- The user cannot keep working while an implementation runs.

This spec isolates each `/implement` run in a dedicated **git worktree** on its
own **new branch**, created from the triggering checkout's `HEAD`. The entire
pipeline (per-phase plan → implement → review → commit) executes inside the
worktree. Two new settings in `.pi/spec-pipeline.json` control the worktree
base path and an optional post-creation setup script.

### Key architectural change: split `projectRoot` from `workRoot`

`runImplementPipeline(state, cwd, ...)` and its callees currently use a single
`cwd` for two distinct concerns that must now diverge:

| Concern | Today | After this spec |
|---|---|---|
| Pipeline state, session logs, review logs, escalation log, metrics export (`state.ts`, `writeReviewLog`, `escalation.ts`) | `cwd` | **`projectRoot`** — the main repo root of the checkout `/implement` was triggered from |
| Agent subprocess `cwd`, git operations (`git.ts`), test commands, modified-file detection | `cwd` | **`workRoot`** — the new worktree path |

State must stay in the main repo so `/implement-status`, `/implement-list`,
`/implement-resume`, and `/implement-metrics` keep working from the user's
normal checkout, and so concurrent runs share one state directory.

---

## 2. Scope & Boundaries

### 2.1 In Scope

- New `worktree` config section in `SpecPipelineConfigSchema` (`types.ts`) and
  its normalization in `config.ts` (FR-1).
- New module `worktree.ts` (+ `worktree.test.ts`): branch/directory naming,
  worktree creation, collision handling, gitignore guard, setup-script
  execution, resume re-attachment (FR-2, FR-3, FR-5).
- `/implement` handler changes in `index.ts`: create the worktree after
  validation, run the setup script, pass `workRoot` into the pipeline; relax
  the dirty-tree hard error on the *triggering* checkout (FR-2, FR-4).
- `runImplementPipeline` / `implement-pipeline.ts`, `review.ts`
  (`retryFailedOperation`), `errors.ts`, `escalation.ts`, `commit-agent.ts`
  call-site plumbing: distinguish `projectRoot` vs `workRoot` (FR-4).
- `ImplementationState` extension with worktree metadata + state migration
  defaults (FR-5).
- `/implement-resume` re-attachment to an existing or recreated worktree
  (FR-5).
- Completion/failure messaging with merge + cleanup instructions; status/list
  display of worktree info (FR-6).
- Tests and docs (FR-7).

### 2.2 Out of Scope

- Automatic worktree/branch cleanup or a `/implement-clean` command (cleanup
  is manual in v1; the completion message documents the commands — FR-6.2).
- Automatic merging of the implementation branch back into the triggering
  branch.
- An opt-out flag (e.g. `--no-worktree`). Worktree isolation is always on for
  `/implement` in v1. Legacy behavior survives only for resuming **pre-feature
  states** that have no worktree metadata (FR-5.6).
- Changes to phase extraction, plan generation, review cycles, escalation
  logic, or the agent subprocess protocol.
- Port/env/deps orchestration itself — that is the user's setup script's job;
  the extension only provides the hook and contract (FR-3).
- Windows support beyond what the codebase already has (setup script is
  executed via `bash`; see FR-3.2).

---

## 3. Configuration

### FR-1 — New `worktree` config section

**FR-1.1.** Add to `types.ts`:

```typescript
export const WorktreeConfigSchema = Type.Object({
	// Where implementation worktrees are created. Relative paths resolve
	// against the main repo root. Default: ".pi/worktrees".
	basePath: Type.Optional(Type.String({ minLength: 1 })),
	// Optional shell command run after worktree creation, before the pipeline
	// starts (cwd = the new worktree). Non-zero exit aborts the run.
	setupScript: Type.Optional(Type.String({ minLength: 1 })),
});
```

and a new optional property on `SpecPipelineConfigSchema`:

```typescript
worktree: Type.Optional(WorktreeConfigSchema),
```

Export `WorktreeConfig = Static<typeof WorktreeConfigSchema>`.

**FR-1.2.** Extend `ProjectConfig` (`types.ts`) with a **normalized** field:

```typescript
worktree: {
	basePath: string;        // always set; default ".pi/worktrees"
	setupScript?: string;    // absent when not configured
};
```

`buildProjectConfig` in `config.ts` populates it:
`basePath = config.worktree?.basePath ?? ".pi/worktrees"`,
`setupScript = config.worktree?.setupScript` (empty/whitespace-only strings are
treated as absent). Add `DEFAULT_WORKTREE_BASE_PATH = ".pi/worktrees"` as an
exported constant in `config.ts`.

**FR-1.3.** Path resolution: a relative `basePath` resolves against the
**project root** (see FR-2.1), not against `process.cwd()` and not against the
worktree. An absolute `basePath` is used as-is. Resolution happens at use time
(in `worktree.ts`), not at config-load time, so the stored config stays
portable.

**FR-1.4.** Validation at worktree-creation time (hard error, run aborts
before any state mutation beyond the already-created `ImplementationState`):

- the resolved base path must not be the project root itself;
- the resolved base path must not be inside `<projectRoot>/.git`.

**FR-1.5.** Backward compatibility: configs without a `worktree` key validate
and load exactly as today (TypeBox `Type.Object` ignores absent optionals);
the existing TypeBox validation error path (R4) applies to malformed values
(e.g. `basePath: 42` must produce a validation error naming the path).

**FR-1.6.** The existing worktree config fallback must keep working: when a pi
subprocess or command runs with `cwd` inside one of our generated worktrees,
`loadPipelineConfig` finds no `.pi/spec-pipeline.json` there (untracked `.pi/`
is not copied by `git worktree add`) and falls back to the main repo's config
via `resolveMainRepoFromWorktree`. Generated worktrees are standard linked
worktrees (`.git` *file* with `gitdir: <mainRepo>/.git/worktrees/<name>`), so
no change to `resolveMainRepoFromWorktree` is required — but FR-7.2 adds a
regression test. Export `resolveMainRepoFromWorktree` from `config.ts` so
`worktree.ts` and `index.ts` can reuse it (it is currently module-private).

---

## 4. Worktree Creation

### FR-2 — Create a worktree + branch on `/implement`

**FR-2.1 — Project root resolution.** Introduce
`resolveProjectRoot(cwd: string): string` in `worktree.ts`:
`resolveMainRepoFromWorktree(cwd) ?? cwd`. All state operations (FR-4.2) and
relative-base-path resolution (FR-1.3) use this value. When `/implement` is
triggered from the main checkout (the normal case) this equals `ctx.cwd` and
behavior of state paths is unchanged.

**FR-2.2 — Branch naming.** *(resolves discovery open point 1)*
The branch name is:

```
impl/<shortName>-<implTimestamp>
```

- `shortName`: derived from the delivery-plan/spec file basename using the
  **same sanitization already used in `implement-pipeline.ts`** (strip
  extension, strip leading `\d+_spec_` / `\d+_` prefix, lowercase, replace
  `[^a-z0-9_]` with `_`, truncate to 30 chars). Extract this into a shared
  exported helper (e.g. `deriveShortName(specPath)` in `worktree.ts` or
  `implement-pipeline.ts`) so phase naming and branch naming cannot drift.
- `implTimestamp`: the existing `YYMMDDhhmm` value from
  `generateTimestamp()` already stored on the state.

The worktree directory name is the branch name with the `impl/` prefix
dropped: `<basePath>/<shortName>-<implTimestamp>`.

**FR-2.3 — Collision handling.** *(resolves discovery open point 1)*
Before creation, check both the branch (`git rev-parse --verify --quiet
refs/heads/<branch>`) and the target directory (`fs.existsSync`). If either
exists, append `-2`, `-3`, … (same suffix applied to branch and directory,
keeping them paired) and re-check, up to `-9`. If all candidates collide,
abort with a hard error telling the user to clean up stale worktrees
(`git worktree list`, `git worktree prune`). Run `git worktree prune` once
before the collision scan to clear stale registrations of manually deleted
directories.

**FR-2.4 — Creation command.** Create with a single git invocation executed in
the project root via the existing `execGit` helper:

```
git worktree add -b <branch> <absoluteWorktreePath> <baseCommit>
```

where `<baseCommit>` is the `HEAD` commit hash of the **triggering checkout**
(`git -C <ctx.cwd> rev-parse HEAD`), resolved *before* creation and stored in
state (FR-5.1). A non-zero exit aborts the run with the git stderr surfaced in
the error notification and recorded in `state.lastError`.

**FR-2.5 — Gitignore guard.** *(resolves discovery open point 2 — yes,
worktrees inside the repo must be ignored)* Before `git worktree add`, ensure
the resolved base directory exists and contains a `.gitignore` file whose
content is exactly `*\n`. Create both idempotently (`mkdir -p`; only write the
file if missing). Rationale: a worktree under `.pi/worktrees/` is a full
checkout that would otherwise (a) appear as untracked noise in the main
checkout's `git status`, (b) risk being committed by `git add -A`, and (c)
make concurrent runs see each other's worktrees as dirty-tree changes. The
self-ignoring `.gitignore` solves all three without editing the user's root
`.gitignore`. This is done unconditionally — it is harmless when `basePath`
is outside the repository.

**FR-2.6 — Dirty triggering checkout.** *(behavior change)* The hard
`checkGitClean` error in the `/implement` handler is **removed** for the
triggering checkout. The worktree is created from `HEAD`, so uncommitted
changes in the triggering checkout can neither be destroyed by the pipeline
nor included in it. Instead, when the triggering checkout is dirty, emit a
**warning**: uncommitted changes will NOT be part of the implementation
(commit first if they should be). The destructive-operation rationale in
`DIRTY_TREE_SUPPORT.md` no longer applies to the user's checkout because
`git add -A` / `reset --hard` / `clean -fd` now execute inside the worktree
(FR-4.1); update that document (FR-7.4).

**FR-2.7 — Ordering in the `/implement` handler.** Worktree creation happens
**after** all input validation (file exists, non-empty, git repo valid, config
loads) and **after** `createInitialImplState` + first `saveImplState`, so a
creation failure is recorded on the state (`state.lastError`) and is
retryable via `/implement-resume`. Sequence:

1. validate args/file/git/config (existing logic);
2. create + save initial state (existing logic) — state now also gets
   worktree-pending info only after step 3 succeeds;
3. create worktree (FR-2.2–FR-2.5), persist worktree metadata to state
   (FR-5.1);
4. run setup script if configured (FR-3);
5. `runImplementPipeline(state, { projectRoot, workRoot }, projectConfig, ctx)`
   (FR-4).

---

## 5. Setup Script

### FR-3 — Optional setup script contract

*(resolves discovery open point 3)*

**FR-3.1 — When.** Runs once per worktree, immediately after successful
worktree creation and before any agent is spawned. Also re-runs when
`/implement-resume` had to **recreate** a missing worktree (FR-5.4); it does
NOT re-run on a plain resume into an existing worktree. Track this with
`state.worktree.setupScriptRan: boolean` (FR-5.1).

**FR-3.2 — How.** The config value is a shell command string (not necessarily
a file path), executed as:

- `spawn("bash", ["-c", <setupScript>], { cwd: <worktreePath>, env })`;
- `env` = `process.env` plus the variables in FR-3.3;
- stdout/stderr captured (combined log), not streamed raw to the UI; a
  one-line "Running worktree setup script…" notify before, and a success/
  failure notify after.

Because it is a shell command, users can reference files in the main repo via
the provided env vars, e.g. `"$PI_MAIN_REPO/scripts/setup-worktree.sh"`.
Relative paths inside the command resolve against the worktree (its cwd).

**FR-3.3 — Environment variables.**

| Variable | Value |
|---|---|
| `PI_WORKTREE_PATH` | absolute path of the new worktree |
| `PI_WORKTREE_BRANCH` | the implementation branch name (FR-2.2) |
| `PI_MAIN_REPO` | absolute project root (FR-2.1) |
| `PI_IMPL_ID` | `state.id` of this implementation run |

These four variables give the script everything needed to allocate unique
ports, copy/generate `.env` files, and install dependencies per-worktree.

**FR-3.4 — Failure handling: abort.** A non-zero exit code, a spawn error, or
a timeout (FR-3.5) **aborts the run before any agent call**:

- notify with the exit code and the last ~2000 chars of combined output;
- record a `state.lastError` (`errorType: "VALIDATION"` is acceptable; the
  important parts are a descriptive message and that `agentTask` is not set to
  a retryable agent task — resume must re-run the *script*, not an agent);
- leave the worktree in place for debugging;
- `state.worktree.setupScriptRan` stays `false`, so `/implement-resume`
  re-runs the script before continuing (FR-5.5).

**FR-3.5 — Timeout.** Kill the script (SIGTERM, then SIGKILL after 10 s) if it
runs longer than **15 minutes**; treat as failure per FR-3.4. Not configurable
in v1.

**FR-3.6 — Logging.** Write the full combined output to
`<projectRoot>/.pi/spec-pipeline/sessions/<state.id>/setup-script.log`
(best-effort, same pattern as `writeReviewLog`).

**FR-3.7 — Success.** Exit code 0 → set `setupScriptRan = true`, save state,
notify success, continue. No setup script configured → skip silently and set
`setupScriptRan = true` (so resume logic needs no special case).

---

## 6. Pipeline Execution Inside the Worktree

### FR-4 — `projectRoot` / `workRoot` plumbing

**FR-4.1 — Work operations use `workRoot`.** The following must receive the
worktree path instead of the triggering `cwd`:

- agent subprocess `cwd` for every role (`runAgentWithEscalation`,
  `runAgentWithConfig` call sites in `implement-pipeline.ts`, `review.ts`,
  `errors.ts`/retry paths, `commit-agent.ts` message generation);
- all `git.ts` helpers invoked by the pipeline: `getModifiedFiles`,
  `stageFiles`, `hasChangesStaged`, `createAgentCommit`, `createCommit`,
  `stashChanges`, `resetToHead`, `captureGitStatus`, `execGit` diff calls;
- test-command execution (implementer/addressReview agents inherit it via
  their `cwd` — no extra change needed beyond the agent `cwd`);
- the implementer no-op validation in `implement-pipeline.ts`
  (`getModifiedFiles(cwd)` → `getModifiedFiles(workRoot)`).

**FR-4.2 — State operations use `projectRoot`.** The following must keep
writing under the main repo regardless of where work happens:

- `saveImplState` / `loadImplState` / `listImplStates` /
  `getLatestActiveImplPipeline` (all `state.ts` CRUD);
- `getSessionLogDir` (subagent session logs);
- `writeReviewLog` in `implement-pipeline.ts`
  (`.pi/spec-pipeline/reviews/...`);
- `recordEscalation` / the escalation log
  (`.pi/spec-pipeline/escalations.log`);
- agent prompt-cache diff samples in `agents.ts`
  (`.pi/spec-pipeline/cache-diffs`) — key the cache map by `workRoot` or
  `projectRoot` consistently, but write the diff files under `projectRoot`;
- `/implement-metrics` export (`metrics-export.json`).

**FR-4.3 — Signature change.** Change `runImplementPipeline` to accept both
roots explicitly. Recommended shape:

```typescript
export interface PipelineRoots {
	projectRoot: string; // state, logs, config
	workRoot: string;    // agents, git, tests (the worktree)
}
export async function runImplementPipeline(
	state: ImplementationState,
	roots: PipelineRoots,
	projectConfig: ProjectConfig,
	ctx: PipelineUIContext,
): Promise<void>;
```

Thread the same pair through `runReview`, `retryFailedOperation`,
`handleAgentError`, `createAgentCommit`, and `recordEscalation` (or pass the
two paths as separate parameters where an options object is overkill). For a
legacy resume without worktree metadata (FR-5.6), callers pass
`workRoot === projectRoot`, which reproduces today's behavior exactly.

**FR-4.4 — Config consumed by the pipeline** is the one loaded at trigger time
from `projectRoot` (existing `loadPipelineConfig(ctx.cwd)` call relocated to
`loadPipelineConfig(projectRoot)`). Project-context files (`README.md`,
`AGENTS.md`, …) and test-command auto-detection in `buildProjectConfig` keep
reading from the directory passed to `loadPipelineConfig`; since the worktree
is a checkout of the same commit these are equivalent — no change required.

**FR-4.5 — Commits land only on the implementation branch.** All commits
created by the pipeline (`createAgentCommit` after each implementer/
addressReview run, the per-phase fallback `createCommit`) occur in the
worktree and therefore on `impl/...`. The triggering branch must show **zero**
new commits and zero working-tree changes from a pipeline run (verified by
test FR-7.2).

---

## 7. State, Resume, and Concurrency

### FR-5 — Worktree metadata in `ImplementationState` + resume

*(resolves discovery open point 5)*

**FR-5.1 — New state field.** Extend `ImplementationState` in `types.ts`:

```typescript
worktree?: {
	path: string;            // absolute worktree path
	branch: string;          // e.g. "impl/myfeature-2606101218"
	baseCommit: string;      // commit the branch was created from
	createdAt: string;       // ISO timestamp
	setupScriptRan: boolean; // false until FR-3 succeeds (or no script)
};
```

Persisted by `saveImplState` immediately after successful `git worktree add`
(before the setup script runs).

**FR-5.2 — State migration.** `loadImplState` treats a missing `worktree`
field as a legacy state (no defaulting, no rewrite); see FR-5.6.

**FR-5.3 — Resume into an existing worktree.** `/implement-resume` (run from
the main checkout or anywhere in the project):

- resolves `projectRoot` (FR-2.1) and loads state from there;
- if `state.worktree` is set, verifies the worktree:
  `fs.existsSync(path)` AND `git -C <path> rev-parse --git-dir` succeeds AND
  the checked-out branch is `state.worktree.branch`
  (`git -C <path> rev-parse --abbrev-ref HEAD`);
- on success: the **clean-tree check moves to the worktree**
  (`checkGitClean(workRoot)`) — the triggering checkout's dirtiness is
  irrelevant; error-stash cleanup (`stashExists`/`dropStash`) likewise runs
  against `workRoot`;
- then resumes the pipeline with `{ projectRoot, workRoot: worktree.path }`.

**FR-5.4 — Resume with a missing worktree directory.** If the directory is
gone (or fails the checks in FR-5.3) but the branch still exists:

- run `git worktree prune` in the project root;
- recreate with `git worktree add <path> <branch>` (no `-b`; reuse the
  existing branch and its commits);
- reset `setupScriptRan = false` and re-run the setup script (FR-3.1);
- continue the resume.

If the **branch** no longer exists, fail with a hard error: the
implementation cannot be resumed; direct the user to start a fresh
`/implement` (the state remains for `/implement-metrics`/forensics).

**FR-5.5 — Resume after setup-script failure.** When `state.worktree` exists,
`setupScriptRan === false`, and a setup script is configured, resume re-runs
the script (FR-3) before entering the pipeline. Success clears
`state.lastError` for this case.

**FR-5.6 — Legacy states.** A resumable state **without** `worktree` metadata
(created before this feature) resumes with today's exact behavior:
`workRoot = projectRoot = cwd`, including the existing dirty-tree hard error.
No worktree is retroactively created for in-flight legacy runs.

**FR-5.7 — Concurrency.** Multiple active implementations are supported by
design: each has its own state file (already true), its own worktree, and its
own branch. The existing "Active Implementation Found" confirm prompt in
`/implement` stays, but its wording changes from a collision warning to an
informational prompt ("An implementation is already running in its own
worktree. Start another one in parallel?"). `/implement-resume <id>` resumes a
specific run; bare `/implement-resume` keeps resolving via
`getLatestActiveImplPipeline`.

---

## 8. Completion, Failure, and Visibility

### FR-6 — Lifecycle policy and UX

*(resolves discovery open point 4)*

**FR-6.1 — The worktree is always left in place** — on success, on agent
failure, on setup-script failure, and on `/implement-cancel`. No automatic
deletion in v1.

**FR-6.2 — Completion message.** Extend the completion block in
`implement-pipeline.ts` with:

- `Branch: impl/<...>` and `Worktree: <path>`;
- next-steps lines:
  - review: `cd <worktreePath>`;
  - merge: `git merge <branch>` (from the user's branch in the main
    checkout) or open a PR from `<branch>`;
  - cleanup: `git worktree remove <worktreePath>` then
    `git branch -d <branch>` (after merging).

**FR-6.3 — Failure messages** (agent error, setup-script error) must include
the worktree path so the user can inspect it.

**FR-6.4 — `/implement-status` and `/implement-list`** display
`Branch:`/`Worktree:` lines when `state.worktree` is set (extend
`formatImplState` in `formatting.ts`).

**FR-6.5 — `/implement-cancel`** is unchanged apart from messaging: mention
that the worktree is kept and resumable.

---

## 9. Tests & Documentation

### FR-7 — Verification

**FR-7.1 — `worktree.test.ts`** (bun test, real temporary git repos as in
`git.test.ts`):

- branch/dir naming from spec basenames (prefix stripping, sanitization,
  30-char truncation, `impl/` prefix);
- collision handling: pre-create the branch and/or directory → `-2` suffix on
  both; exhaustion (`-9`) → error;
- creation: worktree exists, correct branch checked out, base commit matches
  triggering `HEAD`; `<base>/.gitignore` with `*` created idempotently;
- relative vs absolute `basePath` resolution against project root; rejection
  of project root / `.git`-internal base paths (FR-1.4);
- setup script: env vars present, cwd is the worktree, non-zero exit →
  failure result with captured output, no-script case sets
  `setupScriptRan = true`;
- `resolveProjectRoot` from inside a generated worktree returns the main repo
  root (also covers FR-1.6 config fallback indirectly).

**FR-7.2 — Isolation regression test:** run a minimal pipeline-level scenario
(or a focused integration test around the commit path) asserting the
triggering checkout's branch ref and working tree are byte-identical before
and after commits are made in the worktree (FR-4.5).

**FR-7.3 — `config.test.ts` additions:** `worktree` section validation
(valid, missing → defaults, wrong types → validation errors naming the path);
normalized `ProjectConfig.worktree.basePath` default `.pi/worktrees`;
whitespace-only `setupScript` treated as absent.

**FR-7.4 — State/resume tests** (`state.test.ts` / `pipeline-resume.test.ts`):
worktree metadata round-trips through save/load; legacy state without
`worktree` loads unchanged (FR-5.2/5.6); resume recreation path (FR-5.4) at
least at the helper level (`git worktree add <path> <branch>` after directory
deletion restores prior commits).

**FR-7.5 — Docs:** update `README.md` (configuration section: `worktree`
settings with an example including a setup script using `$PI_MAIN_REPO` and
`$PI_WORKTREE_PATH`; lifecycle/cleanup commands), the `index.ts` header
comment, `skills/implement-pipeline/SKILL.md` (the run happens in an isolated
worktree; where to find results), and `DIRTY_TREE_SUPPORT.md` (the
clean-tree requirement now applies to the worktree, not the user's checkout —
FR-2.6).

---

## 10. Non-Functional Requirements

- **NFR-1 — No behavior change for legacy in-flight runs** (FR-5.6) and no
  on-disk migration of existing state files.
- **NFR-2 — Config backward compatibility:** existing
  `.pi/spec-pipeline.json` files load unchanged; the schema remains tolerant
  of unknown fields (current TypeBox behavior).
- **NFR-3 — The existing main-repo config fallback**
  (`resolveMainRepoFromWorktree` + fallback read in `loadPipelineConfig`)
  keeps working for processes running inside generated worktrees (FR-1.6).
- **NFR-4 — State directory layout is unchanged** (`.pi/spec-pipeline/…` under
  the project root); only the *resolution* of which root it lives under is
  formalized (FR-2.1/FR-4.2).
- **NFR-5 — All git interaction goes through `execGit`/`git.ts`** (no ad-hoc
  child_process calls outside `worktree.ts`'s use of the same helper), and
  setup-script execution is the only new shell-out.
- **NFR-6 — `tsc --noEmit` and `bun test` green** at completion.

---

## 11. Resolved Open Points (from the discovery doc)

| Open point | Resolution |
|---|---|
| Branch naming + collisions | `impl/<shortName>-<implTimestamp>`, dir `<shortName>-<implTimestamp>` under base path; paired `-2`…`-9` suffixes, then hard error; `git worktree prune` before scanning (FR-2.2, FR-2.3) |
| Gitignore for `.pi/worktrees` | Yes — self-ignoring `<basePath>/.gitignore` containing `*`, created idempotently, never touching the user's root `.gitignore` (FR-2.5) |
| Setup script contract | `bash -c <command>`, cwd = worktree, env `PI_WORKTREE_PATH`/`PI_WORKTREE_BRANCH`/`PI_MAIN_REPO`/`PI_IMPL_ID`, 15-min timeout, non-zero exit **aborts** the run (worktree kept; resume re-runs the script) (FR-3) |
| Completion/failure cleanup policy | Worktree and branch always left in place; completion message gives merge + `git worktree remove` + `git branch -d` instructions; no auto-cleanup in v1 (FR-6) |
| Resume interaction | Worktree metadata stored in state under the main repo; resume re-attaches, recreates a missing worktree from the surviving branch (re-running setup), hard-fails only if the branch is gone; legacy states resume with old behavior (FR-5) |
| Relative vs absolute base path | Relative resolved against the project root (main repo root when triggered from a worktree); absolute used as-is; project root and `.git`-internal paths rejected (FR-1.3, FR-1.4, FR-2.1) |

---

## 12. Suggested Phase Table

| Phase | Focus | Effort | Difficulty |
|-------|-------|--------|------------|
| Phase 1 | Config: `WorktreeConfigSchema`, `ProjectConfig.worktree` normalization, export `resolveMainRepoFromWorktree`, config tests | Small | standard |
| Phase 2 | New `worktree.ts`: project-root resolution, naming, collision handling, creation, gitignore guard, setup-script runner; `worktree.test.ts` | Medium | standard |
| Phase 3 | Plumbing: `PipelineRoots` through `implement-pipeline.ts`, `review.ts`, `errors.ts`, `escalation.ts`, `git.ts` call sites; state vs work split | Large | hard |
| Phase 4 | `index.ts`: `/implement` creation flow + dirty-check relaxation, `/implement-resume` re-attach/recreate, status/list/cancel/completion UX; state field + migration | Medium | standard |
| Phase 5 | Isolation regression test, resume tests, docs (`README.md`, SKILL, `DIRTY_TREE_SUPPORT.md`), final `bun test` + typecheck | Medium | standard |
