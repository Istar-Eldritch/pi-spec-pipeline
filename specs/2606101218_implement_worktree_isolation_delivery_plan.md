# Delivery Plan: Git Worktree Isolation for `/implement`

> Spec: `specs/2606101218_implement_worktree_isolation.md`
> Codebase: `/home/istar/code/pi-spec-pipeline` (TypeScript, bun, pi extension)
> Date: 2026-06-10
> Baseline verified green before planning: `bun test` (326 pass / 0 fail, 11 files) · `bun run typecheck` (`tsc --noEmit`, exit 0)

---

## 1. Summary

Isolate every `/implement` run in a dedicated git worktree on a new
`impl/<shortName>-<implTimestamp>` branch, created from the triggering
checkout's `HEAD`. The core architectural move is splitting today's single
`cwd` into two roots:

- **`projectRoot`** — main repo root: state files, session logs, review logs,
  escalation log, error log, metrics export, config loading.
- **`workRoot`** — the worktree: agent subprocess `cwd`, all git mutations
  (`git add/commit/stash/reset/clean`), test execution, modified-file
  detection.

Two new config knobs (`worktree.basePath`, `worktree.setupScript`) in
`.pi/spec-pipeline.json`. Legacy in-flight states (no `worktree` metadata)
resume with today's exact behavior (`workRoot === projectRoot`).

## 2. Sequencing Rationale (deltas vs. spec §12)

The spec's 5-phase table is sound; this plan keeps its shape with three
refinements:

1. **`ImplementationState.worktree` type + state round-trip moves to Phase 1**
   (spec had it in Phase 4). Phases 2 and 3 both reference the type
   (`worktree.ts` returns the metadata; the pipeline reads it for the
   completion message), so it must exist first. It is pure `types.ts` +
   `state.ts` work with no behavior change, which matches Phase 1's risk
   profile.
2. **Phase 3 is a strictly behavior-preserving refactor.** All call sites
   (including `index.ts`) pass `workRoot === projectRoot === ctx.cwd` until
   Phase 4. This makes Phase 3 — the largest, riskiest diff (it ripples
   through `handleAgentError`, `runReview`, `retryFailedOperation`,
   `recordEscalation`, `agents.ts` cache-diff paths) — verifiable purely by
   "all existing tests still green, zero functional delta", before any
   worktree is ever created.
3. **The completion-message/UX changes (FR-6.2) land in Phase 4 with the
   `index.ts` wiring**, not Phase 3, because they are dead code until
   `state.worktree` is actually populated by the handler.

Dependency chain: P1 → P2 (worktree.ts uses config + state types) → P3
(pipeline reads roots; independent of P2 logic but shares the types) → P4
(wires P2's creation/resume into P3's plumbed pipeline) → P5 (end-to-end
regression + docs). P2 and P3 touch disjoint files and could in principle be
parallelized, but sequential delivery is recommended: P3's
`PipelineRoots`/`handleAgentError` signatures are easier to settle once P2 has
fixed the metadata shape.

## 3. Phase Table

| Phase | Focus | Effort | Difficulty |
|-------|-------|--------|------------|
| Phase 1 | Config schema and state types: WorktreeConfigSchema, ProjectConfig worktree normalization, ImplementationState worktree field, export resolveMainRepoFromWorktree, config and state tests | Small | standard |
| Phase 2 | New worktree module: project root resolution, deriveShortName extraction, branch and directory naming, collision handling, worktree creation, gitignore guard, setup script runner, reattach and recreate helpers, worktree tests | Medium | standard |
| Phase 3 | Roots plumbing: PipelineRoots through implement-pipeline, review, errors, escalation, agents and commit call sites, split state operations from work operations, behavior preserving with workRoot equal projectRoot | Large | hard |
| Phase 4 | Command wiring: /implement worktree creation flow and dirty check relaxation, setup script invocation, /implement-resume reattach and recreate, status list cancel and completion UX | Medium | standard |
| Phase 5 | Isolation regression test, resume recreation tests, docs for README, SKILL, DIRTY_TREE_SUPPORT and index header, final full verification | Medium | standard |

---

## 4. Phase Details

### Phase 1 — Config schema + state types (FR-1, FR-5.1, FR-5.2)

**Files:** `types.ts`, `config.ts`, `state.ts` (verify-only), `config.test.ts`, `state.test.ts`

