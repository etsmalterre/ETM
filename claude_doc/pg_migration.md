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
| D6 | Target: the existing PostgreSQL VM `10.10.20.6` (runs MFProd's `mfprod`), a new database `mps`. Version to align (VM runs 15; 17+ preferred for the new DB, decide at step 2). | One engine to back up and monitor. |

## Status

| Step | What | Status |
|---|---|---|
| 1 | Audit who / what still uses HFSQL (legacy audit, below) | **running since 2026-09-22**, evening email |
| 2 | Repeatable HFSQL → PG reload script with self-checks, nightly on a prod copy | todo |
| 3 | `DB_BACKEND` switch in the MPS API, port routes one by one (parameterised SQL) | todo |
| 4 | Shadow diff: same requests on both backends, compare JSON | todo |
| 5 | Dress rehearsals on a staging VM (timed cutover + timed rollback), two clean in a row | todo |
| 6 | Cutover weekend | todo |
| 7 | Archive HFSQL read-only for months, retire the audit cron | todo |

## Inventory (what touches HFSQL)

Databases on `10.10.20.2`: `mps` (main, 204 tables), `pointage` (time clock, own client
`lib/hfsql-pointage.ts`), `etmprod`, `trmprod`, `__trs`, `mfprod` (legacy copy, MFProd now on PG),
plus the server's `__jnl`, `__jnlbackup`, `__system`. Which of `etmprod` / `trmprod` / `__trs`
are still used must be settled before step 2.

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

## Cutover procedure (draft, refined by the rehearsals)

1. Announce the date; the evening email must have shown no legacy host for a week.
2. Friday evening: stop the API (`mps-api`), block :4900 for everything but the migration
   host (OPNsense / nftables on `10.10.20.2`), take an HFSQL backup.
3. Run the reload script, then its checks (row counts, checksums, sequences = max(id)).
4. Set `DB_BACKEND=pg`, start the API, run the smoke list on every client.
5. Go/no-go at the agreed time. No-go → `DB_BACKEND=hfsql`, unblock :4900, restart.
6. Keep HFSQL read-only and backed up; delete nothing for months.
