# Serve Main Skill

## When to use

Invoke with `/serve-main` to serve the **main checkout** (`C:\dev\etsmalterre\ETM`, on
`master`) locally so you can click through the integrated app — e.g. to verify that
merged feature work looks right before deploying. Master runs on its own reserved
**slot 0**: API on `8080`, web on `3000`. Slot 0 sits outside the 1–6 feature-worktree
range, so it never collides with a running feature worktree and there is no per-run
"which port?" decision.

Run this from the main checkout. Stop it later with `/serve-main-down`.

## Background

Slot 0 is defined as `MAIN_SLOT` in `scripts/worktree/lib.mjs`; `allocateSlot()` only
hands out slots 1–6, so it can never reuse 0. The web origin `http://localhost:3000`
must be in the API's `CORS_ORIGIN`; because `apps/api/.env.development` is gitignored
and per-machine, `serve-main.mjs` rewrites that line from `DEV_WEB_ORIGINS` on every
start rather than trusting it. The committed pnpm scripts `@mps/api dev:8080` and
`@mps/web dev:3000` (→ `VITE_API_URL=http://localhost:8080/api`) wire the pair.
State is recorded under `reg.main` in `~/.claude/mps-worktrees.json`, kept separate
from `reg.slots` so `/worktree-status` and slot allocation ignore it.

## Steps

1. **Run the serve script** from the main checkout:
   ```bash
   node scripts/worktree/serve-main.mjs
   ```
   It refuses to double-spawn if slot 0 is already serving; installs deps if the
   checkout has none; repairs `CORS_ORIGIN`; starts the API (`dev:8080`) and web
   (`dev:3000`) detached (logs → `.dev-logs/main-api.log` / `main-web.log`); records
   the PIDs; then checks ports **plus** HFSQL reachability and CORS.

2. **Read the summary** (branch, URLs, PIDs, `UP`/`NOT UP`, `HFSQL`, `CORS`). A failed
   start now prints the tail of its own log, so the cause should be on screen; if you
   need more:
   ```bash
   tail -n 40 .dev-logs/main-api.log
   tail -n 40 .dev-logs/main-web.log
   ```
   Do not report success on `UP` alone — `UP` means "port open". `HFSQL : UNREACHABLE`
   means every data screen will hang; `CORS : REJECTS …` means the browser fails while
   `curl` still passes.

3. **Report to the user**: the web URL (`http://localhost:3000`) and that it serves the
   live `master` checkout. **Flag that it talks to the live shared HFSQL DB** — clicking
   around is fine, but edits are real writes.

## Notes

- The dev servers are **detached** — they keep running after this Claude session ends.
  Stop them with `/serve-main-down` (or `node scripts/worktree/serve-main.mjs down`).
- `node scripts/worktree/serve-main.mjs status` reports current slot-0 health without
  starting anything.
- This serves whatever the main checkout currently has checked out (normally `master`);
  the summary prints the branch so you can confirm.

## Failure modes

- **Both servers "NOT UP" instantly, log shows `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`** →
  the checkout has no `node_modules` (fresh machine: the main checkout is the one tree
  nothing installs for). `serve-main.mjs` now installs automatically; by hand it is
  `pnpm install --config.confirmModulesPurge=false` — without that flag pnpm can block
  on an interactive "remove and reinstall modules dirs?" prompt and appear to hang.
- **App loads but every list shows "Impossible de charger la liste"** → CORS. The API
  rejects origins not in `CORS_ORIGIN`, and `curl` cannot see this because it sends no
  `Origin` header. Verify the way the browser does:
  ```bash
  curl -s -D - -o /dev/null -H "Origin: http://localhost:3000" http://localhost:8080/api/health | grep -i access-control
  ```
- **Screens hang forever while `/api/health` returns 200** → the API's HFSQL connection
  is wedged, not the DB. Confirm with `curl "http://localhost:8080/api/health?db=1"` and
  restart slot 0 (`down` then up). See `claude_doc/worktrees.md` §health checks.
- **`HFSQL : not checked (API predates ?db=1)`** → informational, not a fault: the
  checkout being served is older than the readiness probe.
- **Port 3000 serves the wrong app (or web dies instantly with "Port 3000 is already in
  use")** → a foreign process is squatting slot 0's web port. Seen live 2026-07-24: a
  global node kill took down every MPS dev server, then the **LIVA issue tracker**
  (`C:\dev\liva\issue-tracker\frontend`, `next start --port 3000`) claimed 3000.
  Identify the owner before assuming an MPS problem:
  ```powershell
  Get-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess | Select-Object Id,ProcessName,Path
  ```
  If it's the issue tracker (or anything non-MPS), stop it or move it to another port —
  do NOT kill node blindly: a blanket `node` kill is exactly what causes the "every MPS
  server dead at once" incident (all worktree slots + master die as collateral). The
  same symptom on ports 3001–3006 means a feature slot is squatted; `up.mjs --restart`
  detects this and prints the owner.