Work items:

1. `types.ts`:
   - Add `WorktreeConfigSchema` (`basePath?: string minLength 1`,
     `setupScript?: string minLength 1`) and `worktree: Type.Optional(WorktreeConfigSchema)`
     on `SpecPipelineConfigSchema`. Export `WorktreeConfig = Static<...>`.
   - Extend `ProjectConfig` with normalized
     `worktree: { basePath: string; setupScript?: string }`.
   - Extend `ImplementationState` with optional
     `worktree?: { path; branch; baseCommit; createdAt; setupScriptRan }`
     (FR-5.1).
2. `config.ts`:
   - Export `DEFAULT_WORKTREE_BASE_PATH = ".pi/worktrees"`.
   - `buildProjectConfig`: populate `worktree.basePath` (default) and
     `worktree.setupScript` — trim and treat empty/whitespace-only as absent
     (FR-1.2). **Note:** `buildProjectConfig` runs before the `!fromFile`
     defaults-reset branch in `loadPipelineConfig`; confirm the normalized
     `worktree` survives that branch untouched.
   - Change `function resolveMainRepoFromWorktree` to an **exported**
     function (FR-1.6); no logic change.
   - No path resolution at load time — `basePath` stays as-written (FR-1.3).
3. `state.ts`: no code change expected — `loadImplState` must NOT default or
   rewrite a missing `worktree` field (FR-5.2). Verify the migration block
   (`needsSave` logic) does not touch it.
4. Tests:
   - `config.test.ts` (FR-7.3): valid `worktree` section accepted; absent →
     normalized default `.pi/worktrees`; `basePath: 42` → validation error
     whose message names the `/worktree/basePath` path; whitespace-only
     `setupScript` → normalized absent; configs without `worktree` key load
     exactly as today (FR-1.5/NFR-2).
   - `state.test.ts` / `pipeline-resume.test.ts` (FR-7.4 first half):
     `state.worktree` round-trips through `saveImplState`/`loadImplState`;
     a legacy state JSON without `worktree` loads with
     `state.worktree === undefined` and the file on disk is not rewritten to
     add it.

**Exit criteria (verifiable):**
- `bun test` green (≥ baseline 326 tests; new config/state tests added and passing).
- `bun run typecheck` green.
- `grep -n "export function resolveMainRepoFromWorktree" config.ts` matches.
- `grep -n "DEFAULT_WORKTREE_BASE_PATH" config.ts` matches.
- A state JSON written by `saveImplState` with `worktree` set contains the
  five metadata keys (assert in test); a legacy fixture without `worktree`
  is byte-stable across `loadImplState` (assert in test).
- No behavior change anywhere else: zero modifications outside the listed files.

---

### Phase 2 — `worktree.ts` module + tests (FR-2.1–2.5, FR-3, FR-1.3/1.4)

**Files:** new `worktree.ts`, new `worktree.test.ts`, `implement-pipeline.ts`
(extract-only edit), `state.ts` (reuse `getSessionLogDir` for the log path)

Work items:

1. `resolveProjectRoot(cwd): string` = `resolveMainRepoFromWorktree(cwd) ?? cwd`
   (FR-2.1), importing the now-exported helper from `config.ts`.
2. `deriveShortName(specPath): string` — extract the inline sanitization from
   `_runImplementPipelineInner` (strip extension, strip `\d+_spec_` / `\d+_`
   prefix, lowercase, `[^a-z0-9_]` → `_`, slice 30) into this shared exported
   helper; replace the inline block in `implement-pipeline.ts` with a call
   (FR-2.2). Pure refactor — existing phase-naming tests must stay green.
3. Base-path resolution + validation (FR-1.3/1.4): relative resolves against
   `projectRoot`, absolute as-is; hard error if resolved base ===
   `projectRoot` or is inside `<projectRoot>/.git`.
4. Gitignore guard (FR-2.5): idempotent `mkdir -p` of the base dir + write
   `.gitignore` containing exactly `*\n` only when missing.
5. Naming + collision scan (FR-2.2/2.3): branch
   `impl/<shortName>-<implTimestamp>`, dir `<shortName>-<implTimestamp>`;
   run `git worktree prune` once; check branch via
   `git rev-parse --verify --quiet refs/heads/<branch>` and dir via
   `fs.existsSync`; paired `-2`…`-9` suffixes; exhaustion → hard error
   mentioning `git worktree list` / `git worktree prune`.
