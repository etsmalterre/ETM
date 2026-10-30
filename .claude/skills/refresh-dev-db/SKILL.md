---
name: refresh-dev-db
description: Replace the ETM dev database mps_dev with today's copy of production mps (PostgreSQL on 10.10.20.6), then apply pending migrations. On demand only — use when Vincent asks to refresh / realign / pull the prod image into the dev DB ("mets à jour la bdd dev", "aligne dev sur prod").
---

# Refresh the ETM dev database from production

`mps_dev` (role `mps_dev`, owner of every table) lives on the SAME host as prod `mps`: `mps-database` `10.10.20.6`.
Everything runs on that host as `postgres` over SSH — no dump crosses the network. Prod is only read (`pg_dump`).
Never run this unprompted: every dev station (and every worktree API) shares `mps_dev`, and test data in it is lost.

## Step 1 — check SSH access

```bash
wsl -e bash -lc 'ssh -F none -i ~/.ssh/claude_deploy/claude_deploy -o IdentitiesOnly=yes -o BatchMode=yes debian@10.10.20.6 "cd /tmp; sudo -n -u postgres psql -Atc \"select 1\""'
```

If refused, Vincent has the `claude_deploy` key turned off: ask him to enable it.
⚠️ Inline quoting through `wsl → ssh → sudo → psql` breaks on `'`: put multi-command work in a script in the scratchpad and pipe it to `bash -s` (step 2).

## Step 2 — dump, restore into `mps_dev_new`, swap

Write this to `<scratchpad>/refresh.sh`, then run
`wsl -e bash -lc 'ssh -F none -i ~/.ssh/claude_deploy/claude_deploy -o IdentitiesOnly=yes -o BatchMode=yes debian@10.10.20.6 bash -s' < <scratchpad>/refresh.sh`
(Bash tool, timeout 600000):

```bash
set -e
cd /tmp
P="sudo -n -u postgres"
D=/tmp/mps-$(date +%Y%m%d-%H%M).dump
$P pg_dump -Fc -d mps -f $D; ls -lh $D
$P psql -Atc "drop database if exists mps_dev_new"
$P createdb -O mps_dev mps_dev_new
$P pg_restore --no-owner --no-acl --role=mps_dev -d mps_dev_new -j 4 $D
$P psql -d mps_dev_new -Atc "select 'not owned by mps_dev: '||count(*) from pg_tables where schemaname in ('public','pointage') and tableowner<>'mps_dev'"
$P psql -Atc "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('mps_dev','mps_dev_old') and pid<>pg_backend_pid()" >/dev/null
$P psql -Atc "drop database if exists mps_dev_old"
$P psql -Atc "alter database mps_dev rename to mps_dev_old"
$P psql -Atc "alter database mps_dev_new rename to mps_dev"
$P psql -Atc "select pg_terminate_backend(pid) from pg_stat_activity where datname='mps_dev_old'" >/dev/null || true
$P psql -Atc "drop database mps_dev_old"
$P rm -f $D
echo DONE
```

Measured 2026-10-30: dump ~1 m 45 s (1.9 GB), restore ~40 s, dev APIs cut only during the swap (they reconnect by themselves).
« not owned by mps_dev » must be 0 — otherwise dev migrations will fail on ALTER.
If the script stops before the swap, `mps_dev` is untouched; drop `mps_dev_new` and the `/tmp` dump.

## Step 3 — apply pending migrations

From the current checkout / worktree (its `apps/api/.env.development` points at `mps_dev`):

```bash
cd apps/api && npx tsx src/scripts/mps-migrate.ts          # dry-run: lists pending
cd apps/api && npx tsx src/scripts/mps-migrate.ts --write  # only if some are pending
```

Prod usually has every merged migration; pending ones come from the current branch. Other worktrees with their own unmerged migrations must re-run their `mps-migrate --write`.

## Never

- reset the `mps_dev` role password (trust auth from the LAN, see `claude_doc/dev_setup.md` item 0);
- touch prod `mps` beyond `pg_dump`;
- swap without the ownership check.

Not covered: the JSON state in `apps/api/data/` (permissions, notifications, agents) and the PostgreSQL `espace_client_dev` / `rh_dev` databases stay as they are.
