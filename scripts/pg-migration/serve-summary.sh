#!/bin/sh
# Forced command of the API server's hfsql_audit key on the PostgreSQL VM
# (debian authorized_keys on 10.10.20.6):
#   restrict,command="/opt/pg-migration/serve-summary.sh" ssh-ed25519 ... hfsql-audit@mps-api
# The only thing that key can do: print the summary of the latest nightly run,
# for the evening email (legacy-activity-report.ts).
cat /var/lib/pg-migration/runs/latest/summary.json 2>/dev/null || echo '{}'