6. Creation (FR-2.4): resolve `baseCommit` =
   `git -C <triggeringCwd> rev-parse HEAD` first, then
   `git worktree add -b <branch> <absPath> <baseCommit>` executed at
   `projectRoot` via the existing `execGit` helper (NFR-5). Surface git
   stderr in the error result. Return the full `state.worktree` metadata
   object.
7. Setup-script runner (FR-3): `spawn("bash", ["-c", script], { cwd: worktreePath, env })`
   with `PI_WORKTREE_PATH`, `PI_WORKTREE_BRANCH`, `PI_MAIN_REPO`,
   `PI_IMPL_ID` merged over `process.env`; combined stdout+stderr capture;
   15-min timeout, SIGTERM then SIGKILL after 10 s (FR-3.5); full log written
   best-effort to `<projectRoot>/.pi/spec-pipeline/sessions/<implId>/setup-script.log`
   (FR-3.6, reuse `getSessionLogDir`); structured result
   `{ ok, exitCode, outputTail (~2000 chars), logPath }` — caller decides
   abort semantics (FR-3.4 handled in Phase 4). No-script case is the
   caller's skip (FR-3.7).
8. Resume helpers (consumed in Phase 4): `verifyWorktree(meta)` —
   `fs.existsSync(path)` AND `git -C <path> rev-parse --git-dir` succeeds AND
   `git -C <path> rev-parse --abbrev-ref HEAD` === branch (FR-5.3);
   `recreateWorktree(projectRoot, meta)` — `git worktree prune` then
   `git worktree add <path> <branch>` (no `-b`) (FR-5.4); branch-existence
   check for the hard-fail path.
9. `worktree.test.ts` (FR-7.1), real temp git repos following the
   `git.test.ts` pattern: naming/sanitization/truncation; collision `-2`
   pairing + `-9` exhaustion error; creation correctness (worktree exists,
   correct branch checked out, `HEAD` === triggering base commit); gitignore
   guard idempotency; relative vs absolute `basePath`; FR-1.4 rejections;
   setup script env vars + cwd + non-zero exit + output capture + timeout
   path (use a short injectable timeout for the test);
   `resolveProjectRoot` from inside a generated worktree returns the main
   repo root (also regression-covers FR-1.6 / NFR-3 config fallback).

**Exit criteria (verifiable):**
- `bun test` green, including all new `worktree.test.ts` cases above.
- `bun run typecheck` green.
- `grep -c "deriveShortName" implement-pipeline.ts` ≥ 1 and the old inline
  `replace(/^\d+_spec_/, ...)` chain is gone from `implement-pipeline.ts`
  (grep returns 0 matches there).
- Observable check in test: after creation in a temp repo,
  `git -C <mainRepo> worktree list` shows the new path+branch, and
  `git -C <worktree> rev-parse HEAD` equals the pre-creation `HEAD` of the
  triggering checkout.
- No production behavior change: `index.ts` untouched; nothing calls the new
  module yet except tests.

---

### Phase 3 — `PipelineRoots` plumbing (FR-4) — *hard*

**Files:** `implement-pipeline.ts`, `review.ts`, `errors.ts`,
`escalation.ts`, `agents.ts`, `index.ts` (call-site signature only),
`implement-pipeline.test.ts`, `errors.test.ts`, `review.test.ts` (signature
updates)

Work items:

1. `implement-pipeline.ts`:
   - Export `interface PipelineRoots { projectRoot: string; workRoot: string }`.
   - `runImplementPipeline(state, roots, projectConfig, ctx)` (FR-4.3);
     thread through `_runImplementPipelineInner`.
   - **workRoot:** `runAgentWithEscalation({ cwd })` for planDrafter and
     implementer; implementer no-op validation `getModifiedFiles(workRoot)`;
     `createAgentCommit(workRoot, ...)`; per-phase fallback
     `createCommit(workRoot, ...)`; `getModifiedFiles(workRoot)` in step 5.
   - **projectRoot:** `saveImplState(projectRoot, state)` (the `save`
     closure), `getSessionLogDir(projectRoot, state.id)`,
     `writeReviewLog(projectRoot, ...)`, `recordEscalation(projectRoot, ...)`.
