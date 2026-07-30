# ETM Deploy Skill

## When to use

Invoke with `/etm_deploy` to deploy the ETM API and/or webapp to production.

**Optional version argument — `/etm_deploy v0.2.1`.** A version means "release this
version", so **before** building: set `version` in the **root** `package.json` (the single
source of truth — see CLAUDE.md §Versioning), commit it as `chore(release): X.Y.Z`, and
push. The web build bakes it in as `__APP_VERSION__` and the header profile menu shows it,
so bumping *after* the build ships the old number. Deploy the pushed commit, not the
pre-bump one. With no argument, deploy `origin/master` as-is and change no version.
Do NOT touch the per-package `apps/*/package.json` versions; they are displayed nowhere.

## Deploy ownership — the API is shared with TRM

The API deployed here serves **two frontends**: ETM (`mpsng.malterre`) and the sister
app **TRM** (`mpstrm.malterre`, dist at `/home/debian/mps_trm/dist` on the same web
server, its nginx site proxies `/api/` to this same `10.10.2.163:8081`).

- **This skill owns**: the ETM web bundle + the **shared API** (including endpoints that
  only TRM screens use, e.g. `planning-atelier.ts` — they live in this repo and deploy from
  here).
- **The TRM repo's own `/trm_deploy`** owns: the TRM web bundle only. Never deploy the
  API from there; never deploy the TRM web bundle from here.
- **After every API deploy, smoke-check BOTH frontends**: `https://mpsng.malterre/api/...`
  and `http://mpstrm.malterre/api/...` (same API through two proxies — if one fails, it's
  nginx-side, not the API).
- Shared-API changes for TRM features land on this repo's `master` via a **paired NG
  worktree** (see `claude_doc/worktrees.md` §"Shared-API changes") — so deploying `master`
  here is always sufficient to ship the API side of a TRM feature.

## Infrastructure Overview

| Component | Server | IP | User | Hostname |
|-----------|--------|-----|------|----------|
| **API** | mfprod-api | `10.10.2.163` | `debian` | `mfprod-api` |
| **Web** | mfprod-erp | `10.10.2.165` | `debian` | `mfprod-erp` |
| **HFSQL** | mps.malterre | `mps.malterre:4900` | `Malterre` | — |

Both servers are Debian Linux (x86_64). The MFProd (separate project) also runs on these servers.

## SSH Access

**Connect with the Windows-native OpenSSH binary** (`C:\Windows\System32\OpenSSH\ssh.exe`) and the `claude_deploy` key — NOT WSL and NOT Git Bash's `ssh` (its libcrypto rejects these keys with `error in libcrypto: unsupported`). This is the method defined in the user-level **`ssh-context`** skill; load that skill for the full flag rationale and the access model. The recipe below is portable across machines (laptop user `malte`, factory PC user `vince`) because it derives the key path from `$HOME`.

```bash
SSH="/c/Windows/System32/OpenSSH/ssh.exe"
SCP="/c/Windows/System32/OpenSSH/scp.exe"
KEY="$HOME/.ssh/claude_deploy/claude_deploy"   # C:\Users\<current-user>\.ssh\claude_deploy\claude_deploy
OPTS="-F none -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"

# API server
"$SSH" $OPTS debian@10.10.2.163 'command'
# Web server
"$SSH" $OPTS debian@10.10.2.165 'command'
```

**Important**: The claude_deploy key is only enabled during active sessions. The user enables it before deployment and disables it after for security. `Permission denied (publickey)` = the key isn't enabled right now (normal, not a bug) — ask the user to enable it. A timeout on a `10.10.x.x` address = not on the factory LAN/VPN.

**Key location varies per machine** (verified 2026-07-06): on the **factory PC** (`vince`) the
Windows-side key path above does **not exist** — the key lives on the WSL side at
`/home/vincent/.ssh/claude_deploy/claude_deploy`.

