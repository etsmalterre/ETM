# Parallel development with git worktrees

Work on multiple screens at once — one worktree per screen, one Claude per worktree, each with
its own local dev stack. Driven by the worktree skills + `scripts/worktree/*.mjs`. Supports
**two projects**: `ng` (ETM — API + web, the default) and `trm` (the sibling TRM repo —
web only). The scripts live in the ETM checkout and drive both; the TRM repo is resolved as
the sibling directory (`../TRM`).

## Mental model

- **`C:\dev\etsmalterre\ETM` is the integration tree.** It stays permanently on `master` and is
  where features merge in and where you deploy from. **Do not do feature work here.** (A branch can
  be checked out in only one worktree, so `master` must live in one fixed place.) TRM
  (`C:\dev\etsmalterre\TRM`) is its own integration tree with the same discipline.
- **Each screen gets a worktree** `../ETM-<feature>` (or `../TRM-<feature>`) on branch
  `feat/<feature>`, created off that repo's current `origin/master`.
- All worktrees share the **same local HFSQL** (`localhost:4900`) — do NOT fork the DB per tree.
- All worktrees share `node_modules`? No — each worktree runs its own `pnpm install` (the pnpm
  content-addressable store makes this fast/hardlinked).

## Slot model

Six slots **per project**; slot **N** (1–6). The two projects have **disjoint port ranges**, so
an NG slot and a TRM slot with the same number never collide:

| | ETM (`ng`) | TRM (`trm`) |
|---|---|---|
| API port | `8080 + N` (pnpm `@mps/api dev:808N`) | *none* — targets an ETM API over HTTP |
| Web port | `3000 + N` (pnpm `@mps/web dev:300N`, targets API `808N`) | `5170 + N` (pnpm `@mps-trm/web dev:517N`) |
| Worktree | `../ETM-<feature>` | `../TRM-<feature>` |
| Branch | `feat/<feature>` | `feat/<feature>` |
| URL | `http://localhost:300N` | `http://localhost:517N` |

**TRM is web-only.** Its web dev server calls an ETM API cross-origin, so the TRM web ports
(`5171–5176`) are in `DEV_WEB_ORIGINS` and in the ETM API's dev CORS. By default a TRM worktree
targets the **slot-0 master** ETM API on `:8080` (start it with `/serve-main`); override with
`up.mjs <feature> trm --api 808N` to point at a running NG worktree's API instead. The chosen
target is written to the TRM worktree's `apps/web/.env.development.local` as `VITE_API_URL`.

## Shared-API changes (TRM features) — the paired-worktree rule

The ETM API serves both frontends; TRM has none of its own. The invariant:
**API changes always flow through ETM's own pipeline — NG worktree → `feat/*` branch →
NG `master` → `/etm_deploy` — regardless of which frontend consumes them.** Never edit
`apps/api` in the ETM main checkout (it's the integration tree, and a dirty tree blocks
both `/feature-complete` merges and deploys).

A TRM feature that needs endpoints therefore uses a **pair of worktrees** with the same name:

```bash
node scripts/worktree/up.mjs <name> ng               # NG worktree: the API work (API on 808N)
node scripts/worktree/up.mjs <name> trm --api 808N   # TRM worktree: the screen, wired to it
```

- **Landing order**: NG branch first (`/feature-complete` in the NG worktree), then the TRM
  branch. `/feature-complete` on TRM guards this: it stops if `ETM/apps/api` has
  uncommitted main-checkout edits.
- **Deploy ownership**: `/etm_deploy` ships the shared API (+ NG web) to
  `mpsng.malterre`; `/trm_deploy` ships only the TRM web to `trm.malterre`
  (same servers, `/api/` proxied to the same API). One deploy Claude per repo, each on its
  own `master`.
- Purely-web TRM features (no API change) need no pair — the default `:8080` master API
  via `/serve-main` is enough.
- **Retro-fitting a pair onto an existing TRM worktree**: a TRM worktree created without
  `--api` targets `:8080` (master). When the feature turns out to need endpoints, spin up
  the NG worktree and repoint the TRM one with
  `node scripts\worktree\up.mjs <name> trm --api 808N --restart`. Until 2026-07-30 that
  command **lied**: the restart branch skipped the env write (it only repairs deps + CORS),
  so `VITE_API_URL` kept the old port while the summary printed the new one. The failure is
  near-invisible — the app loads, auth works off master's API, and only the feature's brand-new
  endpoints 404 with nothing in the console. `up.mjs` now rewrites
  `apps/web/.env.development.local` on restart for web-only projects and logs
  `Rewrote apps/web/.env.development.local (API → :808N)`. If you ever see a 404 on an endpoint
  you know exists, check which port the browser actually called before debugging the route.

The registry `~/.claude/mps-worktrees.json` maps slot → project/feature/branch/ports/PIDs. NG
entries keep bare numeric keys (`"1"`); TRM entries are namespaced (`"trm:1"`). Slot allocation
picks the lowest slot free in the registry **for that project** and whose port(s) are actually
idle (a live probe), so a stale entry can't hand out a busy port. `PROJECTS` in
`scripts/worktree/lib.mjs` defines each project's packages/ports/scripts.

