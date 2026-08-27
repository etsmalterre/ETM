# Feature Complete Skill

## When to use

Invoke with `/feature-complete` **from inside a feature worktree** (`../ETM-<name>` or
`../TRM-<name>`, on branch `feat/<name>`) when a screen is finished and ready to land.
It commits, rebases onto `master` (resolving conflicts with this screen's context),
fast-forward-merges into `master`, then shuts down this slot's dev servers, removes the
worktree, and deletes the branch.

Deploy is a **separate** step — after this completes, run `/etm_deploy` or `/trm_deploy` (whichever matches this worktree) if you want to ship.

The merge is always a clean fast-forward because we rebase first. Conflicts are resolved
HERE (you have the context), so `master` only ever sees a fast-forward.

## Run it end to end — no process questions

`/feature-complete` is a **finish** command. What the user is buying is: branch merged into
`master`, dev servers stopped, worktree and branch gone, nothing left to decide. Run the
whole sequence and report once, at the end. Stopping mid-run to ask which option they prefer
costs them the exact thing the command exists to buy — and the rules below already hold the
answer.

**Decide it yourself and keep going** for: untracked or unrelated files that can't affect
this feature, whether anything durable goes into `CLAUDE.md`, a `CLAUDE.md` over budget, a
typecheck error you can fix, a rebase conflict (you have this screen's context — resolve it),
a worktree dir Windows won't delete yet (defer it, it self-reaps).

**Stop only when continuing could lose work or ship something broken** — and then say exactly
what you need, in one message:
- not in a worktree / not on a `feat/*` branch — wrong place, there is nothing to land;
- `<MAIN>` holds uncommitted work that isn't yours — merging could clobber it;
- unlanded API **endpoint** code this feature needs that the recipe below can't land for you;
- a typecheck failure you can't fix without a decision about how the feature should behave.

Deploy is never part of this — `/feature-complete` lands, `/etm_deploy` and `/trm_deploy` ship.


## Project-aware

This worktree is either **ETM** or **TRM**. Detect which from the repo (web package
name — `@mps/web` for NG, `@mps-trm/web` for TRM) and substitute throughout:

| | ETM | TRM |
|---|---|---|
| Main checkout | `C:\dev\etsmalterre\ETM` | `C:\dev\etsmalterre\TRM` |
| Web package | `@mps/web` | `@mps-trm/web` |
| API package | `@mps/api` | *(none — skip API steps)* |
| Merge-log file | `claude_doc/worktree-merge-log.md` | *(none — skip if absent)* |

Below, **`<MAIN>`** = the main checkout for this project. Get it programmatically with
`git rev-parse --git-common-dir` (its parent dir is `<MAIN>`).

## Preconditions

- You are in a feature worktree on a `feat/*` branch (NOT the main checkout / `master`).
- `<MAIN>` is on `master` with a clean working tree. (The `apps/api/tsconfig.tsbuildinfo`
  gitignore keeps it clean across builds — if `git -C <MAIN> status --porcelain` is
  non-empty, that is one of the few genuine stops — see "Run it end to end". Never force past it.)
- **TRM only — shared-API guardrail.** A TRM feature's endpoints live in the **MPS API**
  (`C:\dev\etsmalterre\ETM\apps\api`), not in this repo. Before landing, check whether
  API work for this feature is still unlanded:
  ```bash
  git -C C:/dev/etsmalterre/ETM status --porcelain -- apps/api
  ```
  **Non-empty is not by itself a reason to stop — classify what it prints.** The only thing
  that can strand a half-shipped feature is code the running server serves:

  | Path | Verdict |
  |---|---|
  | `src/routes/`, `src/lib/`, `src/index.ts`, `src/middleware*`, `apps/api/package.json`, `apps/api/data/` | **Blocking** — the screen may call an endpoint that isn't landed |
  | `src/scripts/**` | **Not blocking** — dev-only probes/seeds/checks. Never imported by the server, never called by the web, so they cannot strand anything. Leave them alone; one line in the final report. |
  | build output, `*.tsbuildinfo`, `.env*`, `.dev-logs/` | **Not blocking** — ignore silently |

  *(2026-08-27: a run halted to ask what to do about an untracked
  `src/scripts/seed-visitage-pieces.ts` — a dev-only seed that could not have stranded
  anything. Classify and proceed; don't re-litigate this case.)*

  If the feature's API changes live in a **paired NG worktree**, land that one FIRST — drive
  its landing from here by path (steps 3–6 against `../ETM-<name>`), then land this TRM branch.

  **Blocking entries in the ETM main checkout — land them, don't ask.** Loose edits in the
  integration tree still have to reach `master` through ETM's own pipeline, so move them into
  a paired NG worktree and land that first:
  ```bash
  # 1. capture (the stash is recoverable, and stays the only copy until step 5)
  git -C C:/dev/etsmalterre/ETM stash push -u -m "api for <name>" -- apps/api
  # 2. paired NG worktree  → ../ETM-<name>-api on feat/<name>-api
  node C:/dev/etsmalterre/ETM/scripts/worktree/up.mjs <name>-api ng
  # 3. worktrees share refs/stash, so the stash applies straight into it
  git -C C:/dev/etsmalterre/ETM-<name>-api stash apply stash@{0}
  # 4. commit there, then run steps 3–6 below against that worktree (land on ETM master)
  # 5. ONLY once it is merged:
  git -C C:/dev/etsmalterre/ETM stash drop
  ```
  **Never drop the stash before the changes are committed on the NG branch** — it is the only
  copy. Then land this TRM branch as usual, and note in the report that the API must deploy
  **before or with** the TRM web (`/etm_deploy` first, then `/trm_deploy`).

## Shared-API changes (TRM features)

TRM is frontend-only; its endpoints are part of the MPS API. The rule:
**API changes always flow through ETM's own pipeline — worktree → `feat/*` branch →
NG `master` → `/etm_deploy` — regardless of which frontend consumes them.**

For a TRM feature that needs API work, the setup is a **pair of worktrees**:
- an NG worktree (`../ETM-<name>`) holding the API changes, and
- this TRM worktree (`../TRM-<name>`) holding the screen, spun up with
  `--api 808N` pointing at the NG worktree's API.

Landing order: **NG branch first** (its API lands on NG `master`), then the TRM branch.
Deploys are separate per repo: `/etm_deploy` (from the ETM checkout) ships the API (+ NG web);
`/trm_deploy` (from the TRM checkout) ships the TRM web. When a feature spans both, the API deploy runs **first**.

## Steps

1. **Confirm the branch.** `git branch --show-current` must be `feat/<name>`. If not, STOP.

2. **Promote the durable learnings, then write the note + final commit.**

   **2a — update `CLAUDE.md` (the rules sheet).** Review the full diff and ask: what must a
   *future* session know that it could not infer from reading the code? Add only that, editing
   the `CLAUDE.md` **in this worktree**, so the rule lands with the feature instead of arriving
   later as a stray commit on `master`. Typical entries:
   - a new HFSQL quirk or footgun → § HFSQL rules
   - a screen now implemented → § Navigation Structure (route, layout, tables it touches)
   - a new API route, convention, or architecture decision
   - a **systemic** bug fixed → record the *pattern*, so it is not repeated

   Rules: durable only — the blow-by-blow of this feature belongs in the merge log, not here;
   one or two lines per item; match the surrounding formatting; **never delete a rule the user
   added** (those encode real incidents). Nothing durable came out of this feature? Skip 2a and
   say so in the report — that is a normal outcome, not a failure.

   **2b — keep `CLAUDE.md` lean.** It is loaded into context on *every* session, so its size is
   a permanent tax. Measure after editing:
   ```bash
   wc -l CLAUDE.md && wc -c CLAUDE.md
   ```
   Under **20 KB** is healthy. Over it, still add your line — **never block the landing on
   file size** — but flag the overage in step 8 and offer the extraction. The fix is nearly
   always the same shape: a section longer than ~15 lines covering one subsystem moves to
   `claude_doc/<topic>.md` and leaves a one-line row in the "Reference Documentation" table
   ("load on demand when…"). Also worth hunting: the same rule stated in two places, phase
   notes for completed phases, references to deleted files. **Never relocate content mid-landing** — finish the
   merge, then offer the extraction in the step-8 report.

   *Known state (2026-07-30):* ETM's `CLAUDE.md` is ~53 KB and needs a dedicated extraction
   pass; TRM's is ~11 KB and healthy. Until that pass happens, ETM will report over budget
   every time — mention it once, don't re-litigate it.

   **2c — the note + commit.** Craft a thorough summary of what this screen does — this is the
   **note**, used as the merge-commit message. If the project has a merge log
   (`claude_doc/worktree-merge-log.md` — NG only), prepend a dated entry (newest first). Commit
   any remaining work plus the log entry and any `CLAUDE.md` edits on the branch. End the commit
   body with:
   ```
   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   ```

3. **Push the branch** (ensure the account first):
   ```bash
   gh auth switch --user etsmalterre
   git push -u origin HEAD
   ```

4. **Rebase onto the latest master, resolving conflicts here:**
   ```bash
   git fetch origin
   git rebase origin/master
   ```
   On conflict: edit, `git add`, `git rebase --continue` (keep BOTH sides on additive
   registry files; for `claude_doc/worktree-merge-log.md` keep every entry). Then:
   ```bash
   git push --force-with-lease
   ```

5. **Typecheck gate — do not merge broken code.**
   ```bash
   pnpm --filter @mps/web exec tsc --noEmit        # (or @mps-trm/web on TRM) — MUST be clean
   pnpm --filter @mps/api exec tsc --noEmit        # NG only — only the 7 known baseline errors
   ```
   On NG the API has 7 pre-existing baseline errors in `src/lib/hfsql.ts` + `src/scripts/*`;
   the gate passes if web is clean AND no API error references a file you changed. On TRM there
   is no API package, but the web typecheck has **2 pre-existing baseline errors** (implicit-any
   in `Header.tsx` + `MobileNav.tsx`) — the gate passes if the only errors are those two AND
   none reference a file you changed. If anything else fails, fix it before continuing.

6. **Fast-forward merge into master, from the main checkout (`<MAIN>`):**
   ```bash
   git -C <MAIN> fetch origin
   git -C <MAIN> status --porcelain          # must be empty — else stop & resolve
   git -C <MAIN> merge --ff-only origin/master
   git -C <MAIN> merge --ff-only feat/<name>
   git -C <MAIN> push origin master
   ```
   - If `merge --ff-only feat/<name>` **fails** (another feature landed on master between your
     rebase and now), re-run step 4 (`git fetch && git rebase origin/master && git push
     --force-with-lease`) then retry step 6. The `--ff-only` guard is intentional — it refuses
     to create a tangled merge.

7. **Tear down** — run from the main checkout dir (`<MAIN>`):
   ```bash
   cd <MAIN> && node scripts/worktree/down.mjs <name> --remove
   ```
   (The worktree scripts live in the **ETM** checkout. For a TRM worktree, run the script
   from ETM — it resolves the TRM repo from the registry entry — i.e.
   `cd /c/dev/etsmalterre/ETM && node scripts/worktree/down.mjs <name> --remove`.)
   This stops the slot's API + web process trees, frees the slot, and removes the worktree +
   branch. **Expected on Windows:** because this very session (and your terminal) is still
   cwd'd inside the worktree, the OS won't let the directory be deleted — so the script
   **defers** the dir/branch removal to a pending queue and prints a NOTE. That's fine: the
   merge is already done and the slot is freed. The leftover dir is reaped **automatically**
   the next time any worktree skill runs from the main checkout (or `node
   scripts/worktree/reap.mjs` there after you close this session).

8. **Report.** Confirm: merged to `master` (show `git -C <MAIN> log --oneline -3`) and
   slot freed. State what went into `CLAUDE.md` in step 2a (or that nothing durable came up),
   and flag it if the file is over its size budget.
   State whether the worktree dir was removed now or deferred (per the script's
   output). Tell the user to **close this Claude session / terminal** — the work is on `master`,
   and any deferred dir cleans itself up on the next worktree skill. Shipping is a separate
   `/etm_deploy` (or `/trm_deploy`) from the main checkout.