**Pick the transport with a file test, not a failed SSH probe** (a probe wastes a round-trip):
```bash
if [ -f "$HOME/.ssh/claude_deploy/claude_deploy" ]; then TRANSPORT=win; else TRANSPORT=wsl; fi
```
- `win` (laptop `malte`): use the `$SSH`/`$SCP`/`$OPTS`/`$KEY` recipe above.
- `wsl` (factory PC `vince`): wrap every command through WSL with the WSL-side key:
  ```bash
  WKEY="/home/vincent/.ssh/claude_deploy/claude_deploy"
  WOPTS="-i $WKEY -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no"
  wsl bash -c "ssh $WOPTS debian@10.10.2.163 '<command>'"
  wsl bash -c "scp $WOPTS <local> debian@10.10.2.163:<remote>"
  ```
  **WSL `scp` can only read `/mnt/c/...` paths** — git-bash `/tmp` is NOT reachable. Stage any
  tarball under a Windows-visible dir first (the session scratchpad works; its `/mnt/c/...`
  form is the same path with `/c/` → `/mnt/c/`), then scp from there.

Shell state does NOT persist between Bash tool calls, so re-establish `TRANSPORT`/the key vars
in each call (or just inline the WSL form on the factory PC — that's the common case here).

## Step 0 — What needs deploying (ALWAYS run first)

Do this before building anything. It answers "is there an undeployed merge, and does it touch
the API, the web, or both?" deterministically — so a bare "deploy" never needs you to ask the
user what merged, and you never eyeball `git show --stat` to pick API-vs-web by hand.

Prod records the commit it's running in a `DEPLOYED_SHA` file on each server (written at the end
of every deploy — see the deploy steps). The check:

1. **Sync and read what's live** (uses the transport from §SSH Access):
   ```bash
   cd /c/dev/etsmalterre/ETM && git fetch origin
   LOCAL=$(git rev-parse origin/master)
   # factory PC (wsl) form — read both servers' deployed SHA (missing file → "none"):
   API_SHA=$(wsl bash -c "ssh $WOPTS debian@10.10.2.163 'cat /home/debian/mps_api/DEPLOYED_SHA 2>/dev/null || echo none'")
   WEB_SHA=$(wsl bash -c "ssh $WOPTS debian@10.10.2.165 'cat /home/debian/mps_erp/DEPLOYED_SHA 2>/dev/null || echo none'")
   ```

