#!/usr/bin/env bash
# Everything, in order. Needs: local Postgres 16 (PGHOST/PGPORT/PGUSER), Node + Playwright, tsx, tsc.
#   PGHOST=/var/tmp/kfp-pg PGPORT=54329 PGUSER=postgres tests/run-all.sh [--scale]
set -uo pipefail
cd "$(dirname "$0")/.."
status=0
step() { echo; echo "================ $1"; }
step "0/6 Fresh install (empty DB → install_all.sql → security report)"; tests/run-fresh-install.sh || status=1
step "1/6 SQL (migrations + Phase 2–12 tests)";  tests/run-sql-tests.sh | tee /tmp/kfp-sql.log | grep -E "PASSED|ERROR|NOTICE" ; grep -q ERROR /tmp/kfp-sql.log && status=1
step "2/6 Edge Function core (fake Stripe + real Postgres)"; tests/run-edge-tests.sh | grep -E "✗|passed, " || status=1
step "3/6 TypeScript (Edge Functions)"; npx tsc -p tests/ts/tsconfig.json --noEmit && echo "tsc OK" || status=1
step "4/6 Static security audit"; node tests/security/static-audit.js | tail -1; node tests/security/static-audit.js >/dev/null || status=1
step "5/6 Browser e2e (Chromium)"
for t in $(ls tests/e2e/phase*.test.js | sort -V); do
  out=$(node "$t" 2>&1); rc=$?
  printf "%-32s %s\n" "$t" "$(echo "$out" | tail -1)"; echo "$out" | grep "✗" || true
  [ $rc -eq 0 ] || status=1
done
if [ "${1:-}" = "--scale" ]; then step "6/6 Scale benchmark (100 → 50,000 members)"; tests/run-scale.sh | tail -14; else step "6/6 Scale benchmark skipped (add --scale)"; fi
echo; [ $status -eq 0 ] && echo "ALL GREEN" || echo "SOMETHING FAILED"
exit $status