2. `errors.ts` — `handleAgentError` splits its single `cwd` into both roots:
   `stashChanges`/`resetToHead` against `workRoot` (the destructive ops,
   FR-4.1); `appendErrorLog` under `projectRoot` (FR-4.2). Update all
   callers (`implement-pipeline.ts` ×2, `review.ts` ×3).
3. `review.ts` — `ReviewContext` carries both roots (replace `cwd`):
   reviewer/fix `runAgentWithEscalation` cwd and `createAgentCommit` use
   `workRoot`; `handleAgentError` gets both. `retryFailedOperation` takes
   both roots: `runAgentWithConfig(..., workRoot, ...)`,
   `getSessionLogDir(projectRoot, ...)`, `handleAgentError` both.
4. `escalation.ts` — `recordEscalation`'s first param is the **projectRoot**
   (escalations.log location); rename the param `cwd` → `projectRoot` for
   clarity; verify every caller passes the project root.
5. `agents.ts` — cache-diff samples (`.pi/spec-pipeline/cache-diffs`): keep
   keying the in-memory map by the `cwd` argument (the workRoot — per-run
   isolation is acceptable and consistent), but write diff files under
   `resolveProjectRoot(cwd)` so they land in the main repo (FR-4.2). This
   avoids threading a second root through `runAgentWithConfig`'s public
   signature.
6. `commit-agent.ts` — no signature change needed: `generateCommitMessage`'s
   `cwd` is the pi-subprocess cwd and callers now pass `workRoot` through
   `createAgentCommit`. `git.ts` itself is untouched (its `cwd` params
   simply receive `workRoot`).
7. `index.ts` — update the two `runImplementPipeline(state, cwd, ...)` call
   sites and the `retryFailedOperation(state, cwd, ...)` /
   `recordEscalation(cwd, ...)` call sites to pass
   `{ projectRoot: cwd, workRoot: cwd }` / both-roots-equal. **No worktree
   logic yet** — this phase is byte-for-byte behavior-equivalent (FR-4.3
   legacy mode).
8. Relocate config loading semantics: `loadPipelineConfig(ctx.cwd)` →
   `loadPipelineConfig(projectRoot)` (FR-4.4) — identical value in this
   phase since `projectRoot === ctx.cwd`.
9. Update existing tests that construct these signatures
   (`implement-pipeline.test.ts`, `review.test.ts`, `errors.test.ts`) to the
   new shapes; add one focused test asserting `handleAgentError` stashes in
   `workRoot` but writes the error log under `projectRoot` when the two
   differ (two temp dirs).

**Exit criteria (verifiable):**
- `bun test` green — all pre-existing tests pass with **no assertion-value
  changes** (only signature/call-shape updates allowed in test diffs); the
  new split-roots `handleAgentError` test passes.
- `bun run typecheck` green.
- `grep -rn "runImplementPipeline(state, cwd" index.ts` → 0 matches;
  `grep -n "PipelineRoots" implement-pipeline.ts index.ts review.ts` shows the
  type threaded through.
- Audit greps for missed work-ops: every `getModifiedFiles(`, `stageFiles(`,
  `createAgentCommit(`, `createCommit(`, `stashChanges(`, `resetToHead(`,
  `captureGitStatus(` call site in pipeline code receives `workRoot`; every
  `saveImplState(`, `getSessionLogDir(`, `appendErrorLog(`,
  `recordEscalation(` receives `projectRoot`. Record the audit as a checklist
  in the phase commit message.
- NFR-5 spot check: no new `child_process` usage outside `worktree.ts`'s
  setup-script spawn (`grep -rn "spawn(" *.ts` shows only the pre-existing
  sites + worktree.ts).

---

### Phase 4 — Command wiring: create, resume, UX (FR-2.6/2.7, FR-3.4/3.7, FR-5.3–5.7, FR-6)

**Files:** `index.ts`, `implement-pipeline.ts` (completion block),
`formatting.ts`, `errors.ts` (failure-message line), `formatting.test.ts`,
new/extended resume tests

Work items:

1. `/implement` handler (FR-2.7 ordering):
   1. existing validation (file, git repo, config) — config now loaded from
      `projectRoot = resolveProjectRoot(ctx.cwd)`; state ops
      (`getLatestActiveImplPipeline`, `saveImplState`) keyed to
      `projectRoot`;
   2. **replace** the `checkGitClean` hard error with a warning that
      uncommitted changes in the triggering checkout will NOT be included
      (FR-2.6);
   3. create + save initial state (unchanged);
   4. create worktree via Phase 2 module; on failure record
      `state.lastError` (no retryable `agentTask`), save, notify with git
      stderr, abort (FR-2.4);
   5. persist `state.worktree` metadata immediately (FR-5.1);
   6. run setup script if configured: abort on failure per FR-3.4 (notify
      exit code + last ~2000 chars, `errorType: "VALIDATION"`, no
      `agentTask`, worktree kept, `setupScriptRan` stays `false`); on
      success or no-script set `setupScriptRan = true` and save (FR-3.7);
   7. `runImplementPipeline(state, { projectRoot, workRoot }, ...)`.
   - Reword the "Active Implementation Found" confirm to the parallel-runs
     informational prompt (FR-5.7).
2. `/implement-resume` (FR-5.3–5.6):
   - resolve `projectRoot`, load state from there;
   - **legacy branch** (`state.worktree` undefined): `workRoot = projectRoot`,
     keep today's dirty-tree hard error and stash cleanup exactly as-is
     (FR-5.6/NFR-1);
   - worktree branch: `verifyWorktree`; on failure → if branch exists,
     prune + `recreateWorktree`, reset `setupScriptRan = false` (FR-5.4); if
     branch gone → hard error directing to a fresh `/implement` (state kept);
   - move `checkGitClean` + `stashExists`/`dropStash` to `workRoot` (FR-5.3);
   - if `setupScriptRan === false` and a script is configured → re-run it
     before the pipeline; success clears the setup-script `lastError`
     (FR-5.5);
   - existing `retryFailedOperation` path passes both roots.
3. UX (FR-6):
   - completion block in `implement-pipeline.ts`: `Branch:`/`Worktree:`
     lines + next-steps (cd, `git merge <branch>` / PR,
     `git worktree remove <path>` then `git branch -d <branch>`) when
     `state.worktree` is set (FR-6.2);
   - `handleAgentError` notification includes the worktree path when
     available (FR-6.3) — thread via state (`state.worktree?.path`), not a
     new param;
   - `formatImplState` in `formatting.ts`: `Branch:`/`Worktree:` lines under
     the Git section when set (FR-6.4) → also covers `/implement-status`;
     add the same lines to the `/implement-list` per-state block;
   - `/implement-cancel` message mentions the worktree is kept and resumable
     (FR-6.5).
4. Tests:
   - `formatting.test.ts`: `formatImplState` with/without `state.worktree`.
   - Resume-decision unit tests (extend `pipeline-resume.test.ts` or a new
     file) against real temp repos: legacy state → roots equal + dirty-tree
     error preserved; worktree intact → re-attach; directory deleted +
     branch alive → recreate restores prior commits and flags setup re-run;
     branch deleted → hard error. (Test the extracted decision/helper layer,
     not the interactive handler.)

**Exit criteria (verifiable):**
- `bun test` green; `bun run typecheck` green.
- `grep -n "checkGitClean" index.ts`: in the `/implement` handler the result
  no longer triggers an early `return` (warning only); in
  `/implement-resume` it is applied to `workRoot` on the worktree path and to
  `projectRoot` only in the legacy branch.
- Scripted smoke check (manual or throwaway script in a temp repo): trigger
  the creation sequence (steps 3–6 factored to be callable for the check) in
  a scratch git repo with one commit and a dirty file → asserts: worktree
  created under `.pi/worktrees/<shortName>-<ts>` on branch `impl/...` at the
  pre-existing `HEAD`; `.pi/worktrees/.gitignore` contains `*`;
  `git -C <repo> status --porcelain` output is unchanged (dirty file intact,
  no new noise); `state.json` under the main repo contains the worktree
  metadata with `setupScriptRan: true` (no script configured).
- Completion/failure message snapshots include `Branch:` and `Worktree:`
  lines (assert via the formatting tests).

---

### Phase 5 — Isolation regression, resume tests, docs (FR-7.2, FR-7.4, FR-7.5, NFR-6)