2. **Show the gap** — the merged features not yet on prod (this is the "make sure you get it
   when a worktree is merged" signal). List commits and the merge-log entries between the
   deployed SHA and `origin/master`:
   ```bash
   git log --oneline ${API_SHA}..origin/master   # (API_SHA is the older of the two if they differ)
   ```
   `claude_doc/worktree-merge-log.md` has the prose description of each landed feature.

3. **Decide API / web / both by the changed paths** in that range — don't guess:
   ```bash
   git diff --name-only ${API_SHA}..origin/master -- apps/api | head -1   # non-empty → deploy API
   git diff --name-only ${WEB_SHA}..origin/master -- apps/web | head -1   # non-empty → deploy web
   ```
   Deploy API if `apps/api/**` changed, web if `apps/web/**` changed (usually both). If a
   server's `DEPLOYED_SHA` is `none` (first deploy after adopting this) or the SHA is unknown to
   git, treat that side as needing deploy and just ship it.

   **Exception — `apps/api/src/scripts/**`-only changes have no runtime effect.** One-off
   backfill/migration scripts under `src/scripts/` are never imported by the running service,
   so if the API diff touches **only** those, do NOT redeploy/restart the shared API (a restart
   blips both `mpsng` and `mpstrm` for nothing). Confirm with
   `git diff --name-only ${API_SHA}..origin/master -- apps/api | grep -v '^apps/api/src/scripts/'`
   — empty output → skip the API side. (Seen 2026-07-23: `backfill-factures-envoyees.ts` was
   the only API delta; web-only deploy shipped.) Run the script itself on the server by hand if
   the migration hasn't been applied yet — that's separate from a service deploy.

4. **Report the plan to the user before proceeding**: e.g. *"prod API at `9b208bc`, origin/master
   at `f4c26c9` (1 ahead: facturation) — touches apps/api + apps/web → deploying both."*

## API Server (10.10.2.163)

### Location
- **App directory**: `/home/debian/mps_api/`
- **Source files**: `/home/debian/mps_api/src/` (TypeScript, run directly via `tsx`)
- **Binary**: `/home/debian/mps_api/hfsql_bridge` (compiled C binary for iODBC on Linux)
- **Config**: `/home/debian/mps_api/.env` (HFSQL connection string, PORT=8081)

### Process Manager
- **Systemd service**: `mps-api.service`
- **Service file**: `/home/debian/mps-api.service` (also installed in systemd)
- **ExecStart**: `/usr/bin/node --import tsx src/index.ts`
- **Restart**: `sudo systemctl restart mps-api`
- **Status**: `sudo systemctl status mps-api`
- **Logs**: `sudo journalctl -u mps-api -f`

### Runtime
- **Node.js**: v22.22.0
- **ODBC**: Uses iODBC (not unixODBC) via the `hfsql_bridge` C binary
- **Auto-select**: `hfsql-auto.ts` detects Linux → uses `hfsql-bridge.ts` → spawns `hfsql_bridge` binary

### Dependencies
- `node_modules/` installed with npm (not pnpm — monorepo workspace refs stripped)
- `package.json` is a standalone copy (no workspace protocol)

### Deploy Steps (API)

1. **Build a deploy tarball** locally with the API source files:
   - `src/` directory (all .ts files)
   - `package.json` (convert `workspace:*` refs to actual versions or remove them)
   - `.env.production` → `.env`
   - Do NOT include `node_modules/`, `hfsql_bridge` binary (already on server), or `.env.development`

2. **Upload** the tarball to the server (uses `$SCP`/`$KEY` from the SSH Access block):
   ```bash
   "$SCP" -i "$KEY" -o IdentitiesOnly=yes tarball.tar.gz debian@10.10.2.163:/home/debian/
   ```

3. **On the server**: extract, install deps, restart service:
   ```bash
   cd /home/debian/mps_api
   # backup current
   tar czf ../mps_api_backup.tar.gz src/ package.json
   # extract new files
   tar xzf ../tarball.tar.gz
   # install new dependencies if package.json changed
   npm install --production
   # restart
   sudo systemctl restart mps-api
   sudo systemctl status mps-api
   ```

4. **Stamp the deployed commit** after a clean restart (this is what Step 0 reads next time).
   Compute the SHA locally (`git rev-parse origin/master`) and write it on the API server:
   ```bash
   SHA=$(cd /c/dev/etsmalterre/ETM && git rev-parse origin/master)
   wsl bash -c "ssh $WOPTS debian@10.10.2.163 'echo $SHA > /home/debian/mps_api/DEPLOYED_SHA'"
   ```

### Key Differences from Local Dev
- Linux uses `hfsql-bridge.ts` (C bridge binary via iODBC) instead of `odbc` npm package (unixODBC)
- `hfsql-auto.ts` must export `queryRaw` on both paths
- `hfsql-bridge.ts` must also export `queryRaw`
- **Binary blobs**: The C bridge base64-encodes binary columns (`"b64:..."` prefix), Node decodes in `cleanRow()`. If `hfsql_bridge.c` changes, recompile on server: `gcc -o hfsql_bridge src/hfsql_bridge.c -I/usr/include/iodbc -liodbc -liodbcinst`
- **Accented column names**: iODBC bridge mangles accents (e.g. `recyclé` → `recyclb`). Frontend must handle all variants.
- **Accented VALUES in write literals (Windows-passes / Linux-500 footgun)**: a SQL write that interpolates accented text as a plain quoted literal (`'${esc(v)}'`) works on the Windows `odbc` driver but **corrupts the Linux bridge** → `[HY090]` / `string without end: ' not found` → HTTP 500. Because it never fails in local dev, it ships silently and only breaks after deploy. Any INSERT/UPDATE (and any `WHERE textcol = '...'` SELECT-back) touching free text — incl. **hardcoded French defaults** like `'Nouvelle référence'` — must emit accented values via the Latin-1 hex-literal helper `sqlText()` (canonical impl in `commandes-sous-traitant.ts`), not `'${esc(v)}'`. See CLAUDE.md §"Encoding (writes)". Found 2026-06-14: Fils › Références "Nouveau" button (silent 500, no UI feedback). When deploying API write routes, grep the changed routes for `'${esc(` on text columns before shipping, and after restart check `journalctl -u mps-api | grep HY090`.
- `multer` must be in `package.json` dependencies for certificate file uploads
- **Use `npm install` (not `--production`)** — `tsx` is in devDependencies but needed at runtime since the service runs TypeScript directly

## Web Server (10.10.2.165)

### Location
- **Dist directory**: `/home/debian/mps_erp/dist/`
- **Nginx config**: `/etc/nginx/sites-available/mpsng.malterre` (symlinked to sites-enabled)
- **Server name**: `mpsng.malterre`

### Nginx Setup
- Serves static files from `/home/debian/mps_erp/dist/`
- Proxies `/api/` to `http://10.10.2.163:8081` (API server)
- SPA routing: all non-file routes → `/index.html`
- Hashed assets cached 1 year; `index.html` + `sw.js` never cached
- **Default `client_max_body_size` is 1MB** — may need increasing for certificate file uploads

### Deploy Steps (Web)

1. **Build locally — use PowerShell, NOT the Bash tool.** `VITE_API_URL=/api`
   MUST be set in the build env. **Run `pnpm install` first** — features are built in
   worktrees (which get their own fresh install), so the main checkout's `node_modules`
   lags whenever a landed feature added a dependency. Skipping it fails the build with a
   misleading `tsc` error like `Cannot find module 'html-to-image'` (seen 2026-07-23:
   the tickets feature's dep wasn't in the main checkout). `pnpm install` is a no-op when
   already current, so always run it:
   ```powershell
   cd C:\dev\etsmalterre\ETM; pnpm install; $env:VITE_API_URL='/api'; pnpm --filter web build   # USE THIS
   ```
   ```bash
   MSYS_NO_PATHCONV=1 VITE_API_URL=/api pnpm --filter web build          # bash ONLY with the guard
   ```
   This produces `apps/web/dist/` with hashed assets.

   **Footgun A — git-bash path mangling (caused a prod outage 2026-06-15):**
   the Claude Code Bash tool on this machine is **git-bash**, whose MSYS
   path-conversion rewrites any value that looks like an absolute Unix path. So
   `VITE_API_URL=/api ... build` run through Bash bakes the API base as
   **`C:/Program Files/Git/api`**, and the prod bundle does
   `fetch(\`C:/Program Files/Git/api/auth/users\`)` → resolves to
   `https://mpsng.malterre/C:/Program Files/Git/api/...` → never matches `/api/*`.
   Result is identical to Footgun B ("Impossible de charger la liste" everywhere)
   but the `localhost:3002` grep below PASSES because the var *was* set, just to a
   garbage value. Build with PowerShell to avoid it entirely.

   **Footgun B — unset var (caused a prod outage 2026-06-14):** if the var is
   unset at build time, `apiFetch` silently bakes in its dev fallback
   `http://localhost:3002/api` (`apps/web/src/lib/api.ts:5`). The build succeeds,
   but every prod API call goes to `localhost:3002` and is blocked.

   **Verify the built bundle BEFORE upload — both a negative AND a positive
   check (the negative alone is necessary-but-not-sufficient, it misses Footgun A):**
   The build now emits **more than one `index-*.js` chunk** (e.g. the ~1.6 MB main
   bundle `index-BGQgngLQ.js` **and** a small ~14 KB `index-*.js`), so `ls … | head`/
   `tail -1` picks an arbitrary one — and the `="/api"` base lives **only in the main
   bundle**, so grabbing the wrong chunk gives a false "assertion doesn't match, do NOT
   deploy" (seen 2026-07-23). Grep **across all** index chunks: the negatives must be 0
   in every chunk, the positive must match in **at least one**.
   ```bash
   B=$(ls apps/web/dist/assets/index-*.js)                        # ALL index chunks
   grep -oc 'localhost:3002'        $B   # must be 0 for every file  (Footgun B)
   grep -oc 'Program Files/Git/api' $B   # must be 0 for every file  (Footgun A)
   grep -lE  'ht="/api"|="/api"'    $B   # MUST list ≥1 file — that chunk has API base /api
   ```
   If no chunk matches the positive `="/api"` assertion, do NOT deploy — the base is
   wrong regardless of what the negative checks say. (Do not `"$B"`-quote when it holds
   multiple filenames.)

2. **Upload** the dist folder (uses `$SSH`/`$SCP`/`$KEY`/`$OPTS` from the SSH Access block):
   ```bash
   "$SCP" -i "$KEY" -o IdentitiesOnly=yes -r apps/web/dist/* debian@10.10.2.165:/home/debian/mps_erp/dist/
   ```
   Or tar it first for speed. **On the factory PC (wsl transport), stage the tarball under a
   `/mnt/c`-visible dir — NOT git-bash `/tmp`, which WSL `scp` cannot read** (see §SSH Access):
   ```bash
   tar czf /tmp/mps_web_dist.tar.gz -C apps/web/dist .
   "$SCP" -i "$KEY" -o IdentitiesOnly=yes /tmp/mps_web_dist.tar.gz debian@10.10.2.165:/home/debian/   # win transport
   # Extract OVER the existing dist — do NOT wipe it first (see below), then age out
   # hashed assets untouched by a deploy for 14 days.
   "$SSH" $OPTS debian@10.10.2.165 'tar xzf /home/debian/mps_web_dist.tar.gz -C /home/debian/mps_erp/dist/ && find /home/debian/mps_erp/dist/assets -type f -mtime +14 -delete'
   ```

   **Never `rm -rf dist/*` before extracting.** The shell files (`index.html`, `sw.js`,
   `registerSW.js`, `manifest.webmanifest`) are overwritten in place by the extract, and the
   new build's assets are hash-named, so a plain extract-over is already a complete deploy.
   Wiping first deletes the *previous* build's hashed chunks, which breaks any browser tab a
   user left open across the deploy: that tab runs the old bundle, whose lazy `import()` URLs
   (`assets/xlsx-<oldhash>.js`, `html-to-image`) point at files that no longer exist. Once the
   new service worker activates and claims the tab (it is built with `clientsClaim`), those
   chunks aren't in its precache either, so the request hits nginx, 404s into the SPA fallback,
   and the dynamic import rejects — the user clicks "Exporter Excel" and nothing happens.
   Keeping the old assets for 14 days makes that tab keep working until it is reloaded.

   The `-mtime +14` sweep is what stops `dist/assets` growing without bound: `tar` restores
   each file's build-time mtime, so a redeployed file looks fresh and only genuinely superseded
   chunks age out. The web app also carries a client-side backstop for the residual case
   (`apps/web/src/lib/chunk-error.ts` + `components/shared/StaleBundleReload.tsx`), which
   offers the user a reload when a chunk does go missing — but that is the safety net, not the
   fix. Keep both.

3. **Stamp the deployed commit** — write it to `/home/debian/mps_erp/DEPLOYED_SHA`, which is the
   PARENT of `dist/` so it is never served publicly (and survives any dist-level cleanup):
   ```bash
   SHA=$(cd /c/dev/etsmalterre/ETM && git rev-parse origin/master)
   wsl bash -c "ssh $WOPTS debian@10.10.2.165 'echo $SHA > /home/debian/mps_erp/DEPLOYED_SHA'"
   ```

4. **No restart needed** — nginx serves static files directly. Just verify:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://mpsng.malterre/
   ```

### Production Environment
- `VITE_API_URL=/api` — relative URL, proxied by nginx to the API server
- No `.env` file needed on the web server (baked into the build)

## Verification Checklist

After deployment, verify:
- [ ] `curl http://10.10.2.163:8081/api/fournisseurs` returns JSON
- [ ] `curl http://mpsng.malterre/` returns HTML
- [ ] `curl http://mpsng.malterre/api/fournisseurs` returns JSON (through nginx proxy)
- [ ] Navigate to `http://mpsng.malterre/fournisseurs/gestion` in browser
- [ ] Certificate PDF viewer works (may need `client_max_body_size` increase in nginx)

## Step 5 — Clean up merged worktrees (after a green deploy)

Once the deploy is live and smoke checks pass, the feature branches that just shipped no
longer need their worktree, local/remote branch, or detached dev servers. A merged
`feat/*` branch is one whose tip is an **ancestor of `origin/master`** — that only happens
after `/feature-complete` lands it, so a merged branch still lying around is leftover.
Clean each one up; this is safe precisely because "merged" guarantees no unshipped commits.

⚠️ **The ancestor test alone is NOT a safety net — it flags brand-new worktrees as
merged.** A worktree created but not yet committed in sits exactly at `origin/master`, so
its branch **is** an ancestor of master and reads as "MERGED" while being someone's live
workspace. (This doc previously claimed active worktrees are excluded automatically. They
are not; that claim nearly caused two active worktrees to be torn down on 2026-07-30.)
So the listing below **subtracts every feature the worktree registry currently owns** —
that registry is the authority on what is live, not the commit graph. Never delete
`master`.

1. **List merged remote feature branches, minus the ones a live slot owns**:
   ```bash
   cd /c/dev/etsmalterre/ETM && git fetch --prune origin
   # features held by an active worktree slot (any project) — never touch these
   ACTIVE=$(node -e "const r=require(require('os').homedir()+'/.claude/mps-worktrees.json');console.log(Object.values(r.slots||{}).map(s=>s.feature).join(' '))" 2>/dev/null)
   for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/feat); do
     name=${b#origin/feat/}
     git merge-base --is-ancestor "$b" origin/master || continue
     case " $ACTIVE " in *" $name "*) echo "ACTIVE (skip): $name"; continue;; esac
     # a branch with no commits of its own is a fresh tree, not a shipped feature
     if [ "$(git rev-list --count origin/master..$b)" = "0" ] && \
        [ "$(git rev-parse $b)" = "$(git rev-parse origin/master)" ]; then
       echo "AT MASTER (skip, nothing shipped from it): $name"; continue
     fi
     echo "MERGED: $name"
   done
   ```
   Cross-check anything you are about to remove against `/worktree-status` and
   `git worktree list`. If a name appears in either, it is live — leave it.

2. **For each merged feature**, tear down any leftover worktree (dir + registry entry +
   detached servers) and delete the remote branch:
   ```bash
   node scripts/worktree/down.mjs <name> --remove   # no-op-safe if already gone
   git push origin --delete feat/<name>
   git worktree prune
   ```
   `down.mjs` is idempotent — it just reaps the dir and reports "No registry entry" if the
   worktree was already cleaned by `/feature-complete`. The local `feat/<name>` branch is
   usually already gone; delete it too if it lingers (`git branch -D feat/<name>`).

3. **Report** which worktrees/branches were cleaned. Only act on branches confirmed merged
   in step 1 — if unsure whether a branch is truly done, leave it and tell the user.

## Known Issues

- **nginx upload limit**: Default 1MB `client_max_body_size` may block large certificate uploads. Fix: add `client_max_body_size 10m;` to the `/api/` location block in nginx config.
- **hfsql_bridge binary**: Compiled on the server from `src/hfsql_bridge.c`. Must be recompiled when the C source changes. Build: `gcc -o hfsql_bridge src/hfsql_bridge.c -I/usr/include/iodbc -liodbc -liodbcinst`
- **Logo files**: `logo-full.png`, `logo-small.png`, `logo-dev.webp` are in `public/` and included in the build. The `logo-dev.webp` only shows in dev mode (`import.meta.env.DEV`), so it won't appear in production.
- **Service Worker caching**: After deploying, users may need to hard-refresh (Ctrl+Shift+R) or unregister the SW in DevTools to pick up the new bundle. The SW precaches assets by hash, so new filenames are picked up on next SW update cycle.
- **Diagnosing "Impossible de charger la liste" / "API inaccessible" in the browser while curl works**: do NOT assume stale service worker and send the user through cache-clearing rituals first. **Diagnose server-side before touching the client**, in this order:
  1. `curl -sk https://mpsng.malterre/api/auth/users` — if it returns JSON, the API is fine.
  2. Check the nginx access log for the user's request: `sudo grep 'auth/users' /var/log/nginx/access.log | tail`. **If the browser shows the error but NO matching request appears in the log, the bundle is sending the request to the wrong URL** (Footgun A `C:/Program Files/Git/api/...` or Footgun B `localhost:3002`) — it's a bad build, not a cache problem.
  3. Confirm by grepping the *served* bundle: `curl -sk https://mpsng.malterre/$(curl -sk https://mpsng.malterre/ | grep -oE 'assets/index-[^"]+\.js')` then check for `ht="/api"` vs `Program Files`/`localhost`.
  Only after the served bundle is confirmed correct is a client-side SW clear the right next step. Rebuilding wrong → re-pushing → telling the user to clear cache again wastes everyone's time.
- **Missing PWA manifest icons**: `manifest.webmanifest` references `/icons/icon-192.png` and `/icons/icon-512.png`, but `apps/web/public/icons/` only contains `fini.png` and `tm.png` — so these 404 in the nginx error log after every deploy. Cosmetic (only affects the PWA install icon), NOT a sign of a broken deploy. Don't chase it while diagnosing API failures.
- **SW NavigationRoute**: The `navigateFallbackDenylist: [/^\/api\//]` in `vite.config.ts` is critical — without it, the SW intercepts iframe loads to `/api/` and serves `index.html`, causing React Router 404 errors.
