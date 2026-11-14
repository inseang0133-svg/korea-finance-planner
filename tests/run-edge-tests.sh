#!/usr/bin/env bash
# Edge Function core tests: fake Stripe + real Postgres (run tests/run-sql-tests.sh first).
#   PGHOST=... PGPORT=... PGUSER=postgres tests/run-edge-tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TSX="$(npm root -g)/tsx/dist/cli.mjs"; [ -f "$TSX" ] || TSX="$(command -v tsx)"
for t in tests/edge/*.test.ts; do echo "### $t"; node "$TSX" "$t"; done
