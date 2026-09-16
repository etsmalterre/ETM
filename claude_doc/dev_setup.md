# Dev Setup (first-time, fresh machine)

The factory PC has everything pre-installed; on a fresh machine you also need:

1. **HFSQL Client/Server** running on `localhost:4900` with the `MPS` database — and, for the pointage PWA, a `pointage` database built from prod with `node --import tsx src/scripts/copy-pointage-prod-to-dev.ts --write` (run from `apps/api`; reads `ETM/apps/api/.env.production`, only SELECTs prod). No env line needed: the API derives it from `HFSQL_CONNECTION_STRING` (`HFSQL_POINTAGE_CONNECTION_STRING` overrides).
2. **HFSQL ODBC driver** — install once via `C:\PC SOFT\WINDEV Suite <year>\Install\ODBC\WX310PACKODBC.exe` (admin required). Without this, the API throws ODBC `IM002` ("Source de données introuvable") on every query and the user picker shows "Impossible de charger la liste".
3. **`apps/api/.env.development`** with at minimum `PORT=3002`, `AUTH_COOKIE_SECRET=<32-byte hex>`, `HFSQL_CONNECTION_STRING=DRIVER={HFSQL};Server Name=localhost;Server Port=4900;Database=MPS;UID=Admin;PWD=;`, and a `CORS_ORIGIN` **spanning every dev web port** (see below). Gitignored. Gmail send/draft is disabled until `apps/api/secrets/<service-account>.json` exists and `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` points at it.
4. **Ticket reporting (LIVA issue tracker)** — optional in dev; without it the widget's proxy returns 503 "non configuré". Server-side env only (the key must never reach the client):
   `ISSUE_TRACKER_URL=https://liva-holding.com/issues/api/v1`, `ISSUE_TRACKER_API_KEY=<company key>`, `ISSUE_TRACKER_PRODUCT_SLUG=etm-erp`, `ISSUE_TRACKER_PRODUCT_SLUG_TRM=trm-erp` (the sister TRM app's product — its widget hits this API's `/api/tickets-trm` mount). **These are a prod deploy requirement too** — the same four vars must exist in the prod API env or the header ticket button breaks (in ETM without the first three, in TRM without the fourth). Proxy routes live in `apps/api/src/routes/tickets.ts` (one factory, mounted at `/api/tickets` for ETM and `/api/tickets-trm` for TRM); the widget in `apps/web/src/components/tickets/` (trigger in `Header.tsx`). Reporters need an email mapped in Paramètres › Utilisateurs (same mapping as Gmail send) — users without one get a French 400 telling them so.

### `CORS_ORIGIN` must list every dev port, not just one

The API rejects any origin not in the list, and the symptom is misleading: the app loads
but every list shows *"Impossible de charger la liste"*, while `curl` against the same
endpoint returns 200 — because `curl` sends no `Origin` header. A single-origin value
(the old `CORS_ORIGIN=http://localhost:5174`) breaks slot 0 (`:3000`) and every worktree
slot. Since the file is gitignored, this drifts per machine; generate the correct line
from the canonical list instead of typing one:

```bash
node -e "import('./scripts/worktree/lib.mjs').then(m => console.log('CORS_ORIGIN=' + m.DEV_WEB_ORIGINS.join(',')))"
```

`up.mjs` (worktrees) and `serve-main.mjs` (main checkout) both rewrite this line on every
start, so in practice you only hit it if you start a server another way.

## Linux dev machine (Arch / Omarchy) — done 2026-09-16

On Linux the API does not use the `odbc` npm package: `hfsql-auto.ts` spawns the C bridge
`apps/api/hfsql_bridge`, which needs **iODBC** and the **HFSQL Linux ODBC driver**. Neither
ships with the repo; the driver is PC SOFT's and the only copy we hold is on the prod API
box (`10.10.20.3`, `/home/debian/hfsql_odbc/`, ~200 MB of `wd310*64.so`).

1. `sudo pacman -S libiodbc` (headers land in `/usr/include/libiodbc`, not Debian's
   `/usr/include/iodbc`).
