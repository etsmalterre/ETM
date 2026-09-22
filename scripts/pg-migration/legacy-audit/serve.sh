#!/bin/sh
# Forced command of the API server's hfsql_audit key (authorized_keys on 10.10.20.2):
#   restrict,command="/home/debian/hfsql-audit/serve.sh" ssh-ed25519 ... hfsql-audit@mps-api
# The only thing that key can do: print the samples of ONE day (arg YYYY-MM-DD).
D="$SSH_ORIGINAL_COMMAND"
case "$D" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "usage: YYYY-MM-DD" >&2; exit 2 ;;
esac
F="$HOME/hfsql-audit/samples/$D.tsv"
[ -f "$F" ] && cat "$F"
exit 0
