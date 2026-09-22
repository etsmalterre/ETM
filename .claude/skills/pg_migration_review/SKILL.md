---
name: pg_migration_review
description: Daily review, with Vincent, of last night's HFSQL → PostgreSQL rehearsal run (step 2 of the PG migration) — fetch the report from the PostgreSQL VM, present only what is NEW or REGRESSED, decide each issue together (conversion rule / data fix in HFSQL / accepted), apply the decision, rerun the affected tables, record it in the register. Use when the user says "migration review", "pg review", "let's look at last night's migration errors", "what broke in the copy", or runs /pg_migration_review.
---

# PG migration review

The nightly job (`pg_migrate.py`, 02:00 on `10.10.20.6`, postgres crontab) rebuilds
`mps_rehearsal` from HFSQL and writes `/var/lib/pg-migration/runs/latest/{report.json,report.md,run.log}`.
Every anomaly is an issue with a stable id `<kind>:<schema>.<table>[.<column>]`, matched
against the register `scripts/pg-migration/known-issues.json`. **The register is how
the knowledge compounds: an issue decided once never needs investigating again.**
Background: `claude_doc/pg_migration.md` § Step 2 (read it first if this session has not).

## 1. Fetch

```bash
export MSYS_NO_PATHCONV=1
K="-o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i /home/vincent/.ssh/claude_deploy/claude_deploy"
wsl -- ssh $K debian@10.10.20.6 "cat /var/lib/pg-migration/runs/latest/summary.json; echo; cat /var/lib/pg-migration/runs/latest/report.md"
# full detail: .../latest/report.json ; the run log: .../latest/run.log
```

First check the run itself: did it run last night (`run` date), did it finish (`tables_ok` =
`tables`), how long (`duration_min`, the D-Day downtime estimate). A missing or old run is the
first thing to fix (`sudo -u postgres crontab -l`, `run.log`).

## 2. Present

Show Vincent **REGRESSED first, then NEW**, grouped by kind, errors before warnings before
info. For each group: what it means in plain French-business terms, how many rows, one or
two samples, and **your recommended decision**. Do not dump known issues; mention only
their count and any register entry marked `fixed-data` that is now "gone" (a win).

## 3. Decide, one group at a time

Every issue ends in exactly one register state. Vincent decides; you propose.

| State | When | What you do |
|---|---|---|
| `rule` | the value is right, only its PostgreSQL form needs a convention (NUL → NULL, empty date → NULL) | implement in `hfsql_dump.c` (extraction) or `pg_migrate.py` (loading), comment it, add the register entry with the rule number (R3, R4…) and where it lives |
| `fixed-data` | the HFSQL data is wrong (impossible date, garbled accents, duplicate key) | write a repair script `apps/api/src/scripts/pg-fix-<topic>.ts` (dry run by default, `--write` to apply), show Vincent the dry run, **run `--write` against prod HFSQL only with his explicit go**, then add the register entry. If it reappears it shows as REGRESSED: the source still produces bad data, so find the writer (HFSQL journal, `hfsql_odbc.md` § « Reading the journal »). |
| `accepted` | harmless and understood (a WinDev scratch table, a difference the API never reads) | register entry with the reason |

Register entry: `"<issue id or fnmatch pattern>": {"status", "decision", "date"}`. Prefer
the narrowest pattern that is true; a `*` wildcard hides future problems.
Tables to leave behind (WinDev scratch or dead tables) are `accepted` with the reason
"not migrated", and get listed in `pg_migration.md` § Inventory.

HFSQL writes follow every rule in `CLAUDE.md` § HFSQL (no parameters, `esc()`, the
column-name outage footgun on Linux: **verify every column name against a dev SELECT
first**).

## 4. Apply and verify

```bash
# copy the changed files, rebuild the extractor, rerun only the affected tables
wsl -- scp $K /mnt/c/dev/etsmalterre/ETM/scripts/pg-migration/{pg_migrate.py,hfsql_dump.c,known-issues.json} debian@10.10.20.6:/tmp/
wsl -- ssh $K debian@10.10.20.6 "cd /tmp && sudo install -m 644 pg_migrate.py known-issues.json /opt/pg-migration/ && sudo gcc -O2 -o /opt/pg-migration/hfsql_dump hfsql_dump.c -I/usr/include/iodbc -liodbc && sudo -u postgres python3 /opt/pg-migration/pg_migrate.py --only <table1>,<table2>"
```

A `--only` run writes its own `runs/<date_time>/report.md` (not `latest`). Confirm the
issue is gone or now `known` before calling it done.

## 5. Record

- Commit `scripts/pg-migration/*` and any repair script, one commit per review:
  `pg-migration: review <date> — <decisions in a line>`.
- Append one line per decision to `claude_doc/pg_migration.md` § Review log
  (date, issue id / pattern, decision, rows affected).
- Update the § Status table when the nightly run reaches a milestone (first clean run,
  N clean nights in a row → D-Day criterion).

## Done when

Nothing NEW or REGRESSED is left undecided, the register and the review log are committed,
and Vincent knows what tonight's run should show differently.