2. Copy the driver bundle from the prod API box and register it:
   ```bash
   scp -r -i ~/.ssh/claude_deploy/claude_deploy -o IdentitiesOnly=yes debian@10.10.20.3:/home/debian/hfsql_odbc /tmp/
   sudo mkdir -p /opt/hfsql_odbc && sudo cp /tmp/hfsql_odbc/*.so /opt/hfsql_odbc/
   printf '[HFSQL]\nDescription = HFSQL ODBC Driver\nDriver = /opt/hfsql_odbc/wd310hfo64.so\nSetup = /opt/hfsql_odbc/wd310hfo64.so\n' | sudo tee /etc/odbcinst.ini
   ```
3. Compile the bridge (gitignored, per machine):
   `cd apps/api && gcc -o hfsql_bridge src/hfsql_bridge.c -I/usr/include/libiodbc -liodbc -liodbcinst`
4. Smoke-check without a server: `./hfsql_bridge "DRIVER={HFSQL};Server Name=localhost;Server Port=4900;Database=MPS;UID=Admin;PWD=;" </dev/null`
   must answer an HFSQL `[08001] The connection to the <localhost:4900> server failed`
   (driver loaded); a `[iODBC][Driver Manager] … cannot open shared object file` means
   `/etc/odbcinst.ini` or the `.so` path is wrong.

Symptom before this: `serve-main.mjs` prints `HFSQL : UNREACHABLE — spawn …/hfsql_bridge
ENOENT` and the API log repeats `[hfsql_bridge] Failed to start` (idle, not a storm).
**Local HFSQL Client/Server (same day).** The dev `MPS` copy used to live on the Windows
workstation; on the Linux box it is a local server built from the prod install:

- Binaries: `/opt/hfsql` copied from the MPS VM (`debian@10.10.20.2:/opt/hfsql`, minus
  `hfmailer64`, `AI Models`, `backup`), `HFConf.ini` unchanged (`DBRootPATH=/var/lib/hfsql/`,
  logs under `/var/log/hfsql/{log,stat}`). System user `hfsql`, data root `/var/lib/hfsql`
  mode 770. Unit `/etc/systemd/system/hfsql.service` = prod's (`Type=notify`,
  `ExecStart=/opt/hfsql/manta64`, `WorkingDirectory=/opt/hfsql`), enabled; listens on 4900,
  kept LAN-invisible by ufw's default deny. A first start with an empty root creates
  `__system` with `Admin` / empty password — the dev connection string as-is.
- Data: a database is just a folder under the root, and **names are case-insensitive**
  (`Database=MPS` opens `mps`). `mps` (2.8 GB, 501 files, `_backup` excluded) and
  `pointage` were streamed live from prod with
  `ssh … 'sudo tar -C /var/lib/hfsql -cf - --exclude=mps/_backup mps pointage | zstd -3' | zstd -d | sudo tar -C /var/lib/hfsql -x`
  (~25 min at ~2 MB/s; the prod box has no rsync), then `chown -R hfsql:hfsql`. The
  journals (`__jnl`, 4.7 GB) were **not** copied and the server did not object. Tables
  being written during the copy (`stock_ecru`, `evenement_piece`) queried fine afterwards;
  if one ever reports a corrupt index, re-copy that table's three files.
- Refresh the copy: stop `hfsql.service`, `rm -rf /var/lib/hfsql/mps`, re-run the stream,
  start. ⚠️ **It is a prod snapshot** (2026-09-16), the same rule as the March one on
  Windows: never point `.env.development` at `mps.malterre`.

## Quick Start

```bash
# --config.confirmModulesPurge=false: pnpm may otherwise block on an interactive
# "remove and reinstall modules dirs?" prompt, which looks like a hang.
pnpm install --config.confirmModulesPurge=false
pnpm dev          # start dev servers
pnpm build        # build all packages
pnpm test         # run tests
```

## Dev Ports

| Service | Port | Notes |
|---------|------|-------|
| MPS API | 3002 | Set in `apps/api/.env.development` |
| ETM Web | 5175 | Vite (5173/5174 taken by MFProd) |
| MFProd API | 8080 | Separate project |
| MFProd Web | 5173 | Separate project |

> Local dev webapp actually runs on **5174** in practice (memory `feedback_local_dev_port` overrides the 5175 note above).
