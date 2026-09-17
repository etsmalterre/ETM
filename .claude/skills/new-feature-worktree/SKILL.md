# New Feature Worktree Skill

## When to use

Invoke with `/new-feature-worktree <feature-name> [ng|trm]` to start work on a new
screen/feature in an isolated git worktree with its own local dev stack on a dedicated
port slot. Run this from the **ETM main checkout** (`C:\dev\etsmalterre\ETM`, which
stays on `master`). The **project** defaults to `ng`; pass `trm` to spin up an TRM
worktree instead. Up to 6 worktrees per project can run at once.

`<feature-name>` is kebab-case (e.g. `clients-commandes`). It produces:

**`ng` (ETM — API + web):**
- branch `feat/<feature-name>`, worktree dir `../ETM-<feature-name>`
- lowest free slot N (1–6) → API on `808N`, web on `300N`

**`trm` (TRM — web only):**
- branch `feat/<feature-name>`, worktree dir `../TRM-<feature-name>`
- lowest free slot N (1–6) → web on `517N` (no API of its own)
- The TRM web server talks to an **MPS API over HTTP**. By default it targets the
  slot-0 master API on `:8080` (start it with `/serve-main`). To point it at a different
  MPS API (e.g. a running NG worktree's `808N`), pass `--api <port>`.

The two projects have **disjoint port ranges**, so an NG slot and a TRM slot with the
same number never collide (NG `300N`/`808N`, TRM `517N`).

## Background

Slot model and merge flow are documented in `claude_doc/worktrees.md`. The heavy
lifting (project resolution, slot allocation, worktree creation, `pnpm install`,
env/secrets copy, starting the detached dev servers, health checks, registry
bookkeeping) is done by `scripts/worktree/up.mjs`. The registry lives at
`~/.claude/mps-worktrees.json` (shared across both projects; TRM entries are keyed
`trm:N`, NG entries stay bare `N`).

## Steps

1. **Validate the arguments.** If no feature name was given, ask for one. It must match
   `^[a-z0-9][a-z0-9-]*$` (kebab-case). Reject names with spaces/uppercase/slashes. The
   optional project must be `ng` (default) or `trm`.

2. **Run the spin-up script** from the ETM main checkout:
   ```bash
   node scripts/worktree/up.mjs <feature-name> [ng|trm] --terminal [--app atelier|trs] [--api <port>]
   ```
   This fetches origin (in the target repo — TRM is resolved as the sibling checkout
   for `trm`), allocates a free slot, creates the worktree off `origin/master`, installs
   deps, and:
   - **ng**: writes a CORS-correct `apps/api/.env.development`, copies `secrets/`, starts
     the API (`dev:808N`) and web (`dev:300N`) detached.
   - **trm**: writes `.env.development.local` for the three apps (`VITE_API_URL` → the chosen
     ETM API, plus the tab label), starts ONE web server on `517N` detached — the ERP by
     default, or the PWA named by `--app atelier` / `--app trs`. The TRM skill infers the app
     from the session's cwd (`apps/atelier` → atelier); from here, pass it when the feature is
     for a PWA.

   Logs → `<worktree>/.dev-logs/`; slot + PIDs recorded in the registry.

3. **Read the script's summary** (project, slot, branch, worktree path, URLs, log paths).
   If it reports a server "NOT UP", tail the named log before declaring success:
   ```bash
   tail -n 40 ../ETM-<feature-name>/.dev-logs/web.log      # or TRM-<name>
   tail -n 40 ../ETM-<feature-name>/.dev-logs/api.log      # ng only
   ```
   For **trm**, if the summary says the MPS API isn't reachable, tell the user to run
   `/serve-main` (master on `:8080`) — the TRM web will 404 its API calls until then.

4. **Report to the user** the project, worktree path, the web URL (`http://localhost:300N`
   for ng, `http://localhost:517N` for trm), the slot number, and which terminal now carries
   the feature (the script's `wt-slot:` line). That session will use `/feature-checkpoint`
   to sync and `/feature-complete` to land it.
   **End the report with the dev link alone on its last line** (`http://localhost:300N` /
   `517N`), not inside a bullet or a sentence: the user opens it from there.

   **The session opens by itself.** `--terminal` hands the worktree to one of the six
   Windows Terminal windows of the 2x3 grid whose title is exactly « free »: that window is
   replaced on the same spot by one titled after the feature, running the context launcher
   (`yolo-ets` under `C:\dev\etsmalterre`, `yolo-liva` under `C:\dev\liva`) in the
   worktree. When Claude exits there, the window turns back into a « free » one. The
   mechanics live in `C:\dev\claude_config\bin\wt-slot.ps1` (`list` / `claim` / `free` /
   `layout`). No « free » window (all six busy, or the grid not open) → the script says so
   and the user opens the session by hand; a « busy » title means someone is typing there.

   **On Linux inside Herdr** (`HERDR_ENV=1` in the session) the same `--terminal` opens the
   worktree as a **new tab of the repo's Herdr space**, named after the feature (one space
   per repo, one tab per worktree), and runs the launcher in that tab's shell without
   stealing focus. The script prints `terminal: Herdr tab « <feature> » (wN:tM) in space wN …`.
   The sidebar's agent row then reads « ETM · <feature> », with the current task and the
   web URL under it — both reported by the Claude SessionStart / UserPromptSubmit hook
   (`claude_config/config/hooks/task-line.mjs`), which also names a hand-opened, still
   numbered tab after its worktree folder. `prefix+u` in any pane of the worktree opens
   its web app (`claude_config/bin/herdr-open-dev.sh`). A `NOTE: could not open a Herdr
   tab` means the socket call failed: open a tab (`prefix+c`) in the worktree and run the
   launcher by hand.

   **On Linux outside Herdr (Omarchy / Hyprland) there is no grid.** The same `--terminal` opens a new
   terminal window on the **current workspace**, titled after the feature, cwd'd in the
   worktree and running the same launcher (`yolo-ets` / `yolo-liva`, the bash functions from
   `claude_config/bin/launchers.sh` that `~/.bashrc` sources — hence `bash -ic`). When Claude
   exits the shell stays open. Mechanics: `setsid uwsm-app -- xdg-terminal-exec --title=…
   --dir=…` (what `omarchy-launch-terminal` does), in the Linux branch of `up.mjs`. The
   script prints `terminal: new « <feature> » window …`; a `NOTE: --terminal ignored` means
   `xdg-terminal-exec` is missing — open a terminal in the worktree and run the launcher.

## Notes / failure modes

- "All 6 … slots are in use" → run `/worktree-status`; finish or `/feature-down` one of
  that project's worktrees before creating another.
- "Branch already exists" / "Worktree dir already exists" → the script aborts to avoid
  clobbering in-progress work. If you meant to **resume** that tree (its servers died,
  e.g. after a reboot), restart it in place — this keeps the slot, ports and env:
  ```bash
  node scripts/worktree/up.mjs <feature-name> [ng|trm] --restart
  ```
  Otherwise pick a different name, or clean up the old one with `/feature-complete`
  (if mergeable) or `node scripts/worktree/down.mjs <name> --remove`.
- **Reusing the name of a feature that already shipped** → allowed, but the script now
  says `NOTE: origin/feat/<name> already exists and is merged`. A worktree path is derived
  from the feature name, so a name reused across sessions rebuilds the *same* directory —
  which is how, on 2026-07-30, two freshly created worktrees were deleted by a later
  `/worktree-status`: a concurrent `/feature-complete` had queued that exact path for
  deferred removal, and the reaper matched the new tree. `reapPending()` now refuses to
  delete any path a live registry slot claims (and `up.mjs` voids the stale entry when it
  recreates the path), so this is fixed rather than merely documented — but if the NOTE
  appears and you did **not** mean to continue that feature, use a fresh name anyway: two
  unrelated features sharing a branch name makes the merge log unreadable.
- **API "UP" but every screen hangs on a loading spinner** → the API is listening but its
  HFSQL connection is wedged. The spin-up summary now catches this itself
  (`HFSQL : UNREACHABLE — …`); check by hand with
  `curl "http://localhost:808N/api/health?db=1"`, and recover with `--restart`.
- The dev servers are **detached** — they keep running after this Claude session ends,
  which is the point. They are stopped by `/feature-complete` or `/feature-down`.
- **TRM worktrees need an MPS API running** (master via `/serve-main`, or an NG worktree
  via `--api 808N`). They have no API of their own.
- **TRM feature needing shared-API changes** → spin up a **paired NG worktree** with the
  same feature name for the API work, and pass `--api 808N` to the TRM worktree so it talks
  to that API. Never edit the API in this main checkout. Landing order: NG branch first,
  then TRM. See `claude_doc/worktrees.md` §"Shared-API changes".
- Do NOT do feature work in the main checkout; it is the integration tree on `master`.
