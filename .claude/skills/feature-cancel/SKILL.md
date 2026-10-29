---
name: feature-cancel
description: Cancel a feature worktree that is no longer needed, without landing anything (stop its servers, delete the worktree and its branch, close its Herdr tab and Claude session). USER-ONLY: run only when Vincent types /feature-cancel.
disable-model-invocation: true
---

# Feature Cancel Skill

## Only when the user types it

Only Vincent typing `/feature-cancel` starts this (the frontmatter sets
`disable-model-invocation`). It is the opposite of `/feature-complete`: **nothing lands on
`master`**, the worktree's work is thrown away.

## When to use

A worktree was created with `/new-feature-worktree` and is finally not needed. Run it:
- **from inside that worktree's session** (the usual case): `/feature-cancel`;
- or from any other session with the name: `/feature-cancel <feature-name>` (ETM, TRM or
  the console, the registry knows which).

## Steps

1. **Resolve the target.** With an argument, it is that feature. Without, it is the
   current worktree: `git branch --show-current` must be `feat/<name>` and the cwd must be
   `../ETM-<name>` or `../TRM-<name>`. If neither resolves (you are in a main checkout on
   `master` and no name was given), STOP and ask which worktree. Never cancel `master` or a
   main checkout.

2. **Look for work that would be lost** (read-only), in the worktree dir `<W>`:
   ```bash
   git -C <W> status --porcelain                         # uncommitted / untracked
   git -C <W> fetch -q origin
   git -C <W> log --oneline origin/master..HEAD          # commits not on master
   ```
   Also check for a **paired worktree** of the same name in the other project (`../ETM-<name>`
   and `../TRM-<name>`): `node scripts/worktree/status.mjs` lists the slots.

   - **Nothing found** (clean, no commit beyond `origin/master`): go on, no question. That is
     the normal case: a worktree created and never used.
   - **Something found**: show it in one short message (the `status` lines and the commit
     subjects) and ask ONE confirmation, « Tout supprimer quand même ? ». Proceed only on a
     clear yes. Never stash, push or « save somewhere » on your own: cancel means discard.
     If Vincent wants to keep the work, stop and point to `/feature-complete` or to
     `node scripts/worktree/down.mjs <name>` (pause: servers off, worktree kept).

3. **Tear down**, from the ETM main checkout (the worktree scripts live there, and they
   resolve a TRM worktree from the registry):
   ```bash
   cd <ETM main checkout> && node scripts/worktree/down.mjs <name> <ng|trm|admin> --remove
   ```
   It stops the slot's API + web, frees the slot, deletes the worktree dir, the local branch
   and `origin/feat/<name>` if it was pushed, and inside Herdr closes the worktree's tabs.
   For the calling tab, a detached helper waits for this session to go idle, submits
   `/exit`, then closes the tab about 5 s later. A dir still locked by a terminal is
   **deferred** and reaped automatically by the next worktree skill.
   Always pass the project: a paired worktree shares the feature name, and `down.mjs`
   refuses a name that matches several slots. A paired worktree confirmed in step 2: run
   the same command for it too, with its own project.

4. **Report in two lines, as the LAST thing this session does** (no tool call after it:
   the session quits right after the report inside Herdr): what was deleted (worktree, slot,
   branch local/remote), whether the dir removal was deferred, and that nothing landed on
   `master`.
