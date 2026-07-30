# Feature Checkpoint Skill

## When to use

Invoke with `/feature-checkpoint` **from inside a feature worktree** (`../ETM-<name>` or
`../TRM-<name>`, on branch `feat/<name>`) to save progress and re-sync onto the latest
`master` **without merging**. Use it whenever you want a clean, up-to-date base mid-feature.
Your work stays isolated on the branch; nothing lands on `master`, and the dev servers keep
running so you can keep working immediately afterward.

This is the **sync-only** counterpart to `/feature-complete` (which merges + tears down).

**Project-aware:** this worktree is either ETM or TRM. Detect which from the repo
(the web package name — `@mps/web` for NG, `@mps-trm/web` for TRM) and use the matching
package filter below. TRM has **no API package**, so skip any `@mps/api` step there.

## Steps

1. **Sanity-check the branch.** Confirm you're in a feature worktree on a `feat/*` branch
   (`git branch --show-current`). If you're on `master` or in the main checkout, STOP —
   this skill is only for feature worktrees.

2. **Review and commit.** Inspect the diff (`git status`, `git diff`), then stage and
   commit. Write a real commit message describing what changed (use any message the user
   passed as an argument as the subject, otherwise craft one). End the commit body with:
   ```
   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   ```

3. **Ensure the push account, then push the branch:**
   ```bash
   gh auth switch --user etsmalterre
   git push -u origin HEAD
   ```

4. **Rebase onto the latest master:**
   ```bash
   git fetch origin
   git rebase origin/master
   ```
   - **If there are conflicts:** resolve them here — you have this screen's full context.
     Edit the conflicted files, `git add` them, then `git rebase --continue`. Repeat until
     done. Prefer keeping BOTH sides on additive "registry" files (e.g.
     `apps/api/src/lib/permission-keys.ts`, `apps/web/src/config/navigation.ts`,
     `router.tsx`, `index.ts`).
   - **If it gets out of hand:** `git rebase --abort`, tell the user, and stop.

5. **Re-push the rebased branch** (history was rewritten):
   ```bash
   git push --force-with-lease
   ```

6. **Quick gate (optional but recommended):** typecheck the web package so you know the
   rebase didn't break types — `pnpm --filter @mps/web exec tsc --noEmit` (NG) or
   `pnpm --filter @mps-trm/web exec tsc --noEmit` (TRM).

7. **Report.** Confirm: committed, pushed, rebased on `origin/master`, servers still up,
   still on `feat/<name>`. Show `git log --oneline -3`. Do **not** touch `master`.
