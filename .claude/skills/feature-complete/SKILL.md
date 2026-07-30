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
  non-empty, resolve that first; do not force past it.)
- **TRM only — shared-API guardrail.** A TRM feature's endpoints live in the **ETM API**
  (`C:\dev\etsmalterre\ETM\apps\api`), not in this repo. Before landing, check whether
  API work for this feature is still unlanded:
  ```bash
  git -C C:/dev/etsmalterre/ETM status --porcelain -- apps/api
  ```
  - If this is **non-empty**, someone edited the API in the NG **main checkout** — STOP and
    tell the user. Those edits must land via a **paired NG worktree** (see "Shared-API
    changes" below), never as loose edits in the integration tree. Landing the TRM web
    branch while its API is uncommitted would strand the feature half-shipped.
  - If the feature's API changes live in a **paired NG worktree**, land that one FIRST
    (run `/feature-complete` there), then land this TRM branch.

## Shared-API changes (TRM features)

TRM is frontend-only; its endpoints are part of the ETM API. The rule:
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
   notes for completed phases, references to deleted files. **Propose any non-trivial
   extraction before doing it** — never silently relocate content the user relies on.

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