**Slot 0 is reserved for serving the main checkout (`master`) itself** — API `8080` / web `3000`,
outside the 1–6 feature range so `allocateSlot()` never hands it out and a feature worktree can
never collide with a running master. Defined as `MAIN_SLOT` in `scripts/worktree/lib.mjs`;
`localhost:3000` is in `DEV_WEB_ORIGINS` (so every generated worktree env allows it too). The
main checkout's own `apps/api/.env.development` is **gitignored and per-machine**, so it is NOT
guaranteed to list `:3000` — a station set up before slot 0 existed had only `:5174`, and the
browser then failed CORS while `curl` still passed. `serve-main.mjs` now rewrites that line from
`DEV_WEB_ORIGINS` on every start and verifies the API echoes the origin back. Managed
by `scripts/worktree/serve-main.mjs` behind the `/serve-main` + `/serve-main-down` skills; state
lives under `reg.main` (separate from `reg.slots`, so status/allocation ignore it). Use it to
click through the integrated app on `master` before deploying.

Slot 0 is often **half up** — one side dies while the other keeps its port. `serve-main` used to
answer "either port in use → already serving" and so could never repair it: the API stayed down
behind a healthy-looking `:3000` while every TRM worktree (which targets `:8080`) showed
« Impossible de charger la liste ». It now starts **only the missing side**, never restarts the
survivor (it may be another session's), and adopts an unregistered survivor by its listening PID
(`pidOnPort()`) so `/serve-main-down` can still stop it. `down` is only auto-called when slot 0 is
fully down — with one side alive it would kill the survivor too.

## The skills

| Skill | Run from | What it does |
|---|---|---|
| `/new-feature-worktree <name> [ng\|trm]` | ETM main checkout | allocate slot for the project (default `ng`), create worktree off that repo's `origin/master`, `pnpm install`, wire dev env (ng: `.env.development` CORS + `secrets/`, start API+web; trm: `.env.development.local` `VITE_API_URL`, start web only), health-check, register. Then open a new Claude in the worktree. |
| `/feature-checkpoint [msg]` | the feature worktree | commit → push → rebase onto `origin/master` (resolve conflicts here). **No merge.** Servers stay up; keep working. |
| `/feature-complete` | the feature worktree | commit + note → push → rebase → typecheck gate → fast-forward merge into `master` (from the main checkout) → push → stop servers, remove worktree, delete branch, free slot. **Deploy is separate.** |
| `/worktree-status` | anywhere | per-slot health (servers alive? web serving? ahead/behind master), free slots, stale-entry cleanup. |
| `/serve-main` | main checkout | serve `master` on reserved slot 0 (API 8080 / web 3000) detached + health-check — verify merged work before deploying. `serve-main.mjs status` reports without starting; never double-spawns a side that is already up, and repairs a half-up slot 0 by starting only the missing side. |
| `/serve-main-down` | main checkout | stop the slot-0 master server and free 8080/3000. |

## Merge discipline (why it stays clean)

1. One worktree = one branch = one screen. Keep scope tight.
2. Sync each tree onto `master` only **when it's that tree's turn** — at `/feature-checkpoint`
   or `/feature-complete`. You do NOT pull every tree after every merge.
3. Conflicts are always resolved **in the feature worktree** (rebase), where that screen's
   Claude has context. `master` therefore only ever sees a **fast-forward** — no tangled
   merges, no second Claude untangling anything.
4. Deploy only from `master` (the main checkout), via `/etm_deploy` (or `/trm_deploy` on TRM).

### Shared "registry" files that tend to conflict (all additive — keep both sides)

`apps/api/src/lib/permission-keys.ts`, `apps/api/src/index.ts`,
`apps/web/src/config/navigation.ts`, `apps/web/src/router.tsx`, `pnpm-lock.yaml`,
`claude_doc/worktree-merge-log.md`.

### Reusing a feature name (the registry is shared across sessions)

A worktree's path is derived from its feature name (`ETM-<name>`), and the registry at
`~/.claude/mps-worktrees.json` is **shared by every Claude session and terminal on this
machine**. So two sessions working on the same name are working on the same directory.

`/feature-complete` usually cannot delete its own worktree (the session is cwd'd inside
it), so it queues the *path* in `pendingRemovals`, and the next worktree skill run from
the main checkout reaps it. That queue holds a path, not an identity — which used to mean
that recreating a worktree with a shipped feature's name handed the reaper a live tree to
delete. **Hit live 2026-07-30:** two freshly created worktrees, plus their branches, were
destroyed by an unrelated `/worktree-status`.

Fixed in `scripts/worktree/lib.mjs`: `reapPending()` refuses to touch any path an active
registry slot claims, drops the stale entry instead, and reports it (`Kept <name> — a live
slot owns that path`); `up.mjs` voids the queued entry when it legitimately recreates the
path, and prints a NOTE when the name belongs to an already-merged branch. Regression
repro: sandbox `USERPROFILE`, put a pending entry and a live slot on the same path, assert
the directory survives.

Still true regardless: **prefer a fresh name.** Two unrelated features sharing a branch
name makes the merge log and `git log` ambiguous, and `origin/feat/<name>` from the first
one lingers.

## Manual fallbacks

```bash
node scripts/worktree/status.mjs                       # what's running
node scripts/worktree/up.mjs   <feature>               # create + start
node scripts/worktree/up.mjs   <feature> --restart     # existing tree: kill + respawn on its slot
node scripts/worktree/down.mjs <feature|slot>          # stop servers, free slot, keep tree
node scripts/worktree/down.mjs <feature|slot> --remove # + remove worktree & branch
git worktree list                                      # ground truth from git
```

## Bringing a tree back up (`--restart`)

Dev servers are detached, so they outlive their Claude — but not a reboot or a crash.
`status.mjs` then shows the slot `DOWN` with dead PIDs while the worktree is untouched.
`--restart` reuses the recorded slot, ports and env (no fetch, no `pnpm install`, no
`.env` rewrite), kills whatever is still alive on it, respawns and refreshes the PIDs.
The plain create path deliberately aborts on an existing dir, and now points at this.

## Health checks: an open port is not a healthy API

Spin-up used to accept "the port accepts connections" as proof the API worked. It isn't:
an API whose HFSQL connection is wedged answers `/api/health` instantly while **every**
data route hangs forever with nothing in the log — in the browser that's an infinite
loading screen on a server that reports `UP`. **`up.mjs` and `status.mjs` both** probe
`/api/health?db=1`, which runs a real query (`SELECT COUNT(*) FROM utilisateur`) and
returns 503 `{ db: 'error' }` when HFSQL is unreachable. The line reads
`HFSQL : OK (207ms)` or `HFSQL : UNREACHABLE — …`; in `up.mjs` the latter sets a non-zero
exit code, in `status.mjs` it downgrades the slot from `UP` to **`DEGRADED`** and prints
the remedy. A TRM slot is probed on the ETM API it *borrows*, so a wedge there is never
reported by nobody.

Use it by hand whenever screens hang but the app loads:

```bash
curl "http://localhost:808N/api/health?db=1"
```

### "The browser loads forever" — the one diagnosis to run first

This is the single most expensive false trail in this repo: the app is fine, the feature
code is fine, and the API is *listening*. Before reading any application code, run
`/worktree-status` (or `node scripts/worktree/status.mjs`) and believe the `HFSQL` line.

Signature of a wedged connection, all three together:

| Signal | Value |
|---|---|
| `/api/health` | `200`, instant |
| any data route (`/api/clients`) | `500` after **exactly 15.0 s** — `HFSQL_CONNECT_TIMEOUT_MS` |
| `.dev-logs/api.err.log` | `HFSQL connect timed out after 15000ms` |

**Usual cause: a burst of API file edits.** Every save under `apps/api/src` restarts
`tsx watch`, and the killed process leaves its ODBC connection dangling; ~8 restarts in
half a minute and the fresh process can no longer get one. So this bites hardest right
after a round of edits — i.e. exactly when you're about to ask the user to go and look at
your change. **Batch API edits, then restart the slot yourself before handing back.**

⚠ **A paired TRM worktree doubles this.** Under the §Shared-API rule the TRM feature's API
work lands in *your* ETM checkout, so two agents can be saving into the same
`apps/api/src` and restarting the same `tsx watch`. If the slot wedges without you having
touched the API, check `git status` for someone else's files before concluding anything.

Cure (the self-heal in `hfsql.ts` does not always win the race):

```bash
node scripts/worktree/up.mjs <feature> --restart
```

Logs survive that restart: Windows `Start-Process` truncates its redirect targets, so
`spawnDetached` first rotates `api.log`/`api.err.log` to **`api.prev.log`/`api.err.prev.log`**.
Read those for the failure you just restarted away.

The Windows connect path (`apps/api/src/lib/hfsql.ts`) now self-heals like the Linux
bridge does: a connect attempt is raced against `HFSQL_CONNECT_TIMEOUT_MS` (default 15s,
overridable) and the cached promise is cleared on failure, so the next request retries
instead of every request inheriting one hung connect for the process lifetime.

## Notes

- Dev servers are launched **detached** so they outlive the Claude that started them; they're
  stopped by `/feature-complete` or `node down.mjs`. On Windows the whole `pnpm → vite/tsx`
  process tree is reaped via `taskkill /T /F`.
- **Deferred dir removal:** `/feature-complete` runs *inside* the worktree, so Windows won't let
  it delete that directory (the session/terminal holds the cwd). The merge + slot-free + branch
  delete still happen; the leftover dir is queued (`pendingRemovals` in the registry) and reaped
  automatically the next time any worktree skill runs from the main checkout — or manually via
  `node scripts/worktree/reap.mjs`. `/worktree-status` shows anything still pending.
- `apps/api/tsconfig.tsbuildinfo` and `.dev-logs/` are gitignored — the former so a build never
  dirties the main checkout (which would block the fast-forward merge).
