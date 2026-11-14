#!/usr/bin/env bash
# Runs SQL tests on a throwaway local Postgres (NOT Supabase). Usage:
#   PGHOST=... PGPORT=... PGUSER=postgres tests/run-sql-tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."
P="psql -X -q -v ON_ERROR_STOP=1"
$P -d postgres -c "drop database if exists kfp_test" -c "create database kfp_test" >/dev/null
$P -d kfp_test -f tests/sql/00_supabase_stub.sql >/dev/null 2>&1
$P -d kfp_test -f supabase_schema.sql >/dev/null 2>&1
for t in $(ls tests/sql/phase*_test.sql | sort -V); do
  echo "### $t"; $P -d kfp_test -f "$t" 2>&1 | grep -E '^==|ERROR|assert|PASSED|NOTICE:  P1[0-9]|NOTICE:  \(' || true
done
