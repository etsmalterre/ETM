# HFSQL → PostgreSQL migration (MPS database)

Started 2026-09-22, once every WinDev app had a replacement. Owner: Vincent.
This file is the reference for the whole migration: decisions, step status, cutover
procedure. Update the status table as steps land.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **HFSQL stays the single source of truth until the cutover.** No two-way sync, and WinDev never points at PostgreSQL. | Employees keep the legacy apps during an adaptation period; a sync is the classic way to lose data. The 2025 attempt died on WinDev's native PG connector (quoted mixed-case columns vs unquoted hand SQL). |
| D2 | **PostgreSQL identifiers: lowercase, unquoted, no accents** (`prénom` → `prenom`, `IDsociete` → `idsociete`). | Vincent, 2026-09-22: keep it simple. Nothing needs to be quoted, ever. |
| D3 | The switch happens **in the MPS API** (`DB_BACKEND=hfsql\|pg`), route by route, shipped to prod while HFSQL is still live. | Every client (ETM, TRM, atelier, TRS, pointage) goes through the API: one place to switch. |
| D4 | A route is "ported" only when its PG answers **match HFSQL's** in the shadow diff (step 4). | Catches type, encoding and NULL-vs-0 differences before users do. |
| D5 | Rollback: HFSQL is locked read-only at cutover and kept intact. **Go/no-go window decided before the cutover**; after it, fix forward. | Once users write to PG, going back to HFSQL loses those writes. |
| D6 | Target: the existing PostgreSQL 15 instance on `10.10.20.6` (next to MFProd's `mfprod`): `mps_rehearsal` rebuilt nightly, `mps` (empty leftover of 2025) loaded for real on D-Day. HFSQL `pointage` → schema `pointage` of the same database. Upgrade to 17 later, MFProd and MPS together. | Host RAM is fully allocated (~30/32 GB), so no new VM; one engine to back up and monitor. **Before D-Day**: backups of that VM at least hourly (PITR preferred, HFSQL has hourly today), and give it the HFSQL VM's RAM after the cutover. |
| D7 | Every anomaly of the nightly run is an issue with a stable id, decided ONCE with Vincent in the daily `/pg_migration_review` and recorded in `scripts/pg-migration/known-issues.json` (rule / fixed-data / accepted). | Knowledge compounds; nothing is investigated twice; D-Day readiness is measurable. |

## Status

| Step | What | Status |
|---|---|---|
| 1 | Audit who / what still uses HFSQL (legacy audit, below) | **running since 2026-09-22**, evening email |
| 2 | Repeatable HFSQL → PG reload script with self-checks, nightly 02:00, daily review | **running since 2026-09-22** |
| 3 | `DB_BACKEND` switch in the MPS API, port routes one by one (parameterised SQL) | todo |
| 4 | Shadow diff: same requests on both backends, compare JSON | todo |
| 5 | Dress rehearsals on a staging VM (timed cutover + timed rollback), two clean in a row | todo |
| 6 | Cutover weekend | todo |
| 7 | Archive HFSQL read-only for months, retire the audit cron | todo |

## Inventory (what touches HFSQL)

Databases on `10.10.20.2`: `mps` (main, 204 tables), `pointage` (time clock, own client
`lib/hfsql-pointage.ts`), `etmprod`, `trmprod`, `__trs`, `mfprod` (legacy copy, MFProd now on PG),
plus the server's `__jnl`, `__jnlbackup`, `__system`. `etmprod` (last write 2026-01-30) and `trmprod` (2025-11-03) look like dead copies and are **not migrated**
unless Vincent says otherwise; `__trs` holds only a `_backup` of the TRS files.

Clients seen in `__jnl.jnl_users` (application column) on 2026-09-22:
- `MPS.exe` — the WinDev desktop app, on office PCs (Isa, Nico, Pierrot, Laetitia, Patricia, Éloïse, visitage, régleur…)
- `app_process32/64 (BONNETIER)` and `(REGLEUR)` — **WinDev Mobile Android tablets** in the workshop
- `hfsql_bridge` — the MPS API (`10.10.20.3`) and dev machines (a Tailscale dev API wrote to prod once, #1172)
- `CC3xxHF` — HFSQL Control Centre; `wdtst*` — WinDev test mode (Vincent's PCs)
- `Data_Recorder_V2` — the old TRS collector (the new one writes through the API)

Also to check: the WebDev services `tricotbotapi` (`10.10.54.2`, n8n writes to HFSQL through it)
and `webservice` (`10.10.55.2`, behind `alpha.etsmalterre.com`), and the PHP files in
`etsmalterre.com/`. Any of them still writing to HFSQL after the cutover would write into a
dead database.

## Step 1: legacy audit (daily email)

HFSQL logs no connections (`ServerLogPath` is empty), and `jnl_operation` only journals the
four atelier tables (`message_of`, `bonnetier`, `utilisateur`, `evenement_machine`). So:

- **Sampler** on `10.10.20.2`: `~/hfsql-audit/sample.py` (source
  `scripts/pg-migration/legacy-audit/sample.py`), debian crontab `*/2 * * * *`. Appends
  `HH:MM ip connections netbios-name` to `~/hfsql-audit/samples/YYYY-MM-DD.tsv` for each
  client connected to :4900. NetBIOS names come from a UDP 137 query (Windows PCs answer,
  tablets don't). No root, read-only, keeps 200 days.
- **Transport**: key `~/.ssh/hfsql_audit` of debian@`10.10.20.3`, authorised on `10.10.20.2`
  as `restrict,command="/home/debian/hfsql-audit/serve.sh"`: it can print one day's file, nothing else.
- **Report**: `apps/api/src/scripts/legacy-activity-report.ts`, debian crontab on `10.10.20.3`
  `30 19 * * *` → `cd ~/mps_api && npx tsx src/scripts/legacy-activity-report.ts --send`,
  log `~/legacy-audit.log`. Mails `vincent@etsmalterre.com`: each legacy host with apps, time
  connected, first/last seen, atelier writes, NOUVEAU flag; hosts silent ≥ 7 days (uninstall
  to confirm). State (first/last seen per host) in `data/legacy-audit-state.json`.
  Without `--send` it is a dry run; `--date=`, `--samples=<local file>`, `--preview=<html>`.
- Name resolution is best effort: NetBIOS name, else "probablement <name>" from the latest
  `jnl_users` row for that IP (DHCP may have moved the PC since).
- **No email one evening = something broke** (cron, Gmail, API host). The mail reports
  its own sources as INDISPONIBLE rather than failing silently.

Retire after the cutover: remove both crontab lines, the `hfsql_audit` key line from
`10.10.20.2:~/.ssh/authorized_keys`, and `~/hfsql-audit/`.

## Step 2: nightly reload and daily review

Runs on the PostgreSQL VM `10.10.20.6` (it writes locally at full speed, and stays off the API host).

- **Code** (`scripts/pg-migration/`, installed in `/opt/pg-migration/`):
  `hfsql_dump.c` (iODBC extractor: catalog, row counts, one table → PostgreSQL COPY format; built
  on the VM with `gcc -O2 -o hfsql_dump hfsql_dump.c -I/usr/include/iodbc -liodbc`, HFSQL driver
  copied to `/opt/hfsql_odbc`), `pg_migrate.py` (orchestrator), `known-issues.json` (the register),
  `serve-summary.sh`. HFSQL connection string in `/etc/pg-migration/hfsql.conf` (postgres, 600).
- **Schedule**: postgres crontab `0 2 * * *`; output in `/var/lib/pg-migration/runs/<date_time>/`
  (`report.md`, `report.json`, `summary.json`, `run.log`), `runs/latest` = last full run.
  One-off: `sudo -u postgres python3 /opt/pg-migration/pg_migrate.py [--only t1,t2] [--keep-files]`.
  `--target mps` is refused without `PG_MIGRATE_DDAY=1`.
- **Per table**: HFSQL count → extract → HFSQL count → load → primary key → read everything back and
  compare field by field with what was extracted (rows matched on the key). Plus catalog drift
  against the previous night.
- **Conversion rules** (each has a register entry): R1 text starting with NUL → NULL (as the API reads it);
  R2 empty date → NULL; text is cp1252 → UTF-8 (checked identical to the driver's own UTF-16
  conversion on 2026-09-22); names lowercase/unaccented (D2); impossible dates → NULL **and reported
  as errors** until decided.
- **Evening email** carries one line on the latest run (the API host reads `summary.json` through
  the `hfsql_audit` key, forced to `serve-summary.sh` on the VM).
- **Review**: `/pg_migration_review` (ETM project skill). D-Day criterion: several consecutive
  nights with 0 new, 0 regressed, 0 open errors.

Retire after the cutover: the postgres crontab line, the `hfsql_audit` key line in
`10.10.20.6:~debian/.ssh/authorized_keys`, and `mps_rehearsal`.

## Review agenda (open questions for the next review)

From the first full runs (2026-09-22, 219 tables, 781 346 rows, 3.5 min):
- `invalid_date:public.stock_ecru.date_saisie` (103 rows) and `stock_fini.date_saisie` (153):
  day and month swapped (`2020-20-05`), 2018–2021. Repair in HFSQL (swap) or accept as NULL?
- `ordre_fabrication.interruption_prod`: HFSQL *Durée*, arrives as milliseconds (8260 = 8.3 s),
  loaded as bigint; 363 non-zero, a few absurd (91 161 419 960 ms ≈ 3 years). Keep ms or
  convert to `interval`; what to do with the outliers? (The API never selects it.)
- `possible_double_encoding` ×11 columns (`CÃ©line`, `TuiliÃ¨re`, `donnÃ©`…): repair in HFSQL?
- `no_primary_key`: `conso_fil`, `maj_appli` (no key), `entreprise_competence` (key named
  `IDENTREPRISE_IDCOMPETENCE`, probably composite): still used? If not, not migrated.

## Review log

One line per decision: date · issue id / pattern · decision · rows.

- 2026-09-22 · `nul_as_null:*`, `zero_date_null:*` · rules R1, R2 · (initial register)
- 2026-09-22 · `changed_during_copy:*` · accepted, live source at night; HFSQL locked on D-Day

## Cutover procedure (draft, refined by the rehearsals)

1. Announce the date; the evening email must have shown no legacy host for a week.
2. Friday evening: stop the API (`mps-api`), block :4900 for everything but the migration
   host (OPNsense / nftables on `10.10.20.2`), take an HFSQL backup.
3. Run the reload script, then its checks (row counts, checksums, sequences = max(id)).
4. Set `DB_BACKEND=pg`, start the API, run the smoke list on every client.
5. Go/no-go at the agreed time. No-go → `DB_BACKEND=hfsql`, unblock :4900, restart.
6. Keep HFSQL read-only and backed up; delete nothing for months.