**Files:** new `worktree-isolation.test.ts` (or extension of
`worktree.test.ts`), `pipeline-resume.test.ts`, `README.md`,
`skills/implement-pipeline/SKILL.md`, `DIRTY_TREE_SUPPORT.md`, `index.ts`
header comment

Work items:

1. **Isolation regression test (FR-7.2 / FR-4.5):** in a temp repo, create a
   worktree via the Phase 2 module, run the real commit path
   (`createAgentCommit` and/or `createCommit` with `cwd = workRoot`,
   commit-message generation stubbed to the fallback path so no `pi`
   subprocess is needed), plus a `handleAgentError` stash/reset cycle in the
   worktree; assert the triggering checkout's branch ref
   (`git rev-parse <origBranch>`), `git status --porcelain` output, and a
   sample dirty file's bytes are identical before and after; assert the new
   commits exist only on `impl/...`.
2. **Resume recreation test (FR-7.4 second half):** delete the worktree
   directory, run the recreate helper, assert prior worktree commits are
   restored at the same path and branch.
3. **Docs (FR-7.5):**
   - `README.md` configuration section: `worktree` settings with an example
     `setupScript` using `$PI_MAIN_REPO` / `$PI_WORKTREE_PATH`; lifecycle +
     manual cleanup commands; note that cleanup is manual in v1 (FR-6.1).
   - `index.ts` header comment: `/implement` runs in an isolated worktree.
   - `skills/implement-pipeline/SKILL.md`: isolated-worktree behavior, where
     results land, merge/cleanup steps.
   - `DIRTY_TREE_SUPPORT.md`: implementation pipeline no longer requires a
     clean *user* checkout; the clean-tree requirement applies to the
     worktree (resume path); destructive ops run inside the worktree
     (FR-2.6).
4. Final verification sweep (NFR-6).

**Exit criteria (verifiable):**
- `bun test` green — full suite including isolation + recreation tests
  (expect meaningfully > 326 tests total by now).
- `bun run typecheck` green.
- Isolation test's specific assertions pass: triggering branch ref unchanged,
  `git status --porcelain` byte-identical, pipeline commits present only on
  the `impl/` branch.
- `grep -n "worktree" README.md skills/implement-pipeline/SKILL.md DIRTY_TREE_SUPPORT.md` —
  all three documents updated; `DIRTY_TREE_SUPPORT.md` no longer claims
  `/implement` requires a clean user tree.
- Spec cross-check: walk FR-1…FR-7 and NFR-1…NFR-6 against the diff; each FR
  maps to at least one test or grep above.

---

## 5. Risks & Watch Items

| Risk | Phase | Mitigation |
|---|---|---|
| `handleAgentError` root-split is easy to get half-wrong (stash in projectRoot would mutate the user's tree — the exact bug this spec exists to kill) | 3 | Dedicated two-temp-dirs test (P3 item 9); audit-grep checklist in exit criteria |
| Missed call site keeps writing state/logs into the worktree (lost on cleanup) | 3 | Audit greps in P3 exit criteria; P5 isolation test asserts no `.pi/spec-pipeline` noise appears in the worktree's `git status` |
| `agents.ts` cache map keyed by workRoot makes cache-diff comparisons per-run instead of per-project | 3 | Accepted trade-off (spec allows either); diff files themselves land under projectRoot — assert path in a test |
| Setup-script timeout test flakiness (15-min default) | 2 | Injectable timeout for tests; never sleep-based asserts on real default |
| `resolveMainRepoFromWorktree` path parsing on absolute `gitdir` lines | 1–2 | Covered by the FR-7.1 `resolveProjectRoot`-from-inside-worktree test against a real generated worktree |
| Legacy resume regression (NFR-1) | 4 | Explicit legacy-branch test: no `worktree` metadata → identical dirty-tree hard error and `workRoot === projectRoot` |
| Test files import from `"vitest"` but run under `bun test` | all | Established repo pattern — keep new tests consistent with `git.test.ts` |

## 6. Out of Scope (restated from spec §2.2)

No auto-cleanup or `/implement-clean`, no auto-merge, no `--no-worktree`
opt-out, no changes to phase extraction/review/escalation logic or the agent
subprocess protocol, no port/env orchestration beyond the setup-script hook,
no Windows work beyond `bash -c`.
