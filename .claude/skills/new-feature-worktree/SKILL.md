# New Feature Worktree Skill

## When to use

Invoke with `/new-feature-worktree <feature-name> [ng|trm]` to start work on a new
screen/feature in an isolated git worktree with its own local dev stack on a dedicated
port slot. Run this from the **ETM main checkout** (`C:\dev\etsmalterre\ETM`, which
stays on `master`). The **project** defaults to `ng`; pass `trm` to spin up an MPS-TRM
worktree instead. Up to 6 worktrees per project can run at once.

`<feature-name>` is kebab-case (e.g. `clients-commandes`). It produces:

**`ng` (ETM — API + web):**
- branch `feat/<feature-name>`, worktree dir `../ETM-<feature-name>`
- lowest free slot N (1–6) → API on `808N`, web on `300N`

**`trm` (MPS-TRM — web only):**
- branch `feat/<feature-name>`, worktree dir `../MPS-TRM-<feature-name>`
- lowest free slot N (1–6) → web on `517N` (no API of its own)
- The TRM web server talks to an **ETM API over HTTP**. By default it targets the
  slot-0 master API on `:8080` (start it with `/serve-main`). To point it at a different
  ETM API (e.g. a running NG worktree's `808N`), pass `--api <port>`.

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
   node scripts/worktree/up.mjs <feature-name> [ng|trm] [--api <port>]
   ```
   This fetches origin (in the target repo — MPS-TRM is resolved as the sibling checkout
   for `trm`), allocates a free slot, creates the worktree off `origin/master`, installs
   deps, and:
   - **ng**: writes a CORS-correct `apps/api/.env.development`, copies `secrets/`, starts
     the API (`dev:808N`) and web (`dev:300N`) detached.
   - **trm**: writes `apps/web/.env.development.local` (`VITE_API_URL` → the chosen ETM
     API, plus the tab label), starts web only (`dev:517N`) detached.

   Logs → `<worktree>/.dev-logs/`; slot + PIDs recorded in the registry.

3. **Read the script's summary** (project, slot, branch, worktree path, URLs, log paths).
   If it reports a server "NOT UP", tail the named log before declaring success:
   ```bash
   tail -n 40 ../ETM-<feature-name>/.dev-logs/web.log      # or MPS-TRM-<name>
   tail -n 40 ../ETM-<feature-name>/.dev-logs/api.log      # ng only
   ```
   For **trm**, if the summary says the ETM API isn't reachable, tell the user to run
   `/serve-main` (master on `:8080`) — the TRM web will 404 its API calls until then.

4. **Report to the user** the project, worktree path, the web URL (`http://localhost:300N`
   for ng, `http://localhost:517N` for trm), and the slot number. Tell them to **open a new
   Claude Code session in the worktree directory** to do the screen work there — that
   session will use `/feature-checkpoint` to sync and `/feature-complete` to land it.

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
- **API "UP" but every screen hangs on a loading spinner** → the API is listening but its
  HFSQL connection is wedged. The spin-up summary now catches this itself
  (`HFSQL : UNREACHABLE — …`); check by hand with
  `curl "http://localhost:808N/api/health?db=1"`, and recover with `--restart`.
- The dev servers are **detached** — they keep running after this Claude session ends,
  which is the point. They are stopped by `/feature-complete` or `/feature-down`.
- **TRM worktrees need an ETM API running** (master via `/serve-main`, or an NG worktree
  via `--api 808N`). They have no API of their own.
- **TRM feature needing shared-API changes** → spin up a **paired NG worktree** with the
  same feature name for the API work, and pass `--api 808N` to the TRM worktree so it talks
  to that API. Never edit the API in this main checkout. Landing order: NG branch first,
  then TRM. See `claude_doc/worktrees.md` §"Shared-API changes".
- Do NOT do feature work in the main checkout; it is the integration tree on `master`.
