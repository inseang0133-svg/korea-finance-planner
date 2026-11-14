#!/usr/bin/env bash
# Scale benchmark (100 → 50,000 members). Needs the test DB from tests/run-sql-tests.sh. Rolled back.
set -euo pipefail
cd "$(dirname "$0")/.."
psql -X -q -v ON_ERROR_STOP=1 -d kfp_test -f tests/sql/scale_bench.sql
